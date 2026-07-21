import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { WEBVIEW_SURFACES } from "../../src/webview/surfaces.js";

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
      expect(esbuild.includes(`dist/webview/${s.view}.js`), `${s.viewId}: no esbuild entrypoint for dist/webview/${s.view}.js`).toBe(true);
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
    const offenders = readdirSync("src/webview")
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /<!DOCTYPE/i.test(readFileSync(`src/webview/${f}`, "utf8")));
    expect(offenders, `host files hand-rolling <!DOCTYPE> (use renderWebviewShell): ${offenders.join(", ")}`).toEqual([]);
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
      tachyonServerInspector: "SERVER_INSPECTOR_VIEW_TYPE",
      tachyonCockpit: "COCKPIT_VIEW_TYPE",
      tachyonPinPreview: "PIN_PREVIEW_VIEW_TYPE",
      tachyonMissionControl: "MISSION_CONTROL_VIEW_TYPE",
      tachyonTaskDetail: "TASK_DETAIL_VIEW_TYPE",
      tachyonTaskStudio: "TASK_STUDIO_VIEW_TYPE",
      tachyonApprovals: "APPROVAL_VIEW_TYPE",
      tachyonPipelineStudio: "PIPELINE_STUDIO_VIEW_TYPE",
      tachyonAgentStudioShell: "AGENT_STUDIO_SHELL_VIEW_TYPE",
      tachyonTerminalStudioShell: "TERMINAL_STUDIO_SHELL_VIEW_TYPE",
      tachyonCommandStudioShell: "COMMAND_STUDIO_SHELL_VIEW_TYPE",
      tachyonRunbookStudioShell: "RUNBOOK_STUDIO_SHELL_VIEW_TYPE",
      tachyonScheduleStudioShell: "SCHEDULE_STUDIO_SHELL_VIEW_TYPE",
    };
    const disposeOnly = new Set(["tachyonAgentFixtureStudio", "tachyonControlInspector", "tachyonPluginSurface", "tachyonPluginSurfaces"]);
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
