import { useEffect, useRef } from "preact/hooks";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { AgentPaneFontMetrics, AgentPaneFromHost, AgentPaneToHost } from "./protocol";

export interface AgentPaneAppProps {
  postMessage: (msg: AgentPaneToHost) => void;
  /** Subscribe to host messages; returns unsubscribe. */
  onHostMessage: (handler: (msg: AgentPaneFromHost) => void) => () => void;
}

/** Fallback when host has not yet sent font metrics (first paint before init). */
const FALLBACK_FONT: AgentPaneFontMetrics = {
  fontFamily: "Menlo, Monaco, 'Courier New', monospace",
  fontSize: 14,
  fontWeight: "normal",
  fontWeightBold: "bold",
  lineHeight: 1,
  letterSpacing: 0,
};

function applyFont(term: Terminal, font: AgentPaneFontMetrics): void {
  // xterm accepts string | number for fontWeight*; cast through unknown for the union.
  term.options.fontFamily = font.fontFamily;
  term.options.fontSize = font.fontSize;
  term.options.fontWeight = font.fontWeight as never;
  term.options.fontWeightBold = font.fontWeightBold as never;
  term.options.lineHeight = font.lineHeight;
  term.options.letterSpacing = font.letterSpacing;
}

/**
 * Full-bleed xterm viewport — typography comes from host (terminal.integrated.*).
 */
export function App({ postMessage, onHostMessage }: AgentPaneAppProps) {
  const termHostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = termHostRef.current;
    if (!el) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: FALLBACK_FONT.fontFamily,
      fontSize: FALLBACK_FONT.fontSize,
      fontWeight: FALLBACK_FONT.fontWeight as "normal",
      fontWeightBold: FALLBACK_FONT.fontWeightBold as "bold",
      lineHeight: FALLBACK_FONT.lineHeight,
      letterSpacing: FALLBACK_FONT.letterSpacing,
      // Solid theme defaults (CSS vars are unreliable for xterm cell measurement).
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

    const fitSoon = () => {
      try {
        fit.fit();
        if (term.cols >= 2 && term.rows >= 1) {
          postMessage({ type: "agent-pane/resize", cols: term.cols, rows: term.rows });
        }
      } catch {
        /* container may not be ready */
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(fitSoon));

    const dataDisp = term.onData((data) => {
      postMessage({ type: "agent-pane/input", data });
    });

    const ro = new ResizeObserver(() => fitSoon());
    ro.observe(el);

    const unsub = onHostMessage((msg) => {
      if (msg.type === "agent-pane/init") {
        if (msg.font) {
          applyFont(term, msg.font);
          // Font metrics change cell size → re-fit and re-report geometry to PTY.
          fitSoon();
        }
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

    postMessage({ type: "agent-pane/ready" });

    return () => {
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
