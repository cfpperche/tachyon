import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tmuxChildEnv } from "./tmuxEnv.js";

/**
 * `t-8f48da` — a tmux server outlives the directory its socket lived in, so removing the fixture
 * directory is NOT cleanup.
 *
 * MEASURED 2026-08-09/10 on this host: **1946** live `tmux: server` processes, 1719 of them with a
 * cwd pointing at a worktree that had already been deleted, the oldest 2 days and 5 hours old. 91% of
 * every process the user owned was leaked tmux. The visible cost is not memory (~870 MB by PSS, not
 * the 7.1 GB a naive RSS sum reports): it is that `kill_agent` refuses to remove a worktree while a
 * process is alive inside it, so a coordinator's dismiss wedges with no explanation and the disk the
 * deleted worktree used never comes back.
 *
 * WHERE IT COMES FROM, and it is one place, not three. The census classified the survivors by session
 * name — `tachyon-ctl-<hash>` (174), `<hash>-looper` (34), `<hash>-source` (30) — which reads like
 * three independent producers. Crosstabbing them against `TMUX_TMPDIR` instead shows every one of
 * them rooted in a `makeSocketTemp()` directory (`test/helpers/socketTemp.ts`), which is
 * `trackTempDir` (`test/helpers/tempDir.ts`), which is one `afterAll`. `t-25a908` taught that hook to
 * remove the DIRECTORY; a tmux server whose socket file is unlinked keeps running quite happily. The
 * proof is direct: of the leaked servers measured here, not one of their `TMUX_TMPDIR` directories
 * still existed on disk.
 *
 * WHY IDENTITY COMES FROM `/proc` AND NOT FROM A NAME. `docs/project-guidance.md` § "Who else can
 * reach this?" bans stopping a process by name or command-line pattern (`pkill`, `killall`) on a
 * shared host, and this host runs a whole fleet of agents. So a server is ours only when its OWN
 * environment says its socket lives under a directory we created — `TMUX_TMPDIR` read from
 * `/proc/<pid>/environ`, which is captured when the SERVER starts and can never be the client's. The
 * fleet's server was started with no `TMUX_TMPDIR` at all, so it cannot match this predicate however
 * a caller's env is mangled — that is the structural reason this cannot repeat `t-9713ff`, where a
 * private `TMUX_TMPDIR` was believed to isolate and `kill-server` took the whole fleet down five
 * times in one day. `assertReapableRoot` refuses the shapes that could contain the fleet socket
 * anyway, so the containment is asserted rather than argued.
 */

/** Where a fixture is allowed to have put a private `TMUX_TMPDIR`. */
const TEMP_ROOTS: readonly string[] = [
  ...new Set(["/tmp", os.tmpdir(), process.env.TMPDIR ?? ""].filter(Boolean).map((p) => path.resolve(p))),
];

/** `<temp root>/tmux-<uid>` is where tmux puts a DEFAULT socket — the fleet's included. Never a root. */
const DEFAULT_SOCKET_DIR = /^tmux-\d+$/;

/** Set by the leak guard's `globalSetup` so a server can name the run that produced it. */
export const TMUX_RUN_STAMP_ENV = "TACHYON_TMUX_LEAK_RUN";

export interface TmuxServerRecord {
  readonly pid: number;
  readonly ppid: number;
  /** `TMUX_TMPDIR` as the server itself was started with, read from `/proc/<pid>/environ`. */
  readonly tmuxTmpdir: string;
  /** False once the fixture removed its directory — the shape that proves removal is not cleanup. */
  readonly tmuxTmpdirExists: boolean;
  /** Absolute socket path when the argv resolves one, else null (the server is still killable by pid). */
  readonly socket: string | null;
  readonly cwd: string;
  readonly argv: readonly string[];
  /** True when the server's own env says it was started by a vitest worker. */
  readonly fromVitest: boolean;
  /** The suite run that spawned it, when the stamp reached this far; "" otherwise. */
  readonly runStamp: string;
}

/**
 * Is `dir` a directory we may reap servers out of?
 *
 * Three refusals, each naming a way the fleet's socket (`<temp root>/tmux-<uid>/tachyon`) could end
 * up inside the tree we sweep: the temp root itself, anything outside a temp root, and tmux's own
 * default socket directory. A `mkdtemp` result can never be any of them, which is the point — the
 * check costs nothing and turns "a tracked dir is always private" from an assumption into a test.
 */
