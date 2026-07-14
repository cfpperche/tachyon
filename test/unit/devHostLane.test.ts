import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const script = path.resolve("scripts/dev-host/lane.mjs");
function call(base: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, TACHYON_EDH_LANE_BASE: base, ...env } });
}

describe("Dev Host dogfood lane", () => {
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

  it.skipIf(process.platform === "win32")("preserves signal termination separately from numeric child exit", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "edh-lane-signal-"));
    try {
      const result = call(base, ["run", "--owner", "pilot", "--target", "worktree", "--", process.execPath, "-e", 'process.kill(process.pid, "SIGTERM")']);
      expect(result.status).toBe(128 + 15);
      const report = JSON.parse(fs.readFileSync(path.join(base, "evidence", "latest.json"), "utf8"));
      expect(report).toMatchObject({ owner: "pilot", target: "worktree", exitCode: null, signal: "SIGTERM" });
      expect(fs.existsSync(path.join(base, "owner.lease"))).toBe(false);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  it("rejects unknown target identities", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "edh-lane-target-"));
    try { expect(call(base, ["acquire", "--owner", "pilot", "--target", "mystery"]).status).toBe(2); }
    finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  it("removes the lease directory when lease-file creation fails", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "edh-lane-write-"));
    const childMarker = path.join(base, "child-ran");
    try {
      const result = call(base, ["acquire", "--owner", "pilot"], { TACHYON_EDH_TEST_FAIL_WRITE: "lease" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("injected lease write failure");
      expect(fs.existsSync(path.join(base, "owner.lease"))).toBe(false);
      expect(call(base, ["acquire", "--owner", "next-pilot"]).status).toBe(0);
      expect(call(base, ["release", "--owner", "next-pilot"]).status).toBe(0);
      const racedRun = call(base, ["run", "--owner", "pilot", "--", process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(childMarker)}, "yes")`], { TACHYON_EDH_TEST_FAIL_WRITE: "lease" });
      expect(racedRun.status).toBe(1);
      expect(fs.existsSync(childMarker)).toBe(false);
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

  it("atomically replaces a planted latest.json symlink without touching its target", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "edh-lane-latest-link-"));
    const target = path.join(base, "do-not-overwrite.txt");
    try {
      fs.mkdirSync(path.join(base, "evidence"));
      fs.writeFileSync(target, "unchanged");
      fs.symlinkSync(target, path.join(base, "evidence", "latest.json"));
      const result = call(base, ["run", "--owner", "pilot", "--", process.execPath, "-e", "process.exit(0)"]);
      expect(result.status).toBe(0);
      expect(fs.readFileSync(target, "utf8")).toBe("unchanged");
      expect(fs.lstatSync(path.join(base, "evidence", "latest.json")).isSymbolicLink()).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(base, "evidence", "latest.json"), "utf8"))).toMatchObject({ owner: "pilot", exitCode: 0 });
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  it("cleans an exclusive evidence temporary file when publication fails", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "edh-lane-temp-cleanup-"));
    try {
      fs.mkdirSync(path.join(base, "evidence", "latest.json"), { recursive: true });
      const result = call(base, ["run", "--owner", "pilot", "--", process.execPath, "-e", "process.exit(0)"]);
      expect(result.status).toBe(1);
      expect(fs.readdirSync(path.join(base, "evidence"))).toEqual(["latest.json"]);
      expect(fs.existsSync(path.join(base, "owner.lease"))).toBe(false);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  it("refuses symlinked base and evidence directories before writing through them", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "edh-lane-dir-links-"));
    const target = path.join(root, "target");
    const linkedBase = path.join(root, "linked-base");
    try {
      fs.mkdirSync(target);
      fs.symlinkSync(target, linkedBase, "dir");
      const baseResult = call(linkedBase, ["acquire", "--owner", "pilot"]);
      expect(baseResult.status).toBe(1);
      expect(baseResult.stderr).toContain("lane base must be a real directory");
      expect(fs.readdirSync(target)).toEqual([]);

      const base = path.join(root, "base");
      fs.mkdirSync(base);
      fs.symlinkSync(target, path.join(base, "evidence"), "dir");
      const evidenceResult = call(base, ["run", "--owner", "pilot", "--", process.execPath, "-e", "process.exit(0)"]);
      expect(evidenceResult.status).toBe(1);
      expect(evidenceResult.stderr).toContain("evidence must be a real directory");
      expect(fs.readdirSync(target)).toEqual([]);
      expect(fs.existsSync(path.join(base, "owner.lease"))).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("recovers only an empty orphan lease directory", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "edh-lane-recover-empty-"));
    try {
      fs.mkdirSync(path.join(base, "owner.lease"));
      expect(call(base, ["recover"]).status).toBe(0);
      expect(fs.existsSync(path.join(base, "owner.lease"))).toBe(false);
      expect(call(base, ["acquire", "--owner", "next-pilot"]).status).toBe(0);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });

  it("refuses recovery of valid, nonempty, and symlinked leases", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "edh-lane-recover-refuse-"));
    try {
      expect(call(base, ["acquire", "--owner", "pilot"]).status).toBe(0);
      expect(call(base, ["recover"]).status).toBe(1);
      expect(call(base, ["status"]).stdout).toContain('"owner": "pilot"');
      expect(call(base, ["release", "--owner", "pilot"]).status).toBe(0);

      fs.mkdirSync(path.join(base, "owner.lease"));
      fs.writeFileSync(path.join(base, "owner.lease", "unexpected"), "occupied");
      expect(call(base, ["recover"]).status).toBe(1);
      expect(fs.readFileSync(path.join(base, "owner.lease", "unexpected"), "utf8")).toBe("occupied");
      fs.rmSync(path.join(base, "owner.lease"), { recursive: true });

      const elsewhere = path.join(base, "elsewhere");
      fs.mkdirSync(elsewhere);
      fs.symlinkSync(elsewhere, path.join(base, "owner.lease"), "dir");
      const linked = call(base, ["recover"]);
      expect(linked.status).toBe(1);
      expect(linked.stderr).toContain("lease must be a real directory");
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
