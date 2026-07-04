import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Badge, Button, Icon, Input } from "../shared/ui";
import { KitSelect } from "../shared/ui/kit";
import { agentFilterOptions, buildBoardModel, type BoardCardVM, type BoardColumnVM } from "../../tasks/boardModel";
import type { BoardSnapshot } from "../../tasks/boardSnapshot";
import { compareTasksByPriorityRank } from "../../tasks/nextTask";
import type { MissionControlVM } from "./messages";
import { assigneePatch, canSubmitEdit, cardMenuActions, priorityPatch, resolveDrop, resolveReorder, isStaleError, type DragSession } from "./interactions";
import type { Task, TaskPriority, TaskStatus, TaskUpdateExpect, TaskUpdateInput } from "../../tasks/types";
import type { ValidationOutcome } from "../../validations/types";

// spec 335 — Mission Control board. The webview NEVER computes affordances/ordering itself: every column, card
// order, drag legality, and spotlight comes straight out of `boardModel.ts` (pure, shared with tests), fed by
// the snapshot the host pushes. No optimistic mutation: a card's position/fields only ever change when a fresh
// snapshot arrives, so "snap back" on a rejected drop is just... nothing moved in the first place.

export interface MissionControlDispatch {
  updateTask(id: string, patch: TaskUpdateInput): void;
  /** spec 335 (Gated v1.1) — the `resolveReorder` rebalance fallback, routed to `TaskStore.reorderLane`. */
  reorderLane(status: TaskStatus, priority: TaskPriority | undefined, orderedIds: string[], expect: Record<string, string>): void;
  closeValidation(id: string, outcome: ValidationOutcome, result_note: string): void;
  /** spec 339 — opens Task Studio; omit `id` for a new task (replaces the former inline quick-add), pass it
   *  to edit an existing one (the card context menu's "Edit in Studio"). */
  openTaskStudio(id?: string): void;
  openTask(id: string): void;
}

export interface TaskErrorEvent {
  seq: number;
  taskId?: string;
  message: string;
}

interface EditSession {
  field: "assignee" | "priority";
  value: string;
  startUpdatedAt: string;
  stale: boolean;
  pending: boolean;
}

const PRIORITIES: TaskPriority[] = [0, 1, 2, 3];
// t-6da5f0 — the agent filter's "All agents" is a real, selectable sentinel value (Radix Select.Item can't
// take an empty-string value), mapped to/from `selectedChip: string | undefined` at the callback boundary —
// same pattern Task Studio's Priority KitSelect uses for its "none" state.
const ALL_AGENTS = "__all__";

let toastSeq = 0;
interface Toast { id: number; message: string }

