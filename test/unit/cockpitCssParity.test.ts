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

  // t-610705 (Phase D, D2) — same ordering hazard as Agent Studio above, one sheet deeper: Task
  // Studio's lazy block must request tailwind, THEN rich-doc, THEN the shared studio-frame sheet,
  // THEN its own sheet — matching Cockpit.ts's eager `styles: [...]` order exactly (see that array's
  // own D2 comment for why rich-doc must precede studio-frame, not follow it).
  it("Task Studio's lazy block requests tailwind, then rich-doc, then the shared studio-frame sheet, in that order", () => {
    const app = readFileSync("src/webview/cockpit/App.tsx", "utf8");
    const block = /TaskStudioApp = lazy\(([\s\S]*?)return \{ default: m\.App \};/.exec(app);
    expect(block, "cockpit/App.tsx: TaskStudioApp lazy block not found — did it move or get renamed?").not.toBeNull();
    const calls = [...block![1].matchAll(/loadSectionStylesheet\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1]);
    expect(calls).toEqual(["studio-task-tailwind", "studio-task-richdoc", "studio-frame-task", "studio-task"]);
  });

  // t-610705 (Phase D, D3) — same ordering hazard as Task Studio above, minus the Tailwind sheet
  // (Pin has no Tailwind-family controls): rich-doc THEN the shared studio-frame sheet THEN its own
  // sheet — matching Cockpit.ts's eager `styles: [...]` order exactly. Own co-load key
  // ("studio-pin-richdoc") even though it resolves to the same rich-doc.css href as Task's
  // "studio-task-richdoc" — a shared key called from two lazy blocks would fail the co-load-id
  // parity check below (a plain array compare, not set-based).
  it("Pin Studio's lazy block requests rich-doc, then the shared studio-frame sheet, in that order", () => {
    const app = readFileSync("src/webview/cockpit/App.tsx", "utf8");
    const block = /PinStudioApp = lazy\(([\s\S]*?)return \{ default: m\.App \};/.exec(app);
    expect(block, "cockpit/App.tsx: PinStudioApp lazy block not found — did it move or get renamed?").not.toBeNull();
    const calls = [...block![1].matchAll(/loadSectionStylesheet\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1]);
    expect(calls).toEqual(["studio-pin-richdoc", "studio-frame-pin", "studio-pin"]);
  });
});
