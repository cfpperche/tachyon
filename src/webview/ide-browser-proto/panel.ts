import * as vscode from "vscode";
import { mapDisplayClickToViewport } from "./coords.js";
import { IdeBrowserSession } from "./session.js";
import {
  formatPickForAgent,
  type IdeBrowserFromWeb,
  type IdeBrowserPickPayload,
  type IdeBrowserToWeb,
} from "./types.js";

const VIEW_TYPE = "tachyonIdeBrowserProto";

let active: { panel: vscode.WebviewPanel; session: IdeBrowserSession } | undefined;

/**
 * Open (or focus) the Option A IDE browser prototype panel.
 * Caller must ensure Dev Host / Development mode gate already passed.
 */
export async function openIdeBrowserProtoPanel(context: vscode.ExtensionContext): Promise<void> {
  if (active) {
    active.panel.reveal(vscode.ViewColumn.Beside, false);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    "IDE Browser (prototype)",
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    },
  );
  panel.webview.html = buildHtml(panel.webview.cspSource);

  let lastPick: IdeBrowserPickPayload | null = null;
  let designMode = false;
  let lastCss = { cssW: 1024, cssH: 720 };

  const post = (msg: IdeBrowserToWeb): void => {
    void panel.webview.postMessage(msg);
  };

  const session = new IdeBrowserSession({
    startUrl: "https://example.com",
    // UI-design defaults: larger CSS viewport + 2× DPR + PNG (no JPEG mush).
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    screencastFormat: "png",
    screencastEveryNthFrame: 1,
    onFrame: (frame) => {
      lastCss = { cssW: frame.cssW, cssH: frame.cssH };
      post({
        type: "frame",
        dataUrl: frame.dataUrl,
        cssW: frame.cssW,
        cssH: frame.cssH,
        url: frame.url,
        source: frame.source,
      });
    },
    onStatus: (text, opts) => {
      post({
        type: "status",
        text,
        url: opts?.url,
        error: opts?.error,
        designMode,
      });
    },
  });

  active = { panel, session };

  const sub = panel.webview.onDidReceiveMessage(async (raw: IdeBrowserFromWeb) => {
    if (!raw || typeof raw !== "object" || !("type" in raw)) return;
    try {
      switch (raw.type) {
        case "ready":
          post({ type: "status", text: "Starting Chrome…", designMode });
          await session.start();
          break;
        case "navigate":
          await session.navigate(raw.url);
          break;
        case "reload":
          await session.reload();
          break;
        case "setDesignMode":
          designMode = !!raw.on;
          post({ type: "designMode", on: designMode });
          post({
            type: "status",
            text: designMode ? "Design Mode ON — click an element to capture" : "Design Mode off — clicks interact",
            url: session.url,
            designMode,
          });
          break;
        case "click": {
          const mapped = mapDisplayClickToViewport({
            x: raw.x,
            y: raw.y,
            displayW: raw.displayW,
            displayH: raw.displayH,
            cssW: lastCss.cssW,
            cssH: lastCss.cssH,
          });
          if (!mapped) {
            post({ type: "status", text: "Click outside page content (letterbox)", designMode });
            break;
          }
          if (designMode) {
            lastPick = await session.pickAt(mapped.x, mapped.y);
            post({ type: "pick", payload: lastPick });
            post({
              type: "status",
              text: lastPick
                ? `Picked <${lastPick.tag.toLowerCase()}> — use Copy for agent`
                : "No element under cursor",
              url: session.url,
              designMode,
            });
          } else {
            await session.clickAt(mapped.x, mapped.y);
          }
          break;
        }
        case "copyPick":
          if (!lastPick) {
            void vscode.window.showWarningMessage("IDE Browser prototype: no pick yet (enable Design Mode and click).");
            break;
          }
          await vscode.env.clipboard.writeText(formatPickForAgent(lastPick));
          void vscode.window.showInformationMessage("IDE Browser prototype: pick copied to clipboard.");
          break;
        default:
          break;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      post({ type: "status", text: msg, error: true, designMode });
    }
  });

  panel.onDidDispose(() => {
    sub.dispose();
    void session.dispose();
    if (active?.panel === panel) active = undefined;
  });

  context.subscriptions.push({
    dispose: () => {
      void session.dispose();
      try {
        panel.dispose();
      } catch {
        // already disposed
      }
    },
  });
}

