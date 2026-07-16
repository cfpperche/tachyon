/**
 * spec 392 — managed worktree registry (product catalog of Tachyon-owned checkouts).
 * Pure helpers + durable JSON store. Git mutate ops live in ManagedWorktreeService / WorktreeManager.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveBase } from "./WorktreeManager.js";
import type { TachyonConfig } from "../config/loadConfig.js";

export type ManagedWorktreeKind = "agent" | "change";

export interface ManagedWorktreeEntry {
  id: string;
  kind: ManagedWorktreeKind;
  path: string;
  branch: string;
  baseRef: string;
  tachyonCreatedBranch: boolean;
  /** Agent name when kind=agent; optional owner for change. */
  agent?: string;
  /** Task id when kind=change (or linked). */
  taskId?: string;
  /** Stable slug for change path segment. */
  slug?: string;
  createdAt: string;
  createdBy?: string;
  status: "active" | "abandoned";
}

export interface ManagedWorktreeStoreFile {
  schemaVersion: 1;
  entries: ManagedWorktreeEntry[];
}

export const MANAGED_WORKTREE_STORE_REL = path.join(".tachyon", "managed-worktrees.json");

const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export class ManagedWorktreeStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedWorktreeStoreError";
  }
}

export function managedWorktreeStorePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, MANAGED_WORKTREE_STORE_REL);
}

/** Change worktree path: `<base>/<wsHash>/change/<slug>`. */
export function pathForChange(base: string, wsHash: string, slug: string): string {
  return path.join(base, wsHash, "change", slug);
}

export function assertManagedSlug(slug: string): string {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`invalid managed worktree slug '${slug}' (expected ${SLUG_RE.source})`);
  }
  return slug;
}

export function resolveManagedBase(
  settings: TachyonConfig["settings"],
  env: NodeJS.ProcessEnv = process.env,
  homeDir?: string,
): string {
  return resolveBase(settings, env, homeDir);
}

export function isUnderManagedBase(folderPath: string, base: string): boolean {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, "");
  const rel = path.relative(norm(base), norm(folderPath));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Contained under `<base>/<wsHash>/…` (agent or change). */
export function isUnderWorkspaceManagedRoot(folderPath: string, base: string, wsHash: string): boolean {
  const root = path.resolve(base, wsHash);
  const abs = path.resolve(folderPath);
  if (abs === root) return false;
  const rel = path.relative(root, abs);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export function defaultChangeBranch(slug: string): string {
  return `tachyon/change/${slug}`;
}

/** Injective id for the accepted key space (no silent collision on long slugs). */
export function newManagedId(kind: ManagedWorktreeKind, key: string): string {
  const digest = crypto.createHash("sha256").update(`${kind}\0${key}`).digest("hex").slice(0, 16);
  const safe = key.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 32);
  return `mw-${kind}-${safe}-${digest}`;
}

/**
 * Load registry. Missing file → empty catalog.
 * Corrupt/unreadable/unknown schema → throws (fail-closed; never silently wipe).
 */
