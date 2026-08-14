import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SOCKET_NAME } from "@tachyon/engine/tmux/TmuxService.js";
import { makeSocketTemp } from "../helpers/socketTemp.js";
import { waitUntil } from "../helpers/settle.js";
import { tmuxChildEnv } from "../helpers/tmuxEnv.js";
import {
  assertReapableRoot,
  isPaneForkChild,
  reapTmuxServers,
  reapTmuxServersUnder,
  tmuxServersUnder,
} from "../helpers/tmuxReap.js";

/**
 * `t-8f48da` — the reap that stops the suite leaking tmux servers, and the containment that keeps it
 * from ever reaching the fleet.
 *
 * Two properties, and they fail in opposite directions, which is why neither covers the other:
 *
 *  1. **A tmux server outlives its socket directory.** That is the defect in one sentence, and this
 *     file measures it rather than asserting it from the outside: the server is started, the
 *     directory is removed the way `t-25a908`'s hook removes it, and the server is observed still
 *     running. Everything else here would be theatre if that step were assumed.
 *  2. **Only a server whose OWN environment puts it inside a directory we created can be stopped.**
 *     `t-9713ff` killed every live agent on this host five times in one day, from code whose author
 *     believed a private `TMUX_TMPDIR` isolated it. So the refusals below name the three shapes that
 *     could put the fleet's socket (`<temp root>/tmux-<uid>/${DEFAULT_SOCKET_NAME}`) inside a swept
 *     tree, and the scan is shown BLIND to an ambient server rather than merely told to skip it.
 */

function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "pipe", env: tmuxChildEnv() });
    return true;
  } catch {
    return false;
  }
}

/** Every server this file starts gets its own socket NAME as well as its own directory. */
function privateSocketName(tag: string): string {
  return `tachyon-reap-${tag}-${process.pid}`;
}

function startServer(name: string, tmuxTmpdir: string | undefined): void {
  execFileSync(
    "tmux",
    ["-f", "/dev/null", "-L", name, "new-session", "-d", "-s", `${name}-anchor`, "tail -f /dev/null"],
    {
      stdio: "pipe",
      // `-L` pins the socket BEFORE the command word and TMUX is dropped: the two independent reasons
      // this cannot land on the inherited server.
      env: { ...tmuxChildEnv(), ...(tmuxTmpdir === undefined ? {} : { TMUX_TMPDIR: tmuxTmpdir }) },
    },
  );
}

function serverAlive(name: string, tmuxTmpdir: string | undefined): boolean {
  try {
    execFileSync("tmux", ["-L", name, "list-sessions"], {
      stdio: "pipe",
      env: { ...tmuxChildEnv(), ...(tmuxTmpdir === undefined ? {} : { TMUX_TMPDIR: tmuxTmpdir }) },
    });
    return true;
  } catch {
    return false;
  }
}

function stopServer(name: string, tmuxTmpdir: string | undefined): void {
  try {
    execFileSync("tmux", ["-L", name, "kill-server"], {
      stdio: "pipe",
      env: { ...tmuxChildEnv(), ...(tmuxTmpdir === undefined ? {} : { TMUX_TMPDIR: tmuxTmpdir }) },
    });
  } catch {
    /* already gone */
  }
}

/**
 * Every pid the scan would CONSIDER, before it classifies any of them — the pane fork child included.
 * The test needs to see what `tmuxServersUnder` hides, so this deliberately repeats the two identity
 * reads (`comm` and the server's own `TMUX_TMPDIR`) instead of calling it.
 */
function candidatePids(tmuxTmpdir: string): Array<{ pid: number; ppid: number; stdin: string | null }> {
  const found: Array<{ pid: number; ppid: number; stdin: string | null }> = [];
  for (const pid of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim() !== "tmux: server") continue;
      if (!fs.readFileSync(`/proc/${pid}/environ`, "utf8").includes(`TMUX_TMPDIR=${tmuxTmpdir}\0`)) continue;
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // Past the LAST `") "`: tmux's own comm is "(tmux: server)", so counting fields from the left
      // shifts every one of them.
      const ppid = Number(stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[1]);
      let stdin: string | null = null;
      try { stdin = fs.readlinkSync(`/proc/${pid}/fd/0`); } catch { /* unreadable */ }
      found.push({ pid: Number(pid), ppid, stdin });
    } catch {
      /* exited mid-scan */
    }
  }
  return found;
}

function processIsRunning(pid: number): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[0] !== "Z";
  } catch {
    return false;
  }
}

