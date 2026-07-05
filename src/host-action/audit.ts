import crypto from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
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

  protected resumeFrom(record: Pick<HostActionAuditRecord, "seq" | "event_hash">): void {
    this.seq = record.seq;
    this.previousHash = record.event_hash;
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
  private readonly filePath: string;
  private initialized = false;

  constructor(input: { readonly filePath: string; readonly now?: () => Date }) {
    const filePath = input.filePath;
    super({
      now: input.now,
      durableFlush: async (record) => {
        await mkdir(path.dirname(filePath), { recursive: true });
        const handle = await open(filePath, "a");
        try {
          await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
      },
    });
    this.filePath = filePath;
  }

  override async appendBeforeExecute(payload: HostActionAuditDecisionEvent): Promise<HostActionAuditRecord> {
    await this.initializeFromFile();
    return super.appendBeforeExecute(payload);
  }

  override async appendOutcome(payload: HostActionAuditOutcomeEvent): Promise<HostActionAuditRecord> {
    await this.initializeFromFile();
    return super.appendOutcome(payload);
  }

  private async initializeFromFile(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch {
      return;
    }

    const lastLine = text.trim().split("\n").filter(Boolean).at(-1);
    if (!lastLine) return;
    try {
      const record = JSON.parse(lastLine) as Partial<HostActionAuditRecord>;
      if (Number.isInteger(record.seq) && typeof record.event_hash === "string" && /^[0-9a-f]{64}$/.test(record.event_hash)) {
        this.resumeFrom({ seq: Number(record.seq), event_hash: record.event_hash });
      }
    } catch {
      return;
    }
  }
}
