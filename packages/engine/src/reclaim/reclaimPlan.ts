import { verifyProvenance, type ProvenanceProbe, type WorkspaceProvenance } from "./provenance.js";

/**
 * t-f5769a — what Tachyon may take back, computed BEFORE anything is touched.
 *
 * Measured on 2026-08-22, one machine, ~5.0GB of machine-local state that nothing ever collected:
 * 1.8GB of staged engine bundles (362 of them — `engineBundleStore.ts` had stage/load/verify and no
 * removal at all), 1.7GB of worktrees belonging to workspace incarnations that no longer exist,
 * 760MB of engine runtimes, and 35MB of engine state whose ownership was unknowable until
 * `provenance.ts`.
 *
 * The plan is a VALUE: pure, ordered, and reviewable. Nothing here deletes — `applyReclaim` does,
 * against a plan a human or a policy has seen. Two rules give the whole thing its shape:
 *   - anything a LIVE engine is using is never a candidate, whatever its age;
 *   - anything that may still hold work a human has not landed is REPORTED, never collected.
 */

export type ReclaimKind = "bundle" | "runtime" | "engine-state" | "worktree" | "bridge-token";

export interface ReclaimCandidate {
  kind: ReclaimKind;
  /** absolute path this entry occupies. */
  path: string;
  bytes: number;
  /** why it is collectable, in one human sentence. */
  reason: string;
}

export interface ReclaimHold {
  kind: ReclaimKind;
  path: string;
  bytes: number;
  /** why it is NOT collectable — the sentence a human reads before deciding by hand. */
  reason: string;
}

export interface ReclaimPlan {
  /** safe to remove now. */
  collect: ReclaimCandidate[];
  /** state of a dead incarnation: moved aside rather than deleted, so nothing is destroyed. */
  quarantine: ReclaimCandidate[];
  /** reported for a human decision; the plan never acts on these. */
  hold: ReclaimHold[];
  bytesCollectable: number;
  bytesQuarantined: number;
}

export interface BundleEntry { id: string; path: string; bytes: number; mtimeMs: number }
export interface RuntimeEntry { id: string; path: string; bytes: number; inUse: boolean }
export interface EngineStateEntry { hash: string; path: string; bytes: number; provenance?: WorkspaceProvenance }
export interface WorktreeEntry {
  path: string;
  bytes: number;
  /** the workspace hash this worktree was created under. */
  workspaceHash: string;
  /** uncommitted changes present. */
  dirty: boolean;
  /** commits not reachable from the branch it was based on. */
  unmerged: boolean;
  /** its workspace still exists and still owns it. */
  live: boolean;
}
export interface BridgeTokenEntry { path: string; bytes: number; hash: string }

export interface ReclaimInput {
  bundles: BundleEntry[];
  /** bundle ids a running engine is executing right now. */
  liveBundleIds: ReadonlySet<string>;
  keepBundles: number;
  runtimes: RuntimeEntry[];
  engineStates: EngineStateEntry[];
  worktrees: WorktreeEntry[];
  bridgeTokens: BridgeTokenEntry[];
  /** workspace hashes with a live engine state — a token for one of these is in use. */
  liveWorkspaceHashes: ReadonlySet<string>;
  /**
   * t-63955f — hashes whose engine state PROVES the workspace is gone or was replaced. Only these
   * justify removing a token: see the collection rule below for why "not provably live" must not.
   */
  deadWorkspaceHashes: ReadonlySet<string>;
  probe: ProvenanceProbe;
}

