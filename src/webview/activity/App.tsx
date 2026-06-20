import type { ActivityItem, ActivityViewModel } from "../../activity/activityView";
import { renderMarkdown, inline } from "./markdown";

/** Render-only activity cockpit (spec 238). All parsing/normalization happened in the host; this draws
 *  the view-model as a chat (human right, agent left) with the agent's tool/file activity threaded in. */
export interface ActivityDispatch {
  openFile(path: string): void;
  terminal(): void;
  transcript(): void;
}

const ICON: Record<ActivityItem["kind"], string> = {
  message: "comment",
  tool: "tools",
  file: "file",
  usage: "graph",
  error: "error",
  raw: "circle-outline",
  session: "debug-start",
};

/** A chat bubble — aligned right for the human, left for the agent (markdown-rendered). */
function Bubble({ it }: { it: ActivityItem }) {
  const agent = it.role !== "user";
  return (
    <div class={`msg ${it.role ?? "agent"}`}>
      <div class="bubble">
        <div class="btext md">{agent ? renderMarkdown(it.title) : inline(it.title)}</div>
        {it.timestamp && <div class="btime">{hhmm(it.timestamp)}</div>}
      </div>
    </div>
  );
}

/** A compact activity line (tool / file / error) threaded on the agent's side, between bubbles. */
function Chip({ it, dispatch }: { it: ActivityItem; dispatch: ActivityDispatch }) {
  return (
    <div class={`chip${it.failed ? " err" : ""}`}>
      <span class={`codicon codicon-${it.failed ? "error" : ICON[it.kind]}`} />
      <span class="cname">{it.title}</span>
      {it.path
        ? <button class="flink" title={it.path} onClick={() => dispatch.openFile(it.path!)}>{it.detail ?? it.path}</button>
        : it.detail && <span class="ct">{it.detail}</span>}
      {it.result && <span class="cres">↳ {it.result}</span>}
    </div>
  );
}

export function App({ vm, dispatch }: { vm: ActivityViewModel; dispatch: ActivityDispatch }) {
  const s = vm.summary;
  const term = (
    <button class="term" onClick={() => dispatch.terminal()}>
      <span class="codicon codicon-terminal" /> Open terminal
    </button>
  );
  const transcript = vm.sourcePath ? (
    <button class="term" title={vm.sourcePath} onClick={() => dispatch.transcript()}>
      <span class="codicon codicon-json" /> Open transcript
    </button>
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
          : withDaySeparators(vm.items).map((node, idx) =>
            typeof node === "string"
              ? <div class="daysep" key={`d${idx}`}><span>{node}</span></div>
              : node.kind === "message"
                ? <Bubble key={node.sequence} it={node} />
                : <Chip key={node.sequence} it={node} dispatch={dispatch} />)}
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
