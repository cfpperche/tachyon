import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ScheduleDef } from "../config/loadConfig.js";

/**
 * Agent-proposed schedules awaiting human approval (F23). An agent can ask for a
 * schedule via the Bridge, but the proposal is INERT — it never fires — until a
 * human approves it, which writes it into tachyon.yml (config-as-code) and drops
 * it from here. Stored as a plain file so it has the same doors as pins:
 *
 *   .tachyon/schedules-pending.json — {"proposals": [...]}
 */

export interface ScheduleProposal {
  id: string;
  name: string;
  /**
   * Who proposed it. t-fbefec — over the Bridge this is the RESOLVED caller (the agent's own name,
   * or `(kind)` for a non-agent caller), never self-declared and never the placeholder "agent" every
   * proposal used to carry: the human reads this when authorizing the tachyon.yml write.
   */
  by: string;
  /** why the agent wants it — shown to the human */
  reason?: string;
  createdAt: string;
  /** Same review window as Saved Agent proposals: pending authority is not evergreen. */
  expiresAt: string;
  schedule: ScheduleDef;
}

/** Same per-proposer attention ceiling as the sibling Saved Agent proposal queue. */
export const SCHEDULE_PROPOSAL_PENDING_CEILING = 3;
export const SCHEDULE_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

export function scheduleProposalExpired(proposal: Pick<ScheduleProposal, "expiresAt">, nowMs = Date.now()): boolean {
  const expiry = Date.parse(proposal.expiresAt);
  return !Number.isFinite(expiry) || expiry <= nowMs;
}

export class ProposalStore {
  constructor(private readonly workspaceRoot: string) {}

  get dir(): string {
    return path.join(this.workspaceRoot, ".tachyon");
  }
  get file(): string {
    return path.join(this.dir, "schedules-pending.json");
  }

  list(): ScheduleProposal[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(".tachyon/schedules-pending.json is not valid JSON — fix or delete it");
    }
    const proposals = (parsed as { proposals?: unknown }).proposals;
    if (!Array.isArray(proposals)) throw new Error('.tachyon/schedules-pending.json must be {"proposals": [...]}');
    return proposals as ScheduleProposal[];
  }

  private write(proposals: ScheduleProposal[]): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify({ proposals }, null, 2)}\n`, "utf8");
  }

  /** Records a proposal. Dedupes by name (a re-proposal replaces the prior pending one). */
  create(name: string, schedule: ScheduleDef, by: string, reason?: string): ScheduleProposal {
    const proposals = this.list().filter((p) => p.name !== name);
    const mine = proposals.filter((proposal) => proposal.by === by && !scheduleProposalExpired(proposal));
    if (mine.length >= SCHEDULE_PROPOSAL_PENDING_CEILING) {
      throw new Error(
        `agent '${by}' already has ${mine.length} pending schedule proposals ` +
        `(ceiling ${SCHEDULE_PROPOSAL_PENDING_CEILING}); approve or reject one before proposing another`,
      );
    }
    const createdAt = new Date().toISOString();
    const proposal: ScheduleProposal = {
      id: crypto.randomBytes(6).toString("hex"),
      name,
      by,
      reason,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + SCHEDULE_PROPOSAL_TTL_MS).toISOString(),
      schedule,
    };
    this.write([...proposals, proposal]);
    return proposal;
  }

  get(id: string): ScheduleProposal | undefined {
    return this.list().find((p) => p.id === id);
  }

  remove(id: string): void {
    this.write(this.list().filter((p) => p.id !== id));
  }
}
