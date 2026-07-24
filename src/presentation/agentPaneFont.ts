/**
 * Resolve xterm typography from the same VS Code settings the integrated terminal uses.
 * xterm.js cannot measure CSS variables — pass concrete font stacks only.
 *
 * Critical webview rule: the stack MUST always end with real monospace faces that exist on
 * the webview host. A bare Windows face like `JetBrainsMono Nerd Font` is NOT installed in
 * WSL/Linux Chromium webviews; without mono fallbacks the browser substitutes a *proportional*
 * default. xterm then sizes every cell to measureText('W') of that proportional face and
 * letter-spaces each glyph into the cell → classic double-spaced TUI (human dogfood 2026-07-24).
 */
import type { AgentPaneFontMetrics } from "../webview/agent-pane/protocol.js";

/**
 * Fonts that must actually exist on the host for cell metrics to be trustworthy.
 * Prefer system monos that ship on Linux/WSL/macOS/Windows over product faces that
 * only load when design-system @font-face URLs resolve (often broken in a bare webview).
 */
export const MONO_FALLBACK_FAMILIES = [
  "DejaVu Sans Mono",
  "Liberation Mono",
  "Menlo",
  "Monaco",
  "Consolas",
  "Courier New",
  "monospace",
] as const;

export const DEFAULT_TERMINAL_FONT_FAMILY = MONO_FALLBACK_FAMILIES.map(quoteFontFamily).join(", ");

/** Product-only faces that must not be used unless we explicitly load woff in this webview. */
const UNSAFE_WEBVIEW_FACES = /tachyon\s*mono|var\s*\(/i;

export interface TerminalFontConfigSource {
  get<T>(section: string, defaultValue: T): T;
}

/** Quote a single family so canvas `ctx.font = size + family` and CSS both parse multi-word names. */
export function quoteFontFamily(name: string): string {
  const t = name.trim().replace(/^['"]+|['"]+$/g, "");
  if (!t) return "";
  if (t === "monospace" || t === "ui-monospace" || t === "ui-sans-serif" || t === "sans-serif" || t === "serif") {
    return t;
  }
  // Unquoted CSS identifiers cannot contain spaces; canvas font shorthand is even stricter.
  if (/[^a-zA-Z0-9_-]/.test(t)) {
    return `"${t.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return t;
}

/** Split a CSS font-family list on commas not inside quotes. */
export function splitFontStack(raw: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote && raw[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ",") {
      const part = cur.trim();
      if (part) out.push(part);
      cur = "";
      continue;
    }
    cur += ch;
  }
  const tail = cur.trim();
  if (tail) out.push(tail);
  return out;
}

function familyKey(quotedOrRaw: string): string {
  return quotedOrRaw.trim().replace(/^['"]+|['"]+$/g, "").toLowerCase();
}

/**
 * Build a webview-safe mono stack: preferred faces first (quoted), then guaranteed mono
 * fallbacks so a missing Windows-only face never collapses to a proportional default.
 */
export function ensureMonoFontStack(preferred: string): string {
  const preferredParts = preferred.trim()
    ? splitFontStack(preferred).map(quoteFontFamily).filter(Boolean)
    : [];
  // Drop bare `monospace` from the preferred segment so we can place real faces first,
  // then re-append generics last (CSS font-family first-match wins).
  const safe = preferredParts.filter(
    (p) => !UNSAFE_WEBVIEW_FACES.test(familyKey(p)) && familyKey(p) !== "monospace",
  );
  const seen = new Set(safe.map(familyKey));
  for (const fb of MONO_FALLBACK_FAMILIES) {
    const key = familyKey(fb);
    if (seen.has(key)) continue;
    safe.push(quoteFontFamily(fb));
    seen.add(key);
  }
  return safe.length > 0 ? safe.join(", ") : DEFAULT_TERMINAL_FONT_FAMILY;
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
  // Always append mono fallbacks — bare user faces often do not exist in the webview font world.
  const fontFamily = ensureMonoFontStack(termFamily || editorFamily || DEFAULT_TERMINAL_FONT_FAMILY);

  const termSize = terminalCfg.get<number>("fontSize", 0);
  const editorSize = editorCfg?.get<number>("fontSize", 14) ?? 14;
  const fontSize = typeof termSize === "number" && termSize > 0 ? termSize : editorSize > 0 ? editorSize : 14;

  const fontWeight = terminalCfg.get<string | number>("fontWeight", "normal") ?? "normal";
  const fontWeightBold = terminalCfg.get<string | number>("fontWeightBold", "bold") ?? "bold";

  // Agent pane hosts full-screen TUIs (Claude/Codex/Grok). Extra letter-spacing widens cells and
  // breaks box-drawing; pin packing tight regardless of integrated-terminal cosmetics.
  return {
    fontFamily,
    fontSize,
    fontWeight,
    fontWeightBold,
    lineHeight: 1,
    letterSpacing: 0,
  };
}
