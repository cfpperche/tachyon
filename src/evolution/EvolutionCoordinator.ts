import { createHash } from "node:crypto";
import type { ManagedEntryDef } from "../config/loadConfig.js";
import type { TaskMutationEvent } from "../tasks/TaskStore.js";
import type { EvolutionReview } from "./domain.js";
import type { EvolutionStore } from "./EvolutionStore.js";

export interface EvolutionNoticeResult {
  status: "notified" | "queued";
}

export interface EvolutionCoordinatorDeps {
  store: EvolutionStore;
  declaredAgent: (name: string) => ManagedEntryDef | undefined;
  sessionFor: (name: string) => string;
  activitySeq: (name: string) => number | undefined;
  deliverNotice: (agent: string, line: string) => Promise<EvolutionNoticeResult>;
  onReviewChanged?: (review: EvolutionReview) => void;
  onError?: (message: string) => void;
}

export function evolutionCompletionRevision(event: TaskMutationEvent): string {
  return createHash("sha256")
    .update(JSON.stringify({
      taskId: event.after.id,
      beforeStatus: event.before.status,
      beforeUpdatedAt: event.before.updatedAt,
      completedUpdatedAt: event.after.updatedAt,
    }), "utf8")
    .digest("hex");
}

export function composeEvolutionReviewNotice(review: EvolutionReview): string {
  return `[tachyon] Evolution review ${review.id} for completed task ${review.taskId}: reflect on reusable `
    + "learnings from this work. Do not change Soul or Persistent Instructions. Call submit_evolution_review "
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

  async onTaskMutation(event: TaskMutationEvent): Promise<void> {
    if (event.before.status === "done" || event.after.status !== "done") return;
    const agent = event.after.assignee;
    if (!agent) return;
    const definition = this.deps.declaredAgent(agent);
    if (!definition || definition.kind !== "agent" || definition.selfEvolution?.enabled !== true) return;

    try {
      const created = await this.deps.store.createReview(agent, {
        taskId: event.after.id,
        taskTitle: event.after.title,
        completionRevision: evolutionCompletionRevision(event),
        session: this.deps.sessionFor(agent),
        activitySeq: this.deps.activitySeq(agent),
      });
      if (!created.created) return;
      this.emitReviewChanged(created.review);
      try {
        const delivery = await this.deps.deliverNotice(agent, composeEvolutionReviewNotice(created.review));
        const review = await this.deps.store.markReviewDelivery(agent, created.review.id, delivery.status);
        this.emitReviewChanged(review);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const review = await this.deps.store.markReviewFailed(agent, created.review.id, detail);
        this.emitReviewChanged(review);
        this.emitError(`Agent Evolution review '${created.review.id}' could not be delivered: ${detail}`);
      }
    } catch (error) {
      this.emitError(`Agent Evolution could not create a review for task '${event.after.id}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private emitReviewChanged(review: EvolutionReview): void {
    try { this.deps.onReviewChanged?.(review); } catch { /* committed review state is authoritative */ }
  }

  private emitError(message: string): void {
    try { this.deps.onError?.(message); } catch { /* diagnostics cannot change review state */ }
  }
}
