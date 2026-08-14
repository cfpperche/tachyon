import { describe, expect, it } from "vitest";
import { buildDesignModeInjectExpression, themeDesignModeOverlayBundle } from "../../apps/vscode-extension/src/webview/ide-browser-bridge/designModeInject.js";
import { fallbackDsTokens, formatDmThemeCssBlock, mapVscodeVarsToDs } from "../../apps/vscode-extension/src/webview/ide-browser-bridge/themeTokens.js";

describe("buildDesignModeInjectExpression — compiled page app boundary", () => {
  it("ratchets the page expression to a thin wrapper", () => {
    const bundle = themeDesignModeOverlayBundle('const theme="__TACHYON_DM_THEME_CSS__";window.__tachyonDmOverlay={mount:(options)=>options}', fallbackDsTokens());
    const expression = buildDesignModeInjectExpression(bundle, { bindingName: "binding", restorePickMode: false });
    expect(expression.length - bundle.length).toBeLessThan(400);
  });

  it("executes the artifact and passes typed install configuration", () => {
    const expression = buildDesignModeInjectExpression(
      "window.__tachyonDmOverlay={mount:(options)=>options}",
      { bindingName: "binding'with-quote", restorePickMode: false },
    );
    const window = { __tachyonDmCleanup: () => undefined } as unknown as Window;
    const result = Function("window", `return ${expression}`)(window) as Record<string, unknown>;
    expect(result).toEqual({ bindingName: "binding'with-quote", restorePickMode: false });
  });

  it("builds the bundle's single shadow stylesheet from all resolved tokens", () => {
    const themed = themeDesignModeOverlayBundle('const theme="__TACHYON_DM_THEME_CSS__"', mapVscodeVarsToDs({ "--vscode-focusBorder": "#123456" }));
    expect(themed).toContain("--ds-focus: #123456");
    expect(themed).not.toContain("__TACHYON_DM_THEME_CSS__");
  });
});

describe("theme token mapping", () => {
  it("maps vscode vars through the CSS-authored token definitions", () => { const ds=mapVscodeVarsToDs({"--vscode-foreground":"#abc","--vscode-button-background":"#0e639c","--vscode-editor-background":"#111"}); expect(ds["--ds-fg"]).toBe("#abc"); expect(ds["--ds-btn-bg"]).toBe("#0e639c"); expect(ds["--ds-editor-bg"]).toBe("#111"); });
  it("keeps a white input from becoming raised chrome on a dark glass shell", () => {
    const ds = mapVscodeVarsToDs({
      "--vscode-editor-background": "#202124",
      "--vscode-input-background": "#ffffff",
      "--vscode-sideBar-background": "#2b2c30",
    });
    expect(ds["--ds-surface-raised"]).toBe("#2b2c30");
  });
  it("classifies an rgb() editor background as light", () => {
    const ds = mapVscodeVarsToDs({ "--vscode-editor-background": "rgb(250, 250, 250)" });
    expect(ds["--ds-color-scheme"]).toBe("light");
  });
  it("formats a CSS block for remaining consumers", () => { const block=formatDmThemeCssBlock(fallbackDsTokens(),"#x"); expect(block).toMatch(/^#x \{/); expect(block).toContain("--ds-fg:"); });
});
