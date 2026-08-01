/**
 * t-05dff5 — a governed refusal declares itself; it is never recognised by reading its prose.
 *
 * Two things can stop a canonical profile lifecycle action, and they are not the same kind of thing:
 *
 *   - a GOVERNED REFUSAL: a named precondition the engine checked and rejected. Its message IS the
 *     answer — "still owns a worktree; remove it explicitly before canonical forget" names the exact
 *     gesture that unblocks the human. Sanitising it destroys the only information the screen had.
 *   - an INTERNAL FAILURE: a stack, a path, an I/O detail. Flattening it to one neutral sentence is
 *     correct — it is not actionable, and the raw text leaks host layout into the panel.
 *
 * The distinction used to be drawn downstream, in the cockpit, by `message.includes("revision")`.
 * That put the decision in the WRONG PLACE (a reader of the text, not the author of the condition)
 * and made it depend on wording nobody was obliged to preserve, so every precondition that did not
 * happen to say "revision" — all of forget's — was classified as an internal failure and thrown
 * away. Measured on 0.56.142: three rounds of trial and error to discover a refusal the engine had
 * spelled out on the first attempt.
 *
 * So the throw site declares it. `AgentProfileRefusal` carries a CODE from a closed set, and the
 * classification is `instanceof` — no substring anywhere. Renaming a message can no longer silently
 * reclassify it, and a new precondition is a refusal only if its author says so, which is the one
 * person who actually knows.
 *
 * The codes live in the `agent-profile/*` family the Agent Studio protocol already speaks. The list
 * below is CLOSED in the type system, where the author of a precondition is; the wire accepts the
 * open `AGENT_PROFILE_REFUSAL_CODE_RE` SHAPE instead, because a shell one release behind must still
 * render a refusal code it has never heard of rather than reject the payload and fall back to the
 * generic sentence this task exists to remove.
 */
export const AGENT_PROFILE_REFUSAL_CODES = [
  /** The profile moved under the human between reading it and acting on it. */
  "agent-profile/revision-conflict",
  /** A session, pane, provisional registration or soul reservation still holds the agent. */
  "agent-profile/forget-agent-running",
  /** The session ledger still claims a checkout for the agent. */
  "agent-profile/forget-worktree-owned",
  /** Canonical authority for the agent (or its declared owner) is absent or no longer matches. */
  "agent-profile/forget-authority-stale",
  /** Evolution's stored profile and the on-disk profile tree disagree about whether one exists. */
  "agent-profile/forget-evolution-incomplete",
  /** t-4736b4 — a session still holds the agent while its worktree ownership is being released. */
  "agent-profile/worktree-release-agent-running",
  /**
   * t-4736b4 — the tmux inventory could not be read, so occupancy is UNKNOWN: neither alive nor
   * gone. Removal refuses rather than guess, and this is a refusal because the human can act on it
   * (check the server, retry — the probe re-measures every call and records nothing durable).
   */
  "agent-profile/occupancy-unverifiable",
] as const;

export type AgentProfileRefusalCode = (typeof AGENT_PROFILE_REFUSAL_CODES)[number];

/** The shape the Agent Studio protocol accepts for a refusal code, mirrored by the webview guard. */
export const AGENT_PROFILE_REFUSAL_CODE_RE = /^agent-profile\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The one refusal whose recovery the SHELL performs rather than the human: the profile moved, so the
 * panel reloads it before the human reads the sentence. Named here, beside the code list, so the
 * cockpit tests a constant rather than re-typing the string it is deciding on.
 */
export const AGENT_PROFILE_REVISION_CONFLICT_CODE = "agent-profile/revision-conflict" satisfies AgentProfileRefusalCode;

/**
 * A precondition the engine checked and rejected, whose message is meant for a human to act on.
 *
 * Thrown, not returned, because every caller below the Studio boundary already handles lifecycle
 * failures as exceptions and none of them should have to learn a second control flow. It becomes a
 * VALUE exactly once, at `commitAgentProfileStudioLifecycle`, because that is where it crosses the
 * engine↔shell wire — and an exception does not survive that crossing with its type intact.
 */
export class AgentProfileRefusal extends Error {
  constructor(readonly code: AgentProfileRefusalCode, message: string, options?: { cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "AgentProfileRefusal";
  }
}

export function isAgentProfileRefusal(error: unknown): error is AgentProfileRefusal {
  return error instanceof AgentProfileRefusal;
}
