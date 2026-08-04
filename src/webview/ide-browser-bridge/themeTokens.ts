/**
 * Resolve Tachyon design-system tokens from the active VS Code theme.
 *
 * Integrated Browser pages are third-party (no --vscode-* vars). Webviews get
 * those vars from VS Code automatically; we sample the same vars via a short-lived
 * probe webview and map them to --ds-* exactly like design-system.css.
 *
 * Strategy (no flash on Design Mode toggle):
 * 1. Seed immediately from ColorThemeKind (Dark+/Light+ fallbacks)
 * 2. Warm in background on activate / theme change (probe upgrades cache)
 * 3. Design Mode inject always reads cache (sync) — never blocks on a panel
 */

import * as vscode from "vscode";

/** Final CSS custom properties to inject into the Design Mode chrome. */
export type DmThemeCssVars = Record<string, string>;

const VS_PROBE_VARS = [
  "--vscode-foreground",
  "--vscode-descriptionForeground",
  "--vscode-editor-background",
  "--vscode-sideBar-background",
  "--vscode-editorWidget-background",
  "--vscode-editorWidget-border",
  "--vscode-widget-border",
  "--vscode-panel-border",
  "--vscode-sash-hoverBorder",
  "--vscode-focusBorder",
  "--vscode-textLink-foreground",
  "--vscode-button-background",
  "--vscode-button-foreground",
  "--vscode-button-hoverBackground",
  "--vscode-input-background",
  "--vscode-input-foreground",
  "--vscode-input-border",
  "--vscode-toolbar-hoverBackground",
  "--vscode-errorForeground",
  "--vscode-charts-green",
  "--vscode-charts-yellow",
  "--vscode-charts-blue",
  "--vscode-testing-iconPassed",
  "--vscode-list-warningForeground",
  "--vscode-list-errorForeground",
  "--vscode-terminal-ansiGreen",
  "--vscode-terminal-ansiYellow",
  "--vscode-terminal-ansiRed",
  "--vscode-widget-shadow",
  "--vscode-font-size",
  "--vscode-font-family",
] as const;

let cached: { key: string; vars: DmThemeCssVars; probed: boolean } | null = null;
let inflight: Promise<DmThemeCssVars> | null = null;

function themeCacheKey(): string {
  // ColorTheme only exposes kind publicly (1 Light / 2 Dark / 3 HC / 4 HC Light).
  return String(vscode.window.activeColorTheme?.kind ?? 2);
}

function pick(v: Record<string, string>, keys: string[], fallback: string): string {
  for (const k of keys) {
    const val = v[k]?.trim();
    if (val) return val;
  }
  return fallback;
}

