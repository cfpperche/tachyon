import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { RuntimeConfigControlSnapshot } from "../../runtimeConfig/types";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";
import { App } from "./App";
import {
  RUNTIME_CONFIG_SNAPSHOT,
  RUNTIME_CONFIG_SNAPSHOT_UNAVAILABLE,
  openRuntimeConfigSourceAction,
  pollRuntimeConfigAction,
  readyMessage,
  saveRuntimeConfigChangesAction,
  type RuntimeConfigStrings,
} from "./messages";

declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);
const post = (message: unknown): void => vscode ? vscode.postMessage(message) : window.postMessage(message, "*");

function Root() {
  const [snapshot, setSnapshot] = useState<RuntimeConfigControlSnapshot>();
  const [unavailable, setUnavailable] = useState(false);
  const strings = (window as unknown as { __TACHYON_STRINGS__: RuntimeConfigStrings }).__TACHYON_STRINGS__;
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.data?.type === RUNTIME_CONFIG_SNAPSHOT) {
        setSnapshot(event.data.snapshot);
        setUnavailable(false);
      } else if (event.data?.type === RUNTIME_CONFIG_SNAPSHOT_UNAVAILABLE) {
        setSnapshot(undefined);
        setUnavailable(true);
      }
    };
    window.addEventListener("message", receive);
    post(readyMessage());
    const timer = window.setInterval(() => post(pollRuntimeConfigAction()), 3_000);
    return () => { window.clearInterval(timer); window.removeEventListener("message", receive); };
  }, []);
  return <App
    s={strings}
    snapshot={snapshot}
    unavailable={unavailable}
    onOpenSource={(path) => post(openRuntimeConfigSourceAction(path))}
    onSaveChanges={(runtime, documentId, expectedRevision, changes) =>
      post(saveRuntimeConfigChangesAction(runtime, documentId, expectedRevision, changes))}
  />;
}

const root = document.getElementById("root");
if (root) render(<ErrorBoundary><Root /></ErrorBoundary>, root);