export function App({ vm, lastError, dispatch }: { vm?: MissionControlVM; lastError?: TaskErrorEvent; dispatch: MissionControlDispatch }) {
  const [selectedChip, setSelectedChip] = useState<string | undefined>(undefined);
  const [showDropped, setShowDropped] = useState(false);
  // t-5ea4c7 — toolbar search: `searchInput` is what the field shows (instant), `searchQuery` is what actually
  // filters the board (debounced) — so typing feels immediate while `buildBoardModel` isn't re-run per keystroke.
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [liveSnapshot, setLiveSnapshot] = useState<BoardSnapshot | undefined>(undefined);
  const [editSessions, setEditSessions] = useState<Record<string, EditSession>>({});
  const drag = useRef<DragSession | null>(null);
  const [dragAllowed, setDragAllowed] = useState<TaskStatus[] | null>(null);
  const queuedSnapshot = useRef<BoardSnapshot | null>(null);
  const pendingSubmit = useRef<string | null>(null);
  const lastErrorSeq = useRef<number>(-1);
  const [cardMenu, setCardMenu] = useState<CardMenuState | null>(null);
  const [validationClose, setValidationClose] = useState<{ id: string; outcome: ValidationOutcome; note: string } | null>(null);

  const pushToast = (message: string) => {
    const id = ++toastSeq;
    setToasts((t) => [...t, { id, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  };

  // dueto F3 — a push arriving mid-drag is HELD (not applied to the DOM) until the drag ends; the drop itself
  // validates against the queued (latest) state, not the stale one the drag started from.
  useEffect(() => {
    if (!vm) return;
    if (drag.current) { queuedSnapshot.current = vm.snapshot; return; }
    setLiveSnapshot(vm.snapshot);
    // dueto F7 — a fresh push clears an edit session ONLY when it's the echo of that session's own submit;
    // an unrelated external change never discards or overwrites what the user is typing.
    if (pendingSubmit.current) {
      const id = pendingSubmit.current;
      pendingSubmit.current = null;
      setEditSessions((s) => { const { [id]: _drop, ...rest } = s; return rest; });
    }
  }, [vm]);

  useEffect(() => {
    if (!lastError || lastError.seq === lastErrorSeq.current) return;
    lastErrorSeq.current = lastError.seq;
    pushToast(lastError.message);
    if (lastError.taskId && isStaleError(lastError.message)) {
      setEditSessions((s) => {
        const session = s[lastError.taskId!];
        if (!session) return s;
        return { ...s, [lastError.taskId!]: { ...session, stale: true, pending: false } };
      });
    } else if (lastError.taskId) {
      setEditSessions((s) => {
        const session = s[lastError.taskId!];
        if (!session) return s;
        return { ...s, [lastError.taskId!]: { ...session, pending: false } };
      });
    }
  }, [lastError]);

  // t-5ea4c7 — 200ms debounce: re-runs buildBoardModel only after typing settles, not per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setSearchQuery(searchInput), 200);
    return () => clearTimeout(t);
  }, [searchInput]);

  const model = useMemo(
    () => (liveSnapshot ? buildBoardModel({ snapshot: liveSnapshot, selectedChip, searchQuery }) : undefined),
    [liveSnapshot, selectedChip, searchQuery],
  );

  if (!vm || !model || !liveSnapshot) {
    return <div class="ds-degrade"><span class="codicon codicon-loading" /><div>Loading Mission Control…</div></div>;
  }

  const findTask = (id: string): Task | undefined => liveSnapshot.views.find((v) => v.task.id === id)?.task;

  const onDragStart = (card: BoardCardVM, e: DragEvent) => {
    drag.current = { taskId: card.id, fromStatus: card.status, startUpdatedAt: card.updatedAt, priority: card.priority };
    setDragAllowed(liveSnapshot.allowedDropStatuses[card.id] ?? []);
    e.dataTransfer?.setData("text/plain", card.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  };
  const endDrag = () => {
    drag.current = null;
    setDragAllowed(null);
    if (queuedSnapshot.current) { setLiveSnapshot(queuedSnapshot.current); queuedSnapshot.current = null; }
  };
  const onDrop = (targetStatus: TaskStatus, e: DragEvent) => {
    e.preventDefault();
    const session = drag.current;
    if (!session) return;
    const latestSnapshot = queuedSnapshot.current ?? liveSnapshot;
    const latestTask = latestSnapshot.views.find((v) => v.task.id === session.taskId)?.task;
    const allowed = latestSnapshot.allowedDropStatuses[session.taskId] ?? [];
    const decision = resolveDrop(session, latestTask, targetStatus, allowed);
    if (decision.action === "commit") dispatch.updateTask(session.taskId, decision.patch);
    else if (decision.action === "cancel") pushToast("Board changed — retry");
    endDrag();
  };

  // spec 335 (Gated v1.1) — in-column rank reorder. A card is a valid reorder target only when it shares the
  // dragged card's status AND priority (the acceptance criterion's own scope: "two cards with equal priority
  // in the same column"); anything else falls through to the column-level onDrop above (status drag / noop).
  const isReorderTarget = (targetCard: BoardCardVM): boolean => {
    const session = drag.current;
    return !!session && targetCard.status === session.fromStatus && targetCard.priority === session.priority && targetCard.id !== session.taskId;
  };
  const onCardDragOver = (targetCard: BoardCardVM, e: DragEvent) => {
    if (!isReorderTarget(targetCard)) return;
    e.preventDefault();
    e.stopPropagation();
  };
  const onCardDrop = (targetCard: BoardCardVM, e: DragEvent) => {
    const session = drag.current;
    if (!session || !isReorderTarget(targetCard)) return;
    e.preventDefault();
    e.stopPropagation();
    const latestSnapshot = queuedSnapshot.current ?? liveSnapshot;
    const latestTask = latestSnapshot.views.find((v) => v.task.id === session.taskId)?.task;
    const laneOrdered = latestSnapshot.views
      .map((v) => v.task)
      .filter((t) => t.status === session.fromStatus && (t.priority ?? undefined) === (session.priority ?? undefined))
      .sort(compareTasksByPriorityRank);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const dropAfter = e.clientY - rect.top > rect.height / 2;
    const withoutDragged = laneOrdered.filter((t) => t.id !== session.taskId);
    const targetIdx = withoutDragged.findIndex((t) => t.id === targetCard.id);
    const dropBeforeId = dropAfter ? withoutDragged[targetIdx + 1]?.id : targetCard.id;
    const decision = resolveReorder(session, latestTask, laneOrdered, dropBeforeId);
    if (decision.action === "commit") dispatch.updateTask(session.taskId, decision.patch);
    else if (decision.action === "rebalance") dispatch.reorderLane(decision.laneStatus, decision.lanePriority, decision.orderedIds, decision.expect);
    else if (decision.action === "cancel") pushToast("Board changed — retry");
    endDrag();
  };

  // t-c0e711 — right-click opens a custom menu (native browser menu suppressed); "Move to Dropped" reuses
  // the SAME guarded resolveDrop path drags use (a synthetic session from the card's own known state), so a
  // board change underneath still fails closed with the standard retry toast, not a silent overwrite.
  const onCardContextMenu = (card: BoardCardVM, e: MouseEvent) => {
    e.preventDefault();
    const allowed = liveSnapshot.allowedDropStatuses[card.id] ?? [];
    setCardMenu({ taskId: card.id, x: e.clientX, y: e.clientY, actions: cardMenuActions(allowed) });
  };
  const runCardAction = (actionId: string, taskId: string) => {
    setCardMenu(null);
    if (actionId === "open-in-studio") { dispatch.openTaskStudio(taskId); return; }
    if (actionId !== "move-to-dropped") return;
    const latestSnapshot = queuedSnapshot.current ?? liveSnapshot;
    const latestTask = latestSnapshot.views.find((v) => v.task.id === taskId)?.task;
    if (!latestTask) return;
    const session: DragSession = { taskId, fromStatus: latestTask.status, startUpdatedAt: latestTask.updatedAt };
    const allowed = latestSnapshot.allowedDropStatuses[taskId] ?? [];
    const decision = resolveDrop(session, latestTask, "dropped", allowed);
    if (decision.action === "commit") dispatch.updateTask(taskId, decision.patch);
    else if (decision.action === "cancel") pushToast("Board changed — retry");
  };

  const beginEdit = (card: BoardCardVM, field: EditSession["field"]) => {
    const value = field === "assignee" ? (card.assignee ?? "") : (card.priority !== undefined ? String(card.priority) : "");
    setEditSessions((s) => ({ ...s, [card.id]: { field, value, startUpdatedAt: card.updatedAt, stale: false, pending: false } }));
  };
  const changeEdit = (taskId: string, value: string) => {
    setEditSessions((s) => (s[taskId] ? { ...s, [taskId]: { ...s[taskId], value } } : s));
  };
  const cancelEdit = (taskId: string) => setEditSessions((s) => { const { [taskId]: _drop, ...rest } = s; return rest; });
  const refreshStale = (card: BoardCardVM) => {
    const session = editSessions[card.id];
    if (!session) return;
    setEditSessions((s) => ({ ...s, [card.id]: { ...s[card.id], stale: false, startUpdatedAt: card.updatedAt } }));
  };
  // dogfood round 3 (#2) — a native <select>'s onChange fires ONCE, synchronously, with both the state-update
  // (async) and the submit in the same handler; reading `session.value` at submit time raced the state update
  // and always lost, resubmitting the value the editor had BEFORE this change (a no-op patch the store rejects
  // as "requires at least one changed field"). PriorityEditor now passes the freshly-read value straight
  // through instead of relying on the queued state to have landed first.
  // dogfood round 3 (#3) — the board card's assignee editor had the SAME double-submit bug the detail tab's
  // `afe12fa` fixed: submitting (Enter) sets `pending`, which disables the input, which auto-blurs it (a
  // disabled element can't hold focus), which re-fires the onBlur-triggered submit a SECOND time with the
  // original (now-stale) CAS `expect` — a duplicate request landing right after the real one already
  // succeeded, failing its own precondition check. `canSubmitEdit` reuses the session's own `pending` flag
  // (already true by the time the duplicate call happens) instead of adding a new ref.
  const submitEdit = (taskId: string, valueOverride?: string) => {
    const session = editSessions[taskId];
    if (!canSubmitEdit(session)) return;
    const value = valueOverride ?? session.value;
    const expect: TaskUpdateExpect = { updatedAt: session.startUpdatedAt };
    const patch = session.field === "priority"
      ? priorityPatch(value === "" ? null : (Number(value) as TaskPriority), expect)
      : assigneePatch(value.trim() || null, expect);
    pendingSubmit.current = taskId;
    setEditSessions((s) => ({ ...s, [taskId]: { ...s[taskId], pending: true } }));
    dispatch.updateTask(taskId, patch);
  };

  // dogfood round 2 (#5) — maintainer decision: the chip row + "+N more" overflow toggle (round 1, #5) is
  // replaced entirely by ONE dropdown holding every filter option (declared, human, ad-hoc), dots/colors
  // preserved via inline option styling — see agentFilterOptions in boardModel.ts for the ordering.
  const filterOptions = agentFilterOptions(model);

  return (
    <div class="mc-root">
      <div class="mc-head">
        <h1 class="ds-title"><span aria-hidden="true">◆</span> Mission Control <span class="ws">— {vm.folder}</span></h1>
        {/* t-5ea4c7 — toolbar search: HIDES non-matching cards (title/id/kind/assignee/body), unlike Ctrl+F
            find (t-b5e6e5), which never hides anything — the two gestures stay distinct on purpose. */}
        <div class="board-search">
          <Icon name="search" />
          <Input
            aria-label="Search tasks"
            placeholder="Search…"
            value={searchInput}
            onInput={(e) => setSearchInput((e.currentTarget as HTMLInputElement).value)}
          />
          {searchInput && (
            <button type="button" class="board-search-clear" title="Clear search" onClick={() => setSearchInput("")}>
              <Icon name="close" />
            </button>
          )}
        </div>
        <div class="agent-filter">
          <KitSelect
            aria-label="Filter by agent"
            data-testid="board-agent-filter"
            value={selectedChip ?? ALL_AGENTS}
            onValueChange={(value) => setSelectedChip(value === ALL_AGENTS ? undefined : value)}
            options={[
              { value: ALL_AGENTS, label: "All agents" },
              ...filterOptions.map((chip) => ({
                value: chip.agent,
                label: `● ${chip.agent}${!chip.hasWork ? " · idle" : ""}`,
              })),
            ]}
          />
        </div>
        <div class="spacer" />
        <Button icon="add" onClick={() => dispatch.openTaskStudio()}>Task</Button>
        <Button icon={showDropped ? "eye-closed" : "eye"} onClick={() => setShowDropped((v) => !v)}>
          Dropped · {model.dropped.count}
        </Button>
      </div>

      {model.spotlight?.emptyReason && (
        <div class="mc-spotlight-banner">
          <Icon name="info" /> next_task({model.spotlight.agent}): {model.spotlight.emptyReason}
        </div>
      )}

      <ValidationStrip
        validations={model.validations}
        closeState={validationClose}
        onSelect={(id) => setValidationClose({ id, outcome: "passed", note: "" })}
        onChange={(patch) => setValidationClose((s) => (s ? { ...s, ...patch } : s))}
        onCancel={() => setValidationClose(null)}
        onSubmit={() => {
          if (!validationClose || !validationClose.note.trim()) { pushToast("Validation closure needs a note or evidence"); return; }
          dispatch.closeValidation(validationClose.id, validationClose.outcome, validationClose.note.trim());
          setValidationClose(null);
        }}
      />

      <div class="board">
        {model.columns.map((col) => (
          <Column
            key={col.status}
            col={col}
            dragAllowed={dragAllowed}
            editSessions={editSessions}
            onDragStart={onDragStart}
            onDragEndCard={endDrag}
            onDragOverCol={(e) => { if (!dragAllowed || dragAllowed.includes(col.status)) e.preventDefault(); }}
            onDrop={(e) => onDrop(col.status, e)}
            onCardDragOver={onCardDragOver}
            onCardDrop={onCardDrop}
            onOpen={dispatch.openTask}
            onBeginEdit={beginEdit}
            onChangeEdit={changeEdit}
            onSubmitEdit={submitEdit}
            onCancelEdit={cancelEdit}
            onRefreshStale={refreshStale}
            onContextMenu={onCardContextMenu}
          />
        ))}
        {showDropped && (
          <Column
            col={{ status: "dropped", label: "Dropped", count: model.dropped.count, cards: model.dropped.cards }}
            dragAllowed={dragAllowed}
            editSessions={editSessions}
            onDragStart={onDragStart}
            onDragEndCard={endDrag}
            onDragOverCol={(e) => { if (!dragAllowed || dragAllowed.includes("dropped")) e.preventDefault(); }}
            onDrop={(e) => onDrop("dropped" as TaskStatus, e)}
            onCardDragOver={onCardDragOver}
            onCardDrop={onCardDrop}
            onOpen={dispatch.openTask}
            onBeginEdit={beginEdit}
            onChangeEdit={changeEdit}
            onSubmitEdit={submitEdit}
            onCancelEdit={cancelEdit}
            onRefreshStale={refreshStale}
            onContextMenu={onCardContextMenu}
          />
        )}
      </div>

      <div class="toasts" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} class="toast"><Icon name="error" /> {t.message}</div>)}
      </div>

      <CardMenu menu={cardMenu} onRun={runCardAction} onClose={() => setCardMenu(null)} />
    </div>
  );
}

