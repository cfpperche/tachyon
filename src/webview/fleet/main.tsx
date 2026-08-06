import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { FleetVM } from "../../sidebar/types";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { persistWebviewState, type TachyonVsCodeApi } from "../shared/clientState";
import { App, defaultStrings, type Strings } from "./App";
import { FLEET_MODEL, pollFleetAction, readyMessage, type FleetAction } from "./messages";

declare function acquireVsCodeApi(): TachyonVsCodeApi;
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
persistWebviewState(vscode);
const post = (message: FleetAction) => vscode ? vscode.postMessage(message) : window.postMessage(message, "*");

function Root() {
  const [fleet, setFleet] = useState<FleetVM | undefined>();
  const strings = (window as unknown as { __TACHYON_STRINGS__?: Strings }).__TACHYON_STRINGS__ ?? defaultStrings;
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === FLEET_MODEL && event.data.fleet) setFleet(event.data.fleet as FleetVM);
    };
    window.addEventListener("message", onMessage);
    post(readyMessage());
    const timer = setInterval(() => post(pollFleetAction()), 3_000);
    return () => { clearInterval(timer); window.removeEventListener("message", onMessage); };
  }, []);
  return <App fleet={fleet} strings={strings} post={post} />;
}

const root = document.getElementById("root");
if (root) render(<ErrorBoundary><Root /></ErrorBoundary>, root);
