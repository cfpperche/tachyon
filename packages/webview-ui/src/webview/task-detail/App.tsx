import { useEffect, useReducer, useRef, useState } from "preact/hooks";
import { Badge, Button, Chip, EmptyState, Input, PageChrome, Select } from "../shared/ui";
import { MarkdownView } from "../activity/markdown";
import { assigneePatch, priorityPatch } from "../board/interactions";
import { reduceDetailStale, INITIAL_STALE_STATE, selectedReviewablePrototype, type DetailField } from "./interactions";
import type { TaskDetailVM } from "./messages";
import type { TaskPriority, TaskUpdateExpect, TaskUpdateInput } from "@tachyon/shared/tasks/types";
import { PrototypePreview } from "../shared/PrototypePreview";
import { refDisplay } from "./refDisplay";

// spec 335 — the Task Detail panel: the full task (title/body/status/priority/kind/author/assignee/deps/
// artifact_refs/attention), read-only in v1 except the same priority/assignee quick controls the
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
    return <EmptyState kind="error" message={<>Task {vm.id}<br />never found on disk</>} />;
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
      <PageChrome
        class="td-chrome"
        title={t.title}
        actions={
          // t-5564b4 — identity (id/status) and actions are different things; sharing one baseline row
          // with a long wrapped title is what made the header read as rubble. Identity sits under the
          // title, actions stay right-aligned and stop wrapping into the text.
          <div class="ds-actions td-head-actions">
            <Button icon="edit" onClick={() => dispatch.openStudio()}>Edit task</Button>
            <Button icon="refresh" onClick={() => dispatch.refresh()}>Refresh</Button>
          </div>
        }
      />

      <div class="td-identity">
        <span class="ref">{t.id}</span>
        <Badge>{t.status}</Badge>
      </div>

      <div class="td-fields">
        <div class="td-field">
          <span class="ds-section">Priority</span>
          {stale.priorityStale ? (
            <span class="stale-editor">board changed <Button onClick={() => requestRefresh("priority")}>refresh</Button></span>
          ) : (
            <Select value={t.priority !== undefined ? String(t.priority) : ""} disabled={controlsDisabled} onChange={(e) => submitPriority((e.currentTarget as HTMLSelectElement).value)}>
              <option value="">none</option>
              {PRIORITIES.map((p) => <option key={p} value={p}>P{p}</option>)}
            </Select>
          )}
        </div>
        <div class="td-field readonly">
          <span class="ds-section">Kind</span>
          <span>{t.kind ?? <span class="ds-dim">—</span>}</span>
        </div>
        <div class="td-field readonly">
          <span class="ds-section">Author</span>
          <span>{t.author}</span>
        </div>
        <div class="td-field">
          <span class="ds-section">Assignee</span>
          {stale.assigneeStale ? (
            <span class="stale-editor">board changed <Button onClick={() => requestRefresh("assignee")}>refresh</Button></span>
          ) : editingAssignee ? (
            <Input autoFocus value={assigneeValue} disabled={controlsDisabled}
              onInput={(e) => setAssigneeValue((e.currentTarget as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitAssignee(); if (e.key === "Escape") cancelAssignee(); }}
              onBlur={submitAssignee} />
          ) : (
            <Button class={`who-btn${assigneeHistorical ? " historical" : ""}`} disabled={!canEditAssignee} onClick={beginAssignee}>
              {t.assignee ? assigneeLabel : <span class="ds-dim">{assigneeLabel}</span>}
            </Button>
          )}
        </div>
      </div>

      {vm.attention && vm.attention.length > 0 && (
        // t-5564b4 — an attention message is a sentence, not a label. It used to render in `.ds-badge`,
        // which is `white-space: nowrap`, so the whole banner grew to the width of the text and pushed a
        // horizontal scrollbar onto the page. A callout wraps, and reads like the next step it describes.
        <div class="td-attention">
          {vm.attention.map((a) => (
            <div key={a.code} class={`td-callout${a.code === "awaiting_human" ? " awaiting" : ""}`} role="note">
              <span class="codicon codicon-warning td-callout-icon" aria-hidden="true" />
              <div class="td-callout-body">
                <span class="td-callout-text">{a.message}</span>
                {a.ref && <span class="ref td-callout-ref">{a.ref}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {vm.deps.length > 0 && (
        <div class="td-deps">
          <span class="ds-section">Dependencies</span>
          <div class="td-deps-list">
            {vm.deps.map((d) => d.missing
              ? <Badge key={d.id} tone="err">{d.id} · missing</Badge>
              : <Chip key={d.id} onClick={() => dispatch.openTask(d.id)} style={{ cursor: "pointer" }}>{d.title ?? d.id} <span class="ds-dim">· {d.status}</span></Chip>)}
          </div>
        </div>
      )}

      {t.artifact_refs && t.artifact_refs.length > 0 && (
        // t-5564b4 — refs are shas, absolute paths and URLs: variable-length content that a fixed-size
        // label primitive cannot hold. Each row keeps the type as a short label and truncates the value
        // in the MIDDLE, which is the only form that keeps both ends a reader identifies it by. The full
        // string stays in `title`, so nothing is lost — only what is painted is bounded.
        <div class="td-refs">
          <span class="ds-section">Artifact refs</span>
          <ul class="td-ref-list">
            {t.artifact_refs.map((r) => {
              const shown = refDisplay(r.ref);
              return (
                <li key={`${r.type}:${r.ref}`} class="td-ref-row">
                  <span class="td-ref-type">{r.type}</span>
                  <span class="td-ref-value" title={shown.truncated ? shown.full : undefined}>{shown.text}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {vm.prototypes && vm.prototypes.prototypes.length > 0 && (() => {
        // captured into a local const so the closure below narrows on an immutable binding — `vm.prototypes`
        // re-read inside the IIFE doesn't retain the outer truthy check's narrowing across the closure boundary.
        const prototypes = vm.prototypes;
        return (
          <div class="td-prototype">
            <PrototypePreview value={prototypes} onSelect={setSelectedPrototypeId} />
            {(() => {
              const draft = selectedReviewablePrototype(prototypes, selectedPrototypeId);
              if (!draft) return null;
              return <div class="prototype-decision">
                <label>First-party review note<textarea value={prototypeReview} maxLength={4000} onInput={(e) => setPrototypeReview((e.currentTarget as HTMLTextAreaElement).value)} /></label>
                <div class="ds-actions">
                  <Button onClick={() => { dispatch.notePrototype(draft.id, prototypes.updatedAt!, prototypeReview); setPrototypeReview(""); }}>Add note</Button>
                  <Button onClick={() => dispatch.rejectPrototype(draft.id, prototypes.updatedAt!, prototypeReview)}>Request changes</Button>
                  <Button onClick={() => dispatch.approvePrototype(draft.id, prototypes.updatedAt!, prototypeReview)}>Approve prototype</Button>
                </div>
              </div>;
            })()}
          </div>
        );
      })()}

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
