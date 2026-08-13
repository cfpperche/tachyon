import { describe, expect, it } from "vitest";
import { buildDesignModeInjectExpression } from "../../src/webview/ide-browser-bridge/designModeInject.js";
import { fallbackDsTokens, formatDmThemeCssBlock, mapVscodeVarsToDs } from "../../src/webview/ide-browser-bridge/themeTokens.js";

describe("buildDesignModeInjectExpression — hybrid D page boundary", () => {
  const src = buildDesignModeInjectExpression({ bindingName: "tachyonDesignModePick", themeVars: mapVscodeVarsToDs({ "--vscode-focusBorder": "#007fd4" }) });
  it("keeps only page-realm pick, outline, serialization, and internal navigation signaling", () => {
    expect(src).toContain("elementFromPoint"); expect(src).toContain("getBoundingClientRect"); expect(src).toContain("outerHTML"); expect(src).toContain("internalNav"); expect(src).toContain("tachyon-dm-root"); expect(src).toContain("__tachyonDmSetPickMode");
  });
  it("has no injected chrome, chat, inspector, agent menu, responsive controls, or host push receiver", () => {
    for (const retired of ["tachyon-dm-toolbar","tachyon-dm-picker","tachyon-dm-card","tachyon-dm-chat","__tachyonDmChatPush","mountFloatingPanel","data-preset","trustedTypes","createPolicy","__layout:'chat'","__layout:'agents'","__layout:'responsive'"]) expect(src).not.toContain(retired);
  });
  it("ratchets the page expression to a thin inject", () => { expect(src.split("\n").length).toBeLessThan(80); expect(src.length).toBeLessThan(8_000); });
});

describe("theme token mapping", () => {
  it("maps vscode vars to ds tokens", () => { const ds=mapVscodeVarsToDs({"--vscode-foreground":"#abc","--vscode-button-background":"#0e639c","--vscode-sideBar-background":"#111"}); expect(ds["--ds-fg"]).toBe("#abc"); expect(ds["--ds-btn-bg"]).toBe("#0e639c"); expect(ds["--ds-sidebar-bg"]).toBe("#111"); });
  it("formats a CSS block for remaining consumers", () => { const block=formatDmThemeCssBlock(fallbackDsTokens(),"#x"); expect(block).toMatch(/^#x \{/); expect(block).toContain("--ds-fg:"); });
});
