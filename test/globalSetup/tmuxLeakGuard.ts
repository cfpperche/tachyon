import path from "node:path";
import {
  TMUX_REAP_TEMP_ROOTS,
  TMUX_RUN_STAMP_ENV,
  reapTmuxServers,
  tmuxServersUnder,
  type TmuxServerRecord,
} from "../helpers/tmuxReap.js";

/**
 * `t-8f48da` — after this suite finishes, no tmux server started into a private socket directory may
 * still be running. The reap in `test/helpers/tempDir.ts` is what makes that true; this is what makes
 * it CHECKED, and the two are deliberately not the same code path.
 *
 * WHY A GUARD AT ALL, when the leak is fixed. The fix closes one hook. A fixture that spawns tmux
 * without going through `makeSocketTemp`, a test file whose `afterAll` never runs because the worker
 * died, a future helper with its own temp directory — each of those reopens the leak, and none of
 * them would fail a single test. The leak was invisible for two days and reached 1946 processes
 * exactly because nothing measured it. So the measurement runs on every suite.
 *
 * WHAT MAKES A SERVER "OURS", and this is the part that decides whether the guard is safe on a host
 * running a whole fleet of agents in parallel. Three facts, all read from `/proc/<pid>` — never from a
 * process name, never from a command line, never from a fixture's prefix:
 *
 *  1. **It has its own `TMUX_TMPDIR`, under a temp root.** The fleet's server was started with none,
 *     so it cannot match this however anyone's env is set. `environ` is the server's OWN environment,
 *     captured when IT started, so a client with a mangled env cannot make the fleet look private.
 *  2. **Its cwd is inside this checkout**, or it carries this run's stamp. A tmux server inherits the
 *     cwd of the vitest worker that spawned it — which is why a leaked one pins a deleted worktree and
 *     wedges `kill_agent` — and a sibling agent's suite runs in a different worktree. Without this,
 *     agent A's guard would go red over agent B's leak.
 *  3. **It did not exist when this run started.** A server left behind by an earlier, unfixed run is
 *     reported for information and never fails the run that merely inherited it.
 *
 * Note what is NOT in that list: the fixture prefixes. The census that motivated this classified the
 * survivors as three separate producers by session name (`tachyon-ctl-*`, `*-looper`, `*-source`);
 * closing on those names would have left the next producer to leak in silence. Identity is the
 * creator — a vitest worker of this checkout writing into a private socket directory.
 *
 * WHAT IT DOES ON A FINDING: reports every leaked server with the evidence, stops them (contained, by
 * their own socket), and fails the run. Stopping them is not the fix and is not silent — the run is
 * red and the report names what was stopped. Leaving them alive would ask the next agent to pay for
 * this run's bug.
 */

const repoRoot = path.resolve(__dirname, "../..");
let stamp = "";
let baseline = new Set<number>();

function underRepo(dir: string): boolean {
  const resolved = path.resolve(dir);
  return resolved === repoRoot || resolved.startsWith(repoRoot + path.sep);
}

/** A server this run is answerable for. Exported so the guard's own test can drive it on records. */
export function attributable(server: TmuxServerRecord, runStamp: string): boolean {
  return underRepo(server.cwd) || (runStamp !== "" && server.runStamp === runStamp);
}

function describe(server: TmuxServerRecord): string {
  return `  pid ${server.pid}  TMUX_TMPDIR=${server.tmuxTmpdir}${server.tmuxTmpdirExists ? "" : " (already deleted)"}\n`
    + `      cwd=${server.cwd}${server.fromVitest ? "  [vitest worker]" : ""}\n`
    + `      ${server.argv.slice(0, 12).join(" ")}`;
}

export async function setup(): Promise<void> {
  // No Math.random: the pid plus the start instant is unique enough for one host and reproducible in
  // a log. Workers are forked after this returns, so they inherit it, and so does anything they spawn.
  stamp = `${process.pid}-${process.hrtime.bigint()}`;
  process.env[TMUX_RUN_STAMP_ENV] = stamp;
  baseline = new Set(tmuxServersUnder(TMUX_REAP_TEMP_ROOTS).map((server) => server.pid));
}

export async function teardown(): Promise<void> {
  const servers = tmuxServersUnder(TMUX_REAP_TEMP_ROOTS).filter((server) => attributable(server, stamp));
  const inherited = servers.filter((server) => baseline.has(server.pid));
  const leaked = servers.filter((server) => !baseline.has(server.pid));
  if (inherited.length > 0) {
    process.stderr.write(
      `[tmux-leak-guard] ${inherited.length} private-socket tmux server(s) predate this run — not this run's leak, left alone:\n`
      + `${inherited.map(describe).join("\n")}\n`,
    );
  }
  if (leaked.length === 0) return;
  const reaped = reapTmuxServers(leaked);
  throw new Error(
    `t-8f48da — this suite leaked ${leaked.length} tmux server(s) into private socket directories.\n`
    + `${leaked.map(describe).join("\n")}\n`
    + `Stopped ${reaped.length} of them so the host does not accumulate, but the leak is the defect, not the residue.\n`
    + `A tmux server outlives the directory its socket lived in, so removing the fixture directory is not cleanup: it\n`
    + `keeps running with the cwd of the vitest worker, which is this checkout — and that is what makes an agent's\n`
    + `dismiss refuse with "still has a live root process for its worktree". Create the directory through\n`
    + `test/helpers/socketTemp.ts (makeSocketTemp) or register it with trackTempDir, and test/helpers/tempDir.ts\n`
    + `will stop the server before it removes the directory.`,
  );
}
