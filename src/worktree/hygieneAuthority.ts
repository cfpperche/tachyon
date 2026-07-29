/**
 * t-e74631 — WHO may ask for a change worktree to be cleaned up.
 *
 * The measured failure: 19 change worktrees accumulated, 14 of them clean and already contained in
 * the trunk, because `canMutateManagedWorktree` grants removal to the creator alone. The coordinator
 * that delegated the work could not clean up after its own children, so hygiene depended on each
 * child waking up and remembering — and a child that finished its task has no reason to wake again.
 *
 * The fix is an AUTHORITY question, and only that. It answers "may this actor ask?", never "is this
 * safe?". The material locks — clean, unoccupied, contained in base or trunk, Tachyon-created branch —
 * are `classifyManagedWorktree`'s and stay exactly where they are. Widening who may ASK while every
 * proof still has to pass is what makes this safe to widen at all: the worst a wrongly-granted
 * ancestor can do is request a removal the classifier then refuses.
 *
 * Fail-closed on identity, deliberately: a relation that cannot be PROVED is not a relation. An entry
 * with no recorded owner, a lineage that cycles, or an actor with no name all refuse rather than
 * assume, because the cost of a wrong "yes" here is someone else's uncommitted work.
 */

import type { ManagedWorktreeEntry } from "./managedWorktree.js";

/** How the actor is entitled to act on this entry. Recorded on every removal, never inferred later. */
export type HygieneRelation =
  /** The actor created the entry, or is the agent it belongs to. */
  | "owner"
  /** The actor is a registered lineage ancestor of the owner (the delegating parent, or ITS parent). */
  | "ancestor"
  /** The workspace authority (the host human), who is nobody's descendant. */
  | "workspace";

export interface HygieneAuthorityGranted {
  allowed: true;
  relation: HygieneRelation;
  /** Bridge-resolved actor the grant was issued to. */
  actor: string;
  /** The entry's recorded owner, when it has one. */
  owner?: string;
  /**
   * Owner-to-actor chain for an `ancestor` grant, owner first and actor last. This is the PROOF the
   * grant rests on, so it is recorded rather than recomputed — lineage is session-local and a later
   * reader cannot re-derive what it looked like at removal time.
   */
  lineage?: string[];
}

export interface HygieneAuthorityRefused {
  allowed: false;
  /** Why the actor may not ask. Names a reachable way forward (t-2600f8), never just the fact. */
  reason: string;
}

export type HygieneAuthorityDecision = HygieneAuthorityGranted | HygieneAuthorityRefused;

/** The lineage seam. `AgentManager.parentOf` satisfies it; tests pass a map. */
export interface HygieneLineageSource {
  parentOf(name: string): string | undefined;
}

/**
 * t-ff0a7a — compose session/runtime parent with config `declaredOwner` for hygiene walks.
 *
 * Saved Agents created via the governed port are top-level managed entries: they expose
 * `declaredOwner` in list_agents / tachyon.yml but deliberately do NOT write a runtime `parent`
 * (sidebar stays flat; runtime lineage stays for ad-hoc children only). Hygiene is an AUTHORITY
 * question over CHANGE residue — the declared owner is an authorized ancestor for that purpose.
 *
 * Precedence matches the rest of the product (sidebar grouping): runtime parent first, then
 * declaredOwner. Self-parent and empty values are ignored so a corrupt config cannot cycle on itself.
 */
export function composeHygieneLineageSource(input: {
  runtimeParentOf: (name: string) => string | undefined;
  declaredOwnerOf: (name: string) => string | undefined;
}): HygieneLineageSource {
  return {
    parentOf(name: string): string | undefined {
      const runtime = input.runtimeParentOf(name);
      if (runtime && runtime !== name) return runtime;
      const declared = input.declaredOwnerOf(name);
      if (declared && declared !== name) return declared;
      return undefined;
    },
  };
}

export interface HygieneActor {
  kind: string;
  name?: string;
}

/**
 * Bound on the ancestor walk. Lineage is a tree in principle, but it is rebuilt from session-local
 * memory unioned with a persisted ledger, and a corrupted union could contain a cycle. `seen` already
 * terminates the walk; this bounds it even if `seen` is defeated by something exotic, and turns a
 * pathological chain into a refusal rather than a hang inside an authorization decision.
 */
