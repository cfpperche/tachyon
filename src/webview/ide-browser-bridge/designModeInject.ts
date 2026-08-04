/**
 * In-page Design Mode inject — overlay chrome only (does not wrap/reframe the page).
 *
 * - Status bar ON → floating Picker button (footer center)
 * - Picker ON → crosshair + click-to-select
 * - Element selected → glassmorphism floating card (over the site)
 * - Picker button again → picker OFF + hide card
 * - Status bar OFF → remove all overlays
 *
 * Tokens: host-resolved --ds-* from the live VS Code theme.
 */

import type { DmThemeCssVars } from "./themeTokens.js";
import { fallbackDsTokens, formatDmThemeCssBlock } from "./themeTokens.js";

const STYLE_KEYS = [
  "color",
  "backgroundColor",
  "fontSize",
  "fontWeight",
  "fontFamily",
  "display",
  "padding",
  "margin",
  "border",
  "borderRadius",
  "width",
  "height",
  "position",
  "flexDirection",
  "gap",
  "justifyContent",
  "alignItems",
] as const;

export type DesignModeInjectOptions = {
  bindingName: string;
  /** Resolved --ds-* vars from host theme probe. */
  themeVars?: DmThemeCssVars;
  /** Restore picker armed state after re-inject (default true). */
  restorePickMode?: boolean;
};

/**
 * Build a Runtime.evaluate expression that installs (or reinstalls) Design Mode overlays.
 */
