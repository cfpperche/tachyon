import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ROUTES } from "../../scripts/webview-preview/routes.js";

// t-6bbdf6 — the webview-preview harness's cockpit route drifted from the real Control host: the host linked
// validations.css but the harness didn't, so the harness rendered the Validations tab unstyled (and baked that
// into fixture screenshots). A "does it link validations.css" test would only guard the one file that already
// broke, so this asserts PARITY instead: the harness's cockpit cssLinks are the SAME product CSS set, in the
// SAME order, as the real host's.
//
// Cockpit.ts composes its link set inline (`uri("x.css")` inside renderWebviewShell's `styles:`) with no
// exported symbol to import, so we source-scan that one array — the tolerant-source-scan pattern already used
// by webviewConvention.test.ts. If a future refactor exports a real constant, import it here instead.

const COCKPIT_HOST = "src/webview/Cockpit.ts";

/** the css basenames the real Control host links, in link order, read out of its renderWebviewShell call. */
function hostCssOrder(): string[] {
  const src = readFileSync(COCKPIT_HOST, "utf8");
  const block = /\bstyles:\s*\[([\s\S]*?)\]/.exec(src);
  expect(block, `${COCKPIT_HOST}: no \`styles: [...]\` array found — did the shell call move or get renamed?`).not.toBeNull();
  return [...block![1].matchAll(/uri\(\s*["'`]([^"'`]+\.css)["'`]\s*\)/g)].map((m) => m[1]);
}

/** the css basenames the harness cockpit route links, in link order. */
function harnessCssOrder(): string[] {
  return ROUTES.cockpit.cssLinks.map((href) => href.slice(href.lastIndexOf("/") + 1));
}

describe("cockpit css parity (harness ↔ real Control host)", () => {
  it("reads a non-trivial link set out of the real host (guard against a silently-empty scan)", () => {
    const host = hostCssOrder();
    // a broken regex that matched nothing would make every parity assertion below vacuously pass.
    expect(host.length).toBeGreaterThan(5);
    expect(host).toContain("cockpit.css");
    expect(new Set(host).size, `${COCKPIT_HOST}: duplicate css link`).toBe(host.length);
  });

  it("the harness cockpit route links the same product CSS, in the same order, as the real host", () => {
    // order is a real contract, not cosmetics: these files cascade over each other.
    expect(harnessCssOrder()).toEqual(hostCssOrder());
  });

  it("cockpit.css stays LAST in both (its own header comment: 'linked LAST — these rules must win')", () => {
    // cockpit.css hard-resets html/body/#root globals that the embedded surfaces' standalone CSS sets;
    // anything linked after it would break every Control tab.
    expect(hostCssOrder().at(-1)).toBe("cockpit.css");
    expect(harnessCssOrder().at(-1)).toBe("cockpit.css");
  });

  it("links validations.css — the embedded Validations tab's own stylesheet (the t-6bbdf6 regression)", () => {
    expect(hostCssOrder()).toContain("validations.css");
    expect(harnessCssOrder()).toContain("validations.css");
  });

  // t-610705 Phase B — CSS co-load key parity: every loadSectionStylesheet("<id>") the client calls
  // must have a URI registered under that exact key in the host's __tachyonSectionStyles bootstrap
  // global, or that section's stylesheet silently never loads in production (only when it wasn't the
  // opening section — the worst kind of drift: invisible in the harness, which links everything).
  it("every client co-load id has a host bootstrap-global key (and vice versa)", () => {
    const app = readFileSync("src/webview/cockpit/App.tsx", "utf8");
    const clientIds = [...app.matchAll(/loadSectionStylesheet\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1]).sort();
    expect(clientIds.length, "no loadSectionStylesheet calls found in cockpit/App.tsx — did the co-load move?").toBeGreaterThan(0);

    const host = readFileSync(COCKPIT_HOST, "utf8");
    const block = /__tachyonSectionStyles:\s*\{([\s\S]*?)\}/.exec(host);
    expect(block, `${COCKPIT_HOST}: no __tachyonSectionStyles bootstrap-global block found`).not.toBeNull();
    const hostKeys = [...block![1].matchAll(/(?:"([^"]+)"|([A-Za-z-]+)):\s*uri\(/g)].map((m) => m[1] ?? m[2]).sort();

    expect(clientIds).toEqual(hostKeys);
  });

  // t-610705 (Phase D, D1b code-review finding) — loadSectionStylesheet APPENDS a real <link> on every
  // call, so a lazy studio block's CALL ORDER determines the DOM cascade order for an in-session
  // navigation into that studio — a Tailwind utilities sheet requested AFTER the shared studio-frame
  // sheet reverses the intended cascade for a route reached by navigating IN (as opposed to a direct
  // deep-link, whose initial <link> tags come from Cockpit.ts's own array and are unaffected). Only
  // Agent Studio has this shape today (the only studio needing a Tailwind co-load); this guards that
  // specific ordering rather than a generic property, since it's the concrete bug that shipped once.
  it("Agent Studio's lazy block requests its Tailwind sheet before the shared studio-frame sheet", () => {
    const app = readFileSync("src/webview/cockpit/App.tsx", "utf8");
    const block = /AgentStudioApp = lazy\(([\s\S]*?)return \{ default: m\.App \};/.exec(app);
    expect(block, "cockpit/App.tsx: AgentStudioApp lazy block not found — did it move or get renamed?").not.toBeNull();
    const calls = [...block![1].matchAll(/loadSectionStylesheet\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1]);
    expect(calls).toEqual(["studio-agent-tailwind", "studio-frame-agent", "studio-agent"]);
  });

  // t-610705 (Phase D, D3) — same ordering hazard as Task Studio above, minus the Tailwind sheet
  // (Pin has no Tailwind-family controls): rich-doc THEN the shared studio-frame sheet THEN its own
  // sheet — matching Cockpit.ts's eager `styles: [...]` order exactly. Own co-load key
  // ("studio-pin-richdoc") even though it resolves to the same rich-doc.css href as Task's
  // "studio-task-richdoc" — a shared key called from two lazy blocks would fail the co-load-id
  // parity check below (a plain array compare, not set-based).
  // t-32c872 — the SAME parity, one app over: the harness's Board route must link exactly what
  // `BoardPanel.ts` links, in the same order. This is not symmetry for its own sake — the Board's visual
  // evidence (per-column scrolling, no page scroll) is taken in this harness, and a harness that links a
  // different set proves nothing about what ships. The host's list is a `styleFiles:` config handed to
  // SectionPanelManager rather than an inline `styles: [...]`, so it is scanned from that key.
  it("the harness Board route links the same product CSS, in the same order, as BoardPanel.ts", () => {
    const src = readFileSync("src/webview/BoardPanel.ts", "utf8");
    const block = /\bstyleFiles:\s*\[([\s\S]*?)\]/.exec(src);
    expect(block, "src/webview/BoardPanel.ts: no `styleFiles: [...]` array found — did the config move?").not.toBeNull();
    const host = [...block![1].matchAll(/["'`]([^"'`]+\.css)["'`]/g)].map((m) => m[1]);
    expect(host.length, "empty scan of BoardPanel.ts styleFiles — a silently-blind parity check").toBeGreaterThan(3);
    expect(host).toContain("page-frame.css");
    expect(ROUTES["mission-control"].cssLinks.map((href) => href.slice(href.lastIndexOf("/") + 1))).toEqual(host);
  });

  // SDD 485 D1 — the same parity, one app over. The tmux app's visual evidence is taken in this harness,
  // so a harness linking a different set proves nothing about what ships. Same scan shape as the Board's
  // above (a `styleFiles:` config handed to SectionPanelManager, not an inline `styles: [...]`).
  it("the harness tmux route links the same product CSS, in the same order, as TmuxPanel.ts", () => {
    const src = readFileSync("src/webview/TmuxPanel.ts", "utf8");
    const block = /\bstyleFiles:\s*\[([\s\S]*?)\]/.exec(src);
    expect(block, "src/webview/TmuxPanel.ts: no `styleFiles: [...]` array found — did the config move?").not.toBeNull();
    const host = [...block![1].matchAll(/["'`]([^"'`]+\.css)["'`]/g)].map((m) => m[1]);
    expect(host.length, "empty scan of TmuxPanel.ts styleFiles — a silently-blind parity check").toBeGreaterThan(2);
    expect(ROUTES.inspector.cssLinks.map((href) => href.slice(href.lastIndexOf("/") + 1))).toEqual(host);
  });

  // SDD 485 D2 — the same parity, one app over. Load-bearing here for a specific reason: the four card
  // states t-4e5f11 built are photographed through this harness, and `plugins.css` is the sheet that
  // styles the badge, the card and the 720px reflow. A harness linking a different set would photograph a
  // screen that does not ship.
  it("the harness Plugins route links the same product CSS, in the same order, as PluginsPanel.ts", () => {
    const src = readFileSync("src/webview/PluginsPanel.ts", "utf8");
    const block = /\bstyleFiles:\s*\[([\s\S]*?)\]/.exec(src);
    expect(block, "src/webview/PluginsPanel.ts: no `styleFiles: [...]` array found — did the config move?").not.toBeNull();
    const host = [...block![1].matchAll(/["'`]([^"'`]+\.css)["'`]/g)].map((m) => m[1]);
    expect(host.length, "empty scan of PluginsPanel.ts styleFiles — a silently-blind parity check").toBeGreaterThan(3);
    // the Tailwind layer must precede the base sheet, which is the order Control linked them in and the
    // order the cascade needs (utilities layer first, panel deltas after).
    expect(host.indexOf("plugins.tailwind.css")).toBeLessThan(host.indexOf("plugins.css"));
    expect(ROUTES.plugins.cssLinks.map((href) => href.slice(href.lastIndexOf("/") + 1))).toEqual(host);
  });

  it("Control no longer links the plugins sheets — the cutover's other half, checked rather than remembered", () => {
    // A section that left Control must take its stylesheets with it: an eager link for a screen this
    // build cannot render is dead weight in every session, and a co-load key with no caller is the kind of
    // residue t-17d885 was about.
    expect(hostCssOrder()).not.toContain("plugins.css");
    expect(hostCssOrder()).not.toContain("plugins.tailwind.css");
    expect(readFileSync(COCKPIT_HOST, "utf8")).not.toContain('"plugins-tailwind"');
  });

  // SDD 485 D3 — the same parity, one app further. Load-bearing for the same reason the others are: the
  // `?view=runtime-ops` route is what `test/browser/runtimeOpsView.test.ts` drives, and a harness linking a
  // different sheet set would photograph a screen that does not ship.
  it("the harness Runtime Ops route links the same product CSS, in the same order, as RuntimeOpsPanel.ts", () => {
    const src = readFileSync("src/webview/RuntimeOpsPanel.ts", "utf8");
    const block = /\bstyleFiles:\s*\[([\s\S]*?)\]/.exec(src);
    expect(block, "src/webview/RuntimeOpsPanel.ts: no `styleFiles: [...]` array found — did the config move?").not.toBeNull();
    const host = [...block![1].matchAll(/["'`]([^"'`]+\.css)["'`]/g)].map((m) => m[1]);
    expect(host.length, "empty scan of RuntimeOpsPanel.ts styleFiles — a silently-blind parity check").toBeGreaterThan(2);
    expect(ROUTES["runtime-ops"].cssLinks.map((href) => href.slice(href.lastIndexOf("/") + 1))).toEqual(host);
  });

  it("Control no longer links the runtime-ops sheet — the cutover's other half, checked rather than remembered", () => {
    // A section that left Control must take its stylesheet with it: an eager link for a screen this build
    // cannot render is dead weight in every session, and a co-load key with no caller is the kind of
    // residue t-17d885 was about.
    expect(hostCssOrder()).not.toContain("runtime-ops.css");
    expect(readFileSync(COCKPIT_HOST, "utf8")).not.toContain("runtime: uri(");
  });

  it("Pin Studio's lazy block requests rich-doc, then the shared studio-frame sheet, in that order", () => {
    const app = readFileSync("src/webview/cockpit/App.tsx", "utf8");
    const block = /PinStudioApp = lazy\(([\s\S]*?)return \{ default: m\.App \};/.exec(app);
    expect(block, "cockpit/App.tsx: PinStudioApp lazy block not found — did it move or get renamed?").not.toBeNull();
    const calls = [...block![1].matchAll(/loadSectionStylesheet\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1]);
    expect(calls).toEqual(["studio-pin-richdoc", "studio-frame-pin", "studio-pin"]);
  });
});
