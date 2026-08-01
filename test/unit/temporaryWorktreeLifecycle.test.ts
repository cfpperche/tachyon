import { describe, expect, it } from "vitest";
import { registerTools } from "../../src/bridge/tools.js";
import { executeExtensionCommand } from "../../src/engine-service/extensionOperationService.js";
import type { WorktreeRecord } from "../../src/worktree/WorktreeManager.js";

/**
 * t-d06da3 (spec 484) — the two lifecycle doors that open once a Temporary child may own a worktree.
 *
 * Neither of these was reachable before: `spawn_agent worktree:true` was refused for a Temporary AI
 * agent, so nothing a Temporary owned could be stranded. Lifting that refusal turns both of them from
 * dead code into product behaviour, which is why they are pinned here rather than left to be
 * discovered by the first coordinator that dismisses a child.
 *
 * DISMISS was measured to be a THIRD door. `extensionOperationService` already ran
 * `removeAgentWorktree` before dismissing, generically, and `agentRemovalCascade` was extracted by
 * t-e722ce "so BOTH doors can call the same code instead of two copies drifting" — while the Bridge's
 * `dismiss_agent` called `dismissTemporary` and nothing else. The fix is the call, not a new cascade,
 * so these tests drive the REAL cascade through fake ports: what they assert is that the ledger, the
 * registry and the occupancy gates all moved, not that one function called another.
 *
 * PROMOTION was measured to be safe by accident. It writes `addAgent(text, agent, cmd, "terminal")` —
 * cmd and kind only — and a terminal entry may not declare `worktree` at all, so it cannot carry
 * isolation; it is protected today only because it separately refuses every instance that is not a
 * terminal, and a worktree is an Agent capability. That is an incidental exclusion holding up an
 * acceptance criterion, which is exactly the shape that breaks silently later.
 */

class ToolCapture {
  handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>>();
  registerTool(
    name: string,
    _schema: unknown,
    handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>,
  ) {
    this.handlers.set(name, handler);
  }
}

const RECORD: WorktreeRecord = {
  path: "/checkouts/child",
  branch: "tachyon/child",
  tachyonCreatedBranch: true,
  baseRef: "0f0f0f0",
  createdAt: "2026-08-01T00:00:00.000Z",
};

interface DismissWorld {
  events: string[];
  notices: Array<{ message: string; level: string }>;
  ledger: Map<string, { worktree?: WorktreeRecord }>;
  registry: Map<string, WorktreeRecord | null>;
  dismiss: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
}

/**
 * A Bridge whose dismiss door is wired to the real cascade over recording ports. Everything the
 * cascade touches is observable: the two records that claim the checkout, git's removal, and every
 * occupancy question asked on the way.
 */
function dismissWorld(opts: {
  owns?: boolean;
  dead?: boolean;
  descendants?: string[];
  occupancy?: Array<{ state: "free" | "occupied" | "unknown"; detail?: string }>;
  branchDeleted?: boolean;
} = {}): DismissWorld {
  const events: string[] = [];
  const notices: Array<{ message: string; level: string }> = [];
  const ledger = new Map<string, { worktree?: WorktreeRecord }>([
    ["child", opts.owns === false ? {} : { worktree: RECORD }],
  ]);
  const registry = new Map<string, WorktreeRecord | null>([["child", opts.owns === false ? null : RECORD]]);
  // Default: a stopped-but-present pane, which is what a finished Temporary child actually looks like
  // to tmux, then free once the cascade's gate has killed it.
  const verdicts = opts.occupancy ?? [{ state: "occupied" as const, detail: "a stopped pane is still present in tmux" }, { state: "free" as const }];
  let probe = 0;
  const manager = {
    list: async () => [{ name: "child", lifetime: "temporary", running: false, dead: opts.dead === true }],
    liveDescendants: async () => opts.descendants ?? [],
    probeAgentOccupancy: async () => {
      events.push("probe");
      return verdicts[Math.min(probe++, verdicts.length - 1)]!;
    },
    kill: async () => { events.push("kill"); },
    releaseOwnedWorktreeForRemoval: async () => { events.push("release"); },
    dismissTemporary: () => { events.push("dismiss-row"); ledger.delete("child"); },
  };
  const mcp = new ToolCapture();
  registerTools(mcp as never, {
    workspaceRoot: "/repo",
    caller: { kind: "agent", name: "ada" },
    notify: (message: string, level: string) => { notices.push({ message, level }); },
    manager,
    agentWorktrees: {
      manager,
      ledger: {
        get: (agent: string) => ledger.get(agent),
        clearWorktree: (agent: string) => { events.push("ledger-clear"); const row = ledger.get(agent); if (row) delete row.worktree; },
      },
      worktrees: {
        remove: async (rec: WorktreeRecord, deleteBranch: boolean) => {
          events.push(`git-remove ${rec.path} deleteBranch=${deleteBranch}`);
          return { removed: true, branchDeleted: opts.branchDeleted ?? true };
        },
      },
      managedWorktrees: {
        syncAgentRecord: (agent: string, rec: WorktreeRecord | null) => { events.push("registry-sync"); registry.set(agent, rec); },
      },
    },
  } as never);
  return { events, notices, ledger, registry, dismiss: mcp.handlers.get("dismiss_agent")!, };
}

