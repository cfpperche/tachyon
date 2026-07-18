import { useMemo, useState } from "preact/hooks";
import type { ValidationOutcome } from "../../validations/types";
import type { ValidationExecutorFilter } from "./messages";
import type { ValidationsViewModel, ValidationViewItem } from "./viewModel";

const Icon = ({ name }: { name: string }) => <span class={`codicon codicon-${name}`} aria-hidden="true" />;

export interface ValidationsDispatch {
  refresh(): void;
  close(id: string, outcome: ValidationOutcome, note: string): void;
  assign(id: string, assignee: string, expect: { assignee: string | null; updatedAt: string }): void;
}

function RefList({ refs }: { refs: ValidationViewItem["sourceRefs"] }) {
  if (!refs.length) return null;
  return <div class="validation-refs">{refs.map((ref, i) => <span key={`${ref.type}:${ref.ref}:${i}`}>{ref.type}: {ref.ref}</span>)}</div>;
}

function ValidationCard({ item, dispatch }: { item: ValidationViewItem; dispatch: ValidationsDispatch }) {
  const [expanded, setExpanded] = useState(false);
  const [closing, setClosing] = useState(false);
  const [outcome, setOutcome] = useState<ValidationOutcome>("passed");
  const [note, setNote] = useState("");
  const [assignee, setAssignee] = useState(item.assignee ?? "");
  const open = item.status !== "closed";
  return (
    <article class={`validation-card ${open ? "open" : "closed"}`}>
      <button class="validation-summary" type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <span class="validation-chevron"><Icon name={expanded ? "chevron-down" : "chevron-right"} /></span>
        <span class="validation-primary"><strong>{item.title}</strong><span class="validation-id">{item.id}</span></span>
        <span class="validation-chips">
          {item.type && <span>{item.type}</span>}<span>{item.status}</span><span>{item.executor}</span>
          {item.priority !== undefined && <span>P{item.priority}</span>}<span>{item.assignee ?? "unassigned"}</span>
        </span>
      </button>
      {expanded && <div class="validation-detail">
        {item.instructions && <section><h3>Instructions</h3><p>{item.instructions}</p></section>}
        <section><h3>Source</h3><RefList refs={item.sourceRefs} />{!item.sourceRefs.length && <p class="muted">No source references.</p>}</section>
        <section><h3>Rounds</h3>{item.rounds.length ? <ol>{item.rounds.map((round) => <li key={round.n}>
          <strong>Round {round.n}</strong>{round.outcome ? ` · ${round.outcome}` : ""}{round.assignee ? ` · ${round.assignee}` : ""}
          {round.resultNote && <p>{round.resultNote}</p>}<RefList refs={round.evidenceRefs} />
        </li>)}</ol> : <p class="muted">No completed rounds.</p>}</section>
        {open && <section class="validation-controls">
          <label>Assignee<input value={assignee} maxlength={64} placeholder="human or agent" onInput={(e) => setAssignee(e.currentTarget.value)} /></label>
          <button type="button" disabled={!assignee.trim() || assignee.trim() === item.assignee} onClick={() => dispatch.assign(item.id, assignee.trim(), { assignee: item.assignee ?? null, updatedAt: item.updatedAt })}>Claim / assign</button>
          {!closing ? <button type="button" onClick={() => setClosing(true)}>Close</button> : <div class="validation-close">
            <select value={outcome} onChange={(e) => setOutcome(e.currentTarget.value as ValidationOutcome)}><option value="passed">passed</option><option value="failed">failed</option><option value="skipped">skipped</option></select>
            <textarea value={note} placeholder="Required result note" onInput={(e) => setNote(e.currentTarget.value)} />
            <button type="button" disabled={!note.trim()} onClick={() => dispatch.close(item.id, outcome, note.trim())}>Confirm close</button>
            <button type="button" onClick={() => setClosing(false)}>Cancel</button>
          </div>}
        </section>}
      </div>}
    </article>
  );
}

export function App({ vm, error, dispatch }: { vm?: ValidationsViewModel; error?: string; dispatch: ValidationsDispatch }) {
  const [scope, setScope] = useState<"open" | "closed">("open");
  const [executor, setExecutor] = useState<ValidationExecutorFilter>("all");
  const [type, setType] = useState("all");
  const rows = useMemo(() => (vm?.validations ?? []).filter((item) => (scope === "closed") === (item.status === "closed") && (executor === "all" || item.executor === executor) && (type === "all" || item.type === type)), [vm, scope, executor, type]);
  if (!vm) return <div class="validation-empty"><Icon name="loading" /> Loading validations...</div>;
  return <main class="validations-main">
    <header class="validation-title"><div><h1>Validations</h1><p>{vm.folder}</p></div><button type="button" title="Refresh" aria-label="Refresh validations" onClick={() => dispatch.refresh()}><Icon name="refresh" /></button></header>
    <div class="validation-filters">
      <select aria-label="Validation status" value={scope} onChange={(e) => setScope(e.currentTarget.value as "open" | "closed")}><option value="open">Open</option><option value="closed">Closed</option></select>
      <select aria-label="Validation executor" value={executor} onChange={(e) => setExecutor(e.currentTarget.value as ValidationExecutorFilter)}><option value="all">All executors</option><option value="human">Human</option><option value="agent">Agent</option><option value="either">Either</option></select>
      {vm.types.length > 0 && <select aria-label="Validation type" value={type} onChange={(e) => setType(e.currentTarget.value)}><option value="all">All types</option>{vm.types.map((value) => <option key={value} value={value}>{value}</option>)}</select>}
    </div>
    {error && <div class="validation-warning"><Icon name="error" /> {error}</div>}
    {rows.length ? <div class="validation-list">{rows.map((item) => <ValidationCard key={item.id} item={item} dispatch={dispatch} />)}</div> : <div class="validation-empty">No {scope} validations</div>}
  </main>;
}
