import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("shared UI product patterns (STYLEGUIDE)", () => {
  it("exports PageChrome, ListRow, EmptyState from the ui barrel", () => {
    const barrel = readFileSync("src/webview/shared/ui/index.ts", "utf8");
    expect(barrel).toContain("PageChrome");
    expect(barrel).toContain("ListRow");
    expect(barrel).toContain("EmptyState");
    expect(barrel).toContain('from "./patterns"');
  });

  it("implements pattern components in patterns.tsx", () => {
    const src = readFileSync("src/webview/shared/ui/patterns.tsx", "utf8");
    expect(src).toContain("export function PageChrome");
    expect(src).toContain("export function ListRow");
    expect(src).toContain("export function EmptyState");
  });

  it("documents the patterns in design-system.css", () => {
    const css = readFileSync("src/webview/shared/design-system.css", "utf8");
    expect(css).toContain(".ds-page-chrome");
    expect(css).toContain(".ds-list-row");
    expect(css).toContain(".ds-empty-state");
  });

  it("STYLEGUIDE is the contract source", () => {
    const guide = readFileSync("docs/STYLEGUIDE.md", "utf8");
    expect(guide).toContain("PageChrome");
    expect(guide).toContain("reuse");
    expect(guide).toContain("shared/ui");
  });

  it("Control ModuleChrome and Approvals adopt the patterns", () => {
    const cockpit = readFileSync("src/webview/cockpit/App.tsx", "utf8");
    expect(cockpit).toContain("PageChrome");
    const approvals = readFileSync("src/webview/approval/App.tsx", "utf8");
    expect(approvals).toContain("PageChrome");
    expect(approvals).toContain("EmptyState");
    expect(approvals).toMatch(/Button[\s\S]*Approve/);
  });
});
