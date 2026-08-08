/**
 * t-875700 — host-driven completion candidate for gated delegations that omit notify_agent.
 *
 * Arms when a gated child is idle (or clean-exited) on a clean worktree with HEAD beyond base,
 * waits a grace window for a real doorbell, then delivers one host-fallback/unverified notice
 * to the delegator via deliverNotice. Never writes doorbells.jsonl (protocol_doorbell_missed stays).
 */
import type { AgentAttention } from "../attention/AttentionMonitor.js";
import type { ManagedEntryInfo } from "../agents/AgentManager.js";
import type { ManagedWorktreeEntry } from "../worktree/managedWorktree.js";
import type { NoticeQueueMetadata } from "../bridge/NoticeQueue.js";

export const DEFAULT_GATED_COMPLETION_GRACE_MS = 45_000;

export type GatedCandidateStatus = "armed" | "sent" | "suppressed";

export interface GatedCandidateRecord {
  key: string;
  agent: string;
  delegator: string;
  deliveryId: string;
  headSha: string;
  baseSha: string;
  status: GatedCandidateStatus;
  armedAtMs: number;
  sentAtMs?: number;
}

/**
 * t-5e9bf8 — what makes a HEAD count as a delivery, which is not the same question for both kinds of
 * agent this monitor now serves.
 *
 * `beyond-base` is the gated-delegation rule: a gated child is created at the contract base and is
 * torn down after, so ANY commit past that base is its work and nothing else's.
 *
 * `verified-since` is the assigned-agent rule. A persistent canonical agent's worktree is its home
 * across many tasks, so it sits past its spawn base essentially always — `beyond-base` there would
 * fire on ordinary idle, which is precisely the false positive this feature must not produce. The
 * stronger fact is that the tree at HEAD has a verification record written AFTER the task was
 * assigned: that is evidence of a finished, gated deliverable rather than evidence of activity.
 */
export type CompletionEvidence = "beyond-base" | "verified-since";

export interface GatedCompletionFacts {
  agent: string;
  /** the party to notify: the gated delegator, or the assigned agent's owner/coordinator. */
  delegator: string;
  deliveryId: string;
  worktreePath: string;
  baseSha: string;
  /** ISO — doorbell "since" (delivery/spawn createdAt, or the task assignment moment) */
  sinceIso: string;
  /** Defaults to the original gated rule so existing facts keep their exact behavior. */
  evidence?: CompletionEvidence;
}

export interface GatedCompletionDeps {
  listGatedFacts(): Promise<GatedCompletionFacts[]>;
  listAgents(): Promise<ManagedEntryInfo[]>;
  attentionOf(agent: string): AgentAttention | undefined;
  headState(worktreePath: string): Promise<{ headRef: string; dirty: boolean } | null>;
  /**
   * t-5e9bf8 — whether the tree at `headSha` carries a verification recorded at or after `sinceIso`.
   * Fail-closed: anything unreadable, absent or older answers false, so "cannot tell" never arms.
   */
  isVerifiedSince?(worktreePath: string, headSha: string, sinceIso: string): Promise<boolean>;
  hasDoorbellRung(agent: string, delegator: string, sinceIso: string): boolean;
  deliverNotice(delegator: string, line: string, metadata?: NoticeQueueMetadata): Promise<unknown>;
  /** t-fb1453 — a host-authored observation ABOUT a child; it expires with that child by design. */
  sourceNoticeMetadata?(agent: string): NoticeQueueMetadata;
  now(): number;
  loadCandidates(): Record<string, GatedCandidateRecord>;
  saveCandidates(candidates: Record<string, GatedCandidateRecord>): void;
}

export function candidateKey(input: {
  deliveryId: string;
  agent: string;
  headSha: string;
  delegator: string;
}): string {
  return `${input.deliveryId}|${input.agent}|${input.headSha}|${input.delegator}`;
}