function ValidationStrip({
  validations,
  closeState,
  onSelect,
  onChange,
  onCancel,
  onSubmit,
}: {
  validations: ReturnType<typeof buildBoardModel>["validations"];
  closeState: { id: string; outcome: ValidationOutcome; note: string } | null;
  onSelect(id: string): void;
  onChange(patch: Partial<{ outcome: ValidationOutcome; note: string }>): void;
  onCancel(): void;
  onSubmit(): void;
}) {
  if (!validations || (validations.pendingCount === 0 && validations.candidateCount === 0)) return null;
  const selected = closeState ? validations.cards.find((v) => v.id === closeState.id) : undefined;
  return (
    <section class="validation-strip" aria-label="Validation queue">
      <div class="validation-summary">
        <span class="validation-icon"><Icon name="checklist" /></span>
        <strong>Validations</strong>
        <Badge tone={validations.pendingCount > 0 ? "warn" : "info"}>{validations.pendingCount} pending</Badge>
        {validations.humanPendingCount > 0 && <span class="validation-count">{validations.humanPendingCount} human</span>}
        {validations.agentPendingCount > 0 && <span class="validation-count">{validations.agentPendingCount} agent</span>}
        {validations.candidateCount > 0 && <span class="validation-count">{validations.candidateCount} candidates</span>}
      </div>
      {validations.cards.length > 0 && (
        <div class="validation-list">
          {validations.cards.map((v) => (
            <button key={v.id} type="button" class={`validation-pill${closeState?.id === v.id ? " selected" : ""}`} title={`${v.status} · ${v.executor}${v.assignee ? ` · ${v.assignee}` : ""}`} onClick={() => onSelect(v.id)}>
              <span class="ref">{v.id}</span>
              {v.type && <span class="validation-type">{v.type}</span>}
              <span class="validation-title">{v.title}</span>
              {v.priority !== undefined && <span class={`prio p${v.priority}`}>P{v.priority}</span>}
            </button>
          ))}
        </div>
      )}
      {validations.cards.length === 0 && validations.candidateTitles.length > 0 && (
        <div class="validation-list">
          {validations.candidateTitles.map((title) => <span key={title} class="validation-pill candidate"><span class="validation-title">{title}</span></span>)}
        </div>
      )}
      {selected && closeState && (
        <div class="validation-close">
          <span class="validation-close-title">Close {selected.id}</span>
          <select aria-label="Validation outcome" value={closeState.outcome} onChange={(e) => onChange({ outcome: (e.currentTarget as HTMLSelectElement).value as ValidationOutcome })}>
            <option value="passed">passed</option>
            <option value="failed">failed</option>
            <option value="skipped">skipped</option>
          </select>
          <Input
            value={closeState.note}
            placeholder="note or evidence ref"
            onInput={(e) => onChange({ note: (e.currentTarget as HTMLInputElement).value })}
            onKeyDown={(e) => { if (e.key === "Enter") onSubmit(); if (e.key === "Escape") onCancel(); }}
          />
          <Button icon="check" onClick={onSubmit}>Close</Button>
          <Button icon="close" onClick={onCancel} />
        </div>
      )}
    </section>
  );
}