export function buildDesignModeInjectExpression(
  bindingNameOrOptions: string | DesignModeInjectOptions,
): string {
  const opts: DesignModeInjectOptions =
    typeof bindingNameOrOptions === "string"
      ? { bindingName: bindingNameOrOptions }
      : bindingNameOrOptions;

  const bindingName = opts.bindingName;
  const restorePickMode = opts.restorePickMode !== false;
  const themeVars = opts.themeVars ?? fallbackDsTokens();
  const themeCss = formatDmThemeCssBlock(
    themeVars,
    "#tachyon-dm-root, #tachyon-dm-toolbar, #tachyon-dm-card, #tachyon-dm-chat",
  );

  return `(() => {
  const BIND = ${JSON.stringify(bindingName)};
  const STYLE_KEYS = ${JSON.stringify([...STYLE_KEYS])};
  const RESTORE_PICK = ${JSON.stringify(restorePickMode)};
  if (window.__tachyonDmCleanup) {
    try { window.__tachyonDmCleanup(); } catch (e) {}
  }
  window.__tachyonDmQueue = window.__tachyonDmQueue || [];
  let hoverEl = null;
  let selected = null;
  let pickMode = RESTORE_PICK;
  const ROOT_ID = 'tachyon-dm-root';

  const post = (obj) => {
    const raw = JSON.stringify(obj);
    window.__tachyonDmQueue.push(raw);
    try {
      if (typeof window[BIND] === 'function') window[BIND](raw);
    } catch (e) {}
  };

  const isChrome = (el) => !!(el && el.closest && el.closest('#' + ROOT_ID));

  const captureEl = (el) => {
    const r = el.getBoundingClientRect();
    const cs = window.getComputedStyle(el);
    const styles = {};
    for (const k of STYLE_KEYS) styles[k] = cs[k];
    const className = typeof el.className === 'string'
      ? el.className
      : (el.getAttribute('class') || '');
    return {
      url: location.href,
      tag: el.tagName,
      id: el.id || '',
      className,
      text: (el.innerText || el.textContent || '').trim().slice(0, 240),
      html: (el.outerHTML || '').slice(0, 4000),
      bounds: { x: r.x, y: r.y, width: r.width, height: r.height },
      styles,
    };
  };

  const focusColor = () => {
    try {
      const v = getComputedStyle(root).getPropertyValue('--ds-focus').trim();
      if (v) return v;
    } catch (e) {}
    return '#007fd4';
  };

  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.setAttribute('data-tachyon-dm', '1');

  /**
   * Chromium Trusted Types (Google, require-trusted-types-for) blocks bare innerHTML.
   * Prefer a createPolicy HTML; fall back to createElement tree (no HTML strings).
   */
  const setNodeHtml = (node, html) => {
    try {
      const tt = window.trustedTypes;
      if (tt && typeof tt.createPolicy === 'function') {
        let policy = window.__tachyonDmHtmlPolicy;
        if (!policy) {
          try {
            policy = tt.createPolicy('tachyon-dm', { createHTML: (s) => s });
          } catch (e1) {
            policy = tt.createPolicy('tachyon-dm-' + Date.now(), { createHTML: (s) => s });
          }
          window.__tachyonDmHtmlPolicy = policy;
        }
        node.innerHTML = policy.createHTML(html);
        return true;
      }
    } catch (e) { /* policy denied */ }
    try {
      node.innerHTML = html;
      return true;
    } catch (e) {
      return false;
    }
  };

  const svgEl = (tag, attrs, kids) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    if (kids) for (const c of kids) n.appendChild(c);
    return n;
  };
  const h = (tag, attrs, kids) => {
    const n = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null) continue;
        if (k === 'text') n.textContent = String(v);
        else if (k === 'disabled') { if (v) n.setAttribute('disabled', ''); }
        else if (k === 'hidden') { if (v) n.setAttribute('hidden', ''); else n.removeAttribute('hidden'); }
        else n.setAttribute(k, String(v));
      }
    }
    if (kids) for (const c of kids) {
      if (c == null) continue;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  };

  const cssText = \`
      ${themeCss}

      /* Full-viewport stacking root so site sticky headers / high z-index chrome cannot cover DM UI */
      #tachyon-dm-root {
        all: initial;
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        font-family: var(--ds-mono, ui-monospace, monospace);
        font-size: var(--ds-body, 13px);
        color: var(--ds-fg, #cccccc);
        pointer-events: none;
        isolation: isolate;
        /* After all:initial — force form/pre UA chrome to follow VS Code theme, not the host page. */
        color-scheme: var(--ds-color-scheme, dark);
      }
      #tachyon-dm-root * { box-sizing: border-box; }
      #tachyon-dm-root button,
      #tachyon-dm-root textarea { pointer-events: auto; font-family: var(--ds-mono, ui-monospace, monospace); }

      /*
       * In-page toolbar — match EDH / VS Code status-bar cluster:
       * flat, compact, icon-only, no pill/glass blob.
       */
      #tachyon-dm-toolbar {
        pointer-events: auto;
        position: fixed;
        z-index: 2147483647;
        left: 50%;
        bottom: 8px;
        transform: translateX(-50%);
        display: inline-flex;
        align-items: stretch;
        gap: 0;
        height: 22px;
        padding: 0 2px;
        border-radius: 0;
        border: 1px solid var(--ds-border);
        background: var(--ds-sidebar-bg, var(--ds-editor-bg, #252526));
        color: var(--ds-fg);
        box-shadow: none;
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
        font-family: var(--ds-mono, ui-monospace, monospace);
        font-size: 11px;
        line-height: 22px;
      }
      #tachyon-dm-toolbar .dm-tb-sep {
        width: 1px;
        align-self: stretch;
        margin: 3px 1px;
        background: var(--ds-border);
        flex: none;
        opacity: 0.85;
      }
      #tachyon-dm-toolbar .dm-tb-btn {
        width: 22px;
        height: 22px;
        min-width: 22px;
        min-height: 22px;
        padding: 0;
        margin: 0;
        border: none;
        border-radius: 0;
        background: transparent;
        color: var(--ds-fg);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: none;
        opacity: 0.9;
      }
      #tachyon-dm-toolbar .dm-tb-btn svg {
        width: 14px;
        height: 14px;
        display: block;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.6;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      #tachyon-dm-toolbar .dm-tb-btn:hover {
        background: var(--ds-hover, rgba(255, 255, 255, 0.08));
        opacity: 1;
      }
      #tachyon-dm-toolbar .dm-tb-btn[aria-pressed="true"],
      #tachyon-dm-toolbar .dm-tb-btn.dm-active {
        background: color-mix(in srgb, var(--ds-btn-bg, #0e639c) 28%, transparent);
        color: var(--ds-ok, #89d185);
        opacity: 1;
      }
      #tachyon-dm-toolbar .dm-tb-btn:focus-visible {
        outline: 1px solid var(--ds-focus, #007fd4);
        outline-offset: -1px;
      }

      /* Base floating panel (drag + resize) — shared by pick card and chat */
      .dm-panel {
        pointer-events: auto;
        position: fixed;
        z-index: 2147483647;
        display: none;
        flex-direction: column;
        min-width: 260px;
        min-height: 180px;
        box-sizing: border-box;
        touch-action: none;
        overflow: hidden;
      }
      .dm-panel[data-open="1"] { display: flex; }
      .dm-panel.dm-dragging,
      .dm-panel.dm-resizing {
        box-shadow: var(--ds-shadow-2), 0 0 0 1px var(--ds-focus);
        user-select: none;
      }
      .dm-panel-hd {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: 0 0 auto;
        cursor: grab;
        user-select: none;
      }
      .dm-panel.dm-dragging .dm-panel-hd { cursor: grabbing; }
      .dm-panel-hd .dm-drag-hint {
        color: var(--ds-muted);
        font-size: 12px;
        margin-right: 2px;
        opacity: 0.85;
        letter-spacing: -0.04em;
      }
      .dm-resize-handle {
        position: absolute;
        z-index: 3;
        background: transparent;
      }
      .dm-resize-se {
        right: 0; bottom: 0;
        width: 14px; height: 14px;
        cursor: nwse-resize;
      }
      .dm-resize-se::after {
        content: '';
        position: absolute;
        right: 3px; bottom: 3px;
        width: 8px; height: 8px;
        border-right: 2px solid var(--ds-muted, #888);
        border-bottom: 2px solid var(--ds-muted, #888);
        opacity: 0.7;
      }
      .dm-resize-e {
        top: 12px; right: 0; bottom: 12px;
        width: 6px;
        cursor: ew-resize;
      }
      .dm-resize-s {
        left: 12px; right: 12px; bottom: 0;
        height: 6px;
        cursor: ns-resize;
      }

      #tachyon-dm-card {
        top: 16px;
        left: auto;
        right: 16px;
        width: min(360px, calc(100vw - 32px));
        max-height: min(70vh, 560px);
        height: min(70vh, 560px);
        border-radius: 12px;
        border: var(--ds-border-width, 1px) solid var(--ds-border, rgba(128,128,128,0.35));
        /* Solid-ish panel from theme (not page white bleeding through glass). */
        background: var(--ds-card, var(--ds-sidebar-bg, var(--ds-editor-bg, #252526)));
        color: var(--ds-fg, #cccccc);
        color-scheme: var(--ds-color-scheme, dark);
        backdrop-filter: blur(20px) saturate(1.25);
        -webkit-backdrop-filter: blur(20px) saturate(1.25);
        box-shadow: var(--ds-shadow-2);
        font-family: var(--ds-mono, ui-monospace, monospace);
        font-size: var(--ds-small, 12px);
      }
      #tachyon-dm-card header.dm-chrome {
        padding: 12px 14px;
        border-bottom: var(--ds-border-width, 1px) solid var(--ds-border, rgba(128,128,128,0.35));
        background: var(--ds-sidebar-bg, var(--ds-card, var(--ds-editor-bg, #252526)));
      }
      #tachyon-dm-card .dm-title {
        margin: 0;
        font-size: var(--ds-title, 16px);
        font-weight: var(--tachyon-weight-semibold, 600);
        color: var(--ds-fg);
        flex: 1 1 auto;
        cursor: inherit;
      }
      .dm-badge {
        font-size: var(--ds-micro, 11px);
        line-height: 1.5;
        padding: 2px 9px;
        border-radius: 999px;
        border: var(--ds-border-width, 1px) solid color-mix(in srgb, var(--ds-info) 65%, var(--ds-border));
        color: var(--ds-info);
        background: color-mix(in srgb, var(--ds-info) 12%, transparent);
        white-space: nowrap;
        font-weight: 600;
      }
      .dm-badge.ok {
        color: var(--ds-ok);
        border-color: color-mix(in srgb, var(--ds-ok) 65%, var(--ds-border));
        background: color-mix(in srgb, var(--ds-ok) 12%, transparent);
      }
      .dm-icon-btn {
        min-width: 28px;
        min-height: 28px;
        border-radius: var(--ds-radius, 6px);
        border: var(--ds-border-width, 1px) solid var(--ds-border, rgba(128,128,128,0.35));
        background: var(--ds-surface-raised, var(--ds-sidebar-bg, transparent));
        color: var(--ds-fg, #cccccc);
        cursor: pointer;
        font: inherit;
        font-size: 16px;
        line-height: 1;
      }
      .dm-icon-btn:hover {
        background: var(--ds-hover, rgba(128,128,128,0.15));
        border-color: var(--ds-focus, #007fd4);
        color: var(--ds-fg, #cccccc);
      }

      /* Shared DS scrollbars — picker card, chat, agent menu, nested pre blocks */
      .dm-scroll,
      #tachyon-dm-card,
      #tachyon-dm-body,
      #tachyon-dm-body pre,
      #tachyon-dm-chat,
      #tachyon-dm-chat-scroll,
      #tachyon-dm-agent-menu {
        scrollbar-width: thin;
        scrollbar-color: color-mix(in srgb, var(--ds-fg) 35%, transparent) color-mix(in srgb, var(--ds-fg) 6%, transparent);
      }
      .dm-scroll::-webkit-scrollbar,
      #tachyon-dm-card::-webkit-scrollbar,
      #tachyon-dm-body::-webkit-scrollbar,
      #tachyon-dm-body pre::-webkit-scrollbar,
      #tachyon-dm-chat::-webkit-scrollbar,
      #tachyon-dm-chat-scroll::-webkit-scrollbar,
      #tachyon-dm-agent-menu::-webkit-scrollbar {
        width: 8px;
        height: 8px;
      }
      .dm-scroll::-webkit-scrollbar-track,
      #tachyon-dm-card::-webkit-scrollbar-track,
      #tachyon-dm-body::-webkit-scrollbar-track,
      #tachyon-dm-body pre::-webkit-scrollbar-track,
      #tachyon-dm-chat::-webkit-scrollbar-track,
      #tachyon-dm-chat-scroll::-webkit-scrollbar-track,
      #tachyon-dm-agent-menu::-webkit-scrollbar-track {
        background: color-mix(in srgb, var(--ds-fg) 6%, transparent);
        border-radius: 4px;
      }
      .dm-scroll::-webkit-scrollbar-thumb,
      #tachyon-dm-card::-webkit-scrollbar-thumb,
      #tachyon-dm-body::-webkit-scrollbar-thumb,
      #tachyon-dm-body pre::-webkit-scrollbar-thumb,
      #tachyon-dm-chat::-webkit-scrollbar-thumb,
      #tachyon-dm-chat-scroll::-webkit-scrollbar-thumb,
      #tachyon-dm-agent-menu::-webkit-scrollbar-thumb {
        background: color-mix(in srgb, var(--ds-fg) 32%, transparent);
        border-radius: 4px;
        border: 2px solid transparent;
        background-clip: padding-box;
      }
      .dm-scroll::-webkit-scrollbar-thumb:hover,
      #tachyon-dm-card::-webkit-scrollbar-thumb:hover,
      #tachyon-dm-body::-webkit-scrollbar-thumb:hover,
      #tachyon-dm-body pre::-webkit-scrollbar-thumb:hover,
      #tachyon-dm-chat::-webkit-scrollbar-thumb:hover,
      #tachyon-dm-chat-scroll::-webkit-scrollbar-thumb:hover,
      #tachyon-dm-agent-menu::-webkit-scrollbar-thumb:hover {
        background: color-mix(in srgb, var(--ds-fg) 48%, transparent);
        background-clip: padding-box;
      }

      #tachyon-dm-body {
        flex: 1 1 auto;
        overflow: auto;
        padding: 12px 14px;
        color: var(--ds-fg);
        background: transparent;
      }
      #tachyon-dm-empty {
        color: var(--ds-muted);
        font-size: var(--ds-small);
        line-height: 1.5;
      }
      .dm-section {
        font-size: var(--ds-section, 11px);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: var(--tachyon-tracking-label, 0.06em);
        color: var(--ds-muted);
        margin: 14px 0 6px;
      }
      .dm-section:first-child { margin-top: 0; }
      .dm-tagline {
        font-size: var(--ds-body);
        font-weight: 600;
        margin: 0 0 4px;
        color: var(--ds-fg);
      }
      .dm-meta {
        color: var(--ds-muted);
        font-size: var(--ds-micro, 11px);
        line-height: 1.4;
      }
      /* Nested blocks: theme surface tokens only — never bare UA white for pre/code. */
      .dm-glass-block {
        background: var(--ds-surface-raised, var(--ds-sidebar-bg, var(--ds-card, var(--ds-editor-bg, #2d2d2d))));
        color: var(--ds-fg, #cccccc);
        border: var(--ds-border-width, 1px) solid var(--ds-border, rgba(128,128,128,0.35));
        border-radius: var(--ds-radius, 6px);
        padding: 8px 10px;
        margin: 0 0 2px;
      }
      #tachyon-dm-body pre {
        white-space: pre-wrap;
        word-break: break-word;
        overflow-wrap: anywhere;
        margin: 0;
        max-height: 100px;
        overflow: auto;
        font-size: var(--ds-micro, 11px);
        line-height: 1.45;
        font-family: var(--ds-mono, ui-monospace, monospace);
        background: transparent;
        color: var(--ds-fg, #cccccc);
        border: 0;
        padding: 0;
      }
      #tachyon-dm-selection-chip {
        display: none;
        align-items: center;
        gap: 8px;
        margin: 0 10px 8px;
        padding: 6px 10px;
        border-radius: var(--ds-radius, 6px);
        background: color-mix(in srgb, var(--ds-focus, #4da3ff) 18%, var(--ds-card, #1e1e1e));
        border: 1px solid color-mix(in srgb, var(--ds-focus, #4da3ff) 35%, transparent);
        font-size: var(--ds-micro, 11px);
        color: var(--ds-fg);
      }
      #tachyon-dm-selection-chip[data-on="1"] { display: flex; }
      #tachyon-dm-selection-chip .dm-sel-label {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #tachyon-dm-selection-chip .dm-sel-x {
        flex: 0 0 auto;
        border: 0;
        background: transparent;
        color: var(--ds-muted);
        cursor: pointer;
        font-size: 14px;
        line-height: 1;
        padding: 0 2px;
      }
      #tachyon-dm-status {
        font-size: var(--ds-micro, 11px);
        color: var(--ds-ok);
        padding: 0 14px 8px;
        min-height: 1.2em;
        font-weight: 500;
      }
      #tachyon-dm-status.err { color: var(--ds-err); }
      #tachyon-dm-actions {
        padding: 10px 14px;
        border-top: var(--ds-border-width, 1px) solid var(--ds-border, rgba(128,128,128,0.35));
        background: var(--ds-sidebar-bg, var(--ds-card, var(--ds-editor-bg, #252526)));
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        flex: 0 0 auto;
      }
      .dm-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 1 1 auto;
        min-height: 32px;
        padding: 8px 12px;
        border-radius: var(--ds-radius, 6px);
        border: var(--ds-border-width, 1px) solid var(--ds-border, rgba(128,128,128,0.35));
        background: var(--ds-surface-raised, var(--ds-sidebar-bg, var(--ds-card, #2d2d2d)));
        color: var(--ds-fg, #cccccc);
        cursor: pointer;
        font: inherit;
        font-size: var(--ds-small, 12px);
        font-weight: 500;
      }
      .dm-btn:hover {
        background: var(--ds-hover, rgba(128,128,128,0.15));
        border-color: var(--ds-focus, #007fd4);
      }
      .dm-btn:disabled {
        opacity: var(--ds-disabled-opacity, 0.5);
        cursor: default;
      }
      .dm-btn.primary {
        background: var(--ds-btn-bg, #0e639c);
        color: var(--ds-btn-fg, #ffffff);
        border-color: transparent;
        font-weight: 600;
      }
      .dm-btn.primary:hover { background: var(--ds-btn-hover); }
      .dm-btn.primary:disabled {
        opacity: var(--ds-disabled-opacity, 0.5);
      }

      /* Agent select — first toolbar control (compact) */
      #tachyon-dm-agent {
        pointer-events: auto;
        display: inline-flex;
        align-items: center;
        gap: 2px;
        height: 22px;
        max-width: 96px;
        padding: 0 6px 0 5px;
        margin: 0;
        border: none;
        border-radius: 0;
        background: transparent;
        color: var(--ds-fg);
        cursor: pointer;
        font: inherit;
        font-size: 11px;
        line-height: 22px;
      }
      #tachyon-dm-agent:hover { background: var(--ds-hover, rgba(255,255,255,0.08)); }
      #tachyon-dm-agent-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 72px;
      }
      .dm-tb-agent-chev { opacity: 0.7; font-size: 9px; }
      /* absolute under toolbar (toolbar has transform — fixed+viewport coords would fly away) */
      #tachyon-dm-agent-menu {
        position: absolute;
        z-index: 2;
        left: 0;
        bottom: calc(100% + 4px);
        min-width: 120px;
        max-width: min(220px, 70vw);
        max-height: 200px;
        overflow: auto;
        padding: 2px 0;
        border: 1px solid var(--ds-border);
        background: var(--ds-sidebar-bg, var(--ds-editor-bg, #252526));
        color: var(--ds-fg);
        box-shadow: 0 4px 12px rgba(0,0,0,0.35);
        font-size: 11px;
      }
      #tachyon-dm-agent-menu[hidden] { display: none !important; }
      #tachyon-dm-agent-menu button {
        display: block;
        width: 100%;
        text-align: left;
        padding: 4px 10px;
        border: none;
        background: transparent;
        color: inherit;
        cursor: pointer;
        font: inherit;
      }
      #tachyon-dm-agent-menu button:hover,
      #tachyon-dm-agent-menu button[aria-selected="true"] {
        background: var(--ds-hover, rgba(255,255,255,0.08));
      }

      /* Group chat panel — messenger aesthetics, DS tokens */
      #tachyon-dm-chat {
        right: 12px;
        bottom: 40px;
        left: auto;
        top: auto;
        width: min(360px, calc(100vw - 24px));
        height: min(420px, calc(100vh - 56px));
        border: 1px solid var(--ds-border, rgba(128,128,128,0.35));
        border-radius: 10px;
        background: var(--ds-card, var(--ds-editor-bg, #1e1e1e));
        color: var(--ds-fg, #cccccc);
        color-scheme: var(--ds-color-scheme, dark);
        box-shadow: 0 8px 28px rgba(0,0,0,0.4);
        font-family: var(--ds-mono, ui-sans-serif, system-ui, sans-serif);
        font-size: 12px;
      }
      .dm-chat-hd {
        padding: 8px 10px;
        border-bottom: 1px solid var(--ds-border, rgba(128,128,128,0.35));
        background: var(--ds-sidebar-bg, var(--ds-card, #252526));
      }
      .dm-chat-hd-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
      .dm-chat-hd-text strong { font-size: 12px; font-weight: 600; }
      #tachyon-dm-chat-sub { font-size: 10px; color: var(--ds-muted); opacity: 0.9; }
      #tachyon-dm-chat-scroll {
        flex: 1 1 auto;
        overflow-y: auto;
        overflow-x: hidden;
        padding: 8px 10px;
        background: var(--ds-editor-bg, var(--ds-card, #1e1e1e));
        /* inherits shared .dm-scroll scrollbar tokens via selector list above */
      }
      #tachyon-dm-chat-window { display: flex; flex-direction: column; gap: 6px; }
      .dm-chat-row { display: flex; flex-direction: column; max-width: 88%; }
      .dm-chat-row.user { align-self: flex-end; align-items: flex-end; }
      .dm-chat-row.agent { align-self: flex-start; align-items: flex-start; }
      .dm-chat-row.system { align-self: center; max-width: 94%; align-items: center; }
      .dm-chat-who { font-size: 10px; color: var(--ds-muted); margin: 0 4px 2px; }
      .dm-chat-bubble {
        padding: 7px 10px;
        border-radius: 12px;
        line-height: 1.35;
        word-break: break-word;
        white-space: pre-wrap;
      }
      .dm-chat-row.user .dm-chat-bubble {
        background: var(--ds-btn-bg, #0e639c);
        color: var(--ds-btn-fg, #fff);
        border-bottom-right-radius: 4px;
      }
      .dm-chat-row.agent .dm-chat-bubble {
        background: var(--ds-surface-raised, var(--ds-sidebar-bg, var(--ds-card, #2d2d2d)));
        color: var(--ds-fg, #cccccc);
        border-bottom-left-radius: 4px;
      }
      .dm-chat-row.system .dm-chat-bubble {
        background: transparent;
        color: var(--ds-muted);
        font-size: 10px;
        padding: 4px 8px;
        text-align: center;
      }
      /* Messenger-style typing row (inside scroll, as a participant bubble) */
      #tachyon-dm-chat-typing {
        display: none;
        flex-direction: column;
        align-items: flex-start;
        align-self: flex-start;
        max-width: 88%;
        margin-top: 2px;
      }
      #tachyon-dm-chat-typing[data-on="1"] { display: flex; }
      #tachyon-dm-chat-typing .dm-chat-who { font-size: 10px; color: var(--ds-muted); margin: 0 4px 2px; }
      .dm-typing-bubble {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 10px 12px;
        border-radius: 12px;
        border-bottom-left-radius: 4px;
        background: var(--ds-surface-raised, var(--ds-sidebar-bg, var(--ds-card, #2d2d2d)));
        min-height: 18px;
      }
      .dm-typing-bubble span {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--ds-muted, #9d9d9d);
        opacity: 0.45;
        animation: dm-typing-dot 1.2s ease-in-out infinite;
      }
      .dm-typing-bubble span:nth-child(2) { animation-delay: 0.15s; }
      .dm-typing-bubble span:nth-child(3) { animation-delay: 0.3s; }
      @keyframes dm-typing-dot {
        0%, 80%, 100% { opacity: 0.35; transform: translateY(0); }
        40% { opacity: 1; transform: translateY(-2px); }
      }
      /* Legacy footer slot (kept hidden; typing lives in-thread) */
      #tachyon-dm-chat-working { display: none !important; }
      .dm-chat-ft {
        display: flex;
        gap: 6px;
        padding: 8px;
        border-top: 1px solid var(--ds-border);
        background: var(--ds-sidebar-bg, #252526);
        flex: 0 0 auto;
        align-items: flex-end;
      }
      #tachyon-dm-chat-input {
        flex: 1 1 auto;
        min-height: 32px;
        max-height: 88px;
        resize: none;
        border: 1px solid var(--ds-border, rgba(128,128,128,0.35));
        border-radius: 16px;
        padding: 7px 12px;
        background: var(--ds-surface-raised, var(--ds-sidebar-bg, var(--ds-card, #2d2d2d)));
        color: var(--ds-fg, #cccccc);
        color-scheme: var(--ds-color-scheme, dark);
        font: inherit;
        font-size: 12px;
        line-height: 1.3;
      }
      #tachyon-dm-chat-input:focus {
        outline: 1px solid var(--ds-focus);
        border-color: var(--ds-focus);
      }
      #tachyon-dm-chat-send {
        flex: 0 0 auto;
        min-width: 56px;
        min-height: 32px;
        border-radius: 16px;
      }
  \`;

  const markup = \`
    <div id="tachyon-dm-toolbar" role="toolbar" aria-label="Design Mode">
      <button type="button" class="dm-tb-agent" id="tachyon-dm-agent" title="Active agent" aria-label="Select Design Mode agent" aria-haspopup="listbox">
        <span id="tachyon-dm-agent-label">agent</span>
        <span class="dm-tb-agent-chev" aria-hidden="true">▾</span>
      </button>
      <div id="tachyon-dm-agent-menu" role="listbox" aria-label="Saved agents" hidden></div>
      <button type="button" class="dm-tb-btn" id="tachyon-dm-chat-btn" aria-pressed="false" title="Group chat" aria-label="Open Design Mode chat">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H7l-3 3V5z"/></svg>
      </button>
      <span class="dm-tb-sep" aria-hidden="true"></span>
      <button type="button" class="dm-tb-btn" id="tachyon-dm-picker" aria-pressed="false" title="Element picker" aria-label="Toggle element picker">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>
      </button>
      <span class="dm-tb-sep" aria-hidden="true"></span>
      <button type="button" class="dm-tb-btn" data-preset="phone" title="Phone 375×812" aria-label="Phone viewport 375">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></svg>
      </button>
      <button type="button" class="dm-tb-btn" data-preset="tablet" title="Tablet 768×1024" aria-label="Tablet viewport 768">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M11 17h2"/></svg>
      </button>
      <button type="button" class="dm-tb-btn" data-preset="desktop" title="Desktop 1280×800" aria-label="Desktop viewport 1280">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="4" width="20" height="13" rx="1.5"/><path d="M8 21h8M12 17v4"/></svg>
      </button>
      <button type="button" class="dm-tb-btn" data-preset="reset" title="Reset viewport" aria-label="Reset viewport size">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>
      </button>
    </div>
    <aside id="tachyon-dm-chat" class="dm-panel" data-open="0" aria-label="Design Mode chat">
      <header class="dm-panel-hd dm-chat-hd" id="tachyon-dm-chat-drag" title="Drag to move">
        <span class="dm-drag-hint" aria-hidden="true">⋮⋮</span>
        <div class="dm-chat-hd-text">
          <strong>Design Mode chat</strong>
          <span id="tachyon-dm-chat-sub">pick a running agent</span>
        </div>
        <button type="button" class="dm-icon-btn" id="tachyon-dm-chat-term" title="Open agent terminal" aria-label="Open agent terminal">⧉</button>
        <button type="button" class="dm-icon-btn" id="tachyon-dm-chat-close" title="Close chat">×</button>
      </header>
      <div id="tachyon-dm-chat-scroll">
        <div id="tachyon-dm-chat-spacer-top"></div>
        <div id="tachyon-dm-chat-window"></div>
        <div id="tachyon-dm-chat-typing" data-on="0" aria-live="polite">
          <div class="dm-chat-who" id="tachyon-dm-typing-who"></div>
          <div class="dm-typing-bubble" aria-label="typing"><span></span><span></span><span></span></div>
        </div>
        <div id="tachyon-dm-chat-spacer-bottom"></div>
      </div>
      <div id="tachyon-dm-chat-working" hidden></div>
      <div id="tachyon-dm-selection-chip" data-on="0" aria-live="polite">
        <span class="dm-sel-label" id="tachyon-dm-selection-label">No selection</span>
        <button type="button" class="dm-sel-x" id="tachyon-dm-selection-clear" title="Detach selection" aria-label="Detach selection">×</button>
      </div>
      <footer class="dm-chat-ft">
        <textarea id="tachyon-dm-chat-input" rows="1" placeholder="Message the agent…"></textarea>
        <button type="button" class="dm-btn primary" id="tachyon-dm-chat-send">Send</button>
      </footer>
    </aside>
    <aside id="tachyon-dm-card" class="dm-panel" data-open="0" aria-label="Design Mode pick">
      <header class="dm-panel-hd dm-chrome" id="tachyon-dm-card-drag" title="Drag to move">
        <span class="dm-drag-hint" aria-hidden="true">⋮⋮</span>
        <h1 class="dm-title">Selection</h1>
        <span class="dm-badge" id="tachyon-dm-badge">pick</span>
        <button type="button" class="dm-icon-btn" id="tachyon-dm-card-close" title="Close card">×</button>
      </header>
      <div id="tachyon-dm-body">
        <div id="tachyon-dm-empty">
          Picker is on — click an element on the page. Toggle Picker off to browse links.
        </div>
        <div id="tachyon-dm-detail" style="display:none">
          <div class="dm-tagline"><span id="tachyon-dm-tag"></span></div>
          <div class="dm-meta" id="tachyon-dm-meta"></div>
          <div class="dm-section">Text</div>
          <div class="dm-glass-block"><pre id="tachyon-dm-text"></pre></div>
          <div class="dm-section">Styles</div>
          <div class="dm-glass-block"><pre id="tachyon-dm-styles"></pre></div>
          <div class="dm-section">HTML</div>
          <div class="dm-glass-block"><pre id="tachyon-dm-html"></pre></div>
        </div>
      </div>
      <div id="tachyon-dm-status"></div>
      <div id="tachyon-dm-actions">
        <button type="button" class="dm-btn" id="tachyon-dm-clear" disabled>Clear selection</button>
      </div>
    </aside>
  \`;

  // Style always via textContent (never subject to TrustedHTML).
  const styleEl = document.createElement('style');
  styleEl.id = 'tachyon-dm-style';
  styleEl.textContent = cssText;
  document.documentElement.appendChild(styleEl);

  if (!setNodeHtml(root, markup)) {
    // Hard Trusted Types deny: pure DOM construction (no HTML assignment).
    const iconPicker = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [
      svgEl('circle', { cx: '12', cy: '12', r: '3' }),
      svgEl('path', { d: 'M12 2v4M12 18v4M2 12h4M18 12h4' }),
    ]);
    const iconPhone = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [
      svgEl('rect', { x: '7', y: '2', width: '10', height: '20', rx: '2' }),
      svgEl('path', { d: 'M11 18h2' }),
    ]);
    const iconTablet = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [
      svgEl('rect', { x: '4', y: '3', width: '16', height: '18', rx: '2' }),
      svgEl('path', { d: 'M11 17h2' }),
    ]);
    const iconDesktop = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [
      svgEl('rect', { x: '2', y: '4', width: '20', height: '13', rx: '1.5' }),
      svgEl('path', { d: 'M8 21h8M12 17v4' }),
    ]);
    const iconReset = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [
      svgEl('path', { d: 'M3 12a9 9 0 1 0 3-6.7' }),
      svgEl('path', { d: 'M3 4v5h5' }),
    ]);
    const iconChat = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [
      svgEl('path', { d: 'M4 5h16v11H7l-3 3V5z' }),
    ]);
    const toolbarDom = h('div', { id: 'tachyon-dm-toolbar', role: 'toolbar', 'aria-label': 'Design Mode' }, [
      h('button', { type: 'button', class: 'dm-tb-agent', id: 'tachyon-dm-agent', title: 'Active agent', 'aria-label': 'Select Design Mode agent', 'aria-haspopup': 'listbox' }, [
        h('span', { id: 'tachyon-dm-agent-label', text: 'agent' }),
        h('span', { class: 'dm-tb-agent-chev', 'aria-hidden': 'true', text: '▾' }),
      ]),
      h('div', { id: 'tachyon-dm-agent-menu', role: 'listbox', 'aria-label': 'Running agents', hidden: true }),
      h('button', { type: 'button', class: 'dm-tb-btn', id: 'tachyon-dm-chat-btn', 'aria-pressed': 'false', title: 'Chat with agent', 'aria-label': 'Open Design Mode chat' }, [iconChat]),
      h('span', { class: 'dm-tb-sep', 'aria-hidden': 'true' }),
      h('button', { type: 'button', class: 'dm-tb-btn', id: 'tachyon-dm-picker', 'aria-pressed': 'false', title: 'Element picker', 'aria-label': 'Toggle element picker' }, [iconPicker]),
      h('span', { class: 'dm-tb-sep', 'aria-hidden': 'true' }),
      h('button', { type: 'button', class: 'dm-tb-btn', 'data-preset': 'phone', title: 'Phone 375×812', 'aria-label': 'Phone viewport 375' }, [iconPhone]),
      h('button', { type: 'button', class: 'dm-tb-btn', 'data-preset': 'tablet', title: 'Tablet 768×1024', 'aria-label': 'Tablet viewport 768' }, [iconTablet]),
      h('button', { type: 'button', class: 'dm-tb-btn', 'data-preset': 'desktop', title: 'Desktop 1280×800', 'aria-label': 'Desktop viewport 1280' }, [iconDesktop]),
      h('button', { type: 'button', class: 'dm-tb-btn', 'data-preset': 'reset', title: 'Reset viewport', 'aria-label': 'Reset viewport size' }, [iconReset]),
    ]);
    // Minimal chat shell for TT fallback (full virtualization wires below after querySelector).
    const chatDom = h('aside', { id: 'tachyon-dm-chat', class: 'dm-panel', 'data-open': '0', 'aria-label': 'Design Mode chat' }, [
      h('header', { class: 'dm-panel-hd dm-chat-hd', id: 'tachyon-dm-chat-drag', title: 'Drag to move' }, [
        h('span', { class: 'dm-drag-hint', 'aria-hidden': 'true', text: '⋮⋮' }),
        h('div', { class: 'dm-chat-hd-text' }, [
          h('strong', { text: 'Design Mode chat' }),
          h('span', { id: 'tachyon-dm-chat-sub', text: 'pick a running agent' }),
        ]),
        h('button', { type: 'button', class: 'dm-icon-btn', id: 'tachyon-dm-chat-term', title: 'Open agent terminal', 'aria-label': 'Open agent terminal', text: '⧉' }),
        h('button', { type: 'button', class: 'dm-icon-btn', id: 'tachyon-dm-chat-close', title: 'Close chat', text: '×' }),
      ]),
      h('div', { id: 'tachyon-dm-chat-scroll' }, [
        h('div', { id: 'tachyon-dm-chat-spacer-top' }),
        h('div', { id: 'tachyon-dm-chat-window' }),
        h('div', { id: 'tachyon-dm-chat-typing', 'data-on': '0' }, [
          h('div', { class: 'dm-chat-who', id: 'tachyon-dm-typing-who' }),
          h('div', { class: 'dm-typing-bubble', 'aria-label': 'typing' }, [
            h('span'), h('span'), h('span'),
          ]),
        ]),
        h('div', { id: 'tachyon-dm-chat-spacer-bottom' }),
      ]),
      h('div', { id: 'tachyon-dm-chat-working', hidden: true }),
      h('div', { id: 'tachyon-dm-selection-chip', 'data-on': '0' }, [
        h('span', { class: 'dm-sel-label', id: 'tachyon-dm-selection-label', text: 'No selection' }),
        h('button', { type: 'button', class: 'dm-sel-x', id: 'tachyon-dm-selection-clear', title: 'Detach selection', 'aria-label': 'Detach selection', text: '×' }),
      ]),
      h('footer', { class: 'dm-chat-ft' }, [
        h('textarea', { id: 'tachyon-dm-chat-input', rows: '1', placeholder: 'Message the agent…' }),
        h('button', { type: 'button', class: 'dm-btn primary', id: 'tachyon-dm-chat-send', text: 'Send' }),
      ]),
    ]);
    const cardDom = h('aside', { id: 'tachyon-dm-card', class: 'dm-panel', 'data-open': '0', 'aria-label': 'Design Mode pick' }, [
      h('header', { class: 'dm-panel-hd dm-chrome', id: 'tachyon-dm-card-drag', title: 'Drag to move' }, [
        h('span', { class: 'dm-drag-hint', 'aria-hidden': 'true', text: '⋮⋮' }),
        h('h1', { class: 'dm-title', text: 'Selection' }),
        h('span', { class: 'dm-badge', id: 'tachyon-dm-badge', text: 'pick' }),
        h('button', { type: 'button', class: 'dm-icon-btn', id: 'tachyon-dm-card-close', title: 'Close card', text: '×' }),
      ]),
      h('div', { id: 'tachyon-dm-body' }, [
        h('div', { id: 'tachyon-dm-empty', text: 'Picker is on — click an element on the page. Toggle Picker off to browse links.' }),
        h('div', { id: 'tachyon-dm-detail', style: 'display:none' }, [
          h('div', { class: 'dm-tagline' }, [h('span', { id: 'tachyon-dm-tag' })]),
          h('div', { class: 'dm-meta', id: 'tachyon-dm-meta' }),
          h('div', { class: 'dm-section', text: 'Text' }),
          h('div', { class: 'dm-glass-block' }, [h('pre', { id: 'tachyon-dm-text' })]),
          h('div', { class: 'dm-section', text: 'Styles' }),
          h('div', { class: 'dm-glass-block' }, [h('pre', { id: 'tachyon-dm-styles' })]),
          h('div', { class: 'dm-section', text: 'HTML' }),
          h('div', { class: 'dm-glass-block' }, [h('pre', { id: 'tachyon-dm-html' })]),
        ]),
      ]),
      h('div', { id: 'tachyon-dm-status' }),
      h('div', { id: 'tachyon-dm-actions' }, [
        h('button', { type: 'button', class: 'dm-btn', id: 'tachyon-dm-clear', disabled: true, text: 'Clear selection' }),
      ]),
    ]);
    root.appendChild(toolbarDom);
    root.appendChild(chatDom);
    root.appendChild(cardDom);
  }

  document.documentElement.appendChild(root);

  const toolbar = root.querySelector('#tachyon-dm-toolbar');
  const pickerBtn = root.querySelector('#tachyon-dm-picker');
  const card = root.querySelector('#tachyon-dm-card');
  const dragHandle = root.querySelector('#tachyon-dm-card-drag');
  const empty = root.querySelector('#tachyon-dm-empty');
  const detail = root.querySelector('#tachyon-dm-detail');
  const clearBtn = root.querySelector('#tachyon-dm-clear');
  const statusEl = root.querySelector('#tachyon-dm-status');
  const badge = root.querySelector('#tachyon-dm-badge');
  const agentBtn = root.querySelector('#tachyon-dm-agent');
  const agentLabel = root.querySelector('#tachyon-dm-agent-label');
  const agentMenu = root.querySelector('#tachyon-dm-agent-menu');
  const chatBtn = root.querySelector('#tachyon-dm-chat-btn');
  const chatPanel = root.querySelector('#tachyon-dm-chat');
  const chatScroll = root.querySelector('#tachyon-dm-chat-scroll');
  const chatWindow = root.querySelector('#tachyon-dm-chat-window');
  const chatWorking = root.querySelector('#tachyon-dm-chat-working');
  const chatTyping = root.querySelector('#tachyon-dm-chat-typing');
  const chatTypingWho = root.querySelector('#tachyon-dm-typing-who');
  const chatInput = root.querySelector('#tachyon-dm-chat-input');
  const chatSend = root.querySelector('#tachyon-dm-chat-send');
  const chatClose = root.querySelector('#tachyon-dm-chat-close');
  const chatTerm = root.querySelector('#tachyon-dm-chat-term');
  const chatSub = root.querySelector('#tachyon-dm-chat-sub');
  const selectionChip = root.querySelector('#tachyon-dm-selection-chip');
  const selectionLabel = root.querySelector('#tachyon-dm-selection-label');
  const selectionClearBtn = root.querySelector('#tachyon-dm-selection-clear');

  let activePreset = 'reset';

  /* ── Chat (sole agent channel; selection is attach context only) ── */
  let agents = [];
  let activeAgent = '';
  let chatOpen = false;
  let chatItems = [];
  let hasMoreBefore = false;
  let chatLoading = false;
  let chatWorkingOn = false;
  let selectionAttached = false;

  const eventKey = (ev) => String(ev.lineNo || ((ev.at || '') + ':' + String(ev.text || '').slice(0, 24)));
  const bubbleRole = (ev) => {
    if (ev.kind === 'agent_switch' || ev.kind === 'system' || ev.role === 'system') return 'system';
    if (ev.role === 'agent') return 'agent';
    if (ev.role === 'user') return 'user';
    return 'system';
  };
  const renderBubble = (ev) => {
    const role = bubbleRole(ev);
    const row = document.createElement('div');
    row.className = 'dm-chat-row ' + role;
    row.dataset.line = String(ev.lineNo || '');
    if (role === 'agent') {
      const who = document.createElement('div');
      who.className = 'dm-chat-who';
      who.textContent = ev.agent || 'agent';
      row.appendChild(who);
    }
    const bubble = document.createElement('div');
    bubble.className = 'dm-chat-bubble';
    bubble.textContent = ev.text || (ev.kind === 'agent_switch' ? ('Active agent → ' + (ev.to || '')) : '');
    row.appendChild(bubble);
    return row;
  };
  const rebuildChatWindow = (opts) => {
    if (!chatWindow) return;
    const stickBottom = !opts || opts.stickBottom !== false;
    const prevHeight = chatScroll ? chatScroll.scrollHeight : 0;
    const prevTop = chatScroll ? chatScroll.scrollTop : 0;
    chatWindow.textContent = '';
    const MAX_DOM = 120;
    const slice = chatItems.length > MAX_DOM ? chatItems.slice(chatItems.length - MAX_DOM) : chatItems;
    for (const ev of slice) chatWindow.appendChild(renderBubble(ev));
    if (!chatScroll) return;
    if (stickBottom) chatScroll.scrollTop = chatScroll.scrollHeight;
    else {
      const delta = chatScroll.scrollHeight - prevHeight;
      chatScroll.scrollTop = prevTop + Math.max(0, delta);
    }
  };
  const mergeChatItems = (incoming, mode) => {
    const map = new Map(chatItems.map((e) => [eventKey(e), e]));
    for (const ev of incoming) map.set(eventKey(ev), ev);
    chatItems = Array.from(map.values()).sort((a, b) => (a.lineNo || 0) - (b.lineNo || 0));
    rebuildChatWindow({ stickBottom: mode !== 'before' });
  };
  const setChatOpen = (on) => {
    chatOpen = !!on;
    if (chatPanel) chatPanel.setAttribute('data-open', chatOpen ? '1' : '0');
    if (chatBtn) chatBtn.setAttribute('aria-pressed', chatOpen ? 'true' : 'false');
    if (chatOpen) {
      try { if (typeof chatPanelApi !== 'undefined' && chatPanelApi) chatPanelApi.ensureLayout(); } catch (e) {}
      // Single open message — host hydrates tail + agents (no concurrent posts that can race).
      post({ __layout: 'chat', action: 'open', limit: 60 });
    } else {
      post({ __layout: 'chat', action: 'close' });
      if (agentMenu) agentMenu.hidden = true;
    }
  };
  const setWorking = (on, agentName, phase) => {
    chatWorkingOn = !!on;
    const who = agentName || activeAgent || 'agent';
    if (chatTyping) {
      chatTyping.setAttribute('data-on', chatWorkingOn ? '1' : '0');
    }
    if (chatTypingWho) {
      // Messenger pattern: "grok is typing" via name above dots (not a system banner).
      if (phase === 'needs-input') chatTypingWho.textContent = who + ' needs input';
      else if (phase === 'throttled') chatTypingWho.textContent = who + ' (throttled)';
      else chatTypingWho.textContent = who;
    }
    if (chatWorking) chatWorking.hidden = true;
    if (chatSend) chatSend.disabled = chatWorkingOn;
    if (chatWorkingOn && chatScroll) {
      try { chatScroll.scrollTop = chatScroll.scrollHeight; } catch (e) {}
    }
  };
  const syncAgentUi = () => {
    if (agentLabel) agentLabel.textContent = activeAgent || 'agent';
    if (chatSub) {
      chatSub.textContent = activeAgent
        ? ('chat with ' + activeAgent)
        : 'pick a running agent';
    }
    if (chatInput) {
      chatInput.placeholder = activeAgent
        ? ('Message ' + activeAgent + '…')
        : 'Message the agent…';
    }
  };
  const openAgentMenu = () => {
    if (!agentMenu || !agentBtn) return;
    agentMenu.textContent = '';
    if (!agents.length) {
      const emptyBtn = document.createElement('button');
      emptyBtn.type = 'button';
      emptyBtn.textContent = 'No running agents';
      emptyBtn.disabled = true;
      agentMenu.appendChild(emptyBtn);
    } else {
      for (const name of agents) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.agent = name;
        b.textContent = name;
        b.setAttribute('aria-selected', name === activeAgent ? 'true' : 'false');
        b.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          agentMenu.hidden = true;
          if (name !== activeAgent) post({ __layout: 'agents', action: 'set', agent: name });
        });
        agentMenu.appendChild(b);
      }
    }
    // CSS anchors the menu above the toolbar (absolute); do not use viewport fixed coords —
    // toolbar has transform:translateX(-50%) which creates a containing block for fixed.
    agentMenu.style.left = '0';
    agentMenu.style.right = 'auto';
    agentMenu.style.bottom = '';
    agentMenu.style.top = '';
    agentMenu.hidden = false;
  };
  window.__tachyonDmChatPush = (payload) => {
    try {
      if (!payload || typeof payload !== 'object') return;
      if (payload.type === 'agents') {
        agents = Array.isArray(payload.agents) ? payload.agents.slice() : [];
        if (typeof payload.active === 'string') activeAgent = payload.active;
        syncAgentUi();
        return;
      }
      if (payload.type === 'selection') {
        if (payload.clear || payload.consumed) {
          // Host cleared/consumed attach — update chip; card can stay for inspect unless clear.
          setSelectionChip(false);
          if (payload.clear && !payload.consumed) {
            selected = null;
            empty.style.display = 'block';
            detail.style.display = 'none';
            if (clearBtn) clearBtn.disabled = true;
            hideCard();
          }
          return;
        }
        if (payload.attached) {
          setSelectionChip(true, payload.summary || 'element');
          if (!chatOpen) setChatOpen(true);
        }
        return;
      }
      if (payload.type === 'working') {
        setWorking(!!payload.on, payload.agent, payload.phase);
        return;
      }
      if (payload.type === 'chunk') {
        hasMoreBefore = !!payload.hasMoreBefore;
        mergeChatItems(Array.isArray(payload.items) ? payload.items : [], payload.mode === 'before' ? 'before' : 'tail');
        chatLoading = false;
        return;
      }
      if (payload.type === 'message' || payload.type === 'system' || payload.type === 'agent_switch') {
        const ev = payload.event || payload;
        mergeChatItems([ev], 'tail');
        if (payload.type === 'agent_switch' && typeof payload.active === 'string') {
          activeAgent = payload.active;
          syncAgentUi();
        }
        if (ev && ev.role === 'agent') setWorking(false);
        return;
      }
      if (payload.type === 'error' && typeof payload.text === 'string') {
        mergeChatItems([{ v: 1, kind: 'system', role: 'system', text: payload.text, at: new Date().toISOString(), lineNo: Date.now() }], 'tail');
        setWorking(false);
      }
    } catch (e) {}
  };
  if (agentBtn) {
    agentBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (agentMenu && !agentMenu.hidden) agentMenu.hidden = true;
      else { post({ __layout: 'agents', action: 'list' }); openAgentMenu(); }
    });
  }
  if (chatBtn) {
    chatBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setChatOpen(!chatOpen);
    });
  }
  if (chatClose) chatClose.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); setChatOpen(false); });
  if (chatTerm) chatTerm.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); post({ __layout: 'chat', action: 'openTerminal' }); });
  const sendChat = () => {
    if (!chatInput || chatWorkingOn) return;
    const text = (chatInput.value || '').trim();
    if (!text) return;
    chatInput.value = '';
    post({ __layout: 'chat', action: 'send', text: text });
    setWorking(true, activeAgent);
  };
  if (chatSend) chatSend.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); sendChat(); });
  if (chatInput) {
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
    });
  }
  if (chatScroll) {
    chatScroll.addEventListener('scroll', () => {
      if (chatLoading || !hasMoreBefore || !chatOpen) return;
      if (chatScroll.scrollTop > 40) return;
      const oldest = chatItems.length ? chatItems[0].lineNo : null;
      if (oldest == null) return;
      chatLoading = true;
      post({ __layout: 'chat', action: 'load', before: oldest, limit: 40 });
    });
  }
  document.addEventListener('click', (e) => {
    if (!agentMenu || agentMenu.hidden) return;
    const t = e.target;
    if (t && t.closest && (t.closest('#tachyon-dm-agent-menu') || t.closest('#tachyon-dm-agent'))) return;
    agentMenu.hidden = true;
  }, true);
  post({ __layout: 'agents', action: 'list' });

  const clearHover = () => {
    if (hoverEl) {
      try { hoverEl.style.outline = hoverEl.__tachyonPrevOutline || ''; } catch (e) {}
      hoverEl = null;
    }
  };

  /**
   * Base floating panel: drag by header + resize handles (se/e/s).
   * Shared by pick card and chat. Keeps left/top/width/height after first interaction.
   */
  const mountFloatingPanel = (panel, opts) => {
    if (!panel) return { dispose: () => {}, ensureLayout: () => {} };
    const handle = opts && opts.handle;
    const minW = (opts && opts.minWidth) || 280;
    const minH = (opts && opts.minHeight) || 200;
    const ignoreSel = (opts && opts.ignoreSelector) || '.dm-icon-btn, button, a, input, textarea, select';
    let layout = null; // { left, top, width, height }

    const clamp = (left, top, width, height) => {
      const pad = 8;
      const w = Math.min(Math.max(minW, width), Math.max(minW, window.innerWidth - pad * 2));
      const h = Math.min(Math.max(minH, height), Math.max(minH, window.innerHeight - pad * 2));
      const maxL = Math.max(pad, window.innerWidth - w - pad);
      const maxT = Math.max(pad, window.innerHeight - h - pad);
      return {
        left: Math.min(Math.max(pad, left), maxL),
        top: Math.min(Math.max(pad, top), maxT),
        width: w,
        height: h,
      };
    };

    const apply = () => {
      if (!layout) return;
      layout = clamp(layout.left, layout.top, layout.width, layout.height);
      panel.style.left = layout.left + 'px';
      panel.style.top = layout.top + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.width = layout.width + 'px';
      panel.style.height = layout.height + 'px';
      panel.style.maxWidth = 'none';
      panel.style.maxHeight = 'none';
    };

    const captureLayout = () => {
      const rect = panel.getBoundingClientRect();
      layout = clamp(rect.left, rect.top, rect.width || minW, rect.height || minH);
      apply();
    };

    // Resize handles (once)
    if (!panel.querySelector('.dm-resize-handle')) {
      for (const edge of ['se', 'e', 's']) {
        const rh = document.createElement('div');
        rh.className = 'dm-resize-handle dm-resize-' + edge;
        rh.dataset.edge = edge;
        rh.setAttribute('aria-hidden', 'true');
        panel.appendChild(rh);
      }
    }

    const onDragDown = (e) => {
      if (!handle) return;
      if (e.button != null && e.button !== 0) return;
      const t = e.target;
      if (t && t.closest && t.closest(ignoreSel)) return;
      e.preventDefault();
      e.stopPropagation();
      if (!layout) captureLayout();
      const startX = e.clientX;
      const startY = e.clientY;
      const originL = layout.left;
      const originT = layout.top;
      panel.classList.add('dm-dragging');
      const onMove = (ev) => {
        layout = clamp(originL + (ev.clientX - startX), originT + (ev.clientY - startY), layout.width, layout.height);
        apply();
      };
      const onUp = () => {
        panel.classList.remove('dm-dragging');
        document.removeEventListener('pointermove', onMove, true);
        document.removeEventListener('pointerup', onUp, true);
        document.removeEventListener('pointercancel', onUp, true);
      };
      document.addEventListener('pointermove', onMove, true);
      document.addEventListener('pointerup', onUp, true);
      document.addEventListener('pointercancel', onUp, true);
    };

    const onResizeDown = (e) => {
      const edge = e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.edge;
      if (!edge) return;
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (!layout) captureLayout();
      const startX = e.clientX;
      const startY = e.clientY;
      const oL = layout.left;
      const oT = layout.top;
      const oW = layout.width;
      const oH = layout.height;
      panel.classList.add('dm-resizing');
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        let left = oL;
        let top = oT;
        let width = oW;
        let height = oH;
        if (edge === 'e' || edge === 'se') width = oW + dx;
        if (edge === 's' || edge === 'se') height = oH + dy;
        layout = clamp(left, top, width, height);
        apply();
      };
      const onUp = () => {
        panel.classList.remove('dm-resizing');
        document.removeEventListener('pointermove', onMove, true);
        document.removeEventListener('pointerup', onUp, true);
        document.removeEventListener('pointercancel', onUp, true);
      };
      document.addEventListener('pointermove', onMove, true);
      document.addEventListener('pointerup', onUp, true);
      document.addEventListener('pointercancel', onUp, true);
    };

    if (handle) handle.addEventListener('pointerdown', onDragDown);
    const handles = panel.querySelectorAll('.dm-resize-handle');
    for (const rh of handles) rh.addEventListener('pointerdown', onResizeDown);
    const onWinResize = () => { if (layout) apply(); };
    window.addEventListener('resize', onWinResize);

    return {
      ensureLayout: () => { if (layout) apply(); },
      dispose: () => {
        if (handle) handle.removeEventListener('pointerdown', onDragDown);
        for (const rh of handles) rh.removeEventListener('pointerdown', onResizeDown);
        window.removeEventListener('resize', onWinResize);
      },
    };
  };

  const hideCard = () => {
    card.setAttribute('data-open', '0');
  };

  const showCard = () => {
    card.setAttribute('data-open', '1');
    if (cardPanelApi) cardPanelApi.ensureLayout();
  };

  // Floating panels: pick card + chat (drag header, resize edges).
  const cardPanelApi = mountFloatingPanel(card, {
    handle: dragHandle,
    minWidth: 280,
    minHeight: 220,
    ignoreSelector: '#tachyon-dm-card-close, .dm-icon-btn, button, a, input, textarea',
  });
  const chatDragHandle = root.querySelector('#tachyon-dm-chat-drag');
  const chatPanelApi = mountFloatingPanel(chatPanel, {
    handle: chatDragHandle,
    minWidth: 280,
    minHeight: 240,
    ignoreSelector: '#tachyon-dm-chat-close, #tachyon-dm-chat-term, .dm-icon-btn, button, a, input, textarea',
  });
  const syncResponsiveUi = () => {
    if (!toolbar) return;
    const btns = toolbar.querySelectorAll('[data-preset]');
    for (const b of btns) {
      const p = b.getAttribute('data-preset');
      if (p === 'reset') {
        b.classList.toggle('dm-active', activePreset === 'reset');
        b.setAttribute('aria-pressed', activePreset === 'reset' ? 'true' : 'false');
      } else {
        const on = activePreset === p;
        b.classList.toggle('dm-active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }
  };

  const setResponsivePreset = (preset) => {
    const allowed = { phone: 1, tablet: 1, desktop: 1, reset: 1 };
    if (!allowed[preset]) return;
    activePreset = preset;
    syncResponsiveUi();
    post({ __layout: 'responsive', preset: preset });
    if (statusEl) {
      const labels = {
        phone: 'Viewport: phone 375×812',
        tablet: 'Viewport: tablet 768×1024',
        desktop: 'Viewport: desktop 1280×800',
        reset: 'Viewport: reset (native)',
      };
      statusEl.textContent = labels[preset] || '';
      statusEl.className = '';
    }
  };

  const syncPickerUi = () => {
    pickerBtn.setAttribute('aria-pressed', pickMode ? 'true' : 'false');
    pickerBtn.title = pickMode
      ? 'Picker on — click an element. Click again to turn off.'
      : 'Element picker';
    pickerBtn.setAttribute('aria-label', pickMode ? 'Turn picker off' : 'Turn picker on');
    try {
      document.documentElement.style.cursor = pickMode ? 'crosshair' : '';
    } catch (e) {}
    if (!pickMode) {
      clearHover();
      hideCard();
      selected = null;
      empty.style.display = 'block';
      detail.style.display = 'none';
      if (clearBtn) clearBtn.disabled = true;
      statusEl.textContent = '';
      if (badge) {
        badge.textContent = 'idle';
        badge.className = 'dm-badge';
      }
    } else if (badge && !selected) {
      badge.textContent = 'pick';
      badge.className = 'dm-badge';
    }
    post({ __layout: 'pickMode', pickMode: pickMode });
  };

  const setPickMode = (on) => {
    pickMode = !!on;
    syncPickerUi();
  };

  const setSelectionChip = (on, summary) => {
    selectionAttached = !!on;
    if (selectionChip) selectionChip.setAttribute('data-on', selectionAttached ? '1' : '0');
    if (selectionLabel) {
      selectionLabel.textContent = selectionAttached
        ? ('Attached: ' + (summary || 'element'))
        : 'No selection';
    }
    if (chatInput && selectionAttached) {
      chatInput.placeholder = activeAgent
        ? ('Ask about selection → ' + activeAgent + '…')
        : 'Ask about the selection…';
    } else if (chatInput) {
      chatInput.placeholder = activeAgent
        ? ('Message ' + activeAgent + '…')
        : 'Message the agent…';
    }
  };

  const clearPick = (opts) => {
    const notifyHost = !opts || opts.notifyHost !== false;
    selected = null;
    empty.style.display = 'block';
    detail.style.display = 'none';
    if (clearBtn) clearBtn.disabled = true;
    statusEl.textContent = '';
    hideCard();
    setSelectionChip(false);
    if (badge) {
      badge.textContent = pickMode ? 'pick' : 'idle';
      badge.className = 'dm-badge';
    }
    if (notifyHost) post({ __clearSelection: true });
  };

  const showPick = (payload) => {
    selected = payload;
    empty.style.display = 'none';
    detail.style.display = 'block';
    const tagEl = card.querySelector('#tachyon-dm-tag');
    const metaEl = card.querySelector('#tachyon-dm-meta');
    const textEl = card.querySelector('#tachyon-dm-text');
    const stylesEl = card.querySelector('#tachyon-dm-styles');
    const htmlEl = card.querySelector('#tachyon-dm-html');
    if (tagEl) tagEl.textContent = '<' + (payload.tag || '').toLowerCase() + '>';
    if (metaEl) {
      metaEl.textContent =
        (payload.id ? '#' + payload.id + ' ' : '') +
        (payload.className
          ? '.' + String(payload.className).trim().split(/\\s+/).filter(Boolean).slice(0, 3).join('.')
          : '');
    }
    if (textEl) textEl.textContent = payload.text || '(no text)';
    if (stylesEl) stylesEl.textContent = JSON.stringify(payload.styles || {}, null, 2);
    if (htmlEl) htmlEl.textContent = (payload.html || '').slice(0, 1200);
    if (clearBtn) clearBtn.disabled = false;
    const summary = '<' + String(payload.tag || '').toLowerCase() + '> '
      + (payload.selectorHint || payload.id || '');
    statusEl.textContent = 'Attached to chat — type your ask there (no send on this card).';
    statusEl.className = '';
    if (badge) {
      badge.textContent = 'selected';
      badge.className = 'dm-badge ok';
    }
    showCard();
    setSelectionChip(true, summary.trim());
    // Open chat so the human has one place to speak.
    if (!chatOpen) setChatOpen(true);
    try { if (chatInput) chatInput.focus(); } catch (e) {}
  };

  pickerBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setPickMode(!pickMode);
    if (pickMode) {
      statusEl.textContent = 'Picker on — click an element.';
      statusEl.className = '';
    }
  });

  if (toolbar) {
    toolbar.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-preset]') : null;
      if (!btn || !toolbar.contains(btn)) return;
      e.preventDefault();
      e.stopPropagation();
      const preset = btn.getAttribute('data-preset');
      if (preset) setResponsivePreset(preset);
    });
  }

  root.querySelector('#tachyon-dm-card-close').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearPick();
  });

  if (clearBtn) {
    clearBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearPick();
    });
  }
  if (selectionClearBtn) {
    selectionClearBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearPick();
    });
  }

  const onPageMove = (e) => {
    if (!pickMode) {
      clearHover();
      return;
    }
    if (isChrome(e.target)) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isChrome(el) || el === document.documentElement || el === document.body) return;
    if (hoverEl && hoverEl !== el) {
      try { hoverEl.style.outline = hoverEl.__tachyonPrevOutline || ''; } catch (err) {}
    }
    if (el !== hoverEl) {
      el.__tachyonPrevOutline = el.style.outline;
      el.style.outline = '2px solid ' + focusColor();
      hoverEl = el;
    }
  };

  const onPageClick = (e) => {
    if (!pickMode) return;
    if (isChrome(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isChrome(el) || el === document.documentElement || el === document.body) return;
    const payload = captureEl(el);
    // Host stores selection only — never auto-sends to the agent. Chat is the sole channel.
    showPick(payload);
    post(payload);
  };

  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (selected || card.getAttribute('data-open') === '1') {
      clearPick();
      return;
    }
    if (pickMode) setPickMode(false);
  };

  // Same-tab link/form → host re-injects Design Mode after load (address bar still ends session).
  const onInternalNavIntent = (e) => {
    if (pickMode && e.type === 'click') return;
    if (e.type === 'click') {
      const t = e.target;
      const a = t && t.closest ? t.closest('a[href]') : null;
      if (!a || isChrome(a)) return;
      const href = a.getAttribute('href') || '';
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
      if (a.target && a.target !== '' && a.target !== '_self') return;
      post({ __layout: 'internalNav' });
      return;
    }
    if (e.type === 'submit') {
      const form = e.target;
      if (form && form.target && form.target !== '' && form.target !== '_self') return;
      post({ __layout: 'internalNav' });
    }
  };

  let listenersOn = false;
  const attachListeners = () => {
    if (listenersOn) return;
    document.addEventListener('mousemove', onPageMove, true);
    document.addEventListener('click', onPageClick, true);
    document.addEventListener('click', onInternalNavIntent, true);
    document.addEventListener('submit', onInternalNavIntent, true);
    document.addEventListener('keydown', onKey, true);
    listenersOn = true;
  };
  const detachListeners = () => {
    if (!listenersOn) return;
    document.removeEventListener('mousemove', onPageMove, true);
    document.removeEventListener('click', onPageClick, true);
    document.removeEventListener('click', onInternalNavIntent, true);
    document.removeEventListener('submit', onInternalNavIntent, true);
    document.removeEventListener('keydown', onKey, true);
    listenersOn = false;
    clearHover();
  };

  const cleanup = () => {
    detachListeners();
    try { if (cardPanelApi) cardPanelApi.dispose(); } catch (e) {}
    try { if (chatPanelApi) chatPanelApi.dispose(); } catch (e) {}
    try { root.remove(); } catch (e) {}
    try {
      const st = document.getElementById('tachyon-dm-style');
      if (st) st.remove();
    } catch (e) {}
    delete window.__tachyonDmCleanup;
    delete window.__tachyonDmChatPush;
    document.documentElement.style.cursor = '';
  };

  window.__tachyonDmCleanup = cleanup;

  let finished = false;
  const finishInstall = () => {
    if (finished) return;
    finished = true;
    attachListeners();
    clearPick();
    syncResponsiveUi();
    // Design Mode ON → toolbar visible; picker state restored after re-inject.
    setPickMode(RESTORE_PICK);
  };

  if (document.body) {
    finishInstall();
  } else {
    document.addEventListener('DOMContentLoaded', finishInstall, { once: true });
    setTimeout(() => {
      if (document.body) {
        try { finishInstall(); } catch (e) {}
      }
    }, 50);
  }
  return true;
})()`;
}