export function hostFallbackLine(input: {
  agent: string;
  deliveryId: string;
  headSha: string;
  baseSha: string;
  ageMs: number;
  evidence?: CompletionEvidence;
}): string {
  const head = input.headSha.slice(0, 12);
  const base = input.baseSha.slice(0, 12);
  const ageMin = Math.max(1, Math.round(input.ageMs / 60_000));
  // t-5e9bf8 — the line has to name the fact that armed it, because the reader's next move differs:
  // an assigned agent is read through its task journal, an unassigned one only through its pane.
  // Saying "gated child" about an assigned agent would send them to the wrong place.
  //
  // t-8b8315 — the unassigned branch used to say "inspect verify_task", and that tool was retired
  // with the Delivery machinery. This line fires exactly when a human is already confused about a
  // silent agent; naming a door that no longer opens spends their next move on discovering that.
  if (input.evidence === "verified-since") {
    return (
      `[tachyon] host-fallback/unverified: assigned agent '${input.agent}' idle/clean with a VERIFIED ` +
      `HEAD ${head}, ${input.deliveryId}, ~${ageMin}m, no notify_agent — read its task journal; not an accept`
    );
  }
  return (
    `[tachyon] host-fallback/unverified: gated child '${input.agent}' idle/clean, ` +
    `delivery ${input.deliveryId}, HEAD ${head} (base ${base}), ~${ageMin}m, no notify_agent — ` +
    `read its pane (read_output) / Activity; not an accept`
  );
}

/** Whether attention/exit qualifies to arm a candidate (not working/needs-input/throttled). */
export function isArmableAttention(
  entry: Pick<ManagedEntryInfo, "running" | "cleanExited" | "dead" | "crashed">,
  attention: AgentAttention | undefined,
): boolean {
  const cleanExit = !!entry.cleanExited || (!!entry.dead && !entry.crashed && !entry.running);
  if (cleanExit) return true;
  if (!entry.running || !attention) return false;
  if (attention.state === "needs-input" || attention.state === "throttled") return false;
  if (attention.composerOccupied) return false;
  // attentionOf may already remap post-notify working→idle (t-9552f3)
  return attention.state === "idle";
}

/** The narrow slice of a board task this selection needs. */
export interface AssignedTaskFact {
  id: string;
  status: string;
  assignee?: string;
  /** the assignment moment — a verification older than this belongs to earlier work. */
  updatedAt: string;
}

export interface AssignedCompletionInput {
  entries: readonly Pick<ManagedEntryInfo, "name" | "kind" | "delegator" | "declaredOwner" | "parent">[];
  /** names present in `agents:` — declared only, so a Temporary sibling can never arm. */
  declared: ReadonlySet<string>;
  tasks: readonly AssignedTaskFact[];
  /** worktree path and base for this exact agent+task, resolved from host-owned records. */
  locate(agent: string, taskId: string): { worktreePath?: string; baseSha?: string } | undefined;
}

export interface AssignedCompletionWorktreeInput {
  agent: string;
  taskId: string;
  /** Host-owned managed registry rows; paths supplied by an agent are never accepted here. */
  managed: readonly ManagedWorktreeEntry[];
  /** The agent's persistent checkout from its host-owned session ledger. */
  persistent?: { worktreePath?: string; baseSha?: string };
}

/**
 * Resolve the checkout that can prove an assigned task's delivery.
 *
 * A change worktree is authoritative only when its registry row binds all three identities:
 * active change kind + this task + this agent as creator. A row for another task/agent is unrelated,
 * and multiple matching rows are ambiguous rather than permission to guess. With no exact change
 * row, preserve the original persistent-worktree behavior.
 */
export function resolveAssignedCompletionWorktree(
  input: AssignedCompletionWorktreeInput,
): { worktreePath?: string; baseSha?: string } | undefined {
  const activeChanges = input.managed.filter((entry) =>
    entry.kind === "change"
    && entry.status === "active");
  const matching = activeChanges.filter((entry) =>
    entry.taskId === input.taskId
    && entry.createdBy === input.agent);
  if (matching.length > 1) return undefined;
  if (matching.length === 1) {
    return { worktreePath: matching[0]!.path, baseSha: matching[0]!.baseRef };
  }
  // A partial registry association is evidence that the persistent checkout is NOT a safe
  // substitute: either this task belongs to another creator's change worktree, or this agent has a
  // different task's change worktree. Falling through here reproduced the cross-task HEAD notice in
  // t-b103c5. Only a registry with no relation to either identity permits the legacy persistent path.
  if (activeChanges.some((entry) => entry.taskId === input.taskId || entry.createdBy === input.agent)) {
    return undefined;
  }
  return input.persistent;
}

/**
 * t-5e9bf8 — facts for declared canonical agents that have a coordinator and an active assigned task.
 *
 * Pure on purpose: every clause here is a NON-trigger the feature promises, and a predicate that
 * decides when a coordinator gets messaged automatically should be checkable without standing up a
 * Workspace. A gated row (one carrying `delegator`) is skipped because the delegation arm already
 * owns it — the two sources must never both emit for the same agent.
 */