interface ColumnProps {
  col: BoardColumnVM | { status: TaskStatus; label: string; count: number; cards: BoardCardVM[] };
  dragAllowed: TaskStatus[] | null;
  editSessions: Record<string, EditSession>;
  onDragStart(card: BoardCardVM, e: DragEvent): void;
  onDragEndCard(): void;
  onDragOverCol(e: DragEvent): void;
  onDrop(e: DragEvent): void;
  onCardDragOver(card: BoardCardVM, e: DragEvent): void;
  onCardDrop(card: BoardCardVM, e: DragEvent): void;
  onOpen(id: string): void;
  onBeginEdit(card: BoardCardVM, field: EditSession["field"]): void;
  onChangeEdit(taskId: string, value: string): void;
  onSubmitEdit(taskId: string, value?: string): void;
  onCancelEdit(taskId: string): void;
  onRefreshStale(card: BoardCardVM): void;
  onContextMenu(card: BoardCardVM, e: MouseEvent): void;
}

function Column(p: ColumnProps) {
  const blocked = !!p.dragAllowed && !p.dragAllowed.includes(p.col.status);
  return (
    <div class="col">
      <div class="col-head"><span class="ds-section">{p.col.label}</span><span class="cnt">· {p.col.count}</span></div>
      <div class={`col-body${blocked ? " drag-blocked" : ""}`} onDragOver={p.onDragOverCol} onDrop={p.onDrop}>
        {p.col.cards.map((card) => (
          <Card
            key={card.id}
            card={card}
            session={p.editSessions[card.id]}
            onDragStart={(e) => p.onDragStart(card, e)}
            onDragEnd={p.onDragEndCard}
            onCardDragOver={(e) => p.onCardDragOver(card, e)}
            onCardDrop={(e) => p.onCardDrop(card, e)}
            onOpen={() => p.onOpen(card.id)}
            onBeginEdit={(field) => p.onBeginEdit(card, field)}
            onChangeEdit={(v) => p.onChangeEdit(card.id, v)}
            onSubmitEdit={(v) => p.onSubmitEdit(card.id, v)}
            onCancelEdit={() => p.onCancelEdit(card.id)}
            onRefreshStale={() => p.onRefreshStale(card)}
            onContextMenu={(e) => p.onContextMenu(card, e)}
          />
        ))}
      </div>
    </div>
  );
}

