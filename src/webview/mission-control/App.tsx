import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { Badge, Button, Icon, Input, IconButton, PageChrome, Select } from "../shared/ui";
import { KitSelect } from "../shared/ui/kit";
import { agentFilterOptions, buildBoardModel, type BoardCardVM, type BoardColumnVM } from "../../tasks/boardModel";
import type { BoardSnapshot } from "../../tasks/boardSnapshot";
import { compareTasksByPriorityRank } from "../../tasks/nextTask";
import type { MissionControlVM } from "./messages";
import { applyAwaitingHumanFilter, assigneePatch, canSubmitEdit, cardMenuActions, priorityPatch, resolveDrop, resolveReorder, isStaleError, shouldShowAwaitingFilterButton, type DragSession } from "./interactions";
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
  copyTaskId(id: string): void;
  switchWorkspace(wsHash: string): void;
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
const FLIP_CARD_ANIMATION_MS = 260;

let toastSeq = 0;
interface Toast { id: number; message: string; tone: "error" | "info" }

export function App({ vm, lastError, dispatch }: { vm?: MissionControlVM; lastError?: TaskErrorEvent; dispatch: MissionControlDispatch }) {
  const [selectedChip, setSelectedChip] = useState<string | undefined>(undefined);
  const [showDropped, setShowDropped] = useState(false);
  // t-2ab324 — toolbar toggle-filter replacing the always-on AwaitingHumanStrip: OFF leaves the board untouched,
  // ON scopes it (via applyAwaitingHumanFilter) to only cards whose task has `awaitingHuman` set.
  const [awaitingOnly, setAwaitingOnly] = useState(false);
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
  const boardRef = useRef<HTMLDivElement>(null);
  const flipFirstRects = useRef<Map<string, DOMRect> | null>(null);
  const flipAnimations = useRef<WeakMap<HTMLElement, Animation>>(new WeakMap());

  const captureCardRects = (): Map<string, DOMRect> | null => {
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
    const board = boardRef.current;
    if (!board) return null;
    const rects = new Map<string, DOMRect>();
    board.querySelectorAll<HTMLElement>(".card[data-card-id]").forEach((el) => {
      if (el.dataset.cardId) rects.set(el.dataset.cardId, el.getBoundingClientRect());
    });
    return rects.size > 0 ? rects : null;
  };

  const applySnapshot = (snapshot: BoardSnapshot) => {
    flipFirstRects.current = captureCardRects();
    setLiveSnapshot(snapshot);
  };

  const pushToast = (message: string, tone: Toast["tone"] = "error") => {
    const id = ++toastSeq;
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  };

  // dueto F3 — a push arriving mid-drag is HELD (not applied to the DOM) until the drag ends; the drop itself
  // validates against the queued (latest) state, not the stale one the drag started from.
  useEffect(() => {
    if (!vm) return;
    if (drag.current) { queuedSnapshot.current = vm.snapshot; return; }
    applySnapshot(vm.snapshot);
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

  useLayoutEffect(() => {
    const firstRects = flipFirstRects.current;
    flipFirstRects.current = null;
    const board = boardRef.current;
    if (!firstRects || !board) return;
    board.querySelectorAll<HTMLElement>(".card[data-card-id]").forEach((el) => {
      const first = el.dataset.cardId ? firstRects.get(el.dataset.cardId) : undefined;
      if (!first) return;
      const last = el.getBoundingClientRect();
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      flipAnimations.current.get(el)?.cancel();
      const animation = el.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: "translate(0, 0)" },
        ],
        {
          duration: FLIP_CARD_ANIMATION_MS,
          easing: "cubic-bezier(.2, 0, .2, 1)",
        },
      );
      flipAnimations.current.set(el, animation);
      animation.onfinish = () => {
        if (flipAnimations.current.get(el) === animation) flipAnimations.current.delete(el);
      };
      animation.oncancel = animation.onfinish;
    });
  }, [model]);

  if (!vm || !model || !liveSnapshot) {
    return <div class="ds-degrade"><span class="codicon codicon-loading" /><div>Loading Board…</div></div>;
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
    if (queuedSnapshot.current) { applySnapshot(queuedSnapshot.current); queuedSnapshot.current = null; }
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
  // t-2ab324 — the toolbar filter scopes the board's columns + dropped bucket down to awaiting-human cards
  // only when `awaitingOnly` is on; `applyAwaitingHumanFilter` is a pure no-op pass-through when it's off.
  const boardScope = applyAwaitingHumanFilter(model.columns, model.dropped, awaitingOnly);
  const awaitingHumanTitle = model.awaitingHuman?.items
    .map((item) => `${item.id} · ${item.kind} · ${item.reason}`)
    .join("\n");

  return (
    <div class="mc-root">
      <div class="mc-head">
        <PageChrome
          class="mc-page-chrome"
          title="Board"
          icon="checklist"
          actions={
            <div class="mc-head-tools">
              <KitSelect
                aria-label="Board workspace"
                data-testid="board-workspace-select"
                class="workspace-select"
                value={vm.wsHash}
                onValueChange={(value) => dispatch.switchWorkspace(value)}
                options={vm.workspaces.map((w) => ({ value: w.hash, label: w.folder }))}
              />
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
                {searchInput ? (
                  <IconButton name="close" title="Clear search" class="board-search-clear" onClick={() => setSearchInput("")} />
                ) : null}
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
              <Button variant="primary" icon="add" onClick={() => dispatch.openTaskStudio()}>
                Task
              </Button>
              {shouldShowAwaitingFilterButton(model.awaitingHuman?.count) && (
                <Button
                  class={awaitingOnly ? "active" : undefined}
                  aria-pressed={awaitingOnly}
                  title={awaitingHumanTitle}
                  onClick={() => setAwaitingOnly((v) => !v)}
                >
                  ⏳ Awaiting you · {model.awaitingHuman?.count}
                </Button>
              )}
              <Button icon={showDropped ? "eye-closed" : "eye"} onClick={() => setShowDropped((v) => !v)}>
                Dropped · {boardScope.dropped.count}
              </Button>
            </div>
          }
        />
      </div>

      {model.spotlight?.emptyReason && (
        <div class="mc-spotlight-banner">
          <Icon name="info" /> next_task({model.spotlight.agent}): {model.spotlight.emptyReason}
        </div>
      )}

      {vm.agentLiveness?.status === "unavailable" && (
        <div class="mc-spotlight-banner" role="status" data-testid="agent-liveness-warning">
          <Icon name="warning" /> Agent status is temporarily unavailable. Tasks are current; the next refresh will retry.
        </div>
      )}

      <div ref={boardRef} class="board">
        {boardScope.columns.map((col) => (
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
            onCopyId={(id) => { dispatch.copyTaskId(id); pushToast(`Copied ${id}`, "info"); }}
          />
        ))}
        {showDropped && (
          <Column
            col={{ status: "dropped", label: "Dropped", count: boardScope.dropped.count, cards: boardScope.dropped.cards }}
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
            onCopyId={(id) => { dispatch.copyTaskId(id); pushToast(`Copied ${id}`, "info"); }}
          />
        )}
      </div>

      <div class="toasts" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} class={`toast ${t.tone}`}><Icon name={t.tone === "error" ? "error" : "check"} /> {t.message}</div>)}
      </div>

      <CardMenu menu={cardMenu} onRun={runCardAction} onClose={() => setCardMenu(null)} />
    </div>
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
  onCopyId(id: string): void;
}

