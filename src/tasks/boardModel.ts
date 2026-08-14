import type { BoardChip, BoardSnapshot } from "@tachyon/engine/tasks/boardSnapshot.js";
import { compareTasksByPriorityRank } from "@tachyon/shared/tasks/nextTask.js";
import type { Task, TaskAttention, TaskAwaitingHumanKind, TaskEmptyReason, TaskPriority, TaskStatus } from "@tachyon/shared/tasks/types.js";
import type { ValidationExecutor, ValidationOutcome, ValidationStatus } from "@tachyon/engine/validations/types.js";
import type { ValidationSummary } from "@tachyon/engine/validations/ValidationStore.js";

/** spec 335/360 — the always-on board columns, in display order. Dropped is a toggle-reveal bucket, never an
 *  always-on column. */
export const BOARD_COLUMN_STATUSES = ["inbox", "triaged", "active", "landed", "done"] as const;
export type BoardColumnStatus = (typeof BOARD_COLUMN_STATUSES)[number];

export const PRIORITY_ACCENT: Record<TaskPriority, "err" | "warn" | "info" | "neutral"> = {
  0: "err",
  1: "warn",
  2: "info",
  3: "neutral",
};

/** spec 335 (dueto F11) — declared agents and unknown assignee/kind strings both resolve through this SAME
 *  deterministic hash (Tachyon has no existing per-agent identity-color system to mirror — see notes.md); only
 *  `human` gets a reserved, non-hashed token so it always reads the same regardless of what else is on screen.
 *  All entries are theme-aware `--vscode-charts-*` custom properties (already the design system's basis for
 *  semantic color), so contrast follows the user's active theme rather than a fixed hex swatch. */
export const HUMAN_COLOR_VAR = "--vscode-charts-foreground";
const CATEGORICAL_PALETTE = [
  "--vscode-charts-blue",
  "--vscode-charts-orange",
  "--vscode-charts-purple",
  "--vscode-charts-green",
  "--vscode-charts-red",
  "--vscode-charts-yellow",
] as const;

/** FNV-1a — cheap, deterministic, stable across sessions/platforms (no Math.random, no session state). */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic color token for an arbitrary name (assignee or kind). `human` is reserved; everything else
 *  hashes into the categorical palette — never blank, never session-random. */
export function colorTokenFor(name: string): string {
  if (name === "human") return HUMAN_COLOR_VAR;
  return CATEGORICAL_PALETTE[hashString(name) % CATEGORICAL_PALETTE.length];
}

export interface BoardCardVM {
  id: string;
  title: string;
  status: TaskStatus;
  priority?: TaskPriority;
  priorityAccent?: "err" | "warn" | "info" | "neutral";
  kind?: string;
  kindColorVar?: string;
  /** t-8aeaac — who created the task (agent name or "human"); the card always shows it. */
  author: string;
  authorColorVar: string;
  assignee?: string;
  assigneeLabel: string;
  assigneeColorVar?: string;
  assigneeHistorical: boolean;
  canEditAssignee: boolean;
  attachmentCount?: number;
  journalCount?: number;
  attention: TaskAttention[];
  createdAt: string;
  updatedAt: string;
  isSpotlight: boolean;
  isDimmed: boolean;
}

export interface BoardColumnVM {
  status: BoardColumnStatus;
  label: string;
  count: number;
  cards: BoardCardVM[];
}

export interface BoardChipVM {
  agent: string;
  source: BoardChip["source"];
  hasWork: boolean;
  emptyReason?: TaskEmptyReason;
  colorVar: string;
}

export interface BoardSpotlight {
  agent: string;
  taskId?: string;
  emptyReason?: TaskEmptyReason;
}

export interface BoardValidationCardVM {
  id: string;
  title: string;
  type?: string;
  status: ValidationStatus;
  executor: ValidationExecutor;
  priority?: TaskPriority;
  assignee?: string;
  outcome?: ValidationOutcome;
  updatedAt: string;
}

export interface BoardValidationVM {
  pendingCount: number;
  humanPendingCount: number;
  agentPendingCount: number;
  candidateCount: number;
  cards: BoardValidationCardVM[];
  candidateTitles: string[];
}

/** t-1339a8 — one authored "blocked on the human" entry for the Board "Awaiting you" strip. A
 *  DIFFERENT signal from Validations (BoardValidationCardVM): this comes straight from `task.awaitingHuman`,
 *  never derived/discovered. */
export interface BoardAwaitingHumanCardVM {
  id: string;
  title: string;
  reason: string;
  kind: TaskAwaitingHumanKind;
  since: string;
}

export interface BoardAwaitingHumanVM {
  count: number;
  items: BoardAwaitingHumanCardVM[];
}

