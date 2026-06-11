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
  /** self-declared author (agent name) */
  by: string;
  /** why the agent wants it — shown to the human */
  reason?: string;
  createdAt: string;
  schedule: ScheduleDef;
}

const CAP = 10;

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
    if (proposals.length >= CAP) {
      throw new Error(`too many pending schedule proposals (cap ${CAP}) — approve or reject some first`);
    }
    const proposal: ScheduleProposal = {
      id: crypto.randomBytes(6).toString("hex"),
      name,
      by,
      reason,
      createdAt: new Date().toISOString(),
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