/** Map probed --vscode-* values → --ds-* (mirrors design-system.css). */
export function mapVscodeVarsToDs(v: Record<string, string>): DmThemeCssVars {
  const fg = pick(v, ["--vscode-foreground"], "#cccccc");
  const muted = pick(v, ["--vscode-descriptionForeground"], "#9d9d9d");
  const editorBg = pick(v, ["--vscode-editor-background"], "#1e1e1e");
  const sideBg = pick(v, ["--vscode-sideBar-background", "--vscode-editor-background"], "#252526");
  const card = pick(v, ["--vscode-editorWidget-background", "--vscode-sideBar-background"], sideBg);
  const border = pick(
    v,
    ["--vscode-widget-border", "--vscode-editorWidget-border", "--vscode-panel-border"],
    "rgba(128,128,128,0.35)",
  );
  const separator = pick(
    v,
    ["--vscode-panel-border", "--vscode-widget-border"],
    border,
  );
  const focus = pick(v, ["--vscode-focusBorder"], "#007fd4");
  const sashHover = pick(
    v,
    ["--vscode-sash-hoverBorder", "--vscode-focusBorder"],
    focus,
  );
  const link = pick(v, ["--vscode-textLink-foreground"], focus);
  const btnBg = pick(v, ["--vscode-button-background"], "#0e639c");
  const btnFg = pick(v, ["--vscode-button-foreground"], "#ffffff");
  const btnHover = pick(v, ["--vscode-button-hoverBackground", "--vscode-button-background"], btnBg);
  const inputBg = pick(v, ["--vscode-input-background"], "#3c3c3c");
  const inputFg = pick(v, ["--vscode-input-foreground", "--vscode-foreground"], fg);
  const hover = pick(v, ["--vscode-toolbar-hoverBackground"], "rgba(128,128,128,0.15)");
  const ok = pick(v, ["--vscode-charts-green", "--vscode-testing-iconPassed", "--vscode-terminal-ansiGreen"], "#89d185");
  const warn = pick(v, ["--vscode-charts-yellow", "--vscode-list-warningForeground", "--vscode-terminal-ansiYellow"], "#cca700");
  const err = pick(v, ["--vscode-errorForeground", "--vscode-list-errorForeground", "--vscode-terminal-ansiRed"], "#f14c4c");
  const info = pick(v, ["--vscode-charts-blue", "--vscode-textLink-foreground"], link);
  const shadow = pick(v, ["--vscode-widget-shadow"], "rgba(0,0,0,0.36)");
  const fontSize = pick(v, ["--vscode-font-size"], "13px");
  const fontFamily = pick(v, ["--vscode-font-family"], "system-ui, sans-serif");

  return {
    "--ds-fg": fg,
    "--ds-muted": muted,
    "--ds-border": border,
    "--ds-separator": separator,
    "--ds-sash-hover": sashHover,
    "--ds-focus": focus,
    "--ds-link": link,
    "--ds-ok": ok,
    "--ds-warn": warn,
    "--ds-err": err,
    "--ds-info": info,
    "--ds-card": card,
    "--ds-input-bg": inputBg,
    "--ds-input-fg": inputFg,
    "--ds-btn-bg": btnBg,
    "--ds-btn-fg": btnFg,
    "--ds-btn-hover": btnHover,
    "--ds-hover": hover,
    "--ds-accent": btnBg,
    "--ds-editor-bg": editorBg,
    "--ds-sidebar-bg": sideBg,
    "--ds-disabled-opacity": "0.5",
    "--ds-shadow-1": `0 1px 2px ${shadow}`,
    "--ds-shadow-2": `0 10px 24px ${shadow}`,
    "--ds-radius": "6px",
    "--ds-border-width": "1px",
    "--ds-1": "4px",
    "--ds-2": "8px",
    "--ds-3": "12px",
    "--ds-4": "16px",
    "--ds-5": "24px",
    "--ds-title": "16px",
    "--ds-section": "11px",
    "--ds-body": fontSize,
    "--ds-small": "12px",
    "--ds-micro": "11px",
    "--ds-mono": `"Tachyon Mono", ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace`,
    "--ds-font-ui": fontFamily,
    "--ds-icon-gap": "6px",
    "--ds-control-pad-y": "8px",
    "--ds-control-pad-x": "12px",
    "--tachyon-weight-semibold": "600",
    "--tachyon-tracking-label": ".06em",
  };
}

/** Dark+/Light+ fallbacks when probe fails (still respects theme kind). */
export function fallbackDsTokens(kind?: number): DmThemeCssVars {
  // ColorThemeKind: Light=1, Dark=2, HighContrast=3, HighContrastLight=4
  const light = kind === 1 || kind === 4;
  if (light) {
    return mapVscodeVarsToDs({
      "--vscode-foreground": "#3b3b3b",
      "--vscode-descriptionForeground": "#6c6c6c",
      "--vscode-editor-background": "#ffffff",
      "--vscode-sideBar-background": "#f3f3f3",
      "--vscode-editorWidget-background": "#f3f3f3",
      "--vscode-widget-border": "rgba(0,0,0,0.12)",
      "--vscode-panel-border": "rgba(0,0,0,0.1)",
      "--vscode-focusBorder": "#0090f1",
      "--vscode-textLink-foreground": "#006ab1",
      "--vscode-button-background": "#0078d4",
      "--vscode-button-foreground": "#ffffff",
      "--vscode-button-hoverBackground": "#026ec1",
      "--vscode-input-background": "#ffffff",
      "--vscode-input-foreground": "#3b3b3b",
      "--vscode-toolbar-hoverBackground": "rgba(184,184,184,0.31)",
      "--vscode-charts-green": "#388a34",
      "--vscode-charts-yellow": "#bf8803",
      "--vscode-charts-blue": "#1a85ff",
      "--vscode-errorForeground": "#a1260d",
      "--vscode-font-size": "13px",
      "--vscode-font-family": "system-ui, sans-serif",
    });
  }
  return mapVscodeVarsToDs({
    "--vscode-foreground": "#cccccc",
    "--vscode-descriptionForeground": "#9d9d9d",
    "--vscode-editor-background": "#1e1e1e",
    "--vscode-sideBar-background": "#252526",
    "--vscode-editorWidget-background": "#252526",
    "--vscode-widget-border": "rgba(128,128,128,0.35)",
    "--vscode-panel-border": "rgba(128,128,128,0.35)",
    "--vscode-focusBorder": "#007fd4",
    "--vscode-textLink-foreground": "#3794ff",
    "--vscode-button-background": "#0e639c",
    "--vscode-button-foreground": "#ffffff",
    "--vscode-button-hoverBackground": "#1177bb",
    "--vscode-input-background": "#3c3c3c",
    "--vscode-input-foreground": "#cccccc",
    "--vscode-toolbar-hoverBackground": "rgba(90,93,94,0.31)",
    "--vscode-charts-green": "#89d185",
    "--vscode-charts-yellow": "#cca700",
    "--vscode-charts-blue": "#75beff",
    "--vscode-errorForeground": "#f14c4c",
    "--vscode-font-size": "13px",
    "--vscode-font-family": "system-ui, sans-serif",
  });
}

