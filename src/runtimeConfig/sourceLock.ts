import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
 * The obvious repair — unlink only when we hold the descriptor — is a trap on its own, and that is
 * why this is a shared helper rather than a one-line edit in two places. A save that dies between
 * acquiring and releasing (crash, kill, power loss) would then leave a lock nobody can clear from
 * the UI, and every later save on that file would refuse forever. The unconditional unlink was, by
 * accident, the only thing recovering an orphan.
 *
 * So release is owner-only AND an orphan is recoverable: the lock file carries its holder's pid, and
 * a lock whose holder is gone is stolen once, then re-acquired. A holder that is alive keeps it —
 * hung is not the same as dead, and a live process may still be about to write. The one residual
 * risk is pid reuse, which resolves toward refusing rather than stealing: the worst case is a
 * spurious "in progress" that a person retries, not two writers.
 *
 * A second review pass then proved two follow-ons, both now closed here, because a comment that
 * overstates the guarantee is the same class of defect as the one above:
 *
 *  - releasing by PATH would delete a lock that is no longer ours, so `release` re-reads the pid and
 *    leaves a foreign lock alone;
 *  - creating and stamping were two steps, so a lock could be seen unstamped, and reading that as
 *    "crashed" let a live holder be robbed mid-create. Publication now goes through `link` (see
 *    `publish`), which both fails on an existing holder and puts a fully-stamped file in place, so
 *    the unstamped window does not exist on that path at all. The age rule survives as the guard for
 *    the weaker fallback and for a lock this module did not write.
 *
 * This mirrors `acquireVerifyFullLock` in `scripts/verify-full.mjs` (t-6a9bc4), which already had to
 * solve exactly this in this repository.
 */

export interface RuntimeConfigSourceLockOptions {
  /** Injected by tests. Production asks the OS whether the pid is still around. */
  isHolderAlive?: (pid: number) => boolean;
}

export function sourceLockPath(file: string): string {
  return `${file}.tachyon-runtime-config.lock`;
}

/**
 * A lock whose pid cannot be read yet is NOT evidence of a crash: the create and the stamp are two
 * steps (see `acquire`), so a holder that is mid-create looks exactly like one that died mid-create.
 * Age is what tells them apart, and it has to, because guessing either way is a real failure — "gone"
 * robs a live holder, "alive" is the permanent wedge. Two seconds is far longer than the microseconds
 * between `open` and `write`, and far shorter than a human noticing a stuck save.
 */
const UNSTAMPED_LOCK_GRACE_MS = 2_000;

function holderIsAlive(lock: string, options: RuntimeConfigSourceLockOptions): boolean {
  let raw: string;
  let stampedAtMs: number;
  try {
    stampedAtMs = fs.statSync(lock).mtimeMs;
    raw = fs.readFileSync(lock, "utf8");
  } catch {
    // It vanished between the failed create and this read — whoever held it is done with it.
    return false;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return Date.now() - stampedAtMs < UNSTAMPED_LOCK_GRACE_MS;
  }
  const alive = options.isHolderAlive ?? ((candidate: number) => {
    try {
      process.kill(candidate, 0);
      return true;
    } catch (error) {
      // EPERM means it exists and belongs to another user — existing is what we asked.
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  });
  return alive(pid);
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
 */
function publish(lock: string): void {
  const temporary = `${lock}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${process.pid}\n`, { mode: 0o600 });
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
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* never created, or already gone */
    }
  }
}

function acquire(lock: string, options: RuntimeConfigSourceLockOptions, stolen = false): void {
  try {
    publish(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!stolen && !holderIsAlive(lock, options)) {
      try {
        fs.unlinkSync(lock);
      } catch {
        /* another waiter cleared the same orphan first — the retry below settles it */
      }
      acquire(lock, options, true);
      return;
    }
    throw new Error(
      `Another Runtime Config save is in progress for this source. Reload before trying again.`
      + ` If no save is running, delete ${lock}.`,
    );
  }
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = sourceLockPath(file);
  acquire(lock, options);
  try {
    return body();
  } finally {
    release(lock);
  }
}

/**
 * Release by OWNERSHIP, not by path. Unlinking whatever sits at the path would repeat the original
 * defect one level down: if our lock was taken from us (stolen as an unstamped orphan, or cleared by
 * hand), the file there belongs to somebody else and deleting it hands a third caller the same
 * collision. Leaving a foreign lock alone costs nothing — its owner releases it, and the grace period
 * above covers the case where nobody does.
 */
function release(lock: string): void {
  try {
    if (Number.parseInt(fs.readFileSync(lock, "utf8").trim(), 10) !== process.pid) return;
  } catch {
    return; // already gone
  }
  try {
    fs.unlinkSync(lock);
  } catch {
    /* removed between the read and here — nothing left to release */
  }
}