describe("t-d06da3 — dismiss_agent takes the child's worktree with it", () => {
  it("runs the SHARED cascade before the row is dropped, and leaves neither record claiming the checkout", async () => {
    const world = dismissWorld();

    const result = await world.dismiss({ name: "child" });

    expect(result.isError).toBeFalsy();
    // The order is the whole point: the ledger row OWNS the record the cascade reads, so a dismissal
    // that ran first would leave `removeAgentWorktree` with nothing to remove and the checkout behind.
    expect(world.events.indexOf("git-remove /checkouts/child deleteBranch=true")).toBeLessThan(world.events.indexOf("dismiss-row"));
    expect(world.events).toContain("ledger-clear");
    expect(world.registry.get("child")).toBeNull(); // `.tachyon/managed-worktrees.json` no longer lists it
    expect(result.content[0]?.text).toContain("/checkouts/child");
  });

  /**
   * The gate that matters MOST for a Temporary and least for a Saved Agent, and the reason reusing
   * this cascade is not ceremony: a parented child with no `worktree:true` runs in its PARENT's cwd by
   * construction, so dismissing an isolated parent while a child still runs there deletes the ground
   * under a live agent. Only the Temporary lifecycle can build that arrangement.
   */
  it("refuses while a descendant is still live in that checkout, and keeps the row", async () => {
    const world = dismissWorld({ descendants: ["grandchild"] });

    const result = await world.dismiss({ name: "child" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("grandchild");
    expect(world.events).not.toContain("git-remove /checkouts/child deleteBranch=true");
    expect(world.events).not.toContain("dismiss-row"); // a refused removal must not half-dismiss
  });

  /**
   * t-4736b4's lesson, inherited: the `running` flag this door checks first comes from
   * `manager.list()`, the last-known-good inventory, which lies in both directions on a removal path.
   * The cascade re-asks and MEASURES, so a pane the snapshot called stopped is killed before git is
   * asked to remove the checkout underneath it.
   */
  it("measures occupancy rather than trusting the listing, and kills a pane the listing called stopped", async () => {
    const world = dismissWorld();

    await world.dismiss({ name: "child" });

    expect(world.events.slice(0, 4)).toEqual(["probe", "kill", "probe", "release"]);
  });

  it("refuses when occupancy cannot be measured, and destroys nothing", async () => {
    const world = dismissWorld({ occupancy: [{ state: "unknown", detail: "the tmux server did not answer" }] });

    const result = await world.dismiss({ name: "child" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("unverifiable");
    expect(world.events).not.toContain("ledger-clear");
    expect(world.ledger.get("child")?.worktree).toEqual(RECORD);
  });

  /**
   * Criterion 3's recoverable half. `WorktreeManager.remove` deletes the branch with `git branch -d`,
   * so a branch carrying commits that were never merged SURVIVES the dismissal — and the human is the
   * only one who can act on that, so it is said out loud rather than left in a return value.
   */
  it("says so when the branch outlives the checkout because its commits were never merged", async () => {
    const world = dismissWorld({ branchDeleted: false });

    const result = await world.dismiss({ name: "child" });

    expect(result.content[0]?.text).toContain("tachyon/child");
    expect(world.notices).toContainEqual(expect.objectContaining({ level: "warn" }));
    expect(world.notices[0]?.message).toContain("KEPT");
  });

  /**
   * A `dead` entry is what a finished child usually IS (a remain-on-exit postmortem pane), so this is
   * the common path, not an edge. The cascade's occupancy gate already tore the pane down through the
   * same `manager.kill` this branch used to call; calling it again would throw AgentNotRunningError
   * and turn a completed dismissal into an error.
   */
  it("does not kill a postmortem pane twice when the cascade already did", async () => {
    const world = dismissWorld({ dead: true });

    const result = await world.dismiss({ name: "child" });

    expect(result.isError).toBeFalsy();
    expect(world.events.filter((e) => e === "kill")).toHaveLength(1);
    expect(world.events).toContain("dismiss-row");
  });

  /** Non-vacuity, and the promise that this change costs an entry that owns nothing exactly nothing. */
  it("leaves a Temporary with no checkout dismissing exactly as it did before", async () => {
    const world = dismissWorld({ owns: false });

    const result = await world.dismiss({ name: "child" });

    expect(result.content[0]?.text).toBe("agent 'child' dismissed");
    expect(world.events).toEqual(["dismiss-row"]); // no probe, no release, no git
  });
});

/** The narrow slice of the Workspace `config.agent.promote` reaches, with every write recorded. */
function promoteWorld(opts: { worktree?: WorktreeRecord; kind?: "agent" | "terminal"; resume?: boolean }) {
  const writes: string[] = [];
  const workspace = {
    ledger: {
      get: () => ({
        def: { cmd: "codex", kind: opts.kind ?? "agent" },
        ...(opts.worktree ? { worktree: opts.worktree } : {}),
        ...(opts.resume ? { resume: { runtime: "codex", sessionId: "s" } } : {}),
      }),
      record: () => { writes.push("ledger-record"); },
      remove: () => { writes.push("ledger-remove"); },
    },
    config: { agents: {} },
    mutateConfig: (mutate: (text: string) => { text: string }) => {
      writes.push(`config:${mutate("agents: {}\n").text}`);
      return true;
    },
    manager: { forgetTemporary: () => { writes.push("forget-temporary"); } },
  };
  return { writes, workspace };
}

const promote = (workspace: unknown, agent: string): Promise<unknown> => executeExtensionCommand(
  { workspace, onViewsChanged: () => {} } as unknown as Parameters<typeof executeExtensionCommand>[0],
  { action: "config.agent.promote", agent } as Parameters<typeof executeExtensionCommand>[1],
);

describe("t-d06da3 — promotion does not orphan a checkout by omission", () => {
  /**
   * The measurement the guard exists for, asserted against the real writer rather than quoted from a
   * note: what promotion puts in `tachyon.yml` is a terminal entry with a cmd, and there is no
   * isolation in it. Anything this door promotes therefore lands somewhere else on its next launch.
   */
  it("writes a profile that says nothing about isolation", async () => {
    const { writes, workspace } = promoteWorld({ kind: "terminal" });

    await promote(workspace, "helper");

    const written = writes.find((w) => w.startsWith("config:"))!;
    expect(written).toContain("cmd: codex");
    expect(written).toContain("kind: terminal");
    expect(written).not.toContain("worktree");
  });

  it("refuses an instance that owns a checkout, and names the checkout it would have left behind", async () => {
    const { writes, workspace } = promoteWorld({ worktree: RECORD, kind: "terminal" });

    await expect(promote(workspace, "helper")).rejects.toThrow(/\/checkouts\/child/);
    // Nothing may move: a promotion that wrote the profile and then failed would leave the agent
    // declared, relocated on its next launch, and still owning a tree nobody removes.
    expect(writes).toEqual([]);
  });

  /**
   * The pin, and the reason this guard is not dead code sitting behind the kind gate. A worktree is an
   * Agent capability (`asAgent(def)` — a terminal never reaches the create path), so today the only
   * instances that can own one are refused by the kind gate anyway. That refusal says "only a terminal
   * instance can be saved", which tells the human nothing about the checkout they are standing in.
   */
  it("tells an isolated AI child about its checkout, not just that it is the wrong kind", async () => {
    const { workspace } = promoteWorld({ worktree: RECORD, kind: "agent" });

    await expect(promote(workspace, "helper")).rejects.toThrow(/git worktree/);
    await expect(promote(workspace, "helper")).rejects.not.toThrow(/only a terminal instance/);
  });
});
