import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { App, type GlobalOp } from "./App";
import { SAMPLE, type FleetVM, type SidebarBootVM } from "@tachyon/shared/sidebar/types";
import { FLEET, readyMessage, type SidebarHostMessage } from "./messages";

// The webview iframe entry. The host (SidebarPrototypeProvider) pushes the live fleet via postMessage
// once we signal "ready"; standalone preview keeps SAMPLE, while the real webview waits for live data.
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

// spec 278 — the ready handshake works in BOTH modes: the real webview signals the vscode host; standalone
// (the dev preview harness) it posts to `window` so the harness can inject a fixture deterministically (no
// 10×-post race). `vscode` stays `undefined` standalone, so the SAMPLE default below is preserved.
const signalReady = (): void => {
  if (vscode) vscode.postMessage(readyMessage());
  else window.postMessage(readyMessage(), "*");
};

function Root() {
  // In the real webview start empty (the host pushes live fleets after "ready"); SAMPLE only when opened
  // standalone (no vscode api) so the dev/design preview still has data. Never show SAMPLE in production.
  const [fleets, setFleets] = useState<FleetVM[]>(vscode ? [] : [SAMPLE]);
  /**
   * SDD 504 — `undefined` until the host says otherwise, and that default is the fix.
   *
   * This empty array above is the webview's first frame on every reload, and the sidebar used to
   * read it as proof that no Tachyon workspace existed — so the welcome was frame #1, shown before
   * anyone had asked the question it answers. Keeping discovery in its OWN state, with no value at
   * all until a message arrives, means "not asked" can no longer be spelled the same way as "no".
   *
   * A retained webview can also outlive the host that filled it: on a new host incarnation this
   * resets with the rest of the client state, so nothing carries a previous window's answer into a
   * window that has not been checked (plan, "Risks and unknowns").
   */
  const [boot, setBoot] = useState<SidebarBootVM | undefined>(undefined);
  // spec 242 — persisted sort prefs (per section); the host includes them in the fleet message so the FIRST
  // render is already in the saved order (no name-asc→saved flicker).
  const [prefs, setPrefs] = useState<{ agents?: string; terminals?: string }>({});
  const [collapsedKeys, setCollapsedKeys] = useState<string[]>([]);
  const [appVersion, setAppVersion] = useState<string | undefined>(undefined);
  const [selectedWsHash, setSelectedWsHash] = useState<string | undefined>(undefined);
  useEffect(() => {
    let gotFleet = false;
    let retry: number | undefined;
    let stopRetry: number | undefined;
    const requestFleet = () => signalReady();
    const stopRetrying = () => {
      if (retry !== undefined) window.clearInterval(retry);
      if (stopRetry !== undefined) window.clearTimeout(stopRetry);
      retry = undefined;
      stopRetry = undefined;
    };
    const onMsg = (e: MessageEvent) => {
      const d = e.data as Partial<SidebarHostMessage> | undefined;
      if (d && d.type === FLEET && Array.isArray(d.fleets)) {
        gotFleet = true;
        stopRetrying();
        setFleets(d.fleets);
        // SDD 504 — an empty `fleets` says only "no fleet"; `boot` is what says whether that means
        // absence. Set unconditionally, including back to undefined, so a host that stops sending
        // discovery returns the sidebar to "unknown" rather than leaving a stale claim on screen.
        setBoot(d.boot);
        if (d.prefs) setPrefs(d.prefs);
        setCollapsedKeys(Array.isArray(d.collapsedKeys) ? d.collapsedKeys : []);
        if (typeof d.appVersion === "string" && d.appVersion.trim()) setAppVersion(d.appVersion.trim());
        setSelectedWsHash(typeof d.selectedWsHash === "string" ? d.selectedWsHash : undefined);
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
    section: (op: string, id: string, extra?: { done?: boolean; label?: string; actionId?: string }, hash?: string) => vscode?.postMessage({ type: "section", op, id, ...extra, hash }),
    // t-6e2952 — `sectionId` rides along for the Control launcher tiles (openControl <section>); every
    // other global op leaves it undefined and the host ignores it.
    global: (op: GlobalOp, hash?: string, sectionId?: string) => vscode?.postMessage({ type: "global", op, hash, sectionId }),
    pipeline: (op: string, name: string, nodeId?: string, hash?: string) => vscode?.postMessage({ type: "pipeline", op, name, nodeId, hash }),
    // t-41117e — destination already chosen in the shared ContinuePicker.
    continueTask: (fromName: string, toName: string, hash?: string) =>
      vscode?.postMessage({ type: "continueTask", fromName, toName, hash }),
    setSort: (section: "agents" | "terminals", mode: string) => vscode?.postMessage({ type: "setSort", section, mode }),
    setCollapsedKeys: (keys: string[]) => vscode?.postMessage({ type: "setCollapsed", keys }),
    switchWorkspace: (wsHash: string) => vscode?.postMessage({ type: "switchControlWorkspace", hash: wsHash }),
  };
  return <App fleets={fleets} dispatch={dispatch} prefs={prefs} collapsedKeys={collapsedKeys} appVersion={appVersion} selectedWsHash={selectedWsHash} boot={boot} />;
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
