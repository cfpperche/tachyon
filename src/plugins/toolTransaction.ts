/**
 * spec 265 task 10a — the crash-safe TRANSACTION JOURNAL (task-0 gate (c)).
 *
 * A tool-provisioning run is one transaction under `.tachyon/transactions/<txid>/`:
 *   meta.json     { txid, startedAtIso, pid, ownerUid, plugin }
 *   staging/      downloaded+verified binaries land here before the atomic rename into the live store
 *   journal.jsonl append-only step log
 *
 * Rollback-on-error is in-process only. The orphaned-content-addressed-binary sweep (by physical refcount)
 * is task 10b/11.
 *
 * This module is INERT plumbing — it creates/commits/abandons transaction dirs; no provisioning or activation
 * happens here.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const TRANSACTIONS_REL = ".tachyon/transactions";

export interface TransactionMeta {
  txid: string;
  startedAtIso: string;
  pid: number;
  ownerUid: number;
  plugin: string;
}

export interface BeginOpts {
  /** the plugin this transaction provisions for. */
  plugin: string;
  /** override the random txid (tests). */
  txid?: string;
  /** override the ISO start time (tests). */
  startedAtIso?: string;
}

/** One provisioning transaction's journaled staging area. */
export class ToolTransaction {
  readonly dir: string;
  readonly meta: TransactionMeta;

  private constructor(workspaceRoot: string, meta: TransactionMeta) {
    this.dir = path.join(workspaceRoot, TRANSACTIONS_REL, meta.txid);
    this.meta = meta;
  }

  /** Create the transaction dir (0700) + meta.json + an empty staging/ + journal. */
  static begin(workspaceRoot: string, opts: BeginOpts): ToolTransaction {
    const txid = opts.txid ?? crypto.randomBytes(12).toString("hex");
    const meta: TransactionMeta = {
      txid,
      startedAtIso: opts.startedAtIso ?? new Date().toISOString(),
      pid: process.pid,
      ownerUid: process.getuid?.() ?? 0,
      plugin: opts.plugin,
    };
    const tx = new ToolTransaction(workspaceRoot, meta);
    fs.mkdirSync(path.join(tx.dir, "staging"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(tx.dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(tx.dir, "journal.jsonl"), "", { mode: 0o600 });
    return tx;
  }

  /** The private, same-filesystem staging dir (downloads land here before the atomic rename into the store). */
  stagingDir(): string {
    return path.join(this.dir, "staging");
  }

  /** Append one step record to the journal (best-effort durability for crash recovery diagnostics). */
  appendJournal(entry: Record<string, unknown>): void {
    fs.appendFileSync(path.join(this.dir, "journal.jsonl"), `${JSON.stringify(entry)}\n`);
  }

  /** Remove the whole transaction dir (commit-cleanup or rollback). */
  abandon(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}
