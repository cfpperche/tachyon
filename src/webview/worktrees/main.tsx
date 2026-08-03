import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { CockpitModel } from "../../cockpit/model";
import type { CockpitStrings } from "../cockpit/messages";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";
import { App, defaultStrings } from "./App";
import { WORKTREES_MODEL, pollWorktreesAction, readyMessage, type WorktreesAction } from "./messages";

declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);
const post = (message: WorktreesAction) => vscode ? vscode.postMessage(message) : window.postMessage(message, "*");

function Root() {
  const [model, setModel] = useState<CockpitModel>();
  const strings = (window as unknown as { __TACHYON_STRINGS__?: CockpitStrings }).__TACHYON_STRINGS__ ?? defaultStrings;
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === WORKTREES_MODEL) setModel(event.data.model);
    };
    window.addEventListener("message", onMessage);
    post(readyMessage());
    const timer = setInterval(() => post(pollWorktreesAction()), 3_000);
    return () => {
      clearInterval(timer);
      window.removeEventListener("message", onMessage);
    };
  }, []);
  return <App model={model} strings={strings} post={post} />;
}

const root = document.getElementById("root");
if (root) render(<ErrorBoundary><Root /></ErrorBoundary>, root);
