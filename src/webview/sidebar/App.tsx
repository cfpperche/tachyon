import { createContext } from "preact";
import { useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  SAMPLE, TABS, countOf, searchIndex,
  type FleetVM, type TabId, type AgentVM, type AgentStatus, type SearchItem,
} from "../../sidebar/types";
import { primaryActions, moreActions, ACTION_META, type ActionId } from "../../sidebar/actions";
import { sortRows, groupByParent, SORT_LABEL, asSortMode, type SortMode } from "../../sidebar/sortRows";

const Icon = ({ name }: { name: string }) => <span class={`codicon codicon-${name}`} aria-hidden="true" />;

/** Alphabetical sort glyph — codicons have no A–Z/Z–A icon, so we draw one inline and flip it with the
 *  direction: A↓Z for ascending, Z↑A for descending (letters and arrow both invert on each toggle). */
const SortIcon = ({ dir }: { dir: SortMode }) => {
  const asc = dir === "name-asc";
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <text x="0.5" y="6.9" font-size="7.5" font-weight="700" fill="currentColor">{asc ? "A" : "Z"}</text>
      <text x="0.5" y="15" font-size="7.5" font-weight="700" fill="currentColor">{asc ? "Z" : "A"}</text>
      <g stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
        {asc
          ? <><path d="M12 3.4 V11" /><path d="M9.9 8.9 L12 11.6 L14.1 8.9" /></>
          : <><path d="M12 12.6 V5" /><path d="M9.9 7.1 L12 4.4 L14.1 7.1" /></>}
      </g>
    </svg>
  );
};

/** The host bridge (from main.tsx). Each method's LAST arg is the target folder's wsHash, so multi-root
 *  actions route to the right workspace (omitted → the first). */
export interface Dispatch {
  action: (id: ActionId, agent: string, wsHash?: string) => void;
  section: (op: string, id: string, extra?: { done?: boolean; label?: string }, wsHash?: string) => void;
  global: (op: GlobalOp, wsHash?: string) => void;
  pipeline: (op: string, name: string, nodeId?: string, wsHash?: string) => void;
  /** spec 242 — persist the chosen sort for a status list (global per-user, per-section). */
  setSort?: (section: "agents" | "terminals", mode: SortMode) => void;
}
/** Global (section-level, not per-row) ops: pins + the per-section "new …" studios. */
export type GlobalOp = "addPin" | "copyBridge" | "init" | "openHandoff" | "openProbes" | "persistenceSettings" | "studio:agents" | "studio:terminals" | "studio:commands" | "studio:runbooks" | "studio:schedules";

/** One entry in the in-webview "..." overflow menu (edit/delete etc. live here across ALL tabs, not inline). */
export interface MenuItem { label: string; icon: string; run: () => void }

/** What rows consume via context: the bridge methods with the folder's wsHash already curried in, plus the
 *  LOCAL opener for the in-webview "more" menu. App builds one of these per folder. */
interface SidebarCtx {
  action: (id: ActionId, agent: string) => void;
  section: (op: string, id: string, extra?: { done?: boolean; label?: string }) => void;
  global: (op: GlobalOp) => void;
  pipeline: (op: string, name: string, nodeId?: string) => void;
  openMore: (items: MenuItem[], x: number, y: number) => void;
}
const NOOP_CTX: SidebarCtx = { action: () => {}, section: () => {}, global: () => {}, pipeline: () => {}, openMore: () => {} };
const DispatchCtx = createContext<SidebarCtx>(NOOP_CTX);

/** Contextual "new …" studio per tab (opens the existing Studio command; it picks the folder itself). */
const STUDIO_OF: Partial<Record<TabId, { op: GlobalOp; label: string }>> = {
  Agents: { op: "studio:agents", label: "New agent" },
  Terminals: { op: "studio:terminals", label: "New terminal" },
  Commands: { op: "studio:commands", label: "New command" },
  Runbooks: { op: "studio:runbooks", label: "New runbook" },
  Schedules: { op: "studio:schedules", label: "New schedule" },
};

const STATUS_ORDER: AgentStatus[] = ["running", "needs", "throttled", "idle", "stopping", "stopped", "crashed"];
const STATUS_LABEL: Record<AgentStatus, string> = { running: "Running", needs: "Needs input", throttled: "Throttled", idle: "Idle", stopping: "Stopping", stopped: "Stopped", crashed: "Crashed" };

