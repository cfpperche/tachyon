import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/** spec 384 — structural guarantees for the live branch badge (order + styles + mapping surface). */
const appTsx = readFileSync(path.join(__dirname, "../../src/webview/sidebar/App.tsx"), "utf8");
const css = readFileSync(path.join(__dirname, "../../src/webview/sidebar/sidebar.css"), "utf8");
const fleetService = readFileSync(path.join(__dirname, "../../src/sidebar/sidebarFleetService.ts"), "utf8");

describe("spec 384 — agent live branch badge", () => {
  it("renders BranchBadge before every other badge in AgentBadges", () => {
    const start = appTsx.indexOf("function AgentBadges");
    expect(start).toBeGreaterThan(-1);
    const end = appTsx.indexOf("export function AgentRow", start);
    const body = appTsx.slice(start, end);
    const branchPos = body.indexOf("<BranchBadge");
    const configPos = body.indexOf("a.configInvalid");
    const attentionPos = body.indexOf("a.attention");
    // Old mid-list config-only worktree badge must not remain as a second ⎇ display.
    expect(body).not.toMatch(/a\.worktree\s*&&\s*<span class="badge">⎇/);
    expect(branchPos).toBeGreaterThan(-1);
    expect(branchPos).toBeLessThan(configPos);
    expect(branchPos).toBeLessThan(attentionPos);
  });

  it("styles isolated / shared / drift branch badges", () => {
    expect(css).toMatch(/\.badge\.git-branch\b/);
    expect(css).toMatch(/\.badge\.git-branch\.shared\b/);
  });

  it("gathers live HEAD inside the persistent engine fleet projection", () => {
    expect(fleetService).toMatch(/source\.worktrees\.currentBranch\(/);
    expect(fleetService).toMatch(/liveBranch:/);
    expect(fleetService).toMatch(/branchDrift/);
  });
});
