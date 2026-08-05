import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The one cross-process advisory lock in the product (t-7843d0).
 *
 * This is not a new mechanism. It is `src/runtimeConfig/sourceLock.ts` (t-ce83a2) lifted out of
 * Runtime Config so the other consumers stop reinventing it — `withRuntimeConfigSourceLock` is now a
 * caller of this file and its on-disk format is unchanged. What it replaces is the repo's OTHER
 * cross-process pattern: an exclusive `mkdirSync` of a lock DIRECTORY, copied into `PinStore` and
 * then into the Design Mode chat log, with no staleness check at all. A holder that died — a window
 * closed mid-write, an extension-host crash, a `kill_agent` — left that directory behind forever, so
 * every later writer burned the whole timeout and then threw, and the only repair was deleting the
 * directory by hand. Governed refusal without governed recovery (t-0cbcbd).
 *
 * The exclusion mechanisms that remain, and why this one is not a fourth:
 *
 *  - THIS file — every cross-process lock in the extension (runtime config sources, pins, chat log).
 *  - `acquireVerifyFullLock` in `scripts/verify-full.mjs` — the build gate's own mutex, in tmpdir,
 *    outside the bundle, with a different contract (one gate at a time, queued by the CLI). It is a
 *    script, not product code, and cannot import TypeScript.
 *  - `withSoulProfileAdmission` in `src/agents/soul.ts` — IN-PROCESS admission per principal. It is
 *    not an answer to "another window is writing this file" and never was.
 *
 * ## Who else can reach a lock, and what happens
 *
 * | actor × trigger                          | outcome                                              |
 * |------------------------------------------|------------------------------------------------------|
 * | holder releases normally                 | `release` unlinks the file it created                |
 * | holder dies (crash / kill / window close)| next arrival may steal; residual path-rm TOCTOU (↓)  |
 * | holder is alive and working              | arrival waits, then times out naming the path        |
 * | holder's pid was REUSED by another proc  | age exceeds `maxHoldMs` → stolen (see below)         |
 * | holder is mid-create, pid not stamped yet| grace window protects it; older than that is a crash |
 * | lock vanished between EEXIST and stat    | busy → retry publish; never force-rm (t-b457ce)      |
 * | our lock was stolen from us mid-body     | `release` sees a foreign lock and leaves it alone    |
 * | a legacy `mkdir` lock DIRECTORY is there | unreadable → aged out → removed recursively          |
 *
 * ## Why liveness alone is not enough
 *
 * `sourceLock` judges an orphan purely by "does the holder pid still answer", and resolves pid reuse
 * toward refusing: for a save that a human retries, a spurious "in progress" is the safe side. A
 * WAITING lock cannot take that trade — a recycled pid that happens to match a dead holder's is a
 * permanent wedge again, which is the exact defect this file exists to remove. So a holder also has
 * an AGE, and `maxHoldMs` (opt-in, off by default so Runtime Config keeps its old semantics) makes a
 * lock held longer than any legitimate critical section stealable even while its pid answers.
 *
 * That trade is deliberate and worth stating: stealing from a live-but-stalled holder can produce two
 * concurrent writers, whose worst case is one malformed record (rare, recoverable, and repairable on
 * the next write). Not stealing produces a chat log or a pin file that nobody can write again without
 * a human deleting a file. Callers pick `maxHoldMs` far above their real hold — milliseconds of
 * read-modify-write against seconds — so the only holder it can rob is one that is no longer running.
 */

export interface ProcessLockOptions {
  /** Injected by tests. Production asks the OS whether the pid is still around. */
  isHolderAlive?: (pid: number) => boolean;
  /**
   * A holder older than this is treated as orphaned even when its pid answers — the pid-reuse guard.
   * Undefined means age never steals (liveness only), which is what Runtime Config wants.
   */
  maxHoldMs?: number;
  /** Injected by tests. */
  now?: () => number;
}

export interface ProcessLockWaitOptions extends ProcessLockOptions {
  /** How long to wait for a live holder before giving up. */
  timeoutMs: number;
  /** How often to retry while waiting. */
  pollMs?: number;
  /** Human-readable name of what this lock protects, used in the timeout message. */
  label?: string;
}

export interface HeldProcessLock {
  readonly path: string;
  /** Releases only the lock THIS acquisition created. */
  release(): void;
}

export class ProcessLockBusyError extends Error {
  readonly code = "PROCESS_LOCK_BUSY";
  constructor(readonly lockPath: string, readonly holderPid: number | null) {
    super(
      `lock ${lockPath} is held${holderPid === null ? "" : ` by pid ${holderPid}`}`,
    );
    this.name = "ProcessLockBusyError";
  }
}

