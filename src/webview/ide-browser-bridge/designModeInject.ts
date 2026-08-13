import * as fs from "node:fs";
import * as path from "node:path";
import type { DmThemeCssVars } from "./themeTokens.js";

export type DesignModeInjectOptions = { bindingName: string; themeVars?: DmThemeCssVars; restorePickMode?: boolean };

export function loadDesignModeOverlayBundle(extensionRoot: string): string {
  return fs.readFileSync(path.join(extensionRoot, "dist", "webview", "design-mode-overlay.js"), "utf8");
}

export function buildDesignModeInjectExpression(bundle: string, options: DesignModeInjectOptions): string {
  const focusColor = options.themeVars?.["--ds-focus"] ?? "#007fd4";
  const mountOptions = JSON.stringify({ bindingName: options.bindingName, focusColor, restorePickMode: options.restorePickMode !== false });
  return `(() => { if(window.__tachyonDmCleanup)try{window.__tachyonDmCleanup()}catch{};${bundle};return window.__tachyonDmOverlay.mount(${mountOptions});})()`;
}
