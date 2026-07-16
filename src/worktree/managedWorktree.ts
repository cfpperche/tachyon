/**
 * spec 392 — managed worktree registry (product catalog of Tachyon-owned checkouts).
 * Pure helpers + durable JSON store. Git mutate ops live in ManagedWorktreeService / WorktreeManager.
 */

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

export function managedWorktreeStorePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, MANAGED_WORKTREE_STORE_REL);
}

/** Change worktree path: `<base>/<wsHash>/change/<slug>`. */
export function pathForChange(base: string, wsHash: string, slug: string): string {
  return path.join(base, wsHash, "change", slug);
}

export function assertManagedSlug(slug: string): string {
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `invalid managed worktree slug '${slug}' (expected ${SLUG_RE.source})`,
    );
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

export function defaultChangeBranch(slug: string): string {
  return `tachyon/change/${slug}`;
}

export function newManagedId(kind: ManagedWorktreeKind, key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 48);
  return `mw-${kind}-${safe}`;
}

export function loadManagedWorktreeStore(filePath: string): ManagedWorktreeStoreFile {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as ManagedWorktreeStoreFile;
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.entries)) {
      return { schemaVersion: 1, entries: [] };
    }
    return { schemaVersion: 1, entries: parsed.entries.filter(isEntryShape) };
  } catch {
    return { schemaVersion: 1, entries: [] };
  }
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

/** Active entries for VS Code reveal (name = agent or change slug). */
export function liveFoldersFromRegistry(store: ManagedWorktreeStoreFile): Array<{ path: string; agent: string }> {
  return store.entries
    .filter((e) => e.status === "active")
    .map((e) => ({
      path: e.path,
      agent: e.agent ?? e.slug ?? e.id,
    }));
}
