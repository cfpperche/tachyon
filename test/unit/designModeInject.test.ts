import { describe, expect, it } from "vitest";
import { buildDesignModeInjectExpression } from "../../src/webview/ide-browser-bridge/designModeInject.js";
import { fallbackDsTokens, formatDmThemeCssBlock, mapVscodeVarsToDs } from "../../src/webview/ide-browser-bridge/themeTokens.js";

describe("buildDesignModeInjectExpression — compiled page app boundary", () => {
  it("ratchets the page expression to a thin wrapper", () => {
    const bundle = "window.__tachyonDmOverlay={mount:(options)=>options}";
    const expression = buildDesignModeInjectExpression(bundle, { bindingName: "binding", themeVars: fallbackDsTokens(), restorePickMode: false });
    expect(expression.length - bundle.length).toBeLessThan(400);
  });

  it("executes the artifact and passes typed install configuration", () => {
    const expression = buildDesignModeInjectExpression(
      "window.__tachyonDmOverlay={mount:(options)=>options}",
      { bindingName: "binding'with-quote", themeVars: mapVscodeVarsToDs({ "--vscode-focusBorder": "#123456" }), restorePickMode: false },
    );
    const window = { __tachyonDmCleanup: () => undefined } as unknown as Window;
    const result = Function("window", `return ${expression}`)(window) as Record<string, unknown>;
    expect(result).toEqual({ bindingName: "binding'with-quote", focusColor: "#123456", restorePickMode: false });
  });
});

describe("theme token mapping", () => {
  it("maps vscode vars to ds tokens", () => { const ds=mapVscodeVarsToDs({"--vscode-foreground":"#abc","--vscode-button-background":"#0e639c","--vscode-sideBar-background":"#111"}); expect(ds["--ds-fg"]).toBe("#abc"); expect(ds["--ds-btn-bg"]).toBe("#0e639c"); expect(ds["--ds-sidebar-bg"]).toBe("#111"); });
  it("formats a CSS block for remaining consumers", () => { const block=formatDmThemeCssBlock(fallbackDsTokens(),"#x"); expect(block).toMatch(/^#x \{/); expect(block).toContain("--ds-fg:"); });
});
