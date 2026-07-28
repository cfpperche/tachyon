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

function holderIsAlive(lock: string, options: RuntimeConfigSourceLockOptions): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(lock, "utf8");
  } catch {
    // It vanished between the failed create and this read — whoever held it is done with it.
    return false;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    // An unreadable holder is treated as gone. A crash during the create+write is the only way to
    // get here, and refusing instead would be the permanent wedge described above.
    return false;
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

function acquire(lock: string, options: RuntimeConfigSourceLockOptions, stolen = false): void {
  try {
    // Create and stamp in ONE call: a lock that exists but has no pid yet would be indistinguishable
    // from a crashed holder.
    fs.writeFileSync(lock, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
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
    try {
      fs.unlinkSync(lock);
    } catch {
      /* already stolen as an orphan, or removed by hand */
    }
  }
}
