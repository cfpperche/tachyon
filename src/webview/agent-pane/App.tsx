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
 * Full-bleed xterm viewport — no chrome header (title/status live on the editor tab).
 * Terminal fills 100% of the webview / editor area.
 */
export function App({ postMessage, onHostMessage }: AgentPaneAppProps) {
  const termHostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const el = termHostRef.current;
    if (!el) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "var(--vscode-editor-font-family, Menlo, Monaco, 'Courier New', monospace)",
      fontSize: 13,
      theme: {
        background: "var(--vscode-editor-background, #1e1e1e)",
        foreground: "var(--vscode-editor-foreground, #cccccc)",
        cursor: "var(--vscode-editorCursor-foreground, #aeafad)",
        selectionBackground: "var(--vscode-editor-selectionBackground, #264f78)",
      },
      allowProposedApi: true,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const dataDisp = term.onData((data) => {
      postMessage({ type: "agent-pane/input", data });
    });

    const reportSize = () => {
      fit.fit();
      postMessage({ type: "agent-pane/resize", cols: term.cols, rows: term.rows });
    };
    reportSize();

    const ro = new ResizeObserver(() => reportSize());
    ro.observe(el);

    const unsub = onHostMessage((msg) => {
      if (msg.type === "agent-pane/init") {
        // Title is the editor tab; nothing to paint in-pane.
        return;
      }
      if (msg.type === "agent-pane/data") {
        term.write(msg.data);
        return;
      }
      if (msg.type === "agent-pane/status") {
        return;
      }
      if (msg.type === "agent-pane/exit") {
        term.writeln("\r\n\x1b[33m[Tachyon] attach ended — reopen the pane or use integrated terminal.\x1b[0m");
      }
    });

    postMessage({ type: "agent-pane/ready" });

    return () => {
      unsub();
      ro.disconnect();
      dataDisp.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [postMessage, onHostMessage]);

  return (
    <div class="agent-pane">
      <div class="agent-pane__term" ref={termHostRef} />
    </div>
  );
}
