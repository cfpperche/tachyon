import { createContext } from "preact";
import { useContext, useEffect, useMemo, useState } from "preact/hooks";
import {
  SAMPLE, TABS, countOf, searchIndex,
  type FleetVM, type TabId, type AgentVM, type AgentStatus, type SearchItem,
} from "../../sidebar/types";
import { primaryActions, moreActions, ACTION_META, type ActionId } from "../../sidebar/actions";

const Icon = ({ name }: { name: string }) => <span class={`codicon codicon-${name}`} />;

/** Dispatch to the host: run an action on an agent, or open the "more" overflow menu. */
export interface Dispatch { action: (id: ActionId, agent: string) => void; more: (agent: string) => void }
const DispatchCtx = createContext<Dispatch>({ action: () => {}, more: () => {} });

const STATUS_ORDER: AgentStatus[] = ["running", "needs", "idle", "stopped", "crashed"];
const STATUS_LABEL: Record<AgentStatus, string> = { running: "Running", needs: "Needs input", idle: "Idle", stopped: "Stopped", crashed: "Crashed" };

function AgentBadges({ a }: { a: AgentVM }) {
  return (
    <>
      {a.attention && <span class="badge attn">{a.attention}</span>}
      {a.worktree && <span class="badge">⎇ {a.worktree}</span>}
      {a.verify === "pass" && <span class="badge ok">✓ verified</span>}
      {a.verify === "fail" && <span class="badge err">✗ verify</span>}
      {a.verify === "stale" && <span class="badge">⊘ stale</span>}
      {a.harness && <span class="badge">⚙ harness</span>}
      {a.resumable && <span class="badge">↻ resumable</span>}
      {a.fork && <span class="badge">⑂ fork</span>}
    </>
  );
}

function AgentRow({ a, flash }: { a: AgentVM; flash: boolean }) {
  const d = useContext(DispatchCtx);
  const hasMeta = a.parent || a.sub || a.attention || a.worktree || a.verify || a.harness || a.resumable || a.fork;
  return (
    <div class={`row${a.parent ? " child" : ""}${flash ? " flash" : ""}`} data-name={a.name.toLowerCase()}>
      <div class="row-top"><span class={`sdot ${a.status}`} /><span class="name">{a.name}</span></div>
      {hasMeta && (
        <div class="row-meta">
          {a.parent ? <span class="msub">spawned by {a.parent}</span> : a.sub ? <span class="msub">{a.sub}</span> : null}
          <AgentBadges a={a} />
        </div>
      )}
      <div class="actions">
        {primaryActions(a).map((id) => <span class="act" title={ACTION_META[id].label} onClick={() => d.action(id, a.name)}><Icon name={ACTION_META[id].icon} /></span>)}
        {moreActions(a).length > 0 && <span class="act" title="More…" onClick={() => d.more(a.name)}><Icon name="ellipsis" /></span>}
      </div>
    </div>
  );
}

function Group({ title, count, collapsed, onToggle, children }: { title: string; count: number; collapsed: boolean; onToggle: () => void; children: preact.ComponentChildren }) {
  if (!count) return null;
  return (
    <>
      <div class={`grp${collapsed ? " collapsed" : ""}`} onClick={onToggle}><span class="chev">▼</span><span>{title}</span><span class="gcount">{count}</span></div>
      {!collapsed && <div class="grp-body">{children}</div>}
    </>
  );
}

function ListRow({ dot, name, sub, meta, child }: { dot?: AgentStatus | null; name: string; sub?: string; meta?: preact.ComponentChildren; child?: boolean }) {
  return (
    <div class={`row${child ? " child" : ""}`}>
      <div class="row-top">{dot ? <span class={`sdot ${dot}`} /> : null}<span class="name">{name}</span>{sub && <span class="msub">· {sub}</span>}</div>
      {meta && <div class="row-meta">{meta}</div>}
    </div>
  );
}

const Empty = () => <div class="empty">(none)</div>;

