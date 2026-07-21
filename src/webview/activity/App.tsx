import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { RefObject } from "preact";
import type { ActivityItem, ActivityViewModel } from "../../activity/activityView";
import { MarkdownView, linkify } from "./markdown";
import { highlight } from "./markdownEngine";
import { Badge, Button, EmptyState, IconButton, Input, PageChrome } from "../shared/ui";
import {
  ACTIVITY_FILTER_CATEGORIES,
  ACTIVITY_FILTER_LABELS,
  DEFAULT_ACTIVITY_FILTERS,
  buildSearchIndex,
  filterByActivityTypes,
  filterIndex,
  hiddenByActivityTypes,
  normalizeActivityFilters,
  tailFromSequence,
  toggleActivityFilter,
  type ActivityFilterCategory,
  type ActivityFilterState,
} from "./feedModel";

/** Render-only activity cockpit (spec 238). All parsing/normalization happened in the host; this draws
 *  the view-model as a chat (human right, agent left) with the agent's reasoning + tool/file activity. */
export interface ActivityDispatch {
  openFile(path: string): void;
  terminal(): void;
  loadOlder(): void;
  copyShareText(sequence: number, key: string): void;
  shareExternal(sequence: number, key: string): void;
  shareToAgent(sequence: number, key: string): void;
}

const ICON: Record<ActivityItem["kind"], string> = {
  message: "comment", command: "terminal", nudge: "sparkle", injected: "arrow-circle-down", thinking: "lightbulb", image: "device-camera",
  tool: "tools", file: "file", usage: "graph", error: "error", raw: "circle-outline", session: "debug-start", boundary: "fold",
};

const FILTER_STORAGE_KEY = "tachyon.activity.typeFilters";

function readStoredFilters(): ActivityFilterState {
  try {
    const raw = window.localStorage.getItem(FILTER_STORAGE_KEY);
    return normalizeActivityFilters(raw ? JSON.parse(raw) as Partial<ActivityFilterState> : undefined);
  } catch {
    return { ...DEFAULT_ACTIVITY_FILTERS };
  }
}

