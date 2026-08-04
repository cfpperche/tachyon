import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { WEBVIEW_SURFACES, postureDeclarationErrors, type WebviewSurface } from "../../src/webview/surfaces.js";
import { SHELL_DESIGN_SYSTEM_STYLESHEET, SHELL_EXTENSION_POINTS, SHELL_PAGE_FRAME_STYLESHEET, type ShellExtensionPoint } from "../../src/webview/shared/shell.js";
import { buildsWebviewEntry } from "../helpers/webviewEntries.js";
import { WEBVIEW_APPS } from "../../src/webview/webviewApps.js";

// spec 279 — the webview CONVENTION GUARD (a unit test, so it rides the existing CI suite — no extra runner or
// tsx dependency, and more robust than a grep script). It asserts the inline-HTML panel class can't recur:
//   1. every converted surface is a real preact bundle (main.tsx + an esbuild entrypoint);
//   2. no host *Panel.ts carries inline webview app logic — `acquireVsCodeApi`, the precise tell that a panel's
//      webview JS lives inline (a converted panel calls it in its bundle's main.tsx, never in the host file) —
//      unless it's an unconverted LIVE panel still mid-migration (allowlisted via the manifest's `converted` flag);
//   3. the manifest covers every registered webview panel (a NEW un-manifested panel fails).
// As each spec-279 lane flips `converted`, the allowlist shrinks; when all are true a NEW inline panel fails here.

const esbuild = readFileSync("esbuild.mjs", "utf8");

