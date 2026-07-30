import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("dogfood command surface", () => {
  it("keeps one stable npm entry instead of one script per scenario", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(Object.keys(pkg.scripts).filter((name) => name === "dogfood" || name.startsWith("dogfood:"))).toEqual(["dogfood"]);
    expect(pkg.scripts.dogfood).toBe("node scripts/dogfood/run.mjs");
  });

  it("lists the migrated scenarios through the runner", () => {
    const scenarios = execFileSync(process.execPath, ["scripts/dogfood/run.mjs", "--list"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim().split("\n");
    expect(scenarios).toContain("dev-host");
    expect(scenarios).toContain("runtime-launch-preflight");
    expect(scenarios).toContain("claude-canonical-create");
    expect(scenarios).toContain("persistent-engine");
    expect(new Set(scenarios).size).toBe(22);
  });
});
