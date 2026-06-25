/**
 * spec 264 — the managed git-hook store under `.tachyon/githooks/` (Tachyon-OWNED; gitignored, reconstructable
 * from the lockfile via repair). Pure I/O primitives the engine composes; the generated dispatcher (task 4)
 * consumes the published snapshot.
 *
 * Layout:
 *   .tachyon/githooks/
 *     leaves/<contentHash>      content-addressed leaf scripts (0755) — a copied payload script, a captured
 *                               prior user hook, or a generated argv wrapper. Immutable by content address.
 *     registry.json             the IMMUTABLE registry snapshot (per-event leaves + captured prior hook +
 *                               a generation + a self-integrity hash); atomically published, never references
 *                               a missing leaf.
 *     ownership.json            repo-level ownership of core.hooksPath: { claimedFrom, managedPath, leafRefs
 *                               across ALL events, generation }.
 *     .lock/                    an mkdir-based advisory repo lock for install/remove.
 *
 * Fail-closed: a corrupt registry/ownership is an ERROR, never a silent "empty" (which would disable a gate).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const GITHOOKS_REL = ".tachyon/githooks";
const LEAVES_SUBDIR = "leaves";
const REGISTRY_FILE = "registry.json";
const OWNERSHIP_FILE = "ownership.json";
const LOCK_SUBDIR = ".lock";
const LOCK_STALE_MS = 60_000;

export class GitHookStoreError extends Error {}

/** One registered leaf in an event's chain. `contentHash` names its `leaves/<hash>` file. */
export interface RegistryLeaf {
  pluginId: string;
  contentHash: string;
  /** present when the leaf is an argv vector (the leaf file is a generated wrapper) — kept for audit/consent. */
  argv?: string[];
}

/** A captured prior user hook the dispatcher chains to FIRST. Its content is stored as a leaf too. */
export interface PriorHook {
  contentHash: string;
  /** identity bound into the consent fingerprint. */
  origin: { path: string; mode: number; type: "file" | "symlink"; symlinkTarget?: string };
}

export interface EventEntry {
  priorHook: PriorHook | null;
  /** registered leaves, sorted by canonical pluginId (deterministic dispatcher order). */
  leaves: RegistryLeaf[];
}

export interface RegistrySnapshot {
  schema: 1;
  generation: number;
  events: Record<string, EventEntry>;
  /** sha256 over the canonical {generation, events} — the dispatcher self-validates this. */
  integrity: string;
}

export interface OwnershipRecord {
  schema: 1;
  /** the prior core.hooksPath raw value Tachyon replaced (null = none was set). */
  claimedFrom: string | null;
  /** the value Tachyon set core.hooksPath to (workspace-relative, e.g. `.tachyon/githooks`). */
  managedPath: string;
  /** count of registered leaves across ALL events — restore core.hooksPath only when this hits 0. */
  leafRefs: number;
  generation: number;
}