function buildHtml(cspSource: string): string {
  const nonce = String(Date.now()) + Math.random().toString(36).slice(2);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src data: ${cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>IDE Browser prototype</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #1e1e1e;
      --panel: #252526;
      --border: #3c3c3c;
      --fg: #cccccc;
      --muted: #858585;
      --accent: #0e639c;
      --danger: #f14c4c;
      --ok: #89d185;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); font: 13px/1.4 system-ui, sans-serif; }
    #app { display: flex; flex-direction: column; height: 100%; }
    header {
      display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
      padding: 8px; background: var(--panel); border-bottom: 1px solid var(--border);
    }
    header input[type="text"] {
      flex: 1 1 200px; min-width: 120px; padding: 6px 8px;
      border: 1px solid var(--border); border-radius: 4px; background: #1a1a1a; color: var(--fg);
    }
    button {
      padding: 6px 10px; border: 1px solid var(--border); border-radius: 4px;
      background: #2d2d2d; color: var(--fg); cursor: pointer;
    }
    button:hover { background: #3a3a3a; }
    button.primary { background: var(--accent); border-color: #1177bb; }
    button.active { outline: 1px solid var(--ok); }
    #status { font-size: 12px; color: var(--muted); padding: 4px 8px; border-bottom: 1px solid var(--border); }
    #status.err { color: var(--danger); }
    main { flex: 1; min-height: 0; display: flex; }
    #stage {
      flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center;
      background: #111; position: relative; overflow: hidden;
    }
    /* Canvas (not <img>): swapping img.src every frame blanks between decodes → flicker.
       We drawImage only after decode; previous bitmap stays visible. */
    #frame {
      max-width: 100%; max-height: 100%; width: auto; height: auto;
      object-fit: contain; cursor: crosshair;
      background: #000; user-select: none; display: block;
    }
    #frame.interact { cursor: default; }
    aside {
      width: 280px; max-width: 40%; border-left: 1px solid var(--border);
      background: var(--panel); padding: 8px; overflow: auto; font-size: 12px;
    }
    aside h2 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
    aside pre {
      white-space: pre-wrap; word-break: break-word; margin: 0;
      background: #1a1a1a; border: 1px solid var(--border); border-radius: 4px; padding: 8px;
    }
    .badge {
      font-size: 11px; padding: 2px 6px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted);
    }
    .badge.on { color: var(--ok); border-color: var(--ok); }
  </style>
</head>
<body>
  <div id="app">
    <header>
      <span class="badge" id="modeBadge">interact</span>
      <input id="url" type="text" spellcheck="false" placeholder="https://example.com" value="https://example.com" />
      <button class="primary" id="go" type="button">Go</button>
      <button id="reload" type="button">Reload</button>
      <button id="design" type="button">Design Mode</button>
      <button id="copy" type="button">Copy for agent</button>
    </header>
    <div id="status">Booting…</div>
    <main>
      <div id="stage">
        <canvas id="frame" class="interact" width="1024" height="720" aria-label="Browser stream"></canvas>
      </div>
      <aside>
        <h2>Last pick</h2>
        <pre id="pick">Design Mode + click an element.</pre>
      </aside>
    </main>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const urlEl = document.getElementById('url');
    const statusEl = document.getElementById('status');
    const frameEl = document.getElementById('frame');
    const pickEl = document.getElementById('pick');
    const designBtn = document.getElementById('design');
    const modeBadge = document.getElementById('modeBadge');
    const ctx = frameEl.getContext('2d', { alpha: false, desynchronized: true });
    let designMode = false;
    let cssW = 1024, cssH = 720;
    // Stream/status used to stomp the address bar every ~350ms while typing.
    // Only mirror host URL when the field is idle (not focused, not dirty).
    let urlDirty = false;
    let lastCommittedUrl = urlEl.value || '';
    // Double-buffer decode: never blank the canvas between frames (fixes flicker from img.src thrash).
    const decodePool = [new Image(), new Image()];
    let decodeIdx = 0;
    let loadGen = 0;
    let pendingFrame = null;
    let rafId = 0;

    function setStatus(text, err) {
      // Skip fps telemetry spam on the main status line (was noisy; not a flicker source but clutter).
      if (typeof text === 'string' && text.startsWith('Screencast ~') && !err) {
        modeBadge.title = text;
        return;
      }
      statusEl.textContent = text || '';
      statusEl.classList.toggle('err', !!err);
    }
    function setDesign(on) {
      designMode = !!on;
      designBtn.classList.toggle('active', designMode);
      modeBadge.textContent = designMode ? 'design' : 'interact';
      modeBadge.classList.toggle('on', designMode);
      frameEl.classList.toggle('interact', !designMode);
    }
    function syncUrlBar(url) {
      if (!url || typeof url !== 'string') return;
      lastCommittedUrl = url;
      if (urlDirty || document.activeElement === urlEl) return;
      if (urlEl.value !== url) urlEl.value = url;
    }
    function submitNavigate() {
      urlDirty = false;
      vscode.postMessage({ type: 'navigate', url: urlEl.value });
    }
    function paintDecoded(img) {
      if (!ctx || !img.naturalWidth) return;
      if (frameEl.width !== img.naturalWidth || frameEl.height !== img.naturalHeight) {
        frameEl.width = img.naturalWidth;
        frameEl.height = img.naturalHeight;
      }
      // High-quality downsample when CSS shrinks a 2× bitmap into the panel.
      ctx.imageSmoothingEnabled = true;
      if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0);
    }
    function beginDecode(dataUrl) {
      const gen = ++loadGen;
      const img = decodePool[decodeIdx];
      decodeIdx = 1 - decodeIdx;
      img.onload = () => {
        if (gen !== loadGen) return; // a newer frame already started decoding
        paintDecoded(img);
      };
      img.onerror = () => { /* keep previous canvas bitmap */ };
      img.src = dataUrl;
    }
    function queueFrame(msg) {
      pendingFrame = msg;
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        const m = pendingFrame;
        pendingFrame = null;
        if (!m || !m.dataUrl) return;
        cssW = m.cssW || cssW;
        cssH = m.cssH || cssH;
        if (m.url) syncUrlBar(m.url);
        beginDecode(m.dataUrl);
      });
    }

    urlEl.addEventListener('input', () => { urlDirty = true; });
    urlEl.addEventListener('focus', () => { urlDirty = true; });
    urlEl.addEventListener('blur', () => {
      // If user left the field without Go/Enter, keep their text until they navigate
      // (do not immediately re-stomp). Host still owns lastCommittedUrl for frames.
    });
    document.getElementById('go').addEventListener('click', submitNavigate);
    urlEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitNavigate();
      } else if (e.key === 'Escape') {
        urlDirty = false;
        urlEl.value = lastCommittedUrl;
        urlEl.blur();
      }
    });
    document.getElementById('reload').addEventListener('click', () => {
      urlDirty = false;
      vscode.postMessage({ type: 'reload' });
    });
    designBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'setDesignMode', on: !designMode });
    });
    document.getElementById('copy').addEventListener('click', () => {
      vscode.postMessage({ type: 'copyPick' });
    });
    frameEl.addEventListener('click', (e) => {
      const rect = frameEl.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      vscode.postMessage({
        type: 'click',
        x, y,
        displayW: rect.width,
        displayH: rect.height,
        designMode,
      });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || !msg.type) return;
      if (msg.type === 'status') {
        setStatus(msg.text, msg.error);
        if (typeof msg.url === 'string' && msg.url) {
          // After a successful navigate/reload, accept host URL even if we were dirty.
          if (!msg.error && typeof msg.text === 'string'
              && (msg.text === 'Ready' || msg.text === 'Reloaded'
                  || msg.text.startsWith('Ready ') || msg.text.startsWith('Reloaded '))) {
            urlDirty = false;
          }
          syncUrlBar(msg.url);
        }
        if (typeof msg.designMode === 'boolean') setDesign(msg.designMode);
      } else if (msg.type === 'frame') {
        queueFrame(msg);
      } else if (msg.type === 'designMode') {
        setDesign(msg.on);
      } else if (msg.type === 'pick') {
        if (!msg.payload) {
          pickEl.textContent = '(no element)';
          return;
        }
        const p = msg.payload;
        pickEl.textContent = JSON.stringify({
          tag: p.tag, id: p.id, className: p.className, text: p.text,
          bounds: p.bounds, styles: p.styles, url: p.url,
          htmlPreview: (p.html || '').slice(0, 500),
        }, null, 2);
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
