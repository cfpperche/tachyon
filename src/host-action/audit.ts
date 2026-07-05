import crypto from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";
import type { HostActionDecisionChain, HostActionLifecycleState } from "./types.js";

export type HostActionAuditEventKind = "decision" | "outcome";

export interface HostActionAuditDecisionEvent {
  readonly kind: "decision";
  readonly actionId: string;
  readonly action: string;
  readonly decision: HostActionDecisionChain;
  readonly allowed: boolean;
  readonly denialCode?: string;
  readonly denialReason?: string;
}

export interface HostActionAuditOutcomeEvent {
  readonly kind: "outcome";
  readonly actionId: string;
  readonly state: HostActionLifecycleState | "denied" | "failed";
  readonly code?: string;
  readonly message?: string;
  readonly receipt?: string;
}

export type HostActionAuditPayload = HostActionAuditDecisionEvent | HostActionAuditOutcomeEvent;

export interface HostActionAuditRecord {
  readonly seq: number;
  readonly timestamp: string;
  readonly previous_hash: string;
  readonly event_hash: string;
  readonly payload: HostActionAuditPayload;
}

export interface HostActionAuditSink {
  appendBeforeExecute(payload: HostActionAuditDecisionEvent): Promise<HostActionAuditRecord>;
  appendOutcome(payload: HostActionAuditOutcomeEvent): Promise<HostActionAuditRecord>;
}

export class HashChainAuditSink implements HostActionAuditSink {
  private previousHash = "0".repeat(64);
  private seq = 0;
  private readonly recordsInternal: HostActionAuditRecord[] = [];
  private readonly now: () => Date;
  private readonly durableFlush: (record: HostActionAuditRecord) => void | Promise<void>;

  constructor(input: { readonly now?: () => Date; readonly durableFlush?: (record: HostActionAuditRecord) => void | Promise<void> } = {}) {
    this.now = input.now ?? (() => new Date());
    this.durableFlush = input.durableFlush ?? (() => undefined);
  }

  get records(): readonly HostActionAuditRecord[] {
    return this.recordsInternal;
  }

  async appendBeforeExecute(payload: HostActionAuditDecisionEvent): Promise<HostActionAuditRecord> {
    return this.append(payload);
  }

  async appendOutcome(payload: HostActionAuditOutcomeEvent): Promise<HostActionAuditRecord> {
    return this.append(payload);
  }

  private async append(payload: HostActionAuditPayload): Promise<HostActionAuditRecord> {
    const seq = this.seq + 1;
    const base = {
      seq,
      timestamp: this.now().toISOString(),
      previous_hash: this.previousHash,
      payload,
    };
    const event_hash = crypto.createHash("sha256").update(JSON.stringify(base), "utf8").digest("hex");
    const record: HostActionAuditRecord = { ...base, event_hash };
    this.recordsInternal.push(record);
    await this.durableFlush(record);
    this.seq = seq;
    this.previousHash = event_hash;
    return record;
  }
}

export class FileHashChainAuditSink extends HashChainAuditSink {
  constructor(input: { readonly filePath: string; readonly now?: () => Date }) {
    super({
      now: input.now,
      durableFlush: async (record) => {
        await mkdir(path.dirname(input.filePath), { recursive: true });
        const handle = await open(input.filePath, "a");
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
      },
    });
  }
}