/** Sync read for inject — never opens a webview. */
export function getCachedDmThemeTokens(): DmThemeCssVars {
  if (cached && cached.key === themeCacheKey()) return cached.vars;
  return seedDmThemeTokensFromKind();
}

/** Immediate seed from theme kind (no UI). Safe on activate. */
export function seedDmThemeTokensFromKind(): DmThemeCssVars {
  const key = themeCacheKey();
  const vars = fallbackDsTokens(vscode.window.activeColorTheme?.kind);
  // Don't overwrite a successful probe for the same theme.
  if (cached?.key === key && cached.probed) return cached.vars;
  cached = { key, vars, probed: false };
  return vars;
}

/**
 * Background warm: upgrade seed → live VS Code colors.
 * Call on activate and on theme change; never await from Design Mode toggle.
 */
export function warmDmThemeTokensInBackground(log?: (m: string) => void): void {
  seedDmThemeTokensFromKind();
  void resolveDmThemeTokens()
    .then(() => log?.("[theme] Design Mode tokens warmed from VS Code theme"))
    .catch((err) => log?.(`[theme] warm failed (using seed): ${err}`));
}

/**
 * Sample live --vscode-* from a probe webview (same source as Tachyon panels).
 * Prefer warmDmThemeTokensInBackground + getCachedDmThemeTokens for UI paths.
 */
export async function resolveDmThemeTokens(): Promise<DmThemeCssVars> {
  const key = themeCacheKey();
  if (cached?.key === key && cached.probed) return cached.vars;
  if (inflight) return inflight;

  // Ensure seed exists while probe runs.
  if (!cached || cached.key !== key) seedDmThemeTokensFromKind();

  inflight = (async () => {
    try {
      const raw = await probeVscodeCssVars();
      const vars = mapVscodeVarsToDs(raw);
      cached = { key, vars, probed: true };
      return vars;
    } catch {
      const vars = fallbackDsTokens(vscode.window.activeColorTheme?.kind);
      cached = { key, vars, probed: false };
      return vars;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

export function invalidateDmThemeTokenCache(): void {
  cached = null;
}

/**
 * Probe webview — may flash a tab briefly. Only used from background warm,
 * never from the Design Mode click path.
 */
function probeVscodeCssVars(): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    // preserveFocus + dispose ASAP; seeded tokens already cover Design Mode.
    const panel = vscode.window.createWebviewPanel(
      "tachyon.ideBrowserThemeProbe",
      "",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
      { enableScripts: true },
    );

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("theme probe timed out"));
    }, 2500);

    const sub = panel.webview.onDidReceiveMessage((msg: unknown) => {
      if (!msg || typeof msg !== "object") return;
      const m = msg as { type?: string; vars?: Record<string, string> };
      if (m.type !== "theme" || !m.vars) return;
      cleanup();
      resolve(m.vars);
    });

    const cleanup = (): void => {
      clearTimeout(timer);
      sub.dispose();
      try {
        panel.dispose();
      } catch {
        /* ignore */
      }
    };

    const varList = JSON.stringify([...VS_PROBE_VARS]);
    panel.webview.html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><style>html,body{margin:0;padding:0;width:1px;height:1px;overflow:hidden;background:var(--vscode-editor-background);}</style></head>
<body>
<script>
(function () {
  const keys = ${varList};
  const style = getComputedStyle(document.documentElement);
  const vars = {};
  for (const k of keys) {
    vars[k] = style.getPropertyValue(k).trim();
  }
  const api = acquireVsCodeApi();
  api.postMessage({ type: "theme", vars });
})();
</script>
</body>
</html>`;
  });
}

/** CSS custom-property block for injection into page chrome. */
export function formatDmThemeCssBlock(vars: DmThemeCssVars, selectors: string): string {
  const lines = Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  return `${selectors} {\n${lines}\n}`;
}
