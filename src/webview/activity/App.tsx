import { useEffect, useMemo, useState } from "preact/hooks";
import type { ActivityItem, ActivityViewModel } from "../../activity/activityView";
import { MarkdownView, linkify } from "./markdown";
import { buildSearchIndex, filterIndex, isCapped, tailFromSequence } from "./feedModel";

/** Render-only activity cockpit (spec 238). All parsing/normalization happened in the host; this draws
 *  the view-model as a chat (human right, agent left) with the agent's reasoning + tool/file activity. */
export interface ActivityDispatch {
  openFile(path: string): void;
  terminal(): void;
  transcript(): void;
}

const ICON: Record<ActivityItem["kind"], string> = {
  message: "comment", command: "terminal", thinking: "lightbulb", image: "device-camera",
  tool: "tools", file: "file", usage: "graph", error: "error", raw: "circle-outline", session: "debug-start", boundary: "fold",
};

/** A compaction boundary — a "context compacted" rule; if the runtime injected a recap, it folds in here as
 *  an expandable summary (NOT a human bubble). History before it is retained. */
function Boundary({ it, cv }: { it: ActivityItem; cv?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div class={`boundary-wrap${cv ? " cv" : ""}`}>
      <div class="boundary">
        <span class="codicon codicon-fold" />
        <span class="blabel">{it.title}</span>
        {it.detail && <span class="bmeta">{it.detail}</span>}
        {it.resultFull && <button class="bsum" onClick={() => setOpen(!open)}>{open ? "hide summary" : "view summary"}</button>}
      </div>
      {open && it.resultFull && <div class="boundary-summary"><MarkdownView text={it.resultFull} /></div>}
    </div>
  );
}

/** A chat bubble — aligned right for the human, left for the agent (markdown-rendered). A long agent
 *  message is clamped with a fade + Show more/less toggle. */
function Bubble({ it, cv }: { it: ActivityItem; cv?: boolean }) {
  const agent = it.role !== "user";
  // Clamp tall messages by EITHER length or line count (many short lines/lists also render tall).
  const long = it.title.length > 1400 || (it.title.match(/\n/g)?.length ?? 0) > 24;
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState(false); // preview (rendered markdown) by default; toggle to raw source
  return (
    <div class={`msg ${it.role ?? "agent"}${cv ? " cv" : ""}`}>
      <div class="bubble">
        {agent && (
          <button class="rawtoggle" title={raw ? "Show preview" : "Show raw markdown"} aria-label="Toggle raw markdown" onClick={() => setRaw(!raw)}>
            <span class={`codicon codicon-${raw ? "eye" : "code"}`} />
          </button>
        )}
        {agent && raw
          ? <pre class="rawmd">{it.title}</pre>
          : <div class={`btext${long && !open ? " clamp" : ""}`}>{agent ? <MarkdownView text={it.title} /> : linkify(it.title)}</div>}
        {long && !raw && <button class="more" onClick={() => setOpen(!open)}>{open ? "Show less" : "Show more"}</button>}
        {it.timestamp && <div class="btime">{hhmm(it.timestamp)}</div>}
      </div>
    </div>
  );
}

/** Collapsible reasoning, agent side. Collapsed by default (the gist is the bubbles + activity). */
function Thinking({ it, cv }: { it: ActivityItem; cv?: boolean }) {
  const [open, setOpen] = useState(false);
  const preview = it.title.replace(/\s+/g, " ").trim().slice(0, 64);
  return (
    <div class={`think${cv ? " cv" : ""}`}>
      <button class="think-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span class={`codicon codicon-chevron-${open ? "down" : "right"}`} />
        <span class="codicon codicon-lightbulb" />
        <span class="think-prev">{open ? "Thinking" : `Thinking · ${preview}…`}</span>
      </button>
      {open && <div class="think-body"><MarkdownView text={it.title} /></div>}
    </div>
  );
}

/** A pasted/produced image, on the correct chat side; shows a placeholder until the data arrives.
 *  Clicking the loaded image opens the full-size lightbox. */
