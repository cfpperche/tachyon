import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";

export type LegacyDeliveryRetirementEntryKind =
  | "delegation-metadata"
  | "delivery-json-store"
  | "git-delivery-row"
  | "git-delivery-mirror";

export interface LegacyDeliveryRetirementRow {
  id: string;
  branchRef: string;
  worktreePath: string;
  active: number;
  recordJson: string;
}

export interface LegacyDeliveryRetirementEntry {
  kind: LegacyDeliveryRetirementEntryKind;
  entryType: "file" | "directory";
  /** Workspace-relative source path, or the SQLite database path for a row. */
  source: string;
  /** Archive-relative destination. */
  archivePath: string;
  bytes: number;
  sha256: string;
  row?: LegacyDeliveryRetirementRow;
}

export interface LegacyDeliveryRetirementPreservedRow {
  id: string;
  sha256: string;
}

export interface LegacyDeliveryRetirementPreview {
  schemaVersion: 1;
  workspaceRoot: string;
  createdAt: string;
  archiveId: string;
  snapshotDigest: string;
  preservedDigest: string;
  recoveryPending: boolean;
  entries: LegacyDeliveryRetirementEntry[];
  preserved: {
    deliveries: LegacyDeliveryRetirementPreservedRow[];
    linkedGitDeliveries: LegacyDeliveryRetirementPreservedRow[];
  };
  counts: {
    delegationEntries: number;
    deliveryJsonEntries: number;
    unlinkedGitDeliveryRows: number;
    gitDeliveryMirrorEntries: number;
    canonicalDeliveries: number;
    linkedGitDeliveries: number;
  };
}

export interface LegacyDeliveryRetirementReceipt {
  schemaVersion: 1;
  snapshotDigest: string;
  archiveId: string;
  archivePath: string;
  completedAt: string;
  counts: LegacyDeliveryRetirementPreview["counts"];
}

type RetirementPhase = "archived" | "database-removed" | "files-removed" | "complete";

interface RetirementState {
  schemaVersion: 1;
  phase: RetirementPhase;
  preview: LegacyDeliveryRetirementPreview;
  archivePath: string;
  updatedAt: string;
}

type SqliteDatabase = import("node:sqlite").DatabaseSync;
type SqliteConstructor = new (
  location: string,
  options?: { readOnly?: boolean; timeout?: number },
) => SqliteDatabase;

export type LegacyDeliveryRetirementErrorCode =
  | "LEGACY_DELIVERY_STATE_REQUIRES_RETIREMENT"
  | "LEGACY_DELIVERY_RETIREMENT_BUSY"
  | "LEGACY_DELIVERY_RETIREMENT_CHANGED"
  | "LEGACY_DELIVERY_RETIREMENT_CORRUPT"
  | "LEGACY_DELIVERY_RETIREMENT_NOTHING_TO_DO";

export class LegacyDeliveryRetirementError extends Error {
  constructor(
    readonly code: LegacyDeliveryRetirementErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LegacyDeliveryRetirementError";
  }
}

export interface LegacyDeliveryRetirementOptions {
  now?: () => string;
  /** Test-only crash seam. Runs after a durable phase transition. */
  afterPhase?: (phase: RetirementPhase) => void;
}

interface ScanResult {
  entries: LegacyDeliveryRetirementEntry[];
  preserved: LegacyDeliveryRetirementPreview["preserved"];
  counts: LegacyDeliveryRetirementPreview["counts"];
  snapshotDigest: string;
  preservedDigest: string;
}

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");

/**
 * Explicit, metadata-only retirement boundary for the pre-Delivery lifecycle.
 *
 * This class deliberately has no Git executor. Its only mutable domain is the legacy metadata
 * enumerated in a fingerprint-bound preview. Branches, commits, indexes and worktrees are outside
 * its authority by construction.
 */
export class LegacyDeliveryRetirement {
  readonly workspaceRoot: string;
  readonly tachyonRoot: string;
  readonly archiveRoot: string;
  readonly receiptHistoryRoot: string;
  readonly statePath: string;
  readonly receiptPath: string;
  readonly lockPath: string;
  private readonly Database: SqliteConstructor;

  constructor(workspaceRoot: string, private readonly opts: LegacyDeliveryRetirementOptions = {}) {
    this.workspaceRoot = fs.realpathSync(path.resolve(workspaceRoot));
    this.tachyonRoot = path.join(this.workspaceRoot, ".tachyon");
    this.archiveRoot = path.join(this.tachyonRoot, "legacy-delivery-archives");
    this.receiptHistoryRoot = path.join(this.tachyonRoot, "legacy-delivery-retirement-receipts");
    this.statePath = path.join(this.tachyonRoot, "legacy-delivery-retirement-state.json");
    this.receiptPath = path.join(this.tachyonRoot, "legacy-delivery-retirement-receipt.json");
    this.lockPath = path.join(this.tachyonRoot, "legacy-delivery-retirement.lock");
    this.Database = loadDatabaseSync();
  }

  preview(): LegacyDeliveryRetirementPreview {
    const state = this.readState();
    if (state && state.phase !== "complete") {
      return { ...structuredClone(state.preview), recoveryPending: true };
    }
    const scan = this.scan();
    const createdAt = this.now();
    return {
      schemaVersion: 1,
      workspaceRoot: this.workspaceRoot,
      createdAt,
      archiveId: this.nextArchiveId(scan.snapshotDigest),
      snapshotDigest: scan.snapshotDigest,
      preservedDigest: scan.preservedDigest,
      recoveryPending: false,
      entries: scan.entries,
      preserved: scan.preserved,
      counts: scan.counts,
    };
  }

