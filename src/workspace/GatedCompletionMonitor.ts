/**
 * t-875700 — host-driven completion candidate for gated delegations that omit notify_agent.
 *
 * Arms when a gated child is idle (or clean-exited) on a clean worktree with HEAD beyond base,
 * waits a grace window for a real doorbell, then delivers one host-fallback/unverified notice
 * to the delegator via deliverNotice. Never writes doorbells.jsonl (protocol_doorbell_missed stays).
 */
import type { AgentAttention } from "../attention/AttentionMonitor.js";
import type { ManagedEntryInfo } from "../agents/AgentManager.js";

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

export interface GatedCompletionFacts {
  agent: string;
  delegator: string;
  deliveryId: string;
  worktreePath: string;
  baseSha: string;
  /** ISO — doorbell "since" (delivery/spawn createdAt) */
  sinceIso: string;
}

export interface GatedCompletionDeps {
  listGatedFacts(): Promise<GatedCompletionFacts[]>;
  listEntries(): Promise<ManagedEntryInfo[]>;
  attentionOf(agent: string): AgentAttention | undefined;
  headState(worktreePath: string): Promise<{ headRef: string; dirty: boolean } | null>;
  hasDoorbellRung(agent: string, delegator: string, sinceIso: string): boolean;
  deliverNotice(delegator: string, line: string, metadata?: { sourceChild?: string; sourceIncarnation?: number }): Promise<unknown>;
  sourceNoticeMetadata?(agent: string): { sourceChild?: string; sourceIncarnation?: number };
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
}): string {
  const head = input.headSha.slice(0, 12);
  const base = input.baseSha.slice(0, 12);
  const ageMin = Math.max(1, Math.round(input.ageMs / 60_000));
  return (
    `[tachyon] host-fallback/unverified: gated child '${input.agent}' idle/clean, ` +
    `delivery ${input.deliveryId}, HEAD ${head} (base ${base}), ~${ageMin}m, no notify_agent — ` +
    `inspect verify_task / Activity; not an accept`
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
    const entries = await this.deps.listEntries();
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
      if (head.headRef === fact.baseSha) continue;

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
