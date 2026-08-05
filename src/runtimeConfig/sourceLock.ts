import { acquireProcessLock, ProcessLockBusyError } from "../locks/processLock.js";

/**
 * The advisory lock a Runtime Config save takes on a native source file.
 *
 * It exists because two Tachyon processes can hold the same workspace open — a second VS Code
 * window, or a Dev Host beside the real host. Within one extension host the saves are already
 * serialized (synchronous `fs` calls on one thread), and the runtime itself does not honour this
 * lock at all, so the CAS revision check remains the mechanism that actually prevents a lost update.
 * This narrows the cross-process window and, more importantly, gives that case an early, nameable
 * error instead of a silent race.
 *
 * ## The defect this file was written to fix (t-ce83a2, found in review)
 *
 * Both adapters previously inlined the lock and released it in a `finally` that ran
 * `fs.unlinkSync(lock)` UNCONDITIONALLY — including on the `EEXIST` path, where the lock belongs to
 * somebody else. Proven behaviour: A acquires; B fails with "another save is in progress" and, on
 * its way out, DELETES A's lock; C then walks straight in while A still believes it holds it. The
 * comment on that line assumed the unlink would fail. It does not: the file is there, and it is not
 * ours.
 *
 * The obvious repair — unlink only when we hold the descriptor — is a trap on its own: a save that
 * died between acquiring and releasing would leave a lock nobody can clear from the UI. So release is
 * owner-only AND an orphan is recoverable.
 *
 * ## Where that algorithm lives now (t-7843d0)
 *
 * All of it — stamped-on-publish via `link`, owner-only release, orphan recovery — moved to
 * `src/locks/processLock.ts`, because two other consumers had grown their own cross-process lock with
 * no staleness check at all and wedged permanently when a holder died. The on-disk format is
 * unchanged and so is the behaviour here: this call site deliberately does NOT pass `maxHoldMs`, so a
 * holder whose pid still answers keeps the lock however long it takes. Hung is not the same as dead,
 * and a live save may still be about to write; pid reuse therefore resolves toward refusing rather
 * than stealing, and the worst case stays a spurious "in progress" that a person retries.
 *
 * This refusal is also why there is no wait loop here. A Runtime Config save is a human action with a
 * visible error and a Reload; queueing it behind another window's save would be a worse answer than
 * telling the person what is happening.
 */

export interface RuntimeConfigSourceLockOptions {
  /** Injected by tests. Production asks the OS whether the pid is still around. */
  isHolderAlive?: (pid: number) => boolean;
}

export function sourceLockPath(file: string): string {
  return `${file}.tachyon-runtime-config.lock`;
}

/**
 * Run `body` while holding the source lock. Releases only the lock this call created, so losing the
 * race can never clear the winner's.
 */
export function withRuntimeConfigSourceLock<T>(
  file: string,
  body: () => T,
  options: RuntimeConfigSourceLockOptions = {},
): T {
  const lock = sourceLockPath(file); // sibling of `file`, so acquiring it creates the same directory

  let held;
  try {
    held = acquireProcessLock(lock, { isHolderAlive: options.isHolderAlive });
  } catch (error) {
    if (!(error instanceof ProcessLockBusyError)) throw error;
    throw new Error(
      `Another Runtime Config save is in progress for this source. Reload before trying again.`
      + ` If no save is running, delete ${lock}.`,
    );
  }
  try {
    return body();
  } finally {
    held.release();
  }
}
