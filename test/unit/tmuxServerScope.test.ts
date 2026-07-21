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
    // transient bus: one retry (fresh unit) then plain fallback — never poisons the probe.
    expect(calls.map((c) => c.file)).toEqual(["systemd-run", "systemd-run", "tmux"]);
  });

  it("does not poison the process-wide probe after a transient bus failure (t-5f6355)", async () => {
    const calls: Call[] = [];
    let busFails = 2; // fail both attempts of the first new-session, then succeed
    const exec = createTmuxExecutor(fakeExec(calls, (file) => {
      if (file === "systemd-run") {
        if (busFails > 0) {
          busFails -= 1;
          return {
            err: Object.assign(new Error("exit 1"), { code: 1 }) as never,
            stderr: "Failed to connect to bus: Connection refused",
          };
        }
        return { stdout: "" };
      }
      return { stdout: "" };
    }));
    await exec(["-L", "tachyon", "new-session", "-d", "-s", "s1", "x"]);
    await exec(["-L", "tachyon", "new-session", "-d", "-s", "s2", "x"]);
    // first op: 2× systemd-run (retry) + plain tmux; second op still probes systemd-run and succeeds.
    expect(calls.map((c) => c.file)).toEqual(["systemd-run", "systemd-run", "tmux", "systemd-run"]);
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
    // Unique socket name — fixed "tss-scope" collides under global pgrep when workers share hosts.
    const socket = `tss-${process.pid}-${Date.now().toString(36)}`;
    const exec = createTmuxExecutor();
    try {
      await exec(["-L", socket, "new-session", "-d", "-s", "probe", "tail -f /dev/null"], { timeoutMs: 10_000 });
      // Oracle via the Unix socket owner (not pgrep -f "… new-session"): the client cmdline can
      // match wrong processes under load, and the server is the process that holds the socket.
      const sock = socketPath(socket);
      expect(fs.existsSync(sock), `missing tmux socket ${sock}`).toBe(true);
      const serverPids = tmuxServerPidsForSocket(sock);
      expect(serverPids.length, `no server pid for socket ${sock}`).toBeGreaterThan(0);
      const own = fs.readFileSync("/proc/self/cgroup", "utf8").trim();
      for (const pid of serverPids) {
        const serverCgroup = fs.readFileSync(`/proc/${pid}/cgroup`, "utf8").trim();
        expect(serverCgroup, `pid ${pid} still in caller cgroup (scoped launch fell back?)`).not.toBe(own);
        expect(
          serverCgroup,
          `pid ${pid} cgroup=${serverCgroup} — expected tachyon-tmux-*.scope (t-5f6355/t-ed5c25)`,
        ).toMatch(/tachyon-tmux-[a-f0-9]+\.scope/);
      }
    } finally {
      try { await exec(["-L", socket, "kill-server"], { timeoutMs: 5_000 }); } catch { /* already down */ }
      if (priorTmuxTmp === undefined) delete process.env.TMUX_TMPDIR;
      else process.env.TMUX_TMPDIR = priorTmuxTmp;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

/** Resolve the tmux server PID(s) that hold `sock` open (Linux). Prefer fuser; fall back to /proc scan. */
function tmuxServerPidsForSocket(sock: string): number[] {
  try {
    const out = execFileSync("fuser", [sock], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const pids = out.trim().split(/\s+/).map(Number).filter((n) => Number.isFinite(n) && n > 0);
    if (pids.length > 0) return [...new Set(pids)];
  } catch {
    /* fuser may exit 1 when no users; try /proc */
  }
  const found: number[] = [];
  for (const ent of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(ent)) continue;
    const fdDir = path.join("/proc", ent, "fd");
    let fds: string[];
    try {
      fds = fs.readdirSync(fdDir);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (fs.readlinkSync(path.join(fdDir, fd)) === sock) {
          found.push(Number(ent));
          break;
        }
      } catch {
        /* race */
      }
    }
  }
  return [...new Set(found)];
}
