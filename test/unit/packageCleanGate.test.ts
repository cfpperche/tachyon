import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const roots: string[] = [];
let assertPackageTreeClean: (cwd?: string) => void;

beforeAll(async () => {
  ({ assertPackageTreeClean } = await import("../../scripts/package-clean-gate.mjs"));
});

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-package-clean-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "package-gate@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Package Gate"], { cwd: root });
  fs.writeFileSync(path.join(root, ".gitignore"), "*.vsix\n");
  fs.writeFileSync(path.join(root, "tracked.txt"), "clean\n");
  execFileSync("git", ["add", ".gitignore", "tracked.txt"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "baseline"], { cwd: root });
  return root;
}

describe("package clean gate", () => {
  it("accepts a clean tree and ignores only declared package outputs", () => {
    const root = repository();
    expect(() => assertPackageTreeClean(root)).not.toThrow();

    fs.writeFileSync(path.join(root, "candidate.vsix"), "artifact");
    expect(() => assertPackageTreeClean(root)).not.toThrow();
  });

  it("refuses untracked source files", () => {
    const root = repository();
    fs.writeFileSync(path.join(root, "new-source.ts"), "export {};\n");

    expect(() => assertPackageTreeClean(root)).toThrow(/dirty source tree[\s\S]*new-source\.ts/);
  });

  it("refuses tracked changes before a VSIX can be produced", () => {
    const root = repository();
    fs.writeFileSync(path.join(root, "tracked.txt"), "dirty\n");

    expect(() => assertPackageTreeClean(root)).toThrow(/dirty source tree[\s\S]*tracked\.txt/);
  });

  it("fails closed when git cannot verify the source tree", () => {
    const missing = path.join(os.tmpdir(), `tachyon-missing-${process.pid}-${Date.now()}`);
    expect(() => assertPackageTreeClean(missing)).toThrow(/source tree could not be verified/);
  });
});
