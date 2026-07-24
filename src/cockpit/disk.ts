/**
 * Host-side (Node) disk reads for Cockpit collect — never import from webview bundles.
 *
 * spec 444 (t-9f8dfc): `readManagedWorktreesFromDisk` was DELETED — a POC-era raw-JSON reader
 * (commit 656f6393, zero tests, lenient parallel parser, `catch {} → []`) that bypassed
 * `loadManagedWorktreeStore`'s fail-closed validation. The Worktrees tab now reads the engine's
 * `worktrees.classified` RPC (ManagedWorktreeService: validated loader + reconcile + classifier);
 * engine unreachable shows an honest error state, never unverified rows. Its sibling below carries
 * the same debt for the Deliveries tab — tracked as t-43c6fa, deliberately untouched here.
 */

import fs from "node:fs";
import path from "node:path";
import type { CockpitDeliveryRow } from "./model.js";

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
