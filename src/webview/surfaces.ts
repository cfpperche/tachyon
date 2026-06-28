/**
 * spec 279 — the canonical manifest of EVERY Tachyon webview surface. One convention, declared in one place:
 * the convention guard (`scripts/check-webview-convention.sh`) reads it, the spec-278 preview harness/catalog
 * spans it, and `converted` tracks the inline→preact migration (flipped per lane; all true = the split is gone).
 *
 * Pure data (no vscode, no DOM) so it's unit-testable and importable anywhere.
 */

/** runtime contract: `live` = ready handshake + host message listener + actions; `static` = render-once. */
export type WebviewMode = "live" | "static";

export interface WebviewSurface {
  /** the createWebviewPanel id / WebviewView viewType. */
  viewId: string;
  /** the bundle/dir name: `src/webview/<view>/main.tsx` → `dist/webview/<view>.js`. */
  view: string;
  /** the vscode-bound host file that creates the panel. */
  hostFile: string;
  mode: WebviewMode;
  /** false ⇒ still an inline-HTML panel (guard-allowlisted until its lane lands); true ⇒ a preact bundle. */
  converted: boolean;
}

export const WEBVIEW_SURFACES: WebviewSurface[] = [
  // already preact (the 5 that established the convention)
  { viewId: "tachyonSidebar", view: "sidebar", hostFile: "src/webview/SidebarPrototype.ts", mode: "live", converted: true },
  { viewId: "tachyonActivity", view: "activity", hostFile: "src/webview/ActivityPanel.ts", mode: "live", converted: true },
  { viewId: "tachyonHandoff", view: "handoff", hostFile: "src/webview/HandoffPanel.ts", mode: "live", converted: true },
  { viewId: "tachyonPlugins", view: "plugins", hostFile: "src/webview/PluginsPanel.ts", mode: "live", converted: true },
  { viewId: "tachyonPinStudio", view: "pin-studio", hostFile: "src/webview/PinStudioPanel.ts", mode: "live", converted: true },
  // spec 279 conversions (flip `converted` as each lane lands)
  // probes re-pushes its model on refresh, so it's a `live` read-only surface (a listener, no inbound actions).
  { viewId: "tachyonProbes", view: "probes", hostFile: "src/webview/ProbeResultPanel.ts", mode: "live", converted: true },
  { viewId: "tachyonServerInspector", view: "inspector", hostFile: "src/webview/ServerInspector.ts", mode: "live", converted: true },
  { viewId: "tachyonAgentStudio", view: "agent-studio", hostFile: "src/webview/AgentForm.ts", mode: "live", converted: true },
  // pin-preview is hosted in SidebarPrototype.previewPin but renders via its own preact bundle (spec 279 Lane E).
  { viewId: "tachyonPinPreview", view: "pin-preview", hostFile: "src/webview/SidebarPrototype.ts", mode: "static", converted: true },
];

/** surfaces still carrying inline-HTML app logic (acquireVsCodeApi / inline <script>) the guard allowlists. */
export function unconvertedInteractive(): WebviewSurface[] {
  return WEBVIEW_SURFACES.filter((s) => !s.converted && s.mode === "live");
}