/** Recursively key-sorted JSON for a stable integrity hash. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function snapshotIntegrity(generation: number, events: Record<string, EventEntry>): string {
  return crypto.createHash("sha256").update(canonical({ generation, events })).digest("hex");
}

function atomicWrite(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, content, mode !== undefined ? { mode } : undefined);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }
    throw e;
  }
}

export class GitHookStore {
  constructor(private readonly workspaceRoot: string) {}

  dir(): string { return path.join(this.workspaceRoot, GITHOOKS_REL); }
  private leavesDir(): string { return path.join(this.dir(), LEAVES_SUBDIR); }
  leafFile(contentHash: string): string { return path.join(this.leavesDir(), contentHash); }
  hasLeaf(contentHash: string): boolean { return fs.existsSync(this.leafFile(contentHash)); }

  /** Store a leaf by content address (0755), idempotent. Returns the content hash. */
  putLeaf(content: Buffer | string): string {
    const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const hash = crypto.createHash("sha256").update(buf).digest("hex");
    const file = this.leafFile(hash);
    if (fs.existsSync(file)) return hash; // content-addressed → identical content already present
    fs.mkdirSync(this.leavesDir(), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    try {
      fs.writeFileSync(tmp, buf, { mode: 0o755 });
      try { fs.renameSync(tmp, file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST" && fs.existsSync(file) === false) throw e; }
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    return hash;
  }

  /** Delete a leaf (caller has confirmed it is unreferenced). ENOENT is a no-op. */
  pruneLeaf(contentHash: string): void {
    fs.rmSync(this.leafFile(contentHash), { force: true });
  }

  // ── registry snapshot ──────────────────────────────────────────────────────

  /** Read + integrity-validate the snapshot. Absent → undefined; corrupt/tampered → throw (fail-closed). */
  readSnapshot(): RegistrySnapshot | undefined {
    let text: string;
    try {
      text = fs.readFileSync(path.join(this.dir(), REGISTRY_FILE), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new GitHookStoreError(`reading ${REGISTRY_FILE}: ${(e as Error).message}`);
    }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new GitHookStoreError(`${REGISTRY_FILE}: invalid JSON`); }
    const snap = raw as RegistrySnapshot;
    if (!snap || snap.schema !== 1 || typeof snap.generation !== "number" || typeof snap.events !== "object" || snap.events === null) {
      throw new GitHookStoreError(`${REGISTRY_FILE}: malformed snapshot`);
    }
    if (snapshotIntegrity(snap.generation, snap.events) !== snap.integrity) {
      throw new GitHookStoreError(`${REGISTRY_FILE}: integrity mismatch — registry was tampered`);
    }
    // never reference a missing leaf — a snapshot pointing at an absent leaf is corruption.
    for (const entry of Object.values(snap.events)) {
      for (const leaf of entry.leaves) if (!this.hasLeaf(leaf.contentHash)) throw new GitHookStoreError(`${REGISTRY_FILE}: references missing leaf ${leaf.contentHash}`);
      if (entry.priorHook && !this.hasLeaf(entry.priorHook.contentHash)) throw new GitHookStoreError(`${REGISTRY_FILE}: references missing prior-hook ${entry.priorHook.contentHash}`);
    }
    return snap;
  }

  /** Atomically publish a snapshot (stamps the integrity hash). Caller must hold the lock + have written every
   *  referenced leaf first (so the published snapshot never references a missing leaf). */
  writeSnapshot(generation: number, events: Record<string, EventEntry>): RegistrySnapshot {
    const integrity = snapshotIntegrity(generation, events);
    const snap: RegistrySnapshot = { schema: 1, generation, events, integrity };
    atomicWrite(path.join(this.dir(), REGISTRY_FILE), `${JSON.stringify(snap, null, 2)}\n`);
    return snap;
  }

  removeSnapshot(): void { fs.rmSync(path.join(this.dir(), REGISTRY_FILE), { force: true }); }

  // ── ownership record ───────────────────────────────────────────────────────

  readOwnership(): OwnershipRecord | undefined {
    let text: string;
    try {
      text = fs.readFileSync(path.join(this.dir(), OWNERSHIP_FILE), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new GitHookStoreError(`reading ${OWNERSHIP_FILE}: ${(e as Error).message}`);
    }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new GitHookStoreError(`${OWNERSHIP_FILE}: invalid JSON`); }
    const o = raw as OwnershipRecord;
    if (!o || o.schema !== 1 || typeof o.managedPath !== "string" || typeof o.leafRefs !== "number" || typeof o.generation !== "number" || !(o.claimedFrom === null || typeof o.claimedFrom === "string")) {
      throw new GitHookStoreError(`${OWNERSHIP_FILE}: malformed ownership record`);
    }
    return o;
  }

  writeOwnership(record: OwnershipRecord): void {
    atomicWrite(path.join(this.dir(), OWNERSHIP_FILE), `${JSON.stringify(record, null, 2)}\n`);
  }

  removeOwnership(): void { fs.rmSync(path.join(this.dir(), OWNERSHIP_FILE), { force: true }); }

  /** Remove the whole managed dir when it is empty of meaningful state (no registry, no ownership). */
  cleanupIfEmpty(): void {
    const d = this.dir();
    fs.rmSync(this.leavesDir(), { recursive: true, force: true });
    for (const sub of [LOCK_SUBDIR]) fs.rmSync(path.join(d, sub), { recursive: true, force: true });
    try { fs.rmdirSync(d); } catch { /* non-empty (registry/ownership still there) → leave it */ }
  }

  // ── repo lock (mkdir-atomic, with a stale break) ──────────────────────────────

  /** Acquire the repo lock; returns a release fn. Retries up to ~`waitMs`, breaks a stale lock older than
   *  LOCK_STALE_MS (a crashed holder must not deadlock install/remove forever). */
  async acquireLock(waitMs = 5_000): Promise<() => void> {
    const lockDir = path.join(this.dir(), LOCK_SUBDIR);
    fs.mkdirSync(this.dir(), { recursive: true });
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        fs.mkdirSync(lockDir); // atomic
        fs.writeFileSync(path.join(lockDir, "pid"), String(process.pid));
        return () => { fs.rmSync(lockDir, { recursive: true, force: true }); };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        // stale-break: a lock dir older than the staleness window is from a dead holder.
        try {
          const age = Date.now() - fs.statSync(lockDir).mtimeMs;
          if (age > LOCK_STALE_MS) { fs.rmSync(lockDir, { recursive: true, force: true }); continue; }
        } catch { /* raced away — retry */ }
        if (Date.now() > deadline) throw new GitHookStoreError("git-hook repo lock is held — another install/remove is in progress");
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }
}
