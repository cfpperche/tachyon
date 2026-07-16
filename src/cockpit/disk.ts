/**
 * Host-side (Node) disk reads for Cockpit collect — never import from webview bundles.
 */

import fs from "node:fs";
import path from "node:path";
import type { CockpitDeliveryRow, CockpitWorktreeRow } from "./model.js";

/** Best-effort read of managed worktree registry from a workspace root. */
export function readManagedWorktreesFromDisk(
  workspaceRoot: string,
  meta?: { folder?: string; wsHash?: string },
): CockpitWorktreeRow[] {
  const file = path.join(workspaceRoot, ".tachyon", "managed-worktrees.json");
  try {
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { entries?: Array<Record<string, unknown>> };
    const entries = Array.isArray(raw.entries) ? raw.entries : [];
    return entries.map((e, i) => ({
      id: String(e.id ?? `mw-${i}`),
      kind: String(e.kind ?? "unknown"),
      path: String(e.path ?? ""),
      branch: String(e.branch ?? ""),
      status: String(e.status ?? "active"),
      slug: e.slug != null ? String(e.slug) : undefined,
      agent: e.agent != null ? String(e.agent) : undefined,
      ...(meta?.folder ? { folder: meta.folder } : {}),
      ...(meta?.wsHash ? { wsHash: meta.wsHash } : {}),
    }));
  } catch {
    return [];
  }
}

/** Best-effort list of git-delivery JSON files under .tachyon/git-deliveries if present. */
export function readGitDeliveriesFromDisk(
  workspaceRoot: string,
  meta?: { folder?: string; wsHash?: string },
): CockpitDeliveryRow[] {
  const dir = path.join(workspaceRoot, ".tachyon", "git-deliveries");
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
    const out: CockpitDeliveryRow[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Record<string, unknown>;
        out.push({
          id: String(rec.id ?? name.replace(/\.json$/, "")),
          phase: String(rec.phase ?? "unknown"),
          branchRef: String(rec.branchRef ?? rec.branch_ref ?? ""),
          agent: rec.agent != null ? String(rec.agent) : undefined,
          worktreePath:
            rec.worktreePath != null
              ? String(rec.worktreePath)
              : rec.worktree_path != null
                ? String(rec.worktree_path)
                : undefined,
          ...(meta?.folder ? { folder: meta.folder } : {}),
          ...(meta?.wsHash ? { wsHash: meta.wsHash } : {}),
        });
      } catch {
        /* skip */
      }
    }
    return out;
  } catch {
    return [];
  }
}
