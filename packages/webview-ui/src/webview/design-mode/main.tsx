import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { App } from "./App";
import { MODEL, readyMessage, type DesignModeAction, type DesignModeModel, type DesignModeStrings } from "./messages";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const api = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
const post = (message: DesignModeAction) => api?.postMessage(message) ?? window.postMessage(message, "*");
const strings = (window as unknown as { __TACHYON_DESIGN_MODE_STRINGS__: DesignModeStrings }).__TACHYON_DESIGN_MODE_STRINGS__;

function Root() {
  const [model, setModel] = useState<DesignModeModel>();
  useEffect(() => {
    const handler = (event: MessageEvent) => { if (event.data?.type === MODEL) setModel(event.data.model); };
    window.addEventListener("message", handler);
    post(readyMessage());
    return () => window.removeEventListener("message", handler);
  }, []);
  return <App model={model} strings={strings} post={post} />;
}

render(<ErrorBoundary><Root /></ErrorBoundary>, document.getElementById("root")!);
