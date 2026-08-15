/**
 * t-bec361 — WHICH TARGETS a resolved agent caller may reach through the by-name lifecycle/input
 * doors (`kill_agent`, `restart_agent`, `write_input`).
 *
 * The identity half was already built and in use (spec 351: the Bridge resolves the caller from its
 * per-agent token before any fallback, and ~10 tools already require `caller.kind === "agent"`).
 * These three doors simply never asked. They take one parameter — the target's name — so any agent
 * could stop, restart or drive any other agent in the fleet; and for a Temporary that owns a
 * checkout, `kill_agent` cascades into removing the worktree and branch (t-a76aed), which makes the
 * wrong call a deletion rather than an interruption.
 *
 * The rule is deliberately NARROWER than `inWaitOutputScope`'s (which also admits siblings): reading
 * a sibling's pane is observation, stopping it is destruction. Self, below you in your own runtime
 * lineage, or directly owned by you in the durable Saved Agent roster — nothing sideways, nothing
 * upward. Roster ownership is checked separately and never converted into runtime lineage.
 *
 * Only a caller resolved as kind "agent" is scoped. master/external/legacy are the HUMAN's operation
 * tokens and stay unrestricted, because narrowing them would narrow the sidebar's own door — and the
 * human kills any agent by right. The host's internal doors (sidebar Kill through
 * `engineService`, crash/watch auto-restart through `Workspace`) call `manager.kill`/`manager.restart`
 * directly and never pass through these tools, so they are unaffected by construction.
 */

/** The runtime lineage question shared with read-only scope checks. */
export interface LineageSource {
  parentOf(name: string): string | undefined;
}

/** The two independent ownership questions lifecycle mutation asks of AgentManager — kept
 *  structural so tests need no real manager. */
export interface LifecycleOwnershipSource extends LineageSource {
  declaredOwnerOf(name: string): string | undefined;
}

export type LifecycleTool = "kill_agent" | "restart_agent" | "write_input";

const ACTION: Record<LifecycleTool, string> = {
  kill_agent: "stop",
  restart_agent: "restart",
  write_input: "type into",
};

/**
 * Bounded because a lineage cycle must refuse rather than hang. `parentOf` already drops self-parents
 * (AgentManager.ledgerParentOf), but a longer cycle written by an older build would still be walkable,
 * and this walk runs on the extension host's event loop.
 */
const MAX_LINEAGE_HOPS = 64;

/** True when `caller` is `target` itself, its direct roster owner, or an ancestor anywhere up its
 *  runtime lineage chain. Declared ownership is deliberately direct: config validation forbids a
 *  nested Saved ownership tree, and this must not invent one. */
export function inLifecycleScope(caller: string, target: string, lineage: LifecycleOwnershipSource): boolean {
  if (caller === target) return true;
  if (lineage.declaredOwnerOf(target) === caller) return true;
  let cursor = lineage.parentOf(target);
  for (let hops = 0; cursor !== undefined && hops < MAX_LINEAGE_HOPS; hops += 1) {
    if (cursor === caller) return true;
    cursor = lineage.parentOf(cursor);
  }
  return false;
}

/**
 * The refusal names the OWNER and the fix, not just "denied" (SDD 478 M6). Both halves are load-bearing
 * here: an agent that learns only "no" retries or gives up silently, and the caller usually cannot see
 * the lineage it just violated.
 */
export function lifecycleScopeRefusal(tool: LifecycleTool, caller: string, target: string, lineage: LifecycleOwnershipSource): string {
  const owner = lineage.parentOf(target) ?? lineage.declaredOwnerOf(target);
  const policy =
    `${tool} refused: caller '${caller}' may ${ACTION[tool]} only itself, an agent below it in its own lineage, ` +
    `or a Saved Agent it owns in the roster (policy: lifecycle-scoped, t-bec361/t-b5f896)`;
  const ownership = owner
    ? `'${target}' is not in that lineage — it belongs to '${owner}'`
    : `'${target}' is not in that lineage — it has no lineage parent, so it is top-level and answers to the human, not to an agent`;
  const fix = tool === "write_input"
    ? `use notify_agent(to: "${target}") — a notice is not lineage-scoped — or ask ${owner ? `'${owner}'` : "the human"}`
    : owner
      ? `ask '${owner}' with notify_agent(to: "${owner}"), or ask the human, who can ${ACTION[tool]} any agent from the Tachyon sidebar`
      : `ask the human, who can ${ACTION[tool]} any agent from the Tachyon sidebar`;
  return `${policy} — ${ownership}. Fix: ${fix}.`;
}
