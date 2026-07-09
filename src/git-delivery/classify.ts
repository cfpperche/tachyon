import fs from "node:fs";
import type { GitExec } from "../worktree/WorktreeManager.js";
import type { TaskStore } from "../tasks/TaskStore.js";
import type { GitDelivery, GitDeliveryCorruptRecord, GitDeliveryListRow, GitDeliveryLiveState, HygieneFinding, HygieneReport } from "./types.js";

export type DeliveryLiveness = (agent: string) => Promise<"live" | "not_live" | "unknown">;

export interface ClassifyDeps {
  workspaceRoot: string;
  git: GitExec;
  liveness: DeliveryLiveness;
  tasks?: TaskStore;
  now?: () => string;
}

function hasIntegrationMetadata(delivery: GitDelivery): boolean {
  const integration = delivery.integration;
  if (!integration || !["cherry-pick", "merge", "patch-id"].includes(integration.kind)) return false;
  return !!(integration.integratedSha ?? delivery.integratedSha);
}

function patchesAllInBase(cherry: { code: number; stdout: string }): boolean {
  return cherry.code === 0 && cherry.stdout.split("\n").every((line) => line.trim() === "" || !line.trim().startsWith("+"));
}

export async function containedInBase(delivery: GitDelivery, currentHeadSha: string | undefined, deps: Pick<ClassifyDeps, "workspaceRoot" | "git">): Promise<boolean> {
  const tip = currentHeadSha || delivery.currentHeadSha;
  if (!tip) return false;
  const base = delivery.baseRef;
  const ancestry = await deps.git(["merge-base", "--is-ancestor", tip, base], deps.workspaceRoot);
  if (ancestry.code === 0) return true;
  if (!hasIntegrationMetadata(delivery)) return false;
  const integratedSha = (delivery.integration?.integratedSha ?? delivery.integratedSha)!;
  const integratedOnBase = await deps.git(["merge-base", "--is-ancestor", integratedSha, base], deps.workspaceRoot);
  if (integratedOnBase.code !== 0) return false;
  const cherry = await deps.git(["cherry", base, tip], deps.workspaceRoot);
  return patchesAllInBase(cherry);
}

export async function classifyDelivery(delivery: GitDelivery, deps: ClassifyDeps): Promise<GitDeliveryLiveState> {
  const reasons: string[] = [];
  const branch = await deps.git(["show-ref", "--verify", "--quiet", `refs/heads/${delivery.branchRef}`], deps.workspaceRoot).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  const branchExists = branch.code === 0;
  const worktreeExists = fs.existsSync(delivery.worktreePath);
  const missingRef = !branchExists || !worktreeExists;
  if (!branchExists) reasons.push("branch missing");
  if (!worktreeExists) reasons.push("worktree missing");

  let currentHeadSha: string | undefined;
  if (branchExists) {
    const head = await deps.git(["rev-parse", delivery.branchRef], deps.workspaceRoot).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    if (head.code === 0 && head.stdout.trim()) currentHeadSha = head.stdout.trim();
  }

  let clean = false;
  if (worktreeExists) {
    const status = await deps.git(["status", "--porcelain=v1", "--untracked-files=all"], delivery.worktreePath).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    clean = status.code === 0 && status.stdout.trim() === "";
    if (!clean) reasons.push(status.code === 0 ? "worktree dirty" : "worktree status unavailable");
  } else {
    reasons.push("worktree status unavailable");
  }

  const liveState = await deps.liveness(delivery.agent).catch((): "unknown" => "unknown");
  if (liveState !== "not_live") reasons.push(`agent liveness is ${liveState}`);
  const contained = await containedInBase(delivery, currentHeadSha, deps).catch(() => false);
  let cherryPickedWithoutMetadata = false;
  if (!contained) {
    const tip = currentHeadSha || delivery.currentHeadSha;
    if (tip && !hasIntegrationMetadata(delivery)) {
      const cherry = await deps.git(["cherry", delivery.baseRef, tip], deps.workspaceRoot).catch(() => ({ code: 1, stdout: "", stderr: "" }));
      cherryPickedWithoutMetadata = patchesAllInBase(cherry);
    }
    reasons.push(
      cherryPickedWithoutMetadata
        ? "not an ancestor of base, but every patch is already in base (likely cherry-picked without integration metadata)"
        : "branch tip is not contained in base",
    );
  }
  return { currentHeadSha, containedInBase: contained, cherryPickedWithoutMetadata, missingRef, branchExists, worktreeExists, clean, liveState, reasons };
}

export async function listRows(deliveries: GitDelivery[], deps: ClassifyDeps): Promise<GitDeliveryListRow[]> {
  return Promise.all(
    deliveries.map(async (delivery) => ({
      id: delivery.id,
      version: delivery.version,
      agent: delivery.agent,
      branchRef: delivery.branchRef,
      worktreePath: delivery.worktreePath,
      baseRef: delivery.baseRef,
      phase: delivery.phase,
      taskLinks: delivery.taskLinks,
      ...(delivery.review ? { review: delivery.review } : {}),
      ...(await classifyDelivery(delivery, deps)),
    })),
  );
}

export async function hygieneReport(deliveries: GitDelivery[], corrupt: GitDeliveryCorruptRecord[], deps: ClassifyDeps): Promise<HygieneReport> {
  const rows = await listRows(deliveries, deps);
  const findings: HygieneFinding[] = [];
  for (const corruptRecord of corrupt) {
    findings.push({ category: "corrupt_record", deliveryId: corruptRecord.id, reason: `${corruptRecord.path}: ${corruptRecord.error}` });
  }
  for (const row of rows) {
    if (row.missingRef && row.phase !== "pruned") findings.push({ category: "missing_ref", deliveryId: row.id, agent: row.agent, reason: row.reasons.join("; ") });
    if (row.phase === "integrated_unverified") findings.push({ category: "integrated_unverified", deliveryId: row.id, agent: row.agent, reason: "integration was asserted without git verification" });
    if (row.containedInBase && row.clean && row.liveState === "not_live" && (row.phase === "integrated" || row.phase === "open" || row.phase === "accepted")) {
      findings.push({ category: "ready_to_prune", deliveryId: row.id, agent: row.agent, reason: "branch is contained in base, worktree is clean, and agent is not live" });
    }
    if (row.cherryPickedWithoutMetadata) {
      findings.push({
        category: "cherry_pick_unrecorded",
        deliveryId: row.id,
        agent: row.agent,
        reason: "not an ancestor of base, but every patch is already in base (likely cherry-picked without integration metadata)",
      });
    }
    if (row.liveState === "not_live" && row.phase !== "pruned") findings.push({ category: "candidate_orphan", deliveryId: row.id, agent: row.agent, reason: "delivery agent is not live" });
    const delivery = deliveries.find((d) => d.id === row.id);
    for (const link of delivery?.taskLinks ?? []) {
      const task = deps.tasks?.get(link.taskId);
      if (task && (task.status === "landed" || task.status === "done") && !row.containedInBase && row.phase !== "integrated") {
        findings.push({ category: "landed_without_integrated", deliveryId: row.id, agent: row.agent, taskId: link.taskId, reason: `task ${link.taskId} is ${task.status}, but delivery is not git-verified integrated` });
      }
    }
  }
  return { generatedAt: deps.now?.() ?? new Date().toISOString(), findings, rows };
}
