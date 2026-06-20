import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { App } from "./App";
import type { ActivityViewModel } from "../../activity/activityView";

// The activity webview iframe entry. The host (ActivityPanelManager) pushes the normalized view-model via
// postMessage; we render only what arrives. No SAMPLE — an unopened/transient transcript shows "waiting".
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

const EMPTY: ActivityViewModel = {
  tier: "structured",
  summary: { messages: 0, toolsRunning: 0, toolsFailed: 0, filesChanged: [], filesReferenced: [], tokens: { input: 0, output: 0 } },
  items: [],
};

function Root() {
  const [vm, setVm] = useState<ActivityViewModel>(EMPTY);
  // Chat sticks to the newest message — but only when the user is already near the bottom (don't yank them
  // back while they scroll up to read history).
  const stick = useRef(true);
  useEffect(() => {
    const onScroll = () => { stick.current = window.innerHeight + window.scrollY >= document.body.scrollHeight - 140; };
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; vm?: ActivityViewModel } | undefined;
      if (d && d.type === "activity" && d.vm) setVm(d.vm);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("message", onMsg);
    vscode?.postMessage({ type: "ready" });
    return () => { window.removeEventListener("scroll", onScroll); window.removeEventListener("message", onMsg); };
  }, []);
  useEffect(() => { if (stick.current) window.scrollTo({ top: document.body.scrollHeight }); }, [vm]);
  const dispatch = {
    openFile: (path: string) => vscode?.postMessage({ type: "openFile", path }),
    terminal: () => vscode?.postMessage({ type: "terminal" }),
    transcript: () => vscode?.postMessage({ type: "transcript" }),
  };
  return <App vm={vm} dispatch={dispatch} />;
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
