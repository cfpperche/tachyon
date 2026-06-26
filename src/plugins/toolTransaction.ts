/**
 * spec 265 task 10a — the crash-safe TRANSACTION JOURNAL + startup GC (task-0 gate (c)).
 *
 * A tool-provisioning run is one transaction under `.tachyon/transactions/<txid>/`:
 *   meta.json     { txid, startedAtIso, pid, ownerUid, plugin }
 *   staging/      downloaded+verified binaries land here before the atomic rename into the live store
 *   journal.jsonl append-only step log
 *
 * "Rollback-on-error" (in-process) is backed by "recover-on-restart": `gcAbandonedTransactions` reclaims any
 * transaction dir owned by the running uid whose meta is missing/corrupt or older than a TTL, plus stale
 * `*.staging-*` temp. The orphaned-content-addressed-binary sweep (by physical refcount) is task 10b/11.
 *
 * This module is INERT plumbing — it creates/commits/abandons + GCs transaction dirs; no provisioning or
 * activation happens here.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const TRANSACTIONS_REL = ".tachyon/transactions";
export const DEFAULT_TX_TTL_MS = 24 * 60 * 60 * 1000; // 24h

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

function readMeta(dir: string): TransactionMeta | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as TransactionMeta;
    if (typeof m.txid === "string" && typeof m.startedAtIso === "string" && typeof m.ownerUid === "number") return m;
  } catch {
    /* missing/corrupt → reclaimable */
  }
  return null;
}

export interface GcOpts {
  /** current time in ms (default Date.now()). */
  nowMs?: number;
  ttlMs?: number;
  /** the running uid (default process uid) — only reclaim OUR own transactions. */
  uid?: number;
}

/**
 * Startup GC: reclaim abandoned transaction dirs owned by the running uid whose meta is missing/corrupt OR
 * older than the TTL. Also sweeps stale `*.staging-*` temp dirs alongside. Never throws; returns what it removed.
 */
export function gcAbandonedTransactions(workspaceRoot: string, opts: GcOpts = {}): { reclaimed: string[] } {
  const now = opts.nowMs ?? Date.now();
  const ttl = opts.ttlMs ?? DEFAULT_TX_TTL_MS;
  const uid = opts.uid ?? process.getuid?.() ?? 0;
  const root = path.join(workspaceRoot, TRANSACTIONS_REL);
  const reclaimed: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { reclaimed }; // no transactions dir → nothing to do
  }
  for (const ent of entries) {
    const full = path.join(root, ent.name);
    // stale temp/staging litter — sweep under the same owner guard.
    if (ent.name.includes(".staging-")) {
      if (ownedByUid(full, uid)) {
        fs.rmSync(full, { recursive: true, force: true });
        reclaimed.push(full);
      }
      continue;
    }
    if (!ent.isDirectory()) continue;
    const meta = readMeta(full);
    if (!ownedByUid(full, uid)) continue; // never touch another user's dir
    const stale = !meta || now - Date.parse(meta.startedAtIso) > ttl;
    if (stale) {
      fs.rmSync(full, { recursive: true, force: true });
      reclaimed.push(full);
    }
  }
  return { reclaimed };
}

function ownedByUid(p: string, uid: number): boolean {
  try {
    return fs.lstatSync(p).uid === uid;
  } catch {
    return false;
  }
}
