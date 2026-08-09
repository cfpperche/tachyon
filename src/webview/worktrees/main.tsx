import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { SectionsModel } from "../../sections/model";
import type { CockpitStrings } from "../shared/control/messages";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";
import { App, defaultStrings } from "./App";
import {
  WORKTREES_MODEL,
  WORKTREE_REVIEW_FILES,
  pollWorktreesAction,
  readyMessage,
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
  const strings = (window as unknown as { __TACHYON_STRINGS__?: CockpitStrings }).__TACHYON_STRINGS__ ?? defaultStrings;
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === WORKTREES_MODEL) setModel(event.data.model);
      else if (event.data?.type === WORKTREE_REVIEW_FILES) setReviewFiles(event.data.review as WorktreeReviewFiles);
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
      onCloseReviewFiles={() => setReviewFiles(null)}
    />
  );
}

const root = document.getElementById("root");
if (root) render(<ErrorBoundary><Root /></ErrorBoundary>, root);
