import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
// The production runner is intentionally plain ESM and has no separate declaration surface.
// @ts-expect-error -- reading the runner's OWN gate list is the point: a copy here could drift from it.
import { STATIC_GATES } from "../../scripts/verify-full.mjs";

/**
 * t-dcd8eb — `npm run verify:full` is the single source of truth for verification, and the CI workflow
 * must DELEGATE to it rather than re-listing steps.
 *
 * Two hand-maintained lists is exactly how they came to disagree: the workflow ran `typecheck` and
 * `check:engine-boundary`, verify:full ran neither, and nobody noticed because Actions was out of
 * credit. The pre-push gate resolves verify:full, so pushes to the trunk skipped both — including the
 * typecheck class of failure that motivated building the gate.
 *
 * The oracle is the shape of the workflow, not its exact text: CI may provision a runner however it
 * needs (checkout, node, apt, npm ci), but the VERIFICATION it performs is one delegated command.
 */

const root = path.resolve(__dirname, "../..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");

/** Every `run:` line in the workflow, in order, comments and indentation stripped. */
function runSteps(): string[] {
  return workflow
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- run:") || l.startsWith("run:"))
    .map((l) => l.replace(/^-\s*/, "").replace(/^run:\s*/, "").trim());
}

/** Provisioning the runner is not verification: these may appear, anything else may not. */
const PROVISIONING = [/^sudo apt-get /, /^npm ci$/];

describe("CI workflow delegates verification to verify:full (t-dcd8eb)", () => {
  it("runs verify:full", () => {
    expect(runSteps()).toContain("npm run verify:full");
  });

  it("re-lists NO verification step of its own", () => {
    const extra = runSteps().filter(
      (s) => s !== "npm run verify:full" && !PROVISIONING.some((p) => p.test(s)),
    );
    // A new step here means CI is about to verify something the local command does not.
    // Add it to verify:full instead, so both sides move together.
    expect(extra).toEqual([]);
  });

  it("does not name a gate that verify:full already owns", () => {
    // Catches the subtler drift: re-adding `npm run typecheck` beside the delegated command, which
    // would still pass the check above only if PROVISIONING were widened to excuse it.
    for (const gate of STATIC_GATES) {
      expect(runSteps().some((s) => s.includes(gate))).toBe(false);
    }
  });

  it("verify:full owns the gates CI used to run itself", () => {
    // The list is not decoration: if a gate is dropped from STATIC_GATES, this fails and the drop has
    // to be a deliberate, reviewed decision rather than a silent narrowing of what a push is checked for.
    // The same holds for ADDING one — t-62cc44 added `check:source-diffable`, and updating this line is
    // how that addition gets reviewed rather than arriving on its own.
    expect([...STATIC_GATES].sort()).toEqual(["check:engine-boundary", "check:package-boundary", "check:source-diffable", "check:theme-tokens", "check:webview-tokens", "typecheck"]);
  });
});
