import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { App } from "./App";
import {
  INIT, MODEL, CAPTURE, readyMessage, captureAction, refreshAction, openAction, killAction, reapDeadAction, reapOrphansAction,
  type InspectorHostMessage, type InspectorStrings, type InspectorAction,
} from "./messages";
import type { InspectorModel } from "../../inspector/model";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";

// spec 279 — the Inspector webview entry (converted from ServerInspector's inline <script>). `preact-live`,
// both directions: pushes init/model/capture, posts ready/refresh/open/reap/capture/kill. Never imports vscode.
declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);

const post = (a: InspectorAction): void => {
  if (vscode) vscode.postMessage(a);
  else window.postMessage(a, "*"); // standalone (dev harness): no host, harmless
};
const signalReady = (): void => {
  if (vscode) vscode.postMessage(readyMessage());
  else window.postMessage(readyMessage(), "*");
};

function Root() {
  const [strings, setStrings] = useState<InspectorStrings | undefined>(undefined);
  const [model, setModel] = useState<InspectorModel | undefined>(undefined);
  const [captures, setCaptures] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [auto, setAuto] = useState(true);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const m = e.data as Partial<InspectorHostMessage> | undefined;
      if (!m) return;
      if (m.type === INIT && m.strings) setStrings(m.strings);
      else if (m.type === MODEL && m.model) setModel(m.model);
      else if (m.type === CAPTURE && m.session) setCaptures((prev) => ({ ...prev, [m.session as string]: m.text ?? "" }));
    };
    window.addEventListener("message", onMsg);
    signalReady();
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // auto-refresh: poll the host every 2.5s while enabled (mirrors the old inline timer), once strings exist.
  useEffect(() => {
    if (timer.current) { clearInterval(timer.current); timer.current = undefined; }
    if (auto && strings) timer.current = window.setInterval(() => post(refreshAction()), 2500);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [auto, strings]);

  const onToggleCapture = (session: string): void => {
    setOpen((prev) => {
      const next = new Set(prev);
      next.add(session);
      post(captureAction(session)); // first open and subsequent clicks explicitly refresh
      return next;
    });
  };
  const onCloseCapture = (session: string): void => setOpen((prev) => {
    const next = new Set(prev);
    next.delete(session);
    return next;
  });

  const onAction = (a: { type: "refresh" | "reapDead" | "reapOrphans" } | { type: "open" | "kill"; session: string }): void => {
    if (a.type === "refresh") post(refreshAction());
    else if (a.type === "reapDead") post(reapDeadAction());
    else if (a.type === "reapOrphans") post(reapOrphansAction());
    else if (a.type === "open") post(openAction(a.session));
    else if (a.type === "kill") post(killAction(a.session));
  };

  return (
    <App
      model={model}
      strings={strings}
      captures={captures}
      open={open}
      auto={auto}
      onToggleAuto={setAuto}
      onToggleCapture={onToggleCapture}
      onCloseCapture={onCloseCapture}
      onAction={onAction}
    />
  );
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