function AgentBadges({ a }: { a: AgentVM }) {
  const d = useContext(DispatchCtx);
  return (
    <>
      {a.attention && <span class="badge attn">{a.attention}</span>}
      {a.worktree && <span class="badge">⎇ {a.worktree}</span>}
      {a.verify === "pass" && <span class="badge ok">✓ verified</span>}
      {a.verify === "fail" && <span class="badge err">✗ verify</span>}
      {a.verify === "stale" && <span class="badge">⊘ stale</span>}
      {a.evidence && (
        <span
          class={`badge ${a.evidence.error > 0 ? "err" : a.evidence.warn > 0 ? "warn" : ""}`}
          title={`${a.evidence.total} evidence record(s)${a.evidence.error ? `, ${a.evidence.error} error` : ""}${a.evidence.warn ? `, ${a.evidence.warn} warn` : ""}${a.evidence.stale ? `, ${a.evidence.stale} stale` : ""} — advisory, never gates (list_evidence to read)`}
        >
          ⊙ {a.evidence.total}{a.evidence.stale > 0 ? ` (${a.evidence.stale}⊘)` : ""}
        </span>
      )}
      {a.harness && <span class="badge">⚙ harness</span>}
      {a.resumable && (a.freshStart
        ? <span class="badge warn" title="Saved transcript is gone — Resume starts fresh">↻ fresh start</span>
        : <span class="badge">↻ resumable</span>)}
      {a.forked && <span class="badge">⑂ fork</span>}
      {a.continuity === "stale" && <span class="badge warn" title="Continuity brief is behind recent activity — the agent should checkpoint (set_continuity)">◐ continuity stale</span>}
      {a.continuity === "missing" && <span class="badge" title="No continuity brief yet — the agent hasn't checkpointed its working state">○ no continuity</span>}
      {a.persistenceHooks && a.persistenceHooks.state !== "active" && (
        <button
          class={`badge hook-badge ${a.persistenceHooks.state === "failed" ? "err" : a.persistenceHooks.state === "unknown" ? "" : "warn"}`}
          type="button"
          title={`${a.persistenceHooks.reason ?? `Persistence hooks ${a.persistenceHooks.state}`} — open persistence settings`}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); d.global("persistenceSettings"); }}
        >
          ⛓ hooks {a.persistenceHooks.state}
        </button>
      )}
    </>
  );
}

function AgentRow({ a, flash }: { a: AgentVM; flash: boolean }) {
  const d = useContext(DispatchCtx);
  const hasMeta = a.parent || a.sub || a.attention || a.worktree || a.verify || a.harness || a.resumable || a.forked || (a.continuity && a.continuity !== "fresh") || a.persistenceHooks;
  return (
    <div class={`row${a.parent ? " child" : ""}${flash ? " flash" : ""}`} data-name={a.name.toLowerCase()}>
      <div class="row-top"><span class={`sdot ${a.status}`} role="img" title={STATUS_LABEL[a.status]} aria-label={STATUS_LABEL[a.status]} /><span class="name">{a.name}</span></div>
      {hasMeta && (
        <div class="row-meta">
          {a.parent ? <span class="msub">spawned by {a.parent}</span> : a.sub ? <span class="msub">{a.sub}</span> : null}
          <AgentBadges a={a} />
        </div>
      )}
      <div class="actions" role="group" aria-label={`${a.name} actions`}>
        {primaryActions(a).map((id) => <Act icon={ACTION_META[id].icon} title={ACTION_META[id].label} on={() => d.action(id, a.name)} />)}
        {moreActions(a).length > 0 && <MoreBtn items={moreActions(a).map((id) => ({ label: ACTION_META[id].label, icon: ACTION_META[id].icon, run: () => d.action(id, a.name) }))} />}
      </div>
    </div>
  );
}

function Group({ title, count, collapsed, onToggle, actions, children }: { title: string; count: number; collapsed: boolean; onToggle: () => void; actions?: preact.ComponentChildren; children: preact.ComponentChildren }) {
  // A group with actions (e.g. a pipeline definition with no active run → 0 nodes) is still meaningful —
  // it must show its header + actions, not vanish. Only action-less, empty groups collapse away.
  if (!count && !actions) return null;
  return (
    <>
      <div class={`grp${collapsed ? " collapsed" : ""}`}>
        <button class="grp-toggle" type="button" aria-expanded={!collapsed} onClick={onToggle}>
          <span class="chev">▼</span><span>{title}</span><span class="gcount">{count}</span>
        </button>
        {actions && <span class="grp-actions" onClick={(e) => e.stopPropagation()}>{actions}</span>}
      </div>
      {!collapsed && <div class="grp-body">{children}</div>}
    </>
  );
}

function ListRow({ dot, name, sub, meta, child, actions }: { dot?: AgentStatus | null; name: string; sub?: string; meta?: preact.ComponentChildren; child?: boolean; actions?: preact.ComponentChildren }) {
  return (
    <div class={`row${child ? " child" : ""}`} data-name={name.toLowerCase()}>
      <div class="row-top">{dot ? <span class={`sdot ${dot}`} /> : null}<span class="name">{name}</span>{sub && <span class="msub">· {sub}</span>}</div>
      {meta && <div class="row-meta">{meta}</div>}
      {actions && <div class="actions">{actions}</div>}
    </div>
  );
}

const Act = ({ icon, title, on }: { icon: string; title: string; on: () => void }) => (
  <button class="act" type="button" title={title} aria-label={title}
    onClick={(e) => { e.preventDefault(); e.stopPropagation(); on(); }}>
    <Icon name={icon} />
  </button>
);

