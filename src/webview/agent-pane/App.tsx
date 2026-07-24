import { useEffect, useRef } from "preact/hooks";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { AgentPaneFontMetrics, AgentPaneFromHost, AgentPaneToHost } from "./protocol";
import { gridChanged, sanitizeFontMetrics, type GridSize } from "./geometry";

export interface AgentPaneAppProps {
  postMessage: (msg: AgentPaneToHost) => void;
  onHostMessage: (handler: (msg: AgentPaneFromHost) => void) => () => void;
}

const FALLBACK_FONT: AgentPaneFontMetrics = {
  fontFamily: "Menlo, Monaco, 'Courier New', monospace",
  fontSize: 14,
  fontWeight: "normal",
  fontWeightBold: "bold",
  lineHeight: 1,
  letterSpacing: 0,
};

function applyFont(term: Terminal, font: AgentPaneFontMetrics): void {
  const s = sanitizeFontMetrics(font);
  term.options.fontFamily = s.fontFamily;
  term.options.fontSize = s.fontSize;
  term.options.fontWeight = s.fontWeight as never;
  term.options.fontWeightBold = s.fontWeightBold as never;
  term.options.lineHeight = s.lineHeight;
  term.options.letterSpacing = s.letterSpacing;
}

/** Wait until document fonts used by the terminal stack are ready (or timeout). */
async function waitForFonts(fontFamily: string, fontSize: number): Promise<void> {
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts?.ready) return;
  try {
    // Load a concrete face size so metrics stabilize before FitAddon measures cells.
    const primary = fontFamily.split(",")[0]?.trim().replace(/^['"]|['"]$/g, "") ?? "monospace";
    await Promise.race([
      fonts.load(`${fontSize}px "${primary}"`),
      fonts.ready,
      new Promise<void>((r) => setTimeout(r, 800)),
    ]);
    await fonts.ready;
  } catch {
    /* ignore — fall through with best-effort metrics */
  }
}

/**
 * Full-bleed xterm. Geometry protocol:
 * 1) host sends init.font
 * 2) apply font + wait fonts.ready
 * 3) FitAddon.fit() → cols/rows
 * 4) post resize → host starts/resizes node-pty to the same grid
 * Never report geometry before fonts are applied (avoids wrong TUI layout / missing status bar).
 */
export function App({ postMessage, onHostMessage }: AgentPaneAppProps) {
  const termHostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = termHostRef.current;
    if (!el) return;

    let disposed = false;
    let fontReady = false;
    let lastGrid: GridSize = { cols: 0, rows: 0 };
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: FALLBACK_FONT.fontFamily,
      fontSize: FALLBACK_FONT.fontSize,
      fontWeight: FALLBACK_FONT.fontWeight as "normal",
      fontWeightBold: FALLBACK_FONT.fontWeightBold as "bold",
      lineHeight: FALLBACK_FONT.lineHeight,
      letterSpacing: FALLBACK_FONT.letterSpacing,
      theme: {
        background: "#1e1e1e",
        foreground: "#cccccc",
        cursor: "#aeafad",
        selectionBackground: "#264f78",
        black: "#000000",
        red: "#cd3131",
        green: "#0dbc79",
        yellow: "#e5e510",
        blue: "#2472c8",
        magenta: "#bc3fbc",
        cyan: "#11a8cd",
        white: "#e5e5e5",
        brightBlack: "#666666",
        brightRed: "#f14c4c",
        brightGreen: "#23d18b",
        brightYellow: "#f5f543",
        brightBlue: "#3b8eea",
        brightMagenta: "#d670d6",
        brightCyan: "#29b8db",
        brightWhite: "#e5e5e5",
      },
      allowProposedApi: true,
      convertEol: false,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    const reportGrid = (force = false) => {
      if (disposed || !fontReady) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      const next: GridSize = { cols: term.cols, rows: term.rows };
      if (next.cols < 2 || next.rows < 1) return;
      if (!force && !gridChanged(lastGrid, next)) return;
      lastGrid = next;
      postMessage({ type: "agent-pane/resize", cols: next.cols, rows: next.rows });
    };

    const scheduleReport = (force = false) => {
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => reportGrid(force), 40);
    };

    const dataDisp = term.onData((data) => {
      postMessage({ type: "agent-pane/input", data });
    });

    const ro = new ResizeObserver(() => scheduleReport(false));
    ro.observe(el);

    const unsub = onHostMessage((msg) => {
      if (msg.type === "agent-pane/init") {
        void (async () => {
          const font = sanitizeFontMetrics(msg.font ?? FALLBACK_FONT);
          applyFont(term, font);
          await waitForFonts(font.fontFamily, font.fontSize);
          if (disposed) return;
          fontReady = true;
          // Double rAF so layout has real pixel size after font change.
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (!disposed) reportGrid(true);
            });
          });
        })();
        return;
      }
      if (msg.type === "agent-pane/data") {
        term.write(msg.data);
        return;
      }
      if (msg.type === "agent-pane/status") return;
      if (msg.type === "agent-pane/exit") {
        term.writeln(
          "\r\n\x1b[33m[Tachyon] attach ended"
          + (msg.signal ? ` (signal ${msg.signal})` : msg.code !== null && msg.code !== undefined ? ` (code ${msg.code})` : "")
          + " — reopen the agent pane (sidebar terminal icon).\x1b[0m",
        );
      }
    });

    // Ready only — do not fit/resize until host font init (geometry must match TUI).
    postMessage({ type: "agent-pane/ready" });

    return () => {
      disposed = true;
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      unsub();
      ro.disconnect();
      dataDisp.dispose();
      term.dispose();
    };
  }, [postMessage, onHostMessage]);

  return (
    <div class="agent-pane">
      <div class="agent-pane__term" ref={termHostRef} />
    </div>
  );
}
