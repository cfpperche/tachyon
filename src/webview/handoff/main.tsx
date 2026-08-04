import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";
import { App } from "./App";
import { HANDOFF, distillExistingAction, distillTemporaryAction, openFileAction, readyMessage, refreshAction, type HandoffAction } from "./messages";
import type { HandoffViewModel } from "./handoffViewModel";

declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);
const post = (message: HandoffAction) => vscode ? vscode.postMessage(message) : window.postMessage(message, "*");

function Root() {
  const [vm, setVm] = useState<HandoffViewModel>();
  useEffect(() => {
    const on = (event: MessageEvent) => { if (event.data?.type === HANDOFF) setVm(event.data.vm); };
    window.addEventListener("message", on); post(readyMessage());
    const timer = window.setInterval(() => post(refreshAction()), 3000);
    return () => { clearInterval(timer); window.removeEventListener("message", on); };
  }, []);
  return <App vm={vm} dispatch={{ refresh: () => post(refreshAction()), openFile: () => post(openFileAction()),
    distillExisting: (agent, instructions) => post(distillExistingAction(agent, instructions)),
    distillAdhoc: (profileId, args, instructions) => post(distillTemporaryAction(profileId, args, instructions)) }} />;
}
const root = document.getElementById("root");
if (root) render(<ErrorBoundary><Root /></ErrorBoundary>, root);
