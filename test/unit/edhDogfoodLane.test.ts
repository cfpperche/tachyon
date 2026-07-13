import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const script = path.resolve("scripts/edh-palliative/lane.mjs");
function call(base: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, TACHYON_EDH_LANE_BASE: base, ...env } });
}

describe("EDH dogfood lane v1", () => {
  it("allows exactly one owner and only that owner can release", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "edh-lane-test-"));
    try {
      expect(call(base, ["acquire", "--owner", "alpha", "--target", "worktree"]).status).toBe(0);
      const collision = call(base, ["acquire", "--owner", "beta", "--target", "main"]);
      expect(collision.status).toBe(1);
      expect(collision.stderr).toContain("lane busy: owner=alpha target=worktree");
      expect(call(base, ["release", "--owner", "beta"]).status).toBe(1);
      expect(call(base, ["release", "--owner", "alpha"]).status).toBe(0);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  it("runs a bounded command, records allowlisted evidence, and always cleans its lease", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "edh-lane-run-"));
    try {
      const result = call(base, ["run", "--owner", "pilot", "--target", "main", "--", process.execPath, "-e", "process.exit(7)"]);
      expect(result.status).toBe(7);
      expect(fs.existsSync(path.join(base, "owner.lease"))).toBe(false);
      const report = JSON.parse(fs.readFileSync(path.join(base, "evidence", "latest.json"), "utf8"));
      expect(report).toMatchObject({ version: 1, owner: "pilot", target: "main", exitCode: 7 });
      expect(Object.keys(report).sort()).toEqual(["exitCode", "finishedAt", "owner", "signal", "startedAt", "target", "version"]);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  it("rejects unknown target identities", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "edh-lane-target-"));
    try { expect(call(base, ["acquire", "--owner", "pilot", "--target", "mystery"]).status).toBe(2); }
    finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  it("removes the lease directory when lease-file creation fails", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "edh-lane-write-"));
    try {
      const result = call(base, ["acquire", "--owner", "pilot"], { TACHYON_EDH_TEST_FAIL_WRITE: "lease" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("injected lease write failure");
      expect(fs.existsSync(path.join(base, "owner.lease"))).toBe(false);
      expect(call(base, ["acquire", "--owner", "next-pilot"]).status).toBe(0);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  it("releases the lease when evidence creation fails", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "edh-lane-evidence-"));
    try {
      const result = call(base, ["run", "--owner", "pilot", "--", process.execPath, "-e", "process.exit(0)"], { TACHYON_EDH_TEST_FAIL_WRITE: "evidence" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("injected evidence write failure");
      expect(fs.existsSync(path.join(base, "owner.lease"))).toBe(false);
      expect(call(base, ["acquire", "--owner", "next-pilot"]).status).toBe(0);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  it("validates owner identity symmetrically before acquire and release", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "edh-lane-owner-"));
    try {
      expect(call(base, ["acquire", "--owner", "bad owner"]).status).toBe(2);
      expect(fs.existsSync(path.join(base, "owner.lease"))).toBe(false);
      expect(call(base, ["acquire", "--owner", "a".repeat(81)]).status).toBe(2);
      expect(call(base, ["acquire", "--owner", "valid.owner_1"]).status).toBe(0);
      expect(call(base, ["release", "--owner", "bad owner"]).status).toBe(2);
      expect(fs.existsSync(path.join(base, "owner.lease"))).toBe(true);
      expect(call(base, ["release", "--owner", "valid.owner_1"]).status).toBe(0);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  it("ignores lane-shaped child flags after the command separator", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "edh-lane-child-flags-"));
    try {
      const result = call(base, ["run", "--owner", "pilot", "--target", "main", "--", process.execPath, "--owner", "child", "--target", "vsix"]);
      expect(result.status).not.toBe(2);
      const report = JSON.parse(fs.readFileSync(path.join(base, "evidence", "latest.json"), "utf8"));
      expect(report).toMatchObject({ owner: "pilot", target: "main" });
      expect(fs.existsSync(path.join(base, "owner.lease"))).toBe(false);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
});