function Card({ card, session, onDragStart, onDragEnd, onCardDragOver, onCardDrop, onOpen, onBeginEdit, onChangeEdit, onSubmitEdit, onCancelEdit, onRefreshStale, onContextMenu }: {
  card: BoardCardVM;
  session?: EditSession;
  onDragStart(e: DragEvent): void;
  onDragEnd(): void;
  onCardDragOver(e: DragEvent): void;
  onCardDrop(e: DragEvent): void;
  onOpen(): void;
  onBeginEdit(field: EditSession["field"]): void;
  onChangeEdit(value: string): void;
  onSubmitEdit(value?: string): void;
  onCancelEdit(): void;
  onRefreshStale(): void;
  onContextMenu(e: MouseEvent): void;
}) {
  const cls = ["card", card.isSpotlight && "next", card.isDimmed && "dimmed"].filter(Boolean).join(" ");
  return (
    // dogfood round 3 (#4, absorbs #1) — the meta row is now the ONE stable place for id/sdd/attention/
    // assignee/priority; the quick-controls stop their own click/contextmenu from ever bubbling to this
    // onClick/onContextMenu (the round-3 click-through: opening an editor also opened the detail tab), so
    // the card handlers no longer need to guess by inspecting e.target.
    // spec 335 (Gated v1.1) — a card is ALSO its own reorder drop target (onDragOver/onDrop); isReorderTarget
    // (App.tsx) no-ops these for any card outside the dragged card's status/priority lane, so they never
    // interfere with the existing column-level status-drop affordance.
    <div class={cls} draggable tabIndex={0} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragOver={onCardDragOver} onDrop={onCardDrop} onContextMenu={onContextMenu} onClick={onOpen}>
      {card.isSpotlight && <span class="next-tag">▶ next_task</span>}
      {card.kind && (
        <div class="top">
          <span class="kind" style={{ color: `var(${card.kindColorVar})`, borderColor: `var(${card.kindColorVar})` }}>{card.kind}</span>
        </div>
      )}
      <p class="title">{card.title}</p>
      <div class="meta">
        <span class="meta-left">
          <span class="ref">{card.id}</span>
          {card.sddStatus && <Badge tone="info">sdd · {card.sddStatus}</Badge>}
          {card.sddMissing && <Badge tone="err">sdd missing</Badge>}
          {card.attention.map((a) => (
            <span key={a.code} class="attn" title={a.message}><Icon name="warning" /></span>
          ))}
          {/* dogfood round 1 (#5, spec 339) — a card with Studio attachments (e.g. a screenshot) previously
              gave no hint it had visuals; count comes read-only from the sidecar via the board snapshot. */}
          {!!card.attachmentCount && (
            <span class="attach-count" title={`${card.attachmentCount} attachment${card.attachmentCount === 1 ? "" : "s"}`}>
              <Icon name="file-media" />{card.attachmentCount}
            </span>
          )}
        </span>
        <span class="quick-controls" onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
          <span class="mc-editable who">
            {session?.field === "assignee" ? (
              <AssigneeEditor session={session} onChange={onChangeEdit} onSubmit={onSubmitEdit} onCancel={onCancelEdit} onRefresh={onRefreshStale} />
            ) : (
              <button type="button" class="who-btn" onClick={() => onBeginEdit("assignee")} title="Edit assignee">
                {card.assignee ? <><span class="dot" style={{ background: `var(${card.assigneeColorVar})` }} />{card.assignee}</> : <span class="ds-dim">unassigned</span>}
              </button>
            )}
          </span>
          <span class="mc-editable prio-edit">
            {session?.field === "priority" ? (
              <PriorityEditor session={session} onChange={onChangeEdit} onSubmit={onSubmitEdit} onCancel={onCancelEdit} onRefresh={onRefreshStale} />
            ) : (
              <button type="button" class="prio-btn" onClick={() => onBeginEdit("priority")} title="Edit priority">
                {card.priority !== undefined ? <span class={`prio p${card.priority}`}>P{card.priority}</span> : <span class="ds-dim">no priority</span>}
              </button>
            )}
          </span>
        </span>
      </div>
    </div>
  );
}