  readReceipt(): LegacyDeliveryRetirementReceipt | undefined {
    this.resolveWorkspacePath(".tachyon/legacy-delivery-retirement-receipt.json");
    if (!fs.existsSync(this.receiptPath)) return undefined;
    return parseReceipt(readJsonFile(this.receiptPath, "retirement receipt"));
  }

  assertRetired(): void {
    const state = this.readState();
    const scan = this.scan();
    if (scan.entries.length === 0 && (!state || state.phase === "complete")) return;
    throw new LegacyDeliveryRetirementError(
      "LEGACY_DELIVERY_STATE_REQUIRES_RETIREMENT",
      "LEGACY_DELIVERY_STATE_REQUIRES_RETIREMENT: legacy Delivery metadata is active; run Tachyon: Retire Legacy Delivery State and review its preview before tracked Delivery work",
    );
  }

  apply(preview: LegacyDeliveryRetirementPreview): LegacyDeliveryRetirementReceipt {
    this.validatePreview(preview);
    const release = this.acquireLock();
    try {
      const storedState = this.readState();
      if (storedState && storedState.phase !== "complete") {
        if (storedState.preview.snapshotDigest !== preview.snapshotDigest
          || storedState.preview.archiveId !== preview.archiveId) {
          throw changed("another retirement snapshot is already in progress");
        }
        preview = storedState.preview;
      }

      const existingReceipt = this.readReceipt();
      if (existingReceipt) {
        const completedPreview = this.verifyCompletedReceipt(existingReceipt);
        this.writeReceiptHistory(existingReceipt);
        if (storedState?.phase === "complete"
          && (storedState.preview.snapshotDigest !== completedPreview.snapshotDigest
            || storedState.preview.archiveId !== completedPreview.archiveId
            || storedState.archivePath !== existingReceipt.archivePath)) {
          throw corrupt("completed retirement state and receipt disagree");
        }

        if (existingReceipt.snapshotDigest === preview.snapshotDigest
          && existingReceipt.archiveId === preview.archiveId) {
          const finalScan = this.scan();
          if (finalScan.entries.length !== 0) {
            throw changed("legacy metadata exists after the recorded retirement completed");
          }
          if (finalScan.preservedDigest !== preview.preservedDigest) {
            throw changed("canonical Delivery or linked GitDelivery state changed after retirement completed");
          }
          if (storedState?.phase !== "complete") {
            const completedState = storedState ?? {
              schemaVersion: 1 as const,
              phase: "complete" as const,
              preview,
              archivePath: existingReceipt.archivePath,
              updatedAt: existingReceipt.completedAt,
            };
            if (completedState.preview.snapshotDigest !== preview.snapshotDigest
              || completedState.archivePath !== existingReceipt.archivePath) {
              throw changed("retirement receipt and recovery state disagree");
            }
            this.writeState({ ...completedState, phase: "complete", updatedAt: existingReceipt.completedAt });
          }
          return existingReceipt;
        }
      } else if (storedState?.phase === "complete") {
        throw corrupt("completed retirement state has no receipt");
      }

      // A completed state belongs to the previous generation. Its archive and receipt were
      // verified above; a downgrade may have recreated legacy metadata, so start a new generation.
      let state = storedState?.phase === "complete" ? undefined : storedState;
      if (state) {
        if (state.preview.snapshotDigest !== preview.snapshotDigest || state.preview.archiveId !== preview.archiveId) {
          throw changed("another retirement snapshot is already in progress");
        }
        preview = state.preview;
      } else {
        if (preview.entries.length === 0) {
          throw new LegacyDeliveryRetirementError(
            "LEGACY_DELIVERY_RETIREMENT_NOTHING_TO_DO",
            "no active legacy Delivery metadata was found",
          );
        }
        this.assertCurrentSnapshot(preview);
        const archivePath = this.createArchive(preview);
        state = this.writeState({ schemaVersion: 1, phase: "archived", preview, archivePath, updatedAt: this.now() });
        this.opts.afterPhase?.("archived");
      }

      this.verifyArchive(state.archivePath, preview);

      if (phaseBefore(state.phase, "database-removed")) {
        this.removeUnlinkedRows(preview);
        state = this.writeState({ ...state, phase: "database-removed", updatedAt: this.now() });
        this.opts.afterPhase?.("database-removed");
      }

      if (phaseBefore(state.phase, "files-removed")) {
        this.removeArchivedFiles(preview);
        state = this.writeState({ ...state, phase: "files-removed", updatedAt: this.now() });
        this.opts.afterPhase?.("files-removed");
      }

      const finalScan = this.scan();
      if (finalScan.entries.length !== 0) {
        throw changed("legacy metadata reappeared while retirement was completing");
      }
      if (finalScan.preservedDigest !== preview.preservedDigest) {
        throw changed("canonical Delivery or linked GitDelivery state changed during retirement");
      }

      const receipt: LegacyDeliveryRetirementReceipt = {
        schemaVersion: 1,
        snapshotDigest: preview.snapshotDigest,
        archiveId: preview.archiveId,
        archivePath: state.archivePath,
        completedAt: this.now(),
        counts: preview.counts,
      };
      writeJsonAtomic(this.receiptPath, receipt);
      this.writeReceiptHistory(receipt);
      this.writeState({ ...state, phase: "complete", updatedAt: receipt.completedAt });
      this.opts.afterPhase?.("complete");
      return receipt;
    } finally {
      release();
    }
  }

