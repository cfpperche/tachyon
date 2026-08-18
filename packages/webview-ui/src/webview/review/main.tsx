import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";
import { App } from "./App";
import {
  REVIEW,
  REVIEW_ERROR,
  selectReviewFileAction,
  sendReviewBatchAction,
  upsertReviewNoteAction,
  type ReviewVM,
} from "./messages";
import { readyMessage } from "../shared/ready";

declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);
const post = (message: unknown): void => vscode ? vscode.postMessage(message) : window.postMessage(message, "*");

function ReviewRoot() {
  const [vm, setVm] = useState<ReviewVM>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const raw = event.data as { type?: unknown; vm?: ReviewVM; message?: string } | undefined;
      if (raw?.type === REVIEW && raw.vm) {
        setVm(raw.vm);
        setError(undefined);
      }
      if (raw?.type === REVIEW_ERROR && typeof raw.message === "string") setError(raw.message);
    };
    window.addEventListener("message", onMessage);
    post(readyMessage());
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return (
    <App
      vm={error && vm ? { ...vm, error } : vm}
      dispatch={{
        selectFile: (path) => post(selectReviewFileAction(path)),
        upsertNote: (path, line, body) => post(upsertReviewNoteAction(path, line, body)),
        sendBatch: (agent) => post(sendReviewBatchAction(agent)),
      }}
    />
  );
}

const root = document.getElementById("root");
if (root) render(<ErrorBoundary><ReviewRoot /></ErrorBoundary>, root);