export function assertReapableRoot(dir: string): string {
  const resolved = path.resolve(dir);
  if (TEMP_ROOTS.includes(resolved)) {
    throw new Error(`refusing to reap tmux servers under ${resolved}: that is the temp root itself`);
  }
  const root = TEMP_ROOTS.find((candidate) => resolved.startsWith(candidate + path.sep));
  if (!root) {
    throw new Error(`refusing to reap tmux servers under ${resolved}: not inside a temp root (${TEMP_ROOTS.join(", ")})`);
  }
  const segments = path.relative(root, resolved).split(path.sep);
  if (DEFAULT_SOCKET_DIR.test(segments[0]!)) {
    throw new Error(`refusing to reap tmux servers under ${resolved}: ${segments[0]} is tmux's default socket directory — the fleet lives there`);
  }
  return resolved;
}

/** `fd 0` as the kernel resolves it, or null when it cannot be read. */
function stdinOf(pid: string): string | null {
  try { return fs.readlinkSync(`/proc/${pid}/fd/0`); } catch { return null; }
}

/**
 * `t-ffc5bf` — is this candidate the process a tmux server FORKS FOR A PANE, rather than a server?
 *
 * Measured on tmux 3.6, 60/60 deterministic reproductions of the state the guard actually observes:
 * a server daemonizes with `/dev/null` on 0/1/2, while the child it forks for a pane has already
 * called `login_tty` and carries the pane's pts on the same descriptors. Nothing else separates
 * them — the child is a copy of the server down to its `comm`, argv and environment.
 *
 * Two fields were tried and rejected before this one, both by measurement rather than by argument.
 * `tty_nr` looks like the same fact and is worthless here: in 20 of 41 observed children the tty is
 * REVOKED when the server dies, so both read 0 in exactly the window that matters. "Holds an open
 * `/dev/ptmx`" is the server's positive identity and would go blind on a real leak, because a server
 * whose panes are all dead (`pane_dead`, first-class in this repo) holds no pty master at all.
 *
 * `null` — fd 0 unreadable — KEEPS the candidate, and that direction is the whole point rather than
 * caution: "I could not measure it" must never read as "it may pass". A real server whose `/proc`
 * turns unreadable has to stay visible to the guard; reading the fallback the other way would delete
 * a leak report on the one shape nobody can check.
 */
export function isPaneForkChild(stdin: string | null): boolean {
  return stdin !== null && stdin.startsWith("/dev/pts/");
}

function readEnviron(pid: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const entry of fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) env.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return env;
}

/**
 * Parent pid from `/proc/<pid>/stat`, past the `(comm)` field — which contains spaces and brackets in
 * tmux's case ("(tmux: server)"), so the LAST `") "` is the only safe anchor.
 */
function parentOf(pid: string): number {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  return Number(stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[1]);
}

/** `-S <path>` wins over `-L <name>`; both only count in the leading global-flag section. */
function socketOf(argv: readonly string[], tmuxTmpdir: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-S" && argv[i + 1]) return path.resolve(argv[i + 1]!);
    if (argv[i] === "-L" && argv[i + 1]) return path.join(tmuxTmpdir, `tmux-${process.getuid?.() ?? 0}`, argv[i + 1]!);
  }
  return null;
}

/**
 * Every live tmux server whose OWN `TMUX_TMPDIR` sits strictly under one of `roots`.
 *
 * Linux-only by construction (`/proc`); elsewhere it answers "none", because a suite that cannot see
 * the processes must not guess at them. `makeSocketTemp` already pins `/tmp` on Linux for the same
 * platform reason.
 */
