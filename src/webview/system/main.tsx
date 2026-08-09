import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { SectionsModel } from "../../sections/model";
import type { CockpitStrings } from "../shared/control/messages";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";
import { App } from "./App";
import { SYSTEM_MODEL, pollSystemAction, readyMessage, type SystemAction } from "./messages";

declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);
const post = (message: SystemAction) => vscode ? vscode.postMessage(message) : window.postMessage(message, "*");

function Root() {
  const [model, setModel] = useState<SectionsModel>();
  // Overview's auto-refresh toggle, kept: Engine polled unconditionally, so the union of the two is the
  // one that can be turned OFF (spec.md § Acceptance — every action both pages carried is reachable).
  const [auto, setAuto] = useState(true);
  const strings = (window as unknown as { __TACHYON_STRINGS__: CockpitStrings }).__TACHYON_STRINGS__;
  useEffect(() => {
    const on = (event: MessageEvent) => { if (event.data?.type === SYSTEM_MODEL) setModel(event.data.model); };
    window.addEventListener("message", on); post(readyMessage());
    const timer = auto ? window.setInterval(() => post(pollSystemAction()), 3000) : undefined;
    return () => { if (timer) clearInterval(timer); window.removeEventListener("message", on); };
  }, [auto]);
  return <App model={model} strings={strings} auto={auto} setAuto={setAuto} post={post} />;
}

const root = document.getElementById("root");
if (root) render(<ErrorBoundary><Root /></ErrorBoundary>, root);
