import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * t-af0d29 — a workspace's identity, so that "the same path" stops meaning "the same workspace".
 *
 * Measured on 2026-08-21: `rm -rf` on a live workspace could not finish, because the engine kept
 * recreating `.tachyon/` underneath it — 154 `mkdirSync` call sites, each a store lazily making its
 * own directory. The rm aborted with "Directory not empty" and the engine went on serving a project
 * that no longer existed. A re-clone at the same path then silently inherited that engine's
 * machine-local state, because engine identity is `workspaceHash(path)` — a digest of the PATH.
 * Destruction followed by recreation is, to the product, indistinguishable from continuity.
 *
 * The marker is the missing half of that identity: a value that lives INSIDE the workspace, so it
 * disappears when the workspace does. Path says WHERE, this says WHICH. A running engine samples it
 * and can tell "still my workspace" from "my workspace is gone" and from "someone else's workspace
 * is here now" — three states that were one.
 *
 * Deliberately not a lock, a lease or a heartbeat: it is a birth certificate, written once and
 * never rewritten. Nothing about it needs to survive being read by an older engine, which simply
 * ignores a file it does not know.
 */

export const WORKSPACE_IDENTITY_FILE = ".tachyon/workspace.json";

export interface WorkspaceIdentity {
  schemaVersion: 1;
  /** Random per workspace incarnation; a re-clone at the same path gets a new one. */
  id: string;
  createdAt: string;
}

export function workspaceIdentityPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ...WORKSPACE_IDENTITY_FILE.split("/"));
}

function parse(raw: string): WorkspaceIdentity | undefined {
  try {
    const value = JSON.parse(raw) as Partial<WorkspaceIdentity>;
    if (value?.schemaVersion !== 1) return undefined;
    if (typeof value.id !== "string" || value.id.trim().length === 0) return undefined;
    return { schemaVersion: 1, id: value.id, createdAt: typeof value.createdAt === "string" ? value.createdAt : "" };
  } catch {
    return undefined;
  }
}

/**
 * The identity of the workspace at `workspaceRoot`, minting one if this is the first engine to run
 * here. Returns undefined when the root does not exist — an engine must not create a workspace out
 * of a path that isn't there.
 */
export function ensureWorkspaceIdentity(workspaceRoot: string): WorkspaceIdentity | undefined {
  if (!fs.existsSync(workspaceRoot)) return undefined;
  const file = workspaceIdentityPath(workspaceRoot);
  const existing = fs.existsSync(file) ? parse(fs.readFileSync(file, "utf8")) : undefined;
  if (existing) return existing;
  const minted: WorkspaceIdentity = { schemaVersion: 1, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write-then-rename: two engines racing on a fresh workspace both write, one rename wins, and
    // both then READ the winner — so the id a caller keeps is the id on disk, never its own guess.
    const temporary = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(minted, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, file);
  } catch {
    // A read-only or racing filesystem must not stop an engine from serving; identity checking
    // simply degrades to "unknown", which readIdentityState reports as `indeterminate`.
    return parse(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "") ?? undefined;
  }
  return parse(fs.readFileSync(file, "utf8")) ?? minted;
}

export type WorkspaceIdentityState =
  /** Same workspace this engine started serving. */
  | { kind: "intact" }
  /** The workspace root itself is gone — a delete happened under the running engine. */
  | { kind: "root-missing" }
  /** The root is there but the marker is not: `.tachyon` was wiped, or the folder was replaced. */
  | { kind: "marker-missing" }
  /** A workspace is here, and it is a different one than the engine started with. */
  | { kind: "replaced"; foundId: string }
  /** Could not be determined (unreadable file, permissions) — never a reason to act. */
  | { kind: "indeterminate" };

/** Sample the workspace this engine believes it is serving. Read-only; creates nothing. */
export function readIdentityState(workspaceRoot: string, expectedId: string): WorkspaceIdentityState {
  let rootExists: boolean;
  try {
    rootExists = fs.existsSync(workspaceRoot);
  } catch {
    return { kind: "indeterminate" };
  }
  if (!rootExists) return { kind: "root-missing" };
  const file = workspaceIdentityPath(workspaceRoot);
  let raw: string;
  try {
    if (!fs.existsSync(file)) return { kind: "marker-missing" };
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { kind: "indeterminate" };
  }
  const found = parse(raw);
  if (!found) return { kind: "indeterminate" };
  return found.id === expectedId ? { kind: "intact" } : { kind: "replaced", foundId: found.id };
}

/** One sentence a human can act on, for each way a workspace stops being the one it was. */
export function describeIdentityLoss(state: WorkspaceIdentityState, workspaceRoot: string): string | undefined {
  switch (state.kind) {
    case "root-missing":
      return `the workspace folder ${workspaceRoot} no longer exists`;
    case "marker-missing":
      return `${workspaceRoot} no longer carries its Tachyon workspace marker (${WORKSPACE_IDENTITY_FILE})`;
    case "replaced":
      return `${workspaceRoot} now holds a different Tachyon workspace`;
    default:
      return undefined;
  }
}
