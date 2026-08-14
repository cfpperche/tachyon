import * as fs from "node:fs";
import * as path from "node:path";
import { formatDmThemeCssBlock, type DmThemeCssVars } from "./themeTokens.js";

export type DesignModeInjectOptions = { bindingName: string; restorePickMode?: boolean };

const THEME_CSS_PLACEHOLDER = "__TACHYON_DM_THEME_CSS__";

export function loadDesignModeOverlayBundle(extensionRoot: string): string {
  return fs.readFileSync(path.join(extensionRoot, "dist", "webview", "design-mode-overlay.js"), "utf8");
}

export function themeDesignModeOverlayBundle(bundle: string, themeVars: DmThemeCssVars): string {
  const marker = JSON.stringify(THEME_CSS_PLACEHOLDER);
  if (!bundle.includes(marker)) throw new Error("Design Mode bundle has no theme CSS placeholder");
  return bundle.replace(marker, JSON.stringify(formatDmThemeCssBlock(themeVars, ":host")));
}

export function buildDesignModeInjectExpression(bundle: string, options: DesignModeInjectOptions): string {
  const mountOptions = JSON.stringify({ bindingName: options.bindingName, restorePickMode: options.restorePickMode !== false });
  return `(() => { if(window.__tachyonDmCleanup)try{window.__tachyonDmCleanup()}catch{};${bundle};return window.__tachyonDmOverlay.mount(${mountOptions});})()`;
}
