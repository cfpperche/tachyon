import type { NoticeDeliveryResult } from "./tools.js";

/**
 * t-a77fe6 — the ports an approval resolution needs, built once.
 *
 * `resolveApproval` was wired twice with the same closures: the editor path
 * (`extensionOperationService`, `APPROVAL_CHANNEL_VSCODE_COMMAND`) and the Companion path (`Workspace`,
 * `APPROVAL_CHANNEL_COMPANION_HTTP`). `currentSessionOwner` and `inject` were byte-identical in both.
 *
 * `resolvedBy` deliberately stays a per-caller argument, and t-86e59a corrected WHY. This note used to
 * say `"vscode"` and `"companion"` were "different facts about who resolved an approval". They are
 * different CHANNELS, and they never carried a fact about the actor: three doors reach resolution with
 * no human gesture (approvalRequest.ts, invariant (3)), so both values were server-side constants
 * asserting something the host cannot observe. The argument stays per-caller because the CHANNEL really
 * does differ between the two call sites — that is the one thing each of them knows about itself.
 *
 * `completePin` is also left to the caller, and NOT because it varies harmlessly: the two callers
 * disagree today about whether a failing pin completion is fatal — the editor path lets it throw, the
 * Companion path swallows it best-effort. That divergence is almost certainly unintended, but picking
 * a winner changes behaviour on one of the two paths, so this preserves both exactly and the
 * disagreement is reported rather than silently resolved here.
 *
 * t-d79534 — delivery goes through the notice queue, not a raw submit.
 *
 * This port used to call `sendSubmittedLine` and return `tmux:<session>` unconditionally. Both halves
 * of that were wrong, and they failed together: a requester waiting on the decision is BUSY by
 * construction (it asked, then kept its turn open), so the line was typed into an occupied composer,
 * never submitted, and never started a turn — while the record claimed delivery. The requester stayed
 * parked until a human noticed and poked it, which is the exact babysitting the escalation flow exists
 * to remove.
 *
 * `deliverNotice` already solves both: it queues for a busy recipient and flushes on idle, and it
 * distinguishes `notified` / `queued` / `submit-unconfirmed` instead of assuming success. The two call
 * sites carried a `t-8d190f` note saying the receipt was "deliberately NOT consumed here" and deferred
 * the honesty fix to this contract — this is that fix.
 */
export interface ApprovalResolutionSources {
  /** Running managed entries, for attributing a session to its agent. */
  listEntries: () => Promise<Array<{ session: string; running: boolean; name: string }>>;
  /** Queue-aware delivery (`Workspace.deliverNotice`): submits to an idle recipient, queues a busy one. */
  deliverNotice: (agent: string, line: string) => Promise<NoticeDeliveryResult>;
}

export interface ApprovalResolutionPorts {
  currentSessionOwner: (session: string) => Promise<string | undefined>;
  inject: (session: string, text: string) => Promise<{ receipt?: string; error?: string }>;
}

export function approvalResolutionPorts(sources: ApprovalResolutionSources): ApprovalResolutionPorts {
  const ownerOf = async (session: string): Promise<string | undefined> =>
    (await sources.listEntries()).find((entry) => entry.session === session && entry.running)?.name;
  return {
    currentSessionOwner: ownerOf,
    inject: async (session, text) => {
      const agent = await ownerOf(session);
      // Delivery is agent-addressed because the queue is. A session with no running owner cannot be
      // woken at all, and saying so is the point: `resolveApproval` records the error, the human's
      // decision still stands, and nobody is told a parked agent was notified.
      if (!agent) return { error: `no running agent owns session '${session}'` };
      const result = await sources.deliverNotice(agent, text);
      if (result.status === "submit-unconfirmed") {
        return { error: `submission was not confirmed (${result.submitReason ?? "unknown"}) — the line may be staged unsent` };
      }
      return { receipt: result.status === "queued" ? `queued:${agent}` : `tmux:${session}` };
    },
  };
}