/** The "..." overflow trigger — edit/delete (and any secondary action) live here, never inline, on every tab. */
function MoreBtn({ items }: { items: MenuItem[] }) {
  const d = useContext(DispatchCtx);
  if (!items.length) return null;
  return (
    <button class="act" type="button" title="More actions" aria-label="More actions"
      onClick={(e) => { e.stopPropagation(); d.openMore(items, e.clientX, e.clientY); }}>
      <Icon name="ellipsis" />
    </button>
  );
}

const Empty = () => <div class="empty">(none)</div>;

/** spec 245 — a tiny folder-scoped Project Handoff affordance: ◆ glyph + a staleness badge → opens the panel.
 *  Lives in the folder header (multi-root) / top header (single-root). Text + glyph, never color alone. */
function HandoffBtn({ handoff, onOpen }: { handoff?: import("../../sidebar/types").HandoffVM; onOpen: () => void }) {
  // Map staleness → {glyph, label, tone} (mirrors handoffViewModel.stalenessLabel; kept inline so the sidebar
  // bundle doesn't import the panel module). A missing/cold handoff still offers Open (to create it).
  const s = handoff?.staleness;
  const meta = !handoff?.exists ? { glyph: "○", label: "no handoff", tone: "" }
    : s === "needs_distill" ? { glyph: "◆", label: `distill · ${handoff.pendingCount}`, tone: "warn" }
      : s === "possibly_stale" ? { glyph: "◷", label: "stale", tone: "warn" }
        : s === "old" ? { glyph: "✗", label: "old", tone: "err" }
          : { glyph: "○", label: "fresh", tone: "" };
  return (
    <button class="handoff-btn" type="button" title="Open Project Handoff" aria-label={`Project Handoff — ${meta.label}`}
      onClick={(e) => { e.stopPropagation(); onOpen(); }}>
      <span aria-hidden="true">◆</span>
      <span class={`badge${meta.tone ? ` ${meta.tone}` : ""}`}>{meta.glyph} {meta.label}</span>
    </button>
  );
}

/** spec 257 — a TRANSIENT chip shown only while probes are running; opens the Probes inspector. */
function ProbesBtn({ probes, onOpen }: { probes?: { running: number }; onOpen: () => void }) {
  const running = probes?.running ?? 0;
  if (running <= 0) return null; // transient: nothing to show when idle (the toolbar button always opens it)
  return (
    <button class="handoff-btn" type="button" title="Open Probes" aria-label={`${running} probe(s) running`}
      onClick={(e) => { e.stopPropagation(); onOpen(); }}>
      <span aria-hidden="true">⌕</span>
      <span class="badge">● {running} probe{running > 1 ? "s" : ""}</span>
    </button>
  );
}

/** spec 242 — compact per-status count chips in the section header: recovers the overview the status group
 *  headers used to give, now that the list is flat. Non-interactive; non-zero statuses only; SR-labeled. */
function StatusChips({ rows }: { rows: AgentVM[] }) {
  const by: Partial<Record<AgentStatus, number>> = {};
  for (const r of rows) by[r.status] = (by[r.status] ?? 0) + 1;
  const present = STATUS_ORDER.filter((s) => by[s]);
  if (!present.length) return null;
  return (
    <span class="schips" aria-label="status counts">
      {present.map((s) => (
        <span class="schip" title={`${STATUS_LABEL[s]}: ${by[s]}`} aria-label={`${STATUS_LABEL[s]}: ${by[s]}`}>
          <span class={`sdot ${s}`} aria-hidden="true" />{by[s]}
        </span>
      ))}
    </span>
  );
}

