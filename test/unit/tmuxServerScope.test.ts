import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, type execFile } from "node:child_process";
import {
  createTmuxExecutor,
  resetServerScopeProbeForTests,
  serverScopeArgv,
  serverScopeUnitName,
  socketPath,
} from "../../src/tmux/TmuxService.js";
import { makeSocketTemp } from "../helpers/socketTemp.js";

// t-3da510 — the engine daemon runs in a transient systemd unit with KillMode=control-group.
// Whoever first talks to the tachyon socket forks the tmux SERVER, and a process forked inside
// that unit stays in its cgroup forever: every bundle activation (Reload with a bump) killed the
// server and SIGHUP'd every agent pane. The fix wraps server-creating tmux commands in their own
// `systemd-run --user --scope`, so the server's cgroup is never the caller's. These tests are the
// boundary forcing function: the argv-shape tests pin the wrap, and the live test proves the
// forked server actually lands outside the caller's cgroup.

type ExecFileImpl = typeof execFile;

interface Call {
  file: string;
  argv: string[];
}

function fakeExec(
  calls: Call[],
  respond: (file: string, argv: string[]) => { err?: NodeJS.ErrnoException & { code?: string }; stdout?: string; stderr?: string },
): ExecFileImpl {
  return ((file: string, argv: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    calls.push({ file, argv });
    const result = respond(file, argv);
    queueMicrotask(() => cb(result.err ?? null, result.stdout ?? "", result.stderr ?? ""));
    return { kill() {}, stdout: undefined, stderr: undefined } as never;
  }) as unknown as ExecFileImpl;
}

beforeEach(() => resetServerScopeProbeForTests());
afterEach(() => resetServerScopeProbeForTests());

