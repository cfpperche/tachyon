import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { App } from "./App";
import type { ApprovalViewModel } from "./viewModel";
import {
  APPROVALS,
  APPROVAL_ERROR,
  readyMessage,
  refreshApprovalsAction,
  resolveApprovalAction,
  type ApprovalHostMessage,
} from "./messages";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";
import type { ApprovalDecision } from "../../bridge/approvalRequest";

declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);

function Root() {
  const [vm, setVm] = useState<ApprovalViewModel | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as Partial<ApprovalHostMessage> | undefined;
      if (d?.type === APPROVALS && d.vm) {
        setVm(d.vm);
        setError(undefined);
      } else if (d?.type === APPROVAL_ERROR) {
        setError(d.message);
      }
    };
    window.addEventListener("message", onMsg);
    if (vscode) vscode.postMessage(readyMessage());
    else window.postMessage(readyMessage(), "*");
    return () => window.removeEventListener("message", onMsg);
  }, []);
  const dispatch = {
    refresh: () => vscode?.postMessage(refreshApprovalsAction()),
    resolve: (id: string, decision: ApprovalDecision) => vscode?.postMessage(resolveApprovalAction(id, decision)),
  };
  return <App vm={vm} error={error} dispatch={dispatch} />;
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
