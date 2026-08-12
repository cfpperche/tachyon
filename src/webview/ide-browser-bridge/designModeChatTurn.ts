/**
 * Design Mode chat turn identity (Codex C-06 / t-181925).
 *
 * One outstanding wait is fine; what was wrong was resolving it by "any reply
 * clears the global slot". A reply binds to a host-minted turn id and the agent
 * that was targeted at send time. Agent switches and later sends must not
 * retarget an in-flight wait.
 */

import { randomUUID } from "node:crypto";

export type DmChatTurnWait = {
  /** Host-minted id for this human send → agent reply cycle. */
  turnId: string;
  /** Agent the prompt was delivered to — frozen for the life of the wait. */
  agent: string;
  /** True once attention has been working/throttled/needs-input for this wait. */
  sawBusy: boolean;
  /** A busy turn already existed at delivery; it must end before a later turn can count. */
  awaitPostDeliveryStart?: boolean;
};

export type DmChatReplyMatch =
  | { ok: true; resolvesWait: boolean }
  | { ok: false; error: string };

/**
 * Mint a host turn id. Prefix makes pane/log grepping obvious and avoids
 */
export function mintDmChatTurnId(newId: () => string = randomUUID): string {
  return `dm-turn-${newId()}`;
}

/**
 * Decide whether a reply may resolve the outstanding wait.
 *
 * - No wait: reply may still be recorded (orphan/tool use outside a send), but
 *   it does not resolve anything.
 * - Pending wait: reply must carry the matching turnId. Wrong or missing id
 *   does not clear the wait (identity, not timing). Optional agent, when
 *   present, must match the wait's target agent.
 */
export function matchDmChatReplyToWait(
  wait: DmChatTurnWait | null,
  reply: { turnId?: string; agent?: string },
): DmChatReplyMatch {
  if (!wait) {
    return { ok: true, resolvesWait: false };
  }

  const turnId = reply.turnId?.trim() ?? "";
  if (!turnId) {
    return {
      ok: false,
      error:
        "turnId required — pass the Design Mode turn id from the prompt so this reply binds to the correct wait",
    };
  }
  if (turnId !== wait.turnId) {
    return {
      ok: false,
      error: `reply turnId '${turnId}' does not match pending turn '${wait.turnId}'`,
    };
  }

  const agent = reply.agent?.trim();
  if (agent && agent !== wait.agent) {
    return {
      ok: false,
      error: `reply agent '${agent}' does not match pending turn agent '${wait.agent}'`,
    };
  }

  return { ok: true, resolvesWait: true };
}

/** True when an agent switch must leave the in-flight wait alone. */
export function agentSwitchRetargetsWait(
  wait: DmChatTurnWait | null,
  newActiveAgent: string,
): boolean {
  if (!wait) return false;
  // Correct product: never retarget. A switch only changes who the *next* send goes to.
  void newActiveAgent;
  return false;
}

/** Poll/timeout target for an outstanding wait — frozen agent, not UI selection. */
export function waitPollAgent(wait: DmChatTurnWait | null, designAgent: string): string | null {
  if (!wait) return null;
  void designAgent;
  return wait.agent;
}
