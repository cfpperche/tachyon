import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { App } from "./App";
import {
  INIT,
  MODEL,
  readyMessage,
  refreshAction,
  copyDiagnosticsAction,
  openServerInspectorAction,
  type ControlInspectorHostMessage,
  type ControlInspectorStrings,
} from "./messages";
import type { ControlInspectorModel } from "../../control-inspector/model";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";

declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);

const post = (msg: unknown): void => {
  if (vscode) vscode.postMessage(msg);
  else window.postMessage(msg, "*");
};

const signalReady = (): void => {
  if (vscode) vscode.postMessage(readyMessage());
  else window.postMessage(readyMessage(), "*");
};

function Root() {
  const [strings, setStrings] = useState<ControlInspectorStrings | undefined>(undefined);
  const [model, setModel] = useState<ControlInspectorModel | undefined>(undefined);
  const [toast, setToast] = useState<string | undefined>(undefined);
  const [auto, setAuto] = useState(true);
  const timer = useRef<number | undefined>(undefined);
  const toastTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const m = e.data as Partial<ControlInspectorHostMessage> | undefined;
      if (!m) return;
      if (m.type === INIT && m.strings) setStrings(m.strings);
      else if (m.type === MODEL && m.model) setModel(m.model);
      else if (m.type === "toast" && m.text) {
        setToast(m.text);
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(() => setToast(undefined), 2200);
      }
    };
    window.addEventListener("message", onMsg);
    signalReady();
    return () => {
      window.removeEventListener("message", onMsg);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  useEffect(() => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = undefined;
    }
    if (auto && strings) timer.current = window.setInterval(() => post(refreshAction()), 3000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [auto, strings]);

  return (
    <App
      model={model}
      strings={strings}
      toast={toast}
      auto={auto}
      onToggleAuto={setAuto}
      onRefresh={() => post(refreshAction())}
      onCopyDiagnostics={() => post(copyDiagnosticsAction())}
      onOpenServerInspector={() => post(openServerInspectorAction())}
    />
  );
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
