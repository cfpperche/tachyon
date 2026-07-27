import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentManager } from "../../src/agents/AgentManager.js";
import { pruneDeliveryRecord } from "../../src/git-delivery/prune.js";
import type { GitDelivery } from "../../src/git-delivery/types.js";
import { SessionLedger } from "../../src/resume/SessionLedger.js";
import type { GitExec, GitResult, WorktreeOccupancyProbe } from "../../src/worktree/WorktreeManager.js";
import { makeTempDir } from "../helpers/tempDir.js";

const actor = { kind: "agent" as const, name: "owner" };

function tmpRoot(): string {
  return makeTempDir("tachyon-prune-occupancy-");
}

function delivery(worktreePath: string): GitDelivery {
  return {
    schemaVersion: 1,
    id: "gd-occupancy",
    deliveryId: "d-occupancy",
    version: 1,
    workspaceId: "ws",
    createdBy: actor,
    agent: "original-dead",
    branchRef: "tachyon/original-dead",
    worktreePath,
    tachyonCreatedBranch: true,
    baseRef: "main",
    currentHeadSha: "tip",
    phase: "integrated",
    taskLinks: [],
    transitions: [],
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
  };
}

const ok = (stdout = ""): GitResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = ""): GitResult => ({ code: 1, stdout: "", stderr });

async function pruneWith(occupancy?: WorktreeOccupancyProbe): Promise<{ ok: boolean; reasons: string[]; calls: string[] }> {
  const root = tmpRoot();
  const wt = path.join(root, "wt");
  fs.mkdirSync(wt);
  const calls: string[] = [];
  const git: GitExec = async (args) => {
    calls.push(args.join(" "));
    if (args[0] === "show-ref" || args[0] === "merge-base") return ok();
    if (args[0] === "rev-parse") return ok("tip\n");
    if (args[0] === "status") return ok("");
    if (args[0] === "worktree" && args[1] === "list") return ok(`worktree ${wt}\nbranch refs/heads/tachyon/original-dead\n`);
    if (args[0] === "worktree" && args[1] === "remove") return ok();
    if (args[0] === "branch" && args[1] === "-d") return ok();
    if (args[0] === "worktree" && args[1] === "prune") return ok();
    return fail(`unexpected git ${args.join(" ")}`);
  };
  const out = await pruneDeliveryRecord(delivery(wt), { id: "gd-occupancy", expectedVersion: 1 }, actor, {
    workspaceRoot: root,
    git,
    liveness: async () => "not_live",
    ...(occupancy ? { worktreeOccupancy: occupancy } : {}),
  });
  return { ok: out.result.ok, reasons: out.result.ok ? [] : out.result.reasons, calls };
}

describe("container-generated delegation behavior", () => {
  it("worktree removal is refused while any live agent occupies it, not merely when the delivery's original agent is dead", async () => {
    const occupied = await pruneWith(async (worktreePath) => ({ state: "live", agent: "different-live-agent", cwd: worktreePath }));
    expect(occupied.ok).toBe(false);
    expect(occupied.reasons).toContain("worktree is occupied by live agent different-live-agent");
    expect(occupied.calls.some((c) => c.startsWith("worktree remove --force"))).toBe(false);

    const unoccupied = await pruneWith(async () => undefined);
    expect(unoccupied.ok).toBe(true);
    expect(unoccupied.calls.some((c) => c.startsWith("worktree remove --force"))).toBe(true);

    const unknown = await pruneWith();
    expect(unknown.ok).toBe(false);
    expect(unknown.reasons).toContain("worktree occupancy is unknown");
    expect(unknown.calls.some((c) => c.startsWith("worktree remove --force"))).toBe(false);

    const root = tmpRoot();
    const wt = path.join(root, "wt");
    const subdir = path.join(wt, "nested");
    fs.mkdirSync(subdir, { recursive: true });
    const ledger = new SessionLedger(root);
    ledger.record("subdir-live-agent", { def: { cmd: "sh", kind: "agent" }, cwd: subdir, declared: false });
    const manager = new AgentManager({
      tmux: {
        sessionStates: async (prefix: string) => new Map([[`${prefix}subdir-live-agent`, { dead: false }]]),
        panePid: async () => undefined,
        hasSession: async () => true,
      } as never,
      wsHash: "ws",
      workspaceRoot: root,
      ledger,
      getConfig: () => undefined,
      getMaxAgents: () => 99,
    });
    await expect(manager.worktreeOccupant(wt)).resolves.toMatchObject({ state: "live", agent: "subdir-live-agent", cwd: subdir });
  });
});
