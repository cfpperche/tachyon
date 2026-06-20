import type { ActivityItem, ActivityViewModel } from "../../activity/activityView";

/** Render-only activity cockpit (spec 238). All parsing/normalization happened in the host; this draws
 *  the view-model and routes two actions back: open a referenced file, or drop to the raw terminal. */
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

function Item({ it, dispatch }: { it: ActivityItem; dispatch: ActivityDispatch }) {
  return (
    <div class={`it ${it.kind}${it.failed ? " err" : ""}`}>
      <span class={`codicon codicon-${it.failed ? "error" : ICON[it.kind]}`} />
      <div class="body">
        {it.path ? (
          <button class="flink" title={it.path} onClick={() => dispatch.openFile(it.path!)}>{it.path}</button>
        ) : (
          <div class="t">{it.title}</div>
        )}
        {it.detail && <div class="d">{it.detail}</div>}
      </div>
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
  // The raw transcript the runtime records the session into — present only when we have a structured source.
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
        <span class="stat" title="assistant messages"><span class="codicon codicon-comment" /> {s.messages}</span>
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
          : vm.items.map((it) => <Item key={it.sequence} it={it} dispatch={dispatch} />)}
      </div>
    </div>
  );
}
