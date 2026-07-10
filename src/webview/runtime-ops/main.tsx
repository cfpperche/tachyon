import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { App } from "./App";
import { RUNTIME_OPS_LOADING, RUNTIME_OPS_SNAPSHOT, readyMessage, type RuntimeOpsHostMessage } from "./messages";
import type { RuntimeOpsSnapshotV1 } from "../../runtimeOps/types";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";

declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);

function signalReady(): void {
  if (vscode) vscode.postMessage(readyMessage());
  else window.postMessage(readyMessage(), "*");
}

function Root() {
  const [snapshot, setSnapshot] = useState<RuntimeOpsSnapshotV1>();
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const message = event.data as Partial<RuntimeOpsHostMessage> | undefined;
      if (message?.type === RUNTIME_OPS_LOADING) setSnapshot(undefined);
      if (message?.type === RUNTIME_OPS_SNAPSHOT && message.snapshot) setSnapshot(message.snapshot);
    };
    window.addEventListener("message", onMessage);
    signalReady();
    return () => window.removeEventListener("message", onMessage);
  }, []);
  return <App snapshot={snapshot} />;
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