export function planReclaim(input: ReclaimInput): ReclaimPlan {
  const collect: ReclaimCandidate[] = [];
  const quarantine: ReclaimCandidate[] = [];
  const hold: ReclaimHold[] = [];

  // Bundles: keep what is running, plus the newest N as a rollback window.
  const keep = Math.max(1, input.keepBundles);
  const byNewest = [...input.bundles].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const retained = new Set(byNewest.slice(0, keep).map((bundle) => bundle.id));
  for (const bundle of byNewest) {
    if (input.liveBundleIds.has(bundle.id)) {
      hold.push({ kind: "bundle", path: bundle.path, bytes: bundle.bytes, reason: "a running engine is executing this bundle" });
      continue;
    }
    if (retained.has(bundle.id)) {
      hold.push({ kind: "bundle", path: bundle.path, bytes: bundle.bytes, reason: `among the ${keep} newest — the rollback window` });
      continue;
    }
    collect.push({ kind: "bundle", path: bundle.path, bytes: bundle.bytes, reason: "superseded engine build" });
  }

  for (const runtime of input.runtimes) {
    if (runtime.inUse) {
      hold.push({ kind: "runtime", path: runtime.path, bytes: runtime.bytes, reason: "a retained bundle runs on this runtime" });
      continue;
    }
    collect.push({ kind: "runtime", path: runtime.path, bytes: runtime.bytes, reason: "no retained bundle uses this runtime" });
  }

  for (const state of input.engineStates) {
    const verdict = verifyProvenance(state.provenance, input.probe);
    switch (verdict.kind) {
      case "live":
        hold.push({ kind: "engine-state", path: state.path, bytes: state.bytes, reason: "its workspace is still there" });
        break;
      case "unknown":
        // Never collected: an engine serving a live workspace stamps provenance within one start,
        // so an unknown entry is either brand-new or already dead — and guessing here deletes
        // credentials.
        hold.push({ kind: "engine-state", path: state.path, bytes: state.bytes, reason: "no provenance recorded yet — start Tachyon in that workspace to identify it" });
        break;
      case "workspace-gone":
      case "incarnation-replaced":
        // The owner's ruling (2026-08-22): a dead incarnation carries nothing forward. Implemented
        // as quarantine rather than deletion, because this state holds provider API keys: nothing
        // is adopted silently, and nothing is destroyed either.
        quarantine.push({
          kind: "engine-state",
          path: state.path,
          bytes: state.bytes,
          reason: verdict.kind === "workspace-gone"
            ? `the workspace ${state.provenance?.root} no longer exists`
            : `${state.provenance?.root} now holds a different workspace`,
        });
        break;
    }
  }

  for (const worktree of input.worktrees) {
    if (worktree.live) {
      hold.push({ kind: "worktree", path: worktree.path, bytes: worktree.bytes, reason: "its workspace still owns this worktree" });
      continue;
    }
    if (worktree.dirty || worktree.unmerged) {
      hold.push({
        kind: "worktree",
        path: worktree.path,
        bytes: worktree.bytes,
        reason: worktree.dirty
          ? "holds uncommitted changes — review before removing"
          : "holds commits that were never merged — review before removing",
      });
      continue;
    }
    collect.push({ kind: "worktree", path: worktree.path, bytes: worktree.bytes, reason: "orphaned worktree with nothing unsaved in it" });
  }

  for (const token of input.bridgeTokens) {
    // t-63955f — this rule used to be "collect unless provably LIVE", which is the destructive
    // default: liveness comes from provenance, provenance is stamped one workspace at a time, and on
    // a real machine 216 of 217 states carried none. Enabling the automatic pass under that rule
    // would have deleted the authentication material of workspaces that were simply not stamped yet.
    // Engine state already followed the opposite rule (unknown is never collected); a token is the
    // same class of thing and now follows it too: only provable death justifies removal.
    if (input.deadWorkspaceHashes.has(token.hash)) {
      collect.push({ kind: "bridge-token", path: token.path, bytes: token.bytes, reason: "token of a workspace that no longer exists" });
      continue;
    }
    hold.push({
      kind: "bridge-token",
      path: token.path,
      bytes: token.bytes,
      reason: input.liveWorkspaceHashes.has(token.hash)
        ? "belongs to a live workspace"
        : "cannot be shown to belong to a dead workspace — it stays until provenance says otherwise",
    });
  }

  return {
    collect,
    quarantine,
    hold,
    bytesCollectable: collect.reduce((sum, entry) => sum + entry.bytes, 0),
    bytesQuarantined: quarantine.reduce((sum, entry) => sum + entry.bytes, 0),
  };
}

/** One line per kind — what a human reads before saying yes. */
export function summarizeReclaimPlan(plan: ReclaimPlan): string[] {
  const mb = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)}MB`;
  const lines: string[] = [];
  const byKind = new Map<ReclaimKind, { count: number; bytes: number }>();
  for (const entry of plan.collect) {
    const current = byKind.get(entry.kind) ?? { count: 0, bytes: 0 };
    byKind.set(entry.kind, { count: current.count + 1, bytes: current.bytes + entry.bytes });
  }
  for (const [kind, totals] of byKind) lines.push(`remove ${totals.count} ${kind}(s) — ${mb(totals.bytes)}`);
  if (plan.quarantine.length > 0) {
    lines.push(`quarantine ${plan.quarantine.length} engine state(s) of workspaces that are gone — ${mb(plan.bytesQuarantined)} (kept, not deleted)`);
  }
  const heldForReview = plan.hold.filter((entry) => entry.reason.includes("review before removing"));
  if (heldForReview.length > 0) {
    lines.push(`${heldForReview.length} worktree(s) left alone because they hold unsaved work — listed below`);
  }
  return lines;
}