export interface BoardModel {
  columns: BoardColumnVM[];
  dropped: { count: number; cards: BoardCardVM[] };
  /** declared agents + `human` — bounded by workspace config, always rendered inline. */
  chips: BoardChipVM[];
  /** Temporary assignee chips (dogfood round 1, #5) — NOT bounded (every string anyone ever typed into
   *  `assignee` gets one, forever), so the header renders these behind an overflow affordance instead of
   *  growing the inline row without limit. */
  chipOverflow: BoardChipVM[];
  spotlight?: BoardSpotlight;
  validations?: BoardValidationVM;
  /** t-1339a8 — the "Awaiting you" strip's data, COEXISTING with `validations` (a different workflow):
   *  every task with `task.awaitingHuman` set, oldest-flagged first, regardless of which column/search
   *  filter currently hides its card. */
  awaitingHuman?: BoardAwaitingHumanVM;
}

export interface BoardModelInput {
  snapshot: BoardSnapshot;
  /** the currently-selected agent chip, if any (webview-local UI state — not part of the snapshot). */
  selectedChip?: string;
  /** t-5ea4c7 — the toolbar's free-text search (webview-local UI state). Case-insensitive substring match
   *  across title/id/kind/assignee/body; a non-matching card is HIDDEN (not just dimmed) — distinct from the
   *  agent chip (dims) and from Ctrl+F find (never hides anything — see t-b5e6e5 in notes.md). */
  searchQuery?: string;
}

/** t-5ea4c7 — exported so the filter predicate is independently testable. Empty/whitespace query matches
 *  everything (no-op filter). */
export function matchesBoardSearch(task: Task, query: string | undefined): boolean {
  const q = query?.trim().toLowerCase();
  if (!q) return true;
  return [task.title, task.id, task.kind, task.assignee, task.body].some((field) => !!field && field.toLowerCase().includes(q));
}

const COLUMN_LABEL: Record<BoardColumnStatus, string> = {
  inbox: "Inbox",
  triaged: "Triaged",
  active: "Active",
  landed: "Landed",
  done: "Done",
};

const HISTORICAL_ASSIGNEE_STATUSES = new Set<TaskStatus>(["landed", "done", "dropped"]);
const ASSIGNEE_EDITABLE_STATUSES = new Set<TaskStatus>(["triaged", "active"]);

/** Pure, DOM-free: a board snapshot + the locally-selected chip → the full render model (columns, cards,
 *  spotlight, dim set, deterministic colors). Mirrors the sidebar's agentModel/actions discipline — no vscode,
 *  no disk reads, no store calls; every card/chip already carries everything the snapshot precomputed. */
