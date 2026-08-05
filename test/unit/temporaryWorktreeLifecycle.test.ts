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
 * PROMOTION was measured to be safe by accident. It writes
 * `upsertAgent(text, agent, { cmd }, undefined, "terminals")` (t-c1ef82 — it used to write into
 * `agents:`, a shape the reader refuses) — cmd only — and a terminal entry may not declare
 * `worktree` at all, so it cannot carry
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
  kill: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
  uiRemove: () => Promise<unknown>;
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
  dirty?: boolean;
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
    // t-bec361 — the caller below is 'ada', and a Temporary child that owns a checkout got that
    // checkout by being SPAWNED by someone. Saying so is what makes this fake faithful to the
    // production shape the cascade runs in: the coordinator stopping its own finished child.
    parentOf: (agent: string) => (agent === "child" ? "ada" : undefined),
    probeAgentOccupancy: async () => {
      events.push("probe");
      return verdicts[Math.min(probe++, verdicts.length - 1)]!;
    },
    // Real AgentManager.kill collects a non-persistent Temporary row — but since t-28bf8f, ONLY once
    // that row no longer records a checkout. A stop that collected a still-owning row would strand the
    // checkout, its branch and its registry entry with no door left addressing them, so a row mid-cascade
    // survives here exactly as it does in production, and the end-of-life door collects it afterwards.
    kill: async () => {
      events.push("kill");
      if (!ledger.get("child")?.worktree) ledger.delete("child");
    },
    releaseOwnedWorktreeForRemoval: async () => { events.push("release"); },
    dismissTemporary: () => { events.push("dismiss-row"); ledger.delete("child"); },
  };
  const mcp = new ToolCapture();
  const agentWorktrees = {
    manager,
    ledger: {
      get: (agent: string) => ledger.get(agent),
      clearWorktree: (agent: string) => { events.push("ledger-clear"); const row = ledger.get(agent); if (row) delete row.worktree; },
    },
    worktrees: {
      remove: async (rec: WorktreeRecord, deleteBranch: boolean, removeOpts: { force: boolean; refuseUnlessForceIfDirty: boolean }) => {
        events.push(`git-remove ${rec.path} deleteBranch=${deleteBranch} force=${removeOpts.force} probeDirty=${removeOpts.refuseUnlessForceIfDirty}`);
        if (opts.dirty) return { removed: false, branchDeleted: false, error: `worktree is dirty at ${rec.path}; pass confirmDirty=true to force-remove uncommitted work` };
        return { removed: true, branchDeleted: opts.branchDeleted ?? true };
      },
    },
    managedWorktrees: {
      syncAgentRecord: (agent: string, rec: WorktreeRecord | null) => { events.push("registry-sync"); registry.set(agent, rec); },
    },
  };
  registerTools(mcp as never, {
    workspaceRoot: "/repo",
    caller: { kind: "agent", name: "ada" },
    notify: (message: string, level: string) => { notices.push({ message, level }); },
    manager,
    agentWorktrees,
  } as never);
  return {
    events,
    notices,
    ledger,
    registry,
    dismiss: mcp.handlers.get("dismiss_agent")!,
    kill: mcp.handlers.get("kill_agent")!,
    uiRemove: () => executeExtensionCommand(
      { workspace: agentWorktrees, onViewsChanged: () => {} } as unknown as Parameters<typeof executeExtensionCommand>[0],
      { action: "worktree.remove", agent: "child" } as Parameters<typeof executeExtensionCommand>[1],
    ),
  };
}

describe("t-46554c — Temporary end-of-life doors prove their worktree effects", () => {
  /**
   * The sidebar's Remove command was measured before this test was written. For an agent that owns a
   * checkout it first executes `worktree.remove`; only after that succeeds does it execute
   * `config.agent.delete` with `removeWorktree: false`. Thus the call inside deleteConfiguredAgent is
   * not the UI door at all. Exercise the operation the human really invokes, including the shared
   * soft-removal arguments and both durable ownership records.
   */
  it("UI Remove deletes checkout, branch and both ownership records through its real first operation", async () => {
    const world = dismissWorld();

    const result = await world.uiRemove();

    expect(result).toMatchObject({ removed: true, branchDeleted: true });
    expect(world.events).toEqual([
      "probe",
      "kill",
      "probe",
      "release",
      "git-remove /checkouts/child deleteBranch=true force=false probeDirty=true",
      // t-28bf8f — registry BEFORE ledger. Both are file writes and the second can fail; only this
      // order fails into a state a door can still finish (a row still owning an unregistered checkout)
      // rather than the one that has none (a registry entry whose owning row is gone).
      "registry-sync",
      "ledger-clear",
    ]);
    expect(world.registry.get("child")).toBeNull();
  });

  it("Bridge kill removes checkout, branch, registry and row through the shared cascade", async () => {
    const world = dismissWorld();

    const result = await world.kill({ name: "child" });

    expect(result.isError).toBeFalsy();
    expect(world.events).toEqual([
      "probe",
      "kill",
      "probe",
      "release",
      "git-remove /checkouts/child deleteBranch=true force=false probeDirty=true",
      "registry-sync",
      "ledger-clear",
      // t-28bf8f — the row is collected LAST, by this door, and only because everything above it
      // succeeded. The `kill` three lines up is the cascade's occupancy gate and no longer collects it.
      "dismiss-row",
    ]);
    expect(world.ledger.has("child")).toBe(false);
    expect(world.registry.get("child")).toBeNull();
    expect(result.content[0]?.text).toContain("branch 'tachyon/child' was deleted");
  });
});