describe("t-8f48da — what may be swept, and what may never be", () => {
  it("accepts a fixture directory and refuses every shape that could contain the fleet's socket", () => {
    const fixture = makeSocketTemp("tachyon-reap-root-");
    expect(assertReapableRoot(fixture)).toBe(path.resolve(fixture));
    // Nested is fine — `trackTempDir` adopts directories a helper made inside one of ours.
    expect(assertReapableRoot(path.join(fixture, "tmux-tmp"))).toBe(path.join(path.resolve(fixture), "tmux-tmp"));

    // The temp root itself would sweep every agent's fixtures, and the fleet's socket directory with them.
    expect(() => assertReapableRoot("/tmp")).toThrow(/temp root itself/);
    expect(() => assertReapableRoot(os.tmpdir())).toThrow(/temp root itself/);
    // Where tmux puts a DEFAULT socket — derived from the product's own socket name, so this is the
    // fleet's actual path and not a lookalike. Every agent on this host is attached to it.
    const fleetSocket = path.join("/tmp", `tmux-${process.getuid?.() ?? 0}`, DEFAULT_SOCKET_NAME);
    expect(() => assertReapableRoot(path.dirname(fleetSocket))).toThrow(/default socket directory/);
    expect(() => assertReapableRoot(path.join(path.dirname(fleetSocket), "nested"))).toThrow(/default socket directory/);
    // Anything outside a temp root is somebody's real work — a worktree, a checkout, a home directory.
    expect(() => assertReapableRoot(process.cwd())).toThrow(/not inside a temp root/);
    expect(() => assertReapableRoot("/")).toThrow(/not inside a temp root/);
    // And the refusal is the reap's own front door, not a check a caller has to remember.
    expect(() => reapTmuxServersUnder(["/tmp"])).toThrow(/temp root itself/);
  });

  it.skipIf(!tmuxAvailable())(
    "a server survives the removal of its socket directory — and the reap stops it anyway",
    async () => {
      const fixture = makeSocketTemp("tachyon-reap-live-");
      const tmuxTmpdir = path.join(fixture, "tmux-tmp");
      fs.mkdirSync(tmuxTmpdir, { recursive: true, mode: 0o700 });
      const name = privateSocketName("live");
      try {
        startServer(name, tmuxTmpdir);

        // ONE record, read immediately: this assertion was red when written. For about a second after
        // a server starts, the process it forks for the first pane still carries its parent's `comm`
        // and environment, so a naive scan reports two servers where one exists and would signal a
        // pid that is about to become a shell. Reading right after `startServer` is what catches it.
        const before = tmuxServersUnder([fixture]);
        expect(before, "the scan finds the server by its own TMUX_TMPDIR").toHaveLength(1);
        expect(before[0]!.tmuxTmpdir).toBe(path.resolve(tmuxTmpdir));
        expect(before[0]!.socket).toBe(path.join(path.resolve(tmuxTmpdir), `tmux-${process.getuid?.() ?? 0}`, name));
        expect(before[0]!.tmuxTmpdirExists).toBe(true);
        expect(before[0]!.fromVitest, "spawned by a vitest worker, and its env says so").toBe(true);

        // THE DEFECT, measured: `t-25a908`'s hook removes the directory, and that is not cleanup.
        fs.rmSync(fixture, { recursive: true, force: true });
        expect(fs.existsSync(fixture)).toBe(false);
        const orphan = tmuxServersUnder([fixture]);
        expect(orphan, "the server is still running with its socket file gone").toHaveLength(1);
        expect(orphan[0]!.pid).toBe(before[0]!.pid);
        expect(orphan[0]!.tmuxTmpdirExists).toBe(false);

        // …and the pid path stops it even then, which is the state the host was found in.
        expect(reapTmuxServers(orphan)).toHaveLength(1);
        await waitUntil(
          () => tmuxServersUnder([fixture]).length,
          (count) => count === 0,
          { label: `tmux server ${orphan[0]!.pid} to exit` },
        );
      } finally {
        stopServer(name, tmuxTmpdir);
      }
    },
  );

  /**
   * `t-ffc5bf` — the false positive that failed 9 of 150 rounds of
   * `validationCloseSocketReachability` on a tree whose tests were all green.
   *
   * The daemon's shutdown was measured CORRECT: across 41 monitored rounds the anchor server was
   * born before the daemon exited (41/41) and died with it (never after). What outlived both, by up
   * to 40ms, was the process the server forks for the anchor's pane — a copy of the server down to
   * its `comm`, argv and environment. The parent-based rule drops that child only while its server
   * is alive to be its parent, so once the server exited the guard reported the child as a leaked
   * tmux server and failed the round. Nothing ever leaked: the process was gone on its own inside
   * 50ms, and 5 of 8 red rounds already said "Stopped 0 of them" because the reap found it dead.
   */
  it.skipIf(!tmuxAvailable())(
    "a pane fork child whose server already exited is not reported as a leaked server",
    () => {
      const fixture = makeSocketTemp("tachyon-reap-orphan-");
      const tmuxTmpdir = path.join(fixture, "tmux-tmp");
      fs.mkdirSync(tmuxTmpdir, { recursive: true, mode: 0o700 });
      const started: string[] = [];
      let child: number | undefined;
      let observed = false;
      try {
        // The child outlives its server by tens of milliseconds, so the observation can miss. Missing
        // it makes the assertion vacuous, never red — retry until the state is actually in hand, and
        // let the expectation below prove it was.
        for (let attempt = 0; attempt < 20 && !observed; attempt++) {
          const name = privateSocketName(`orphan-${attempt}`);
          started.push(name);
          startServer(name, tmuxTmpdir);
          const pair = candidatePids(path.resolve(tmuxTmpdir));
          const pids = new Set(pair.map((p) => p.pid));
          const forked = pair.find((p) => pids.has(p.ppid));
          const server = pair.find((p) => !pids.has(p.ppid));
          if (!forked || !server) continue;
          // The two are told apart HERE by parentage, on a live pair, which is what licenses telling
          // them apart by stdin once the parent is gone.
          expect(server.stdin, "a tmux server daemonizes onto /dev/null").toBe("/dev/null");
          expect(forked.stdin ?? "", "the pane fork child carries the pane's pts").toMatch(/^\/dev\/pts\//);

          // Contained by construction: a pid this test started, in a socket directory it created.
          process.kill(server.pid, "SIGKILL");
          child = forked.pid;
          if (!processIsRunning(child)) continue; // it beat us to exiting; try again
          const reported = tmuxServersUnder([fixture]).map((s) => s.pid);
          const aliveAfter = processIsRunning(child);
          if (!aliveAfter) continue; // it exited during the scan; try again
          // …and it really was still running while we said that.
          expect(aliveAfter, "the child was alive for the scan above").toBe(true);
          expect(
            reported,
            "the orphaned fork child is not a server, and its own server is gone",
          ).toEqual([]);
          observed = true;
        }
        expect(observed, "the orphaned-child state was reproduced").toBe(true);
      } finally {
        if (child !== undefined) { try { process.kill(child, "SIGKILL"); } catch { /* already gone */ } }
        for (const name of started) stopServer(name, tmuxTmpdir);
      }
    },
  );

  it("stdin separates the two, and an unreadable one is KEPT so the guard cannot go blind", () => {
    expect(isPaneForkChild("/dev/pts/8")).toBe(true);
    // What the kernel answers once the pty master is closed — the shape the guard actually meets.
    expect(isPaneForkChild("/dev/pts/8 (deleted)")).toBe(true);
    expect(isPaneForkChild("/dev/null")).toBe(false);
    // "I could not measure it" must never read as "it may pass": an unreadable fd 0 keeps the
    // candidate, so a real server stays visible to the guard on the one shape nobody can check.
    expect(isPaneForkChild(null)).toBe(false);
  });

  it.skipIf(!tmuxAvailable())(
    "the reap stops a server through its own socket, while an AMBIENT server stays invisible to the scan",
    async () => {
      const fixture = makeSocketTemp("tachyon-reap-scope-");
      const tmuxTmpdir = path.join(fixture, "tmux-tmp");
      fs.mkdirSync(tmuxTmpdir, { recursive: true, mode: 0o700 });
      const mine = privateSocketName("scope");
      // A server with NO private TMUX_TMPDIR: the shape the fleet's server has. Its socket lands in
      // the default directory beside the fleet's, under a name nothing else uses.
      const ambient = privateSocketName("ambient");
      try {
        startServer(mine, tmuxTmpdir);
        startServer(ambient, undefined);
        expect(serverAlive(ambient, undefined)).toBe(true);

        // The whole temp tree is offered to the scan, and it still returns only the one in OUR directory.
        const seen = tmuxServersUnder([fixture]);
        expect(seen.map((s) => s.tmuxTmpdir)).toEqual([path.resolve(tmuxTmpdir)]);

        expect(reapTmuxServersUnder([fixture])).toHaveLength(1);
        await waitUntil(
          () => serverAlive(mine, tmuxTmpdir),
          (alive) => alive === false,
          { label: "the fixture's own server to exit" },
        );
        // The one started the way the fleet's was is untouched — no env this reap could be handed
        // reaches it, because its own environ never named a private directory.
        expect(serverAlive(ambient, undefined), "an ambient server is out of reach by construction").toBe(true);
      } finally {
        stopServer(mine, tmuxTmpdir);
        stopServer(ambient, undefined);
      }
    },
  );
});