function Panel({ tab, fleet, scope, collapsed, toggle, flashName, agentSort, terminalSort, activePinTag, onPinTag }: { tab: TabId; fleet: FleetVM; scope: string; collapsed: Set<string>; toggle: (k: string) => void; flashName: string | null; agentSort: SortMode; terminalSort: SortMode; activePinTag: string | null; onPinTag: (tag: string | null) => void }) {
  const d = useContext(DispatchCtx);
  // Collapse keys are scoped to the folder so multi-root groups with the same name don't collapse together.
  const k = (suffix: string) => `${scope}:${suffix}`;
  if (tab === "Agents") {
    // spec 242 — a flat, human-sorted list (default name-asc is stable: a status change only recolors the dot
    // in place, no reflow). The dot + the header count-chips carry status; no status group headers.
    if (!fleet.agents.length) return <div class="empty">(no agents)</div>;
    const sorted = sortRows(fleet.agents, agentSort, (a) => a.name);
    // spec 304 — group a spawned agent's row next to its parent's; sortRows itself stays parent-unaware.
    const grouped = groupByParent(sorted, (a) => a.name, (a) => a.parent);
    return <>{grouped.map((a) => <AgentRow key={a.name} a={a} flash={a.name === flashName} />)}</>;
  }
  if (tab === "Terminals") {
    // spec 242 — flat human-sorted list (same machinery as Agents); terminals are managed entries with ai:false.
    if (!fleet.terminals.length) return <Empty />;
    const sorted = sortRows(fleet.terminals, terminalSort, (t) => t.name);
    return <>{sorted.map((t) => <AgentRow key={t.name} a={t} flash={t.name === flashName} />)}</>;
  }
  if (tab === "Pipelines") return fleet.pipelines.length ? <>{fleet.pipelines.map((p) => {
    const st = p.status;                       // idle | running | paused | failed
    const live = st === "running" || st === "paused";
    // Node actions mirror the tree: Approve/Reject only on awaiting-approval; Review + Rerun on EVERY node.
    const nodeActs = (n: typeof p.nodes[number]) => {
      const a: preact.ComponentChildren[] = [];
      if (n.label === "awaiting-approval") { a.push(<Act icon="check" title="Approve node" on={() => d.pipeline("node:approve", p.name, n.id)} />, <Act icon="close" title="Reject node" on={() => d.pipeline("node:reject", p.name, n.id)} />); }
      a.push(<Act icon="eye" title="Open node terminal" on={() => d.pipeline("node:inspect", p.name, n.id)} />);
      a.push(<Act icon="git-compare" title="Review changes" on={() => d.pipeline("node:review", p.name, n.id)} />);
      a.push(<Act icon="debug-restart" title="Re-run from here" on={() => d.pipeline("node:rerun", p.name, n.id)} />);
      return <>{a}</>;
    };
    const more = [
      ...(live || st === "failed" ? [{ label: "Edit input", icon: "list-selection", run: () => d.pipeline("editInput", p.name) }] : []),
      { label: "Edit pipeline", icon: "edit", run: () => d.pipeline("edit", p.name) },
      { label: "Delete", icon: "trash", run: () => d.pipeline("delete", p.name) },
    ];
    return (
      <Group title={p.name} count={p.nodes.length} collapsed={collapsed.has(k(`p:${p.name}`))} onToggle={() => toggle(k(`p:${p.name}`))}
        actions={<>
          {st === "idle" && <Act icon="run-all" title="Run" on={() => d.pipeline("run", p.name)} />}
          {live && <Act icon="git-compare" title="Review changes" on={() => d.pipeline("review", p.name)} />}
          {live && <Act icon="stop-circle" title="Cancel run" on={() => d.pipeline("cancel", p.name)} />}
          {st === "failed" && <Act icon="trash" title="Dismiss failed run" on={() => d.pipeline("dismiss", p.name)} />}
          <MoreBtn items={more} />
        </>}>
        {p.nodes.map((n) => <ListRow dot={n.status} name={n.id} sub={n.reason ? `${n.label} — ${n.reason}` : n.label} child actions={nodeActs(n)} />)}
      </Group>
    );
  })}</> : <Empty />;
  if (tab === "Schedules") {
    const props = fleet.proposals ?? [];
    if (!props.length && !fleet.schedules.length) return <Empty />;
    return <>
      {props.length > 0 && (
        <Group title="Pending approval" count={props.length} collapsed={collapsed.has(k("s:prop"))} onToggle={() => toggle(k("s:prop"))}>
          {props.map((p) => (
            <ListRow name={p.name} sub={[p.when, p.by && `by ${p.by}`].filter(Boolean).join(" · ") || undefined}
              meta={p.reason ? <span class="msub">{p.reason}</span> : undefined}
              actions={<><Act icon="check" title="Approve" on={() => d.section("proposal:approve", p.id)} /><Act icon="close" title="Reject" on={() => d.section("proposal:reject", p.id, { label: p.name })} /></>} />
          ))}
        </Group>
      )}
      {fleet.schedules.map((s) => (
        <ListRow dot={s.paused ? "stopped" : "running"} name={s.name} sub={s.when} meta={<span class={`badge${s.paused ? "" : " ok"}`}>{s.next}</span>}
          actions={<>
            <Act icon={s.paused ? "debug-continue" : "debug-pause"} title={s.paused ? "Resume" : "Pause"} on={() => d.section("schedule:pause", s.name)} />
            <MoreBtn items={[
              { label: "Edit in Studio", icon: "edit", run: () => d.section("schedule:edit", s.name) },
              { label: "Edit YAML", icon: "file-code", run: () => d.section("schedule:editYaml", s.name) },
              { label: "Delete", icon: "trash", run: () => d.section("schedule:delete", s.name) },
            ]} />
          </>} />
      ))}
    </>;
  }
  if (tab === "Commands") return fleet.commands.length ? <>{fleet.commands.map((c) => {
    const badge = c.state === "running" ? <span class="badge warn">▶ {c.detail}</span>
      : c.state === "passed" ? <span class="badge ok">✓ {c.detail}</span>
        : c.state === "failed" ? <span class="badge err">✗ {c.detail}</span>
          : <span class="badge">— {c.detail}</span>;
    return <ListRow dot={c.state === "running" ? "running" : null} name={c.name} sub={c.cmd} meta={badge}
      actions={<>
        {c.state !== "running" && <Act icon="play" title="Run" on={() => d.section("command:run", c.name)} />}
        {c.state !== "idle" && <Act icon="eye" title="Open output" on={() => d.section("command:open", c.name)} />}
        <MoreBtn items={[
          { label: "Edit in Studio", icon: "edit", run: () => d.section("command:edit", c.name) },
          { label: "Edit YAML", icon: "file-code", run: () => d.section("command:editYaml", c.name) },
          { label: "Delete", icon: "trash", run: () => d.section("command:delete", c.name) },
        ]} />
      </>} />;
  })}</> : <Empty />;
  if (tab === "Runbooks") return fleet.runbooks.length ? <>{fleet.runbooks.map((r) => {
    const stepBadge = (s: typeof r.steps[number]) =>
      s.state === "passed" ? <span class="badge ok">✓ {s.detail ?? "passed"}</span>
        : s.state === "failed" ? <span class="badge err">✗ {s.detail}</span>
          : s.state === "running" ? <span class="badge warn">▶ running</span>
            : <span class="badge">skipped</span>;
    return (
      <Group title={r.name} count={r.steps.length} collapsed={collapsed.has(k(`r:${r.name}`))} onToggle={() => toggle(k(`r:${r.name}`))}
        actions={<>
          {!r.running && <Act icon="play" title="Run" on={() => d.section("runbook:run", r.name)} />}
          <MoreBtn items={[
            { label: "Edit in Studio", icon: "edit", run: () => d.section("runbook:edit", r.name) },
            { label: "Edit YAML", icon: "file-code", run: () => d.section("runbook:editYaml", r.name) },
            { label: "Delete", icon: "trash", run: () => d.section("runbook:delete", r.name) },
          ]} />
        </>}>
        <div class="row-meta" style="padding:2px 12px 4px">
          {r.running ? <span class="badge warn">▶ running</span>
            : r.failed ? <span class="badge err">✗ {r.detail}</span>
              : r.detail === "never run" ? <span class="badge">— never run</span>
                : <span class="badge ok">✓ {r.detail}</span>}
        </div>
        {r.steps.map((s) => (
          <ListRow child name={`${s.n}. ${s.label}`} meta={stepBadge(s)}
            actions={s.state === "failed" ? <Act icon="eye" title="Open output" on={() => d.section("runbook:step", `${r.name}#${s.n - 1}`)} /> : undefined} />
        ))}
      </Group>
    );
  })}</> : <Empty />;
  // Pins — the shared checklist.
  const pins = activePinTag ? fleet.pins.filter((p) => p.tags.includes(activePinTag)) : fleet.pins;
  return <>
    {pins.length ? pins.map((p) => (
      <div class={`pin${p.done ? " done" : ""}`} data-name={p.text.toLowerCase()}>
        <button class={`box${p.done ? " done" : ""}`} type="button" role="checkbox" aria-checked={p.done}
          aria-label={`${p.done ? "Mark not done" : "Mark done"}: ${p.text}`}
          onClick={() => p.id && d.section("pin:toggle", p.id, { done: !p.done })}>{p.done && <Icon name="check" />}</button>
        <div class="pin-body">
          <span class="txt">{p.text}</span>
          {!!p.attachmentCount && (
            <span class="pin-att" title={`${p.attachmentCount} visual attachment${p.attachmentCount === 1 ? "" : "s"}`}>
              <Icon name="file-media" /> {p.attachmentCount}
            </span>
          )}
          {p.tags.map((tag) => (
            <button class={`pin-tag${tag === activePinTag ? " active" : ""}`} type="button" title={`Filter by #${tag}`} onClick={() => onPinTag(tag)}>
              #{tag}
            </button>
          ))}
          {p.by && <span class="pin-by">— {p.by}</span>}
        </div>
        {p.id && <div class="actions">
          <Act icon="eye" title="Preview pin" on={() => d.section("pin:preview", p.id!)} />
          <Act icon="copy" title="Copy pin ID and title" on={() => d.section("pin:copy", p.id!, { label: p.text })} />
          <MoreBtn items={[
            { label: "Edit", icon: "pencil", run: () => d.section("pin:edit", p.id!) },
            { label: "Delete", icon: "trash", run: () => d.section("pin:delete", p.id!) },
          ]} />
        </div>}
      </div>
    )) : activePinTag ? <div class="empty">No pins tagged #{activePinTag}</div> : <Empty />}
  </>;
}

function CmdK({ fleets, onClose, onPick }: { fleets: FleetVM[]; onClose: () => void; onPick: (it: SearchItem) => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const index = useMemo(() => fleets.flatMap(searchIndex), [fleets]);
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    const hit = t ? index.filter((x) => `${x.name} ${x.hint ?? ""} ${x.keywords ?? ""}`.toLowerCase().includes(t)) : index;
    const out: SearchItem[] = [];
    for (const { id } of TABS) for (const x of hit) if (x.tab === id) out.push(x);
    return out;
  }, [q, index]);
  useEffect(() => { if (sel >= matches.length) setSel(0); }, [matches.length]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      else if (e.key === "Tab") { e.preventDefault(); } // focus trap — keep focus on the input
      else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => (matches.length ? (s + 1) % matches.length : 0)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => (matches.length ? (s - 1 + matches.length) % matches.length : 0)); }
      else if (e.key === "Enter") { e.preventDefault(); if (matches[sel]) onPick(matches[sel]); }
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [matches, sel]);

  let i = -1, cur: string | null = null;
  return (
    <div class="cmdk open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div class="cmdk-panel" role="dialog" aria-modal="true" aria-label="Search the fleet">
        <input autofocus role="combobox" aria-expanded="true" aria-controls="cmdk-list" aria-autocomplete="list"
          aria-activedescendant={matches.length ? `cmdk-opt-${sel}` : undefined}
          placeholder="Go to agent, command, pin, schedule…" aria-label="Global search" value={q}
          onInput={(e) => { setQ((e.target as HTMLInputElement).value); setSel(0); }} />
        <div class="cmdk-results" role="listbox" id="cmdk-list" aria-label="Search results">
          {matches.length === 0 && <div class="ci" style="opacity:.55;cursor:default">No matches</div>}
          {matches.map((m) => {
            i++; const flat = i; const header = m.tab !== cur ? (cur = m.tab) : null;
            return (
              <>
                {header && <div class="ci-group" role="presentation">{header}</div>}
                <div class={`ci${flat === sel ? " sel" : ""}`} role="option" id={`cmdk-opt-${flat}`} aria-selected={flat === sel}
                  onMouseEnter={() => setSel(flat)} onClick={() => onPick(m)}>
                  <Icon name={m.icon} /><span class="ci-name">{m.name}</span>{m.hint && <span class="ci-hint">{m.hint}</span>}
                </div>
              </>
            );
          })}
        </div>
        <div class="cmdk-foot"><span><kbd>↑↓</kbd>navigate</span><span><kbd>↵</kbd>open</span><span><kbd>esc</kbd>close</span></div>
      </div>
    </div>
  );
}

