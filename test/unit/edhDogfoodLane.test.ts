import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const script = path.resolve("scripts/edh-palliative/lane.mjs");
function call(base: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, TACHYON_EDH_LANE_BASE: base } });
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
});
