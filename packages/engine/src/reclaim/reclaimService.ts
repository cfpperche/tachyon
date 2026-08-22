import os from "node:os";
import path from "node:path";
import { resolveBase } from "../worktree/WorktreeManager.js";
import type { TachyonConfig } from "../config/loadConfig.js";
import { summarizeReclaimPlan, type ReclaimPlan } from "./reclaimPlan.js";
import { applyReclaim, scanReclaim, type ReclaimResult } from "./reclaimScan.js";

/**
 * t-f5769a — the two doors onto the same plan: the engine's own start-up pass (on by default) and
 * the human's command. Both compute a plan first and act on THAT, so what is reported is what
 * happened rather than a second opinion about it.
 */

export interface ReclaimSettings {
  enabled?: boolean;
  keepBundles?: number;
}

export interface ReclaimRunInput {
  /** the workspace's settings — the worktree base is configurable, so the scan must honour it. */
  workspaceSettings?: TachyonConfig["settings"];
  /**
   * Roots to scan. Production omits these and gets the XDG locations; a caller that must not touch
   * the real machine passes its own.
   *
   * Measured on 2026-08-22: a test that could not override them ran against the author's actual
   * disk and reclaimed 359 real bundles. Untestable-without-side-effects is not a testing problem,
   * it is a design one — an operation that deletes must be able to say WHERE, or someone will find
   * out the hard way which place it meant.
   */
  roots?: { bundlesRoot?: string; runtimesRoot?: string; enginesStateRoot?: string };
  /** where quarantined state is kept — never inside a workspace, which is what may be disappearing. */
  quarantineRoot?: string;
  globalStorageRoot?: string;
  liveBundleIds?: ReadonlySet<string>;
  settings?: ReclaimSettings;
  now?: Date;
}

export function reclaimQuarantineRoot(home: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  const state = env.XDG_STATE_HOME?.trim() || path.join(home, ".local", "state");
  return path.join(state, "tachyon", "quarantine");
}

export async function planWorkspaceReclaim(input: ReclaimRunInput = {}): Promise<ReclaimPlan> {
  return await scanReclaim({
    ...input.roots,
    worktreesRoot: resolveBase(input.workspaceSettings ?? {}),
    globalStorageRoot: input.globalStorageRoot,
    keepBundles: input.settings?.keepBundles ?? 3,
    liveBundleIds: input.liveBundleIds,
  });
}

export interface ReclaimReport {
  plan: ReclaimPlan;
  result?: ReclaimResult;
  /** the lines a human reads — identical whether this ran automatically or by command. */
  lines: string[];
}

export async function runReclaim(input: ReclaimRunInput & { apply: boolean }): Promise<ReclaimReport> {
  const plan = await planWorkspaceReclaim(input);
  const lines = summarizeReclaimPlan(plan);
  if (!input.apply || (plan.collect.length === 0 && plan.quarantine.length === 0)) {
    return { plan, lines: lines.length > 0 ? lines : ["nothing to reclaim"] };
  }
  const result = applyReclaim(plan, {
    quarantineRoot: input.quarantineRoot ?? reclaimQuarantineRoot(),
    now: input.now ?? new Date(),
  });
  const freed = `${(result.bytesFreed / 1_000_000_000).toFixed(2)}GB reclaimed`;
  const reported = [
    freed,
    ...(result.quarantined.length > 0 ? [`${result.quarantined.length} dead workspace state(s) moved to ${input.quarantineRoot ?? reclaimQuarantineRoot()} — kept, not deleted`] : []),
    ...(result.failed.length > 0 ? [`${result.failed.length} entr(y|ies) could not be removed`] : []),
  ];
  return { plan, result, lines: reported };
}

/** Start-up pass: silent when there is nothing to do, one line when there is. */
export async function reclaimOnStart(input: ReclaimRunInput = {}): Promise<ReclaimReport | undefined> {
  if (input.settings?.enabled === false) return undefined;
  const report = await runReclaim({ ...input, apply: true });
  return report.result ? report : undefined;
}
