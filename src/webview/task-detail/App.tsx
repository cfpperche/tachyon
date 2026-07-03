import { useState } from "preact/hooks";
import { Badge, Button, Input } from "../shared/ui";
import { MarkdownView } from "../activity/markdown";
import { assigneePatch, priorityPatch, isStaleError } from "../mission-control/interactions";
import type { TaskDetailVM } from "./messages";
import type { TaskPriority, TaskUpdateExpect, TaskUpdateInput } from "../../tasks/types";

// spec 335 — the Task Detail panel: the full task (title/body/status/priority/kind/author/assignee/deps/
// artifact_refs/derived SDD/attention), read-only in v1 except the same priority/assignee quick controls the
// board's cards offer. NOT a dialog/modal — a normal editor tab. Reuses the Activity view's sanitized
// MarkdownView for the body (same DOMPurify pipeline the assistant feed and Handoff use — dueto F9).

export interface TaskDetailDispatch {
  updateTask(patch: TaskUpdateInput): void;
  openTask(id: string): void;
  refresh(): void;
}

const PRIORITIES: TaskPriority[] = [0, 1, 2, 3];

export function App({ vm, errorSeq, errorMessage, dispatch }: { vm?: TaskDetailVM; errorSeq: number; errorMessage?: string; dispatch: TaskDetailDispatch }) {
  const [priorityStale, setPriorityStale] = useState(false);
  const [assigneeStale, setAssigneeStale] = useState(false);
  const [assigneeValue, setAssigneeValue] = useState("");
  const [editingAssignee, setEditingAssignee] = useState(false);
  const [lastSeenError, setLastSeenError] = useState(-1);

  if (lastSeenError !== errorSeq && errorSeq >= 0) {
    setLastSeenError(errorSeq);
    if (errorMessage && isStaleError(errorMessage)) { setPriorityStale(true); setAssigneeStale(true); }
  }

  if (!vm) {
    return <div class="ds-degrade"><span class="codicon codicon-loading" /><div>Loading task…</div></div>;
  }
  if (!vm.task) {
    return <div class="ds-empty"><div class="ds-big">Task {vm.id}</div><div>never found on disk</div></div>;
  }
  const t = vm.task;
  const controlsDisabled = vm.tombstone;

  const submitPriority = (raw: string) => {
    if (controlsDisabled) return;
    setPriorityStale(false);
    const expect: TaskUpdateExpect = { updatedAt: t.updatedAt };
    dispatch.updateTask(priorityPatch(raw === "" ? null : (Number(raw) as TaskPriority), expect));
  };
  const beginAssignee = () => { setAssigneeValue(t.assignee ?? ""); setAssigneeStale(false); setEditingAssignee(true); };
  const submitAssignee = () => {
    if (controlsDisabled) return;
    const expect: TaskUpdateExpect = { updatedAt: t.updatedAt };
    dispatch.updateTask(assigneePatch(assigneeValue.trim() || null, expect));
    setEditingAssignee(false);
  };

  return (
    <div class="td-root">
      {vm.tombstone && (
        <div class="ds-banner">
          <span class="codicon codicon-warning" /> This task's file is missing or unreadable. Showing the last known state — quick controls are disabled.
        </div>
      )}
      <div class="td-head">
        <h1 class="ds-title">{t.title}</h1>
        <span class="ref">{t.id}</span>
        <Badge>{t.status}</Badge>
      </div>

      <div class="td-fields">
        <div class="td-field">
          <span class="ds-section">Priority</span>
          {priorityStale ? (
            <span class="stale-editor">board changed <button type="button" onClick={() => setPriorityStale(false)}>refresh</button></span>
          ) : (
            <select value={t.priority !== undefined ? String(t.priority) : ""} disabled={controlsDisabled} onChange={(e) => submitPriority((e.currentTarget as HTMLSelectElement).value)}>
              <option value="">none</option>
              {PRIORITIES.map((p) => <option key={p} value={p}>P{p}</option>)}
            </select>
          )}
        </div>
        <div class="td-field">
          <span class="ds-section">Kind</span>
          <span>{t.kind ?? <span class="ds-dim">—</span>}</span>
        </div>
        <div class="td-field">
          <span class="ds-section">Author</span>
          <span>{t.author}</span>
        </div>
        <div class="td-field">
          <span class="ds-section">Assignee</span>
          {assigneeStale ? (
            <span class="stale-editor">board changed <button type="button" onClick={() => setAssigneeStale(false)}>refresh</button></span>
          ) : editingAssignee ? (
            <Input autoFocus value={assigneeValue} disabled={controlsDisabled}
              onInput={(e) => setAssigneeValue((e.currentTarget as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitAssignee(); if (e.key === "Escape") setEditingAssignee(false); }}
              onBlur={submitAssignee} />
          ) : (
            <button type="button" class="who-btn" disabled={controlsDisabled} onClick={beginAssignee}>
              {t.assignee ?? <span class="ds-dim">unassigned</span>}
            </button>
          )}
        </div>
        {vm.derived?.sdd && (
          <div class="td-field">
            <span class="ds-section">SDD</span>
            <Badge tone={vm.derived.sdd.missing ? "err" : "info"}>{vm.derived.sdd.ref}{vm.derived.sdd.status ? ` · ${vm.derived.sdd.status}` : ""}{vm.derived.sdd.missing ? " · missing" : ""}</Badge>
          </div>
        )}
      </div>

      {vm.attention && vm.attention.length > 0 && (
        <div class="td-attention">
          {vm.attention.map((a) => <div key={a.code} class="ds-badge warn" title={a.ref}>{a.message}</div>)}
        </div>
      )}

      {vm.deps.length > 0 && (
        <div class="td-deps">
          <span class="ds-section">Dependencies</span>
          <div class="td-deps-list">
            {vm.deps.map((d) => d.missing
              ? <span key={d.id} class="ds-badge err">{d.id} · missing</span>
              : <button key={d.id} type="button" class="ds-chip" onClick={() => dispatch.openTask(d.id)}>{d.title ?? d.id} <span class="ds-dim">· {d.status}</span></button>)}
          </div>
        </div>
      )}

      {t.artifact_refs && t.artifact_refs.length > 0 && (
        <div class="td-refs">
          <span class="ds-section">Artifact refs</span>
          <div class="td-deps-list">
            {t.artifact_refs.map((r) => <span key={`${r.type}:${r.ref}`} class="ds-badge">{r.type} · {r.ref}</span>)}
          </div>
        </div>
      )}

      <div class="td-body">
        <span class="ds-section">Body</span>
        {t.body ? <MarkdownView text={t.body} /> : <span class="ds-dim">no body</span>}
      </div>

      <div class="td-actions">
        <Button icon="refresh" onClick={() => dispatch.refresh()}>Refresh</Button>
      </div>
    </div>
  );
}
