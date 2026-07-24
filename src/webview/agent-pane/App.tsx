import { useEffect, useRef } from "preact/hooks";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { AgentPaneFromHost, AgentPaneToHost } from "./protocol";

export interface AgentPaneAppProps {
  postMessage: (msg: AgentPaneToHost) => void;
  /** Subscribe to host messages; returns unsubscribe. */
  onHostMessage: (handler: (msg: AgentPaneFromHost) => void) => () => void;
}

/**
 * Full-bleed xterm viewport — no chrome. Geometry is reported to the host so the
 * node-pty attach client matches the integrated terminal's cols×rows.
 */
export function App({ postMessage, onHostMessage }: AgentPaneAppProps) {
  const termHostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = termHostRef.current;
    if (!el) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "var(--vscode-editor-font-family, Menlo, Monaco, 'Courier New', monospace)",
      fontSize: 13,
      // Solid defaults — CSS variables can resolve empty in webview and hide output.
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
    // Defer first fit so the layout has real pixel size (avoids 0×0 → wrong TUI geometry).
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
      if (msg.type === "agent-pane/init") return;
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