describe("t-d06da3 — dismiss_agent takes the child's worktree with it", () => {
  // Reachability measurement: a RUNNING Temporary cannot arrive here owning its checkout because
  // kill_agent collects it through the kill door first. A finished child, however, remains as the
  // stopped/postmortem row modelled by dismissWorld's default inventory, and that is the real
  // dismiss_agent path exercised below.
  it("runs the SHARED cascade before the row is dropped, and leaves neither record claiming the checkout", async () => {
    const world = dismissWorld();

    const result = await world.dismiss({ name: "child" });

    expect(result.isError).toBeFalsy();
    // The order is the whole point: the ledger row OWNS the record the cascade reads, so a dismissal
    // that ran first would leave `removeAgentWorktree` with nothing to remove and the checkout behind.
    expect(world.events.indexOf("git-remove /checkouts/child deleteBranch=true force=false probeDirty=true")).toBeLessThan(world.events.indexOf("dismiss-row"));
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
    expect(world.events.some((event) => event.startsWith("git-remove "))).toBe(false);
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

  it("refuses a dirty checkout and keeps its durable registry record", async () => {
    const world = dismissWorld({ dirty: true });

    const result = await world.dismiss({ name: "child" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("dirty");
    expect(world.events).toContain("git-remove /checkouts/child deleteBranch=true force=false probeDirty=true");
    expect(world.events).not.toContain("ledger-clear");
    expect(world.events).not.toContain("dismiss-row");
    // t-28bf8f — this line used to read `false`, with a comment explaining that teardown of the stopped
    // pane collects the row before Git can measure dirtiness. That was the defect, pinned as behaviour:
    // the preserved checkout stayed hygiene-visible through the registry, but the AGENT that owned it —
    // the only handle the four name-addressed end-of-life doors accept — was gone, so nothing could
    // retry the dismissal once the tree was cleaned. A refused removal now moves neither record.
    expect(world.ledger.has("child")).toBe(true);
    expect(world.ledger.get("child")?.worktree).toEqual(RECORD);
    expect(world.registry.get("child")).toEqual(RECORD);
  });

  /**
   * t-eb25ba — GUARD: following the refusal's instruction must be possible. WorktreeManager still
   * says "pass confirmDirty=true" (true for remove_worktree); agent end-of-life doors never accept
   * that parameter. The cascade rewrites so the message names commit-or-discard + retry.
   */
  it("dirty refusal names commit/discard retry, not confirmDirty=true (t-eb25ba)", async () => {
    const world = dismissWorld({ dirty: true });

    const result = await world.dismiss({ name: "child" });
    const text = result.content[0]?.text ?? "";

    expect(result.isError).toBe(true);
    expect(text).toMatch(/commit|discard/i);
    expect(text).toMatch(/retry/i);
    expect(text).not.toMatch(/pass confirmDirty=true/);
    // Still tells the truth about where confirmDirty lives, without instructing the caller to use it here.
    expect(text).toMatch(/remove_worktree/);
  });

  it("kill_agent dirty refusal also refuses confirmDirty instruction (t-eb25ba)", async () => {
    const world = dismissWorld({ dirty: true });

    const result = await world.kill({ name: "child" });
    const text = result.content[0]?.text ?? "";

    expect(result.isError).toBe(true);
    expect(text).toMatch(/commit|discard/i);
    expect(text).not.toMatch(/pass confirmDirty=true/);
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
    // t-c1ef82 — the BLOCK carries the kind now, and that is the point rather than a detail: a
    // terminal written into `agents:` with `kind: terminal` beside it is the retired inline form the
    // loader refuses. Asserting the block is what proves the entry is readable at all.
    expect(written).toMatch(/terminals:[\s\S]*helper:/);
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