/**
 * A lock whose pid cannot be read yet is NOT evidence of a crash: on the fallback publish path the
 * create and the stamp are two steps, so a holder that is mid-create looks exactly like one that died
 * mid-create. Age is what tells them apart, and it has to, because guessing either way is a real
 * failure — "gone" robs a live holder, "alive" is the permanent wedge. Two seconds is far longer than
 * the microseconds between `open` and `write`, and far shorter than a human noticing a stuck write.
 */
const UNSTAMPED_LOCK_GRACE_MS = 2_000;

const DEFAULT_POLL_MS = 25;

function defaultIsHolderAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to another user — existing is what we asked.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LockHolder {
  /** null when the lock carries no readable pid — mid-create, or a legacy lock DIRECTORY. */
  pid: number | null;
  stampedAtMs: number;
}

function readHolder(lock: string): LockHolder | null {
  let stampedAtMs: number;
  try {
    stampedAtMs = fs.statSync(lock).mtimeMs;
  } catch {
    // Vanished between EEXIST and this read — releaser won the race. Callers must retry publish
    // (busy), not force-rm: another holder may land in that gap (t-b457ce dual writers).
    return null;
  }
  let raw = "";
  try {
    raw = fs.readFileSync(lock, "utf8");
  } catch {
    // EISDIR for a legacy mkdir lock, or unreadable — either way there is no pid to trust.
  }
  const pid = Number.parseInt(raw.trim(), 10);
  return { pid: Number.isInteger(pid) && pid > 0 ? pid : null, stampedAtMs };
}

/**
 * Whether a holder we already read is still protecting the lock.
 * Callers must NOT treat "lock file vanished" as orphan-stealable — that is a separate case
 * (t-b457ce): the releaser won the race, and force-removing after an absent read is a TOCTOU
 * that can delete a *new* holder's lock published in the gap.
 */
function holderIsAlive(holder: LockHolder, options: ProcessLockOptions): boolean {
  const now = (options.now ?? Date.now)();
  if (holder.pid === null) return now - holder.stampedAtMs < UNSTAMPED_LOCK_GRACE_MS;
  if (!(options.isHolderAlive ?? defaultIsHolderAlive)(holder.pid)) return false;
  if (options.maxHoldMs !== undefined && now - holder.stampedAtMs > options.maxHoldMs) return false;
  return true;
}

/**
 * Publish an ALREADY-STAMPED lock, atomically, without ever overwriting a holder.
 *
 * `open(wx)` + `write` gives exclusion but publishes an empty file first, so a competitor can see a
 * lock with no pid. `rename` would fix the emptiness and break the exclusion, because it replaces
 * whatever is there — it would clobber a live holder. `link` is the one primitive with both
 * properties: it fails with EEXIST when the target exists, and what appears at the path is the
 * fully-written source. So the pid is written to a private temp first, and the lock is created by
 * linking that temp into place. There is no moment at which the lock exists unstamped.
 *
 * Hard links need one filesystem (the temp is a sibling, so that holds) and filesystem support. Where
 * `link` is unsupported the older `open(wx)` path still runs — it is weaker, not wrong, and the age
 * rule above is exactly what covers its unstamped window.
 *
 * Returns the inode of the published lock, which is half of this acquisition's identity on release.
 */
function publish(lock: string): number {
  const temporary = `${lock}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${process.pid}\n`, { mode: 0o600 });
  try {
    try {
      fs.linkSync(temporary, lock);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw error;
      if (code !== "EPERM" && code !== "ENOSYS" && code !== "ENOTSUP" && code !== "EOPNOTSUPP") throw error;
      const fd = fs.openSync(lock, "wx", 0o600); // throws EEXIST for a holder, same as link
      try {
        fs.writeSync(fd, `${process.pid}\n`);
      } finally {
        fs.closeSync(fd);
      }
    }
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* never created, or already gone */
    }
  }
  try {
    return fs.statSync(lock).ino;
  } catch {
    return 0; // no identity available; release falls back to the pid check alone
  }
}

/**
 * Release by OWNERSHIP, not by path. Unlinking whatever sits at the path would repeat the defect one
 * level down: if our lock was taken from us (stolen as an orphan, or cleared by hand), the file there
 * belongs to somebody else and deleting it hands a third caller the same collision. Identity is the
 * inode we published PLUS the pid, so a path that was cleared and re-taken by our own process — two
 * appends in one extension host — is still recognised as not ours.
 */
