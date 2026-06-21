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
  // Search query lives here (not in App) so the bottom-stick effect can suppress auto-scroll while a filter
  // is active — otherwise a live vm/image update would yank the filtered result view down to the bottom.
  const [query, setQuery] = useState("");
  // Chat sticks to the newest message — but only when the user is already near the bottom (don't yank them
  // back while they scroll up to read history).
  const stick = useRef(true);
  // When the user loads earlier activity, older items prepend at the TOP → keep their view anchored on the
  // item they were reading: record the pre-load scrollHeight (at click), then scroll by the height delta after
  // the SPECIFIC paged VM renders. `pendingPrepend` is armed only by a VM the host flagged `prepended`, so a
  // live append / imageData arriving in between can't consume the anchor (codex MAJOR).
  const prependAnchor = useRef<number | null>(null);
  const pendingPrepend = useRef(false);
  useEffect(() => {
    const onScroll = () => {
      const near = window.innerHeight + window.scrollY >= document.body.scrollHeight - 140;
      stick.current = near;
      setAtBottom(near);
    };
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; vm?: ActivityViewModel; prepended?: boolean; id?: string; dataUri?: string } | undefined;
      if (!d) return;
      if (d.type === "activity" && d.vm) { if (d.prepended) pendingPrepend.current = true; setVm(d.vm); }
      else if (d.type === "imageData" && d.id && d.dataUri) setImages((prev) => (prev[d.id!] ? prev : { ...prev, [d.id!]: d.dataUri! }));
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("message", onMsg);
    vscode?.postMessage({ type: "ready" });
    return () => { window.removeEventListener("scroll", onScroll); window.removeEventListener("message", onMsg); };
  }, []);
  useEffect(() => {
    if (pendingPrepend.current && prependAnchor.current != null) {
      // the paged VM (older items prepended at the top) just rendered → keep the user's content in place
      window.scrollBy({ top: document.body.scrollHeight - prependAnchor.current });
      pendingPrepend.current = false;
      prependAnchor.current = null;
      return;
    }
    if (stick.current && !query) window.scrollTo({ top: document.body.scrollHeight });
  }, [vm, images, query]);

  const dispatch = {
    openFile: (path: string) => vscode?.postMessage({ type: "openFile", path }),
    terminal: () => vscode?.postMessage({ type: "terminal" }),
    loadOlder: () => { prependAnchor.current = document.body.scrollHeight; vscode?.postMessage({ type: "loadOlder" }); },
  };
  const jump = () => { stick.current = true; window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }); };
  return (
    <>
      <App vm={vm} dispatch={dispatch} images={images} query={query} setQuery={setQuery} />
      {!atBottom && vm.items.length > 0 && (
        <button class="jump" title="Jump to latest" onClick={jump}><span class="codicon codicon-arrow-down" /> Latest</button>
      )}
    </>
  );
}

const root = document.getElementById("root");
if (root) render(<Root />, root);
