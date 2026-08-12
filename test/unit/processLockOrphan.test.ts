import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  acquireProcessLock,
  ProcessLockBusyError,
  withProcessLock,
  withProcessLockSync,
} from "../../src/locks/processLock.js";
import { PinStore } from "../../src/pins/PinStore.js";
import {
  appendDmChatEvent,
  designModeChatLockPath,
  readAllDmChatEvents,
} from "../../src/webview/ide-browser-bridge/designModeChat.js";

/**
 * t-7843d0 — a cross-process lock whose holder died must not wedge the product.
 *
 * The guard is stated as a behaviour, not as an implementation: KILL the owner and prove the next
 * writer proceeds, at both doors that take a lock. The pre-change measurement on this tree was
 * dm-chat wedged 10002ms then threw, pins wedged 5007ms then threw — and both stayed that way until
 * somebody deleted the lock by hand.
 */

type LockHolderProcess = ChildProcessByStdio<null, Readable, Readable>;

const ALIVE = { isHolderAlive: () => true };
const DEAD = { isHolderAlive: () => false };

const roots: string[] = [];

function tempRoot(prefix = "tachyon-process-lock-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function age(file: string, ms: number): void {
  const when = new Date(Date.now() - ms);
  fs.utimesSync(file, when, when);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("processLock", () => {
  it("refuses while the holder is alive and names the lock", async () => {
    const lock = path.join(tempRoot(), "thing.lock");
    const held = acquireProcessLock(lock, ALIVE);
    try {
      expect(() => acquireProcessLock(lock, ALIVE)).toThrow(ProcessLockBusyError);
      expect(fs.existsSync(lock)).toBe(true);
    } finally {
      held.release();
    }
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("steals a lock whose holder pid is gone", async () => {
    const lock = path.join(tempRoot(), "thing.lock");
    fs.writeFileSync(lock, "424242\n");
    const held = acquireProcessLock(lock, DEAD);
    expect(Number.parseInt(fs.readFileSync(lock, "utf8").trim(), 10)).toBe(process.pid);
    held.release();
    expect(fs.existsSync(lock)).toBe(false);
  });

  /**
   * Liveness alone is a false positive waiting to happen: pids are recycled, and a recycled pid that
   * matches a dead holder's makes the wedge permanent again. The timestamp is what stops the worst
   * case, so it is asserted against a holder that IS alive.
   */
  it("steals a holder older than maxHoldMs even though its pid answers", async () => {
    const lock = path.join(tempRoot(), "thing.lock");
    fs.writeFileSync(lock, "424242\n");
    age(lock, 60_000);

    expect(() => acquireProcessLock(lock, { ...ALIVE, maxHoldMs: 30_000 })).not.toThrow();
    expect(() => acquireProcessLock(path.join(tempRoot(), "other.lock"), ALIVE)).not.toThrow();

    const fresh = path.join(tempRoot(), "fresh.lock");
    fs.writeFileSync(fresh, "424242\n");
    // Young and alive is still a holder — age must not become a blanket steal.
    expect(() => acquireProcessLock(fresh, { ...ALIVE, maxHoldMs: 30_000 })).toThrow(ProcessLockBusyError);
  });

  it("leaves a foreign lock alone when ours was taken from us mid-body", async () => {
    const lock = path.join(tempRoot(), "thing.lock");
    await withProcessLock(lock, () => {
      fs.rmSync(lock);
      fs.writeFileSync(lock, "424242\n"); // somebody else now owns the path
    }, { timeoutMs: 1_000 });
    expect(fs.readFileSync(lock, "utf8").trim()).toBe("424242");
  });

  /**
   * The lock this replaces was a DIRECTORY. An orphan left by an older window must be recoverable, or
   * the migration itself is the permanent wedge it was written to remove.
   */
  it("recovers a legacy mkdir lock directory left at the same path", async () => {
    const lock = path.join(tempRoot(), "thing.lock");
    fs.mkdirSync(lock);
    age(lock, 60_000);
    const held = acquireProcessLock(lock, DEAD);
    expect(fs.statSync(lock).isDirectory()).toBe(false);
    held.release();
  });

  it("times out naming the lock when the holder stays alive", async () => {
    const lock = path.join(tempRoot(), "thing.lock");
    const held = acquireProcessLock(lock, ALIVE);
    try {
      expect(() => withProcessLockSync(lock, () => "must not run", {
        ...ALIVE,
        timeoutMs: 50,
        pollMs: 10,
        label: "the thing lock",
      })).toThrow(/timed out after 50ms waiting for the thing lock/);
    } finally {
      held.release();
    }
  });

  /**
   * t-b457ce — under multi-process contention, processLock must not admit two critical sections
   * at once. pinlock3 measured dual holders even with isHolderAlive:()=>true and no maxHoldMs;
   * steals were logged as reason=absent (force-rm of a lock that vanished between EEXIST and stat
   * deleted a *new* holder's lock published in the gap). This harness is the commit gap that
   * measurement left open.
   *
   * What this does NOT cover: `isHolderAlive: () => true` (and no maxHoldMs) never takes the
   * orphan-recovery branch, so the post-orphan path-rm never runs. A green result here proves the
   * absent path only — not residual dual-holder risk between last identity read and rmSync when a
   * real holder dies under multi-waiter load.
   */
  it("does not admit dual holders under multi-process contention (t-b457ce)", async () => {
    const repoRoot = process.cwd();
    const scratch = tempRoot("tachyon-lock-contend-");
    const lock = path.join(scratch, "contend.lock");
    const holdProbe = path.join(scratch, "hold.probe");
    const counterPath = path.join(scratch, "counter");
    const overlapPath = path.join(scratch, "overlaps.jsonl");
    fs.writeFileSync(counterPath, "0\n", "utf8");
    fs.writeFileSync(overlapPath, "", "utf8");

    const workerCount = 6;
    const iters = 40;
    const workerPath = path.join(scratch, "contender.ts");
    const lockUrl = pathToFileURL(path.join(repoRoot, "src/locks/processLock.ts")).href;
    fs.writeFileSync(workerPath, `
      import fs from "node:fs";
      import { withProcessLockSync } from ${JSON.stringify(lockUrl)};
      const lock = process.argv[2]!;
      const holdProbe = process.argv[3]!;
      const counterPath = process.argv[4]!;
      const overlapPath = process.argv[5]!;
      const iters = Number(process.argv[6]!);
      // Age-steal and dead-pid steal both disabled: only the absent-path race remains.
      const opts = { timeoutMs: 30_000, pollMs: 1, isHolderAlive: () => true };
      for (let i = 0; i < iters; i++) {
        withProcessLockSync(lock, () => {
          if (fs.existsSync(holdProbe)) {
            const other = fs.readFileSync(holdProbe, "utf8").trim();
            fs.appendFileSync(overlapPath, JSON.stringify({
              pid: process.pid, other, i, t: Date.now(),
            }) + "\\n");
          }
          fs.writeFileSync(holdProbe, String(process.pid) + "\\n");
          // Widen the critical section enough that a stolen lock is observable.
          const start = Date.now();
          while (Date.now() - start < 2) { /* spin */ }
          const n = Number.parseInt(fs.readFileSync(counterPath, "utf8").trim(), 10);
          fs.writeFileSync(counterPath, String(n + 1) + "\\n");
          try { fs.unlinkSync(holdProbe); } catch { /* foreign cleared it — dual holder */ }
        }, opts);
      }
    `, "utf8");

    const viteNode = path.join(repoRoot, "node_modules", ".bin", "vite-node");
    await Promise.all(Array.from({ length: workerCount }, (_, w) => new Promise<void>((resolve, reject) => {
      const child = spawn(viteNode, [
        "--root", repoRoot, workerPath, lock, holdProbe, counterPath, overlapPath, String(iters),
      ], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`contender ${w} exited ${code}: ${stderr}`));
      });
    })));

    const overlaps = fs.readFileSync(overlapPath, "utf8").split("\n").filter((l) => l.trim());
    const total = Number.parseInt(fs.readFileSync(counterPath, "utf8").trim(), 10);
    expect(overlaps, `dual holders observed: ${overlaps.slice(0, 5).join(" | ")}`).toEqual([]);
    expect(total).toBe(workerCount * iters);
  }, 120_000);

  /**
   * t-07ccde — the post-orphan path-rm TOCTOU is real, measured, and deliberately accepted.
   * On 2026-08-05 the production-shaped harness measured zero dual holders across 120 orphan
   * recoveries / ~23,000 critical sections; continuous mutual-kill stress measured about two
   * episodes in 1,455 holder SIGKILLs (~1/750). The revisit trigger is a sustained field rate,
   * such as lost pin/chat writes after crash storms; a provoking test failure in a loaded gate
   * does not meet it.
   *
   * This rare, accepted overlap is intentionally NOT a standard-gate invariant. Measure it with:
   *   npx vite-node --root . scripts/spikes/processLock-orphan-toctou-measure.mts
   *   npx vite-node --root . scripts/spikes/processLock-orphan-toctou-continuous.mts
   *
   * Keep this note beside t-b457ce: that deterministic test disables orphan recovery, so it
   * cannot be mistaken for coverage of this residual or used to justify returning the provoking
   * scenario to the standard gate.
   */
});