interface MenuState { items: MenuItem[]; x: number; y: number }
function MoreMenu({ menu, onClose }: { menu: MenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const trigger = document.activeElement as HTMLElement | null; // restore focus here on close
    const items = () => Array.from(ref.current?.querySelectorAll<HTMLButtonElement>(".more-item") ?? []);
    setTimeout(() => items()[0]?.focus(), 0); // open with the first item focused (keyboard entry)
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const list = items(); if (!list.length) return;
        const cur = list.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === "ArrowDown" ? (cur + 1) % list.length : (cur - 1 + list.length) % list.length;
        list[next]?.focus();
      }
    };
    document.addEventListener("keydown", h);
    return () => { document.removeEventListener("keydown", h); trigger?.focus?.(); };
  }, [menu]);
  if (!menu) return null;
  const left = Math.max(6, Math.min(menu.x - 8, window.innerWidth - 186));
  const top = Math.min(menu.y, window.innerHeight - (menu.items.length * 28 + 16));
  return (
    <div class="menu-backdrop" onClick={onClose}>
      <div ref={ref} class="more-menu" role="menu" aria-label="Actions" style={`left:${left}px;top:${Math.max(6, top)}px`} onClick={(e) => e.stopPropagation()}>
        {menu.items.map((it) => (
          <button class="more-item" type="button" role="menuitem" onClick={() => { it.run(); onClose(); }}>
            <Icon name={it.icon} /><span>{it.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function App({ fleets = [SAMPLE], dispatch, prefs = {} }: { fleets?: FleetVM[]; dispatch?: Dispatch; prefs?: { agents?: string; terminals?: string } }) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [tab, setTab] = useState<TabId>("Agents");
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [flashName, setFlashName] = useState<string | null>(null);
  const [activePinTag, setActivePinTag] = useState<string | null>(null);
  // spec 242 — sort: the host's persisted pref seeds it; a user choice this session OVERRIDES (and persists),
  // so a stale fleet snapshot can never revert the user's pick (codex D9). Default name-asc.
  const [sortOverride, setSortOverride] = useState<{ agents?: SortMode; terminals?: SortMode }>({});
  const sortAgents = sortOverride.agents ?? asSortMode(prefs.agents);
  const sortTerminals = sortOverride.terminals ?? asSortMode(prefs.terminals);
  const changeSort = (section: "agents" | "terminals", mode: SortMode) => {
    setSortOverride((o) => ({ ...o, [section]: mode })); // optimistic + session-authoritative
    dispatch?.setSort?.(section, mode); // persist for next load
  };
  const isMac = (navigator.platform || "").toLowerCase().includes("mac");
  const toggle = (k: string) => setCollapsed((c) => { const n = new Set(c); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const pinTags = useMemo(() => [...new Set(fleets.flatMap((f) => f.pins.flatMap((p) => p.tags)))].sort((a, b) => a.localeCompare(b)), [fleets]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((o) => !o); } };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, []);

  useEffect(() => {
    if (activePinTag && !pinTags.includes(activePinTag)) setActivePinTag(null);
  }, [activePinTag, pinTags]);

  // Auto-expand a pipeline group the moment it goes active (a run starts) — like the tree's run-aware id.
  // Only on the idle→active TRANSITION, so the user can still collapse a running pipeline afterward.
  const prevActive = useRef<Set<string>>(new Set());
  useEffect(() => {
    const active = new Set<string>();
    for (const f of fleets) for (const p of f.pipelines) if (p.status !== "idle") active.add(`${f.folder?.hash ?? ""}:p:${p.name}`);
    const newly = [...active].filter((k) => !prevActive.current.has(k));
    if (newly.length) setCollapsed((c) => { const n = new Set(c); for (const k of newly) n.delete(k); return n; });
    prevActive.current = active;
  }, [fleets]);

  const pick = (it: SearchItem) => {
    setOpen(false); setTab(it.tab);
    if (it.tab === "Pins") setActivePinTag(null);
    setFlashName(it.name);
    // Scroll + flash the row in ANY section, scoped to the item's folder (multi-root) so a duplicate name
    // in another root doesn't win. Match data-name in JS (no fragile selector escaping for arbitrary text).
    setTimeout(() => {
      const root = it.wsHash ? document.querySelector(`.ws-scope[data-ws="${it.wsHash}"]`) ?? document : document;
      const target = it.name.toLowerCase();
      const el = [...root.querySelectorAll("[data-name]")].find((e) => e.getAttribute("data-name") === target);
      el?.scrollIntoView({ block: "center" });
      el?.classList.add("flash");
      setTimeout(() => el?.classList.remove("flash"), 1100);
    }, 0);
    setTimeout(() => setFlashName(null), 1100);
  };

  const tabKey = (e: KeyboardEvent, idx: number) => {
    let n = idx;
    if (e.key === "ArrowRight") n = (idx + 1) % TABS.length;
    else if (e.key === "ArrowLeft") n = (idx - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = TABS.length - 1;
    else return;
    e.preventDefault();
    const id = TABS[n].id;
    setTab(id);
    setTimeout(() => document.getElementById(`tab-${id}`)?.focus(), 0);
  };
  const closeK = () => { setOpen(false); setTimeout(() => document.getElementById("kbar-trigger")?.focus(), 0); };

  // One curried bridge per folder — rows dispatch without knowing their wsHash; the closure routes it.
  const ctxFor = (hash?: string): SidebarCtx => ({
    action: (id, agent) => dispatch?.action(id, agent, hash),
    section: (op, id, extra) => dispatch?.section(op, id, extra, hash),
    global: (op) => dispatch?.global(op, hash),
    pipeline: (op, name, nodeId) => dispatch?.pipeline(op, name, nodeId, hash),
    openMore: (items, x, y) => setMenu({ items, x, y }),
  });
  const count = (t: TabId) => fleets.reduce((n, f) => n + countOf(f, t), 0);
  const multi = fleets.length > 1;
  // No workspace booted → an honest empty state, never SAMPLE (which would show fake, unactionable rows).
  if (!fleets.length) return (
    <div class="init">
      <Icon name="rocket" />
      <p>No Tachyon workspace.</p>
      <p class="dim">Open a folder, then generate a <code>tachyon.yml</code> to manage its fleet here.</p>
      <button class="init-btn" type="button" onClick={() => dispatch?.global("init")}>
        <Icon name="add" /><span>Initialize Tachyon</span>
      </button>
    </div>
  );
  const renderFolder = (f: FleetVM) => (
    <DispatchCtx.Provider value={ctxFor(f.folder?.hash)}>
      <div class="ws-scope" data-ws={f.folder?.hash ?? ""}>
        <Panel tab={tab} fleet={f} scope={f.folder?.hash ?? ""} collapsed={collapsed} toggle={toggle} flashName={flashName} agentSort={sortAgents} terminalSort={sortTerminals} activePinTag={activePinTag} onPinTag={setActivePinTag} />
      </div>
    </DispatchCtx.Provider>
  );

  return (
    <>
      <div class="kbar" id="kbar-trigger" role="button" tabindex={0} aria-label={`Search agents, commands, pins (${isMac ? "Cmd K" : "Ctrl K"})`}
        onClick={() => setOpen(true)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(true); } }}>
        <Icon name="search" /><span class="kgrow">Search agents, commands, pins…</span><span class="kbd">{isMac ? "⌘K" : "Ctrl K"}</span>
      </div>
      <div class="tabs" role="tablist" aria-label="Sidebar sections">
        {TABS.map(({ id, icon }, i) => (
          <button class={`tab${tab === id ? " active" : ""}`} type="button" role="tab" id={`tab-${id}`}
            aria-selected={tab === id} aria-controls="sidebar-panel" aria-label={`${id} (${count(id)})`}
            tabindex={tab === id ? 0 : -1} onClick={() => setTab(id)} onKeyDown={(e) => tabKey(e, i)}>
            <Icon name={icon} /><span class="cnt">{count(id)}</span>
          </button>
        ))}
      </div>
      {!multi && fleets[0] && (
        <div class="handoff-bar">
          <HandoffBtn handoff={fleets[0].handoff} onOpen={() => dispatch?.global("openHandoff", fleets[0].folder?.hash)} />
          <ProbesBtn probes={fleets[0].probes} onOpen={() => dispatch?.global("openProbes", fleets[0].folder?.hash)} />
        </div>
      )}
      <div class="sec">
        <b>{tab}</b><span class="scount">{count(tab)}</span>
        {(tab === "Agents" || tab === "Terminals") && (() => {
          const section = tab === "Agents" ? "agents" : "terminals";
          const active = section === "agents" ? sortAgents : sortTerminals;
          const rows = fleets.flatMap((f) => (tab === "Agents" ? f.agents : f.terminals));
          // A–Z ⇄ Z–A toggle (one click flips direction); no menu — there are only two alphabetical modes.
          const flipSort = () => changeSort(section, active === "name-asc" ? "name-desc" : "name-asc");
          return <>
            <StatusChips rows={rows} />
            <span class="sec-actions">
              <Act icon="settings-gear" title="Persistence hooks settings" on={() => dispatch?.global("persistenceSettings")} />
              <button class="act" type="button" title={`Sort ${section} — ${SORT_LABEL[active]} (click to flip)`} aria-label={`Sort ${section} (${SORT_LABEL[active]}); click to flip`} onClick={flipSort}><SortIcon dir={active} /></button>
              {STUDIO_OF[tab] && <Act icon="add" title={STUDIO_OF[tab]!.label} on={() => dispatch?.global(STUDIO_OF[tab]!.op)} />}
            </span>
          </>;
        })()}
        {tab !== "Agents" && tab !== "Terminals" && STUDIO_OF[tab] && <span class="sec-new"><Act icon="add" title={STUDIO_OF[tab]!.label} on={() => dispatch?.global(STUDIO_OF[tab]!.op)} /></span>}
        {tab === "Pins" && (
          <span class="sec-actions pin-filter">
            {pinTags.length > 0 && (
              <select value={activePinTag ?? ""} title="Filter pins by tag" aria-label="Filter pins by tag"
                onChange={(e) => setActivePinTag((e.currentTarget as HTMLSelectElement).value || null)}>
                <option value="">all tags</option>
                {pinTags.map((tag) => <option value={tag}>#{tag}</option>)}
              </select>
            )}
            {activePinTag && <button class="tag-clear" type="button" title={`Clear #${activePinTag} filter`} onClick={() => setActivePinTag(null)}>#{activePinTag}<Icon name="close" /></button>}
            <Act icon="add" title="Add pin" on={() => dispatch?.global("addPin")} />
          </span>
        )}
      </div>
      <div class="panel active" role="tabpanel" id="sidebar-panel" aria-labelledby={`tab-${tab}`} tabindex={0}>
        {!multi
          ? renderFolder(fleets[0])
          : fleets.map((f) => {
              const fkey = `folder:${f.folder?.hash}`;
              const fcoll = collapsed.has(fkey);
              return (
                <>
                  <div class={`grp folder${fcoll ? " collapsed" : ""}`} role="button" tabindex={0}
                    onClick={() => toggle(fkey)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(fkey); } }}>
                    <span class="chev">▼</span><Icon name="folder" /><span>{f.folder?.name}</span><span class="gcount">{countOf(f, tab)}</span>
                    <HandoffBtn handoff={f.handoff} onOpen={() => dispatch?.global("openHandoff", f.folder?.hash)} />
                    <ProbesBtn probes={f.probes} onOpen={() => dispatch?.global("openProbes", f.folder?.hash)} />
                  </div>
                  {!fcoll && <div class="folder-body">{renderFolder(f)}</div>}
                </>
              );
            })}
      </div>
      <div class="foot">
        {fleets.map((f) => (
          <button class="bridge-line" type="button" title="Copy Bridge URL" onClick={() => dispatch?.global("copyBridge", f.folder?.hash)}>
            <span class={`dot${f.bridge.connected ? "" : " off"}`} /><b>Bridge</b>
            {multi && <span class="bfolder">{f.folder?.name}</span>}
            <span class="fmeta">:{f.bridge.port} · {f.bridge.connected ? "connected" : "down"}</span>
          </button>
        ))}
      </div>
      {open && <CmdK fleets={fleets} onClose={closeK} onPick={pick} />}
      <MoreMenu menu={menu} onClose={() => setMenu(null)} />
    </>
  );
}
