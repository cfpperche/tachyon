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
  });

  it("embeds the binding name", () => {
    expect(src).toContain("tachyonDesignModePick");
  });

  it("uses overlay chrome only (no page wrap / shell / iframe)", () => {
    expect(src).toContain("tachyon-dm-toolbar");
    expect(src).toContain("tachyon-dm-picker");
    expect(src).toContain("tachyon-dm-card");
    expect(src).not.toContain("tachyon-dm-shell");
    expect(src).not.toContain("tachyon-dm-site-card");
    expect(src).not.toContain("createElement('iframe')");
    expect(src).not.toMatch(/\.src\s*=\s*location\.href/);
  });

  it("footer toolbar is icon-only (no text labels on buttons)", () => {
    expect(src).toContain('role="toolbar"');
    expect(src).toContain("data-preset");
    expect(src).not.toMatch(/id="tachyon-dm-picker-label"/);
    // Toolbar buttons expose accessibility via title/aria-label, not visible text nodes.
    expect(src).toMatch(/aria-label="Toggle element picker"/);
  });

  it("toolbar leads with agent selector + single-agent chat control", () => {
    expect(src).toContain("tachyon-dm-agent");
    expect(src).toContain("tachyon-dm-chat-btn");
    expect(src).toContain("tachyon-dm-chat");
    expect(src).toContain("__tachyonDmChatPush");
    expect(src).toContain("__layout: 'chat'");
    expect(src).toContain("__layout: 'agents'");
    expect(src).toMatch(/Chat with agent|Message the agent|chat with /);
    expect(src).toMatch(/Running agents|No running agents|pick a running agent/);
    expect(src).not.toMatch(/Message the group/);
    expect(src).not.toMatch(/group · one thread/);
  });

  it("unifies agent send on chat only — selection card has no note/send", () => {
    expect(src).toContain("tachyon-dm-selection-chip");
    expect(src).toContain("__clearSelection");
    expect(src).toMatch(/Attached to chat|type your ask there/);
    expect(src).not.toMatch(/Send to agent/);
    expect(src).not.toMatch(/Note for agent/);
    expect(src).not.toMatch(/id="tachyon-dm-note"/);
    expect(src).not.toMatch(/id="tachyon-dm-send"/);
    expect(src).toMatch(/Clear selection/);
  });

  it("in-page toolbar is compact status-bar style (not a large glass pill)", () => {
    // Height / button size match VS Code status bar cluster (~22px).
    expect(src).toMatch(/#tachyon-dm-toolbar\s*\{[^}]*height:\s*22px/s);
    expect(src).toMatch(/#tachyon-dm-toolbar \.dm-tb-btn\s*\{[^}]*width:\s*22px/s);
    expect(src).toMatch(/#tachyon-dm-toolbar \.dm-tb-btn svg\s*\{[^}]*width:\s*14px/s);
    // Flat bar — no heavy glass on the toolbar itself (card may still blur).
    expect(src).toMatch(/#tachyon-dm-toolbar\s*\{[^}]*backdrop-filter:\s*none/s);
    expect(src).not.toMatch(/#tachyon-dm-toolbar\s*\{[^}]*border-radius:\s*999px/s);
  });

  it("includes responsive presets that post to host", () => {
    expect(src).toContain('data-preset="phone"');
    expect(src).toContain('data-preset="tablet"');
    expect(src).toContain('data-preset="desktop"');
    expect(src).toContain('data-preset="reset"');
    expect(src).toContain("setResponsivePreset");
    expect(src).toContain("__layout: 'responsive'");
  });

  it("uses glassmorphism on floating card", () => {
    expect(src).toMatch(/backdrop-filter:\s*blur/);
    expect(src).toMatch(/-webkit-backdrop-filter:\s*blur/);
  });

  it("picker nested blocks use theme surface tokens (not bare white input/UA)", () => {
    expect(src).toMatch(/\.dm-glass-block\s*\{[^}]*--ds-surface-raised/s);
    expect(src).toMatch(/#tachyon-dm-body pre\s*\{[^}]*background:\s*transparent/s);
    expect(src).toMatch(/color-scheme:\s*var\(--ds-color-scheme/);
    // Avoid un-fallbacked --ds-input-bg which paints pure white on many themes.
    expect(src).not.toMatch(/\.dm-glass-block\s*\{[^}]*background:\s*var\(--ds-input-bg\)\s*;/s);
  });

  it("styles scrollbars with design-system tokens on picker and chat", () => {
    expect(src).toMatch(/::-webkit-scrollbar/);
    expect(src).toMatch(/scrollbar-color:\s*color-mix\(in srgb,\s*var\(--ds-fg\)/);
    // Chat + picker share the same DS thumb/track (not browser default).
    expect(src).toContain("#tachyon-dm-chat-scroll::-webkit-scrollbar");
    expect(src).toContain("#tachyon-dm-body::-webkit-scrollbar");
    expect(src).toContain("#tachyon-dm-agent-menu::-webkit-scrollbar");
  });

  it("floating panels share drag + resize base component", () => {
    expect(src).toContain("mountFloatingPanel");
    expect(src).toContain("dm-panel");
    expect(src).toContain("dm-resize-handle");
    expect(src).toContain("dm-resize-se");
    expect(src).toContain("tachyon-dm-card-drag");
    expect(src).toContain("tachyon-dm-chat-drag");
    expect(src).toContain("dm-dragging");
    expect(src).toContain("dm-resizing");
  });

  it("picker toggle arms/disarms and hides card when off", () => {
    expect(src).toContain("setPickMode");
    expect(src).toContain("hideCard");
  });

  it("survives Trusted Types pages (no bare innerHTML assignment)", () => {
    // Google and other sites require TrustedHTML; bare node.innerHTML = throws and crashed Design Mode.
    expect(src).toContain("trustedTypes");
    expect(src).toContain("createPolicy");
    expect(src).toContain("setNodeHtml");
    // Style must use textContent (not innerHTML) so CSS always applies under TT.
    expect(src).toMatch(/styleEl\.textContent\s*=/);
  });

  it("has no Exit Design Mode control (status bar only)", () => {
    expect(src).not.toMatch(/Exit Design Mode/i);
    expect(src).not.toContain("tachyon-dm-off");
  });

  it("signals internalNav on same-tab links so host can re-inject", () => {
    expect(src).toContain("internalNav");
    expect(src).toContain("onInternalNavIntent");
  });

  it("embeds host-resolved theme token values", () => {
    expect(src).toContain("--ds-btn-bg: #0e639c");
    expect(src).toContain("--ds-radius: 6px");
    expect(src).not.toContain("@media (prefers-color-scheme");
  });

  it("Esc clears pick / turns picker off (no __cancel exit)", () => {
    const keySection = src.slice(src.indexOf("const onKey"), src.indexOf("const onInternalNavIntent"));
    expect(keySection).not.toContain("__cancel");
    expect(keySection).toContain("clearPick");
    expect(keySection).toContain("setPickMode(false)");
  });
});

describe("theme token mapping", () => {
  it("maps vscode vars to ds tokens", () => {
    const ds = mapVscodeVarsToDs({
      "--vscode-foreground": "#abc",
      "--vscode-button-background": "#0e639c",
      "--vscode-sideBar-background": "#111",
    });
    expect(ds["--ds-fg"]).toBe("#abc");
    expect(ds["--ds-btn-bg"]).toBe("#0e639c");
    expect(ds["--ds-sidebar-bg"]).toBe("#111");
  });

  it("formats a CSS block for injection", () => {
    const block = formatDmThemeCssBlock(fallbackDsTokens(), "#x");
    expect(block).toMatch(/^#x \{/);
    expect(block).toContain("--ds-fg:");
  });
});
