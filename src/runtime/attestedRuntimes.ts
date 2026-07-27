/**
 * SDD 478 M1 — the one list of LLM runtimes Tachyon attests as able to operate an Agent.
 *
 * Before this module the question "which runtimes may operate an Agent" was answered in three
 * places that disagreed by construction (measured at 2320c2be): `KNOWN_AI_CLIS` (15 binaries,
 * deciding `inferKind`), `ResumeRuntime` (10 runtimes, deciding what resumes) and a literal
 * four-element array in `agentProfileProjection` (deciding what may be a canonical agent). So
 * `opencode`, `gemini` and `qwen` were agents to the first, resumable to the second and
 * unattestable to the third — an entry could be simultaneously "an agent" and "not attestable as
 * an agent".
 *
 * This list is now the source. The others derive from it or assert a relation to it:
 *   - `ResumeRuntime` is *defined* as `AttestedRuntime | <non-attested resumable runtimes>`, so
 *     the subset relation is a compile-time fact rather than a parallel truth;
 *   - `KNOWN_AI_CLIS` is composed from it, so the authoring suggestions can never omit an
 *     attested runtime;
 *   - the canonical-profile attestation and its private-home inspector registry key off it, the
 *     inspector registry exhaustively.
 *
 * A canonical agent's `executable` must equal its `adapter` (`agentProfileProjection`), so these
 * runtime names are also the attested binaries.
 *
 * Membership here is not a suggestion and not a detection heuristic: adding a runtime means
 * Tachyon has a measured inspector, a resume adapter and a launch path for it.
 * See docs/architecture/agent-vs-terminal.md.
 *
 * Order is the authoring-surface order (`KNOWN_AI_CLIS` is composed from it, and CLI detection
 * reports in list order); it carries no precedence.
 */
export const ATTESTED_RUNTIMES = ["claude", "codex", "grok", "pi"] as const;

export type AttestedRuntime = (typeof ATTESTED_RUNTIMES)[number];

const ATTESTED: ReadonlySet<string> = new Set<string>(ATTESTED_RUNTIMES);

/** True when `value` names a runtime Tachyon attests — the only test for "may this be an Agent". */
export function isAttestedRuntime(value: string | null | undefined): value is AttestedRuntime {
  return typeof value === "string" && ATTESTED.has(value);
}