const MAX_LINEAGE_DEPTH = 64;

/**
 * Resolve whether `actor` may request hygiene removal of `entry`.
 *
 * Hierarchy applies to CHANGE worktrees only. An agent worktree is that agent's working home rather
 * than a per-task checkout, so no ancestor inherits authority over it — a parent tidying up after a
 * finished task must never be able to delete the place its child actually lives.
 */
export function resolveHygieneAuthority(
  entry: ManagedWorktreeEntry,
  actor: HygieneActor,
  lineage: HygieneLineageSource,
): HygieneAuthorityDecision {
  // The host human is the workspace authority and is nobody's descendant, so this arm never consults
  // lineage — an unreadable or empty lineage must not cost the human their own cleanup.
  if (actor.kind === "human") return { allowed: true, relation: "workspace", actor: "human", owner: ownerOf(entry) };

  if (actor.kind !== "agent" || !actor.name) {
    // legacy/external principals share tokens, so they are not a provable identity. Deliberately the
    // same stance `canMutateManagedWorktree` takes for destructive registry operations.
    return {
      allowed: false,
      reason:
        `hygiene removal requires an agent-authenticated or human caller (got '${actor.kind}')` +
        "; call it as the owning agent, one of its lineage ancestors, or from the host UI",
    };
  }

  const owner = ownerOf(entry);
  if (owner === actor.name) return { allowed: true, relation: "owner", actor: actor.name, owner };

  if (entry.kind !== "change") {
    return {
      allowed: false,
      reason:
        `'${entry.id}' is an ${entry.kind} worktree, which only its owner may remove — lineage does not ` +
        "extend to an agent's own working home; ask that agent to remove it, or use the host UI",
    };
  }

  if (!owner) {
    // An entry with no recorded owner has no chain to walk, so `ancestor` cannot be PROVED. Refusing
    // is the fail-closed half of the contract: without this, an ownerless row would be removable by
    // any agent at all, which is wider than the creator-only rule this replaces.
    return {
      allowed: false,
      reason:
        `'${entry.id}' records no owner, so no lineage relation to '${actor.name}' can be proved` +
        "; remove it from the host UI, where workspace authority does not depend on lineage",
    };
  }

  const chain = ancestorChain(owner, lineage);
  if (!chain.ok) {
    return {
      allowed: false,
      reason:
        `lineage for owner '${owner}' is ${chain.why}, so authority over '${entry.id}' cannot be established` +
        "; remove it from the host UI, where workspace authority does not depend on lineage",
    };
  }
  const at = chain.chain.indexOf(actor.name);
  if (at > 0) {
    return { allowed: true, relation: "ancestor", actor: actor.name, owner, lineage: chain.chain.slice(0, at + 1) };
  }

  return {
    allowed: false,
    reason:
      `'${actor.name}' is neither the owner ('${owner}') nor one of its lineage ancestors` +
      `${chain.chain.length > 1 ? ` (${chain.chain.slice(1).join(" → ")})` : " (owner has no recorded parent)"}` +
      "; ask the owner or one of those ancestors, or remove it from the host UI",
  };
}

/** The agent an entry belongs to: its creator, or the agent it was registered for. */
function ownerOf(entry: ManagedWorktreeEntry): string | undefined {
  return entry.createdBy ?? entry.agent;
}

/**
 * The owner's ancestor chain, owner first. A cycle or an over-deep chain is reported as inconsistent
 * rather than truncated: a partial chain would silently answer an authorization question with less
 * evidence than the caller thinks it has.
 */
function ancestorChain(
  owner: string,
  lineage: HygieneLineageSource,
): { ok: true; chain: string[] } | { ok: false; why: string; chain: string[] } {
  const chain: string[] = [owner];
  const seen = new Set<string>([owner]);
  let current = owner;
  for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth++) {
    let parent: string | undefined;
    try {
      parent = lineage.parentOf(current);
    } catch {
      // A lineage source that throws is unknown lineage, not absent lineage.
      return { ok: false, why: "unreadable", chain };
    }
    if (!parent || parent === current) return { ok: true, chain };
    if (seen.has(parent)) return { ok: false, why: "cyclic", chain };
    seen.add(parent);
    chain.push(parent);
    current = parent;
  }
  return { ok: false, why: `deeper than ${MAX_LINEAGE_DEPTH} links`, chain };
}
