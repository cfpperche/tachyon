import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { SectionsModel } from "../../sections/model";
import type { CockpitStrings } from "../shared/control/messages";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";
import { App, defaultStrings } from "./App";
import {
  WORKTREES_MODEL,
  WORKTREE_LAND_RESULT,
  WORKTREE_REVIEW_FILES,
  pollWorktreesAction,
  readyMessage,
  type WorktreeLandResult,
  type WorktreeReviewFiles,
  type WorktreesAction,
} from "./messages";

declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);
const post = (message: WorktreesAction) => vscode ? vscode.postMessage(message) : window.postMessage(message, "*");

function Root() {
  const [model, setModel] = useState<SectionsModel>();
  // t-ea5425 — the host's changed-file list. Present ⇒ the product picker is open; cleared on choose or
  // dismiss. The 3s poll keeps replacing the MODEL underneath it, which is why the picker lives here and
  // not inside a row: a row that re-renders must not take the open list away from the human using it.
  const [reviewFiles, setReviewFiles] = useState<WorktreeReviewFiles | null>(null);
  // SDD 498 — the last land outcome, held HERE for the same reason the picker is: the 3s poll replaces
  // the model underneath, and a refusal naming the exit a human has to take must not be swept away by
  // the next refresh. It is keyed by row id, so an outcome is only ever shown on the row it belongs to.
  const [landResult, setLandResult] = useState<WorktreeLandResult | null>(null);
  const strings = (window as unknown as { __TACHYON_STRINGS__?: CockpitStrings }).__TACHYON_STRINGS__ ?? defaultStrings;
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === WORKTREES_MODEL) setModel(event.data.model);
      else if (event.data?.type === WORKTREE_REVIEW_FILES) setReviewFiles(event.data.review as WorktreeReviewFiles);
      else if (event.data?.type === WORKTREE_LAND_RESULT) setLandResult(event.data.result as WorktreeLandResult);
    };
    window.addEventListener("message", onMessage);
    post(readyMessage());
    const timer = setInterval(() => post(pollWorktreesAction()), 3_000);
    return () => {
      clearInterval(timer);
      window.removeEventListener("message", onMessage);
    };
  }, []);
  return (
    <App
      model={model}
      strings={strings}
      post={post}
      reviewFiles={reviewFiles}
      landResult={landResult}
      onCloseReviewFiles={() => setReviewFiles(null)}
    />
  );
}

const root = document.getElementById("root");
if (root) render(<ErrorBoundary><Root /></ErrorBoundary>, root);
