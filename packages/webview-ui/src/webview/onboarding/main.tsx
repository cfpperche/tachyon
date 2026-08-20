import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { App } from "./App";
import { MODEL, readyMessage, type OnboardingAction, type OnboardingModel } from "./messages";
import "./onboarding.css";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const api = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
const post = (message: OnboardingAction) => api?.postMessage(message) ?? window.postMessage(message, "*");
function Root() {
  const [model, setModel] = useState<OnboardingModel>();
  useEffect(() => { const handler = (event: MessageEvent) => { if (event.data?.type === MODEL) setModel(event.data.model); }; window.addEventListener("message", handler); post(readyMessage()); return () => window.removeEventListener("message", handler); }, []);
  return <App model={model} dispatch={post} />;
}
render(<ErrorBoundary><Root /></ErrorBoundary>, document.getElementById("root")!);