function Panel({ tab, fleet, collapsed, toggle, flashName }: { tab: TabId; fleet: FleetVM; collapsed: Set<string>; toggle: (k: string) => void; flashName: string | null }) {
  if (tab === "Agents") {
    const by: Record<string, AgentVM[]> = {};
    for (const a of fleet.agents) (by[a.status] ||= []).push(a);
    const groups = STATUS_ORDER.filter((s) => by[s]?.length);
    if (!groups.length) return <div class="empty">(no agents)</div>;
    return <>{groups.map((s) => (
      <Group title={STATUS_LABEL[s]} count={by[s].length} collapsed={collapsed.has(`a:${s}`)} onToggle={() => toggle(`a:${s}`)}>
        {by[s].map((a) => <AgentRow a={a} flash={a.name === flashName} />)}
      </Group>
    ))}</>;
  }
  if (tab === "Terminals") return fleet.terminals.length ? <>{fleet.terminals.map((t) => <ListRow dot={t.status} name={t.name} sub={t.sub} />)}</> : <Empty />;
  if (tab === "Pipelines") return fleet.pipelines.length ? <>{fleet.pipelines.map((p) => (
    <Group title={p.name} count={p.nodes.length} collapsed={collapsed.has(`p:${p.name}`)} onToggle={() => toggle(`p:${p.name}`)}>
      {p.nodes.map((n) => <ListRow dot={n.status} name={n.id} sub={n.label} child />)}
    </Group>
  ))}</> : <Empty />;
  if (tab === "Schedules") return fleet.schedules.length ? <>{fleet.schedules.map((s) => <ListRow dot="idle" name={s.name} sub={s.when} meta={<span class="badge">next {s.next}</span>} />)}</> : <Empty />;
  if (tab === "Commands") return fleet.commands.length ? <>{fleet.commands.map((c) => <ListRow name={c.name} sub={c.cmd} meta={c.last === "pass" ? <span class="badge ok">✓ passed</span> : c.last === "fail" ? <span class="badge err">✗ failed</span> : <span class="badge">— not run</span>} />)}</> : <Empty />;
  if (tab === "Runbooks") return fleet.runbooks.length ? <>{fleet.runbooks.map((r) => <ListRow name={r.name} sub={`${r.steps} steps`} />)}</> : <Empty />;
  return fleet.pins.length ? <>{fleet.pins.map((p) => (
    <div class={`pin${p.done ? " done" : ""}`}><span class={`box${p.done ? " done" : ""}`}>{p.done && <Icon name="check" />}</span><span class="txt">{p.text}</span></div>
  ))}</> : <Empty />;
}

function CmdK({ fleet, onClose, onPick }: { fleet: FleetVM; onClose: () => void; onPick: (it: SearchItem) => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const index = useMemo(() => searchIndex(fleet), [fleet]);
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    const hit = t ? index.filter((x) => x.name.toLowerCase().includes(t)) : index;
    const out: SearchItem[] = [];
    for (const { id } of TABS) for (const x of hit) if (x.tab === id) out.push(x);
    return out;
  }, [q, index]);
  useEffect(() => { if (sel >= matches.length) setSel(0); }, [matches.length]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
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
      <div class="cmdk-panel">
        <input autofocus placeholder="Go to agent, command, pin, schedule…" aria-label="Global search" value={q} onInput={(e) => { setQ((e.target as HTMLInputElement).value); setSel(0); }} />
        <div class="cmdk-results">
          {matches.length === 0 && <div class="ci" style="opacity:.55;cursor:default">No matches</div>}
          {matches.map((m) => {
            i++; const flat = i; const header = m.tab !== cur ? (cur = m.tab) : null;
            return (
              <>
                {header && <div class="ci-group">{header}</div>}
                <div class={`ci${flat === sel ? " sel" : ""}`} onMouseEnter={() => setSel(flat)} onClick={() => onPick(m)}>
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

export function App({ fleet = SAMPLE, dispatch }: { fleet?: FleetVM; dispatch?: Dispatch }) {
  const [tab, setTab] = useState<TabId>("Agents");
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [flashName, setFlashName] = useState<string | null>(null);
  const isMac = (navigator.platform || "").toLowerCase().includes("mac");
  const toggle = (k: string) => setCollapsed((c) => { const n = new Set(c); n.has(k) ? n.delete(k) : n.add(k); return n; });

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setOpen((o) => !o); } };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, []);

  const pick = (it: SearchItem) => {
    setOpen(false); setTab(it.tab);
    if (it.tab === "Agents") {
      setFlashName(it.name);
      setTimeout(() => { document.querySelector(`.row[data-name="${it.name.toLowerCase()}"]`)?.scrollIntoView({ block: "center" }); }, 0);
      setTimeout(() => setFlashName(null), 1100);
    }
  };

  return (
    <DispatchCtx.Provider value={dispatch ?? { action: () => {}, more: () => {} }}>
      <div class="kbar" onClick={() => setOpen(true)}><Icon name="search" /><span class="kgrow">Search agents, commands, pins…</span><span class="kbd">{isMac ? "⌘K" : "Ctrl K"}</span></div>
      <div class="tabs">
        {TABS.map(({ id, icon }) => (
          <div class={`tab${tab === id ? " active" : ""}`} title={id} onClick={() => setTab(id)}><Icon name={icon} /><span class="cnt">{countOf(fleet, id)}</span></div>
        ))}
      </div>
      <div class="sec"><b>{tab}</b><span class="scount">{countOf(fleet, tab)}</span></div>
      <div class="panel active"><Panel tab={tab} fleet={fleet} collapsed={collapsed} toggle={toggle} flashName={flashName} /></div>
      <div class="foot"><span class="dot" /><b>Bridge</b><span class="fmeta">:{fleet.bridge.port} · {fleet.bridge.connected ? "connected" : "down"} · {fleet.bridge.tools} tools</span></div>
      {open && <CmdK fleet={fleet} onClose={() => setOpen(false)} onPick={pick} />}
    </DispatchCtx.Provider>
  );
}
