/**
 * In-page Design Mode inject for the Integrated Browser tab.
 *
 * Layout (companion-style, not overlay):
 * - Status bar ON → two framed panels immediately (live page DOM + side panel)
 * - Status bar OFF → widget removed entirely
 * - Site is the *already loaded* document moved into a scroll viewport (NOT an iframe).
 *   iframe.src=location fails on many sites (X-Frame-Options / CSP frame-ancestors).
 *
 * Tokens: host passes resolved --ds-* from the live VS Code theme (same source as webviews).
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
  /** Side panel width in CSS px (companion ~320–400). */
  panelWidth?: number;
  /**
   * After navigation re-inject: re-open the side panel (empty pick).
   * Default false — launcher only.
   */
  restorePanelOpen?: boolean;
  /**
   * Restore picker armed state (true = intercept clicks; false = browse links).
   * Default true.
   */
  restorePickMode?: boolean;
};

/**
 * Build a Runtime.evaluate expression that installs (or reinstalls) Design Mode UI.
 */
export function buildDesignModeInjectExpression(
  bindingNameOrOptions: string | DesignModeInjectOptions,
): string {
  const opts: DesignModeInjectOptions =
    typeof bindingNameOrOptions === "string"
      ? { bindingName: bindingNameOrOptions }
      : bindingNameOrOptions;

  const bindingName = opts.bindingName;
  const panelWidth = Math.max(240, Math.min(opts.panelWidth ?? 340, 720));
  const restorePanelOpen = opts.restorePanelOpen === true;
  const restorePickMode = opts.restorePickMode !== false;
  const themeVars = opts.themeVars ?? fallbackDsTokens();
  const themeCss = formatDmThemeCssBlock(
    themeVars,
    "#tachyon-dm-root, #tachyon-dm-shell, #tachyon-dm-panel, #tachyon-dm-site-card, #tachyon-dm-sep",
  );

  return `(() => {
  const BIND = ${JSON.stringify(bindingName)};
  const STYLE_KEYS = ${JSON.stringify([...STYLE_KEYS])};
  const PANEL_W0 = ${JSON.stringify(panelWidth)};
  const RESTORE_PANEL = ${JSON.stringify(restorePanelOpen)};
  const RESTORE_PICK = ${JSON.stringify(restorePickMode)};
  if (window.__tachyonDmCleanup) {
    try { window.__tachyonDmCleanup(); } catch (e) {}
  }
  window.__tachyonDmQueue = window.__tachyonDmQueue || [];
  let hoverEl = null;
  let selected = null;
  let shellActive = false;
  let pickMode = RESTORE_PICK;
  let panelW = PANEL_W0;
  let savedBodyAttr = null;
  let savedHtmlAttr = null;
  let sashCleanup = null;
  const ROOT_ID = 'tachyon-dm-root';
  const SHELL_ID = 'tachyon-dm-shell';
  const VIEWPORT_ID = 'tachyon-dm-viewport';
  const SITE_CARD_ID = 'tachyon-dm-site-card';

  const post = (obj) => {
    const raw = JSON.stringify(obj);
    window.__tachyonDmQueue.push(raw);
    try {
      if (typeof window[BIND] === 'function') window[BIND](raw);
    } catch (e) {}
  };

  // Tachyon chrome only — page content lives inside #tachyon-dm-viewport and is pickable.
  const isChrome = (el) => !!(
    el && el.closest && (
      el.closest('#' + ROOT_ID)
      || el.closest('#tachyon-dm-panel')
      || el.closest('#tachyon-dm-sep')
    )
  );

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
      const v = getComputedStyle(panel).getPropertyValue('--ds-focus').trim();
      if (v) return v;
    } catch (e) {}
    return '#007fd4';
  };

  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.setAttribute('data-tachyon-dm', '1');
  root.innerHTML = \`
    <style id="tachyon-dm-style">
      /* Live VS Code theme → --ds-* (sampled by host; same mapping as webview design-system) */
      ${themeCss}

      #tachyon-dm-root {
        all: initial;
        font-family: var(--ds-mono);
        font-size: var(--ds-body);
        color: var(--ds-fg);
        pointer-events: none;
      }
      #tachyon-dm-root *, #tachyon-dm-panel *, #tachyon-dm-shell * {
        box-sizing: border-box;
      }
      #tachyon-dm-root button,
      #tachyon-dm-root textarea,
      #tachyon-dm-panel button,
      #tachyon-dm-panel textarea { pointer-events: auto; font-family: var(--ds-mono); }

      #tachyon-dm-fab {
        pointer-events: auto;
        position: fixed;
        z-index: 2147483646;
        right: var(--ds-4);
        bottom: 20px;
        width: 40px;
        height: 40px;
        border-radius: 999px;
        border: var(--ds-border-width) solid var(--ds-border);
        background: var(--ds-btn-bg);
        color: var(--ds-btn-fg);
        font-size: 16px;
        line-height: 1;
        cursor: pointer;
        box-shadow: var(--ds-shadow-2);
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      #tachyon-dm-fab:hover { background: var(--ds-btn-hover); }
      #tachyon-dm-fab[data-open="1"] { display: none; }

      /* Shell: soft pad + gap (VS Code separator color) — two framed cards */
      #tachyon-dm-shell {
        position: fixed !important;
        inset: 0 !important;
        z-index: 2147483645 !important;
        display: flex !important;
        flex-direction: row !important;
        align-items: stretch !important;
        gap: var(--ds-3) !important;
        width: 100vw !important;
        height: 100vh !important;
        margin: 0 !important;
        padding: var(--ds-3) !important;
        overflow: hidden !important;
        background: var(--ds-editor-bg) !important;
        font-family: var(--ds-mono);
        color: var(--ds-fg);
      }

      /* Card chrome shared by site frame + panel */
      .tachyon-dm-card {
        border: var(--ds-border-width) solid var(--ds-border) !important;
        border-radius: var(--ds-radius) !important;
        box-shadow: var(--ds-shadow-1) !important;
        overflow: hidden !important;
        min-height: 0 !important;
        background: var(--ds-card) !important;
      }

      /* VS Code-style sash: 4px hit target, 1px hairline using user separator tokens */
      #tachyon-dm-sep {
        flex: 0 0 4px !important;
        width: 4px !important;
        min-width: 4px !important;
        align-self: stretch !important;
        position: relative !important;
        margin: var(--ds-1) 0 !important;
        padding: 0 !important;
        border: 0 !important;
        background: transparent !important;
        cursor: col-resize !important;
        z-index: 5 !important;
        touch-action: none;
      }
      #tachyon-dm-sep::before {
        content: '';
        position: absolute;
        left: 50%;
        top: 0;
        bottom: 0;
        width: 1px;
        transform: translateX(-50%);
        background: var(--ds-separator, var(--ds-border));
        opacity: 0.9;
        pointer-events: none;
      }
      #tachyon-dm-sep:hover::before,
      #tachyon-dm-sep.dragging::before {
        width: 2px;
        background: var(--ds-sash-hover, var(--ds-focus));
        opacity: 1;
      }
      #tachyon-dm-shell.resizing {
        cursor: col-resize !important;
        user-select: none !important;
      }
      #tachyon-dm-shell.resizing #tachyon-dm-viewport {
        pointer-events: none !important;
      }

      #tachyon-dm-site-card {
        flex: 1 1 auto !important;
        min-width: 200px !important;
        min-height: 0 !important;
        width: 0 !important;
        display: flex !important;
        flex-direction: column !important;
        background: #fff !important;
        overflow: hidden !important;
        /* Clip anything that still escapes the card chrome */
        isolation: isolate !important;
      }

      /*
       * Live page DOM (not iframe). iframe.src=location is blank on X-Frame-Options /
       * CSP frame-ancestors sites (Google, banks, many SPAs).
       *
       * Fixed headers: CSS position spec / MDN — position:fixed is relative to the
       * viewport UNLESS an ancestor has transform/filter/perspective/will-change:transform,
       * which then becomes the containing block. transform:translateZ(0) is the standard
       * way to "contain fixed" inside a panel (see MDN position#fixed_positioning,
       * CSS Transforms § containing block for fixed descendants).
       */
      #tachyon-dm-viewport {
        flex: 1 1 auto !important;
        min-width: 0 !important;
        min-height: 0 !important;
        width: 100% !important;
        height: 100% !important;
        overflow: auto !important;
        overflow-x: hidden !important;
        position: relative !important;
        /* Creates fixed-position containing block for headers/navs inside the site */
        transform: translateZ(0) !important;
        -webkit-transform: translateZ(0) !important;
        will-change: transform;
        /* Sticky also resolves against this scrollport */
        overscroll-behavior: contain;
        background: transparent;
      }
      #tachyon-dm-viewport img,
      #tachyon-dm-viewport video,
      #tachyon-dm-viewport canvas,
      #tachyon-dm-viewport svg,
      #tachyon-dm-viewport iframe,
      #tachyon-dm-viewport table {
        max-width: 100% !important;
      }

      #tachyon-dm-panel {
        flex: 0 0 \${PANEL_W0}px !important;
        width: \${PANEL_W0}px !important;
        min-width: 240px !important;
        max-width: none !important;
        height: auto !important;
        align-self: stretch !important;
        display: none;
        flex-direction: column;
        background: var(--ds-sidebar-bg) !important;
        color: var(--ds-fg);
        font-family: var(--ds-mono);
        font-size: var(--ds-small);
        overflow: hidden;
      }
      #tachyon-dm-shell #tachyon-dm-panel,
      #tachyon-dm-panel[data-open="1"] {
        display: flex !important;
      }
      #tachyon-dm-root > #tachyon-dm-panel { display: none !important; }

      #tachyon-dm-panel header.dm-chrome {
        padding: var(--ds-3) var(--ds-4);
        border-bottom: var(--ds-border-width) solid var(--ds-border);
        display: flex;
        align-items: center;
        gap: var(--ds-2);
        flex: 0 0 auto;
        background: var(--ds-sidebar-bg);
      }
      #tachyon-dm-panel header.dm-chrome .dm-title {
        font-size: var(--ds-title);
        font-weight: var(--tachyon-weight-semibold);
        margin: 0;
        line-height: 1.2;
        color: var(--ds-fg);
      }
      .dm-badge {
        font-size: var(--ds-micro);
        line-height: 1.6;
        padding: 1px 9px;
        border-radius: 10px;
        border: 1px solid color-mix(in srgb, var(--ds-info) 55%, transparent);
        color: var(--ds-info);
        white-space: nowrap;
      }
      .dm-badge.ok {
        color: var(--ds-ok);
        border-color: color-mix(in srgb, var(--ds-ok) 55%, transparent);
      }
      .dm-pick-toggle {
        min-height: 28px;
        padding: var(--ds-1) var(--ds-2);
        border-radius: var(--ds-radius);
        border: var(--ds-border-width) solid var(--ds-border);
        background: transparent;
        color: var(--ds-muted);
        cursor: pointer;
        font: inherit;
        font-size: var(--ds-micro);
        white-space: nowrap;
      }
      .dm-pick-toggle:hover { background: var(--ds-hover); color: var(--ds-fg); }
      .dm-pick-toggle[aria-pressed="true"] {
        color: var(--ds-ok);
        border-color: color-mix(in srgb, var(--ds-ok) 55%, transparent);
      }
      .dm-pick-toggle[aria-pressed="false"] {
        color: var(--ds-muted);
      }
      .dm-close {
        margin-left: auto;
        min-height: 28px;
        padding: var(--ds-1) var(--ds-2);
        border-radius: var(--ds-radius);
        border: var(--ds-border-width) solid var(--ds-border);
        background: transparent;
        color: var(--ds-muted);
        cursor: pointer;
        font: inherit;
        font-size: var(--ds-small);
      }
      .dm-close:hover { background: var(--ds-hover); color: var(--ds-fg); }

      #tachyon-dm-body {
        flex: 1 1 auto;
        overflow: auto;
        padding: var(--ds-3) var(--ds-4);
        background: var(--ds-sidebar-bg);
      }
      #tachyon-dm-empty {
        color: var(--ds-muted);
        font-size: var(--ds-small);
        line-height: 1.45;
      }
      .dm-section {
        font-size: var(--ds-section);
        font-weight: var(--tachyon-weight-semibold);
        text-transform: uppercase;
        letter-spacing: var(--tachyon-tracking-label);
        color: var(--ds-muted);
        margin: var(--ds-3) 0 var(--ds-1);
      }
      .dm-section:first-child { margin-top: 0; }
      .dm-tagline {
        font-size: var(--ds-body);
        font-weight: var(--tachyon-weight-semibold);
        margin: 0 0 var(--ds-1);
        color: var(--ds-fg);
      }
      .dm-meta { color: var(--ds-muted); font-size: var(--ds-micro); }
      .dm-card {
        background: var(--ds-card);
        border: var(--ds-border-width) solid var(--ds-border);
        border-radius: var(--ds-radius);
        padding: var(--ds-2);
        margin: 0 0 var(--ds-2);
      }
      #tachyon-dm-body pre {
        white-space: pre-wrap;
        word-break: break-word;
        overflow-wrap: anywhere;
        background: var(--ds-input-bg);
        color: var(--ds-input-fg);
        border: var(--ds-border-width) solid var(--ds-border);
        border-radius: var(--ds-radius);
        padding: var(--ds-2);
        max-height: 120px;
        overflow: auto;
        margin: 0;
        font-size: var(--ds-micro);
        line-height: 1.4;
        font-family: var(--ds-mono);
      }
      #tachyon-dm-note {
        width: 100%;
        min-height: 72px;
        margin: 0;
        background: var(--ds-input-bg);
        color: var(--ds-input-fg);
        border: var(--ds-border-width) solid var(--ds-border);
        border-radius: var(--ds-radius);
        padding: var(--ds-2) var(--ds-3);
        font: inherit;
        font-size: var(--ds-small);
        resize: vertical;
      }
      #tachyon-dm-note:focus {
        outline: 1px solid var(--ds-focus);
        outline-offset: 1px;
      }
      #tachyon-dm-status {
        font-size: var(--ds-micro);
        color: var(--ds-ok);
        padding: 0 var(--ds-4) var(--ds-2);
        min-height: 1.2em;
        background: var(--ds-sidebar-bg);
      }
      #tachyon-dm-status.err { color: var(--ds-err); }
      #tachyon-dm-actions {
        padding: var(--ds-3) var(--ds-4);
        border-top: var(--ds-border-width) solid var(--ds-border);
        display: flex;
        flex-wrap: wrap;
        gap: var(--ds-2);
        flex: 0 0 auto;
        background: var(--ds-sidebar-bg);
      }
      .dm-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: var(--ds-icon-gap);
        flex: 1 1 auto;
        min-height: 28px;
        padding: var(--ds-control-pad-y) var(--ds-control-pad-x);
        border-radius: var(--ds-radius);
        border: var(--ds-border-width) solid var(--ds-border);
        background: transparent;
        color: var(--ds-fg);
        cursor: pointer;
        font: inherit;
        font-size: var(--ds-small);
      }
      .dm-btn:hover { background: var(--ds-hover); }
      .dm-btn:disabled { opacity: var(--ds-disabled-opacity); cursor: default; }
      .dm-btn.primary {
        background: var(--ds-btn-bg);
        color: var(--ds-btn-fg);
        border-color: transparent;
        font-weight: var(--tachyon-weight-semibold);
      }
      .dm-btn.primary:hover { background: var(--ds-btn-hover); }
      .dm-btn.primary:disabled { opacity: var(--ds-disabled-opacity); }
    </style>
    <button type="button" id="tachyon-dm-fab" title="Open Design Mode panel" aria-label="Open Design Mode panel">✦</button>
    <aside id="tachyon-dm-panel" class="tachyon-dm-card" aria-label="Tachyon Design Mode" data-open="0">
      <header class="dm-chrome">
        <h1 class="dm-title">Design Mode</h1>
        <span class="dm-badge" id="tachyon-dm-badge">pick</span>
        <button type="button" class="dm-pick-toggle" id="tachyon-dm-pick-toggle" aria-pressed="true" title="When off, page links and controls work normally">Picker on</button>
        <button type="button" class="dm-close" id="tachyon-dm-close" title="Close panel">Close</button>
      </header>
      <div id="tachyon-dm-body">
        <div id="tachyon-dm-empty">
          <strong>Picker on:</strong> click an element to inspect it.<br/>
          <strong>Picker off:</strong> click links and use the page normally.<br/>
          Toggle with the button above. Design Mode exits only from the VS Code status bar.
        </div>
        <div id="tachyon-dm-detail" style="display:none">
          <div class="dm-tagline"><span id="tachyon-dm-tag"></span></div>
          <div class="dm-meta" id="tachyon-dm-meta"></div>
          <div class="dm-section">Text</div>
          <div class="dm-card"><pre id="tachyon-dm-text"></pre></div>
          <div class="dm-section">Styles</div>
          <div class="dm-card"><pre id="tachyon-dm-styles"></pre></div>
          <div class="dm-section">HTML</div>
          <div class="dm-card"><pre id="tachyon-dm-html"></pre></div>
          <div class="dm-section">Note for agent</div>
          <textarea id="tachyon-dm-note" placeholder="e.g. increase padding / fix contrast"></textarea>
        </div>
      </div>
      <div id="tachyon-dm-status"></div>
      <div id="tachyon-dm-actions">
        <button type="button" class="dm-btn primary" id="tachyon-dm-send" disabled>Send to agent</button>
        <button type="button" class="dm-btn" id="tachyon-dm-clear" disabled>Clear</button>
      </div>
    </aside>
  \`;

  document.documentElement.appendChild(root);
  const styleEl = root.querySelector('#tachyon-dm-style');
  if (styleEl) document.documentElement.appendChild(styleEl);

  const panel = root.querySelector('#tachyon-dm-panel');
  const fab = root.querySelector('#tachyon-dm-fab');
  const empty = root.querySelector('#tachyon-dm-empty');
  const detail = root.querySelector('#tachyon-dm-detail');
  const sendBtn = root.querySelector('#tachyon-dm-send');
  const clearBtn = root.querySelector('#tachyon-dm-clear');
  const statusEl = root.querySelector('#tachyon-dm-status');
  const noteEl = root.querySelector('#tachyon-dm-note');
  const badge = root.querySelector('#tachyon-dm-badge');
  const pickToggle = root.querySelector('#tachyon-dm-pick-toggle');

  const clearHover = () => {
    if (hoverEl) {
      try { hoverEl.style.outline = hoverEl.__tachyonPrevOutline || ''; } catch (e) {}
      hoverEl = null;
    }
  };

  const applyPanelWidth = (w) => {
    const max = Math.max(280, window.innerWidth - 220);
    panelW = Math.max(240, Math.min(Math.round(w), max));
    panel.style.flex = '0 0 ' + panelW + 'px';
    panel.style.width = panelW + 'px';
    panel.style.minWidth = '240px';
    panel.style.maxWidth = 'none';
  };

  const syncPickChrome = () => {
    if (pickToggle) {
      pickToggle.setAttribute('aria-pressed', pickMode ? 'true' : 'false');
      pickToggle.textContent = pickMode ? 'Picker on' : 'Picker off';
      pickToggle.title = pickMode
        ? 'Picker armed — click elements to inspect. Turn off to use links.'
        : 'Picker off — page is interactive. Turn on to inspect elements.';
    }
    if (badge && !selected) {
      badge.textContent = pickMode ? 'pick' : 'browse';
      badge.className = pickMode ? 'dm-badge' : 'dm-badge ok';
    }
    // Cursor: crosshair only while pick is armed.
    try {
      document.documentElement.style.cursor = pickMode ? 'crosshair' : '';
    } catch (e) {}
    fab.title = pickMode
      ? 'Open Design Mode panel (picker on)'
      : 'Open Design Mode panel (picker off — page clickable)';
  };

  const setPickMode = (on) => {
    pickMode = !!on;
    clearHover();
    syncPickChrome();
    post({ __layout: 'pickMode', pickMode: pickMode });
  };

  const bindSash = (shell, sep) => {
    if (sashCleanup) {
      try { sashCleanup(); } catch (e) {}
      sashCleanup = null;
    }
    sep.setAttribute('role', 'separator');
    sep.setAttribute('aria-orientation', 'vertical');
    sep.setAttribute('aria-label', 'Resize Design Mode panel');
    sep.tabIndex = 0;
    const onDown = (e) => {
      if (e.type === 'mousedown' && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = panelW;
      shell.classList.add('resizing');
      sep.classList.add('dragging');
      const onMove = (ev) => {
        // Panel is on the right: drag left → wider panel.
        const dx = startX - ev.clientX;
        applyPanelWidth(startW + dx);
      };
      const onUp = () => {
        shell.classList.remove('resizing');
        sep.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
        post({ __layout: 'resize', panelWidth: panelW });
      };
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
    };
    const onKey = (e) => {
      const step = e.shiftKey ? 40 : 16;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        applyPanelWidth(panelW + step);
        post({ __layout: 'resize', panelWidth: panelW });
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        applyPanelWidth(panelW - step);
        post({ __layout: 'resize', panelWidth: panelW });
      }
    };
    sep.addEventListener('mousedown', onDown);
    sep.addEventListener('keydown', onKey);
    sashCleanup = () => {
      sep.removeEventListener('mousedown', onDown);
      sep.removeEventListener('keydown', onKey);
    };
  };

  const openPanel = () => {
    if (!shellActive) {
      savedBodyAttr = document.body.getAttribute('style');
      savedHtmlAttr = document.documentElement.getAttribute('style');

      const shell = document.createElement('div');
      shell.id = SHELL_ID;

      const siteCard = document.createElement('div');
      siteCard.id = SITE_CARD_ID;
      siteCard.className = 'tachyon-dm-card';

      // Move the live page DOM into the site viewport (keeps render; no X-Frame block).
      const viewport = document.createElement('div');
      viewport.id = VIEWPORT_ID;
      const movers = [];
      for (const child of Array.from(document.body.childNodes)) {
        if (child === root) continue;
        if (child.nodeType === 1 && child.id === SHELL_ID) continue;
        movers.push(child);
      }
      for (const n of movers) viewport.appendChild(n);
      siteCard.appendChild(viewport);

      const sep = document.createElement('div');
      sep.id = 'tachyon-dm-sep';

      panel.classList.add('tachyon-dm-card');
      applyPanelWidth(panelW);

      document.body.appendChild(shell);
      shell.appendChild(siteCard);
      shell.appendChild(sep);
      shell.appendChild(panel);
      bindSash(shell, sep);

      document.documentElement.style.setProperty('height', '100%');
      document.documentElement.style.setProperty('overflow', 'hidden');
      document.body.style.setProperty('height', '100%');
      document.body.style.setProperty('margin', '0');
      document.body.style.setProperty('overflow', 'hidden');
      shellActive = true;
      // Keep page pick handlers — content is still in this document (inside viewport).
      attachPagePick();
    }
    panel.setAttribute('data-open', '1');
    fab.setAttribute('data-open', '1');
    applyPanelWidth(panelW);
    syncPickChrome();
    if (selected && badge) {
      badge.textContent = 'selected';
      badge.className = 'dm-badge ok';
    }
    post({ __layout: 'open', panelWidth: panelW, pickMode: pickMode });
  };

  const closePanel = () => {
    panel.setAttribute('data-open', '0');
    fab.setAttribute('data-open', '0');
    if (!shellActive) return;
    clearHover();
    if (sashCleanup) {
      try { sashCleanup(); } catch (e) {}
      sashCleanup = null;
    }
    const shell = document.getElementById(SHELL_ID);
    const viewport = document.getElementById(VIEWPORT_ID);
    root.appendChild(panel);
    // Restore page nodes to body before removing shell.
    if (viewport && shell) {
      while (viewport.firstChild) {
        document.body.insertBefore(viewport.firstChild, shell);
      }
    }
    if (shell) shell.remove();
    shellActive = false;
    if (savedBodyAttr === null) document.body.removeAttribute('style');
    else document.body.setAttribute('style', savedBodyAttr);
    if (savedHtmlAttr === null) document.documentElement.removeAttribute('style');
    else document.documentElement.setAttribute('style', savedHtmlAttr);
    savedBodyAttr = null;
    savedHtmlAttr = null;
    attachPagePick();
    syncPickChrome();
    post({ __layout: 'close', panelWidth: panelW, pickMode: pickMode });
  };

  fab.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (panel.getAttribute('data-open') === '1') closePanel();
    else openPanel();
  });
  root.querySelector('#tachyon-dm-close').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closePanel();
  });
  if (pickToggle) {
    pickToggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setPickMode(!pickMode);
      if (!pickMode) {
        statusEl.textContent = 'Picker off — click links and use the page.';
        statusEl.className = '';
      } else {
        statusEl.textContent = 'Picker on — click an element to inspect.';
        statusEl.className = '';
      }
    });
  }

  const showPick = (payload) => {
    selected = payload;
    empty.style.display = 'none';
    detail.style.display = 'block';
    const tagEl = panel.querySelector('#tachyon-dm-tag');
    const metaEl = panel.querySelector('#tachyon-dm-meta');
    const textEl = panel.querySelector('#tachyon-dm-text');
    const stylesEl = panel.querySelector('#tachyon-dm-styles');
    const htmlEl = panel.querySelector('#tachyon-dm-html');
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
    sendBtn.disabled = false;
    clearBtn.disabled = false;
    statusEl.textContent = 'Element selected — add a note and Send, or pick another.';
    statusEl.className = '';
    openPanel();
  };

  const clearPick = () => {
    selected = null;
    empty.style.display = 'block';
    detail.style.display = 'none';
    noteEl.value = '';
    sendBtn.disabled = true;
    clearBtn.disabled = true;
    statusEl.textContent = '';
    syncPickChrome();
  };

  sendBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selected) return;
    const payload = Object.assign({}, selected, {
      note: noteEl.value || undefined,
      __send: true,
    });
    post(payload);
    statusEl.textContent = 'Sent to host → agent…';
    statusEl.className = '';
  });
  clearBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearPick();
  });

  const onPageMove = (e) => {
    if (!pickMode) {
      clearHover();
      return;
    }
    if (isChrome(e.target)) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isChrome(el) || el === document.documentElement || el === document.body) return;
    if (el.id === SHELL_ID || el.id === SITE_CARD_ID || el.id === VIEWPORT_ID) return;
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
    // Picker off → normal page (links work).
    if (!pickMode) return;
    if (isChrome(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isChrome(el) || el === document.documentElement || el === document.body) return;
    if (el.id === SHELL_ID || el.id === SITE_CARD_ID || el.id === VIEWPORT_ID) return;
    const payload = captureEl(el);
    showPick(payload);
    post(Object.assign({}, payload, { __preview: true }));
  };

  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (selected) {
      clearPick();
      return;
    }
    if (panel.getAttribute('data-open') === '1') closePanel();
  };

  let pagePickAttached = false;
  const attachPagePick = () => {
    if (pagePickAttached) return;
    document.addEventListener('mousemove', onPageMove, true);
    document.addEventListener('click', onPageClick, true);
    pagePickAttached = true;
  };
  const detachPagePick = () => {
    if (!pagePickAttached) return;
    document.removeEventListener('mousemove', onPageMove, true);
    document.removeEventListener('click', onPageClick, true);
    pagePickAttached = false;
    clearHover();
  };

  const cleanup = () => {
    document.removeEventListener('keydown', onKey, true);
    detachPagePick();
    clearHover();
    if (sashCleanup) {
      try { sashCleanup(); } catch (e) {}
      sashCleanup = null;
    }
    try {
      panel.setAttribute('data-open', '0');
      fab.setAttribute('data-open', '0');
      if (shellActive) {
        const shell = document.getElementById(SHELL_ID);
        const viewport = document.getElementById(VIEWPORT_ID);
        try { root.appendChild(panel); } catch (e) {}
        if (viewport && shell) {
          while (viewport.firstChild) document.body.insertBefore(viewport.firstChild, shell);
        }
        if (shell) shell.remove();
        shellActive = false;
        if (savedBodyAttr === null) document.body.removeAttribute('style');
        else document.body.setAttribute('style', savedBodyAttr);
        if (savedHtmlAttr === null) document.documentElement.removeAttribute('style');
        else document.documentElement.setAttribute('style', savedHtmlAttr);
      }
    } catch (e) {}
    try { root.remove(); } catch (e) {}
    try {
      const st = document.getElementById('tachyon-dm-style');
      if (st) st.remove();
    } catch (e) {}
    try {
      const shell = document.getElementById(SHELL_ID);
      if (shell) {
        const viewport = document.getElementById(VIEWPORT_ID);
        if (viewport) {
          while (viewport.firstChild) document.body.appendChild(viewport.firstChild);
        }
        shell.remove();
      }
    } catch (e) {}
    delete window.__tachyonDmCleanup;
    document.documentElement.style.cursor = '';
  };

  window.__tachyonDmCleanup = cleanup;

  let finished = false;
  const finishInstall = () => {
    if (finished) return;
    finished = true;
    document.addEventListener('keydown', onKey, true);
    attachPagePick();
    // Selection always starts clean (URL change deselects).
    clearPick();
    applyPanelWidth(panelW);
    syncPickChrome();
    // Restore panel after navigation if host says so — empty pick.
    if (RESTORE_PANEL) {
      openPanel();
    }
    // Do NOT open the panel on install — launcher only (unless RESTORE_PANEL).
  };

  // addScriptToEvaluateOnNewDocument may run at document_start before <body>.
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