function ImageItem({ it, images, cv, onZoom }: { it: ActivityItem; images: Record<string, string>; cv?: boolean; onZoom: (uri: string) => void }) {
  const uri = it.imageId ? images[it.imageId] : undefined;
  return (
    <div class={`msg ${it.role ?? "user"}${cv ? " cv" : ""}`}>
      <div class="bubble img">
        {uri
          ? <img src={uri} alt="attached image" title="Click to zoom" onClick={() => onZoom(uri)} />
          : <span class="img-ph"><span class="codicon codicon-device-camera" /> image…</span>}
      </div>
    </div>
  );
}

/** A compact activity line (tool / file / error) threaded on the agent's side; expands to the full result. */
function Chip({ it, dispatch, cv }: { it: ActivityItem; dispatch: ActivityDispatch; cv?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div class={`chip-wrap${it.failed ? " err" : ""}${cv ? " cv" : ""}`}>
      <div class="chip">
        <span class={`codicon codicon-${it.failed ? "error" : it.kind === "tool" && it.result === undefined ? "loading" : ICON[it.kind]}`} />
        <span class="cname">{it.title}</span>
        {it.path
          ? <button class="flink" title={it.path} onClick={() => dispatch.openFile(it.path!)}>{it.detail ?? it.path}</button>
          : it.detail && <span class="ct">{it.detail}</span>}
        {it.result && <span class="cres">↳ {it.result}</span>}
        {it.resultFull && <button class="cexp" title="Show output" onClick={() => setOpen(!open)}><span class={`codicon codicon-chevron-${open ? "up" : "down"}`} /></button>}
      </div>
      {open && it.resultFull && <pre class="cfull">{it.resultFull}</pre>}
    </div>
  );
}

