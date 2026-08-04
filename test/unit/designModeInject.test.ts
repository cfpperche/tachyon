import { describe, expect, it } from "vitest";
import { buildDesignModeInjectExpression } from "../../src/webview/ide-browser-bridge/designModeInject.js";
import {
  fallbackDsTokens,
  formatDmThemeCssBlock,
  mapVscodeVarsToDs,
} from "../../src/webview/ide-browser-bridge/themeTokens.js";

describe("buildDesignModeInjectExpression", () => {
  const themeVars = mapVscodeVarsToDs({
    "--vscode-foreground": "#cccccc",
    "--vscode-descriptionForeground": "#9d9d9d",
    "--vscode-editor-background": "#1e1e1e",
    "--vscode-sideBar-background": "#252526",
    "--vscode-button-background": "#0e639c",
    "--vscode-button-foreground": "#ffffff",
    "--vscode-input-background": "#3c3c3c",
    "--vscode-focusBorder": "#007fd4",
    "--vscode-panel-border": "rgba(128,128,128,0.4)",
  });
  const src = buildDesignModeInjectExpression({
    bindingName: "tachyonDesignModePick",
    themeVars,
    panelWidth: 340,
  });

  it("embeds the binding name", () => {
    expect(src).toContain("tachyonDesignModePick");
  });

  it("status-bar enable opens both panels when restorePanelOpen is true", () => {
    const withOpen = buildDesignModeInjectExpression({
      bindingName: "tachyonDesignModePick",
      themeVars,
      restorePanelOpen: true,
    });
    expect(withOpen).toContain("const RESTORE_PANEL = true");
    expect(withOpen).toMatch(/if \(RESTORE_PANEL\)/);
  });

  it("default install leaves panel closed unless restore", () => {
    expect(src).toContain("const RESTORE_PANEL = false");
    expect(src).toMatch(/\/\/ Do NOT open the panel on install/);
  });

  it("has no Exit Design Mode control (status bar only)", () => {
    expect(src).not.toMatch(/Exit Design Mode/i);
    expect(src).not.toContain("tachyon-dm-off");
  });

  it("uses two framed cards + resizable sash (live DOM viewport, not iframe)", () => {
    expect(src).toContain("tachyon-dm-shell");
    expect(src).toContain("tachyon-dm-site-card");
    expect(src).toContain("tachyon-dm-sep");
    expect(src).toContain("tachyon-dm-card");
    expect(src).toContain("tachyon-dm-viewport");
    // Must NOT reload the page in an iframe (X-Frame-Options blanks many sites).
    expect(src).not.toContain("createElement('iframe')");
    expect(src).not.toMatch(/\.src\s*=\s*location\.href/);
    // MDN/CSS transforms: fixed descendants use this as containing block.
    expect(src).toMatch(/transform:\s*translateZ\(0\)/);
    expect(src).toContain("--ds-separator");
    expect(src).toContain("col-resize");
    expect(src).toContain("bindSash");
    expect(src).toContain("--ds-sash-hover");
  });

  it("has picker on/off toggle for link clicks", () => {
    expect(src).toContain("tachyon-dm-pick-toggle");
    expect(src).toContain("setPickMode");
    expect(src).toContain("Picker on");
    expect(src).toContain("Picker off");
    expect(src).toContain("if (!pickMode) return");
  });

  it("embeds host-resolved theme token values", () => {
    expect(src).toContain("--ds-btn-bg: #0e639c");
    expect(src).toContain("--ds-sidebar-bg: #252526");
    expect(src).toContain("--ds-radius: 6px");
    expect(src).not.toContain("@media (prefers-color-scheme");
  });

  it("posts layout open/close for host to survive URL changes", () => {
    expect(src).toContain("__layout");
    expect(src).toContain("'open'");
    expect(src).toContain("'close'");
  });

  it("Esc only clears pick / closes panel (no __cancel exit)", () => {
    const keySection = src.slice(src.indexOf("const onKey"), src.indexOf("const cleanup"));
    expect(keySection).not.toContain("__cancel");
    expect(keySection).toContain("clearPick");
    expect(keySection).toContain("closePanel");
  });
});

describe("theme token mapping", () => {
  it("maps vscode vars to ds tokens including separator and sash", () => {
    const ds = mapVscodeVarsToDs({
      "--vscode-foreground": "#abc",
      "--vscode-button-background": "#0e639c",
      "--vscode-sideBar-background": "#111",
      "--vscode-panel-border": "rgba(1,2,3,0.5)",
      "--vscode-sash-hoverBorder": "#00aaff",
      "--vscode-focusBorder": "#007fd4",
    });
    expect(ds["--ds-fg"]).toBe("#abc");
    expect(ds["--ds-btn-bg"]).toBe("#0e639c");
    expect(ds["--ds-sidebar-bg"]).toBe("#111");
    expect(ds["--ds-separator"]).toBe("rgba(1,2,3,0.5)");
    expect(ds["--ds-sash-hover"]).toBe("#00aaff");
  });

  it("formats a CSS block for injection", () => {
    const block = formatDmThemeCssBlock(fallbackDsTokens(), "#x");
    expect(block).toMatch(/^#x \{/);
    expect(block).toContain("--ds-fg:");
    expect(block).toContain("--ds-separator:");
  });
});
