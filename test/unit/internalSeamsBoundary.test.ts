import { describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { workspaceRoot } from "../helpers/repositorySourceScan.js";

/**
 * t-4486eb — the 15 remaining `tachyon._*` commands must not close into the
 * product bundle. `_seedPipelineRun` left with Pipeline Studio (3ca278f2).
 */
const SEAM_NAMES = [
  "_agents",
  "_spawn",
  "_wait",
  "_attention",
  "_pins",
  "_pin",
  "_upsertAgent",
  "_schedules",
  "_proposals",
  "_propose",
  "_approveProposal",
  "_rejectProposal",
  "_togglePause",
  "_workspaces",
  "_configHealth",
] as const;

const RETIRED = "_seedPipelineRun";

const extensionSrc = path.join(workspaceRoot("tachyon"), "src/extension.ts");
const seamsSrc = path.join(workspaceRoot("tachyon"), "src/internalSeams.ts");
const esbuildSrc = path.resolve("esbuild.mjs");
const gateSrc = path.resolve(".vscode-test.mjs");
const runnerSrc = path.resolve("scripts/screenshots/runner.js");
const captureSrc = path.resolve("scripts/screenshots/capture.sh");

describe("t-4486eb internal seam boundary", () => {
  it("does not register tachyon._* commands from extension.ts", () => {
    const text = readFileSync(extensionSrc, "utf8");
    expect(text).not.toMatch(/registerCommand\(\s*["']tachyon\._/);
    expect(text).toContain('process.env.TACHYON_TEST_SEAMS === "1"');
    expect(text).toContain("registerInternalSeams");
    expect(text).toContain('path.join(__dirname, "internalSeams.js")');
    expect(text).not.toContain(RETIRED);
  });

  it("keeps every remaining seam name in the sibling module", () => {
    const text = readFileSync(seamsSrc, "utf8");
    expect(text).toContain("export function registerInternalSeams");
    for (const name of SEAM_NAMES) {
      expect(text, `missing tachyon.${name}`).toContain(`"tachyon.${name}"`);
    }
    expect(text).not.toContain(RETIRED);
  });

  it("builds the sibling as its own esbuild outfile", () => {
    const text = readFileSync(esbuildSrc, "utf8");
    expect(text).toContain('outfile: "dist/internalSeams.js"');
    expect(text).toContain('appSource("internalSeams.ts")');
  });

  it("sets TACHYON_TEST_SEAMS on the two declared consumers", () => {
    expect(readFileSync(gateSrc, "utf8")).toContain('TACHYON_TEST_SEAMS: "1"');
    expect(readFileSync(runnerSrc, "utf8")).toMatch(/process\.env\.TACHYON_TEST_SEAMS\s*=\s*"1"/);
    expect(readFileSync(captureSrc, "utf8")).toMatch(/TACHYON_TEST_SEAMS=1/);
  });

  it("drops every seam name from dist/extension.js once a bundle exists", () => {
    const bundle = path.join(workspaceRoot("tachyon"), "dist/extension.js");
    let text: string;
    try {
      if (!statSync(bundle).isFile()) return;
      text = readFileSync(bundle, "utf8");
    } catch {
      return;
    }
    for (const name of SEAM_NAMES) {
      const matches = text.split(`"tachyon.${name}"`).length - 1;
      expect(matches, `dist/extension.js still contains "tachyon.${name}"`).toBe(0);
    }
    expect(text.split(`"tachyon.${RETIRED}"`).length - 1).toBe(0);
  });
});
