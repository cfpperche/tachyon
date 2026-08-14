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

// BEGIN GENERATED TOKEN DEFINITIONS — do not edit; run npm run generate:theme-tokens
export const TOKEN_DEFINITIONS = {
  "--ds-fg": "var(--vscode-foreground)",
  "--ds-muted": "var(--vscode-descriptionForeground)",
  "--ds-border": "var(--vscode-widget-border, var(--vscode-editorWidget-border, color-mix(in srgb, var(--vscode-foreground) 22%, transparent)))",
  "--ds-focus": "var(--vscode-focusBorder)",
  "--ds-ok": "var(--vscode-charts-green, var(--vscode-testing-iconPassed, var(--vscode-terminal-ansiGreen)))",
  "--ds-warn": "var(--vscode-charts-yellow, var(--vscode-list-warningForeground, var(--vscode-terminal-ansiYellow)))",
  "--ds-err": "var(--vscode-errorForeground, var(--vscode-list-errorForeground, var(--vscode-terminal-ansiRed)))",
  "--ds-hover": "var(--vscode-toolbar-hoverBackground, color-mix(in srgb, var(--vscode-foreground) 12%, transparent))",
  "--ds-disabled-opacity": "0.5",
  "--ds-scrim": "color-mix(in srgb, var(--vscode-editor-background) 55%, #000 45%)",
  "--ds-link": "var(--vscode-textLink-foreground)",
  "--ds-info": "var(--vscode-charts-blue, var(--vscode-textLink-foreground))",
  "--ds-card": "var(--vscode-editorWidget-background, color-mix(in srgb, var(--vscode-foreground) 6%, transparent))",
  "--ds-input-bg": "var(--vscode-input-background)",
  "--ds-input-fg": "var(--vscode-input-foreground)",
  "--ds-dropdown-bg": "var(--vscode-dropdown-background, var(--vscode-input-background))",
  "--ds-dropdown-fg": "var(--vscode-dropdown-foreground, var(--vscode-input-foreground))",
  "--ds-btn-bg": "var(--vscode-button-background)",
  "--ds-btn-fg": "var(--vscode-button-foreground)",
  "--ds-btn-hover": "var(--vscode-button-hoverBackground, var(--vscode-button-background))",
  "--ds-accent": "var(--vscode-button-background, var(--vscode-focusBorder, var(--vscode-textLink-foreground)))",
  "--ds-shadow-1": "0 1px 2px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.18))",
  "--ds-shadow-2": "0 10px 24px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.18))",
  "--ds-duration-1": "120ms",
  "--ds-duration-2": "200ms",
  "--ds-ease": "cubic-bezier(0.2, 0, 0, 1)",
  "--ds-z-popover": "20",
  "--ds-z-dialog": "40",
  "--ds-z-toast": "50",
  "--tachyon-font-mono": "\"Tachyon Mono\", ui-monospace, \"SFMono-Regular\", Consolas, \"Liberation Mono\", monospace",
  "--tachyon-font-reading": "var(--vscode-font-family, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif)",
  "--tachyon-weight-regular": "400",
  "--tachyon-weight-medium": "500",
  "--tachyon-weight-semibold": "600",
  "--tachyon-weight-bold": "700",
  "--tachyon-tracking-label": ".06em",
  "--ds-mono": "var(--tachyon-font-mono)",
  "--ds-title": "16px",
  "--ds-section": "11px",
  "--ds-body": "var(--vscode-font-size, 13px)",
  "--ds-small": "12px",
  "--ds-micro": "11px",
  "--ds-1": "4px",
  "--ds-2": "8px",
  "--ds-3": "12px",
  "--ds-4": "16px",
  "--ds-5": "24px",
  "--ds-6": "32px",
  "--ds-page-pad-x": "var(--ds-4)",
  "--ds-page-pad-y": "var(--ds-3)",
  "--ds-page-pad-bottom": "var(--ds-5)",
  "--ds-page-chrome-gap": "var(--ds-3)",
  "--ds-page-chrome-margin-bottom": "var(--ds-4)",
  "--ds-page-chrome-actions-gap": "var(--ds-2)",
  "--ds-border-width": "1px",
  "--ds-radius": "6px",
  "--ds-icon-gap": "6px",
  "--ds-control-pad-y": "var(--ds-2)",
  "--ds-control-pad-x": "var(--ds-3)",
  "--ds-control-line": "calc(4 / 3)",
  "--ds-control-h": "34px"
} as const;
// END GENERATED TOKEN DEFINITIONS

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

function resolveCssVars(value: string, values: Record<string, string>): string {
  let out = value;
  for (let guard = 0; guard < 30; guard += 1) {
    const start = out.lastIndexOf("var(");
    if (start < 0) return out;
    const close = out.indexOf(")", start);
    if (close < 0) return out;
    const [name, ...fallbackParts] = out.slice(start + 4, close).split(",");
    const replacement = values[name!.trim()]?.trim() || fallbackParts.join(",").trim();
    out = out.slice(0, start) + replacement + out.slice(close + 1);
  }
  throw new Error(`theme token reference cycle: ${value}`);
}

/** Resolve the generated CSS declarations against sampled VS Code custom properties. */
export function mapVscodeVarsToDs(v: Record<string, string>): DmThemeCssVars {
  const resolved: DmThemeCssVars = {};
  for (const [name, value] of Object.entries(TOKEN_DEFINITIONS)) {
    resolved[name] = resolveCssVars(value, { ...v, ...resolved });
  }
  const read = (...names: string[]): string => names.map((name) => v[name]?.trim()).find(Boolean) ?? "";
  const editorBg = read("--vscode-editor-background");
  const inputBg = read("--vscode-input-background");
  const hex = editorBg.replace("#", "");
  const channels = /^[\da-f]{6}$/i.test(hex)
    ? [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
    : /rgb\s*\(/i.test(editorBg) ? editorBg.match(/\d+/g)?.slice(0, 3).map(Number) : undefined;
  const light = !!channels && (0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!) / 255 > 0.55;
  // Input can be pure white inside dark-tinted glass themes; keep raised chrome on the shell surface.
  const surfaceRaised = inputBg && inputBg !== "#ffffff" && inputBg !== "#fff"
    ? inputBg
    : read("--vscode-sideBar-background", "--vscode-editorWidget-background") || editorBg;
  return {
    ...resolved,
    // Design Mode overlay-only roles. Q4 keeps these out of the shared product token sheet.
    "--ds-separator": read("--vscode-panel-border", "--vscode-widget-border") || resolved["--ds-border"]!,
    "--ds-surface-raised": surfaceRaised,
    "--ds-editor-bg": editorBg,
    "--ds-font-ui": read("--vscode-font-family") || "system-ui, sans-serif",
    "--ds-color-scheme": light ? "light" : "dark",
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