describe("webview convention (spec 279)", () => {
  it("the extension-host bundle erases browser navigator probes (VS Code extension host migration guard)", () => {
    expect(esbuild).toContain("const nodeDefines =");
    expect(esbuild).toContain('navigator: "undefined"');
    expect(esbuild).toMatch(/const extension = \{[\s\S]*define: nodeDefines,/);
  });

  it("every converted surface is a real preact bundle (main.tsx + esbuild entry)", () => {
    for (const s of WEBVIEW_SURFACES.filter((x) => x.converted)) {
      expect(existsSync(`src/webview/${s.view}/main.tsx`), `${s.viewId}: missing src/webview/${s.view}/main.tsx`).toBe(true);
      // SDD 485 C2 — a bundle is emitted either by its own target's `outfile` or as one entry of the
      // multi-entry splitting invocation (outdir + entryNames, so no literal output path exists).
      expect(buildsWebviewEntry(esbuild, s.view), `${s.viewId}: no esbuild entrypoint for dist/webview/${s.view}.js`).toBe(true);
    }
  });

  it("no host file carries inline webview logic (acquireVsCodeApi) unless allowlisted (unconverted live panels)", () => {
    const allow = new Set(WEBVIEW_SURFACES.filter((s) => !s.converted && s.mode === "live").map((s) => s.hostFile));
    const violations: string[] = [];
    for (const f of [...new Set(WEBVIEW_SURFACES.map((s) => s.hostFile))]) {
      if (allow.has(f)) continue;
      if (!existsSync(f)) { violations.push(`missing host file ${f}`); continue; }
      if (/acquireVsCodeApi/.test(readFileSync(f, "utf8"))) violations.push(`${f}: inline acquireVsCodeApi — webview JS belongs in a preact bundle (spec 279)`);
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("no host emitter hand-rolls a <!DOCTYPE> — only the shared shell may (spec 280)", () => {
    // every top-level src/webview/*.ts is a vscode-bound host emitter; the one sanctioned <!DOCTYPE> site is
    // src/webview/shared/shell.ts (a subdir → naturally excluded here). A host that hand-rolls a page reintroduces
    // the duplicated-shell + CSP-drift problem this spec closed.
    // spec 485 A4 — a surface that DECLARES `replace` is allowed its own page: that is what the posture buys.
    // Silence is what fails, here and in the conformance block below.
    const replaceHosts = new Set(WEBVIEW_SURFACES.filter((s) => s.posture === "replace").map((s) => s.hostFile));
    const offenders = readdirSync("src/webview")
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => !replaceHosts.has(`src/webview/${f}`))
      .filter((f) => /<!DOCTYPE/i.test(readFileSync(`src/webview/${f}`, "utf8")));
    expect(offenders, `host files hand-rolling <!DOCTYPE> (use renderWebviewShell, or declare posture "replace"): ${offenders.join(", ")}`).toEqual([]);
  });

  it("is FULLY ENFORCING — every surface is converted, the allowlist is empty (spec 279 complete)", () => {
    const unconverted = WEBVIEW_SURFACES.filter((s) => !s.converted);
    expect(unconverted.map((s) => s.viewId), `still inline: ${unconverted.map((s) => s.viewId).join(", ")}`).toEqual([]);
  });

  it("the manifest covers every registered webview surface in the codebase", () => {
    // guard against a NEW panel sneaking in un-manifested: every createWebviewPanel id must be in the manifest.
    const ids = new Set(WEBVIEW_SURFACES.map((s) => s.viewId));
    const sources = [...new Set(WEBVIEW_SURFACES.map((s) => s.hostFile))].filter(existsSync);
    const found = new Set<string>();
    for (const f of sources) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/createWebviewPanel\(\s*["'`]([a-zA-Z]+)["'`]/g)) found.add(m[1]);
    }
    // SidebarPrototype registers the sidebar as a WebviewView (not a panel) — assert it's the only non-panel id.
    const missing = [...found].filter((id) => !ids.has(id));
    expect(missing, `un-manifested webview panel ids: ${missing.join(", ")}`).toEqual([]);
  });

  it("every editor-area Tachyon panel has an explicit reload serializer policy", () => {
    const extension = readFileSync("src/extension.ts", "utf8");
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { contributes?: { views?: Record<string, Array<{ id: string }>> } };
    const contributedViews = new Set(Object.values(pkg.contributes?.views ?? {}).flat().map((view) => view.id));
    const restored: Record<string, string> = {
      tachyonActivity: "ACTIVITY_VIEW_TYPE",
      tachyonHandoff: "HANDOFF_VIEW_TYPE",
      tachyonPlugins: "PLUGINS_VIEW_TYPE",
      tachyonPinStudio: "PIN_STUDIO_VIEW_TYPE",
      tachyonProbes: "PROBES_VIEW_TYPE",
      // SDD 485 D1 — the same viewType, a LIVE app again: its serializer revives the panel into
      // TmuxPanelManager instead of disposing and redirecting (the token moved to TmuxPanel.ts with it).
      tachyonServerInspector: "TMUX_VIEW_TYPE",
      // SDD 485 D3 — a NEW viewType, unlike the three reuses above it: the only legacy id
      // (`tachyonRuntimeOpsView`) names spec 367's retired WebviewView, a different surface KIND that was
      // never registered, so it stays in the dispose-only loop and this app registers its own.
      tachyonRuntimeOps: "RUNTIME_OPS_VIEW_TYPE",
      // SDD 485 D4 — the Human Inbox app. A NEW viewType with NO legacy id behind it: this surface was
      // born as a Control section after 410 and never had a standalone panel, so unlike C4's and D2's
      // reuses there is no tombstone and no `migrateLegacy`.
      tachyonHumanInbox: "HUMAN_INBOX_VIEW_TYPE",
      tachyonEngine: "ENGINE_VIEW_TYPE",
      tachyonWorktrees: "WORKTREES_VIEW_TYPE",
      tachyonFleet: "FLEET_VIEW_TYPE",
      tachyonExecutionGraph: "EXECUTION_GRAPH_VIEW_TYPE",
      tachyonCockpit: "COCKPIT_VIEW_TYPE",
      tachyonPinPreview: "PIN_PREVIEW_VIEW_TYPE",
      tachyonMissionControl: "MISSION_CONTROL_VIEW_TYPE",
      // SDD 485 C5 — the Board's own viewType, and the first app on `SectionPanelManager` that genuinely
      // revives (the legacy id above stays a dispose+redirect INTO this one).
      tachyonBoard: "BOARD_VIEW_TYPE",
      tachyonTaskDetail: "TASK_DETAIL_VIEW_TYPE",
      tachyonTaskStudio: "TASK_STUDIO_VIEW_TYPE",
      tachyonApprovals: "APPROVAL_VIEW_TYPE",
      tachyonPipelineStudio: "PIPELINE_STUDIO_VIEW_TYPE",
      tachyonAgentStudioShell: "AGENT_STUDIO_SHELL_VIEW_TYPE",
      tachyonTerminalStudioShell: "TERMINAL_STUDIO_SHELL_VIEW_TYPE",
      tachyonCommandStudioShell: "COMMAND_STUDIO_SHELL_VIEW_TYPE",
      tachyonRunbookStudioShell: "RUNBOOK_STUDIO_SHELL_VIEW_TYPE",
      tachyonScheduleStudioShell: "SCHEDULE_STUDIO_SHELL_VIEW_TYPE",
      tachyonAgentPane: "AGENT_PANE_VIEW_TYPE",
      tachyonRuntimeConfig: "RUNTIME_CONFIG_VIEW_TYPE",
      tachyonSettings: "SETTINGS_VIEW_TYPE",
      tachyonOverview: "OVERVIEW_VIEW_TYPE",
    };
    const disposeOnly = new Set(["tachyonAgentFixtureStudio", "tachyonSectionAppFixture", "tachyonControlInspector", "tachyonPluginSurface", "tachyonPluginSurfaces"]);
    const violations: string[] = [];
    for (const s of WEBVIEW_SURFACES) {
      // Statically contributed WebviewViews are recreated by VS Code through their provider; serializers apply
      // only to createWebviewPanel editor surfaces. tachyonSidebar is the legacy manifest id for its provider.
      if (s.viewId === "tachyonSidebar" || contributedViews.has(s.viewId)) continue;
      const token = restored[s.viewId];
      if (token) {
        if (!new RegExp(`registerTrustedPanelSerializer<[^>]+>\\(context,\\s*${token}\\b`).test(extension)) violations.push(`${s.viewId}: missing trusted serializer`);
        continue;
      }
      if (disposeOnly.has(s.viewId)) {
        if (!extension.includes(`"${s.viewId}"`) || !extension.includes("registerDisposePanelSerializer(context, viewType)")) violations.push(`${s.viewId}: missing dispose-only serializer`);
        continue;
      }
      violations.push(`${s.viewId}: no reload serializer policy`);
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// spec 485 Phase A — the DESIGN-SYSTEM CONFORMANCE CONTRACT.
//
// SDD 410 made the design system enforceable with a mechanism, not with discipline: collapse 23 peer apps
// into one runtime, because "a shared kit cannot enforce one runtime when every surface is a peer app". 485
// puts the app count back. Without a replacement mechanism the reversal recreates 2026-07-18 exactly — dual
// command routes, CSS bleed, dual pad, surface-local shell overrides. This block is the replacement.
//
// It fails an UNDECLARED departure and names the surface. It does NOT fail a declared one: `extend` composes
// through the shell's named points, `replace` brings its own shell with a reason. A contract with no supported
// way out is a contract that gets worked around, and a worked-around contract enforces nothing.
//
// Everything below reads the source the surface actually ships (its host file and its own CSS), never a
// parallel inventory — a declaration that has drifted from the code is itself a failure, in both directions:
// an undeclared departure fails, and a declared point that is NOT used fails too (otherwise `extend`
// everything becomes a rubber stamp and the contract is back to honour-system).
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** CSS with comments removed — a `body {` inside a comment is not page chrome. */
const stripCssComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** every selector text in a stylesheet (including inside `@media`/`@layer` blocks). */
function cssSelectors(css: string): string[] {
  return [...stripCssComments(css).matchAll(/(?:^|[};{])\s*([^{};@]+?)\s*\{/g)].map((m) => m[1]);
}

/** the surface's OWN stylesheets: `src/webview/<view>/**\/*.css`. Sheets a surface merely LINKS that belong to
 *  another app's directory are that app's to answer for (Control links every embedded section's sheet). */
function ownStylesheets(view: string): Array<{ file: string; css: string }> {
  const out: Array<{ file: string; css: string }> = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith(".css")) out.push({ file: p, css: readFileSync(p, "utf8") });
    }
  };
  walk(`src/webview/${view}`);
  return out;
}

const cssNamesIn = (block: string): string[] => [...block.matchAll(/["'`]([^"'`]+\.css)["'`]/g)].map((m) => m[1]);

/** the `renderWebviewShell` option chunks in a host file, one per call site (a host may serve two surfaces —
 *  SidebarPrototype renders both the sidebar view and pin-preview). Keyed back to a surface by its bundle. */
function shellCallChunks(hostSource: string): Array<{ view: string; chunk: string }> {
  const out: Array<{ view: string; chunk: string }> = [];
  for (const chunk of hostSource.split("renderWebviewShell(").slice(1)) {
    const bundle = /\bbundle:\s*uri\(\s*["'`]([^"'`]+)\.js["'`]\s*\)/.exec(chunk)?.[1];
    if (bundle) out.push({ view: bundle, chunk });
  }
  return out;
}

/** the stylesheet basenames a surface links, in link order. Three shapes exist, all of them ending at the
 *  same `renderWebviewShell` option: a direct call (`styles: [uri("x.css"), …]`); a `StudioSurfaceConfig`
 *  handed to the shared studio host base (`styleFiles: [...]` next to `bundleFile: "<view>.js"`); and, since
 *  SDD 485 C1, a `SectionAppConfig` handed to `SectionPanelManager` (`styleFiles: [...]` next to the
 *  manifest row the host names, `webviewApp("<view>")` — that manager derives the bundle from the manifest,
 *  so there is no `bundleFile` to key on). */
function linkedStylesheets(s: WebviewSurface): string[] {
  const src = readFileSync(s.hostFile, "utf8");
  for (const { view, chunk } of shellCallChunks(src)) {
    if (view !== s.view) continue;
    const block = /\bstyles:\s*\[([\s\S]*?)\]/.exec(chunk);
    if (block) return cssNamesIn(block[1]);
  }
  const namesItsSurface = new RegExp(String.raw`bundleFile:\s*["'\`]${s.view}\.js["'\`]`).test(src)
    || new RegExp(String.raw`webviewApp\(\s*["'\`]${s.view}["'\`]\s*\)`).test(src);
  if (namesItsSurface) {
    const block = /\bstyleFiles:\s*\[([\s\S]*?)\]/.exec(src);
    if (block) return cssNamesIn(block[1]);
  }
  return [];
}

/** host files under `src/webview/shared/` that assemble a page — a surface may reach the shared shell through
 *  one of these (PipelineStudioPanel delegates to StudioPanelManagerBase) instead of calling it directly. */
function sharedMountModules(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith(".ts") && readFileSync(p, "utf8").includes("renderWebviewShell(")) out.push(entry.replace(/\.ts$/, ""));
    }
  };
  walk("src/webview/shared");
  return out;
}

/** the extension points a surface's shipped code ACTUALLY exercises, with the evidence that proves each. */
function observedExtensionPoints(s: WebviewSurface): Map<ShellExtensionPoint, string> {
  const found = new Map<ShellExtensionPoint, string>();
  const linked = linkedStylesheets(s);
  if (!linked.includes(SHELL_DESIGN_SYSTEM_STYLESHEET)) {
    found.set("base-style", `${s.hostFile} links [${linked.join(", ")}] — no ${SHELL_DESIGN_SYSTEM_STYLESHEET}`);
  }
  for (const { file, css } of ownStylesheets(s.view)) {
    const chrome = cssSelectors(css).find((sel) => sel.split(",").some((part) => /^\s*(html|body)\b/.test(part)));
    if (chrome !== undefined && !found.has("page-chrome")) found.set("page-chrome", `${file}: styles the page frame itself — \`${chrome.trim().replace(/\s+/g, " ")} { … }\``);
    const token = /(?:^|[;{])\s*(--ds-[a-z0-9-]+)\s*:/.exec(stripCssComments(css));
    if (token && !found.has("token-scale")) found.set("token-scale", `${file}: defines its own \`${token[1]}\` value`);
  }
  return found;
}

const declaredExtensionPoints = (s: WebviewSurface): ShellExtensionPoint[] => (s.posture === "extend" ? [...s.extensionPoints] : []);

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// spec 485 Phase A — CONSUMPTION, the question the declaration half cannot ask (t-32c872).
//
// The block above asks "does this surface DECLARE that it styles the page frame?". For the Board the answer
// was no, and it was RIGHT: `mission-control.css` styles no `html`/`body`, mints no `--ds-*`, links the
// design system — legitimately `conform`. It shipped standalone and lost per-column scrolling anyway,
// because its layout DEPENDS on a page frame that a sheet it no longer links used to provide (cockpit.css
// pinned `html, body { height: 100% }`; the Board linked it only while it lived inside Control).
//
// So a surface can be conforming and still break the moment it stops sitting next to whatever was holding
// it up. The missing question is the other half: **does this surface CONSUME page chrome that another sheet
// provides — and does it link that sheet itself?** Same spirit as the rest of the phase: read the shipped
// source, name the surface, no parallel inventory.
//
// It is checkable because a percentage height chain has exactly one root. `#root` is the SHELL's element,
// so a surface giving it `height: 100%` is asking an ancestor it does not own (`body`) for a definite
// height — that rule is the seam, and it is why `page-frame.css` deliberately stops at `body`. (`min-height:
// 0` on its own asks nothing of anyone: it is a flex-shrink fix, not a dependency.)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** every `selector { declarations }` pair in a stylesheet (comments stripped; at-rule preludes skipped). */
function cssRules(css: string): Array<{ selector: string; body: string }> {
  return [...stripCssComments(css).matchAll(/(?:^|[};{])\s*([^{};@]+?)\s*\{([^{}]*)\}/g)].map((m) => ({ selector: m[1], body: m[2] }));
}

const oneLine = (s: string): string => s.trim().replace(/\s+/g, " ");
const selectsShellRoot = (selector: string): boolean => selector.split(",").some((part) => /(?:^|[\s>+~])#root\b/.test(part.trim()));
const declaresPercentHeight = (body: string): boolean => /(?:^|[;{\s])(?:min-)?height\s*:\s*[^;]*\d%/.test(body);
const declaresOutOfFlowRoot = (body: string): boolean => /(?:^|[;{\s])position\s*:\s*(absolute|fixed)/.test(body);

/**
 * The surface's dependency on a page frame it does not own: its own CSS gives the shell's `#root` a
 * PERCENTAGE height. Returns the offending rule as evidence, or undefined when the surface asks for nothing
 * (task detail scrolls as a document; agent-pane pins `#root` out of flow with `inset: 0`, which resolves
 * against the initial containing block and needs no ancestor height at all).
 */
function rootHeightDependency(view: string): { file: string; rule: string } | undefined {
  for (const { file, css } of ownStylesheets(view)) {
    for (const { selector, body } of cssRules(css)) {
      if (selectsShellRoot(selector) && declaresPercentHeight(body)) return { file, rule: `${oneLine(selector)} { ${oneLine(body)} }` };
    }
  }
  return undefined;
}

/** Any `#root` rule that anchors the surface to the page frame — a percentage height, or out-of-flow. */
function anchorsToPageFrame(view: string): boolean {
  return ownStylesheets(view).some(({ css }) =>
    cssRules(css).some(({ selector, body }) => selectsShellRoot(selector) && (declaresPercentHeight(body) || declaresOutOfFlowRoot(body))));
}

/** every `src/webview/**\/*.css` source, indexed by basename (a linked sheet is a `dist/webview` filename). */
function stylesheetSourcesByName(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith(".css")) out.set(entry, [...(out.get(entry) ?? []), p]);
    }
  };
  walk("src/webview");
  return out;
}

/** Does this sheet give the page frame itself a height — i.e. is it the ROOT of a percentage chain? */
function pageFrameHeightRule(css: string): string | undefined {
  for (const { selector, body } of cssRules(css)) {
    const framesPage = selector.split(",").some((part) => /^\s*(html|body)\b/.test(part));
    if (framesPage && /(?:^|[;{\s])height\s*:/.test(body)) return `${oneLine(selector)} { ${oneLine(body)} }`;
  }
  return undefined;
}

/** the sheets a surface LINKS that provide the page frame's height, resolved back to their source. */
function linkedPageFrameProviders(s: WebviewSurface, sources: Map<string, string[]>): string[] {
  return linkedStylesheets(s).flatMap((name) => (sources.get(name) ?? []).filter((p) => pageFrameHeightRule(readFileSync(p, "utf8")) !== undefined));
}

describe("webview design-system conformance contract (spec 485 Phase A)", () => {
  it("every surface declares a posture, and the declaration is well-formed", () => {
    // A1 — 410's standing exceptions (sidebar, pin-preview, the dev-only spec-350 fakes, the plugin surfaces)
    // carry forward as EXPLICIT entries. `posture` is required by the type, so "no posture" cannot compile;
    // what this catches is a declaration that compiles but says nothing (empty reason, empty point list).
    const errors = WEBVIEW_SURFACES.flatMap(postureDeclarationErrors);
    expect(errors, errors.join("\n")).toEqual([]);
    expect(WEBVIEW_SURFACES.length).toBeGreaterThan(0);
  });

  it("`replace` passes with a reason and FAILS on an empty one (the rule, not just today's manifest)", () => {
    // no surface replaces the shell today, so assert the rule on synthetic entries — otherwise the requirement
    // "an empty or missing reason fails" would be untested until the first surface needs it, which is the
    // moment it is least likely to be noticed.
    const base = { viewId: "scratch", view: "scratch", hostFile: "src/webview/Scratch.ts", mode: "live", converted: true } as const;
    expect(postureDeclarationErrors({ ...base, posture: "replace", reason: "hosts a third-party canvas that owns its own document" })).toEqual([]);
    expect(postureDeclarationErrors({ ...base, posture: "replace", reason: "   " })).toHaveLength(1);
    expect(postureDeclarationErrors({ ...base, posture: "replace", reason: "" })[0]).toContain("non-empty reason");
    expect(postureDeclarationErrors({ ...base, posture: "extend", extensionPoints: [] })[0]).toContain("at least one extension point");
    expect(postureDeclarationErrors({ ...base, posture: "extend", extensionPoints: ["page-chrome"] })).toEqual([]);
  });

  it("reads a real stylesheet list for every surface (guard against a silently-blind contract)", () => {
    // the whole block below is derived from these lists. A regex that quietly matched nothing would make every
    // conformance assertion vacuously pass — a test that sees nothing is worse than no test.
    const blind = WEBVIEW_SURFACES.filter((s) => s.posture !== "replace" && linkedStylesheets(s).length === 0);
    expect(blind.map((s) => `${s.viewId} (${s.hostFile})`), "could not read a stylesheet list — did a shell call move or change shape?").toEqual([]);
  });

  it("every surface mounts through the shared shell unless it declares `replace`", () => {
    const shared = sharedMountModules();
    const violations: string[] = [];
    for (const s of WEBVIEW_SURFACES) {
      if (s.posture === "replace") continue;
      const src = readFileSync(s.hostFile, "utf8");
      const direct = src.includes("renderWebviewShell(");
      const viaShared = shared.some((m) => new RegExp(String.raw`from\s+["'\`][^"'\`]*\b${m}\.js["'\`]`).test(src));
      if (!direct && !viaShared) {
        violations.push(`${s.viewId} (${s.hostFile}): mounts outside the shared shell — call renderWebviewShell, or declare posture "replace" with a reason`);
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("an UNDECLARED departure from the shared shell/design system fails and names the surface", () => {
    // the scenario this whole phase exists for. Three departures are detected from the shipped source:
    //   page-chrome — the surface's own CSS styles `html`/`body`, which design-system.css already owns;
    //   base-style  — the surface links no design-system.css at all;
    //   token-scale — the surface mints its own `--ds-*` values instead of reading the scale.
    const violations: string[] = [];
    for (const s of WEBVIEW_SURFACES) {
      if (s.posture === "replace") continue;
      const declared = new Set(declaredExtensionPoints(s));
      for (const [point, evidence] of observedExtensionPoints(s)) {
        if (!declared.has(point)) {
          violations.push(`${s.viewId}: UNDECLARED "${point}" — ${evidence}. Declare posture "extend" naming "${point}" in WEBVIEW_SURFACES, or stop departing.`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("a declared extension point is one the surface actually uses (no blanket declarations)", () => {
    // the other direction, and the reason `extend` cannot become a rubber stamp: declaring the whole point set
    // on every surface would silence the check above, so a point that is not exercised is itself a failure.
    const violations: string[] = [];
    for (const s of WEBVIEW_SURFACES) {
      if (s.posture === "replace") continue;
      const observed = observedExtensionPoints(s);
      for (const point of declaredExtensionPoints(s)) {
        if (!observed.has(point)) violations.push(`${s.viewId}: declares extension point "${point}" but nothing in its host or CSS uses it — drop it (a declaration nobody checks is how the contract rots)`);
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("a host that binds itself to the shell declares exactly its manifest posture", () => {
    // A2/A3 — `surface`/`extend` on renderWebviewShell put the claim in the rendered page. The manifest stays
    // the declaration of record (Cockpit.ts, AgentPanePanel.ts and StudioPanelManagerBase were Phase B's files
    // when this landed and are not bound yet — t-4a3333), but a host that DOES bind must not disagree with it.
    const violations: string[] = [];
    for (const hostFile of [...new Set(WEBVIEW_SURFACES.map((s) => s.hostFile))]) {
      for (const { view, chunk } of shellCallChunks(readFileSync(hostFile, "utf8"))) {
        const surface = WEBVIEW_SURFACES.find((s) => s.view === view && s.hostFile === hostFile);
        if (!surface) continue;
        const bound = /\bextend:\s*\[/.test(chunk) || /\bsurface:\s*/.test(chunk);
        if (!bound) continue;
        const block = /\bextend:\s*\[([\s\S]*?)\]/.exec(chunk);
        const passed = block ? [...block[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]).sort() : [];
        const declared = declaredExtensionPoints(surface).slice().sort();
        if (JSON.stringify(passed) !== JSON.stringify(declared)) {
          violations.push(`${hostFile} (${view}): passes extend [${passed.join(", ")}] but the manifest declares [${declared.join(", ")}]`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("the page-frame sheet REALLY provides the chain, and some surface really depends on one (blind-scan guard)", () => {
    // Same safeguard the stylesheet-list check above is: the two tests below are vacuous if the provider
    // detection matches nothing, or if no surface in the manifest consumes a chain at all.
    const sources = stylesheetSourcesByName();
    const frame = (sources.get(SHELL_PAGE_FRAME_STYLESHEET) ?? []).map((p) => ({ p, rule: pageFrameHeightRule(readFileSync(p, "utf8")) }));
    expect(frame.filter((f) => f.rule !== undefined).map((f) => f.p), `${SHELL_PAGE_FRAME_STYLESHEET} must exist and give html/body a height — it is what every consumer below is required to link`).not.toEqual([]);
    const consumers = WEBVIEW_SURFACES.filter((s) => s.posture !== "replace" && rootHeightDependency(s.view) !== undefined);
    expect(consumers.map((s) => s.viewId), "no surface anchors `#root` to a percentage height — the consumption check is reading nothing").not.toEqual([]);
  });

  it("a surface that DEPENDS on a root height chain links a sheet that provides it (t-32c872)", () => {
    // The Board's regression, as a rule rather than as one fix: `#root { height: 100% }` resolves against
    // `body`, so whichever sheet gives `body` a height has to be one this surface LINKS — not one that
    // happened to be loaded by the app it used to be embedded in.
    const sources = stylesheetSourcesByName();
    const violations: string[] = [];
    for (const s of WEBVIEW_SURFACES) {
      if (s.posture === "replace") continue;
      const dep = rootHeightDependency(s.view);
      if (!dep) continue;
      if (linkedPageFrameProviders(s, sources).length === 0) {
        violations.push(`${s.viewId}: CONSUMES a page-frame height chain but links nothing that provides it — ${dep.file}: \`${dep.rule}\` resolves against a \`body\` with no height, so it collapses to content. Link ${SHELL_PAGE_FRAME_STYLESHEET} (the shared frame) in ${s.hostFile}, or stop anchoring to the frame. Linked: [${linkedStylesheets(s).join(", ")}].`);
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("a surface that links the page-frame sheet actually anchors to it (no blanket linking)", () => {
    // The mirror rule, and the reason the frame sheet cannot quietly become "link it everywhere": a page
    // that never scrolls is the WRONG frame for a document surface (task detail's reading column would put
    // its own content out of reach), so linking it without anchoring `#root` to the frame is a defect too.
    const violations: string[] = [];
    for (const s of WEBVIEW_SURFACES) {
      if (s.posture === "replace") continue;
      if (!linkedStylesheets(s).includes(SHELL_PAGE_FRAME_STYLESHEET)) continue;
      if (!anchorsToPageFrame(s.view)) {
        violations.push(`${s.viewId} (${s.hostFile}): links ${SHELL_PAGE_FRAME_STYLESHEET} but its own CSS never anchors \`#root\` to the frame (no percentage height, not out of flow) — a page that cannot scroll is the wrong frame for a document surface. Drop the link, or say what the frame is for.`);
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("the shell's extension points are REAL — at least one live surface extends through them", () => {
    // A3's honesty check, kept as a test rather than a note: a shell nobody can extend is a shell people will
    // replace. If every surface ever lands on `conform`, the points below are decorative and this goes red.
    const extending = WEBVIEW_SURFACES.filter((s) => s.posture === "extend");
    expect(extending.map((s) => s.viewId), "no surface uses `extend` — the shell's extension points are decorative").not.toEqual([]);
    const used = new Set(extending.flatMap((s) => s.extensionPoints));
    const unused = SHELL_EXTENSION_POINTS.filter((p) => !used.has(p));
    expect(unused, `extension points declared by the shell but used by nothing: ${unused.join(", ")}`).toEqual([]);
  });

  it("the Engine app consumes its linked shared workspace sheet (SDD 485 D5)", () => {
    const host = readFileSync("src/webview/EnginePanel.ts", "utf8");
    const consumers = readFileSync("src/webview/engine/App.tsx", "utf8")
      + readFileSync("src/webview/cockpit/EngineLogPanel.tsx", "utf8");
    const shared = readFileSync("src/webview/shared/engine-workspace.css", "utf8");
    expect(host).toContain('"engine-workspace.css"');
    for (const className of ["ck-card-list", "ck-empty", "ci-ws", "ci-log"]) {
      expect(consumers).toContain(className);
      expect(shared).toContain(`.${className}`);
    }
  });

  it("every section app links definitions for the ck/ci classes its JSX consumes", () => {
    const sources = stylesheetSourcesByName();
    const violations: string[] = [];
    const skipped: string[] = [];
    for (const app of WEBVIEW_APPS.filter((entry) => entry.host === "section")) {
      // t-967b5b — this used to read ONLY `<view>/App.tsx` and `continue` when it was absent, which
      // skipped the app in silence and reported green for a surface it never opened. Four directories
      // were invisible that way, two of them the section apps D9 and D10 had just delivered; the
      // Settings app shipped `ck-panel` on its outermost container with no linked sheet defining it,
      // and this guard said nothing. A guard whose miss looks identical to a pass is worse than no
      // guard, because it is BELIEVED. Read whatever the app actually ships.
      const jsxSources = appSourceFiles(app.view);
      const surface = WEBVIEW_SURFACES.find((entry) => entry.view === app.view);
      if (!surface) continue;
      if (jsxSources.length === 0) { skipped.push(app.view); continue; }
      const linkedCss = linkedStylesheets(surface)
        .flatMap((name) => sources.get(name) ?? [])
        .map((file) => readFileSync(file, "utf8"))
        .join("\n");
      const jsx = jsxSources.map((file) => readFileSync(file, "utf8")).join("\n");
      // Only CLASS positions. Matching the bare token anywhere caught `id="ck-settings-scope-global-title"`
      // and its `aria-labelledby` partner — accessibility ids that follow the same naming convention and
      // are styled by nothing on purpose. The narrow read (App.tsx only) never saw them, so widening the
      // guard without narrowing WHERE it looks would have traded a silent miss for a false red, and a
      // guard that cries wolf gets edited until it stops crying.
      const used = new Set(classAttributeValues(jsx)
        .flatMap((value) => [...value.matchAll(/\b(?:ck|ci)-[a-z0-9-]+/g)].map((m) => m[0]))
        .map((name) => name.replace(/-$/, "")));
      for (const className of used) {
        if (!new RegExp(`\\.${className}(?![a-z0-9-])`).test(linkedCss)) {
          violations.push(`${app.view}: uses .${className}, but none of its linked stylesheets defines it`);
          continue;
        }
        // t-f78665 — presence is not reach. `.ck-settings-status .ck-badge` made the presence check
        // green while the device-list badge (outside that parent) rendered as plain text. Require an
        // unconditional subject rule: rightmost compound includes the class, no ancestor combinator.
        if (!cssDefinesUnconditionalClass(linkedCss, className)) {
          violations.push(`${app.view}: uses .${className}, but linked CSS only styles it under a required ancestor or as an ancestor of something else — add a subject rule (e.g. .${className} { … }), or stop using the class outside the scoped parent`);
        }
      }
    }
    // A section app with no source at all is not a pass — it is the condition that hid the misses above.
    expect(skipped, `section apps with no readable JSX source — this guard cannot see them: ${skipped.join(", ")}`).toEqual([]);
    expect(violations, violations.join("\n")).toEqual([]);
  });
});

/**
 * t-f78665 — the D6 presence guard is blind to "class only under a parent". Full CSS matching is not
 * free; this heuristic asks a cheaper, incomplete question: does any selector treat the class as a
 * subject without a required ancestor? Measured 2026-08-04 against every section-app × linked-sheet
 * pair (80 usages): one failure, the live `.ck-badge` bug. Zero false positives in that scope.
 *
 * Historical fixtures below are the red proof — they recreate the three named escapes before the
 * production tree is asserted green.
 */
describe("webview CSS unconditional class subject (t-f78665)", () => {
  it("FAILS the three historical escapes (red proof before the live tree is trusted green)", () => {
    // 1. ck-badge — only descendant subjects under .ck-settings-status (pre-fix settings.css)
    const badgeOnlyDescendant = `
      .ck-settings-status .ck-badge { padding: 1px 6px; }
      .ck-settings-status .ck-badge.ok { color: green; }
      .ck-settings-status .ck-badge.muted { color: gray; }
    `;
    expect(cssClassNameAppears(badgeOnlyDescendant, "ck-badge"), "presence alone would still pass for badge").toBe(true);
    expect(cssDefinesUnconditionalClass(badgeOnlyDescendant, "ck-badge"), "badge only as descendant subject").toBe(false);

    // 2. ck-panel — D10/D11 shape: class only as ancestor of a child rule (base lived elsewhere)
    const panelOnlyAsAncestor = `
      .ck-panel p { margin: 0 0 6px; }
    `;
    expect(cssClassNameAppears(panelOnlyAsAncestor, "ck-panel"), "presence alone would still pass for panel").toBe(true);
    expect(cssDefinesUnconditionalClass(panelOnlyAsAncestor, "ck-panel"), "panel only as ancestor qualifier").toBe(false);

    // 3. ck-mono — D6 shape: name never appears in the linked sheet at all
    const monoMissing = `
      .ck-card-list { display: flex; }
    `;
    expect(cssClassNameAppears(monoMissing, "ck-mono"), "mono absent from sheet").toBe(false);
    expect(cssDefinesUnconditionalClass(monoMissing, "ck-mono"), "mono has no subject rule").toBe(false);
  });

  it("PASSES when a bare or compound subject rule exists without an ancestor", () => {
    expect(cssDefinesUnconditionalClass(".ck-badge { padding: 1px 6px; }", "ck-badge")).toBe(true);
    expect(cssDefinesUnconditionalClass(".ck-badge.ok { color: green; }", "ck-badge")).toBe(true);
    expect(cssDefinesUnconditionalClass(".ck-panel { border: 1px solid; }\n.ck-panel p { margin: 0; }", "ck-panel")).toBe(true);
    expect(cssDefinesUnconditionalClass(".ck-mono { font-family: monospace; }", "ck-mono")).toBe(true);
  });
});

/**
 * The text of every `class` attribute in a JSX source — both `class="a b"` and `class={…}` forms, the
 * second taken whole so template literals and conditionals inside it still yield their class names.
 */
function classAttributeValues(jsx: string): string[] {
  return [
    ...[...jsx.matchAll(/\bclass="([^"]*)"/g)].map((m) => m[1]),
    ...[...jsx.matchAll(/\bclass=\{([^}]*)\}/g)].map((m) => m[1]),
  ];
}

/** Every component source that ships inside one app's bundle — its whole directory, not one hoped-for name. */
function appSourceFiles(view: string): string[] {
  const dir = `src/webview/${view}`;
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = `${d}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".tsx")) out.push(path);
    }
  };
  walk(dir);
  return out;
}

/** Does the class token appear as a CSS class selector somewhere in the sheet (the D6 presence check). */
function cssClassNameAppears(css: string, className: string): boolean {
  return new RegExp(`\\.${className}(?![a-z0-9-])`).test(css);
}

/**
 * Heuristic: some selector's rightmost compound includes `.className` and requires no ancestor
 * combinator. Not full cascade matching — deliberately incomplete and cheap. Strips functional
 * pseudos/attributes/simple pseudos before looking for combinators so `:hover` does not look like a
 * descendant. Does not expand `:is()`/`:where()` argument lists (none of our `ck-*` sheets use them
 * as the subject vehicle today).
 *
 * Uses brace-matching selector extraction rather than `cssRules`: that helper's flat regex drops
 * every other rule on real sheets (measured: settings+shared yielded 52 vs 102 selectors), which
 * would make this guard cry wolf on classes that do have bare subject rules.
 */
function cssDefinesUnconditionalClass(css: string, className: string): boolean {
  for (const selector of cssSelectorsBraceMatched(css)) {
    for (const part of selector.split(",")) {
      if (selectorPartIsUnconditionalSubject(part.trim(), className)) return true;
    }
  }
  return false;
}

function selectorPartIsUnconditionalSubject(sel: string, className: string): boolean {
  let s = sel;
  for (let i = 0; i < 6; i++) s = s.replace(/:[a-z-]+\((?:[^()]|\([^()]*\))*\)/gi, "");
  s = s.replace(/\[[^\]]*\]/g, "");
  s = s.replace(/::?[a-z-]+/gi, "");
  s = s.trim();
  if (!s || /[\s>+~]/.test(s)) return false;
  const classes = [...s.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((m) => m[1]);
  return classes.includes(className);
}

/** Every selector list entry in a stylesheet, including those nested under `@media`/`@supports`/`@layer`. */
function cssSelectorsBraceMatched(css: string): string[] {
  const out: string[] = [];
  const extract = (text: string): void => {
    let i = 0;
    while (i < text.length) {
      while (i < text.length && /\s/.test(text[i]!)) i++;
      if (i >= text.length) break;
      if (text.startsWith("@", i)) {
        const brace = text.indexOf("{", i);
        if (brace < 0) break;
        let depth = 1;
        let j = brace + 1;
        while (j < text.length && depth > 0) {
          if (text[j] === "{") depth++;
          else if (text[j] === "}") depth--;
          j++;
        }
        const atName = text.slice(i, brace).trim();
        if (/^@(media|supports|layer)\b/i.test(atName)) extract(text.slice(brace + 1, j - 1));
        i = j;
        continue;
      }
      const brace = text.indexOf("{", i);
      if (brace < 0) break;
      let depth = 1;
      let j = brace + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
        j++;
      }
      const selectorList = text.slice(i, brace).trim();
      if (selectorList && !selectorList.startsWith("@")) {
        for (const sel of selectorList.split(",")) out.push(sel.trim());
      }
      i = j;
    }
  };
  extract(stripCssComments(css));
  return out;
}
