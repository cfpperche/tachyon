/**
 * t-a1ee7e — the working METHODS the primer used to impose, released to the project.
 *
 * The boundary this module completes was already stated in `primer.ts` (t-486f43): a line that only
 * the product can state is a FACT and stays immune; a line saying how to WORK is a recipe and
 * belongs to whoever owns the project. That separation was applied once, to continuity cadence and
 * report style, and then stopped — leaving an orchestration model (wait to be assigned, never adopt
 * work yourself, resolve a records conflict by reporting it) imposed on every agent of every
 * project, inside a block declared immune to project guidance.
 *
 * Orchestration is the user's. Tachyon supplies the mechanism and a DEFAULT for each method; the
 * workspace changes any of them in `.tachyon/settings.yml`:
 *
 *   agentGuidance:
 *     dispatch: |
 *       Take the highest-priority unassigned task from the board yourself.
 *
 * Every default below is the exact text the product shipped before this change, so a workspace that
 * configures nothing reads precisely what it read yesterday.
 */

export interface AgentGuidance {
  /** No task on record and no brief: how this project expects work to reach an agent. */
  dispatch: string;
  /** Nothing assigned: whether an agent may serve itself from the shared records. */
  adoption: string;
  /** More tasks assigned than the current one: this project's ordering policy. */
  queueOrder: string;
  /** Session runs in its own worktree: this project's write policy for it. */
  worktreeWrites: string;
  /** Session shares the primary checkout: this project's write policy for it. */
  sharedCheckout: string;
  /** The two records name different board work: how this project resolves that. */
  conflict: string;
  /** What a completion notice should carry. */
  reporting: string;
}

/** What the product shipped before the methods were released — behaviour-preserving on upgrade. */
export const DEFAULT_AGENT_GUIDANCE: AgentGuidance = {
  dispatch: "Wait for an explicit assignment.",
  adoption: "Do not adopt work by scanning the board, the pins, or another agent's continuity.",
  queueOrder: "Finish or hand back the one above before starting any of these.",
  worktreeWrites: "Make every change here. Do not edit, commit to, or push the primary checkout from this session.",
  sharedCheckout: "If your work needs a separate checkout, create one before you change tracked files; do not assume an earlier conversation already granted that.",
  conflict: "Report it to your spawner and do not pick one.",
  reporting: "status + commit/tree + where the detail lives",
};

export type AgentGuidanceInput = Partial<Record<keyof AgentGuidance, string>>;

/** Workspace overrides on top of the product defaults; a blank override falls back to the default. */
export function resolveAgentGuidance(configured: AgentGuidanceInput | undefined): AgentGuidance {
  const resolved = { ...DEFAULT_AGENT_GUIDANCE };
  for (const key of Object.keys(DEFAULT_AGENT_GUIDANCE) as (keyof AgentGuidance)[]) {
    const value = configured?.[key];
    if (typeof value === "string" && value.trim().length > 0) resolved[key] = value.trim();
  }
  return resolved;
}

export const AGENT_GUIDANCE_KEYS = Object.keys(DEFAULT_AGENT_GUIDANCE) as (keyof AgentGuidance)[];