  private nextArchiveId(snapshotDigest: string): string {
    const base = `legacy-${snapshotDigest}`;
    let candidate = base;
    let generation = 2;
    while (fs.existsSync(path.join(this.archiveRoot, candidate))) candidate = `${base}-${generation++}`;
    return candidate;
  }

  private verifyCompletedReceipt(receipt: LegacyDeliveryRetirementReceipt): LegacyDeliveryRetirementPreview {
    const expectedArchivePath = path.join(this.archiveRoot, receipt.archiveId);
    if (receipt.archivePath !== expectedArchivePath || path.dirname(expectedArchivePath) !== this.archiveRoot) {
      throw corrupt("retirement receipt archive path is not canonical");
    }
    assertNoSymlinkComponents(this.workspaceRoot, expectedArchivePath, "retirement receipt archive");
    const manifest = readJsonFile(
      path.join(expectedArchivePath, "manifest.json"),
      "retirement archive manifest",
    ) as LegacyDeliveryRetirementPreview;
    this.validatePreview(manifest);
    if (manifest.snapshotDigest !== receipt.snapshotDigest || manifest.archiveId !== receipt.archiveId
      || !isDeepStrictEqual(manifest.counts, receipt.counts)) {
      throw corrupt("retirement receipt does not match its archive manifest");
    }
    this.verifyArchive(expectedArchivePath, manifest);
    return manifest;
  }

  private writeReceiptHistory(receipt: LegacyDeliveryRetirementReceipt): void {
    this.resolveWorkspacePath(".tachyon/legacy-delivery-retirement-receipts");
    const destination = safeArchiveDestination(this.receiptHistoryRoot, `${receipt.archiveId}.json`);
    if (path.dirname(destination) !== this.receiptHistoryRoot) throw corrupt("retirement receipt history path escaped its root");
    if (fs.existsSync(destination)) {
      const existing = parseReceipt(readJsonFile(destination, "historical retirement receipt"));
      if (!isDeepStrictEqual(existing, receipt)) throw corrupt("historical retirement receipt is inconsistent");
      return;
    }
    writeJsonAtomic(destination, receipt);
  }

