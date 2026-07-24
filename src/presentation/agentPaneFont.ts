/**
 * Resolve xterm typography from the same VS Code settings the integrated terminal uses.
 * xterm.js cannot measure CSS variables — pass concrete font stacks only.
 */
import type { AgentPaneFontMetrics } from "../webview/agent-pane/protocol.js";

/**
 * Fonts that must actually exist on the host for cell metrics to be trustworthy.
 * Prefer system monos that ship on Linux/WSL/macOS/Windows over product faces that
 * only load when design-system @font-face URLs resolve (often broken in a bare webview).
 */
export const DEFAULT_TERMINAL_FONT_FAMILY =
  "DejaVu Sans Mono, Liberation Mono, Menlo, Monaco, Consolas, 'Courier New', monospace";

/** Product-only faces that must not be used unless we explicitly load woff in this webview. */
const UNSAFE_WEBVIEW_FACES = /tachyon\s*mono|var\s*\(/i;

export interface TerminalFontConfigSource {
  get<T>(section: string, defaultValue: T): T;
}

function pickFontFamily(preferred: string, fallback: string): string {
  const raw = preferred.trim();
  if (!raw || UNSAFE_WEBVIEW_FACES.test(raw)) return fallback;
  return raw;
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
  const fontFamily = pickFontFamily(termFamily || editorFamily, DEFAULT_TERMINAL_FONT_FAMILY);

  const termSize = terminalCfg.get<number>("fontSize", 0);
  const editorSize = editorCfg?.get<number>("fontSize", 14) ?? 14;
  const fontSize = typeof termSize === "number" && termSize > 0 ? termSize : editorSize > 0 ? editorSize : 14;

  const fontWeight = terminalCfg.get<string | number>("fontWeight", "normal") ?? "normal";
  const fontWeightBold = terminalCfg.get<string | number>("fontWeightBold", "bold") ?? "bold";

  // Force TUI-safe packing unless user explicitly set something mild.
  // Default lineHeight 1 + letterSpacing 0 matches typical integrated terminal TUI layout.
  const lineHeightRaw = terminalCfg.get<number>("lineHeight", 1);
  const lineHeight = typeof lineHeightRaw === "number" && lineHeightRaw >= 1 && lineHeightRaw <= 1.2
    ? lineHeightRaw
    : 1;

  const letterSpacingRaw = terminalCfg.get<number>("letterSpacing", 0);
  const letterSpacing = typeof letterSpacingRaw === "number" && letterSpacingRaw >= 0 && letterSpacingRaw <= 1
    ? letterSpacingRaw
    : 0;

  return {
    fontFamily,
    fontSize,
    fontWeight,
    fontWeightBold,
    lineHeight,
    letterSpacing,
  };
}
