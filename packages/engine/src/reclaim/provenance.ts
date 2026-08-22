/**
 * t-f5769a — which workspace a machine-local engine state belongs to.
 *
 * Measured on 2026-08-22: 217 engine states under `~/.local/state/tachyon/engines`, and no way to
 * tell which of them belong to workspaces that still exist. The directory is named for
 * `workspaceHash(path)` — a one-way digest — and nothing inside records the path it came from. So
 * the product could neither collect dead state nor answer "is this mine?", and 35MB of state
 * (holding provider keys, caller registries and authority heads) simply accumulated forever.
 *
 * Provenance is the missing back-reference: the engine stamps, on every start, WHERE it is serving
 * from and WHICH workspace incarnation that is (t-af0d29's identity). With it:
 *   - the path no longer exists            → this state belongs to a workspace that is gone;
 *   - the path exists with a different id  → it belongs to an incarnation that was replaced;
 *   - the path exists with the same id     → it is live, and nothing may touch it.
 *
 * Legacy state carries no stamp. That is reported as `unknown`, never collected: an engine serving
 * a live workspace stamps it within one start, so what stays unknown is what stopped being served.
 */

export const WORKSPACE_PROVENANCE_STATE_KEY = "tachyon.workspace.provenance.v1";

export interface WorkspaceProvenance {
  schemaVersion: 1;
  /** absolute workspace root this engine was serving. */
  root: string;
  /** t-af0d29 workspace identity; absent when the marker could not be read at stamp time. */
  workspaceId?: string;
  /** ISO — refreshed on every engine start, so staleness is measurable. */
  lastSeenAt: string;
}

export function buildWorkspaceProvenance(root: string, workspaceId: string | undefined, now: Date): WorkspaceProvenance {
  return { schemaVersion: 1, root, ...(workspaceId ? { workspaceId } : {}), lastSeenAt: now.toISOString() };
}

export function parseWorkspaceProvenance(value: unknown): WorkspaceProvenance | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<WorkspaceProvenance>;
  if (candidate.schemaVersion !== 1) return undefined;
  if (typeof candidate.root !== "string" || candidate.root.trim().length === 0) return undefined;
  if (typeof candidate.lastSeenAt !== "string") return undefined;
  return {
    schemaVersion: 1,
    root: candidate.root,
    ...(typeof candidate.workspaceId === "string" ? { workspaceId: candidate.workspaceId } : {}),
    lastSeenAt: candidate.lastSeenAt,
  };
}

export type ProvenanceVerdict =
  /** serving a workspace that is still there, unchanged. */
  | { kind: "live" }
  /** the workspace root is gone. */
  | { kind: "workspace-gone" }
  /** the path holds a DIFFERENT workspace than the one this state served. */
  | { kind: "incarnation-replaced" }
  /** no stamp: legacy state, or an engine that never started again. Never collected. */
  | { kind: "unknown" };

export interface ProvenanceProbe {
  /** does this path exist right now? */
  rootExists: (root: string) => boolean;
  /** the identity currently at that path, if any. */
  identityAt: (root: string) => string | undefined;
}

export function verifyProvenance(provenance: WorkspaceProvenance | undefined, probe: ProvenanceProbe): ProvenanceVerdict {
  if (!provenance) return { kind: "unknown" };
  if (!probe.rootExists(provenance.root)) return { kind: "workspace-gone" };
  // A stamp older than the identity feature has no id to compare; the path exists, so it is live
  // until an engine start refreshes the stamp with one.
  if (!provenance.workspaceId) return { kind: "live" };
  const current = probe.identityAt(provenance.root);
  if (current === undefined) return { kind: "unknown" };
  return current === provenance.workspaceId ? { kind: "live" } : { kind: "incarnation-replaced" };
}
