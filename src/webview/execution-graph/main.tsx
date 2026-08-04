import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { ExecutionGraphVm } from "../../cockpit/executionGraphVm";
import { ExecutionGraphSection } from "../cockpit/ExecutionGraphSection";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";
import { MODEL, pollExecutionGraphAction, readyMessage, type ExecutionGraphAction, type ExecutionGraphStrings } from "./messages";

declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);
const post = (message: ExecutionGraphAction) => vscode ? vscode.postMessage(message) : window.postMessage(message, "*");

export function ExecutionGraphRoot({ initialVm }: { initialVm?: ExecutionGraphVm }) {
  const [vm, setVm] = useState<ExecutionGraphVm | undefined>(initialVm);
  // SDD 485 D9 — these are ways of looking, not workspace facts. Keeping them in this root makes
  // selection and filters belong to one webview instance: project A cannot leak either into project B.
  const [selected, setSelected] = useState<string>();
  const [filters, setFilters] = useState<{ turnId?: string; state?: string; kind?: string; agentId?: string }>({});
  const detail = selected ? vm?.details[selected] : undefined;
  const strings = (window as unknown as { __TACHYON_STRINGS__?: ExecutionGraphStrings }).__TACHYON_STRINGS__!;

  useEffect(() => {
    const onMessage = (event: MessageEvent) => { if (event.data?.type === MODEL) setVm(event.data.vm); };
    window.addEventListener("message", onMessage);
    post(readyMessage());
    const timer = setInterval(() => post(pollExecutionGraphAction()), 3_000);
    return () => { clearInterval(timer); window.removeEventListener("message", onMessage); };
  }, []);

  const shown = vm ?? { status: "no-telemetry", nodes: [], edges: [], rows: [], width: 0, height: 0,
    available: { turnIds: [], states: [], kinds: [], agentIds: [] }, matched: 0, grouped: false, details: {} };
  return <ExecutionGraphSection s={strings} vm={shown} detail={detail} selected={selected} filters={filters} onSelect={setSelected} onFilter={setFilters} />;
}

const root = document.getElementById("root");
if (root) render(<ErrorBoundary><ExecutionGraphRoot /></ErrorBoundary>, root);
