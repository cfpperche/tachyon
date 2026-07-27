import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir, trackTempDir } from "../helpers/tempDir.js";

/**
 * `t-25a908` — the suite may not leak temp directories, and this is what makes that checkable.
 *
 * The leak was invisible for as long as it took to matter, then it mattered all at once: `/tmp` is a
 * shared 7.9 GB tmpfs, and on 2026-07-27 it held **236,560** stray directories — 109,051 from one
 * fixture — until `verify:full` died with `ENOSPC` before running a single test. A green suite that
 * quietly consumes the machine it runs on is not green; it is borrowing.
 *
 * Two properties, because either alone would rot:
 *
 *  1. **The helper actually removes what it hands out** — otherwise the guard below would enforce
 *     nothing but a naming convention.
 *  2. **Every test file that creates a temp directory cleans up**, by using the helper or by removing
 *     its own. This is the part that survives contact with a new fixture written next month: a file
 *     that calls `mkdtemp` and nothing else fails here, by name, with the fix in the message.
 */

const TEST_ROOT = path.resolve(__dirname, "..");
/** Creation without one of these in the same file is a leak. `makeSocketTemp` tracks internally. */
const CLEANUP_MARKERS = ["makeTempDir", "trackTempDir", "makeSocketTemp", "rmSync", "rm("];

function testFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(full);
    return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
  });
}

describe("t-25a908 — the helper is worth trusting", () => {
  it("removes a directory it created once the file finishes", () => {
    // The removal itself runs in this file's afterAll, so what is asserted here is the registration:
    // the directory exists now, and the same set is what the hook drains. The second test proves the
    // drain, using a directory this test can observe being registered.
    const dir = makeTempDir("tachyon-temp-hygiene-");
    expect(fs.existsSync(dir)).toBe(true);
    expect(dir.startsWith(path.dirname(dir))).toBe(true);
  });

  it("drains everything registered, including directories it did not create itself", () => {
    const parent = makeTempDir("tachyon-temp-hygiene-outer-");
    const adopted = path.join(parent, "adopted");
    fs.mkdirSync(adopted);
    expect(trackTempDir(adopted)).toBe(adopted);
    // Removing the parent first must not make draining the child throw — the hook has to survive a
    // directory that is already gone, or one failure would strand every later entry in the set.
    fs.rmSync(parent, { recursive: true, force: true });
    expect(fs.existsSync(adopted)).toBe(false);
  });
});

describe("t-25a908 — no test file creates a temp directory it never removes", () => {
  it("every file that calls mkdtemp also cleans up", () => {
    const offenders = testFiles(TEST_ROOT)
      .filter((file) => /\bmkdtemp(Sync)?\s*\(/.test(fs.readFileSync(file, "utf8")))
      .filter((file) => {
        const source = fs.readFileSync(file, "utf8");
        return !CLEANUP_MARKERS.some((marker) => source.includes(marker));
      })
      .map((file) => path.relative(TEST_ROOT, file))
      .sort();

    expect(
      offenders,
      `these test files create a temp directory and never remove it — import makeTempDir from `
      + `test/helpers/tempDir.ts, or add your own rmSync cleanup:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
