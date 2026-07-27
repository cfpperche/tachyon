import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

/**
 * `t-25a908` — a temp directory that removes itself when the test file finishes.
 *
 * The suite had leaked one directory per fixture call, forever, into a shared 7.9 GB tmpfs. Measured
 * 2026-07-27: **236,560** stray directories under `/tmp`, 109,051 of them from a single fixture
 * (`deliveryLeaseService`'s `tachyon-lease-`), and the box hit `ENOSPC` — which killed
 * `verify:full` for every agent on it, before a single test ran. The failure reads like a code
 * failure and is not one, which is the expensive part.
 *
 * 198 of 220 test files already cleaned up by hand, each with its own `dirs[]` + `afterEach`. That is
 * the discipline this replaces: a call to `makeTempDir` is registered for removal by construction, so
 * a new fixture cannot leak by forgetting a hook. `test/unit/tempDirHygiene.test.ts` fails if a test
 * file creates a temp directory without either this helper or its own cleanup.
 *
 * Removal is at **file** scope (`afterAll`), not per test, deliberately: fixtures here create their
 * directory in a test body, in `beforeEach`, and at module scope, and a per-test hook would delete a
 * module-scoped fixture out from under the tests that still need it. Holding a handful of small
 * directories until the file ends costs nothing.
 */
const pending = new Set<string>();

// Registered at import time, so it belongs to the test file that imported this helper. Vitest isolates
// the module registry per test file, so each file gets its own hook and its own `pending` set.
afterAll(() => {
  for (const dir of pending) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a test may already have removed it; leaking one directory is worse than ignoring this */
    }
  }
  pending.clear();
});

/** `mkdtempSync` under the OS temp dir, registered for removal when this test file finishes. */
export function makeTempDir(prefix: string): string {
  return trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/**
 * Register an already-created directory for the same file-scoped removal.
 *
 * For the few fixtures that must choose their own parent — `makeSocketTemp` pins `/tmp` on Linux so a
 * long `TMPDIR` cannot overflow the 108-byte `sockaddr_un` path limit — and for directories a helper
 * creates on the caller's behalf.
 */
export function trackTempDir(dir: string): string {
  pending.add(dir);
  return dir;
}