function TypeFilters({
  filters,
  hidden,
  onToggle,
  onReset,
}: {
  filters: ActivityFilterState;
  hidden: number;
  onToggle: (category: ActivityFilterCategory) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const active = ACTIVITY_FILTER_CATEGORIES.filter((category) => filters[category]).length;
  return (
    <div class="type-filter">
      <Button
        class={`type-filter-btn${hidden ? " active" : ""}`}
        icon="filter"
        title="Filter visible activity types"
        aria-label="Filter visible activity types"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Types
        {hidden > 0 ? <Badge class="filter-count">{hidden}</Badge> : null}
      </Button>
      {open && (
        <div class="type-menu" role="menu">
          {ACTIVITY_FILTER_CATEGORIES.map((category) => (
            <label class="type-row" key={category}>
              <input type="checkbox" checked={filters[category]} onChange={() => onToggle(category)} />
              <span>{ACTIVITY_FILTER_LABELS[category]}</span>
            </label>
          ))}
          <div class="type-menu-foot">
            <span>{active}/{ACTIVITY_FILTER_CATEGORIES.length} visible</span>
            <Button variant="default" onClick={onReset}>Show all</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ShareActions({
  it,
  dispatch,
  raw,
  onToggleRaw,
}: {
  it: ActivityItem;
  dispatch: ActivityDispatch;
  raw?: boolean;
  onToggleRaw?: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!it.shareKey && !onToggleRaw) return null;
  const click = (fn: () => void) => (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); setOpen(false); fn(); };
  return (
    <span class="share-actions" aria-label="Activity item actions">
      <IconButton
        class="share-trigger"
        name="kebab-vertical"
        title="Activity item actions"
        aria-label="Activity item actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(!open); }}
      />
      {open && (
        <span class="share-menu" role="menu">
          {onToggleRaw && (
            <Button role="menuitem" onClick={click(onToggleRaw)}>
              <span class={`codicon codicon-${raw ? "eye" : "code"}`} />
              <span>{raw ? "Show preview" : "Show raw markdown"}</span>
            </Button>
          )}
          {it.shareKey && (
            <>
              <Button role="menuitem" onClick={click(() => dispatch.copyShareText(it.sequence, it.shareKey!))}>
                <span class="codicon codicon-copy" />
                <span>Copy share text</span>
              </Button>
              <Button role="menuitem" onClick={click(() => dispatch.shareExternal(it.sequence, it.shareKey!))}>
                <span class="codicon codicon-share" />
                <span>Share externally</span>
              </Button>
              <Button role="menuitem" onClick={click(() => dispatch.shareToAgent(it.sequence, it.shareKey!))}>
                <span class="codicon codicon-send" />
                <span>Send to Tachyon agent</span>
              </Button>
            </>
          )}
        </span>
      )}
    </span>
  );
}

/** A compaction boundary — a "context compacted" rule; if the runtime injected a recap, it folds in here as
 *  an expandable summary (NOT a human bubble). History before it is retained. */
function Boundary({ it, dispatch, cv }: { it: ActivityItem; dispatch: ActivityDispatch; cv?: boolean }) {
  const [open, setOpen] = useState(false);
  const interrupted = it.variant === "interrupted";
  return (
    <div class={`boundary-wrap${cv ? " cv" : ""}`}>
      <div class={`boundary${interrupted ? " interrupted" : ""}`}>
        <span class={`codicon codicon-${interrupted ? "debug-stop" : "fold"}`} />
        <span class="blabel">{it.title}</span>
        {it.detail && <span class="bmeta">{it.detail}</span>}
        {it.resultFull && <Button class="bsum" onClick={() => setOpen(!open)}>{open ? "hide summary" : "view summary"}</Button>}
        <ShareActions it={it} dispatch={dispatch} />
      </div>
      {open && it.resultFull && <div class="boundary-summary"><MarkdownView text={it.resultFull} /></div>}
    </div>
  );
}

/** A chat bubble — aligned right for the human, left for the agent (markdown-rendered). A long agent
 *  message is clamped with a fade + Show more/less toggle. */
function Bubble({ it, dispatch, cv }: { it: ActivityItem; dispatch: ActivityDispatch; cv?: boolean }) {
  const agent = it.role !== "user";
  // Clamp tall messages by EITHER length or line count (many short lines/lists also render tall).
  const long = it.title.length > 1400 || (it.title.match(/\n/g)?.length ?? 0) > 24;
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState(false); // preview (rendered markdown) by default; toggle to raw source
  return (
    <div class={`msg ${it.role ?? "agent"}${cv ? " cv" : ""}`}>
      <div class="bubble">
        <ShareActions it={it} dispatch={dispatch} raw={raw} onToggleRaw={agent ? () => setRaw(!raw) : undefined} />
        {agent && raw
          ? <pre class="rawmd">{it.title}</pre>
          : <div class={`btext${long && !open ? " clamp" : ""}`}>{agent ? <MarkdownView text={it.title} /> : linkify(it.title)}</div>}
        {long && !raw && <Button class="more" onClick={() => setOpen(!open)}>{open ? "Show less" : "Show more"}</Button>}
        {it.timestamp && <div class="btime">{hhmm(it.timestamp)}</div>}
      </div>
    </div>
  );
}

/** Collapsible reasoning, agent side. Collapsed by default (the gist is the bubbles + activity). */
function Thinking({ it, dispatch, cv }: { it: ActivityItem; dispatch: ActivityDispatch; cv?: boolean }) {
  const [open, setOpen] = useState(false);
  const preview = it.title.replace(/\s+/g, " ").trim().slice(0, 64);
  return (
    <div class={`think${cv ? " cv" : ""}`}>
      <div class="think-head">
        <Button class="think-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span class={`codicon codicon-chevron-${open ? "down" : "right"}`} />
          <span class="codicon codicon-lightbulb" />
          <span class="think-prev">{open ? "Thinking" : `Thinking · ${preview}…`}</span>
        </Button>
        <ShareActions it={it} dispatch={dispatch} />
      </div>
      {open && <div class="think-body"><MarkdownView text={it.title} /></div>}
    </div>
  );
}

function InjectedContext({ it, dispatch, cv }: { it: ActivityItem; dispatch: ActivityDispatch; cv?: boolean }) {
  const [open, setOpen] = useState(false);
  const body = it.resultFull ?? it.title;
  const preview = body.replace(/\s+/g, " ").trim().slice(0, 96);
  return (
    <div class={`contextline share-host${cv ? " cv" : ""}`} title="Injected context">
      <Button class="context-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span class={`codicon codicon-chevron-${open ? "down" : "right"}`} />
        <span class="codicon codicon-info" />
        <span class="context-label">{it.title}</span>
        {it.detail && <span class="context-meta">{it.detail}</span>}
        {!open && preview && <span class="context-preview">{preview}</span>}
      </Button>
      <ShareActions it={it} dispatch={dispatch} />
      {open && <pre class="context-body">{body}</pre>}
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

/** A tool result that is a unified diff (Edit/Write `structuredPatch`) → starts with an `@@ -n,m +n,m @@` hunk. */
function isUnifiedDiff(s: string): boolean {
  return /^@@ -\d/m.test(s);
}

/** hljs language for a path's extension (best-effort; undefined → highlightAuto). */
const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript",
  py: "python", go: "go", rs: "rust", rb: "ruby", java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", cc: "cpp",
  cs: "csharp", php: "php", json: "json", md: "markdown", sh: "bash", bash: "bash", zsh: "bash", css: "css", scss: "scss",
  html: "xml", xml: "xml", yml: "yaml", yaml: "yaml", toml: "ini", sql: "sql",
};
function langFromPath(p?: string): string | undefined {
  const ext = p?.split("/").pop()?.split(".").pop()?.toLowerCase();
  return ext ? LANG_BY_EXT[ext] : undefined;
}

type DiffRow = { kind: "hunk"; text: string } | { kind: "add" | "del" | "ctx"; oldNo?: number; newNo?: number; text: string };

/** Parse a unified diff into rows carrying old/new line numbers (from the `@@` hunk headers). */
function parseDiffRows(diff: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0, newNo = 0;
  for (const raw of diff.split("\n")) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (m) { oldNo = Number(m[1]); newNo = Number(m[2]); rows.push({ kind: "hunk", text: raw }); continue; }
    if (raw === "…" || raw === "") { rows.push({ kind: "ctx", text: raw }); continue; } // truncation marker / trailing blank
    if (raw.startsWith("+")) { rows.push({ kind: "add", newNo, text: raw.slice(1) }); newNo++; }
    else if (raw.startsWith("-")) { rows.push({ kind: "del", oldNo, text: raw.slice(1) }); oldNo++; }
    else { rows.push({ kind: "ctx", oldNo, newNo, text: raw.replace(/^ /, "") }); oldNo++; newNo++; }
  }
  return rows;
}

/** A unified diff rendered TUI-style: per-line gutter (old/new line no), +/− sign, syntax-highlighted code,
 *  add/del row backgrounds. Syntax highlighting is per-line (loses cross-line block state — fine for a diff). */
function DiffView({ text, path }: { text: string; path?: string }) {
  const lang = langFromPath(path);
  const rows = parseDiffRows(text);
  return (
    <div class="cfull diffv">
      {rows.map((r, i) =>
        r.kind === "hunk" ? (
          <div key={i} class="dvhunk">{r.text}</div>
        ) : (
          <div key={i} class={`dvrow dv-${r.kind}`}>
            <span class="dvno">{r.oldNo ?? ""}</span>
            <span class="dvno">{r.newNo ?? ""}</span>
            <span class="dvsign">{r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}</span>
            <code class="dvcode hljs" dangerouslySetInnerHTML={{ __html: r.text.length ? highlight(r.text, lang) : "&nbsp;" }} />
          </div>
        ),
      )}
    </div>
  );
}

/** A compact activity line (tool / file / error) threaded on the agent's side; expands to the full result.
 *  Not a design-system chip — a bespoke log row; named `aline` so it doesn't shadow the kit's reserved token. */
function ActivityLine({ it, dispatch, cv }: { it: ActivityItem; dispatch: ActivityDispatch; cv?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div class={`aline-wrap${it.failed ? " err" : ""}${cv ? " cv" : ""}`}>
      <div class="aline">
        <span class={`codicon codicon-${it.failed ? "error" : it.kind === "tool" && it.result === undefined ? "loading" : ICON[it.kind]}`} />
        <span class="cname">{it.title}</span>
        {it.path
          ? <Button class="flink" title={it.path} onClick={() => dispatch.openFile(it.path!)}>{it.detail ?? it.path}</Button>
          : it.detail && <span class="ct">{it.detail}</span>}
        {it.result && <span class="cres">↳ {it.result}</span>}
        {it.resultFull && <IconButton class="cexp" name={open ? "chevron-up" : "chevron-down"} title="Show output" onClick={() => setOpen(!open)} />}
        <ShareActions it={it} dispatch={dispatch} />
      </div>
      {open && it.resultFull && (isUnifiedDiff(it.resultFull) ? <DiffView text={it.resultFull} path={it.path} /> : <pre class="cfull">{it.resultFull}</pre>)}
    </div>
  );
}

/**
 * t-610705 (SDD 410 Phase C.2) — this used to be the STANDALONE panel's presentational half, with
 * scroll/prepend/query state lifted into activity/main.tsx's Root (the window WAS the scroll
 * container there). The standalone panel is retired; Control's shell (cockpit/main.tsx) now owns
 * the message listener + vm/images state (same split every other migrated surface uses), and this
 * component owns everything ELSE — including the scroll/prepend machinery that used to live in
 * main.tsx, now retargeted at `scrollContainer` (Control's embed host div) instead of window.
 */
export function App({ vm, prepended, dispatch, images, scrollContainer }: {
  vm?: ActivityViewModel;
  /** True when THIS vm push paged in older items at the top (scroll-anchor case) — travels as its
   *  own prop, set together with `vm` by the same host message, never inferred from vm alone. */
  prepended: boolean;
  dispatch: ActivityDispatch;
  images: Record<string, string>;
  scrollContainer: RefObject<HTMLDivElement>;
}) {
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState<string | null>(null);
  const [filters, setFilters] = useState<ActivityFilterState>(() => readStoredFilters());
  const [atBottom, setAtBottom] = useState(true);
  // Chat sticks to the newest message — but only when the user is already near the bottom (don't yank them
  // back while they scroll up to read history).
  const stick = useRef(true);
  // When the user loads earlier activity, older items prepend at the TOP → keep their view anchored on the
  // item they were reading: record the pre-load scrollHeight (at click), then scroll by the height delta after
  // the SPECIFIC paged VM renders. Gated on `prepended` (not merely "is an anchor armed") so a live append
  // racing in before the paged response can't consume the anchor (codex MAJOR, ported from main.tsx).
  const prependAnchor = useRef<number | null>(null);

  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    const onScroll = () => {
      const near = el.scrollTop + el.clientHeight >= el.scrollHeight - 140;
      stick.current = near;
      setAtBottom(near);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollContainer.current]);

  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    if (prepended && prependAnchor.current != null) {
      el.scrollTop += el.scrollHeight - prependAnchor.current;
      prependAnchor.current = null;
      return;
    }
    if (stick.current && !query) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- prepended always changes together with vm
  }, [vm, images, query]);

  // Lowercased search haystack, rebuilt only when the item list changes (NOT per keystroke). Each keystroke
  // then filters precomputed strings — O(n) substring checks, no re-lowercasing of multi-MB tool bodies.
  const index = useMemo(() => buildSearchIndex(vm?.items ?? []), [vm?.items]);
  useEffect(() => {
    try {
      window.localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filters));
    } catch {
      /* best-effort UI preference */
    }
  }, [filters]);

  // Escape closes the image lightbox (only while it's open).
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setZoom(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom]);

  const term = (
    <Button class="term" icon="terminal" onClick={() => dispatch.terminal()}>Open terminal</Button>
  );

  if (!vm) {
    return <div class="ds-degrade"><span class="codicon codicon-loading" /><div>Loading activity…</div></div>;
  }

  if (vm.tier !== "structured") {
    return (
      <EmptyState
        kind="error"
        icon="circle-slash"
        message="Structured activity is unavailable for this runtime. Open the terminal to see the live session."
        action={term}
      />
    );
  }
  const s = vm.summary;

  // Recent-window search: filters the LOADED (capped) items only — the box label states the scope so this
  // never silently masquerades as a full-transcript search.
  const q = query.trim().toLowerCase();
  const searchedItems = filterIndex(index, query);
  const hiddenByType = hiddenByActivityTypes(searchedItems, filters);
  const items = filterByActivityTypes(searchedItems, filters);
  const nodes = withDaySeparators(items);
  const tailFromSeq = tailFromSequence(items); // content-visibility boundary, in monotonic-sequence space
  const canLoadOlder = !q && !!vm.hasOlder; // older activity exists before the window → offer "load earlier"

  const loadOlder = () => {
    if (scrollContainer.current) prependAnchor.current = scrollContainer.current.scrollHeight;
    dispatch.loadOlder();
  };
  const jumpToLatest = () => {
    stick.current = true;
    scrollContainer.current?.scrollTo({ top: scrollContainer.current.scrollHeight, behavior: "smooth" });
  };

  return (
    <>
    <div>
      <PageChrome
        class="activity-chrome"
        title="Activity"
        actions={
          <div class="activity-head-tools">
            <span class="stat" title="agent messages"><span class="codicon codicon-comment" /> {s.messages}</span>
            <span class="stat" title="tools running"><span class="codicon codicon-loading" /> {s.toolsRunning}</span>
            {s.toolsFailed > 0 && <span class="stat err" title="tools failed"><span class="codicon codicon-error" /> {s.toolsFailed}</span>}
            <span class="stat" title="files changed"><span class="codicon codicon-edit" /> {s.filesChanged.length}</span>
            <span class="stat" title="tokens in/out"><span class="codicon codicon-symbol-numeric" /> {s.tokens.input}/{s.tokens.output}</span>
            <div class="search">
              <span class="codicon codicon-search" />
              <Input type="text" placeholder="Search recent activity" value={query} aria-label="Search recent activity"
                onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
              {query ? <IconButton class="sclear" name="close" title="Clear search" onClick={() => setQuery("")} /> : null}
            </div>
            <TypeFilters
              filters={filters}
              hidden={hiddenByType}
              onToggle={(category) => setFilters((cur) => toggleActivityFilter(cur, category))}
              onReset={() => setFilters({ ...DEFAULT_ACTIVITY_FILTERS })}
            />
            {vm.runtimeVersion && <span class="ver">{vm.runtime} {vm.runtimeVersion}</span>}
            {vm.degradedFreshness && <Badge tone="warn" title="transcript lags the terminal">recent activity</Badge>}
            {term}
          </div>
        }
      />
      <div class="feed">
        {vm.sharedCwd && (
          <div class="capnote" title="This agent shares its folder with others and has no distinct session yet — its history can't be safely attributed here">
            <span class="codicon codicon-info" /> history unavailable — agent shares this folder with no distinct session
          </div>
        )}
        {canLoadOlder && (
          <Button class="capnote" icon="chevron-up" title="Load earlier activity from the durable log" onClick={loadOlder}>
            Load earlier activity
          </Button>
        )}
        {hiddenByType > 0 && (
          <div class="capnote" title="Some loaded activity items are hidden by the type filter">
            <span class="codicon codicon-filter" /> {hiddenByType} hidden by type filter
          </div>
        )}
        {nodes.length === 0
          ? <EmptyState kind="empty" icon="watch" message={searchedItems.length ? "All matching activity is hidden by type filters" : q ? "No matches in recent activity" : "Waiting for activity…"} />
          : nodes.map((node, idx) => {
            if (typeof node === "string") return <div class="daysep" key={`d${idx}`}><span>{node}</span></div>;
            const cv = node.sequence < tailFromSeq;
            if (node.kind === "boundary") return <Boundary key={node.sequence} it={node} dispatch={dispatch} cv={cv} />;
            if (node.kind === "command") return (
              <div class="cmdline share-host" key={node.sequence}><span class="codicon codicon-terminal" /> <span>{node.title}</span><ShareActions it={node} dispatch={dispatch} /></div>
            );
            if (node.kind === "nudge") return (
              <div class="nudgeline share-host" key={node.sequence} title="Tachyon reminder"><span class="codicon codicon-sparkle" /> <span>{node.title}</span><ShareActions it={node} dispatch={dispatch} /></div>
            );
            {/* spec 323 — context silently injected into the session (hook additionalContext / codex developer message) */}
            if (node.kind === "injected") return <InjectedContext key={node.sequence} it={node} dispatch={dispatch} cv={cv} />;
            if (node.kind === "message") return <Bubble key={node.sequence} it={node} dispatch={dispatch} cv={cv} />;
            if (node.kind === "thinking") return <Thinking key={node.sequence} it={node} dispatch={dispatch} cv={cv} />;
            if (node.kind === "image") return <ImageItem key={node.sequence} it={node} images={images} cv={cv} onZoom={setZoom} />;
            return <ActivityLine key={node.sequence} it={node} dispatch={dispatch} cv={cv} />;
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
          <IconButton class="lb-close" name="close" title="Close preview" onClick={() => setZoom(null)} />
        </div>
      )}
    </div>
    {!atBottom && vm.items.length > 0 && (
      <Button class="jump" icon="arrow-down" title="Jump to latest" onClick={jumpToLatest}>Latest</Button>
    )}
    </>
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
