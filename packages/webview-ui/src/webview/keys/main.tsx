import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { App } from "./App";
import { MODEL, readyMessage, type KeysAction, type KeysModel } from "./messages";
import "./keys.css";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const api = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
const post = (message: KeysAction) => api?.postMessage(message) ?? window.postMessage(message, "*");
function Root() {
  const [model, setModel] = useState<KeysModel>();
  useEffect(() => { const handler = (event: MessageEvent) => { if (event.data?.type === MODEL) setModel(event.data.model); }; window.addEventListener("message", handler); post(readyMessage()); return () => window.removeEventListener("message", handler); }, []);
  return <App model={model} post={post} />;
}
render(<ErrorBoundary><Root /></ErrorBoundary>, document.getElementById("root")!);