export function App({ vm, dispatch, images, query, setQuery }: {
  vm: ActivityViewModel; dispatch: ActivityDispatch; images: Record<string, string>;
  query: string; setQuery: (q: string) => void;
}) {
  const s = vm.summary;
  const [zoom, setZoom] = useState<string | null>(null);

  // Lowercased search haystack, rebuilt only when the item list changes (NOT per keystroke). Each keystroke
  // then filters precomputed strings — O(n) substring checks, no re-lowercasing of multi-MB tool bodies.
  const index = useMemo(() => buildSearchIndex(vm.items), [vm.items]);

  // Escape closes the image lightbox (only while it's open).
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setZoom(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom]);

  const term = (
    <button class="term" onClick={() => dispatch.terminal()}><span class="codicon codicon-terminal" /> Open terminal</button>
  );
  const transcript = vm.sourcePath ? (
    <button class="term" title={vm.sourcePath} onClick={() => dispatch.transcript()}><span class="codicon codicon-json" /> Open transcript</button>
  ) : null;

  if (vm.tier !== "structured") {
    return (
      <div class="degrade">
        <span class="codicon codicon-circle-slash" />
        <div>Structured activity is unavailable for this runtime.</div>
        <div>Open the terminal to see the live session.</div>
        {term}
      </div>
    );
  }

  // Recent-window search: filters the LOADED (capped) items only — the box label states the scope so this
  // never silently masquerades as a full-transcript search.
  const q = query.trim().toLowerCase();
  const items = filterIndex(index, query);
  const nodes = withDaySeparators(items);
  const tailFromSeq = tailFromSequence(items); // content-visibility boundary, in monotonic-sequence space
  const capped = isCapped(vm.totalItems, vm.items.length, query); // visible "recent N of M", suppressed during search

  return (
    <div>
      <div class="head">
        <h1><span class="codicon codicon-pulse" /> Activity</h1>
        <span class="stat" title="agent messages"><span class="codicon codicon-comment" /> {s.messages}</span>
        <span class="stat" title="tools running"><span class="codicon codicon-loading" /> {s.toolsRunning}</span>
        {s.toolsFailed > 0 && <span class="stat err" title="tools failed"><span class="codicon codicon-error" /> {s.toolsFailed}</span>}
        <span class="stat" title="files changed"><span class="codicon codicon-edit" /> {s.filesChanged.length}</span>
        <span class="stat" title="tokens in/out"><span class="codicon codicon-symbol-numeric" /> {s.tokens.input}/{s.tokens.output}</span>
        <div class="search">
          <span class="codicon codicon-search" />
          <input type="text" placeholder="Search recent activity" value={query} aria-label="Search recent activity"
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
          {query && <button class="sclear" aria-label="Clear search" onClick={() => setQuery("")}><span class="codicon codicon-close" /></button>}
        </div>
        {vm.runtimeVersion && <span class="ver">{vm.runtime} {vm.runtimeVersion}</span>}
        {vm.degradedFreshness && <span class="stale" title="transcript lags the terminal">recent activity</span>}
        {transcript}
        {term}
      </div>
      <div class="feed">
        {vm.sharedCwd && (
          <div class="capnote" title="Multiple agents share this folder — per-agent session history can't be safely stitched here">
            <span class="codicon codicon-info" /> history stitching limited — multiple agents share this folder
          </div>
        )}
        {capped && (
          <button class="capnote" title={vm.sourcePath} onClick={() => dispatch.transcript()}>
            <span class="codicon codicon-history" /> Showing recent {vm.items.length} of {vm.totalItems} — open the full transcript
          </button>
        )}
        {nodes.length === 0
          ? <div class="degrade"><span class="codicon codicon-watch" /><div>{q ? "No matches in recent activity" : "Waiting for activity…"}</div></div>
          : nodes.map((node, idx) => {
            if (typeof node === "string") return <div class="daysep" key={`d${idx}`}><span>{node}</span></div>;
            const cv = node.sequence < tailFromSeq;
            if (node.kind === "boundary") return <Boundary key={node.sequence} it={node} cv={cv} />;
            if (node.kind === "command") return (
              <div class="cmdline" key={node.sequence}><span class="codicon codicon-terminal" /> <span>{node.title}</span></div>
            );
            if (node.kind === "message") return <Bubble key={node.sequence} it={node} cv={cv} />;
            if (node.kind === "thinking") return <Thinking key={node.sequence} it={node} cv={cv} />;
            if (node.kind === "image") return <ImageItem key={node.sequence} it={node} images={images} cv={cv} onZoom={setZoom} />;
            return <Chip key={node.sequence} it={node} dispatch={dispatch} cv={cv} />;
          })}
        {!q && vm.agentState === "working" && (
          <div class="msg agent"><div class="bubble typing" aria-label="agent working"><span /><span /><span /></div></div>
        )}
        {!q && vm.agentState === "needs-input" && (
          <div class="needs"><span class="codicon codicon-comment-discussion" /> waiting for your input</div>
        )}
      </div>
      {zoom && (
        <div class="lightbox" role="dialog" aria-label="image preview" onClick={() => setZoom(null)}>
          <img src={zoom} alt="attached image, full size" onClick={(e) => e.stopPropagation()} />
          <button class="lb-close" aria-label="Close preview" onClick={() => setZoom(null)}><span class="codicon codicon-close" /></button>
        </div>
      )}
    </div>
  );
}

/** Interleave a day-label separator (a string node) whenever the calendar day changes. */
function withDaySeparators(items: ActivityItem[]): Array<ActivityItem | string> {
  const out: Array<ActivityItem | string> = [];
  let lastDay = "";
  for (const it of items) {
    const day = it.timestamp ? it.timestamp.slice(0, 10) : "";
    if (day && day !== lastDay) { out.push(day); lastDay = day; }
    out.push(it);
  }
  return out;
}

/** HH:MM from an ISO timestamp, best-effort (never throws in the webview). */
function hhmm(ts: string): string {
  const m = /T(\d{2}:\d{2})/.exec(ts);
  return m ? m[1] : "";
}
