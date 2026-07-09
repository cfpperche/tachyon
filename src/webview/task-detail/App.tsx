import { useEffect, useReducer, useRef, useState } from "preact/hooks";
import { Badge, Button, Input } from "../shared/ui";
import { MarkdownView } from "../activity/markdown";
import { assigneePatch, priorityPatch } from "../mission-control/interactions";
import { reduceDetailStale, INITIAL_STALE_STATE, selectedReviewablePrototype, type DetailField } from "./interactions";
import type { TaskDetailVM } from "./messages";
import type { TaskPriority, TaskUpdateExpect, TaskUpdateInput } from "../../tasks/types";
import { PrototypePreview } from "../shared/PrototypePreview";

// spec 335 — the Task Detail panel: the full task (title/body/status/priority/kind/author/assignee/deps/
// artifact_refs/derived SDD/attention), read-only in v1 except the same priority/assignee quick controls the
// board's cards offer. NOT a dialog/modal — a normal editor tab. Reuses the Activity view's sanitized
// MarkdownView for the body (same DOMPurify pipeline the assistant feed and Handoff use — dueto F9).

export interface TaskDetailDispatch {
  updateTask(patch: TaskUpdateInput): void;
  openTask(id: string): void;
  /** spec 339 — opens Task Studio for this task (the detail tab's "Open in Studio" button). */
  openStudio(): void;
  refresh(): void;
  approvePrototype(prototypeId: string, expectUpdatedAt: string, review?: string): void;
  rejectPrototype(prototypeId: string, expectUpdatedAt: string, review?: string): void;
  notePrototype(prototypeId: string, expectUpdatedAt: string, review: string): void;
}

const PRIORITIES: TaskPriority[] = [0, 1, 2, 3];
const HISTORICAL_ASSIGNEE_STATUSES = new Set(["landed", "done", "dropped"]);
const ASSIGNEE_EDITABLE_STATUSES = new Set(["triaged", "active"]);

