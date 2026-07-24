/**
 * Resolve xterm typography from the same VS Code settings the integrated terminal uses.
 * xterm.js cannot measure CSS variables — pass concrete font stacks only.
 */
import type { AgentPaneFontMetrics } from "../webview/agent-pane/protocol.js";

/** VS Code default terminal font stack when settings are empty (linux/mac-friendly + generic). */
export const DEFAULT_TERMINAL_FONT_FAMILY =
  "Menlo, Monaco, 'Courier New', monospace";

export interface TerminalFontConfigSource {
  get<T>(section: string, defaultValue: T): T;
}

/**
 * Read `terminal.integrated.*` (with editor fallbacks) into metrics for xterm.
 * Pure over an injectable config source so unit tests do not need vscode.
 */
export function resolveAgentPaneFontMetrics(
  terminalCfg: TerminalFontConfigSource,
  editorCfg?: TerminalFontConfigSource,
): AgentPaneFontMetrics {
  const termFamily = String(terminalCfg.get<string>("fontFamily", "") ?? "").trim();
  const editorFamily = String(editorCfg?.get<string>("fontFamily", "") ?? "").trim();
  const fontFamily = termFamily || editorFamily || DEFAULT_TERMINAL_FONT_FAMILY;

  const termSize = terminalCfg.get<number>("fontSize", 0);
  const editorSize = editorCfg?.get<number>("fontSize", 14) ?? 14;
  const fontSize = typeof termSize === "number" && termSize > 0 ? termSize : editorSize > 0 ? editorSize : 14;

  const fontWeight = terminalCfg.get<string | number>("fontWeight", "normal") ?? "normal";
  const fontWeightBold = terminalCfg.get<string | number>("fontWeightBold", "bold") ?? "bold";

  const lineHeightRaw = terminalCfg.get<number>("lineHeight", 1);
  const lineHeight = typeof lineHeightRaw === "number" && lineHeightRaw > 0 ? lineHeightRaw : 1;

  const letterSpacingRaw = terminalCfg.get<number>("letterSpacing", 0);
  const letterSpacing = typeof letterSpacingRaw === "number" ? letterSpacingRaw : 0;

  return {
    fontFamily,
    fontSize,
    fontWeight,
    fontWeightBold,
    lineHeight,
    letterSpacing,
  };
}