export function loadManagedWorktreeStore(filePath: string): ManagedWorktreeStoreFile {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { schemaVersion: 1, entries: [] };
    throw new ManagedWorktreeStoreError(
      `cannot read managed worktree registry ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ManagedWorktreeStoreError(
      `managed worktree registry is not valid JSON (${filePath}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ManagedWorktreeStoreError(`managed worktree registry has invalid root shape (${filePath})`);
  }
  const root = parsed as Record<string, unknown>;
  if (root.schemaVersion !== 1) {
    throw new ManagedWorktreeStoreError(
      `managed worktree registry schemaVersion unsupported (got ${String(root.schemaVersion)}; need 1) at ${filePath}`,
    );
  }
  if (!Array.isArray(root.entries)) {
    throw new ManagedWorktreeStoreError(`managed worktree registry entries must be an array (${filePath})`);
  }
  const entries: ManagedWorktreeEntry[] = [];
  for (const item of root.entries) {
    if (!isEntryShape(item)) {
      throw new ManagedWorktreeStoreError(`managed worktree registry contains a malformed entry (${filePath})`);
    }
    entries.push(item);
  }
  return { schemaVersion: 1, entries };
}

function isEntryShape(e: unknown): e is ManagedWorktreeEntry {
  if (!e || typeof e !== "object") return false;
  const o = e as Record<string, unknown>;
  return (
    typeof o.id === "string"
    && (o.kind === "agent" || o.kind === "change")
    && typeof o.path === "string"
    && typeof o.branch === "string"
    && typeof o.baseRef === "string"
    && typeof o.tachyonCreatedBranch === "boolean"
    && typeof o.createdAt === "string"
    && (o.status === "active" || o.status === "abandoned")
  );
}

export function saveManagedWorktreeStore(filePath: string, store: ManagedWorktreeStoreFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

export function upsertManagedEntry(store: ManagedWorktreeStoreFile, entry: ManagedWorktreeEntry): ManagedWorktreeStoreFile {
  const entries = store.entries.filter((e) => e.id !== entry.id && path.resolve(e.path) !== path.resolve(entry.path));
  entries.push(entry);
  return { schemaVersion: 1, entries };
}

export function removeManagedEntry(store: ManagedWorktreeStoreFile, idOrPath: string): ManagedWorktreeStoreFile {
  const key = idOrPath;
  const resolved = path.resolve(key);
  return {
    schemaVersion: 1,
    entries: store.entries.filter((e) => e.id !== key && path.resolve(e.path) !== resolved),
  };
}

export function findManagedEntry(store: ManagedWorktreeStoreFile, idOrPath: string): ManagedWorktreeEntry | undefined {
  const resolved = path.resolve(idOrPath);
  return store.entries.find((e) => e.id === idOrPath || path.resolve(e.path) === resolved);
}

/**
 * Mark active entries whose path is gone as abandoned.
 * Does not delete rows — reappearance requires re-register (Git identity check).
 */
export function abandonMissingEntries(
  store: ManagedWorktreeStoreFile,
  pathExists: (p: string) => boolean = fs.existsSync,
): { store: ManagedWorktreeStoreFile; changed: boolean } {
  let changed = false;
  const entries = store.entries.map((e) => {
    if (e.status === "active" && !pathExists(e.path)) {
      changed = true;
      return { ...e, status: "abandoned" as const };
    }
    return e;
  });
  return { store: { schemaVersion: 1, entries }, changed };
}

/**
 * Active entries whose path still exists (stale/abandoned rows never revealed).
 * Callers should run abandonMissingEntries first so missing actives are not left durable.
 */
export function liveFoldersFromRegistry(
  store: ManagedWorktreeStoreFile,
  pathExists: (p: string) => boolean = fs.existsSync,
): Array<{ path: string; agent: string }> {
  return store.entries
    .filter((e) => e.status === "active" && pathExists(e.path))
    .map((e) => ({
      path: e.path,
      agent: e.agent ?? e.slug ?? e.id,
    }));
}

/**
 * Whether actor may mutate this entry.
 * - agent: only creator or agent owner (no path-takeover privilege)
 * - human: host/admin UI principal
 * - legacy/external: NOT globally privileged for destructive registry ops (shared tokens)
 */
export function canMutateManagedWorktree(
  entry: ManagedWorktreeEntry,
  actor: { kind: string; name?: string },
): boolean {
  if (actor.kind === "human") return true;
  if (actor.kind !== "agent" || !actor.name) return false;
  return entry.createdBy === actor.name || entry.agent === actor.name;
}

/** Whether actor may administer/register arbitrary paths (host human only). */
export function canAdminManagedWorktree(actor: { kind: string; name?: string }): boolean {
  return actor.kind === "human";
}