/**
 * The production doors. The owner is a REAL process holding the REAL lock through the code the
 * product runs, and it is SIGKILLed — no `finally`, no cleanup, exactly what a closed window, a
 * crashed extension host or a `kill_agent` leaves behind.
 */
describe("a killed lock owner does not wedge the next writer (t-7843d0)", () => {
  const repoRoot = process.cwd();
  let scratch: string;
  let children: LockHolderProcess[] = [];

  beforeEach(() => {
    scratch = tempRoot("tachyon-lock-owner-");
    children = [];
  });

  afterEach(() => {
    for (const child of children) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  });

  function srcUrl(relative: string): string {
    return JSON.stringify(pathToFileURL(path.join(repoRoot, relative)).href);
  }

  /** Spawn a worker and resolve once it reports that it holds the lock. */
  async function holder(source: string, args: string[]): Promise<LockHolderProcess> {
    const workerPath = path.join(scratch, `holder-${children.length}.ts`);
    fs.writeFileSync(workerPath, source, "utf8");
    const child = spawn(
      path.join(repoRoot, "node_modules", ".bin", "vite-node"),
      ["--root", repoRoot, workerPath, ...args],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    await new Promise<void>((resolve, reject) => {
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.includes("held")) resolve();
      });
      child.on("exit", (code) => reject(new Error(`holder exited ${code} before holding: ${stderr}`)));
      child.on("error", reject);
    });
    return child;
  }

  async function kill(child: LockHolderProcess): Promise<void> {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
  }

  it("Design Mode chat: append proceeds after the owner is killed", async () => {
    const workspaceRoot = path.join(scratch, "ws-chat");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const child = await holder(`
      import { withDmChatWriteLock } from ${srcUrl("src/webview/ide-browser-bridge/designModeChat.ts")};
      const root = process.argv[2]!;
      await withDmChatWriteLock(root, () => new Promise(() => {
        process.stdout.write("held\\n");
      }));
    `, [workspaceRoot]);

    const lock = designModeChatLockPath(workspaceRoot);
    expect(Number.parseInt(fs.readFileSync(lock, "utf8").trim(), 10)).toBe(child.pid);
    await kill(child);
    // The owner is gone and its lock is still on disk — this is the orphan.
    expect(fs.existsSync(lock)).toBe(true);

    const started = Date.now();
    const event = await appendDmChatEvent(workspaceRoot, {
      kind: "message",
      role: "user",
      text: "after the crash",
      activeAgent: "grok",
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(event.lineNo).toBe(1);
    expect(readAllDmChatEvents(workspaceRoot)).toHaveLength(1);
    expect(fs.existsSync(lock)).toBe(false);
  }, 60_000);

  it("pins: mutation proceeds after the owner is killed", async () => {
    const workspaceRoot = path.join(scratch, "ws-pins");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const child = await holder(`
      import { acquireProcessLock } from ${srcUrl("src/locks/processLock.ts")};
      import { PinStore } from ${srcUrl("src/pins/PinStore.ts")};
      acquireProcessLock(new PinStore(process.argv[2]!).lockPath);
      process.stdout.write("held\\n");
      setInterval(() => {}, 1_000);
    `, [workspaceRoot]);

    const store = new PinStore(workspaceRoot);
    expect(Number.parseInt(fs.readFileSync(store.lockPath, "utf8").trim(), 10)).toBe(child.pid);
    await kill(child);
    expect(fs.existsSync(store.lockPath)).toBe(true);

    const started = Date.now();
    const pin = await store.create("after the crash", "human");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(store.list().map((p) => p.id)).toEqual([pin.id]);
    expect(fs.existsSync(store.lockPath)).toBe(false);
  }, 60_000);

  /**
   * The second half of the guard: waiting for a LIVE holder must not stop the extension host. The
   * proof is a timer — it cannot tick at all while `Atomics.wait` holds the thread, which is what the
   * previous implementation did for up to ten seconds.
   */
  it("Design Mode chat: waiting for a live holder keeps the event loop running", async () => {
    const workspaceRoot = path.join(scratch, "ws-live");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    await holder(`
      import { withDmChatWriteLock } from ${srcUrl("src/webview/ide-browser-bridge/designModeChat.ts")};
      const root = process.argv[2]!;
      const holdMs = Number(process.argv[3]!);
      await withDmChatWriteLock(root, async () => {
        process.stdout.write("held\\n");
        await new Promise((resolve) => setTimeout(resolve, holdMs));
      });
    `, [workspaceRoot, "800"]);

    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 20);
    const started = Date.now();
    try {
      await appendDmChatEvent(workspaceRoot, {
        kind: "message",
        role: "user",
        text: "queued behind another window",
        activeAgent: "grok",
      });
    } finally {
      clearInterval(timer);
    }
    // It really did wait for the other process...
    expect(Date.now() - started).toBeGreaterThan(200);
    // ...without freezing the host while it did.
    expect(ticks).toBeGreaterThanOrEqual(5);
  }, 60_000);

  it("pins: waiting for a live holder keeps the event loop running", async () => {
    const workspaceRoot = path.join(scratch, "ws-pins-live");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    await holder(`
      import { withProcessLock } from ${srcUrl("src/locks/processLock.ts")};
      import { PinStore } from ${srcUrl("src/pins/PinStore.ts")};
      const store = new PinStore(process.argv[2]!);
      const holdMs = Number(process.argv[3]!);
      await withProcessLock(store.lockPath, async () => {
        process.stdout.write("held\\n");
        await new Promise((resolve) => setTimeout(resolve, holdMs));
      }, { timeoutMs: 5_000 });
    `, [workspaceRoot, "800"]);

    const store = new PinStore(workspaceRoot);
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 20);
    const started = Date.now();
    try {
      await store.create("queued behind another window", "human");
    } finally {
      clearInterval(timer);
    }
    expect(Date.now() - started).toBeGreaterThan(200);
    expect(ticks).toBeGreaterThanOrEqual(5);
  }, 60_000);
});
