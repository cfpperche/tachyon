import { nextTask } from "./nextTask.js";
import { allowedTransitions, type TaskStore } from "./TaskStore.js";
import type { NextTaskResult, Task, TaskDerived, TaskStatus, TaskView } from "./types.js";
import { discoverValidationCandidates } from "../validations/discovery.js";
import { validationSummary, type ValidationSummary, type ValidationStore } from "../validations/ValidationStore.js";
import type { ValidationCandidate } from "../validations/types.js";
import { TaskDetailStore } from "./TaskDetailStore.js";

/** spec 335 — one chip in the Mission Control header: a declared agent, the `human` queue, or a relevant
 *  ad-hoc agent (live, or still owning open work). */
export type BoardChipSource = "declared" | "human" | "assignee";

export interface BoardChip {
  agent: string;
  source: BoardChipSource;
  next: NextTaskResult;
}

/** spec 335 — the board snapshot contract: one engine-side pass producing everything a Mission Control push
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
  /** ad-hoc agent names currently alive in the managed-entry ledger/sidebar. Declared agents are passed
   *  separately and remain listed even when stopped. */
  liveAdhocAgents?: Iterable<string>;
  /** bounded like `listViews` (default 500 — the store's own max clamp; see the scale-envelope criterion). */
  limit?: number;
  validationStore?: ValidationStore;
  workspaceRoot?: string;
}

/** Build the board snapshot in ONE pass: `listViews` derives SDD once per task; `nextTask()` (pure, already
 *  imported) is called once per chip against that SAME derived map — never `TaskStore.next()` per chip, which
 *  would re-list and re-derive from disk per call (dueto F4). */
export function buildBoardSnapshot(input: BoardSnapshotInput): BoardSnapshot {
  const views = input.store.listViews(input.limit ?? 500);
  const tasks: Task[] = views.map((v) => v.task);
  const derived: Record<string, TaskDerived> = {};
  for (const view of views) {
    if (view.derived) derived[view.task.id] = view.derived;
  }

  const allowedDropStatuses: Record<string, TaskStatus[]> = {};
  for (const task of tasks) {
    allowedDropStatuses[task.id] = allowedTransitions(task.status);
  }

  const chips = chipAgents(input.declaredAgents, tasks, input.liveAdhocAgents).map((entry) => ({
    agent: entry.agent,
    source: entry.source,
    next: nextTask({ tasks, agent: entry.agent, derived }),
  }));

  return { views, allowedDropStatuses, chips, ...validationSnapshot(input), ...attachmentCountsFor(input, tasks) };
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

/** Union of declared agents (declaration order), `human`, and only relevant ad-hocs: currently live, or with
 *  at least one open task. Done/dropped-only dead ad-hocs stay visible on cards but do not bloat the filter. */
function chipAgents(declaredAgents: string[], tasks: Task[], liveAdhocAgents: Iterable<string> | undefined): ChipAgent[] {
  const seen = new Set<string>();
  const out: ChipAgent[] = [];
  const add = (agent: string, source: BoardChipSource): void => {
    if (seen.has(agent)) return;
    seen.add(agent);
    out.push({ agent, source });
  };
  for (const agent of declaredAgents) add(agent, "declared");
  add("human", "human");
  const relevantAdhocs = new Set<string>(liveAdhocAgents ?? []);
  for (const task of tasks) {
    if (task.assignee && OPEN_TASK_STATUSES.has(task.status)) relevantAdhocs.add(task.assignee);
  }
  for (const assignee of [...relevantAdhocs].sort()) add(assignee, "assignee");
  return out;
}
