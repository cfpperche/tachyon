import { useEffect, useRef, useState } from "preact/hooks";
import { Terminal, type IDecoration, type IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { AgentPaneFontMetrics, AgentPaneFromHost, AgentPaneInjectKind, AgentPaneToHost } from "./protocol";
import { gridChanged, sanitizeFontMetrics, type GridSize } from "./geometry";

export interface AgentPaneAppProps {
  postMessage: (msg: AgentPaneToHost) => void;
  onHostMessage: (handler: (msg: AgentPaneFromHost) => void) => () => void;
}

const FALLBACK_FONT: AgentPaneFontMetrics = {
  fontFamily: '"DejaVu Sans Mono", "Liberation Mono", Menlo, Monaco, Consolas, "Courier New", monospace',
  fontSize: 14,
  fontWeight: "normal",
  fontWeightBold: "bold",
  lineHeight: 1,
  letterSpacing: 0,
};

const MARK_GLYPH: Record<AgentPaneInjectKind, string> = {
  stage: "·",
  submit: "▸",
  template: "◇",
};

const MARK_COLOR: Record<AgentPaneInjectKind, string> = {
  stage: "#4ec9b0",
  submit: "#569cd6",
  template: "#c586c0",
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

async function waitForFonts(fontFamily: string, fontSize: number): Promise<void> {
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts?.ready) return;
  try {
    const primary = fontFamily.split(",")[0]?.trim().replace(/^['"]|['"]$/g, "") ?? "monospace";
    await Promise.race([
      fonts.load(`${fontSize}px "${primary}"`),
      fonts.load(`${fontSize}px ${primary}`),
      fonts.ready,
      new Promise<void>((r) => setTimeout(r, 600)),
    ]);
    await fonts.ready;
  } catch {
    /* best-effort */
  }
}

/** Place a non-PTY inject marker + overview ruler tick at the current bottom line. */
export function placeInjectMarker(
  term: Terminal,
  kind: AgentPaneInjectKind,
  keep: { markers: IMarker[]; decorations: IDecoration[] },
): void {
  const marker = term.registerMarker(0);
  if (!marker) return;
  keep.markers.push(marker);
  const color = MARK_COLOR[kind];
  const decoration = term.registerDecoration({
    marker,
    overviewRulerOptions: { color, position: "center" },
  });
  if (!decoration) return;
  keep.decorations.push(decoration);
  decoration.onRender((el) => {
    el.classList.add("agent-pane__inject-mark");
    el.dataset.kind = kind;
    el.title = `Inject: ${kind}`;
    el.textContent = MARK_GLYPH[kind];
    el.style.color = color;
  });
}

/**
 * Layer-2 agent pane: identity + xterm + stage bar + Slice 2 markers / pin selection.
 */
export function App({ postMessage, onHostMessage }: AgentPaneAppProps) {
  const termHostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const marksRef = useRef<{ markers: IMarker[]; decorations: IDecoration[] }>({ markers: [], decorations: [] });
  /** Last non-empty xterm selection — survives focus steal when clicking the Pin button. */
  const lastSelectionRef = useRef("");
  const [agent, setAgent] = useState("…");
  const [status, setStatus] = useState("connecting…");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  /** True while xterm has an active (non-empty) selection — visual affordance only. */
  const [hasSelection, setHasSelection] = useState(false);

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
      fontWeight: "normal",
      fontWeightBold: "bold",
      lineHeight: 1,
      letterSpacing: 0,
      overviewRulerWidth: 14,
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
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    const reportGrid = (force = false) => {
      if (disposed || !fontReady) return;
      if (el.clientWidth < 32 || el.clientHeight < 32) return;
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

    const scheduleReport = () => {
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => reportGrid(false), 50);
    };

    const dataDisp = term.onData((data) => {
      postMessage({ type: "agent-pane/input", data });
    });
    const selDisp = term.onSelectionChange(() => {
      if (disposed) return;
      // Application mouse mode (Claude/Codex TUIs) often paints reverse-video "selection" and
      // copies to the clipboard itself — that is NOT term.getSelection(). Real xterm selection
      // needs Shift+drag (or happens when mouse reporting is off). Cache non-empty selections so
      // clicking Pin does not lose them when focus moves to the footer button.
      const s = term.getSelection()?.trim() ?? "";
      if (s) lastSelectionRef.current = s;
      setHasSelection(!!s);
    });

    const ro = new ResizeObserver(() => scheduleReport());
    ro.observe(el);

    const unsub = onHostMessage((msg) => {
      if (msg.type === "agent-pane/init") {
        setAgent(msg.agent);
        setStatus(msg.status);
        void (async () => {
          const font = sanitizeFontMetrics(msg.font ?? FALLBACK_FONT);
          applyFont(term, font);
          await waitForFonts(font.fontFamily, font.fontSize);
          if (disposed) return;
          fontReady = true;
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                if (!disposed) reportGrid(true);
              });
            });
          });
        })();
        return;
      }
      if (msg.type === "agent-pane/data") {
        term.write(msg.data);
        return;
      }
      if (msg.type === "agent-pane/status") {
        setStatus(msg.status);
        return;
      }
      if (msg.type === "agent-pane/delivery") {
        setBusy(false);
        setFlash(msg.message);
        if (msg.ok && (msg.mode === "stage" || msg.mode === "submit")) {
          setDraft("");
          placeInjectMarker(term, msg.mode, marksRef.current);
        }
        return;
      }
      if (msg.type === "agent-pane/mark") {
        placeInjectMarker(term, msg.kind, marksRef.current);
        return;
      }
      if (msg.type === "agent-pane/pin-result") {
        setFlash(msg.message);
        return;
      }
      if (msg.type === "agent-pane/exit") {
        setStatus("detached");
        term.writeln(
          "\r\n\x1b[33m[Tachyon] attach ended"
          + (msg.signal ? ` (signal ${msg.signal})` : msg.code !== null && msg.code !== undefined ? ` (code ${msg.code})` : "")
          + " — reopen the agent pane (sidebar terminal icon).\x1b[0m",
        );
      }
    });

    postMessage({ type: "agent-pane/ready" });

    return () => {
      disposed = true;
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      unsub();
      ro.disconnect();
      dataDisp.dispose();
      selDisp.dispose();
      for (const d of marksRef.current.decorations) d.dispose();
      for (const m of marksRef.current.markers) m.dispose();
      marksRef.current = { markers: [], decorations: [] };
      termRef.current = null;
      term.dispose();
    };
  }, [postMessage, onHostMessage]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(t);
  }, [flash]);

  const deliver = (mode: "stage" | "submit") => {
    const text = draft;
    if (!text.trim() || busy) return;
    setBusy(true);
    setFlash(null);
    postMessage(mode === "stage" ? { type: "agent-pane/stage", text } : { type: "agent-pane/submit", text });
  };

  const pinSelection = () => {
    void (async () => {
      const term = termRef.current;
      let text = (term?.getSelection() ?? "").trim() || lastSelectionRef.current.trim();
      // Claude's own mouse select shows "copied N chars to clipboard" — pin that when xterm
      // has no selection (application mouse mode ate the drag).
      if (!text && typeof navigator !== "undefined" && navigator.clipboard?.readText) {
        try {
          text = (await navigator.clipboard.readText()).trim();
        } catch {
          /* webview clipboard-read denied — fall through to hint */
        }
      }
      if (!text) {
        setFlash(
          "Nothing to pin. Shift+drag in the pane (agent mouse mode steals selection), or copy text first then Pin.",
        );
        return;
      }
      lastSelectionRef.current = text;
      postMessage({ type: "agent-pane/pin-selection", text });
    })();
  };

  return (
    <div class="agent-pane">
      <header class="agent-pane__identity" aria-label="Agent identity">
        <span class="agent-pane__agent" title={agent}>{agent}</span>
        <span class="agent-pane__status" title={status}>{status}</span>
      </header>

      <div class="agent-pane__term" ref={termHostRef} />

      <footer class="agent-pane__stage" aria-label="Stage and submit">
        <textarea
          class="agent-pane__draft"
          rows={2}
          placeholder="Stage text into the agent composer…"
          value={draft}
          disabled={busy}
          onInput={(e) => setDraft((e.currentTarget as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              deliver("submit");
            }
          }}
        />
        <div class="agent-pane__stage-actions">
          <button
            type="button"
            class={`agent-pane__btn${hasSelection ? " agent-pane__btn--armed" : ""}`}
            disabled={busy}
            title={
              hasSelection
                ? "Pin the selected terminal text to the project checklist"
                : "Pin selection (or clipboard). Tip: Shift+drag if the agent captures the mouse — blue TUI highlight alone is not an xterm selection."
            }
            // Keep focus on the terminal so an active xterm selection is not cleared on click.
            onMouseDown={(e) => e.preventDefault()}
            onClick={pinSelection}
          >
            Pin selection
          </button>
          <button
            type="button"
            class="agent-pane__btn"
            disabled={busy}
            title="Open prompt template picker (spec 381)"
            onClick={() => postMessage({ type: "agent-pane/inject-template" })}
          >
            Template…
          </button>
          <button
            type="button"
            class="agent-pane__btn"
            disabled={busy || !draft.trim()}
            title="Paste without Enter — review in the TUI composer"
            onClick={() => deliver("stage")}
          >
            Stage
          </button>
          <button
            type="button"
            class="agent-pane__btn agent-pane__btn--primary"
            disabled={busy || !draft.trim()}
            title="Paste + Enter (Ctrl/Cmd+Enter). Refused by host when the agent is busy."
            onClick={() => deliver("submit")}
          >
            Submit
          </button>
        </div>
        {flash ? <div class="agent-pane__flash" role="status">{flash}</div> : null}
      </footer>
    </div>
  );
}
