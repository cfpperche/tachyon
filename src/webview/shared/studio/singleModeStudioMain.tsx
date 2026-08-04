import { render, type ComponentType } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { persistWebviewState, type TachyonVsCodeApi } from "../clientState";
import type { StudioDispatch } from "./protocol";
import { dispatchStudioFreezeMessage, isStudioFreezeBusMessage } from "./studioFreezeBus";

declare function acquireVsCodeApi(): TachyonVsCodeApi;

export interface SingleModeStudioAppProps {
  dispatch: StudioDispatch;
  routeKey: string;
  mountNonce: string;
  incoming?: { seq: number; message: unknown };
}

/** Mount a studio as a standalone ONE-mode document; no reading-mode UI exists or is synthesized. */
export function mountSingleModeStudio(
  App: ComponentType<SingleModeStudioAppProps>,
): void {
  const vscode =
    typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
  persistWebviewState(vscode);
  function Root() {
    const [incoming, setIncoming] = useState<{
      seq: number;
      message: unknown;
    }>();
    const seq = useRef(0);
    useEffect(() => {
      const receive = (event: MessageEvent) => {
        if (isStudioFreezeBusMessage(event.data)) {
          dispatchStudioFreezeMessage(event.data);
          return;
        }
        seq.current += 1;
        setIncoming({ seq: seq.current, message: event.data });
      };
      window.addEventListener("message", receive);
      return () => window.removeEventListener("message", receive);
    }, []);
    const post = (message: unknown) =>
      vscode ? vscode.postMessage(message) : window.postMessage(message, "*");
    return (
      <App
        dispatch={{ post }}
        routeKey="standalone-studio"
        mountNonce="single-mode"
        incoming={incoming}
      />
    );
  }
  const root = document.getElementById("root");
  if (root) render(<Root />, root);
}
