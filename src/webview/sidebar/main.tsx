import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { App, type GlobalOp } from "./App";
import { SAMPLE, type FleetVM } from "../../sidebar/types";

// The webview iframe entry. The host (SidebarPrototypeProvider) pushes the live fleet via postMessage
// once we signal "ready"; standalone preview keeps SAMPLE, while the real webview waits for live data.
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

function Root() {
  // In the real webview start empty (the host pushes live fleets after "ready"); SAMPLE only when opened
  // standalone (no vscode api) so the dev/design preview still has data. Never show SAMPLE in production.
  const [fleets, setFleets] = useState<FleetVM[]>(vscode ? [] : [SAMPLE]);
  // spec 242 — persisted sort prefs (per section); the host includes them in the fleet message so the FIRST
  // render is already in the saved order (no name-asc→saved flicker).
  const [prefs, setPrefs] = useState<{ agents?: string; terminals?: string }>({});
  useEffect(() => {
    let gotFleet = false;
    let retry: number | undefined;
    let stopRetry: number | undefined;
    const requestFleet = () => vscode?.postMessage({ type: "ready" });
    const stopRetrying = () => {
      if (retry !== undefined) window.clearInterval(retry);
      if (stopRetry !== undefined) window.clearTimeout(stopRetry);
      retry = undefined;
      stopRetry = undefined;
    };
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; fleets?: FleetVM[]; prefs?: { agents?: string; terminals?: string } } | undefined;
      if (d && d.type === "fleet" && Array.isArray(d.fleets)) {
        gotFleet = true;
        stopRetrying();
        setFleets(d.fleets); // [] = no workspace → App shows an empty state
        if (d.prefs) setPrefs(d.prefs);
      }
    };
    const onFocus = () => requestFleet();
    const onVisibility = () => {
      if (!document.hidden) requestFleet();
    };
    window.addEventListener("message", onMsg);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    requestFleet();
    retry = window.setInterval(() => {
      if (!gotFleet) requestFleet();
    }, 250);
    stopRetry = window.setTimeout(stopRetrying, 5000);
    return () => {
      stopRetrying();
      window.removeEventListener("message", onMsg);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  // wsHash routes each action to the right folder (multi-root); omitted → the host uses the first workspace.
  const dispatch = {
    action: (id: string, agent: string, hash?: string) => vscode?.postMessage({ type: "action", id, agent, hash }),
    section: (op: string, id: string, extra?: { done?: boolean; label?: string }, hash?: string) => vscode?.postMessage({ type: "section", op, id, ...extra, hash }),
    global: (op: GlobalOp, hash?: string) => vscode?.postMessage({ type: "global", op, hash }),
    pipeline: (op: string, name: string, nodeId?: string, hash?: string) => vscode?.postMessage({ type: "pipeline", op, name, nodeId, hash }),
    setSort: (section: "agents" | "terminals", mode: string) => vscode?.postMessage({ type: "setSort", section, mode }),
  };
  return <App fleets={fleets} dispatch={dispatch} prefs={prefs} />;
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