/** dogfood round 4 — `autofocus` on a dynamically-inserted element is unreliable inside a VS Code webview;
 *  focus imperatively on mount instead. */
function focusOnMount(el: HTMLElement | null): void {
  if (el && el.ownerDocument.activeElement !== el) requestAnimationFrame(() => el.focus());
}

function AssigneeEditor({ session, onChange, onSubmit, onCancel, onRefresh }: { session: EditSession; onChange(v: string): void; onSubmit(): void; onCancel(): void; onRefresh(): void }) {
  if (session.stale) {
    return <span class="stale-editor">board changed <button type="button" onClick={onRefresh}>refresh</button></span>;
  }
  return (
    <Input
      ref={focusOnMount}
      autoFocus
      class="assignee-input"
      value={session.value}
      disabled={session.pending}
      placeholder="assignee"
      onInput={(e) => onChange((e.currentTarget as HTMLInputElement).value)}
      onKeyDown={(e) => { if (e.key === "Enter") onSubmit(); if (e.key === "Escape") onCancel(); }}
      onBlur={onSubmit}
    />
  );
}

function PriorityEditor({ session, onChange, onSubmit, onCancel, onRefresh }: { session: EditSession; onChange(v: string): void; onSubmit(value?: string): void; onCancel(): void; onRefresh(): void }) {
  if (session.stale) {
    return <span class="stale-editor">board changed <button type="button" onClick={onRefresh}>refresh</button></span>;
  }
  return (
    <select
      ref={focusOnMount}
      autoFocus
      value={session.value}
      disabled={session.pending}
      onChange={(e) => {
        const value = (e.currentTarget as HTMLSelectElement).value;
        onChange(value);
        onSubmit(value); // dogfood round 3 (#2) — pass the read value directly, don't rely on the queued state
      }}
      onBlur={onCancel}
    >
      <option value="">none</option>
      {PRIORITIES.map((p) => <option key={p} value={p}>P{p}</option>)}
    </select>
  );
}

