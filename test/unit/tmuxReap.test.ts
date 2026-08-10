import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SOCKET_NAME } from "../../src/tmux/TmuxService.js";
import { makeSocketTemp } from "../helpers/socketTemp.js";
import { waitUntil } from "../helpers/settle.js";
import { tmuxChildEnv } from "../helpers/tmuxEnv.js";
import {
  assertReapableRoot,
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
