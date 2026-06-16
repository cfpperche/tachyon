/**
 * Parsing helpers for an AgentTreeItem's `contextValue` (built in Sidebar.ts). The markers are
 * appended as SEGMENTS — e.g. `agent-stopped-ai-adhoc-worktree-forkable` — so `-adhoc` is NOT
 * necessarily the suffix. Detection must match the segment, never `endsWith("-adhoc")` / `/-adhoc$/`
 * (those missed an ad-hoc agent that also has a worktree — a stopped fork — and mis-routed its Delete
 * to the tachyon.yml path, erroring "does not exist"; dogfood 2026-06-16).
 */

/** True when the item is an ad-hoc agent (MCP-spawned / forked sibling — not declared in tachyon.yml). */
export function isAdhocItem(contextValue: string | undefined): boolean {
  return !!contextValue && /-adhoc(?:-|$)/.test(contextValue);
}
