import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
// The scanner is plain ESM with no declaration surface — same convention as verifyAttestationReuse
// importing verify-record.mjs. Importing the REAL implementation is the point of this file.
// @ts-expect-error -- see above
import { ALLOWED, SCANNED, controlBytes, scanRepo } from "../../scripts/check-source-diffable.mjs";

/**
 * t-0750b6 — TypeScript sources must stay reviewable.
 *
 * A single raw control byte makes git classify a whole file as binary: `git show` prints
 * "Binary files differ" instead of a diff, and grep goes silent on it. Four files under
 * src/plugins/ had reached that state by writing regex character classes and string separators with
 * REAL bytes instead of escape sequences. Identical at runtime, opaque in review — and worst exactly
 * there, since those files are the plugin manifest validator, the lockfile reader and the tool
 * provisioner, the code whose job is to refuse hostile input.
 *
 * t-62cc44 — the RULE now lives in `scripts/check-source-diffable.mjs` and runs as a static gate,
 * before the build, because as a test it could only fail after it. This file no longer owns the
 * scanner; it imports it. Two copies would be two lists free to disagree, which is the failure
 * t-dcd8eb's comment in verify-full describes for CI versus verify.
 *
 * What stays here is what a gate cannot assert about itself: that the scanner DISCRIMINATES. A gate
 * that silently matches nothing passes forever, so the non-vacuity cases below are why this file
 * still exists at all.
 */

const ROOT = path.resolve(__dirname, "../..");
const tmpFile = (name: string, contents: string): string => {
  const file = path.join(process.env.TMPDIR ?? "/tmp", `${name}-${process.pid}.ts`);
  fs.writeFileSync(file, contents);
  return file;
};

describe("TypeScript sources stay diffable (t-0750b6)", () => {
  it("contains no raw control byte outside tab, LF and CR", () => {
    // Kept as a test as well as a gate: this is what a developer runs a focused suite against, and it
    // costs milliseconds. The gate makes it fail EARLY; this makes it fail LOCALLY, without the whole
    // command.
    //
    // If it fails: you almost certainly meant an ESCAPE. Write /[\x00-\x1f\x7f]/ rather than the class
    // with real bytes, and the two-character escape for NUL rather than a literal one. Same value at
    // runtime, and the file stays something git can diff and grep can search.
    expect(scanRepo(ROOT)).toEqual([]);
  });

  it("detects a control byte when one is present — the guard is not vacuous", () => {
    // Proves the scanner discriminates, without planting a real one in the tree. This is the case a
    // static gate cannot make about itself: a scanner that matches nothing reports success
    // identically to one that matches correctly.
    const tmp = tmpFile("diffable-probe", `const CONTROL = /[${String.fromCharCode(0)}]/;\n`);
    try {
      expect(controlBytes(tmp)).toEqual(["1:19 (0x00)"]);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it("allows tab, LF and CR", () => {
    const tmp = tmpFile("diffable-ok", "const a = 1;\n\tconst b = 2;\r\n");
    try {
      expect(controlBytes(tmp)).toEqual([]);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it("scans the enforcer's own tree, so the guard cannot exempt itself", () => {
    // The narrow first version covered `src/` alone and this very file slipped past it — the comment
    // explaining how to avoid a literal NUL contained one. The scanner now lives under `scripts/`,
    // which must therefore stay in scope, or the rule stops applying to its own implementation.
    expect([...SCANNED]).toContain("scripts");
    expect([...ALLOWED]).toEqual([0x09, 0x0a, 0x0d]);
  });
});

/** t-62cc44 — the gate and the test must be the same rule, not two that happen to agree today. */
describe("t-62cc44 — one implementation, wired as a static gate", () => {
  it("runs before the compile, and first among the static gates", async () => {
    // Cheapest-first is the whole point: behind `typecheck` it would still cost a compile to learn.
    // @ts-expect-error -- plain ESM, see the import above
    const { STATIC_GATES } = await import("../../scripts/verify-full.mjs");
    expect(STATIC_GATES[0]).toBe("check:source-diffable");
    expect(STATIC_GATES).toContain("typecheck");
    expect(STATIC_GATES.indexOf("check:source-diffable")).toBeLessThan(STATIC_GATES.indexOf("typecheck"));
  });

  it("is a real npm script, so the gate name resolves to something runnable", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    // A gate listed but not defined fails with a shell error rather than a rule violation, which
    // reads like a broken repo instead of a broken file.
    expect(pkg.scripts["check:source-diffable"]).toBe("node scripts/check-source-diffable.mjs");
  });
});
