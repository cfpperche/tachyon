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
  it("refuses while the holder is alive and names the lock", () => {
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

  it("steals a lock whose holder pid is gone", () => {
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
  it("steals a holder older than maxHoldMs even though its pid answers", () => {
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
  it("recovers a legacy mkdir lock directory left at the same path", () => {
    const lock = path.join(tempRoot(), "thing.lock");
    fs.mkdirSync(lock);
    age(lock, 60_000);
    const held = acquireProcessLock(lock, DEAD);
    expect(fs.statSync(lock).isDirectory()).toBe(false);
    held.release();
  });

  it("times out naming the lock when the holder stays alive", () => {
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
    const pin = store.create("after the crash", "human");
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
});
