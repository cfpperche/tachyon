import { nextTask } from "@tachyon/shared/tasks/nextTask.js";
import { allowedTransitions, type TaskStore } from "./TaskStore.js";
import { TASK_STATUSES, type NextTaskResult, type Task, type TaskDerived, type TaskStatus, type TaskView } from "@tachyon/shared/tasks/types.js";
import { discoverValidationCandidates } from "../validations/discovery.js";
import { validationSummary, type ValidationSummary, type ValidationStore } from "../validations/ValidationStore.js";
import type { ValidationCandidate } from "../validations/types.js";
import { TaskDetailStore } from "./TaskDetailStore.js";

/** spec 335 — one chip in the Board header: a declared agent, the `human` queue, or a relevant
 *  Temporary instance (live, or still owning open work). */
export type BoardChipSource = "declared" | "human" | "assignee";

export interface BoardChip {
  agent: string;
  source: BoardChipSource;
  next: NextTaskResult;
}

/** spec 335 — the board snapshot contract: one engine-side pass producing everything a Board push
 *  needs, so every card/chip/spotlight in one push reflects a single consistent filesystem view (dueto F4). */
export interface BoardSnapshot {
  views: TaskView[];
  allowedDropStatuses: Record<string, TaskStatus[]>;
  chips: BoardChip[];
  validations?: BoardValidationSnapshot;
  /** dogfood round 1 (#5, spec 339) — task id → attachment count, from each task's Task Studio sidecar
   *  (read-only; never touches TaskStore/entity 325). Sparse: only tasks with ≥1 attachment get an entry. */
  attachmentCounts?: Record<string, number>;
}

export interface BoardValidationSnapshot {
  items: ValidationSummary[];
  pendingCount: number;
  humanPendingCount: number;
  agentPendingCount: number;
  candidateCount: number;
  candidates: ValidationCandidate[];
}

export interface BoardSnapshotInput {
  store: TaskStore;
  /** declared agent names from the workspace's agent config, in declaration order. */
  declaredAgents: string[];
  /** Temporary instance names currently alive in the managed-entry ledger/sidebar. Declared agents are passed
   *  separately and remain listed even when stopped. */
  liveTemporaryAgents?: Iterable<string>;
  /** Board envelope (default 500 — the store's own max clamp; see the scale-envelope criterion). Shared
   *  fairly across every status so a mixed `listViews` slice cannot starve a column (t-236345). */
  limit?: number;
  validationStore?: ValidationStore;
  workspaceRoot?: string;
}

/** Build the board snapshot in ONE pass: `listViews` derives SDD once per task; `nextTask()` (pure, already
 *  imported) is called once per chip against that SAME derived map — never `TaskStore.next()` per chip, which
 *  would re-list and re-derive from disk per call (dueto F4). */
export function buildBoardSnapshot(input: BoardSnapshotInput): BoardSnapshot {
  const views = listBoardViews(input.store, input.limit ?? 500);
  const tasks: Task[] = views.map((v) => v.task);
  const derived: Record<string, TaskDerived> = {};
  for (const view of views) {
    if (view.derived) derived[view.task.id] = view.derived;
  }

  const allowedDropStatuses: Record<string, TaskStatus[]> = {};
  for (const task of tasks) {
    allowedDropStatuses[task.id] = allowedTransitions(task.status);
  }

  const chips = chipAgents(input.declaredAgents, tasks, input.liveTemporaryAgents).map((entry) => ({
    agent: entry.agent,
    source: entry.source,
    next: nextTask({ tasks, agent: entry.agent, derived }),
  }));

  return {
    views,
    allowedDropStatuses,
    chips,
    ...validationSnapshot(input),
    ...attachmentCountsFor(input, tasks),
  };
}

/**
 * t-236345 — the board is a kanban, not list_tasks. A single mixed `listViews(limit)` inherits
 * `compareTasksForListing` (dropped last) and silently cuts that column once done/landed/open fill
 * the 500 envelope. List each status, then share the same envelope round-robin so no nonempty
 * column is starved. `clampBoardViewLimit` mirrors `TaskStore`'s unpublished `clampLimit`.
 */
function listBoardViews(store: TaskStore, requestedLimit: number): TaskView[] {
  const limit = clampBoardViewLimit(requestedLimit);
  const counts = TASK_STATUSES.map((status) => store.count({ status }));
  const take = allocateBoardViewBudgets(counts, limit);
  return TASK_STATUSES.flatMap((status, i) => {
    const n = take[i] ?? 0;
    return n > 0 ? store.listViews(n, { status }) : [];
  });
}

function clampBoardViewLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) return 100;
  return Math.min(limit, 500);
}

function allocateBoardViewBudgets(counts: number[], limit: number): number[] {
  const take = counts.map(() => 0);
  let remaining = limit;
  let progressed = true;
  while (remaining > 0 && progressed) {
    progressed = false;
    for (let i = 0; i < counts.length; i++) {
      if (remaining === 0) break;
      const have = take[i] ?? 0;
      const want = counts[i] ?? 0;
      if (have < want) {
        take[i] = have + 1;
        remaining -= 1;
        progressed = true;
      }
    }
  }
  return take;
}

function attachmentCountsFor(input: BoardSnapshotInput, tasks: Task[]): Pick<BoardSnapshot, "attachmentCounts"> {
  if (!input.workspaceRoot) return {};
  const store = new TaskDetailStore(input.workspaceRoot);
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    const read = store.read(task.id);
    if (read.status === "ok" && read.detail.attachments.length > 0) counts[task.id] = read.detail.attachments.length;
  }
  return Object.keys(counts).length > 0 ? { attachmentCounts: counts } : {};
}

function validationSnapshot(input: BoardSnapshotInput): Pick<BoardSnapshot, "validations"> {
  if (!input.validationStore) return {};
  const items = input.validationStore.list(input.limit ?? 500).map(validationSummary);
  const open = items.filter((v) => v.status !== "closed");
  const candidates = input.workspaceRoot ? discoverValidationCandidates(input.workspaceRoot, 50) : [];
  return {
    validations: {
      items,
      pendingCount: open.length,
      humanPendingCount: open.filter((v) => v.executor === "human").length,
      agentPendingCount: open.filter((v) => v.executor !== "human").length,
      candidateCount: candidates.length,
      candidates,
    },
  };
}

interface ChipAgent {
  agent: string;
  source: BoardChipSource;
}

const OPEN_TASK_STATUSES = new Set<TaskStatus>(["inbox", "triaged", "active"]);

/** Union of declared agents (declaration order), `human`, and only relevant Temporary instances: currently live, or with
 *  at least one open task. Done/dropped-only dead Temporary instances stay visible on cards but do not bloat the filter. */
function chipAgents(declaredAgents: string[], tasks: Task[], liveTemporaryAgents: Iterable<string> | undefined): ChipAgent[] {
  const seen = new Set<string>();
  const out: ChipAgent[] = [];
  const add = (agent: string, source: BoardChipSource): void => {
    if (seen.has(agent)) return;
    seen.add(agent);
    out.push({ agent, source });
  };
  for (const agent of declaredAgents) add(agent, "declared");
  add("human", "human");
  const relevantTemporaries = new Set<string>(liveTemporaryAgents ?? []);
  for (const task of tasks) {
    if (task.assignee && OPEN_TASK_STATUSES.has(task.status)) relevantTemporaries.add(task.assignee);
  }
  for (const assignee of [...relevantTemporaries].sort()) add(assignee, "assignee");
  return out;
}
