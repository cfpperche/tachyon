import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { App } from "./App";
import type { ActivityViewModel } from "../../activity/activityView";

// The activity webview iframe entry. The host (ActivityPanelManager) pushes the normalized view-model via
// postMessage; image data arrives once per id on a side channel. We render only what arrives.
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

const EMPTY: ActivityViewModel = {
  tier: "structured",
  summary: { messages: 0, toolsRunning: 0, toolsFailed: 0, filesChanged: [], filesReferenced: [], tokens: { input: 0, output: 0 } },
  items: [],
};

function Root() {
  const [vm, setVm] = useState<ActivityViewModel>(EMPTY);
  const [images, setImages] = useState<Record<string, string>>({});
  const [atBottom, setAtBottom] = useState(true);
  // Chat sticks to the newest message — but only when the user is already near the bottom (don't yank them
  // back while they scroll up to read history).
  const stick = useRef(true);
  useEffect(() => {
    const onScroll = () => {
      const near = window.innerHeight + window.scrollY >= document.body.scrollHeight - 140;
      stick.current = near;
      setAtBottom(near);
    };
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; vm?: ActivityViewModel; id?: string; dataUri?: string } | undefined;
      if (!d) return;
      if (d.type === "activity" && d.vm) setVm(d.vm);
      else if (d.type === "imageData" && d.id && d.dataUri) setImages((prev) => (prev[d.id!] ? prev : { ...prev, [d.id!]: d.dataUri! }));
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("message", onMsg);
    vscode?.postMessage({ type: "ready" });
    return () => { window.removeEventListener("scroll", onScroll); window.removeEventListener("message", onMsg); };
  }, []);
  useEffect(() => { if (stick.current) window.scrollTo({ top: document.body.scrollHeight }); }, [vm, images]);

  const dispatch = {
    openFile: (path: string) => vscode?.postMessage({ type: "openFile", path }),
    terminal: () => vscode?.postMessage({ type: "terminal" }),
    transcript: () => vscode?.postMessage({ type: "transcript" }),
  };
  const jump = () => { stick.current = true; window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }); };
  return (
    <>
      <App vm={vm} dispatch={dispatch} images={images} />
      {!atBottom && vm.items.length > 0 && (
        <button class="jump" title="Jump to latest" onClick={jump}><span class="codicon codicon-arrow-down" /> Latest</button>
      )}
    </>
  );
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
