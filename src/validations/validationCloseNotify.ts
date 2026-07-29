/**
 * t-c6c4ad — wake the validation author (and live assignee) when a human closes a Validation.
 *
 * Symmetric to approval resolve inject (`composeFixedApprovalResponse` / `resolveApproval`):
 * the human's decision is already durable on the Validation record; this module only delivers a
 * bounded, FIXED host-owned line into any live agent session that cares. Offline agents lose
 * nothing — the closed round stays on disk and they can re-read it on resume.
 *
 * Pure composition + ported inject — no Bridge/AgentManager/tmux imports — so it stays
 * table-testable the same way approval resolution is.
 */

import type { Validation, ValidationOutcome } from "./types.js";

/** Names that identify a human / non-agent surface, never a live session to wake. */
const NON_AGENT_NAMES = new Set([
  "human",
  "vscode",
  "companion",
  "master",
  "legacy",
  "external",
  "editor",
  "user",
]);

export interface ValidationCloseLiveEntry {
  name: string;
  session: string;
  running: boolean;
  kind?: string;
  dead?: boolean;
  stopping?: boolean;
}

/**
 * FIXED Tachyon line — same posture as `composeFixedApprovalResponse`: plain ASCII, single line,
 * derived only from the validation id + outcome, never free-form human prose (result_note lives on
 * the durable record; the agent re-reads it).
 */
export function composeFixedValidationClosedResponse(
  validation: Pick<Validation, "id">,
  outcome: ValidationOutcome,
): string {
  return `[tachyon] human closed validation ${validation.id} as ${outcome} — you may proceed accordingly`;
}

/**
 * Who should be woken on a human close: the author and (if different) the assignee, when each
 * looks like an agent name. Dedupe preserves author-first order. "human"/host surfaces never wake.
 */
export function validationCloseWakeRecipients(
  validation: Pick<Validation, "author" | "assignee">,
): string[] {
  const out: string[] = [];
  for (const candidate of [validation.author, validation.assignee]) {
    if (!isWakeableAgentName(candidate)) continue;
    if (out.includes(candidate)) continue;
    out.push(candidate);
  }
  return out;
}

export function isWakeableAgentName(name: string | undefined | null): name is string {
  if (!name || typeof name !== "string") return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (NON_AGENT_NAMES.has(trimmed.toLowerCase())) return false;
  // Same shape the Bridge accepts for agent names.
  return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(trimmed);
}

export interface ValidationCloseWakeDelivery {
  agent: string;
  session?: string;
  receipt?: string;
  /** Set when the agent had no live session, or inject failed — close still stands. */
  skipped?: "offline" | "inject-error";
  error?: string;
}

/**
 * After a human closeRound succeeds: best-effort wake of each recipient's live agent session.
 * Never throws for offline agents or inject failures — the durable close is already committed.
 */
export async function wakeValidationClosedAuthors(input: {
  validation: Pick<Validation, "id" | "author" | "assignee">;
  outcome: ValidationOutcome;
  listEntries: () => Promise<ValidationCloseLiveEntry[]>;
  inject: (session: string, text: string) => Promise<{ receipt?: string; error?: string }>;
}): Promise<{
  injectedText: string;
  deliveries: ValidationCloseWakeDelivery[];
}> {
  const injectedText = composeFixedValidationClosedResponse(input.validation, input.outcome);
  const recipients = validationCloseWakeRecipients(input.validation);
  if (recipients.length === 0) {
    return { injectedText, deliveries: [] };
  }

  let entries: ValidationCloseLiveEntry[] = [];
  try {
    entries = await input.listEntries();
  } catch (err) {
    // Cannot enumerate fleet — treat everyone as offline rather than undo the close.
    const message = err instanceof Error ? err.message : String(err);
    return {
      injectedText,
      deliveries: recipients.map((agent) => ({
        agent,
        skipped: "offline" as const,
        error: message,
      })),
    };
  }

  const deliveries: ValidationCloseWakeDelivery[] = [];
  for (const agent of recipients) {
    const live = entries.find(
      (entry) =>
        entry.name === agent
        && entry.running
        && !entry.dead
        && !entry.stopping
        && (entry.kind === undefined || entry.kind === "agent"),
    );
    if (!live) {
      deliveries.push({ agent, skipped: "offline" });
      continue;
    }
    try {
      const result = await input.inject(live.session, injectedText);
      if (result.error) {
        deliveries.push({
          agent,
          session: live.session,
          skipped: "inject-error",
          error: result.error,
          ...(result.receipt ? { receipt: result.receipt } : {}),
        });
      } else {
        deliveries.push({
          agent,
          session: live.session,
          ...(result.receipt ? { receipt: result.receipt } : {}),
        });
      }
    } catch (err) {
      deliveries.push({
        agent,
        session: live.session,
        skipped: "inject-error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { injectedText, deliveries };
}
