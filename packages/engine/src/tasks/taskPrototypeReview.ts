import type { TaskPrototypeReviewInputV1 } from "../runtime-api/taskDetailCommands.js";
import { TaskPrototypeStore } from "./TaskPrototypeStore.js";
import type { TaskStore } from "./TaskStore.js";

/**
 * One authoritative prototype-review transaction shared by the legacy adapter and persistent daemon.
 * Approval/rejection semantics deliberately preserve the existing best-effort task reconciliation rules.
 */
export async function reviewTaskPrototype(
  workspaceRoot: string,
  taskStore: TaskStore,
  input: TaskPrototypeReviewInputV1,
): Promise<void> {
  const store = new TaskPrototypeStore(workspaceRoot, input.taskId);
  if (input.action === "note") {
    store.addReview(input.prototypeId, {
      expectUpdatedAt: input.expectUpdatedAt,
      text: input.review!,
    });
    return;
  }

  const taskBefore = taskStore.get(input.taskId);
  if (input.action === "approve") {
    let snapshot = store.approve(input.prototypeId, {
      expectUpdatedAt: input.expectUpdatedAt,
      ...(input.review ? { review: input.review } : {}),
    });
    if (awaitingThisPrototype(taskBefore, input.prototypeId)) {
      try {
        await taskStore.update(input.taskId, { awaitingHuman: null, expect: { updatedAt: taskBefore.updatedAt } });
      } catch {
        snapshot = store.markNeedsTaskReconciliation(input.prototypeId, snapshot.updatedAt!, true);
      }
    }
    return;
  }

  store.reject(input.prototypeId, {
    expectUpdatedAt: input.expectUpdatedAt,
    ...(input.review ? { review: input.review } : {}),
  });
  if (awaitingThisPrototype(taskBefore, input.prototypeId)) {
    try {
      await taskStore.update(input.taskId, { awaitingHuman: null, expect: { updatedAt: taskBefore.updatedAt } });
    } catch {
      // Rejection is authoritative; stale advisory remains visibly awaiting instead of being guessed away.
    }
  }
}

function awaitingThisPrototype(task: ReturnType<TaskStore["get"]>, prototypeId: string): boolean {
  return task.awaitingHuman?.subject?.type === "task-prototype"
    && task.awaitingHuman.subject.prototypeId === prototypeId;
}
