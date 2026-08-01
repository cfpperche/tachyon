import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  GlobalTmuxWatchdog,
  recoverTmuxServer,
} from "../../src/engine-service/tmuxAuthority.js";
import type { ObservedProcess } from "../../src/runtime/processIdentity.js";

const roots: string[] = [];
const servers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("persistent-engine tmux authority", () => {
  it("elects one watchdog globally and lets a standby take over after clean release", async () => {
    const root = tempRoot();
    let firstProbes = 0;
    let secondProbes = 0;
    const first = new GlobalTmuxWatchdog({
      authorityRoot: root,
      intervalMs: 60_000,
      readProcessIdentity: exactIdentity,
      probe: async () => { firstProbes++; return { state: "healthy" }; },
    });
    const second = new GlobalTmuxWatchdog({
      authorityRoot: root,
      intervalMs: 60_000,
      readProcessIdentity: exactIdentity,
      probe: async () => { secondProbes++; return { state: "healthy" }; },
    });
    await first.start();
    await second.start();
    expect(firstProbes).toBe(1);
    expect(secondProbes).toBe(0);

    first.close();
    await second.pollNow();
    expect(secondProbes).toBe(1);
    second.close();
  });

  it("reclaims a watchdog lease left by a process that is provably gone", async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, "watchdog.lock"), `${JSON.stringify({
      schemaVersion: 1,
      pid: 999_999,
      processStartIdentity: "linux:a:1",
      nonce: "a".repeat(48),
      createdAt: "2026-07-15T00:00:00.000Z",
    })}\n`, { mode: 0o600 });
    let probes = 0;
    const watchdog = new GlobalTmuxWatchdog({
      authorityRoot: root,
      intervalMs: 60_000,
      readProcessIdentity: (pid) => pid === process.pid ? exactIdentity(pid) : { state: "gone" },
      probe: async () => { probes++; return { state: "healthy" }; },
    });

    await watchdog.start();

    expect(probes).toBe(1);
    watchdog.close();
    expect(fs.existsSync(path.join(root, "watchdog.lock"))).toBe(false);
  });

  it("breaks an armed wedge sequence when a probe is unknown", async () => {
    const root = tempRoot();
    let calls = 0;
    const watchdog = new GlobalTmuxWatchdog({
      authorityRoot: root,
      intervalMs: 60_000,
      readProcessIdentity: exactIdentity,
      probe: async () => {
        calls++;
        if (calls === 1) return { state: "healthy" };
        if (calls === 2 || calls === 4) return { state: "wedged", pids: [4242] };
        throw new Error("probe unavailable");
      },
    });
    await watchdog.start();
    await watchdog.pollNow();
    await expect(watchdog.pollNow()).rejects.toThrow(/probe unavailable/);
    await watchdog.pollNow();
    expect(calls).toBe(4);
    watchdog.close();
  });

  it("kills only a freshly revalidated wedged PID set and removes only the same socket inode", async () => {
    const root = tempRoot();
    const socket = path.join(root, "tmux.sock");
    servers.push(await listen(socket));
    const killed: number[] = [];
    const outcome = await recoverTmuxServer({
      authorityRoot: root,
      socketFilePath: socket,
      probe: async () => ({ state: "wedged", pids: [4242] }),
      findPids: async () => [4242],
      snapshot: async () => "pid snapshot",
      readProcessIdentity: (pid) => killed.includes(pid) ? { state: "gone" } : exactIdentity(pid),
      kill: (pid) => killed.push(pid),
      sleep: async () => undefined,
    });

    expect(outcome).toEqual({ state: "recovered", pids: [4242], diagnostics: "pid snapshot" });
    expect(killed).toEqual([4242]);
    expect(fs.existsSync(socket)).toBe(false);
  });

  it("preserves a replacement socket created while the old wedged process is being reaped", async () => {
    const root = tempRoot();
    const socket = path.join(root, "tmux.sock");
    servers.push(await listen(socket));
    let replacement: net.Server | undefined;
    let killed = false;
    const outcome = await recoverTmuxServer({
      authorityRoot: root,
      socketFilePath: socket,
      probe: async () => ({ state: "wedged", pids: [4243] }),
      findPids: async () => [4243],
      snapshot: async () => "",
      readProcessIdentity: (pid) => killed && pid === 4243 ? { state: "gone" } : exactIdentity(pid),
      kill: () => { killed = true; },
      sleep: async () => {
        fs.unlinkSync(socket);
        replacement = await listen(socket);
        servers.push(replacement);
      },
    });

    expect(outcome.state).toBe("recovered");
    expect(replacement).toBeDefined();
    expect(fs.lstatSync(socket).isSocket()).toBe(true);
  });

  it("does not unlink the socket or claim recovery when the killed identity remains live", async () => {
    const root = tempRoot();
    const socket = path.join(root, "tmux.sock");
    servers.push(await listen(socket));
    const outcome = await recoverTmuxServer({
      authorityRoot: root,
      socketFilePath: socket,
      probe: async () => ({ state: "wedged", pids: [4245] }),
      findPids: async () => [4245],
      snapshot: async () => "",
      readProcessIdentity: exactIdentity,
      kill: () => undefined,
      sleep: async () => undefined,
    });

    expect(outcome).toMatchObject({ state: "refused", reason: "tmux server PID 4245 did not exit" });
    expect(fs.lstatSync(socket).isSocket()).toBe(true);
  });

  it("refuses recovery when a target PID start identity changes before the kill", async () => {
    const root = tempRoot();
    let targetReads = 0;
    const killed: number[] = [];
    const outcome = await recoverTmuxServer({
      authorityRoot: root,
      probe: async () => ({ state: "wedged", pids: [4244] }),
      findPids: async () => [4244],
      snapshot: async () => "",
      readProcessIdentity: (pid) => {
        if (pid === process.pid) return exactIdentity(pid);
        targetReads++;
        return { state: "exact", pid, bootId: "a", processStart: String(targetReads) };
      },
      kill: (pid) => killed.push(pid),
      sleep: async () => undefined,
    });

    expect(outcome).toMatchObject({ state: "refused", reason: "tmux server PID 4244 changed before recovery" });
    expect(killed).toEqual([]);
  });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-tmux-authority-"));
  roots.push(root);
  return root;
}

function exactIdentity(pid: number): ObservedProcess {
  return { state: "exact", pid, bootId: "a", processStart: String(pid) };
}

function listen(socketPath: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
