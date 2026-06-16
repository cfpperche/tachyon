/**
 * THE single source of truth for an AgentTreeItem's `contextValue` — both the BUILDER (used by
 * Sidebar.ts) and the PARSERS (used by extension.ts command handlers) live here, so the producer and
 * consumers can't drift. The markers are appended as SEGMENTS — e.g.
 * `agent-stopped-ai-adhoc-worktree-forkable` — so NONE of them is guaranteed to be the suffix.
 * Detection must match the segment, never `endsWith("-adhoc")` / `/-adhoc$/` (those missed an ad-hoc
 * agent that ALSO has a worktree — a stopped fork — and mis-routed its Delete to the tachyon.yml path,
 * erroring "does not exist"; dogfood 2026-06-16). The package.json menu `when` regexes are a parallel
 * declarative consumer of this same contract — a guard test pins them to these outputs.
 */

export type AgentItemStateName = "running" | "stopped" | "crashed";

export interface AgentContextParts {
  state: AgentItemStateName;
  /** AI agent (vs a terminal) — gates AI-only actions (re-anchor, fork). */
  ai: boolean;
  /** ad-hoc: not declared in tachyon.yml (MCP-spawned or a forked sibling). */
  adhoc: boolean;
  /** runs in its own git worktree. */
  worktree: boolean;
  /** declares a verify gate (worktree agent). */
  verifiable: boolean;
  /** running on a fork-capable runtime (claude) → "Fork session" offered. */
  forkable: boolean;
  /** spec 226 — runs with an isolated harness (its own MCP config home). Informational badge. */
  harness: boolean;
}

/** Build the contextValue. Segment order is fixed; matchers must NOT assume any segment is the suffix. */
export function agentContextValue(p: AgentContextParts): string {
  return (
    `agent-${p.state}` +
    (p.ai ? "-ai" : "") +
    (p.adhoc ? "-adhoc" : "") +
    (p.worktree ? "-worktree" : "") +
    (p.verifiable ? "-verifiable" : "") +
    (p.forkable ? "-forkable" : "") +
    (p.harness ? "-harness" : "")
  );
}

/** True when the item is an ad-hoc agent (MCP-spawned / forked sibling — not declared in tachyon.yml). */
export function isAdhocItem(contextValue: string | undefined): boolean {
  return !!contextValue && /-adhoc(?:-|$)/.test(contextValue);
}
