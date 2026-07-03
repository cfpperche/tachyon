import type { BoardChip, BoardSnapshot } from "./boardSnapshot.js";
import { compareTasksByPriorityRank } from "./nextTask.js";
import type { SddStatus, Task, TaskAttention, TaskEmptyReason, TaskPriority, TaskStatus } from "./types.js";
import type { ValidationExecutor, ValidationOutcome, ValidationStatus } from "../validations/types.js";
import type { ValidationSummary } from "../validations/ValidationStore.js";

/** spec 335 — the always-on board columns, in display order. Dropped is a toggle-reveal bucket, never a
 *  fifth always-on column (spec's open-questions resolution). */
export const BOARD_COLUMN_STATUSES = ["inbox", "triaged", "active", "done"] as const;
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
  assignee?: string;
  assigneeColorVar?: string;
  sddRef?: string;
  sddStatus?: SddStatus;
  sddMissing?: boolean;
  attachmentCount?: number;
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

export interface BoardModel {
  columns: BoardColumnVM[];
  dropped: { count: number; cards: BoardCardVM[] };
  /** declared agents + `human` — bounded by workspace config, always rendered inline. */
  chips: BoardChipVM[];
  /** ad-hoc assignee chips (dogfood round 1, #5) — NOT bounded (every string anyone ever typed into
   *  `assignee` gets one, forever), so the header renders these behind an overflow affordance instead of
   *  growing the inline row without limit. */
  chipOverflow: BoardChipVM[];
  spotlight?: BoardSpotlight;
  validations?: BoardValidationVM;
}

export interface BoardModelInput {
  snapshot: BoardSnapshot;
  /** the currently-selected agent chip, if any (webview-local UI state — not part of the snapshot). */
  selectedChip?: string;
}

const COLUMN_LABEL: Record<BoardColumnStatus, string> = {
  inbox: "Inbox",
  triaged: "Triaged",
  active: "Active",
  done: "Done",
};

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
    const sdd = view?.derived?.sdd;
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      ...(task.priority !== undefined ? { priority: task.priority, priorityAccent: PRIORITY_ACCENT[task.priority] } : {}),
      ...(task.kind ? { kind: task.kind, kindColorVar: colorTokenFor(task.kind) } : {}),
      ...(task.assignee ? { assignee: task.assignee, assigneeColorVar: colorTokenFor(task.assignee) } : {}),
      ...(sdd ? { sddRef: sdd.ref, ...(sdd.status ? { sddStatus: sdd.status } : {}), ...(sdd.missing ? { sddMissing: true } : {}) } : {}),
      ...(snapshot.attachmentCounts?.[task.id] ? { attachmentCount: snapshot.attachmentCounts[task.id] } : {}),
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
    const tasks = (byStatus.get(status) ?? []).slice().sort(compareTasksByPriorityRank);
    return { status, label: COLUMN_LABEL[status], count: tasks.length, cards: tasks.map(toCard) };
  });

  const droppedTasks = (byStatus.get("dropped") ?? []).slice().sort(compareTasksByPriorityRank);
  const dropped = { count: droppedTasks.length, cards: droppedTasks.map(toCard) };

  const allChips: BoardChipVM[] = snapshot.chips.map((chip) => ({
    agent: chip.agent,
    source: chip.source,
    hasWork: "task" in chip.next,
    ...("empty" in chip.next ? { emptyReason: chip.next.reason } : {}),
    colorVar: colorTokenFor(chip.agent),
  }));
  // dogfood round 1 (#5) — split the bounded set (declared agents + human) from the unbounded one (ad-hoc
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

  return { columns, dropped, chips, chipOverflow, ...(spotlight ? { spotlight } : {}), ...(validations ? { validations } : {}) };
}

/** dogfood round 2 (#5) — maintainer decision: the inline chip row + "+N more" overflow toggle (round 1, #5)
 *  is replaced entirely by ONE dropdown holding every filter option. `chips`/`chipOverflow` stay the model's
 *  bounded/unbounded split (still useful — e.g. for anything that wants only the declared set); this just
 *  flattens both into the single ordered list the dropdown renders: declared/human first in their existing
 *  order, then ad-hoc assignees alpha-sorted so a long unbounded tail stays scannable in a single select. */
export function agentFilterOptions(model: Pick<BoardModel, "chips" | "chipOverflow">): BoardChipVM[] {
  return [...model.chips, ...model.chipOverflow.slice().sort((a, b) => a.agent.localeCompare(b.agent))];
}

/** A card dims when a chip is selected and the task is neither owned by, nor claimable by, that agent — the
 *  same coarse eligibility next_task uses for its candidate pool (assignedToCaller || unassignedTriaged),
 *  simplified for a visual affordance (drop legality itself always stays store-owned). */
function isDimmed(task: Task, selectedChip: string | undefined): boolean {
  if (!selectedChip) return false;
  if (task.assignee === selectedChip) return false;
  if (!task.assignee && task.status === "triaged") return false;
  return true;
}

function compareValidationCards(a: ValidationSummary, b: ValidationSummary): number {
  const pa = a.priority ?? 3;
  const pb = b.priority ?? 3;
  if (pa !== pb) return pa - pb;
  const age = a.createdAt.localeCompare(b.createdAt);
  return age !== 0 ? age : a.id.localeCompare(b.id);
}
