/**
 * t-815796 — fixer-on-own-branch: spawn a follow-up agent INTO an existing delegation's worktree/branch.
 * Pure resolution/validation helpers, kept separate from AgentManager (which owns the mutex + occupancy
 * state) so the API-key resolution (design point 1) and the owns-subset check (design point 4) stay
 * table-testable on their own.
 */
import { findDelegationRecordById, findNonArchivedDelegationRecordsByAgent, type DelegationRecord } from "../bridge/delegationRecord.js";

export type ReuseWorktreeErrorCode =
  | "AMBIGUOUS_REUSE_TARGET"
  | "REUSE_TARGET_NOT_FOUND"
  | "WORKTREE_OCCUPIED"
  | "WORKTREE_DIRTY_OR_UNVERIFIED"
  | "REUSE_OWNS_WIDENING"
  | "BRANCH_HEAD_CHANGED"
  | "REUSE_WORKTREE_NOT_FOUND";

/** A structured refusal for a reuse_worktree grant — `code` + `detail` carry the machine-actionable
 *  shape the design calls for (matches/occupant/expectedHead-actualHead/etc); `message` is the
 *  human-readable summary the Bridge surfaces via its plain-text error channel. */
export class ReuseWorktreeError extends Error {
  constructor(
    readonly code: ReuseWorktreeErrorCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(detail ? `${code}: ${message} ${JSON.stringify(detail)}` : `${code}: ${message}`);
    this.name = "ReuseWorktreeError";
  }
}

/** design point 4 — a requested owns subset must be ⊆ the original delegation's owns: every requested
 *  path must equal, or be nested under, one of the original owned paths (posix-normalized). */
export function isOwnsSubset(requested: string[], original: string[]): boolean {
  const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const originalNorm = original.map(norm);
  return requested.every((r) => {
    const rn = norm(r);
    return originalNorm.some((o) => rn === o || rn.startsWith(`${o}/`));
  });
}

export interface ReuseTarget {
  /** design point 1 — the API key: a delegation id. Takes precedence over agentName when both are given. */
  delegationId?: string;
  /** design point 1 — sugar only; must resolve to EXACTLY ONE non-archived delegation for that agent. */
  agentName?: string;
}

/** design point 1 — API key = delegation identity, NOT agent name. agentName is sugar that must resolve
 *  to exactly one non-archived delegation, else AMBIGUOUS_REUSE_TARGET naming every match (a rename/
 *  respawn/duplicate agent name must never silently pick a possibly-wrong or escalated target). */
export function resolveReuseTarget(workspaceRoot: string, target: ReuseTarget): { path: string; record: DelegationRecord } {
  if (target.delegationId) {
    const found = findDelegationRecordById(workspaceRoot, target.delegationId);
    if (!found) {
      throw new ReuseWorktreeError("REUSE_TARGET_NOT_FOUND", `no delegation record found for delegation id '${target.delegationId}'`, {
        delegationId: target.delegationId,
      });
    }
    return found;
  }
  if (target.agentName) {
    const matches = findNonArchivedDelegationRecordsByAgent(workspaceRoot, target.agentName);
    if (matches.length === 0) {
      throw new ReuseWorktreeError("REUSE_TARGET_NOT_FOUND", `no non-archived delegation record found for agent '${target.agentName}'`, {
        agentName: target.agentName,
      });
    }
    if (matches.length > 1) {
      throw new ReuseWorktreeError(
        "AMBIGUOUS_REUSE_TARGET",
        `agent name '${target.agentName}' resolves to ${matches.length} non-archived delegations; pass delegation_id instead`,
        { agentName: target.agentName, matches: matches.map((m) => ({ delegationId: m.record.id, path: m.path, createdAt: m.record.createdAt })) },
      );
    }
    return matches[0];
  }
  throw new ReuseWorktreeError("REUSE_TARGET_NOT_FOUND", "reuse_worktree requires either a delegation_id or an agent_name");
}