  private scan(): ScanResult {
    this.resolveWorkspacePath(".tachyon");
    const deliveryRows = this.readDeliveryRows();
    const gitRows = this.readGitDeliveryRows();
    const entries: LegacyDeliveryRetirementEntry[] = [];

    this.scanTree(".tachyon/delegations", "delegation-metadata", entries);
    this.scanTree(".tachyon/deliveries", "delivery-json-store", entries, (file, bytes) => {
      this.assertDeliveryJsonMatchesDatabase(file, bytes, deliveryRows);
    });
    this.scanTree(".tachyon/deliveries.migrated-v1", "delivery-json-store", entries, (file, bytes) => {
      this.assertDeliveryJsonMatchesDatabase(file, bytes, deliveryRows);
    });

    for (const row of [...gitRows.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      const parsed = parseJson(row.recordJson, `GitDelivery row '${row.id}'`) as Record<string, unknown>;
      if (typeof parsed.deliveryId === "string" && parsed.deliveryId.length > 0) continue;
      const payload = rowPayload(row);
      entries.push({
        kind: "git-delivery-row",
        entryType: "file",
        source: ".tachyon/git-deliveries-v2.sqlite3",
        archivePath: `rows/git-deliveries/${safeId(row.id)}.json`,
        bytes: payload.byteLength,
        sha256: hash(payload),
        row,
      });
    }

    this.scanTree(".tachyon/git-deliveries", "git-delivery-mirror", entries, (file, bytes) => {
      const parsed = parseJson(bytes.toString("utf8"), `GitDelivery mirror '${file}'`) as Record<string, unknown>;
      const id = typeof parsed.id === "string" ? parsed.id : undefined;
      if (!id || `${id}.json` !== path.basename(file)) {
        throw corrupt(`GitDelivery mirror '${file}' has no filename-matching id`);
      }
      const durable = gitRows.get(id);
      if (!durable) {
        if (typeof parsed.deliveryId === "string" && parsed.deliveryId.length > 0) {
          throw corrupt(`linked GitDelivery mirror '${file}' has no durable SQLite row`);
        }
        return;
      }
      const durableParsed = parseJson(durable.recordJson, `GitDelivery row '${id}'`);
      if (!isDeepStrictEqual(parsed, durableParsed)) {
        throw corrupt(`GitDelivery mirror '${file}' diverges from its durable SQLite row`);
      }
    });

    entries.sort(compareEntries);
    const preserved = {
      deliveries: [...deliveryRows.entries()].sort(([a], [b]) => a.localeCompare(b))
        .map(([id, recordJson]) => ({ id, sha256: hash(Buffer.from(recordJson)) })),
      linkedGitDeliveries: [...gitRows.values()]
        .filter((row) => {
          const record = parseJson(row.recordJson, `GitDelivery row '${row.id}'`) as Record<string, unknown>;
          return typeof record.deliveryId === "string" && record.deliveryId.length > 0;
        })
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((row) => ({ id: row.id, sha256: hash(rowPayload(row)) })),
    };
    const preservedDigest = retirementPreservedDigest(preserved);
    const snapshotDigest = retirementSnapshotDigest(entries, preserved);
    return {
      entries,
      preserved,
      preservedDigest,
      snapshotDigest,
      counts: retirementCounts(entries, preserved),
    };
  }

  private scanTree(
    relativeRoot: string,
    kind: LegacyDeliveryRetirementEntryKind,
    entries: LegacyDeliveryRetirementEntry[],
    validateFile?: (file: string, bytes: Buffer) => void,
  ): void {
    const root = this.resolveWorkspacePath(relativeRoot);
    if (!fs.existsSync(root)) return;
    const walk = (current: string): void => {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw corrupt(`refusing symlink in legacy metadata: '${current}'`);
      const relative = slash(path.relative(this.workspaceRoot, current));
      if (stat.isDirectory()) {
        entries.push({
          kind,
          entryType: "directory",
          source: relative,
          archivePath: `files/${relative}`,
          bytes: 0,
          sha256: EMPTY_SHA256,
        });
        for (const name of fs.readdirSync(current).sort()) walk(path.join(current, name));
        return;
      }
      if (!stat.isFile()) throw corrupt(`unsupported legacy metadata entry '${current}'`);
      const bytes = fs.readFileSync(current);
      validateFile?.(current, bytes);
      entries.push({
        kind,
        entryType: "file",
        source: relative,
        archivePath: `files/${relative}`,
        bytes: bytes.byteLength,
        sha256: hash(bytes),
      });
    };
    walk(root);
  }

  private readDeliveryRows(): Map<string, string> {
    const databasePath = path.join(this.tachyonRoot, "deliveries-v2.sqlite3");
    if (!fs.existsSync(databasePath)) return new Map();
    return this.withReadOnlyDatabase(databasePath, (db) => {
      if (!tableExists(db, "deliveries")) throw corrupt("Delivery database is missing the deliveries table");
      const rows = db.prepare("SELECT id, record_json FROM deliveries ORDER BY id").all() as Array<{ id: string; record_json: string }>;
      return new Map(rows.map((row) => [String(row.id), String(row.record_json)]));
    });
  }

  private readGitDeliveryRows(): Map<string, LegacyDeliveryRetirementRow> {
    const databasePath = path.join(this.tachyonRoot, "git-deliveries-v2.sqlite3");
    if (!fs.existsSync(databasePath)) return new Map();
    return this.withReadOnlyDatabase(databasePath, (db) => {
      if (!tableExists(db, "git_deliveries")) throw corrupt("GitDelivery database is missing the git_deliveries table");
      const rows = db.prepare(
        "SELECT id, branch_ref, worktree_path, active, record_json FROM git_deliveries ORDER BY id",
      ).all() as Array<{ id: string; branch_ref: string; worktree_path: string; active: number; record_json: string }>;
      return new Map(rows.map((row) => [String(row.id), {
        id: String(row.id),
        branchRef: String(row.branch_ref),
        worktreePath: String(row.worktree_path),
        active: Number(row.active),
        recordJson: String(row.record_json),
      }]));
    });
  }

  private assertDeliveryJsonMatchesDatabase(file: string, bytes: Buffer, rows: Map<string, string>): void {
    if (!file.endsWith(".json")) return;
    const parsed = parseJson(bytes.toString("utf8"), `Delivery JSON '${file}'`) as Record<string, unknown>;
    const id = typeof parsed.id === "string" ? parsed.id : undefined;
    if (!id || `${id}.json` !== path.basename(file)) throw corrupt(`Delivery JSON '${file}' has no filename-matching id`);
    const durable = rows.get(id);
    // A workspace may upgrade directly from the pre-SQLite store. Such a record is precisely
    // legacy metadata: archive it raw, but never promote it into canonical authority. When a
    // durable row does exist, require byte-equivalent JSON semantics so retirement cannot hide
    // an ambiguous second copy of a canonical Delivery.
    if (!durable) return;
    if (!isDeepStrictEqual(parsed, parseJson(durable, `Delivery row '${id}'`))) {
      throw corrupt(`Delivery JSON '${file}' diverges from its durable SQLite row`);
    }
  }

  private createArchive(preview: LegacyDeliveryRetirementPreview): string {
    this.resolveWorkspacePath(".tachyon/legacy-delivery-archives");
    fs.mkdirSync(this.archiveRoot, { recursive: true });
    this.resolveWorkspacePath(".tachyon/legacy-delivery-archives");
    const finalPath = path.join(this.archiveRoot, preview.archiveId);
    const stagingPath = path.join(this.archiveRoot, `.${preview.archiveId}.staging`);
    if (fs.existsSync(finalPath)) {
      assertNoSymlinkComponents(this.archiveRoot, finalPath, "retirement archive");
      this.verifyArchive(finalPath, preview);
      return finalPath;
    }
    fs.mkdirSync(stagingPath, { recursive: true });
    assertNoSymlinkComponents(this.archiveRoot, stagingPath, "retirement archive staging path");
    for (const entry of preview.entries) {
      const destination = safeArchiveDestination(stagingPath, entry.archivePath);
      assertNoSymlinkComponents(stagingPath, destination, "retirement archive entry");
      if (entry.entryType === "directory") {
        fs.mkdirSync(destination, { recursive: true });
        continue;
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const bytes = entry.row ? rowPayload(entry.row) : this.readAndValidateSource(entry);
      if (fs.existsSync(destination)) {
        const existing = fs.readFileSync(destination);
        if (hash(existing) !== entry.sha256 || existing.byteLength !== entry.bytes) {
          throw corrupt(`partial archive entry '${entry.archivePath}' is inconsistent`);
        }
      } else {
        writeFileDurable(destination, bytes);
      }
    }
    writeJsonAtomic(path.join(stagingPath, "manifest.json"), preview);
    fs.renameSync(stagingPath, finalPath);
    this.verifyArchive(finalPath, preview);
    return finalPath;
  }

  private verifyArchive(archivePath: string, preview: LegacyDeliveryRetirementPreview): void {
    const canonicalArchive = path.resolve(archivePath);
    if (path.dirname(canonicalArchive) !== path.resolve(this.archiveRoot)) {
      throw corrupt(`retirement archive escaped its managed root: '${archivePath}'`);
    }
    assertNoSymlinkComponents(this.workspaceRoot, canonicalArchive, "retirement archive");
    const archiveStat = fs.lstatSync(canonicalArchive);
    if (!archiveStat.isDirectory() || archiveStat.isSymbolicLink()) throw corrupt(`retirement archive '${archivePath}' is invalid`);
    const manifestPath = path.join(canonicalArchive, "manifest.json");
    const manifest = readJsonFile(manifestPath, "retirement archive manifest") as LegacyDeliveryRetirementPreview;
    if (!isDeepStrictEqual(manifest, preview)) {
      throw corrupt(`retirement archive manifest does not match snapshot '${preview.snapshotDigest}'`);
    }
    for (const entry of preview.entries) {
      const archived = safeArchiveDestination(canonicalArchive, entry.archivePath);
      assertNoSymlinkComponents(canonicalArchive, archived, "retirement archive entry");
      const stat = fs.lstatSync(archived);
      if (entry.entryType === "directory") {
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw corrupt(`archive directory '${entry.archivePath}' is invalid`);
        continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) throw corrupt(`archive file '${entry.archivePath}' is invalid`);
      const bytes = fs.readFileSync(archived);
      if (bytes.byteLength !== entry.bytes || hash(bytes) !== entry.sha256) {
        throw corrupt(`archive file '${entry.archivePath}' failed checksum verification`);
      }
    }
  }

  private removeUnlinkedRows(preview: LegacyDeliveryRetirementPreview): void {
    const rows = preview.entries.filter((entry): entry is LegacyDeliveryRetirementEntry & { row: LegacyDeliveryRetirementRow } =>
      entry.kind === "git-delivery-row" && !!entry.row);
    if (rows.length === 0) return;
    const databasePath = path.join(this.tachyonRoot, "git-deliveries-v2.sqlite3");
    if (!fs.existsSync(databasePath)) throw changed("GitDelivery database disappeared after archival");
    const db = new this.Database(databasePath, { timeout: 5000 });
    try {
      db.exec("BEGIN IMMEDIATE");
      for (const entry of rows) {
        const row = db.prepare(
          "SELECT id, branch_ref, worktree_path, active, record_json FROM git_deliveries WHERE id = ?",
        ).get(entry.row.id) as { id: string; branch_ref: string; worktree_path: string; active: number; record_json: string } | undefined;
        if (!row) continue; // Safe replay after a commit-before-state-write crash.
        const current: LegacyDeliveryRetirementRow = {
          id: String(row.id),
          branchRef: String(row.branch_ref),
          worktreePath: String(row.worktree_path),
          active: Number(row.active),
          recordJson: String(row.record_json),
        };
        if (!isDeepStrictEqual(current, entry.row)) throw changed(`GitDelivery row '${entry.row.id}' changed after preview`);
        const result = db.prepare(
          "DELETE FROM git_deliveries WHERE id = ? AND branch_ref = ? AND worktree_path = ? AND active = ? AND record_json = ?",
        ).run(current.id, current.branchRef, current.worktreePath, current.active, current.recordJson);
        if (Number(result.changes) !== 1) throw changed(`GitDelivery row '${entry.row.id}' could not be removed exactly`);
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    } finally {
      db.close();
    }
  }

  private removeArchivedFiles(preview: LegacyDeliveryRetirementPreview): void {
    const files = preview.entries.filter((entry) => entry.entryType === "file" && !entry.row);
    for (const entry of files) {
      const source = this.resolveWorkspacePath(entry.source);
      if (!fs.existsSync(source)) continue; // Safe replay after an unlink-before-state-write crash.
      const bytes = this.readAndValidateSource(entry);
      if (bytes.byteLength !== entry.bytes || hash(bytes) !== entry.sha256) {
        throw changed(`legacy metadata '${entry.source}' changed after archival`);
      }
      fs.unlinkSync(source);
    }
    const directories = preview.entries.filter((entry) => entry.entryType === "directory")
      .sort((a, b) => b.source.length - a.source.length);
    for (const entry of directories) {
      const source = this.resolveWorkspacePath(entry.source);
      if (!fs.existsSync(source)) continue;
      const stat = fs.lstatSync(source);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw changed(`legacy directory '${entry.source}' changed type`);
      try {
        fs.rmdirSync(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY") {
          throw changed(`legacy directory '${entry.source}' gained an unreviewed entry`);
        }
        throw error;
      }
    }
  }

  private readAndValidateSource(entry: LegacyDeliveryRetirementEntry): Buffer {
    const source = this.resolveWorkspacePath(entry.source);
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw changed(`legacy metadata '${entry.source}' changed type`);
    const bytes = fs.readFileSync(source);
    if (bytes.byteLength !== entry.bytes || hash(bytes) !== entry.sha256) {
      throw changed(`legacy metadata '${entry.source}' changed after preview`);
    }
    return bytes;
  }

  private assertCurrentSnapshot(preview: LegacyDeliveryRetirementPreview): void {
    const current = this.scan();
    if (current.snapshotDigest !== preview.snapshotDigest) {
      throw changed("legacy or canonical metadata changed after preview; generate and review a new preview");
    }
  }

  private validatePreview(preview: LegacyDeliveryRetirementPreview): void {
    if (!preview || preview.schemaVersion !== 1 || preview.workspaceRoot !== this.workspaceRoot
      || typeof preview.createdAt !== "string" || typeof preview.archiveId !== "string"
      || !isSha256(preview.snapshotDigest) || !isSha256(preview.preservedDigest)
      || typeof preview.recoveryPending !== "boolean" || !Array.isArray(preview.entries)
      || !preview.preserved || !Array.isArray(preview.preserved.deliveries)
      || !Array.isArray(preview.preserved.linkedGitDeliveries) || !preview.counts) {
      throw corrupt("invalid legacy Delivery retirement preview");
    }
    const archiveBases = [
      `legacy-${preview.snapshotDigest}`,
      // Accept receipts written by the pre-release timestamp scheme so a dogfood rollback can recover.
      `${archiveTimestamp(preview.createdAt)}-${preview.snapshotDigest.slice(0, 12)}`,
    ];
    if (!archiveBases.some((base) => preview.archiveId === base
      || new RegExp(`^${escapeRegExp(base)}-[2-9][0-9]*$`).test(preview.archiveId))) {
      throw corrupt("retirement archive id is not bound to its snapshot digest");
    }
    const archivePaths = new Set<string>();
    for (const entry of preview.entries) {
      validateRetirementEntry(entry);
      if (archivePaths.has(entry.archivePath)) throw corrupt(`duplicate retirement archive path '${entry.archivePath}'`);
      archivePaths.add(entry.archivePath);
    }
    validatePreservedRows(preview.preserved.deliveries, "Delivery");
    validatePreservedRows(preview.preserved.linkedGitDeliveries, "linked GitDelivery");
    if (retirementPreservedDigest(preview.preserved) !== preview.preservedDigest) {
      throw corrupt("retirement preserved-state digest does not match its inventory");
    }
    if (retirementSnapshotDigest(preview.entries, preview.preserved) !== preview.snapshotDigest) {
      throw corrupt("retirement snapshot digest does not match its inventory");
    }
    if (!isDeepStrictEqual(retirementCounts(preview.entries, preview.preserved), preview.counts)) {
      throw corrupt("retirement counts do not match the inventory");
    }
  }

  private readState(): RetirementState | undefined {
    this.resolveWorkspacePath(".tachyon/legacy-delivery-retirement-state.json");
    if (!fs.existsSync(this.statePath)) return undefined;
    const value = readJsonFile(this.statePath, "retirement state") as RetirementState;
    if (!value || value.schemaVersion !== 1 || !["archived", "database-removed", "files-removed", "complete"].includes(value.phase)
      || !value.preview || typeof value.archivePath !== "string") {
      throw corrupt("invalid legacy Delivery retirement state");
    }
    this.validatePreview(value.preview);
    if (value.archivePath !== path.join(this.archiveRoot, value.preview.archiveId)) {
      throw corrupt("retirement state archive path is not canonical");
    }
    return value;
  }

  private writeState(state: RetirementState): RetirementState {
    this.resolveWorkspacePath(".tachyon/legacy-delivery-retirement-state.json");
    writeJsonAtomic(this.statePath, state);
    return state;
  }

  private acquireLock(): () => void {
    this.resolveWorkspacePath(".tachyon");
    fs.mkdirSync(this.tachyonRoot, { recursive: true });
    this.resolveWorkspacePath(".tachyon/legacy-delivery-retirement.lock");
    const token = randomUUID();
    const owner = { pid: process.pid, token, createdAt: this.now() };
    const tryAcquire = (): boolean => {
      const stagedOwner = path.join(this.tachyonRoot, `.legacy-delivery-retirement-lock.${process.pid}.${token}.tmp`);
      try {
        writeFileDurable(stagedOwner, Buffer.from(`${JSON.stringify(owner)}\n`));
        // A hard link publishes a fully-written owner atomically and refuses to replace an
        // existing lock. No process can observe an ownerless lock created by this version.
        fs.linkSync(stagedOwner, this.lockPath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        return false;
      } finally {
        try { fs.unlinkSync(stagedOwner); } catch {}
      }
    };
    if (!tryAcquire()) {
      let existing: { pid?: number; token?: string; reclaimable?: boolean } | undefined;
      try { existing = this.readLockOwner(); }
      catch {
        throw new LegacyDeliveryRetirementError("LEGACY_DELIVERY_RETIREMENT_BUSY", "retirement lock owner is unreadable");
      }
      if (!existing?.reclaimable
        && (!Number.isInteger(existing?.pid) || existing!.pid! <= 0 || processAlive(existing!.pid!))) {
        throw new LegacyDeliveryRetirementError("LEGACY_DELIVERY_RETIREMENT_BUSY", "another legacy Delivery retirement is active");
      }
      fs.rmSync(this.lockPath, { recursive: true, force: true });
      if (!tryAcquire()) throw new LegacyDeliveryRetirementError("LEGACY_DELIVERY_RETIREMENT_BUSY", "retirement lock was reacquired concurrently");
    }
    return () => {
      try {
        const current = this.readLockOwner();
        if (current?.pid === process.pid && current.token === token) fs.unlinkSync(this.lockPath);
      } catch {}
    };
  }

  private readLockOwner(): { pid?: number; token?: string; reclaimable?: boolean } | undefined {
    const stat = fs.lstatSync(this.lockPath);
    if (stat.isSymbolicLink()) return undefined;
    if (stat.isFile()) {
      return readJsonFile(this.lockPath, "retirement lock owner") as { pid: number; token?: string };
    }
    if (!stat.isDirectory()) return undefined;
    const ownerPath = path.join(this.lockPath, "owner.json");
    if (fs.existsSync(ownerPath)) {
      return readJsonFile(ownerPath, "retirement lock owner") as { pid: number; token?: string };
    }
    // Older versions could crash between mkdir(lock) and owner.json. Only reclaim a directory
    // that stayed empty beyond the publication grace period; a fresh one may still be in flight.
    if (fs.readdirSync(this.lockPath).length === 0 && Date.now() - stat.mtimeMs >= 30_000) {
      return { reclaimable: true };
    }
    return undefined;
  }

  private resolveWorkspacePath(relative: string): string {
    const resolved = path.resolve(this.workspaceRoot, relative);
    if (resolved !== this.workspaceRoot && !resolved.startsWith(`${this.workspaceRoot}${path.sep}`)) {
      throw corrupt(`metadata path escaped workspace: '${relative}'`);
    }
    assertNoSymlinkComponents(this.workspaceRoot, resolved, "legacy metadata path");
    return resolved;
  }

  private withReadOnlyDatabase<T>(databasePath: string, fn: (db: SqliteDatabase) => T): T {
    // SQLite WAL readers may materialize `-shm` beside the source even with readOnly=true. A preview
    // promises zero workspace mutation, so inspect an exact, stability-checked copy outside the repo.
    const sourcePaths = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
    const before = sourcePaths.map((file) => snapshotOptionalFile(file));
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-delivery-retirement-db-"));
    const copyPath = path.join(scratch, path.basename(databasePath));
    try {
      for (let index = 0; index < sourcePaths.length; index++) {
        const snapshot = before[index];
        if (!snapshot) continue;
        fs.writeFileSync(index === 0 ? copyPath : `${copyPath}${sourcePaths[index]!.slice(databasePath.length)}`, snapshot.bytes);
      }
      const after = sourcePaths.map((file) => snapshotOptionalFile(file));
      if (!isDeepStrictEqual(before.map(snapshotIdentity), after.map(snapshotIdentity))) {
        throw changed(`database '${databasePath}' changed while its retirement snapshot was copied`);
      }
      const db = new this.Database(copyPath, { readOnly: true, timeout: 5000 });
      try { return fn(db); }
      finally { db.close(); }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  private now(): string { return this.opts.now?.() ?? new Date().toISOString(); }
}

function loadDatabaseSync(): SqliteConstructor {
  const require = createRequire(path.join(process.cwd(), "tachyon-legacy-delivery-retirement-loader.cjs"));
  const sqlite = require("node:sqlite") as { DatabaseSync?: SqliteConstructor };
  if (typeof sqlite.DatabaseSync !== "function") throw corrupt("node:sqlite DatabaseSync is unavailable");
  return sqlite.DatabaseSync;
}

function tableExists(db: SqliteDatabase, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name);
}

function rowPayload(row: LegacyDeliveryRetirementRow): Buffer {
  return Buffer.from(`${JSON.stringify({
    id: row.id,
    branchRef: row.branchRef,
    worktreePath: row.worktreePath,
    active: row.active,
    recordJson: row.recordJson,
  }, null, 2)}\n`);
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  writeFileDurable(tmp, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
  fs.renameSync(tmp, file);
}

function writeFileDurable(file: string, bytes: Buffer): void {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readJsonFile(file: string, label: string): unknown {
  if (!fs.existsSync(file)) throw corrupt(`${label} '${file}' is missing`);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw corrupt(`${label} '${file}' is not a regular file`);
  return parseJson(fs.readFileSync(file, "utf8"), label);
}

function parseJson(json: string, label: string): unknown {
  try { return JSON.parse(json); }
  catch (error) { throw corrupt(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

function parseReceipt(value: unknown): LegacyDeliveryRetirementReceipt {
  const receipt = value as LegacyDeliveryRetirementReceipt;
  if (!receipt || receipt.schemaVersion !== 1 || !receipt.snapshotDigest || !receipt.archiveId
    || !receipt.archivePath || !receipt.completedAt || !receipt.counts) {
    throw corrupt("invalid legacy Delivery retirement receipt");
  }
  return receipt;
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value ?? null);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw corrupt("retirement snapshot contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw corrupt("retirement snapshot is not JSON-serializable");
}

function retirementPreservedDigest(preserved: LegacyDeliveryRetirementPreview["preserved"]): string {
  return hash(Buffer.from(canonicalJson(preserved)));
}

function retirementSnapshotDigest(
  entries: LegacyDeliveryRetirementEntry[],
  preserved: LegacyDeliveryRetirementPreview["preserved"],
): string {
  return hash(Buffer.from(canonicalJson({ entries, preserved })));
}

function retirementCounts(
  entries: LegacyDeliveryRetirementEntry[],
  preserved: LegacyDeliveryRetirementPreview["preserved"],
): LegacyDeliveryRetirementPreview["counts"] {
  return {
    delegationEntries: entries.filter((entry) => entry.kind === "delegation-metadata" && entry.entryType === "file").length,
    deliveryJsonEntries: entries.filter((entry) => entry.kind === "delivery-json-store" && entry.entryType === "file").length,
    unlinkedGitDeliveryRows: entries.filter((entry) => entry.kind === "git-delivery-row").length,
    gitDeliveryMirrorEntries: entries.filter((entry) => entry.kind === "git-delivery-mirror" && entry.entryType === "file").length,
    canonicalDeliveries: preserved.deliveries.length,
    linkedGitDeliveries: preserved.linkedGitDeliveries.length,
  };
}

function validateRetirementEntry(entry: LegacyDeliveryRetirementEntry): void {
  if (!entry || !["delegation-metadata", "delivery-json-store", "git-delivery-row", "git-delivery-mirror"].includes(entry.kind)
    || !["file", "directory"].includes(entry.entryType) || typeof entry.source !== "string"
    || typeof entry.archivePath !== "string" || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
    || !isSha256(entry.sha256)) {
    throw corrupt("invalid retirement inventory entry");
  }

  if (entry.kind === "git-delivery-row") {
    const row = entry.row;
    if (entry.entryType !== "file" || entry.source !== ".tachyon/git-deliveries-v2.sqlite3" || !row
      || typeof row.id !== "string" || row.id.length === 0 || typeof row.branchRef !== "string"
      || typeof row.worktreePath !== "string" || !Number.isSafeInteger(row.active)
      || typeof row.recordJson !== "string" || entry.archivePath !== `rows/git-deliveries/${safeId(row.id)}.json`) {
      throw corrupt("invalid unlinked GitDelivery retirement entry");
    }
    const payload = rowPayload(row);
    const record = parseJson(row.recordJson, `GitDelivery row '${row.id}'`) as Record<string, unknown>;
    if (typeof record.deliveryId === "string" && record.deliveryId.length > 0) {
      throw corrupt(`linked GitDelivery '${row.id}' cannot be retired as an unlinked row`);
    }
    if (entry.bytes !== payload.byteLength || entry.sha256 !== hash(payload)) {
      throw corrupt(`GitDelivery row '${row.id}' inventory fingerprint is invalid`);
    }
    return;
  }

  if (entry.row !== undefined) throw corrupt(`file retirement entry '${entry.source}' unexpectedly contains a database row`);
  const roots = entry.kind === "delegation-metadata"
    ? [".tachyon/delegations"]
    : entry.kind === "delivery-json-store"
      ? [".tachyon/deliveries", ".tachyon/deliveries.migrated-v1"]
      : [".tachyon/git-deliveries"];
  const sourceIsAllowed = roots.some((root) => entry.source === root || entry.source.startsWith(`${root}/`));
  if (!sourceIsAllowed || path.posix.normalize(entry.source) !== entry.source || path.posix.isAbsolute(entry.source)
    || entry.archivePath !== `files/${entry.source}`) {
    throw corrupt(`retirement entry escaped its legacy metadata root: '${entry.source}'`);
  }
  if (entry.entryType === "directory" && (entry.bytes !== 0 || entry.sha256 !== EMPTY_SHA256)) {
    throw corrupt(`retirement directory '${entry.source}' has an invalid fingerprint`);
  }
}

function validatePreservedRows(rows: LegacyDeliveryRetirementPreservedRow[], label: string): void {
  let previous = "";
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || row.id.length === 0 || !isSha256(row.sha256)
      || previous.localeCompare(row.id) >= 0) {
      throw corrupt(`invalid or unsorted preserved ${label} inventory`);
    }
    previous = row.id;
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function safeId(id: string): string { return id.replace(/[^A-Za-z0-9._-]/g, "_"); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function slash(value: string): string { return value.split(path.sep).join("/"); }
function archiveTimestamp(value: string): string { return value.replace(/[^0-9TZ-]/g, "-"); }
function compareEntries(a: LegacyDeliveryRetirementEntry, b: LegacyDeliveryRetirementEntry): number {
  return a.archivePath.localeCompare(b.archivePath) || a.entryType.localeCompare(b.entryType);
}

function safeArchiveDestination(root: string, relative: string): string {
  const destination = path.resolve(root, relative);
  const canonicalRoot = path.resolve(root);
  if (!destination.startsWith(`${canonicalRoot}${path.sep}`)) throw corrupt(`archive path escaped root: '${relative}'`);
  return destination;
}

function assertNoSymlinkComponents(root: string, target: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw corrupt(`${label} escaped its managed root: '${target}'`);
  }
  let current = path.resolve(root);
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (!fs.existsSync(current)) return;
    if (fs.lstatSync(current).isSymbolicLink()) throw corrupt(`${label} contains a symlink: '${current}'`);
  }
}

const PHASE_ORDER: RetirementPhase[] = ["archived", "database-removed", "files-removed", "complete"];
function phaseBefore(current: RetirementPhase, target: RetirementPhase): boolean {
  return PHASE_ORDER.indexOf(current) < PHASE_ORDER.indexOf(target);
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

interface OptionalFileSnapshot {
  bytes: Buffer;
  sha256: string;
  size: number;
}

function snapshotOptionalFile(file: string): OptionalFileSnapshot | undefined {
  if (!fs.existsSync(file)) return undefined;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw corrupt(`database sidecar '${file}' is not a regular file`);
  const bytes = fs.readFileSync(file);
  return { bytes, sha256: hash(bytes), size: bytes.byteLength };
}

function snapshotIdentity(snapshot: OptionalFileSnapshot | undefined): { sha256: string; size: number } | undefined {
  return snapshot ? { sha256: snapshot.sha256, size: snapshot.size } : undefined;
}

function corrupt(message: string): LegacyDeliveryRetirementError {
  return new LegacyDeliveryRetirementError("LEGACY_DELIVERY_RETIREMENT_CORRUPT", message);
}

function changed(message: string): LegacyDeliveryRetirementError {
  return new LegacyDeliveryRetirementError("LEGACY_DELIVERY_RETIREMENT_CHANGED", message);
}