export function assignedCompletionFacts(input: AssignedCompletionInput): GatedCompletionFacts[] {
  const out: GatedCompletionFacts[] = [];
  for (const entry of input.entries) {
    if (entry.delegator) continue;
    if (!input.declared.has(entry.name)) continue;
    const owner = entry.declaredOwner ?? entry.parent;
    if (!owner || owner === entry.name) continue;
    const task = input.tasks.find((t) => t.status === "active" && t.assignee === entry.name);
    if (!task) continue;
    const located = input.locate(entry.name, task.id);
    if (!located?.worktreePath) continue;
    out.push({
      agent: entry.name,
      delegator: owner,
      deliveryId: `task:${task.id}`,
      worktreePath: located.worktreePath,
      baseSha: located.baseSha ?? "",
      sinceIso: task.updatedAt,
      evidence: "verified-since",
    });
  }
  return out;
}

export class GatedCompletionMonitor {
  constructor(
    private readonly deps: GatedCompletionDeps,
    private readonly graceMs = DEFAULT_GATED_COMPLETION_GRACE_MS,
  ) {}

  async tick(): Promise<void> {
    const now = this.deps.now();
    const candidates = { ...this.deps.loadCandidates() };
    let dirty = false;

    const facts = await this.deps.listGatedFacts();
    const entries = await this.deps.listAgents();
    const entryByName = new Map(entries.map((e) => [e.name, e]));

    for (const fact of facts) {
      if (!fact.delegator || fact.delegator === fact.agent) continue;
      const entry = entryByName.get(fact.agent);
      if (!entry) continue;

      // Manual doorbell wins: suppress armed candidates for this agent→delegator.
      if (this.deps.hasDoorbellRung(fact.agent, fact.delegator, fact.sinceIso)) {
        for (const [k, rec] of Object.entries(candidates)) {
          if (rec.agent === fact.agent && rec.delegator === fact.delegator && rec.status === "armed") {
            candidates[k] = { ...rec, status: "suppressed" };
            dirty = true;
          }
        }
        continue;
      }

      if (!isArmableAttention(entry, this.deps.attentionOf(fact.agent))) continue;

      const head = await this.deps.headState(fact.worktreePath);
      if (!head || head.dirty || !head.headRef) continue;
      if ((fact.evidence ?? "beyond-base") === "verified-since") {
        // No resolver wired is not "verified" — an assigned agent must never arm on a weaker fact
        // than the one its rule names.
        const verified = await this.deps
          .isVerifiedSince?.(fact.worktreePath, head.headRef, fact.sinceIso)
          .catch(() => false);
        if (!verified) continue;
      } else if (head.headRef === fact.baseSha) continue;

      const key = candidateKey({
        deliveryId: fact.deliveryId,
        agent: fact.agent,
        headSha: head.headRef,
        delegator: fact.delegator,
      });
      const existing = candidates[key];
      if (!existing) {
        candidates[key] = {
          key,
          agent: fact.agent,
          delegator: fact.delegator,
          deliveryId: fact.deliveryId,
          headSha: head.headRef,
          baseSha: fact.baseSha,
          status: "armed",
          armedAtMs: now,
        };
        dirty = true;
        continue;
      }
      if (existing.status === "sent" || existing.status === "suppressed") continue;
      if (now - existing.armedAtMs < this.graceMs) continue;

      if (this.deps.hasDoorbellRung(fact.agent, fact.delegator, fact.sinceIso)) {
        candidates[key] = { ...existing, status: "suppressed" };
        dirty = true;
        continue;
      }

      const line = hostFallbackLine({
        agent: fact.agent,
        deliveryId: fact.deliveryId,
        headSha: existing.headSha,
        baseSha: existing.baseSha,
        ageMs: now - existing.armedAtMs,
        ...(fact.evidence ? { evidence: fact.evidence } : {}),
      });
      await this.deps
        .deliverNotice(fact.delegator, line, this.deps.sourceNoticeMetadata?.(fact.agent))
        .catch(() => undefined);
      candidates[key] = { ...existing, status: "sent", sentAtMs: now };
      dirty = true;
    }

    if (dirty) this.deps.saveCandidates(candidates);
  }
}