export function App({ vm, errorSeq, errorMessage, dispatch }: { vm?: TaskDetailVM; errorSeq: number; errorMessage?: string; dispatch: TaskDetailDispatch }) {
  const [stale, dispatchStale] = useReducer(reduceDetailStale, INITIAL_STALE_STATE);
  const [assigneeValue, setAssigneeValue] = useState("");
  const [editingAssignee, setEditingAssignee] = useState(false);
  const [prototypeReview, setPrototypeReview] = useState("");
  const [selectedPrototypeId, setSelectedPrototypeId] = useState("");
  const [lastSeenError, setLastSeenError] = useState(-1);
  const seenVm = useRef<TaskDetailVM | undefined>(undefined);
  // dogfood round 2 (#1) — pressing Enter calls submitAssignee() directly, then flips editingAssignee to
  // false, which unmounts the focused <Input>; browsers fire a blur on that unmount, which re-invokes
  // submitAssignee() via onBlur with the SAME (now stale) `expect.updatedAt` closure. That duplicate request
  // fails its CAS check after the real one already succeeded, and its late error landed after the real
  // push — see interactions.ts's `vmPush` fix for the other half. Guarding here stops the duplicate request
  // from ever being sent, not just its symptom.
  const assigneeHandled = useRef(false);

  if (lastSeenError !== errorSeq && errorSeq >= 0) {
    setLastSeenError(errorSeq);
    if (errorMessage) dispatchStale({ type: "error", message: errorMessage });
  }

  // dogfood round 1 (#2) — a fresh vm push (now actually live end-to-end, dogfood #1) means the screen already
  // reflects the current task, so a stale marker from an earlier CAS failure no longer applies: auto-clear
  // instead of leaving it sticky forever (the old "refresh" link only dismissed the flag, never re-fetched).
  useEffect(() => {
    if (vm !== seenVm.current) {
      seenVm.current = vm;
      dispatchStale({ type: "vmPush" });
    }
  }, [vm]);

  if (!vm) {
    return <div class="ds-degrade"><span class="codicon codicon-loading" /><div>Loading task…</div></div>;
  }
  if (!vm.task) {
    return <div class="ds-empty"><div class="ds-big">Task {vm.id}</div><div>never found on disk</div></div>;
  }
  const t = vm.task;
  const controlsDisabled = vm.tombstone;
  const assigneeHistorical = HISTORICAL_ASSIGNEE_STATUSES.has(t.status) && !!t.assignee;
  const canEditAssignee = !controlsDisabled && ASSIGNEE_EDITABLE_STATUSES.has(t.status);
  const assigneeLabel = t.assignee ? (assigneeHistorical ? `delivered by ${t.assignee}` : t.assignee) : "unassigned";

  const submitPriority = (raw: string) => {
    if (controlsDisabled) return;
    dispatchStale({ type: "submit", field: "priority" });
    const expect: TaskUpdateExpect = { updatedAt: t.updatedAt };
    dispatch.updateTask(priorityPatch(raw === "" ? null : (Number(raw) as TaskPriority), expect));
  };
  const beginAssignee = () => {
    if (!canEditAssignee) return;
    setAssigneeValue(t.assignee ?? "");
    dispatchStale({ type: "clearField", field: "assignee" });
    setEditingAssignee(true);
    assigneeHandled.current = false;
  };
  const submitAssignee = () => {
    if (controlsDisabled || assigneeHandled.current) return;
    assigneeHandled.current = true;
    dispatchStale({ type: "submit", field: "assignee" });
    const expect: TaskUpdateExpect = { updatedAt: t.updatedAt };
    dispatch.updateTask(assigneePatch(assigneeValue.trim() || null, expect));
    setEditingAssignee(false);
  };
  const cancelAssignee = () => {
    assigneeHandled.current = true;
    setEditingAssignee(false);
  };
  const requestRefresh = (field: DetailField) => {
    dispatchStale({ type: "clearField", field });
    dispatch.refresh();
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
        <div class="ds-actions td-head-actions">
          <Button icon="edit" onClick={() => dispatch.openStudio()}>Open in Studio</Button>
          <Button icon="refresh" onClick={() => dispatch.refresh()}>Refresh</Button>
        </div>
      </div>

      <div class="td-fields">
        <div class="td-field">
          <span class="ds-section">Priority</span>
          {stale.priorityStale ? (
            <span class="stale-editor">board changed <button type="button" onClick={() => requestRefresh("priority")}>refresh</button></span>
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
          {stale.assigneeStale ? (
            <span class="stale-editor">board changed <button type="button" onClick={() => requestRefresh("assignee")}>refresh</button></span>
          ) : editingAssignee ? (
            <Input autoFocus value={assigneeValue} disabled={controlsDisabled}
              onInput={(e) => setAssigneeValue((e.currentTarget as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitAssignee(); if (e.key === "Escape") cancelAssignee(); }}
              onBlur={submitAssignee} />
          ) : (
            <button type="button" class={`who-btn${assigneeHistorical ? " historical" : ""}`} disabled={!canEditAssignee} onClick={beginAssignee}>
              {t.assignee ? assigneeLabel : <span class="ds-dim">{assigneeLabel}</span>}
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

      {vm.prototypes && vm.prototypes.prototypes.length > 0 && (
        <div class="td-prototype">
          <PrototypePreview value={vm.prototypes} onSelect={setSelectedPrototypeId} />
          {(() => {
            const draft = selectedReviewablePrototype(vm.prototypes, selectedPrototypeId);
            if (!draft) return null;
            return <div class="prototype-decision">
              <label>First-party review note<textarea value={prototypeReview} maxLength={4000} onInput={(e) => setPrototypeReview((e.currentTarget as HTMLTextAreaElement).value)} /></label>
              <div class="ds-actions">
                <Button onClick={() => { dispatch.notePrototype(draft.id, vm.prototypes.updatedAt!, prototypeReview); setPrototypeReview(""); }}>Add note</Button>
                <Button onClick={() => dispatch.rejectPrototype(draft.id, vm.prototypes.updatedAt!, prototypeReview)}>Request changes</Button>
                <Button onClick={() => dispatch.approvePrototype(draft.id, vm.prototypes.updatedAt!, prototypeReview)}>Approve prototype</Button>
              </div>
            </div>;
          })()}
        </div>
      )}

      <div class="td-body">
        <span class="ds-section">Body</span>
        {t.body ? <MarkdownView text={t.body} /> : <span class="ds-dim">no body</span>}
      </div>

      <div class="td-journal">
        <span class="ds-section">Notes</span>
        {vm.journal.length > 0 ? (
          <div class="td-journal-list">
            {vm.journal.map((entry) => (
              <article key={entry.id} class="td-journal-entry">
                <div class="td-journal-meta">
                  <span class="td-journal-author">{entry.author}</span>
                  <time dateTime={entry.ts}>{formatJournalTime(entry.ts)}</time>
                </div>
                <MarkdownView text={entry.text} />
              </article>
            ))}
          </div>
        ) : <span class="ds-dim">no notes</span>}
      </div>
    </div>
  );
}

function formatJournalTime(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleString();
}