function release(lock: string, ino: number): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(lock);
  } catch {
    return; // already gone
  }
  if (ino !== 0 && stat.ino !== 0 && stat.ino !== ino) return;
  try {
    if (Number.parseInt(fs.readFileSync(lock, "utf8").trim(), 10) !== process.pid) return;
  } catch {
    return;
  }
  try {
    fs.unlinkSync(lock);
  } catch {
    /* removed between the read and here — nothing left to release */
  }
}

function acquireOnce(lock: string, options: ProcessLockOptions, stolen: boolean): HeldProcessLock {
  try {
    const ino = publish(lock);
    return { path: lock, release: () => release(lock, ino) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

    // EEXIST means the path was occupied at publish time. Re-read before deciding anything.
    const holder = readHolder(lock);
    if (!holder) {
      // Released between EEXIST and this stat — the free path is open for a clean retry.
      // Do NOT force-rm here (t-b457ce): between "absent" and rmSync another process can publish
      // a new lock; force-removing it admits dual critical sections under multi-process load.
      // Callers that wait (withProcessLock / withProcessLockSync) re-enter acquireProcessLock.
      throw new ProcessLockBusyError(lock, null);
    }

    if (!stolen && !holderIsAlive(holder, options)) {
      try {
        // Only remove when the same orphan we judged is still at the path. A re-read that finds
        // a different live stamp means a new holder won in the gap — leave it alone.
        const still = readHolder(lock);
        if (still
          && still.pid === holder.pid
          && still.stampedAtMs === holder.stampedAtMs
          && !holderIsAlive(still, options)) {
          // Residual TOCTOU (t-b457ce follow-up): between this last identity read and rmSync,
          // another waiter can clear the same orphan and a *new* holder can publish; path-based
          // rm then deletes the new lock. Same family as the absent steal, but a much smaller
          // window, and only after someone was already judged orphan. Not closed here: conditional
          // unlink-by-inode is not atomic on POSIX. `rm -r` (not plain unlink) also recovers a
          // legacy mkdir lock DIRECTORY at this path — otherwise migration itself is a permanent wedge.
          fs.rmSync(lock, { recursive: true, force: true });
        }
      } catch {
        /* another waiter cleared the same orphan first — the retry below settles it */
      }
      return acquireOnce(lock, options, true);
    }
    throw new ProcessLockBusyError(lock, holder.pid);
  }
}

/**
 * Take the lock or throw `ProcessLockBusyError`. This is the primitive: it never waits, and callers
 * that must wait use the wrappers below.
 */
export function acquireProcessLock(lockPath: string, options: ProcessLockOptions = {}): HeldProcessLock {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  return acquireOnce(lockPath, options, false);
}

function timedOut(busy: ProcessLockBusyError, options: ProcessLockWaitOptions): Error {
  const what = options.label ?? busy.lockPath;
  const holder = busy.holderPid === null ? "" : ` (held by pid ${busy.holderPid})`;
  return new Error(
    `timed out after ${options.timeoutMs}ms waiting for ${what}${holder}.`
    + ` A holder that died is recovered automatically; if this persists, the holder is alive and stuck.`
    + ` Lock file: ${busy.lockPath}`,
  );
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Wait for the lock WITHOUT blocking the thread, then run `body`.
 *
 * This is the form every extension-host caller must use: the poll is a `setTimeout`, so the host
 * keeps painting, answering messages and running timers while another window holds the file. The
 * synchronous form below stops the host dead for the whole wait and exists only for callers whose
 * public API cannot be made async yet.
 */
export async function withProcessLock<T>(
  lockPath: string,
  body: () => T | Promise<T>,
  options: ProcessLockWaitOptions,
): Promise<T> {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  for (;;) {
    let lock: HeldProcessLock;
    try {
      lock = acquireProcessLock(lockPath, options);
    } catch (error) {
      if (!(error instanceof ProcessLockBusyError)) throw error;
      if (now() >= deadline) throw timedOut(error, options);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    try {
      return await body();
    } finally {
      lock.release();
    }
  }
}

/**
 * Blocking form — the thread sleeps between retries. Use only where the caller's API is synchronous
 * and cannot be changed; on the extension host this freezes the UI for the length of the wait.
 */
export function withProcessLockSync<T>(
  lockPath: string,
  body: () => T,
  options: ProcessLockWaitOptions,
): T {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  for (;;) {
    let lock: HeldProcessLock;
    try {
      lock = acquireProcessLock(lockPath, options);
    } catch (error) {
      if (!(error instanceof ProcessLockBusyError)) throw error;
      if (now() >= deadline) throw timedOut(error, options);
      sleepSync(pollMs);
      continue;
    }
    try {
      return body();
    } finally {
      lock.release();
    }
  }
}
