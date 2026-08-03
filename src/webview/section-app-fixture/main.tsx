import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";
import { App } from "./App";
import {
  SECTION_FIXTURE_MODEL,
  sectionFixtureReadyMessage,
  sectionFixtureRefreshMessage,
  type SectionFixtureModel,
  type SectionFixtureToHost,
} from "./protocol";

/**
 * SDD 485 C2 — this app's OWN bootstrap, error boundary and CSS. That is the half of the reversal a single
 * bundle with twelve lazy mounts could not buy (codex's point in `spec.md`): a shared shell, listener, state
 * and error boundary is code-splitting, not app isolation. The crash boundary that actually matters is the
 * webview itself — this file is what makes each webview its own program rather than another mount inside
 * somebody else's.
 */

declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);

function post(message: SectionFixtureToHost): void {
  if (vscode) vscode.postMessage(message);
  else window.postMessage(message, "*");
}

function Root() {
  const [model, setModel] = useState<SectionFixtureModel | undefined>(undefined);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; model?: SectionFixtureModel } | undefined;
      if (!data || typeof data !== "object" || data.type !== SECTION_FIXTURE_MODEL || !data.model) return;
      setModel(data.model);
    };
    window.addEventListener("message", onMessage);
    post(sectionFixtureReadyMessage());
    // The client-side poll every section app is tempted to keep. It stays here on purpose: the HOST is what
    // refuses to serve it while the panel is hidden (`refreshKindFor` → the gate), so this proves the gate
    // holds no matter what any client version's timer does — Phase B's finding, generalized.
    const timer = setInterval(() => post(sectionFixtureRefreshMessage()), 3000);
    return () => {
      window.removeEventListener("message", onMessage);
      clearInterval(timer);
    };
  }, []);
  return <App model={model} dispatch={{ refresh: () => post(sectionFixtureRefreshMessage()) }} />;
}

const root = document.getElementById("root");
if (root) render(<ErrorBoundary><Root /></ErrorBoundary>, root);
