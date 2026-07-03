import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Badge, Button, Chip, Icon, Input, Textarea } from "../shared/ui";
import { buildBoardModel, type BoardCardVM, type BoardColumnVM } from "../../tasks/boardModel";
import type { BoardSnapshot } from "../../tasks/boardSnapshot";
import type { MissionControlVM } from "./messages";
import { assigneePatch, priorityPatch, resolveDrop, isStaleError, type DragSession } from "./interactions";
import type { Task, TaskPriority, TaskStatus, TaskUpdateExpect, TaskUpdateInput } from "../../tasks/types";

// spec 335 — Mission Control board. The webview NEVER computes affordances/ordering itself: every column, card
// order, drag legality, and spotlight comes straight out of `boardModel.ts` (pure, shared with tests), fed by
// the snapshot the host pushes. No optimistic mutation: a card's position/fields only ever change when a fresh
// snapshot arrives, so "snap back" on a rejected drop is just... nothing moved in the first place.

export interface MissionControlDispatch {
  updateTask(id: string, patch: TaskUpdateInput): void;
  createTask(input: { title: string; kind?: string; body?: string }): void;
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

let toastSeq = 0;
interface Toast { id: number; message: string }

export function App({ vm, lastError, dispatch }: { vm?: MissionControlVM; lastError?: TaskErrorEvent; dispatch: MissionControlDispatch }) {
  const [selectedChip, setSelectedChip] = useState<string | undefined>(undefined);
  const [showAdHocChips, setShowAdHocChips] = useState(false);
  const [showDropped, setShowDropped] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [liveSnapshot, setLiveSnapshot] = useState<BoardSnapshot | undefined>(undefined);
  const [editSessions, setEditSessions] = useState<Record<string, EditSession>>({});
  const drag = useRef<DragSession | null>(null);
  const [dragAllowed, setDragAllowed] = useState<TaskStatus[] | null>(null);
  const queuedSnapshot = useRef<BoardSnapshot | null>(null);
  const pendingSubmit = useRef<string | null>(null);
  const lastErrorSeq = useRef<number>(-1);

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

  const model = useMemo(() => (liveSnapshot ? buildBoardModel({ snapshot: liveSnapshot, selectedChip }) : undefined), [liveSnapshot, selectedChip]);

  if (!vm || !model || !liveSnapshot) {
    return <div class="ds-degrade"><span class="codicon codicon-loading" /><div>Loading Mission Control…</div></div>;
  }

  const findTask = (id: string): Task | undefined => liveSnapshot.views.find((v) => v.task.id === id)?.task;

  const onDragStart = (card: BoardCardVM, e: DragEvent) => {
    drag.current = { taskId: card.id, fromStatus: card.status, startUpdatedAt: card.updatedAt };
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
  const submitEdit = (taskId: string) => {
    const session = editSessions[taskId];
    if (!session || session.stale) return;
    const expect: TaskUpdateExpect = { updatedAt: session.startUpdatedAt };
    const patch = session.field === "priority"
      ? priorityPatch(session.value === "" ? null : (Number(session.value) as TaskPriority), expect)
      : assigneePatch(session.value.trim() || null, expect);
    pendingSubmit.current = taskId;
    setEditSessions((s) => ({ ...s, [taskId]: { ...s[taskId], pending: true } }));
    dispatch.updateTask(taskId, patch);
  };

  const submitCreate = (title: string, kind: string, body: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    dispatch.createTask({ title: trimmed, ...(kind.trim() ? { kind: kind.trim() } : {}), ...(body.trim() ? { body: body.trim() } : {}) });
    setShowCreate(false);
  };

  // dogfood round 1 (#5) — an ad-hoc assignee chip is unbounded (every string ever typed into `assignee`
  // stays a permanent chip), so it renders collapsed behind a "+N" toggle instead of growing the header row
  // without limit; force it open if the currently-selected filter lives in the overflow set, so the active
  // chip is never hidden from view.
  const overflowActive = model.chipOverflow.some((c) => c.agent === selectedChip);
  const overflowOpen = showAdHocChips || overflowActive;
  const renderChip = (chip: (typeof model.chips)[number]) => (
    <Chip
      key={chip.agent}
      active={selectedChip === chip.agent}
      onClick={() => setSelectedChip((cur) => (cur === chip.agent ? undefined : chip.agent))}
      title={chip.hasWork ? `next_task(${chip.agent}) has work` : `next_task(${chip.agent}): ${chip.emptyReason ?? "no-tasks"}`}
    >
      <span class="dot" style={{ background: `var(${chip.colorVar})` }} />
      {chip.agent}
      {!chip.hasWork && <span class="st">· idle</span>}
    </Chip>
  );

  return (
    <div class="mc-root">
      <div class="mc-head">
        <h1 class="ds-title"><span aria-hidden="true">◆</span> Mission Control <span class="ws">— {vm.folder}</span></h1>
        <div class="agents" role="group" aria-label="Filter by agent">
          {model.chips.map(renderChip)}
          {model.chipOverflow.length > 0 && (
            <div class="agents-overflow">
              <Chip active={overflowOpen} onClick={() => setShowAdHocChips((v) => !v)} title="Other assignees found on tasks — not a declared agent">
                +{model.chipOverflow.length} more
              </Chip>
              {overflowOpen && (
                <div class="agents-overflow-panel" role="menu">
                  {model.chipOverflow.map(renderChip)}
                </div>
              )}
            </div>
          )}
        </div>
        <div class="spacer" />
        <Button icon="add" onClick={() => setShowCreate((v) => !v)}>+ task</Button>
        <Button icon={showDropped ? "eye-closed" : "eye"} onClick={() => setShowDropped((v) => !v)}>
          Dropped · {model.dropped.count}
        </Button>
      </div>

      {showCreate && <CreateForm onCancel={() => setShowCreate(false)} onSubmit={submitCreate} />}

      {model.spotlight?.emptyReason && (
        <div class="mc-spotlight-banner">
          <Icon name="info" /> next_task({model.spotlight.agent}): {model.spotlight.emptyReason}
        </div>
      )}

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
            onOpen={dispatch.openTask}
            onBeginEdit={beginEdit}
            onChangeEdit={changeEdit}
            onSubmitEdit={submitEdit}
            onCancelEdit={cancelEdit}
            onRefreshStale={refreshStale}
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
            onOpen={dispatch.openTask}
            onBeginEdit={beginEdit}
            onChangeEdit={changeEdit}
            onSubmitEdit={submitEdit}
            onCancelEdit={cancelEdit}
            onRefreshStale={refreshStale}
          />
        )}
      </div>

      <div class="toasts" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} class="toast"><Icon name="error" /> {t.message}</div>)}
      </div>
    </div>
  );
}

