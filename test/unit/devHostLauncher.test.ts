import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
// The production resolver is an owned ESM CLI; Vitest loads it directly while the repository's
// test typecheck target remains CommonJS.
// @ts-expect-error -- static ESM import is intentional for this executable module test.
import { isWslRemoteCli, resolveEdhCode } from "../../scripts/dev-host/resolve-code.mjs";
// @ts-expect-error -- static ESM import is intentional for this executable module test.
import { fixtureEngineUnitName, stopFixtureBridge, stopFixtureEngine } from "../../scripts/dev-host/stop-bridge.mjs";

const launcher = path.resolve("scripts/dev-host/cli.sh");
const temporaryRoots: string[] = [];

function temporaryRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tachyon-${label}-`));
  temporaryRoots.push(root);
  return root;
}

function executable(file: string, body = "#!/usr/bin/env bash\nexit 0\n"): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Dev Host VS Code resolver", () => {
  it("prefers the newest architecture-compatible worktree cache", () => {
    const repo = temporaryRoot("edh-code-local");
    executable(path.join(repo, ".vscode-test/vscode-linux-x64-1.9.0/code"));
    const newest = executable(path.join(repo, ".vscode-test/vscode-linux-x64-1.10.0/code"));

    expect(resolveEdhCode({ repo, commonRoot: undefined, pathCandidate: undefined })).toEqual({
      path: fs.realpathSync(newest),
      source: "worktree-cache",
    });
  });

  it("falls back to the primary checkout cache for an isolated worktree", () => {
    const repo = temporaryRoot("edh-code-worktree");
    const shared = temporaryRoot("edh-code-shared");
    const cached = executable(path.join(shared, ".vscode-test/vscode-linux-x64-1.128.0/code"));

    expect(resolveEdhCode({ repo, commonRoot: shared, pathCandidate: undefined })).toEqual({
      path: fs.realpathSync(cached),
      source: "shared-checkout-cache",
    });
  });

  it("rejects an explicit path and PATH candidate that resolve to WSL remote-cli/code", () => {
    const repo = temporaryRoot("edh-code-reject");
    const remote = executable(path.join(repo, ".vscode-server/bin/hash/bin/remote-cli/code"));
    const alias = path.join(repo, "code");
    fs.symlinkSync(remote, alias);

    expect(isWslRemoteCli(alias)).toBe(true);
    expect(() => resolveEdhCode({ repo, explicit: alias, commonRoot: undefined, pathCandidate: undefined })).toThrow(/remote-cli\/code/);
    expect(() => resolveEdhCode({ repo, commonRoot: undefined, pathCandidate: remote })).toThrow(/remote-cli\/code/);
  });

  it("does not accept a cache entry whose code binary resolves to WSL remote-cli/code", () => {
    const repo = temporaryRoot("edh-code-cache-reject");
    const remote = executable(path.join(repo, ".vscode-server/bin/hash/bin/remote-cli/code"));
    const cache = path.join(repo, `.vscode-test/vscode-linux-${process.arch}-1.128.0`);
    fs.mkdirSync(cache, { recursive: true });
    fs.symlinkSync(remote, path.join(cache, "code"));

    expect(() => resolveEdhCode({ repo, commonRoot: undefined, pathCandidate: "" })).toThrow(/no compatible VS Code executable/);
  });
});

describe("Dev Host child launch isolation", () => {
  it("refuses GUI launch without explicit desktop intent (t-fe621b)", () => {
    const root = temporaryRoot("edh-launch-refuse");
    const base = path.join(root, "fixtures");
    const fakeCode = executable(path.join(root, "native-code"));
    const result = spawnSync("bash", [launcher, "launch"], {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        TACHYON_DEV_HOST_BASE: base,
        TACHYON_DEV_HOST_ID: "refuse",
        TACHYON_EDH_CODE: fakeCode,
        TACHYON_AGENT_NAME: "live-agent",
      },
    });
    expect(result.status, result.stderr || result.stdout).toBe(1);
    expect(result.stderr).toMatch(/refusing GUI `launch` without explicit desktop intent/);
    expect(result.stderr).toMatch(/headless/);
    expect(result.stderr).toMatch(/launch --gui/);
  });

  it("accepts --gui consent and still scrubs live agent identity into fixture-private state", () => {
    const root = temporaryRoot("edh-launch");
    const base = path.join(root, "fixtures");
    const capture = path.join(root, "capture");
    const fakeCode = executable(
      path.join(root, "native-code"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$@" >"${EDH_TEST_CAPTURE}.args"\nenv >"${EDH_TEST_CAPTURE}.env"\n',
    );
    const result = spawnSync("bash", [launcher, "launch", "--gui"], {
      cwd: path.resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        TACHYON_DEV_HOST_BASE: base,
        TACHYON_DEV_HOST_ID: "isolation",
        TACHYON_EDH_CODE: fakeCode,
        TACHYON_EDH_FOREGROUND: "1",
        TACHYON_DEV_HOST_GUI: "1",
        TACHYON_DEV_HOST_SKIP_BUILD: "1",
        EDH_TEST_CAPTURE: capture,
        ELECTRON_RUN_AS_NODE: "1",
        TACHYON_AGENT_BRIDGE_TOKEN: "agent-secret",
        TACHYON_AGENT_NAME: "live-agent",
        TACHYON_BRIDGE_TOKEN: "bridge-secret",
        TACHYON_BRIDGE_URL: "http://live.invalid",
        TACHYON_NODE_ID: "live-node",
        TACHYON_NODE_NONCE: "live-nonce",
        TACHYON_RUN_ID: "live-run",
        TACHYON_WORKSPACE_ROOT: "/live/workspace",
        TACHYON_WORKTREE_ROOT: "/live/worktree",
        TMUX: "/live/tmux",
        TMUX_PANE: "%99",
        TMUX_TMPDIR: "/live/tmux-tmp",
        XDG_CACHE_HOME: "/live/cache",
        CODEX_HOME: "/live/codex",
        CODEX_THREAD_ID: "live-thread",
        CODEX_CI: "1",
      },
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/agent-driven GUI launch/);
    const args = fs.readFileSync(`${capture}.args`, "utf8").trim().split("\n");
    const childEnv = new Map(
      fs.readFileSync(`${capture}.env`, "utf8").trim().split("\n").map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
    );

    for (const key of [
      "ELECTRON_RUN_AS_NODE",
      "TACHYON_AGENT_BRIDGE_TOKEN",
      "TACHYON_AGENT_NAME",
      "TACHYON_BRIDGE_TOKEN",
      "TACHYON_BRIDGE_URL",
      "TACHYON_NODE_ID",
      "TACHYON_NODE_NONCE",
      "TACHYON_RUN_ID",
      "TACHYON_WORKSPACE_ROOT",
      "TACHYON_WORKTREE_ROOT",
      "TMUX",
      "TMUX_PANE",
      "CODEX_HOME",
      "CODEX_THREAD_ID",
      "CODEX_CI",
    ]) {
      expect(childEnv.has(key), key).toBe(false);
    }
    expect(childEnv.get("TMUX_TMPDIR")).toBe(path.join(base, "isolation/.tmux"));
    expect(childEnv.get("XDG_CACHE_HOME")).toBe(path.join(base, "isolation/.cache"));
    expect(childEnv.get("XDG_STATE_HOME")).toBe(path.join(base, "isolation/.state"));
    expect(childEnv.get("XDG_DATA_HOME")).toBe(path.join(base, "isolation/.data"));
    expect(childEnv.get("TACHYON_DEV_HOST")).toBe("1");
    expect(fs.realpathSync(childEnv.get("TACHYON_DEV_HOST_ENGINE_RUNTIME")!)).toBe(fs.realpathSync(process.execPath));
    expect(args).toContain("--use-inmemory-secretstorage");
    expect(args).toContain(`--extensionDevelopmentPath=${path.resolve(".")}`);
    expect(args.at(-1)).toBe(path.join(base, "isolation/workspace"));
    expect(JSON.parse(fs.readFileSync(path.join(base, "isolation/workspace/.tachyon-dev-host.json"), "utf8")))
      .toEqual({ schemaVersion: 1, kind: "tachyon-dev-host" });
    expect(fs.statSync(path.join(base, "isolation")).mode & 0o077).toBe(0);
  });
});

describe("EDH fixture cleanup", () => {
  it("stops only the exact persistent engine unit derived from the fixture workspace", async () => {
    const fixture = temporaryRoot("edh-clean-engine");
    fs.mkdirSync(path.join(fixture, "workspace"), { recursive: true });
    const unitName = fixtureEngineUnitName(fixture);
    const calls: string[][] = [];
    let active = true;

    await expect(stopFixtureEngine(fixture, {
      runSystemctl: (args) => {
        calls.push(args);
        if (args[0] === "stop") {
          active = false;
          return { status: 0, stdout: "", stderr: "" };
        }
        return active
          ? { status: 0, stdout: "active\n", stderr: "" }
          : { status: 3, stdout: "inactive\n", stderr: "" };
      },
    })).resolves.toEqual({ state: "stopped", unitName });
    expect(calls).toEqual([
      ["is-active", unitName],
      ["stop", unitName],
      ["is-active", unitName],
    ]);
    expect(unitName).toMatch(/^tachyon-engine-[a-f0-9]{32}\.service$/);
  });

  it("treats an unloaded fixture engine unit as already absent", async () => {
    const fixture = temporaryRoot("edh-clean-engine-absent");
    fs.mkdirSync(path.join(fixture, "workspace"), { recursive: true });
    const calls: string[][] = [];

    await expect(stopFixtureEngine(fixture, {
      runSystemctl: (args) => {
        calls.push(args);
        return { status: 4, stdout: "unknown\n", stderr: "" };
      },
    })).resolves.toMatchObject({ state: "absent" });
    expect(calls).toHaveLength(1);
  });

  it("stops the matching persistent Bridge through its control socket before removal", async () => {
    const fixture = temporaryRoot("edh-clean");
    const workspace = path.join(fixture, "workspace");
    const serviceDir = path.join(workspace, ".tachyon", "bridge-service");
    const socketPath = path.join(serviceDir, "control.sock");
    fs.mkdirSync(serviceDir, { recursive: true });
    const descriptor = {
      protocol: 1,
      workspaceHash: "abc12345",
      workspaceRoot: fs.realpathSync(workspace),
      instanceId: "fixture-instance",
      pid: process.pid,
      port: 42_000,
      controlSocket: socketPath,
      startedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(serviceDir, "service.json"), JSON.stringify(descriptor));

    const server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      socket.once("data", (raw) => {
        expect(JSON.parse(String(raw))).toEqual({ op: "stop", workspaceHash: "abc12345" });
        socket.end(`${JSON.stringify({ ok: true, descriptor })}\n`, () => server.close());
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });

    try {
      await expect(stopFixtureBridge(fixture, { timeoutMs: 1_000 })).resolves.toEqual({ state: "stopped" });
      expect(fs.existsSync(socketPath)).toBe(false);
    } finally {
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("refuses a symlinked descriptor instead of stopping an untrusted socket", async () => {
    const fixture = temporaryRoot("edh-clean-symlink");
    const serviceDir = path.join(fixture, "workspace", ".tachyon", "bridge-service");
    fs.mkdirSync(serviceDir, { recursive: true });
    const outside = path.join(fixture, "outside.json");
    fs.writeFileSync(outside, "{}");
    fs.symlinkSync(outside, path.join(serviceDir, "service.json"));

    await expect(stopFixtureBridge(fixture)).rejects.toThrow(/descriptor must not be a symlink/);
  });

  it("refuses a descriptor whose canonical workspace identity does not match the fixture", async () => {
    const fixture = temporaryRoot("edh-clean-identity");
    const serviceDir = path.join(fixture, "workspace", ".tachyon", "bridge-service");
    fs.mkdirSync(serviceDir, { recursive: true });
    fs.writeFileSync(path.join(serviceDir, "service.json"), JSON.stringify({
      protocol: 1,
      workspaceHash: "abc12345",
      workspaceRoot: "/tmp/not-this-fixture",
      controlSocket: path.join(serviceDir, "control.sock"),
    }));

    await expect(stopFixtureBridge(fixture)).rejects.toThrow(/does not match the fixture workspace/);
  });

  it("refuses cleanup while the recorded fixture EDH process is still running", async () => {
    const fixture = temporaryRoot("edh-clean-live");
    fs.mkdirSync(path.join(fixture, "workspace"), { recursive: true });
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)", "--", `--user-data-dir=${path.join(fixture, ".edh-user-data")}`], {
      stdio: "ignore",
    });
    fs.writeFileSync(path.join(fixture, ".edh.pid"), `${child.pid}\n`);

    try {
      await expect(stopFixtureBridge(fixture)).rejects.toThrow(/still alive|still running/);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("fails closed on a malformed EDH pid file", async () => {
    const fixture = temporaryRoot("edh-clean-bad-pid");
    fs.mkdirSync(path.join(fixture, "workspace"), { recursive: true });
    fs.writeFileSync(path.join(fixture, ".edh.pid"), "not-a-pid\n");

    await expect(stopFixtureBridge(fixture)).rejects.toThrow(/EDH pid file is invalid/);
  });

  it("bounds the persistent Bridge descriptor before parsing it", async () => {
    const fixture = temporaryRoot("edh-clean-large-descriptor");
    const serviceDir = path.join(fixture, "workspace", ".tachyon", "bridge-service");
    fs.mkdirSync(serviceDir, { recursive: true });
    fs.writeFileSync(path.join(serviceDir, "service.json"), "x".repeat(33 * 1024));

    await expect(stopFixtureBridge(fixture)).rejects.toThrow(/descriptor is too large/);
  });

  it("the shell cleanup stops the fixture-private tmux server before deleting the fixture", () => {
    const root = temporaryRoot("edh-clean-tmux");
    const base = path.join(root, "fixtures");
    const env = {
      ...process.env,
      TACHYON_DEV_HOST_BASE: base,
      TACHYON_DEV_HOST_ID: "tmux-cleanup",
    };
    const seeded = spawnSync("bash", [launcher, "seed"], { cwd: path.resolve("."), encoding: "utf8", env });
    expect(seeded.status, seeded.stderr || seeded.stdout).toBe(0);
    const tmuxDir = path.join(base, "tmux-cleanup/.tmux");
    const started = spawnSync("tmux", ["-L", "tachyon", "new-session", "-d", "-s", "fixture-cleanup"], {
      encoding: "utf8",
      env: { ...env, TMUX_TMPDIR: tmuxDir },
    });
    expect(started.status, started.stderr || started.stdout).toBe(0);

    const cleaned = spawnSync("bash", [launcher, "clean"], { cwd: path.resolve("."), encoding: "utf8", env });
    expect(cleaned.status, cleaned.stderr || cleaned.stdout).toBe(0);
    expect(fs.existsSync(path.join(base, "tmux-cleanup"))).toBe(false);
    const probe = spawnSync("tmux", ["-L", "tachyon", "has-session", "-t", "fixture-cleanup"], {
      encoding: "utf8",
      env: { ...env, TMUX_TMPDIR: tmuxDir },
    });
    expect(probe.status).not.toBe(0);
  });

  it("the shell cleanup removes a stale fixture-private tmux socket after proving no server responds", () => {
    const root = temporaryRoot("edh-clean-stale-tmux");
    const base = path.join(root, "fixtures");
    const id = "stale-tmux-cleanup";
    const env = {
      ...process.env,
      TACHYON_DEV_HOST_BASE: base,
      TACHYON_DEV_HOST_ID: id,
    };
    const seeded = spawnSync("bash", [launcher, "seed"], { cwd: path.resolve("."), encoding: "utf8", env });
    expect(seeded.status, seeded.stderr || seeded.stdout).toBe(0);
    const socketDir = path.join(base, id, ".tmux", `tmux-${process.getuid?.() ?? 0}`);
    const socketPath = path.join(socketDir, "tachyon");
    fs.mkdirSync(socketDir, { recursive: true });
    const stale = spawnSync("python3", ["-c", "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()", socketPath], {
      encoding: "utf8",
    });
    expect(stale.status, stale.stderr || stale.stdout).toBe(0);

    const cleaned = spawnSync("bash", [launcher, "clean"], { cwd: path.resolve("."), encoding: "utf8", env });
    expect(cleaned.status, cleaned.stderr || cleaned.stdout).toBe(0);
    expect(fs.existsSync(path.join(base, id))).toBe(false);
  });
});