function Column(p: ColumnProps) {
  const blocked = !!p.dragAllowed && !p.dragAllowed.includes(p.col.status);
  const headerCount = `· ${p.col.count}`;
  const renderCard = (card: BoardCardVM) => (
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
      onCopyId={() => p.onCopyId(card.id)}
    />
  );
  return (
    <div class="col">
      <div class="col-head"><span class="ds-section">{p.col.label}</span><span class="cnt">{headerCount}</span></div>
      <div class={`col-body${blocked ? " drag-blocked" : ""}`} onDragOver={p.onDragOverCol} onDrop={p.onDrop}>
        {p.col.cards.map(renderCard)}
      </div>
    </div>
  );
}

function Card({ card, session, onDragStart, onDragEnd, onCardDragOver, onCardDrop, onOpen, onBeginEdit, onChangeEdit, onSubmitEdit, onCancelEdit, onRefreshStale, onContextMenu, onCopyId }: {
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
  onCopyId(): void;
}) {
  // t-1339a8 — the awaiting_human attention code already flows through `card.attention` (TaskStore.attentionFor
  // → boardModel's toCard); this just adds the highlight treatment on top of the existing generic warning icon.
  const isAwaitingHuman = card.attention.some((a) => a.code === "awaiting_human");
  const cls = ["card", card.isSpotlight && "next", card.isDimmed && "dimmed", card.status === "landed" && "landed", isAwaitingHuman && "awaiting-human"].filter(Boolean).join(" ");
  return (
    // dogfood round 3 (#4, absorbs #1) — the meta row is now the ONE stable place for id/sdd/attention/
    // assignee/priority; the quick-controls stop their own click/contextmenu from ever bubbling to this
    // onClick/onContextMenu (the round-3 click-through: opening an editor also opened the detail tab), so
    // the card handlers no longer need to guess by inspecting e.target.
    // spec 335 (Gated v1.1) — a card is ALSO its own reorder drop target (onDragOver/onDrop); isReorderTarget
    // (App.tsx) no-ops these for any card outside the dragged card's status/priority lane, so they never
    // interfere with the existing column-level status-drop affordance.
    <div class={cls} data-card-id={card.id} draggable tabIndex={0} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragOver={onCardDragOver} onDrop={onCardDrop} onContextMenu={onContextMenu} onClick={onOpen}>
      {card.isSpotlight && <span class="next-tag">▶ next_task</span>}
      {card.kind && (
        <div class="top">
          <span class="kind" style={{ color: `var(${card.kindColorVar})`, borderColor: `var(${card.kindColorVar})` }}>{card.kind}</span>
        </div>
      )}
      <p class="title">{card.title}</p>
      <div class="meta">
        <span class="meta-left">
          <Button
            class="ref ref-copy"
            title={`Copy ${card.id}`}
            aria-label={`Copy task ID ${card.id}`}
            onClick={(e) => { e.stopPropagation(); onCopyId(); }}
            onContextMenu={(e) => e.stopPropagation()}
          >
            {card.id}
          </Button>
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
          {!!card.journalCount && (
            <span class="journal-count" title={`${card.journalCount} journal ${card.journalCount === 1 ? "entry" : "entries"}`}>
              <Icon name="note" />{card.journalCount}
            </span>
          )}
        </span>
        <span class="quick-controls" onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
          <span class="mc-editable who">
            {session?.field === "assignee" ? (
              <AssigneeEditor session={session} onChange={onChangeEdit} onSubmit={onSubmitEdit} onCancel={onCancelEdit} onRefresh={onRefreshStale} />
            ) : (
              <Button
                class={`who-btn${card.assigneeHistorical ? " historical" : ""}`}
                disabled={!card.canEditAssignee}
                onClick={() => { if (card.canEditAssignee) onBeginEdit("assignee"); }}
                title={card.canEditAssignee ? "Edit assignee" : card.assigneeLabel}
              >
                {card.assignee ? <><span class="dot" style={{ background: `var(${card.assigneeColorVar})` }} />{card.assigneeLabel}</> : <span class="ds-dim">{card.assigneeLabel}</span>}
              </Button>
            )}
          </span>
          <span class="mc-editable prio-edit">
            {session?.field === "priority" ? (
              <PriorityEditor session={session} onChange={onChangeEdit} onSubmit={onSubmitEdit} onCancel={onCancelEdit} onRefresh={onRefreshStale} />
            ) : (
              <Button class="prio-btn" onClick={() => onBeginEdit("priority")} title="Edit priority">
                {card.priority !== undefined ? <span class={`prio p${card.priority}`}>P{card.priority}</span> : <span class="ds-dim">no priority</span>}
              </Button>
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
    return <span class="stale-editor">board changed <Button onClick={onRefresh}>refresh</Button></span>;
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
    return <span class="stale-editor">board changed <Button onClick={onRefresh}>refresh</Button></span>;
  }
  return (
    <Select
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
    </Select>
  );
}

export interface CardMenuState { taskId: string; x: number; y: number; actions: ReturnType<typeof cardMenuActions> }

/** t-c0e711 — the board card's right-click menu. Mirrors the sidebar's MoreMenu (sidebar/App.tsx) exactly:
 *  a full-screen transparent backdrop closes on click-outside, a fixed-position panel styled with the same
 *  `.menu-backdrop`/`.more-menu`/`.more-item` design-system language, Escape/arrow-key handling via a
 *  document-level listener while open. Also dismisses on webview blur/visibility (editor click is outside
 *  the iframe and never hits the backdrop). */
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
    const dismissOnFocusLoss = () => onClose();
    const onVisibility = () => { if (document.hidden) onClose(); };
    document.addEventListener("keydown", h);
    window.addEventListener("blur", dismissOnFocusLoss);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("keydown", h);
      window.removeEventListener("blur", dismissOnFocusLoss);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [menu]); // onClose is an inline lambda at the call site — do not re-bind every render
  if (!menu || menu.actions.length === 0) return null;
  const left = Math.max(6, Math.min(menu.x, window.innerWidth - 186));
  const top = Math.min(menu.y, window.innerHeight - (menu.actions.length * 28 + 16));
  return (
    <div class="menu-backdrop" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div ref={ref} class="more-menu" role="menu" aria-label="Card actions" style={`left:${left}px;top:${Math.max(6, top)}px`} onClick={(e) => e.stopPropagation()}>
        {menu.actions.map((a) => (
          <Button key={a.id} class="more-item" role="menuitem" onClick={() => onRun(a.id, menu.taskId)}>
            <Icon name={a.icon} /><span>{a.label}</span>
          </Button>
        ))}
      </div>
    </div>
  );
}