export interface CardMenuState { taskId: string; x: number; y: number; actions: ReturnType<typeof cardMenuActions> }

/** t-c0e711 — the board card's right-click menu. Mirrors the sidebar's MoreMenu (sidebar/App.tsx) exactly:
 *  a full-screen transparent backdrop closes on click-outside, a fixed-position panel styled with the same
 *  `.menu-backdrop`/`.more-menu`/`.more-item` design-system language, Escape/arrow-key handling via a
 *  document-level listener while open. */
function CardMenu({ menu, onRun, onClose }: { menu: CardMenuState | null; onRun(actionId: string, taskId: string): void; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const items = () => Array.from(ref.current?.querySelectorAll<HTMLButtonElement>(".more-item") ?? []);
    setTimeout(() => items()[0]?.focus(), 0);
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
    return () => document.removeEventListener("keydown", h);
  }, [menu]);
  if (!menu || menu.actions.length === 0) return null;
  const left = Math.max(6, Math.min(menu.x, window.innerWidth - 186));
  const top = Math.min(menu.y, window.innerHeight - (menu.actions.length * 28 + 16));
  return (
    <div class="menu-backdrop" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div ref={ref} class="more-menu" role="menu" aria-label="Card actions" style={`left:${left}px;top:${Math.max(6, top)}px`} onClick={(e) => e.stopPropagation()}>
        {menu.actions.map((a) => (
          <button key={a.id} class="more-item" type="button" role="menuitem" onClick={() => onRun(a.id, menu.taskId)}>
            <Icon name={a.icon} /><span>{a.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
