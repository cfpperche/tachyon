import type { NextTaskResult, Task, TaskAttention, TaskDerived } from "./types.js";

export interface NextTaskInput {
  tasks: Task[];
  agent: string;
  derived?: Record<string, TaskDerived | undefined>;
}

type Candidate = {
  task: Task;
  derived?: TaskDerived;
  attention: TaskAttention[];
  tier: 0 | 1;
};

const ACTIONABLE_SDD = new Set(["draft", "in-progress", "shipped-partial"]);
const RETRIAGE_SDD = new Set(["superseded", "abandoned", "deferred"]);

export function nextTask(input: NextTaskInput): NextTaskResult {
  const byId = new Map(input.tasks.map((task) => [task.id, task]));
  let sawPotential = false;
  let sawBlocked = false;
  let sawAssignedElsewhere = false;
  const candidates: Candidate[] = [];

  for (const task of input.tasks) {
    const derived = input.derived?.[task.id];
    if (task.status === "inbox" || task.status === "landed" || task.status === "done" || task.status === "dropped") continue;

    const assignedToCaller = task.assignee === input.agent;
    const unassignedTriaged = !task.assignee && task.status === "triaged";
    const assignedElsewhere = !!task.assignee && !assignedToCaller;
    if (!assignedToCaller && !unassignedTriaged) {
      if (assignedElsewhere) sawAssignedElsewhere = true;
      continue;
    }
    sawPotential = true;

    const depState = dependencyState(task, byId);
    if (depState.blocked) {
      sawBlocked = true;
      continue;
    }

    const sdd = derived?.sdd;
    const attention = [...depState.attention];
    if (sdd?.missing) {
      attention.push({ code: "missing_sdd_spec", message: `SDD artifact '${sdd.ref}' was not found`, ref: sdd.ref });
    }
    if (task.status === "active" && sdd?.status === "shipped") {
      // The execution artifact is done; the task itself still needs an explicit close.
      continue;
    }
    if (task.status === "active" && sdd?.status && RETRIAGE_SDD.has(sdd.status)) {
      continue;
    }
    if (task.status === "active" && sdd?.status && !ACTIONABLE_SDD.has(sdd.status) && sdd.status !== "shipped") {
      continue;
    }

    candidates.push({ task, derived, attention, tier: assignedToCaller ? 0 : 1 });
  }

  if (candidates.length === 0) {
    if (!sawPotential && sawAssignedElsewhere) return { empty: true, reason: "all-assigned-elsewhere" };
    if (sawBlocked) return { empty: true, reason: "all-blocked" };
    return { empty: true, reason: "no-tasks" };
  }

  candidates.sort(compareCandidates);
  const winner = candidates[0]!;
  return {
    task: winner.task,
    ...(winner.derived ? { derived: winner.derived } : {}),
    ...(winner.attention.length ? { attention: winner.attention } : {}),
  };
}

function dependencyState(task: Task, byId: Map<string, Task>): { blocked: boolean; attention: TaskAttention[] } {
  const attention: TaskAttention[] = [];
  for (const dep of task.deps ?? []) {
    const dependency = byId.get(dep);
    if (!dependency) {
      attention.push({ code: "dangling_dep", message: `dependency '${dep}' does not exist`, ref: dep });
      continue;
    }
    if (dependency.status !== "done" && dependency.status !== "dropped") return { blocked: true, attention };
  }
  return { blocked: false, attention };
}

function compareCandidates(a: Candidate, b: Candidate): number {
  return a.tier - b.tier || compareTasksByPriorityRank(a.task, b.task);
}

// spec 335 — the priority → rank → createdAt → id ordering, exported so the Mission Control board's card
// ordering uses the SAME comparator next_task ranks candidates with (no re-encoding in boardModel.ts).
export function compareTasksByPriorityRank(a: Task, b: Task): number {
  return (
    prioritySort(a) - prioritySort(b) ||
    rankSort(a, b) ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

function prioritySort(task: Task): number {
  return task.priority ?? Number.POSITIVE_INFINITY;
}

function rankSort(a: Task, b: Task): number {
  const ar = a.rank;
  const br = b.rank;
  if (ar && br) return ar < br ? -1 : ar > br ? 1 : 0;
  if (ar) return -1;
  if (br) return 1;
  return 0;
}