describe("tmux server scope isolation (t-3da510)", () => {
  it("routes server-creating commands through a private systemd scope", async () => {
    const calls: Call[] = [];
    const exec = createTmuxExecutor(fakeExec(calls, () => ({ stdout: "" })));
    await exec(["-L", "tachyon", "new-session", "-d", "-s", "s1", "tail -f /dev/null"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe("systemd-run");
    expect(calls[0]!.argv.slice(0, 4)).toEqual(["--user", "--scope", "--collect", "--quiet"]);
    expect(calls[0]!.argv[4]).toMatch(/^--unit=tachyon-tmux-[a-f0-9]{12}\.scope$/);
    // the real tmux invocation follows the `--` separator, config-isolated like a direct exec.
    const sep = calls[0]!.argv.indexOf("--");
    expect(calls[0]!.argv.slice(sep + 1, sep + 4)).toEqual(["tmux", "-f", "/dev/null"]);
    expect(calls[0]!.argv).toContain("new-session");
  });

  it("keeps non-creating commands (probes, control ops) on a plain tmux exec", async () => {
    const calls: Call[] = [];
    const exec = createTmuxExecutor(fakeExec(calls, () => ({ stdout: "" })));
    await exec(["-L", "tachyon", "list-sessions"]);
    await exec(["-L", "tachyon", "kill-session", "-t", "=x"]);
    expect(calls.map((c) => c.file)).toEqual(["tmux", "tmux"]);
  });

  it("falls back to a plain exec when user systemd is unusable, and remembers the verdict", async () => {
    const calls: Call[] = [];
    const exec = createTmuxExecutor(fakeExec(calls, (file) => {
      if (file === "systemd-run") {
        const err: NodeJS.ErrnoException = new Error("spawn systemd-run ENOENT");
        err.code = "ENOENT";
        return { err };
      }
      return { stdout: "" };
    }));
    await exec(["-L", "tachyon", "new-session", "-d", "-s", "s1", "x"]);
    await exec(["-L", "tachyon", "new-session", "-d", "-s", "s2", "x"]);
    // first call probes systemd-run then retries plain; second call skips the probe entirely.
    expect(calls.map((c) => c.file)).toEqual(["systemd-run", "tmux", "tmux"]);
  });

  it("recognizes version-specific bus failure phrasings (private XDG_RUNTIME_DIR daemons)", async () => {
    const calls: Call[] = [];
    const exec = createTmuxExecutor(fakeExec(calls, (file) => {
      if (file === "systemd-run") {
        return {
          err: Object.assign(new Error("exit 1"), { code: 1 }) as never,
          stderr: "Failed to connect to user scope bus via local transport: No such file or directory",
        };
      }
      return { stdout: "" };
    }));
    await exec(["-L", "tachyon", "new-session", "-d", "-s", "s1", "x"]);
    expect(calls.map((c) => c.file)).toEqual(["systemd-run", "tmux"]);
  });

  it("still surfaces tmux's own errors through the scope wrapper unchanged", async () => {
    const calls: Call[] = [];
    const exec = createTmuxExecutor(fakeExec(calls, () => ({
      err: Object.assign(new Error("exit 1"), { code: 1 }) as never,
      stderr: "duplicate session: s1",
    })));
    // ControlModeClient's idempotent anchor creation depends on this exact message surviving.
    await expect(exec(["-L", "tachyon", "new-session", "-d", "-s", "s1", "x"])).rejects.toThrow(/duplicate session/);
    expect(calls[0]!.file).toBe("systemd-run");
  });

  it("derives a systemd-safe unit name from arbitrary nonce input", () => {
    expect(serverScopeUnitName("abcdef0123456789")).toBe("tachyon-tmux-abcdef012345.scope");
    expect(serverScopeUnitName("!!")).toBe("tachyon-tmux-x.scope");
    expect(serverScopeArgv(["-L", "t", "start-server"]).argv).toContain("start-server");
  });

  // The live boundary proof: fork a real server on a private socket through the real executor and
  // assert its cgroup is NOT the caller's — i.e. a Reload killing the caller's cgroup cannot take
  // the server down. Skips (loudly) where user systemd cannot host scopes (bare CI containers).
  it("forks the real server into its own cgroup, outside the caller's", async () => {
    let systemdUsable = process.platform === "linux";
    if (systemdUsable) {
      try {
        execFileSync("systemd-run", ["--user", "--scope", "--collect", "--quiet", "--", "true"], { stdio: "pipe" });
      } catch {
        systemdUsable = false;
      }
    }
    if (!systemdUsable) {
      expect(systemdUsable).toBe(false); // documents the skip instead of silently no-op-ing.
      return;
    }

    const root = makeSocketTemp("tss-");
    const tmuxTmp = path.join(root, "tmux");
    fs.mkdirSync(tmuxTmp, { mode: 0o700 });
    const priorTmuxTmp = process.env.TMUX_TMPDIR;
    process.env.TMUX_TMPDIR = tmuxTmp;
    const socket = "tss-scope";
    const exec = createTmuxExecutor();
    try {
      await exec(["-L", socket, "new-session", "-d", "-s", "probe", "tail -f /dev/null"], { timeoutMs: 10_000 });
      const pids = execFileSync("pgrep", ["-f", `tmux .*-L ${socket} new-session`], { encoding: "utf8" })
        .trim().split("\n").filter(Boolean).map(Number);
      expect(pids.length).toBeGreaterThan(0);
      const own = fs.readFileSync("/proc/self/cgroup", "utf8").trim();
      for (const pid of pids) {
        const serverCgroup = fs.readFileSync(`/proc/${pid}/cgroup`, "utf8").trim();
        expect(serverCgroup).not.toBe(own);
        expect(serverCgroup).toMatch(/tachyon-tmux-[a-f0-9]+\.scope/);
      }
    } finally {
      try { await exec(["-L", socket, "kill-server"], { timeoutMs: 5_000 }); } catch { /* already down */ }
      if (priorTmuxTmp === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = priorTmuxTmp;
      fs.rmSync(root, { recursive: true, force: true });
      void socketPath; // referenced to keep the import honest if the helper set changes
    }
  });
});
