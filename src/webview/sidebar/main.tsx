import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { App } from "./App";
import { SAMPLE, type FleetVM } from "../../sidebar/types";

// The webview iframe entry. The host (SidebarPrototypeProvider) pushes the live fleet via postMessage
// once we signal "ready"; until then we render SAMPLE so the surface is never blank.
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

function Root() {
  const [fleets, setFleets] = useState<FleetVM[]>([SAMPLE]);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; fleets?: FleetVM[] } | undefined;
      if (d && d.type === "fleet" && d.fleets) setFleets(d.fleets.length ? d.fleets : [SAMPLE]);
    };
    window.addEventListener("message", onMsg);
    vscode?.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", onMsg);
  }, []);
  // wsHash routes each action to the right folder (multi-root); omitted → the host uses the first workspace.
  const dispatch = {
    action: (id: string, agent: string, hash?: string) => vscode?.postMessage({ type: "action", id, agent, hash }),
    section: (op: string, id: string, extra?: { done?: boolean; label?: string }, hash?: string) => vscode?.postMessage({ type: "section", op, id, ...extra, hash }),
    global: (op: "addPin" | "openNotes", hash?: string) => vscode?.postMessage({ type: "global", op, hash }),
    pipeline: (op: string, name: string, nodeId?: string, hash?: string) => vscode?.postMessage({ type: "pipeline", op, name, nodeId, hash }),
  };
  return <App fleets={fleets} dispatch={dispatch} />;
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
