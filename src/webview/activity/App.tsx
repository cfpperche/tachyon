import { useState } from "preact/hooks";
import type { ActivityItem, ActivityViewModel } from "../../activity/activityView";
import { renderMarkdown, linkify } from "./markdown";

/** Render-only activity cockpit (spec 238). All parsing/normalization happened in the host; this draws
 *  the view-model as a chat (human right, agent left) with the agent's reasoning + tool/file activity. */
export interface ActivityDispatch {
  openFile(path: string): void;
  terminal(): void;
  transcript(): void;
}

const ICON: Record<ActivityItem["kind"], string> = {
  message: "comment", thinking: "lightbulb", image: "device-camera",
  tool: "tools", file: "file", usage: "graph", error: "error", raw: "circle-outline", session: "debug-start",
};

/** A chat bubble — aligned right for the human, left for the agent (markdown-rendered). A long agent
 *  message is clamped with a fade + Show more/less toggle. */
function Bubble({ it }: { it: ActivityItem }) {
  const agent = it.role !== "user";
  // Clamp tall messages by EITHER length or line count (many short lines/lists also render tall).
  const long = it.title.length > 1400 || (it.title.match(/\n/g)?.length ?? 0) > 24;
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState(false); // preview (rendered markdown) by default; toggle to raw source
  return (
    <div class={`msg ${it.role ?? "agent"}`}>
      <div class="bubble">
        {agent && (
          <button class="rawtoggle" title={raw ? "Show preview" : "Show raw markdown"} aria-label="Toggle raw markdown" onClick={() => setRaw(!raw)}>
            <span class={`codicon codicon-${raw ? "eye" : "code"}`} />
          </button>
        )}
        {agent && raw
          ? <pre class="rawmd">{it.title}</pre>
          : <div class={`btext${agent ? " md" : ""}${long && !open ? " clamp" : ""}`}>{agent ? renderMarkdown(it.title) : linkify(it.title)}</div>}
        {long && !raw && <button class="more" onClick={() => setOpen(!open)}>{open ? "Show less" : "Show more"}</button>}
        {it.timestamp && <div class="btime">{hhmm(it.timestamp)}</div>}
      </div>
    </div>
  );
}

/** Collapsible reasoning, agent side. Collapsed by default (the gist is the bubbles + activity). */
function Thinking({ it }: { it: ActivityItem }) {
  const [open, setOpen] = useState(false);
  const preview = it.title.replace(/\s+/g, " ").trim().slice(0, 64);
  return (
    <div class="think">
      <button class="think-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span class={`codicon codicon-chevron-${open ? "down" : "right"}`} />
        <span class="codicon codicon-lightbulb" />
        <span class="think-prev">{open ? "Thinking" : `Thinking · ${preview}…`}</span>
      </button>
      {open && <div class="think-body md">{renderMarkdown(it.title)}</div>}
    </div>
  );
}

/** A pasted/produced image, on the correct chat side; shows a placeholder until the data arrives. */
function ImageItem({ it, images }: { it: ActivityItem; images: Record<string, string> }) {
  const uri = it.imageId ? images[it.imageId] : undefined;
  return (
    <div class={`msg ${it.role ?? "user"}`}>
      <div class="bubble img">
        {uri ? <img src={uri} alt="attached image" /> : <span class="img-ph"><span class="codicon codicon-device-camera" /> image…</span>}
      </div>
    </div>
  );
}

/** A compact activity line (tool / file / error) threaded on the agent's side; expands to the full result. */
function Chip({ it, dispatch }: { it: ActivityItem; dispatch: ActivityDispatch }) {
  const [open, setOpen] = useState(false);
  return (
    <div class={`chip-wrap${it.failed ? " err" : ""}`}>
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

export function App({ vm, dispatch, images }: { vm: ActivityViewModel; dispatch: ActivityDispatch; images: Record<string, string> }) {
  const s = vm.summary;
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

  return (
    <div>
      <div class="head">
        <h1><span class="codicon codicon-pulse" /> Activity</h1>
        <span class="stat" title="agent messages"><span class="codicon codicon-comment" /> {s.messages}</span>
        <span class="stat" title="tools running"><span class="codicon codicon-loading" /> {s.toolsRunning}</span>
        {s.toolsFailed > 0 && <span class="stat err" title="tools failed"><span class="codicon codicon-error" /> {s.toolsFailed}</span>}
        <span class="stat" title="files changed"><span class="codicon codicon-edit" /> {s.filesChanged.length}</span>
        <span class="stat" title="tokens in/out"><span class="codicon codicon-symbol-numeric" /> {s.tokens.input}/{s.tokens.output}</span>
        {vm.runtimeVersion && <span class="ver">{vm.runtime} {vm.runtimeVersion}</span>}
        {vm.degradedFreshness && <span class="stale" title="transcript lags the terminal">recent activity</span>}
        {transcript}
        {term}
      </div>
      <div class="feed">
        {vm.items.length === 0
          ? <div class="degrade"><span class="codicon codicon-watch" /><div>Waiting for activity…</div></div>
          : withDaySeparators(vm.items).map((node, idx) => {
            if (typeof node === "string") return <div class="daysep" key={`d${idx}`}><span>{node}</span></div>;
            if (node.kind === "message") return <Bubble key={node.sequence} it={node} />;
            if (node.kind === "thinking") return <Thinking key={node.sequence} it={node} />;
            if (node.kind === "image") return <ImageItem key={node.sequence} it={node} images={images} />;
            return <Chip key={node.sequence} it={node} dispatch={dispatch} />;
          })}
        {vm.agentState === "working" && (
          <div class="msg agent"><div class="bubble typing" aria-label="agent working"><span /><span /><span /></div></div>
        )}
        {vm.agentState === "needs-input" && (
          <div class="needs"><span class="codicon codicon-comment-discussion" /> waiting for your input</div>
        )}
      </div>
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
