import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { App } from "./App";
import { SAMPLE, type FleetVM } from "../../sidebar/types";

// The webview iframe entry. The host (SidebarPrototypeProvider) pushes the live fleet via postMessage
// once we signal "ready"; until then we render SAMPLE so the surface is never blank.
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

function Root() {
  const [fleet, setFleet] = useState<FleetVM>(SAMPLE);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; fleet?: FleetVM } | undefined;
      if (d && d.type === "fleet" && d.fleet) setFleet(d.fleet);
    };
    window.addEventListener("message", onMsg);
    vscode?.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", onMsg);
  }, []);
  const dispatch = {
    action: (id: string, agent: string) => vscode?.postMessage({ type: "action", id, agent }),
    more: (agent: string) => vscode?.postMessage({ type: "more", agent }),
    section: (op: string, id: string, extra?: { done?: boolean; label?: string }) => vscode?.postMessage({ type: "section", op, id, ...extra }),
    global: (op: "addPin" | "openNotes") => vscode?.postMessage({ type: "global", op }),
  };
  return <App fleet={fleet} dispatch={dispatch} />;
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
