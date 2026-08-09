import { createHash, randomUUID } from "node:crypto";
import { asAgent, type ManagedEntryDef } from "../config/loadConfig.js";
import type { TaskMutationEvent } from "../tasks/TaskStore.js";
import type { Task } from "../tasks/types.js";
import type { EvolutionReview } from "./domain.js";
import type { EvolutionStore } from "./EvolutionStore.js";

export interface EvolutionNoticeResult {
  /** t-8d190f — `submit-unconfirmed`: typed into the composer, never observed to leave it. */
  status: "notified" | "queued" | "submit-unconfirmed";
}

export interface EvolutionCoordinatorDeps {
  store: EvolutionStore;
  declaredAgent: (name: string) => ManagedEntryDef | undefined;
  sessionFor: (name: string) => string;
  activitySeq: (name: string) => number | undefined;
  deliverNotice: (agent: string, line: string) => Promise<EvolutionNoticeResult>;
  onReviewChanged?: (review: EvolutionReview) => void;
  onError?: (message: string) => void;
  completionNonce?: () => string;
}

export function evolutionCompletionRevision(event: TaskMutationEvent, nonce: string = randomUUID()): string {
  return createHash("sha256")
    .update(JSON.stringify({
      taskId: event.after.id,
      completedUpdatedAt: event.after.updatedAt,
      nonce,
    }), "utf8")
    .digest("hex");
}

export function composeEvolutionReviewNotice(review: EvolutionReview): string {
  return `[tachyon] Evolution review ${review.id} for completed task ${review.taskId}: reflect on reusable `
    + "learnings from this work. Do not change Persistent Instructions. Call submit_evolution_review "
    + `with review_id '${review.id}' and zero or more independent learning/skill proposals; submit an empty `
    + "proposals list when nothing should be retained.";
}

/** Observes committed Task transitions; never participates in the Task mutation transaction. */
export class EvolutionCoordinator {
  constructor(private readonly deps: EvolutionCoordinatorDeps) {}

  async onAgentUnavailable(agent: string, reason: string): Promise<void> {
    try {
      const pending = (await this.deps.store.listReviews(agent))
        .filter((review) => review.status === "pending");
      for (const review of pending) {
        const failed = await this.deps.store.markReviewFailed(agent, review.id, reason);
        this.emitReviewChanged(failed);
      }
    } catch (error) {
      this.emitError(`Agent Evolution could not close pending reviews for '${agent}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  completionMarker(event: TaskMutationEvent, nonce: string = randomUUID()): Task["evolutionCompletion"] {
    if (event.before.status === "done" || event.after.status !== "done") return undefined;
    const agent = event.after.lastDeliverer;
    if (!agent) return undefined;
    const definition = asAgent(this.deps.declaredAgent(agent));
    if (definition?.selfEvolution?.enabled !== true) return undefined;
    return { agent, revision: evolutionCompletionRevision(event, this.deps.completionNonce?.() ?? nonce) };
  }

  async reconcileCompletedTasks(tasks: readonly Task[]): Promise<void> {
    for (const task of tasks) {
      const marker = task.evolutionCompletion;
      if (task.status !== "done" || !marker || task.lastDeliverer !== marker.agent) continue;
      await this.ensureReview(task, marker.revision);
    }
  }

  async onTaskMutation(event: TaskMutationEvent): Promise<void> {
    if (event.before.status === "done" || event.after.status !== "done") return;
    const marker = event.after.evolutionCompletion
      ?? this.completionMarker(event, `${event.before.updatedAt}->${event.after.updatedAt}`);
    if (!marker) return;
    await this.ensureReview(event.after, marker.revision);
  }

  private async ensureReview(task: Task, completionRevision: string): Promise<void> {
    const agent = task.lastDeliverer;
    if (!agent) return;
    const definition = asAgent(this.deps.declaredAgent(agent));
    if (definition?.selfEvolution?.enabled !== true) return;

    try {
      const created = await this.deps.store.createReview(agent, {
        taskId: task.id,
        taskTitle: task.title,
        completionRevision,
        session: this.deps.sessionFor(agent),
        activitySeq: this.deps.activitySeq(agent),
      });
      if (!created.created) return;
      this.emitReviewChanged(created.review);
      try {
        const delivery = await this.deps.deliverNotice(agent, composeEvolutionReviewNotice(created.review));
        // t-8d190f — an unconfirmed submit is not a delivery. Route it through the existing failure
        // path rather than persisting a third value into the stored review: the notice may be sitting
        // staged in the agent's composer, so recording it as delivered would lose the review.
        if (delivery.status === "submit-unconfirmed") {
          throw new Error("submission to the agent's composer was not confirmed (receipt: submit-unconfirmed)");
        }
        const review = await this.deps.store.markReviewDelivery(agent, created.review.id, delivery.status);
        this.emitReviewChanged(review);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const review = await this.deps.store.markReviewFailed(agent, created.review.id, detail);
        this.emitReviewChanged(review);
        this.emitError(`Agent Evolution review '${created.review.id}' could not be delivered: ${detail}`);
      }
    } catch (error) {
      this.emitError(`Agent Evolution could not create a review for task '${task.id}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private emitReviewChanged(review: EvolutionReview): void {
    try { this.deps.onReviewChanged?.(review); } catch { /* committed review state is authoritative */ }
  }

  private emitError(message: string): void {
    try { this.deps.onError?.(message); } catch { /* diagnostics cannot change review state */ }
  }
}
