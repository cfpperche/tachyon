import path from "node:path";

/**
 * t-5786bc — the durable-state manifest: WHICH parts of a workspace's runtime state deserve to
 * exist off this machine, said once, as data.
 *
 * Two rules from the 2026-08-21 incident (rm -rf of the primary checkout destroyed the Board,
 * continuity, HANDOFF and tachyon.yml — none of it had a replica):
 *
 *  1. ALLOWLIST, never denylist. Only entries named here are ever read by a backup pass. A secret
 *     can only leak by being explicitly added to this list — not by being forgotten in a sweep of
 *     `.tachyon/`. `assertOutsideSecretPaths` makes that structural: the manifest module itself
 *     refuses entries that reach into a secret-bearing location, so the property holds for future
 *     edits too, not just today's list.
 *
 *  2. Local state stays PRIMARY. Nothing in this module mutates the workspace; the manifest only
 *     names what a replica pass may read. The off-machine copy is a backup of the runtime, never
 *     an authority the runtime consults.
 */

export type DurableEntryKind = "file" | "dir";

export interface DurableEntry {
  /** stable id — generation manifests and sync stats refer to entries by this name. */
  id: string;
  kind: DurableEntryKind;
  /** RELATIVE to the workspace root, always with forward slashes. */
  relPath: string;
  /** dir entries only: keep just the files whose workspace-relative path passes this test. */
  include?: (relPath: string) => boolean;
}

/**
 * Locations a durable entry must never resolve into, because they hold credentials or other
 * machine-private secrets (harness homes symlink live `.credentials.json`; `.tachyon/secrets` is
 * the declared secret store — spec 337).
 */
export const SECRET_REL_PREFIXES = [
  ".tachyon/harness",
  ".tachyon/secrets",
] as const;

/** File names that are secrets wherever they appear. */
export const SECRET_BASENAMES = new Set([".credentials.json", ".claude.json", "secrets.env"]);

/** Atomic-write temporaries (TaskStore & friends write `<name>.tmp.<pid>.<hex>` then link/rename). */
export function isAtomicTemp(relPath: string): boolean {
  return path.posix.basename(relPath).includes(".tmp.");
}

export function isSecretPath(relPath: string): boolean {
  const normalized = relPath.split(path.sep).join("/");
  if (SECRET_BASENAMES.has(path.posix.basename(normalized))) return true;
  return SECRET_REL_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

function assertOutsideSecretPaths(entry: DurableEntry): DurableEntry {
  if (isSecretPath(entry.relPath)) {
    throw new Error(`durable-state manifest entry '${entry.id}' reaches a secret path: ${entry.relPath}`);
  }
  return entry;
}

/**
 * The durable allowlist, mapped store-by-store from the engine on 2026-08-21 (full classification
 * in t-5786bc). Everything else under `.tachyon/` is machine-local runtime the engine recreates.
 */
const MANIFEST_ENTRIES: DurableEntry[] = [
  // The Board: tasks, their .journal logs, Task Studio sidecars, prototypes/attempts.
  { id: "tasks", kind: "dir", relPath: ".tachyon/tasks" },
  // Shared checklist (structured file + per-pin records).
  { id: "pins-file", kind: "file", relPath: ".tachyon/pins.json" },
  { id: "pins", kind: "dir", relPath: ".tachyon/pins" },
  { id: "validations", kind: "dir", relPath: ".tachyon/validations" },
  { id: "evidence", kind: "dir", relPath: ".tachyon/evidence" },
  { id: "review", kind: "dir", relPath: ".tachyon/review" },
  // Saved-agent durable memory. The primer promises this survives restarts; without a replica the
  // promise ended at the machine (see t-a1ee7e item 4).
  { id: "continuity", kind: "dir", relPath: ".tachyon/continuity" },
  { id: "handoff", kind: "file", relPath: ".tachyon/HANDOFF.md" },
  { id: "handoff-notes", kind: "file", relPath: ".tachyon/handoff-notes.jsonl" },
  { id: "studies", kind: "dir", relPath: ".tachyon/studies" },
  // Pipeline run ledger (spec 230 — per-run durability).
  { id: "runs", kind: "dir", relPath: ".tachyon/runs" },
  // Agent identity only: agent.yml carries the agentId that ties continuity to an agent. The rest
  // of `.tachyon/agents/<name>/` is runtime materialization.
  {
    id: "agent-profiles",
    kind: "dir",
    relPath: ".tachyon/agents",
    include: (relPath) => path.posix.basename(relPath) === "agent.yml",
  },
  // The workspace config is gitignored BY DESIGN (personal), which is exactly why it needs the
  // replica: it has no other copy anywhere.
  { id: "workspace-config", kind: "file", relPath: "tachyon.yml" },
];

export const DURABLE_STATE_MANIFEST: readonly DurableEntry[] = MANIFEST_ENTRIES.map(assertOutsideSecretPaths);

/** Ids in stable order — handy for tests and for stats reporting. */
export function manifestEntryIds(): string[] {
  return DURABLE_STATE_MANIFEST.map((entry) => entry.id);
}