function CreateForm({ onCancel, onSubmit }: { onCancel(): void; onSubmit(title: string, kind: string, body: string): void }) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("");
  const [body, setBody] = useState("");
  return (
    <div class="mc-create">
      <Input placeholder="Task title" value={title} onInput={(e) => setTitle((e.currentTarget as HTMLInputElement).value)} autoFocus />
      <Input placeholder="kind (optional)" value={kind} onInput={(e) => setKind((e.currentTarget as HTMLInputElement).value)} class="mc-create-kind" />
      <Textarea placeholder="body (optional)" rows={2} value={body} onInput={(e) => setBody((e.currentTarget as HTMLTextAreaElement).value)} />
      <div class="mc-create-actions">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" disabled={!title.trim()} onClick={() => onSubmit(title, kind, body)}>Create</Button>
      </div>
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
  onOpen(id: string): void;
  onBeginEdit(card: BoardCardVM, field: EditSession["field"]): void;
  onChangeEdit(taskId: string, value: string): void;
  onSubmitEdit(taskId: string): void;
  onCancelEdit(taskId: string): void;
  onRefreshStale(card: BoardCardVM): void;
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
            onOpen={() => p.onOpen(card.id)}
            onBeginEdit={(field) => p.onBeginEdit(card, field)}
            onChangeEdit={(v) => p.onChangeEdit(card.id, v)}
            onSubmitEdit={() => p.onSubmitEdit(card.id)}
            onCancelEdit={() => p.onCancelEdit(card.id)}
            onRefreshStale={() => p.onRefreshStale(card)}
          />
        ))}
      </div>
    </div>
  );
}

function Card({ card, session, onDragStart, onDragEnd, onOpen, onBeginEdit, onChangeEdit, onSubmitEdit, onCancelEdit, onRefreshStale }: {
  card: BoardCardVM;
  session?: EditSession;
  onDragStart(e: DragEvent): void;
  onDragEnd(): void;
  onOpen(): void;
  onBeginEdit(field: EditSession["field"]): void;
  onChangeEdit(value: string): void;
  onSubmitEdit(): void;
  onCancelEdit(): void;
  onRefreshStale(): void;
}) {
  const cls = ["card", card.isSpotlight && "next", card.isDimmed && "dimmed"].filter(Boolean).join(" ");
  return (
    <div class={cls} draggable tabIndex={0} onDragStart={onDragStart} onDragEnd={onDragEnd} onClick={(e) => { if (!(e.target as HTMLElement).closest(".mc-editable")) onOpen(); }}>
      {card.isSpotlight && <span class="next-tag">▶ next_task</span>}
      <div class="top">
        {card.priority !== undefined && <span class={`prio p${card.priority}`}>P{card.priority}</span>}
        {card.kind && <span class="kind" style={{ color: `var(${card.kindColorVar})`, borderColor: `var(${card.kindColorVar})` }}>{card.kind}</span>}
      </div>
      <p class="title">{card.title}</p>
      <div class="meta">
        <span class="ref">{card.id}</span>
        {card.sddStatus && <Badge tone="info">sdd · {card.sddStatus}</Badge>}
        {card.sddMissing && <Badge tone="err">sdd missing</Badge>}
        {card.attention.map((a) => (
          <span key={a.code} class="attn" title={a.message}><Icon name="warning" /></span>
        ))}
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
            <button type="button" class="edit-prio-btn" onClick={() => onBeginEdit("priority")} title="Edit priority">✎ priority</button>
          )}
        </span>
      </div>
    </div>
  );
}

function AssigneeEditor({ session, onChange, onSubmit, onCancel, onRefresh }: { session: EditSession; onChange(v: string): void; onSubmit(): void; onCancel(): void; onRefresh(): void }) {
  if (session.stale) {
    return <span class="stale-editor">board changed <button type="button" onClick={onRefresh}>refresh</button></span>;
  }
  return (
    <Input
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

function PriorityEditor({ session, onChange, onSubmit, onCancel, onRefresh }: { session: EditSession; onChange(v: string): void; onSubmit(): void; onCancel(): void; onRefresh(): void }) {
  if (session.stale) {
    return <span class="stale-editor">board changed <button type="button" onClick={onRefresh}>refresh</button></span>;
  }
  return (
    <select
      autoFocus
      value={session.value}
      disabled={session.pending}
      onChange={(e) => { onChange((e.currentTarget as HTMLSelectElement).value); onSubmit(); }}
      onBlur={onCancel}
    >
      <option value="">none</option>
      {PRIORITIES.map((p) => <option key={p} value={p}>P{p}</option>)}
    </select>
  );
}