export function tmuxServersUnder(roots: readonly string[]): TmuxServerRecord[] {
  if (roots.length === 0 || !fs.existsSync("/proc/self")) return [];
  const bounds = roots.map((root) => path.resolve(root) + path.sep);
  const found: TmuxServerRecord[] = [];
  for (const pid of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      // tmux rewrites its own `comm` to "tmux: server"; `pgrep -x tmux` therefore reports ZERO and
      // reading the cmdline instead would be the command-line matching this file exists to avoid.
      if (fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim() !== "tmux: server") continue;
      const env = readEnviron(pid);
      const tmuxTmpdir = env.get("TMUX_TMPDIR");
      if (!tmuxTmpdir) continue; // the fleet's server has none — this is the line that spares it
      const resolved = path.resolve(tmuxTmpdir) + path.sep;
      if (!bounds.some((bound) => resolved.startsWith(bound))) continue;
      // t-ffc5bf — drop the pane fork child HERE, because the parent-based rule at the bottom can
      // only see it while its server is still alive. Once the server has exited — which is the
      // CORRECT outcome of a fixture's teardown — the child is reparented to init/systemd, survives
      // that rule, and gets reported as a leaked server: measured 9 of 150 rounds of
      // `validationCloseSocketReachability` red on a green tree, the process gone on its own within
      // 50ms every time and nothing left on the host. The two rules cover complementary windows.
      if (isPaneForkChild(stdinOf(pid))) continue;
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      found.push({
        pid: Number(pid),
        ppid: parentOf(pid),
        tmuxTmpdir: path.resolve(tmuxTmpdir),
        tmuxTmpdirExists: fs.existsSync(tmuxTmpdir),
        socket: socketOf(argv, path.resolve(tmuxTmpdir)),
        cwd: fs.readlinkSync(`/proc/${pid}/cwd`),
        argv,
        fromVitest: env.has("VITEST") || env.has("VITEST_WORKER_ID"),
        runStamp: env.get(TMUX_RUN_STAMP_ENV) ?? "",
      });
    } catch {
      // A pid that exits mid-scan, or one we may not read: not ours to reap either way.
    }
  }
  // While a server is starting, the process it forks for the first pane still carries the parent's
  // `comm` ("tmux: server") and its whole environment until it execs — measured on tmux 3.6: two
  // matching pids for ~a second, one the child of the other. Counting both would make a leak report
  // say two where one server exists, and would send a signal to a pid that is about to become a
  // shell. A server never has a server for a parent, so the child is the one to drop.
  // This rule holds only while the SERVER is still alive to be that parent, which is why the stdin
  // rule above exists: it is the same child seen after its server exited (t-ffc5bf).
  const pids = new Set(found.map((server) => server.pid));
  return found.filter((server) => !pids.has(server.ppid));
}

/**
 * Stop `servers`, socket first and pid second.
 *
 * `tmux -S <socket> kill-server` is preferred because it addresses the server through the very file
 * we own — there is no pid to go stale between reading it and signalling it. `tmuxChildEnv()` drops
 * `$TMUX`, which tmux consults BEFORE `$TMUX_TMPDIR` (`t-9713ff`), and the socket flag precedes the
 * command word so it pins the server rather than being read as a per-command flag.
 *
 * When the fixture removed its directory before we got here the socket file is gone and only the pid
 * remains. Signalling it is safe for the same reason it was selected: `/proc/<pid>/environ` was read
 * moments ago and named a directory we created. Re-read it before signalling anyway, so a pid the
 * kernel recycled in between is left alone.
 */
export function reapTmuxServers(servers: readonly TmuxServerRecord[]): TmuxServerRecord[] {
  const reaped: TmuxServerRecord[] = [];
  for (const server of servers) {
    if (server.socket) {
      try {
        execFileSync("tmux", ["-S", server.socket, "kill-server"], {
          env: tmuxChildEnv(),
          timeout: 10_000,
          stdio: "ignore",
        });
        reaped.push(server);
        continue;
      } catch {
        // No server on that socket any more, or no tmux binary: fall through to the pid.
      }
    }
    try {
      if (fs.readFileSync(`/proc/${server.pid}/comm`, "utf8").trim() !== "tmux: server") continue;
      if (readEnviron(String(server.pid)).get("TMUX_TMPDIR") !== server.tmuxTmpdir) continue;
      process.kill(server.pid, "SIGTERM");
      reaped.push(server);
    } catch {
      // Already gone.
    }
  }
  return reaped;
}

/**
 * The one call a fixture needs: stop every tmux server whose socket lives under `dir`.
 *
 * Called from `trackTempDir`'s `afterAll` BEFORE the directory is removed, which is the only moment
 * when both facts are still true — the directory is still ours, and the socket file still exists.
 */
export function reapTmuxServersUnder(dirs: readonly string[]): TmuxServerRecord[] {
  const roots = dirs.map(assertReapableRoot);
  return reapTmuxServers(tmuxServersUnder(roots));
}

export const TMUX_REAP_TEMP_ROOTS = TEMP_ROOTS;
