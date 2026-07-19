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
    expect(cockpit).toContain("ListRow");
    expect(cockpit).toContain("EmptyState");
    expect(cockpit).not.toMatch(/ci-badge/);
    const approvals = readFileSync("src/webview/approval/App.tsx", "utf8");
    expect(approvals).toContain("PageChrome");
    expect(approvals).toContain("EmptyState");
    expect(approvals).toMatch(/Button[\s\S]*Approve/);
    const validations = readFileSync("src/webview/validations/App.tsx", "utf8");
    expect(validations).toContain("PageChrome");
    expect(validations).toContain("from \"../shared/ui\"");
    const runtime = readFileSync("src/webview/runtime-ops/App.tsx", "utf8");
    expect(runtime).toContain("PageChrome");
  });

  it("STYLEGUIDE documents guard gap and PageChrome criterion", () => {
    const guide = readFileSync("docs/STYLEGUIDE.md", "utf8");
    expect(guide).toContain("MIGRATED_VIEWS");
    expect(guide).toContain("title / hint / actions");
    expect(guide).toMatch(/primary.*single primary/i);
    expect(guide).toContain("DataTable");
    expect(guide).toContain("cockpit");
  });

  it("Board head and Inspector use PageChrome", () => {
    const board = readFileSync("src/webview/mission-control/App.tsx", "utf8");
    expect(board).toContain("PageChrome");
    expect(board).not.toContain("◆");
    const insp = readFileSync("src/webview/inspector/App.tsx", "utf8");
    expect(insp).toContain("PageChrome");
    expect(insp).toContain("Tabs");
  });

  it("Sidebar agent badges use shared Badge (Phase C.1)", () => {
    const sidebar = readFileSync("src/webview/sidebar/App.tsx", "utf8");
    expect(sidebar).toMatch(/import \{[^}]*Badge/);
    expect(sidebar).toContain("BranchBadge");
    expect(sidebar).not.toMatch(/class=\"badge/);
    expect(sidebar).not.toMatch(/class=\{`badge/);
    expect(sidebar).toContain("EmptyState");
  });

  it("Sidebar uses shared DenseRow (Phase C.2)", () => {
    const patterns = readFileSync("src/webview/shared/ui/patterns.tsx", "utf8");
    expect(patterns).toContain("export function DenseRow");
    expect(patterns).toContain("ds-dense-row");
    const sidebar = readFileSync("src/webview/sidebar/App.tsx", "utf8");
    expect(sidebar).toMatch(/DenseRow/);
    expect(sidebar).toContain("const ListRow = DenseRow");
    expect(sidebar).not.toMatch(/function ListRow\(/);
  });

  it("Full standardize surfaces use PageChrome/Badge/Button", () => {
    for (const [file, needles] of [
      ["src/webview/activity/App.tsx", ["PageChrome", "EmptyState"]],
      ["src/webview/plugins/App.tsx", ["PageChrome", "Badge"]],
      ["src/webview/task-detail/App.tsx", ["PageChrome", "Chip"]],
      ["src/webview/control-inspector/App.tsx", ["PageChrome", "Badge"]],
      ["src/webview/pipeline-studio/App.tsx", ["IconButton"]],
      ["src/webview/runtime-ops/App.tsx", ["Button"]],
    ] as const) {
      const src = readFileSync(file, "utf8");
      for (const n of needles) expect(src, file).toContain(n);
    }
  });

  it("Handoff + Activity + Board body adopt kit (Phase C.3)", () => {
    const handoff = readFileSync("src/webview/handoff/App.tsx", "utf8");
    expect(handoff).toContain("PageChrome");
    expect(handoff).toContain("EmptyState");
    expect(handoff).not.toMatch(/class=\{`ds-badge/);
    const activity = readFileSync("src/webview/activity/App.tsx", "utf8");
    expect(activity).toContain("from \"../shared/ui\"");
    expect(activity).toMatch(/Button[\s\S]*Show all/);
    const board = readFileSync("src/webview/mission-control/App.tsx", "utf8");
    expect(board).toContain("Select");
    expect(board).toMatch(/stale-editor[\s\S]*Button/);
    const radius = readFileSync("src/webview/shared/vscode-theme.css", "utf8");
    expect(radius).toMatch(/--radius:\s*var\(--ds-radius/);
  });

  it("editor PageChrome has no title icon and page shell tokens exist", () => {
    const patterns = readFileSync("src/webview/shared/ui/patterns.tsx", "utf8");
    const chromeFn = patterns.slice(patterns.indexOf("export function PageChrome"), patterns.indexOf("export type ListRowState"));
    expect(chromeFn).toContain("ds-page-chrome-title");
    expect(chromeFn).not.toContain("<Icon");
    const ds = readFileSync("src/webview/shared/design-system.css", "utf8");
    expect(ds).toContain("--ds-page-pad-x");
    expect(ds).toContain("--ds-border-width");
    expect(ds).toContain(".ds-page-chrome-title > .codicon");
    const rt = readFileSync("src/webview/runtime-ops/App.tsx", "utf8");
    expect(rt).not.toMatch(/PageChrome[^>]*icon=/);
  });

  it("sidebar Act/more-item stay native (no .ds-btn on density chrome)", () => {
    const sidebar = readFileSync("src/webview/sidebar/App.tsx", "utf8");
    expect(sidebar).toMatch(/const Act =[\s\S]*?<button class="act"/);
    expect(sidebar).not.toMatch(/const Act =[\s\S]*?IconButton/);
    expect(sidebar).toMatch(/class="more-item" type="button"/);
    expect(sidebar).not.toMatch(/Button class="more-item"/);
  });
});
