import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * SDD 485 E1 — what survives of the cross-studio residue suite.
 *
 * The original tested that navigating BETWEEN studios inside Control did not leave one studio's state
 * visible under another's props — a defect only a single host with one mount could have. Control is
 * gone and each studio is its own panel, so that shape is now impossible by construction rather than
 * by test.
 *
 * This one case is not about the host at all: it is D1a's live `referenceData` push, a fix the
 * standalone Terminal Studio still depends on. It was nearly deleted with the file, which is the
 * hazard of naming a suite after the situation that produced it instead of what it protects.
 */
describe("the surviving D1a standalone-studio fix stays in place", () => {
  it("Terminal Studio handles live referenceData pushes", () => {
    const src = readFileSync("src/webview/terminal-studio-shell/App.tsx", "utf8");
    expect(src).toMatch(/d\.type === "referenceData"/);
    expect(src).toContain("setReferenceData(d.referenceData ?? emptyReferenceData())");
  });
});