export function buildBoardModel(input: BoardModelInput): BoardModel {
  const { snapshot, selectedChip } = input;
  const selectedResult = selectedChip ? snapshot.chips.find((c) => c.agent === selectedChip) : undefined;
  const spotlightTaskId = selectedResult && "task" in selectedResult.next ? selectedResult.next.task.id : undefined;
  const spotlight: BoardSpotlight | undefined = selectedChip
    ? {
        agent: selectedChip,
        ...(spotlightTaskId ? { taskId: spotlightTaskId } : {}),
        ...(selectedResult && "empty" in selectedResult.next ? { emptyReason: selectedResult.next.reason } : {}),
      }
    : undefined;

  const toCard = (task: Task): BoardCardVM => {
    const view = snapshot.views.find((v) => v.task.id === task.id);
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      ...(task.priority !== undefined ? { priority: task.priority, priorityAccent: PRIORITY_ACCENT[task.priority] } : {}),
      ...(task.kind ? { kind: task.kind, kindColorVar: colorTokenFor(task.kind) } : {}),
      author: task.author,
      authorColorVar: colorTokenFor(task.author),
      ...(task.assignee ? { assignee: task.assignee, assigneeColorVar: colorTokenFor(task.assignee) } : {}),
      assigneeLabel: assigneeLabel(task),
      assigneeHistorical: HISTORICAL_ASSIGNEE_STATUSES.has(task.status) && !!task.lastDeliverer,
      canEditAssignee: ASSIGNEE_EDITABLE_STATUSES.has(task.status),
      ...(snapshot.attachmentCounts?.[task.id] ? { attachmentCount: snapshot.attachmentCounts[task.id] } : {}),
      ...(view?.journalCount ? { journalCount: view.journalCount } : {}),
      attention: view?.attention ?? [],
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      isSpotlight: task.id === spotlightTaskId,
      isDimmed: isDimmed(task, selectedChip),
    };
  };

  const byStatus = new Map<TaskStatus, Task[]>();
  for (const view of snapshot.views) {
    const bucket = byStatus.get(view.task.status);
    if (bucket) bucket.push(view.task);
    else byStatus.set(view.task.status, [view.task]);
  }

  const columns: BoardColumnVM[] = BOARD_COLUMN_STATUSES.map((status) => {
    const tasks = (byStatus.get(status) ?? []).filter((t) => matchesBoardSearch(t, input.searchQuery)).sort(compareTasksByPriorityRank);
    return { status, label: COLUMN_LABEL[status], count: tasks.length, cards: tasks.map(toCard) };
  });

  const droppedTasks = (byStatus.get("dropped") ?? []).filter((t) => matchesBoardSearch(t, input.searchQuery)).sort(compareTasksByPriorityRank);
  const dropped = { count: droppedTasks.length, cards: droppedTasks.map(toCard) };

  const allChips: BoardChipVM[] = snapshot.chips.map((chip) => ({
    agent: chip.agent,
    source: chip.source,
    hasWork: "task" in chip.next,
    ...("empty" in chip.next ? { emptyReason: chip.next.reason } : {}),
    colorVar: colorTokenFor(chip.agent),
  }));
  // dogfood round 1 (#5) — split the bounded set (declared agents + human) from the unbounded one (Temporary
  // assignees) so the webview can render the latter behind an overflow affordance.
  const chips = allChips.filter((c) => c.source !== "assignee");
  const chipOverflow = allChips.filter((c) => c.source === "assignee");

  const validations = snapshot.validations
    ? {
        pendingCount: snapshot.validations.pendingCount,
        humanPendingCount: snapshot.validations.humanPendingCount,
        agentPendingCount: snapshot.validations.agentPendingCount,
        candidateCount: snapshot.validations.candidateCount,
        cards: snapshot.validations.items
          .filter((v) => v.status !== "closed")
          .slice()
          .sort((a, b) => compareValidationCards(a, b))
          .slice(0, 6)
          .map((v) => ({
            id: v.id,
            title: v.title,
            ...(v.type ? { type: v.type } : {}),
            status: v.status,
            executor: v.executor,
            ...(v.priority !== undefined ? { priority: v.priority } : {}),
            ...(v.assignee ? { assignee: v.assignee } : {}),
            ...(v.currentRound?.outcome ? { outcome: v.currentRound.outcome } : {}),
            updatedAt: v.updatedAt,
          })),
        candidateTitles: snapshot.validations.candidates.slice(0, 3).map((c) => c.title),
      }
    : undefined;

  // t-1339a8 — read straight off `snapshot.views` (not the column buckets above), so a flagged task still
  // shows in the strip even while hidden by the toolbar search or tucked in the collapsed Dropped bucket.
  const awaitingHumanItems = snapshot.views
    .filter((v) => v.task.awaitingHuman)
    .map((v) => ({
      id: v.task.id,
      title: v.task.title,
      reason: v.task.awaitingHuman!.reason,
      kind: v.task.awaitingHuman!.kind,
      since: v.task.awaitingHuman!.since,
    }))
    .sort((a, b) => a.since.localeCompare(b.since) || a.id.localeCompare(b.id));
  const awaitingHuman = awaitingHumanItems.length ? { count: awaitingHumanItems.length, items: awaitingHumanItems } : undefined;

  return { columns, dropped, chips, chipOverflow, ...(spotlight ? { spotlight } : {}), ...(validations ? { validations } : {}), ...(awaitingHuman ? { awaitingHuman } : {}) };
}

/** dogfood round 2 (#5) — maintainer decision: the inline chip row + "+N more" overflow toggle (round 1, #5)
 *  is replaced entirely by ONE dropdown holding every filter option. `chips`/`chipOverflow` stay the model's
 *  bounded/unbounded split (still useful — e.g. for anything that wants only the declared set); this just
 *  flattens both into the single ordered list the dropdown renders: declared/human first in their existing
 *  order, then Temporary assignees alpha-sorted so a long unbounded tail stays scannable in a single select. */
export function agentFilterOptions(model: Pick<BoardModel, "chips" | "chipOverflow">): BoardChipVM[] {
  return [...model.chips, ...model.chipOverflow.slice().sort((a, b) => a.agent.localeCompare(b.agent))];
}

/** A card dims when a chip is selected and the task is neither owned by, nor claimable by, that agent — the
 *  same coarse eligibility next_task uses for its candidate pool (assignedToCaller || unassigned open),
 *  simplified for a visual affordance (drop legality itself always stays store-owned). */
function isDimmed(task: Task, selectedChip: string | undefined): boolean {
  if (!selectedChip) return false;
  if (HISTORICAL_ASSIGNEE_STATUSES.has(task.status)) return true;
  if (task.assignee === selectedChip) return false;
  if (!task.assignee && (task.status === "triaged" || task.status === "active")) return false;
  return true;
}

function assigneeLabel(task: Task): string {
  const agent = HISTORICAL_ASSIGNEE_STATUSES.has(task.status) ? task.lastDeliverer : task.currentAssignee;
  if (!agent) return "unassigned";
  return HISTORICAL_ASSIGNEE_STATUSES.has(task.status) ? `delivered by ${agent}` : agent;
}

function compareValidationCards(a: ValidationSummary, b: ValidationSummary): number {
  const pa = a.priority ?? 3;
  const pb = b.priority ?? 3;
  if (pa !== pb) return pa - pb;
  const age = a.createdAt.localeCompare(b.createdAt);
  return age !== 0 ? age : a.id.localeCompare(b.id);
}
