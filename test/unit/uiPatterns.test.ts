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

  it("standalone Fleet and Approvals adopt the patterns", () => {
    // SDD 485 D18 — Control was the first subject in this list and has been dropped, not repointed:
    // it renders no product surface any more, so "does the page adopt the shared page patterns" has
    // no page to ask about. The surfaces that inherited its screens are each asserted in their own
    // cutover test plus the shared page-chrome guard, so nothing this line covered went uncovered.
    // t-41117e — Fleet no longer paints its own ListRow boolean list. It reuses AgentsRoster
    // (nine statuses) under PageChrome + EmptyState, which is the richer shared pattern.
    const fleet = readFileSync("src/webview/fleet/App.tsx", "utf8");
    expect(fleet).toContain("PageChrome");
    expect(fleet).toContain("AgentsRoster");
    expect(fleet).toContain("EmptyState");
    expect(fleet).not.toMatch(/\ba\.running\b/);
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

  it("Approvals does not restyle bare buttons; page chrome type is tokenized", () => {
    const ap = readFileSync("src/webview/approval/approval.css", "utf8");
    expect(ap).not.toMatch(/\.approval-root\s+button\s*\{/);
    expect(ap).not.toMatch(/font-size:\s*22px/);
    const ds = readFileSync("src/webview/shared/design-system.css", "utf8");
    expect(ds).toMatch(/\.ds-btn\s*\{[\s\S]*min-height:\s*28px/);
    expect(ds).toMatch(/\.ds-page-chrome-title\s*\{[\s\S]*font-size:\s*var\(--ds-title\)/);
  });

  // t-b8b85c — the guard that has to BITE, because the two guards this repo already had did not.
  // `test/browser/boardHeaderKitParity.test.ts` measures the real thing but was dark for weeks (it
  // loaded a bundle the product had deleted) — including on the day 7be4265a landed the regression.
  // The unit guard above asserted `min-height: 28px`, a number that describes no rendered button
  // (the box computes from padding + border + line box, which is taller), so it passed happily while
  // the button drifted 2px away from the fields beside it. This one asserts the STRUCTURE that makes
  // drift impossible instead of a number that merely happens to be in the file.
  it("button/input/select-trigger share ONE control box (t-b8b85c: the 2px regression cannot come back)", () => {
    const ds = readFileSync("src/webview/shared/design-system.css", "utf8");

    // 1. The three selectors are declared TOGETHER, in one rule. Split them and this fails — which is
    //    what 7be4265a did when it folded t-6da5f0's copy into `.ds-btn` alone and dropped a term.
    const shared = /\.ds-btn,\s*\n\s*\.ds-input,\s*\n\s*\[data-slot="select-trigger"\]\s*\{([\s\S]*?)\n\}/.exec(ds);
    expect(shared, "the shared control-box rule must list .ds-btn, .ds-input and [data-slot=\"select-trigger\"] together").toBeTruthy();
    const box = shared![1];
    // everything after the shared rule — where each selector's own (colour/shape) rule lives
    const tail = ds.slice(shared!.index + shared![0].length);
    for (const term of ["padding:", "border:", "font-family:", "font-size:", "line-height:"]) {
      expect(box, `the shared control box must own ${term}`).toContain(term);
    }
    // the line box is a ratio, never px — --ds-mono may fall back to a host font, and a px line box
    // (or a px height) would clip instead of scaling with it.
    expect(box).toMatch(/line-height:\s*var\(--ds-control-line\)/);
    expect(ds).not.toMatch(/--ds-control-line:[^;]*px/);

    // 2. None of the three may re-declare a height term afterwards. A re-declaration is how the copy
    //    goes stale; forbidding it is the whole point of the shared rule.
    const ownBlock = (selector: string) => {
      const re = new RegExp(`(?:^|\\n)${selector.replace(/[.[\]"$^*+?()|{}\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
      const m = tail.match(re);
      expect(m, `expected a standalone rule for ${selector}`).toBeTruthy();
      return m![1];
    };
    for (const selector of [".ds-btn", ".ds-input", '[data-slot="select-trigger"]']) {
      const block = ownBlock(selector);
      for (const term of ["padding:", "font-family:", "font-size:", "line-height:"]) {
        expect(block, `${selector} must not re-declare ${term} — it comes from the shared control box`).not.toContain(term);
      }
      // `border:` shorthand would reset the shared border-width; only border-color may be set here.
      expect(block, `${selector} must not re-declare the border shorthand`).not.toMatch(/(?:^|;|\s)border:\s/);
    }

    // 3. --ds-control-h is DERIVED, not chosen: pad*2 + border*2 + round(font-size * line ratio).
    //    This is what bites when someone retunes the padding and forgets the nominal — the number
    //    stops matching the formula that produces it.
    const token = (name: string) => {
      const m = ds.match(new RegExp(`${name}:\\s*([^;]+);`));
      expect(m, `token ${name} must exist`).toBeTruthy();
      return m![1].trim();
    };
    // resolve one level of var() indirection, so retuning --ds-control-pad-y to another scale step is
    // allowed — as long as --ds-control-h follows it. That is the check, not a frozen token value.
    const px = (name: string): number => {
      const raw = token(name);
      const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(raw);
      return ref ? px(ref[1]) : Number(raw.replace("px", ""));
    };
    // the ratio is authored either as a plain number or as `calc(a / b)` — both are unitless by design
    const ratio = (() => {
      const raw = token("--ds-control-line");
      const frac = /^calc\(\s*([\d.]+)\s*\/\s*([\d.]+)\s*\)$/.exec(raw);
      return frac ? Number(frac[1]) / Number(frac[2]) : Number(raw);
    })();
    expect(Number.isFinite(ratio), "--ds-control-line must be a unitless ratio").toBe(true);
    const padY = px("--ds-control-pad-y");
    const border = px("--ds-border-width");
    const lineBox = Math.round(px("--ds-small") * ratio);
    expect(
      px("--ds-control-h"),
      "--ds-control-h must equal padding-block*2 + border*2 + line box — it is derived, not chosen",
    ).toBe(padY * 2 + border * 2 + lineBox);
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
