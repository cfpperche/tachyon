import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CARD_CATALOG, DEFAULT_CARD_TEMPLATE } from "@tachyon/shared/sidebar/cardTemplate.js";

/** spec 384 — structural guarantees for the live branch badge (order + styles + mapping surface). */
const appTsx = readFileSync(path.join(__dirname, "../../packages/webview-ui/src/webview/sidebar/App.tsx"), "utf8");
const css = readFileSync(path.join(__dirname, "../../packages/webview-ui/src/webview/sidebar/sidebar.css"), "utf8");
const fleetService = readFileSync(path.join(__dirname, "../../packages/engine/src/sidebar/sidebarFleetService.ts"), "utf8");

describe("spec 384 — agent live branch badge", () => {
  it("renders BranchBadge before every other badge in the meta region", () => {
    // SDD 479 phase 1 moved this guarantee from source POSITION to the default template's meta array.
    // The card now renders through a closed catalog, so "first in the list" is decided by that data —
    // asserting it against the order fragments happen to be typed in would no longer measure anything.
    // The rule is unchanged; only its home is.
    const meta = DEFAULT_CARD_TEMPLATE.meta;
    expect(CARD_CATALOG.branch.region).toBe("meta");
    expect(meta).toContain("branch");
    expect(meta.indexOf("branch")).toBeLessThan(meta.indexOf("config-invalid"));
    expect(meta.indexOf("branch")).toBeLessThan(meta.indexOf("attention"));
    // …and the `branch` component is still the BranchBadge itself, not a second rendering of it.
    // Matched loosely on purpose: the first form of this line pinned the exact source text and broke
    // one increment later, when the renderer legitimately gained a `liveBranch` guard. The rule is
    // "the catalog's `branch` entry renders BranchBadge", not how it is spelled — and the BEHAVIOUR is
    // covered by test/unit/sidebarCardMetaRegion.test.ts, which renders the badge and reads it back.
    expect(appTsx).toMatch(/\n {2}branch: \([^)]*\) =>[\s\S]{0,160}<BranchBadge a=\{a\} \/>/);
    // Old mid-list config-only worktree badge must not remain as a second ⎇ display.
    expect(appTsx).not.toMatch(/a\.worktree\s*&&\s*<span class="badge">⎇/);
  });

  it("styles isolated / shared / drift branch badges", () => {
    expect(css).toMatch(/\.ds-badge\.git-branch\b/);
    expect(css).toMatch(/\.ds-badge\.git-branch\.shared\b/);
  });

  it("gathers live HEAD inside the persistent engine fleet projection", () => {
    expect(fleetService).toMatch(/source\.worktrees\.currentBranch\(/);
    expect(fleetService).toMatch(/liveBranch:/);
    expect(fleetService).toMatch(/branchDrift/);
  });
});
