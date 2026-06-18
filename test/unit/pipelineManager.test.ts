import { describe, it, expect } from "vitest";
import { loadPipeline } from "../../src/pipeline/loadPipeline.js";
import { PipelineManager, type PipelineDeps, type SpawnNodeArgs } from "../../src/pipeline/PipelineManager.js";
import { runStatus, initRun } from "../../src/pipeline/runState.js";

const AGENTS = new Set(["researcher", "coder", "reviewer"]);

const PIPELINE = loadPipeline(
  `name: feature
nodes:
  research: {agent: researcher, task: r, done: signal, timeout: 20m}
  implement: {agent: coder, task: i, needs: [research], done: signal_then_verify, timeout: 45m}
  review: {agent: reviewer, task: v, needs: [implement], done: signal, gate: approve, timeout: 30m}
`,
  AGENTS,
).pipeline!;

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

function makeHarness(opts?: { verify?: (nodeId: string) => { passed: boolean; stale: boolean }; failSpawn?: Set<string> }) {
  const spawns: SpawnNodeArgs[] = [];
  const verifyCalls: string[] = [];
  const released: string[] = [];
  const dismissed: string[] = [];
  const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
  let nonceN = 0;

  const deps: PipelineDeps = {
    allocateWorktree: async (runId) => ({ cwd: `/wt/${runId}`, key: `run-${runId}` }),
    releaseWorktree: async (key) => void released.push(key),
    dismissNode: (_runId, nodeId) => void dismissed.push(nodeId),
    spawnNode: async (args) => {
      if (opts?.failSpawn?.has(args.nodeId)) throw new Error(`agent for '${args.nodeId}' is already running`);
      spawns.push(args);
    },
    runVerify: async ({ nodeId }) => {
      verifyCalls.push(nodeId);
      return opts?.verify ? opts.verify(nodeId) : { passed: true, stale: false };
    },
    mintNonce: () => `nonce-${++nonceN}`,
    genRunId: () => "r1",
    persist: () => {},
    setTimer: (ms, fn) => {
      const t = { ms, fn, cancelled: false };
      timers.push(t);
      return () => void (t.cancelled = true);
    },
  };
  const manager = new PipelineManager(deps);
  const nonceOf = (nodeId: string) => spawns.find((s) => s.nodeId === nodeId)!.env.TACHYON_NODE_NONCE;
  return { manager, spawns, verifyCalls, released, dismissed, timers, nonceOf };
}

describe("PipelineManager — full run", () => {
  it("drives research → implement(verify) → review(approve) to completion", async () => {
    const h = makeHarness();
    const id = await h.manager.start(PIPELINE);
    await settle();

    // research spawned into the run worktree with its nonce env
    expect(h.spawns.map((s) => s.nodeId)).toEqual(["research"]);
    expect(h.spawns[0].cwd).toBe("/wt/r1");
    expect(h.spawns[0].env).toMatchObject({ TACHYON_RUN_ID: "r1", TACHYON_NODE_ID: "research" });

    // research signals done → implement spawns
    await h.manager.completeSignal({ runId: id, nodeId: "research", nonce: h.nonceOf("research") });
    await settle();
    expect(h.spawns.map((s) => s.nodeId)).toEqual(["research", "implement"]);

    // implement signals → verify runs (green) → review spawns
    await h.manager.completeSignal({ runId: id, nodeId: "implement", nonce: h.nonceOf("implement") });
    await settle();
    expect(h.verifyCalls).toEqual(["implement"]);
    expect(h.spawns.map((s) => s.nodeId)).toEqual(["research", "implement", "review"]);

    // review signals → parks at the approval gate
    await h.manager.completeSignal({ runId: id, nodeId: "review", nonce: h.nonceOf("review") });
    await settle();
    expect(h.manager.getRun(id)!.nodes.review.status).toBe("awaiting-approval");
    expect(runStatus(h.manager.getRun(id)!)).toBe("paused");
    // the review agent stays ALIVE at the gate (so the human can inspect what they're approving)
    expect(h.dismissed).not.toContain("review");

    // human approves → completed → worktree released
    h.manager.approve(id, "review");
    await settle();
    expect(h.released).toEqual(["run-r1"]); // completed → worktree released
    expect(h.manager.getRun(id)).toBeUndefined(); // finalized → removed from memory
    // every spawned node's agent is dismissed when it reaches terminal (no lingering pl-* sessions)
    expect(h.dismissed.sort()).toEqual(["implement", "research", "review"]);
  });
});

describe("PipelineManager — failure paths", () => {
  it("a red verify fails the node, blocks downstream, releases the worktree", async () => {
    const h = makeHarness({ verify: () => ({ passed: false, stale: false }) });
    const id = await h.manager.start(PIPELINE);
    await settle();
    await h.manager.completeSignal({ runId: id, nodeId: "research", nonce: h.nonceOf("research") });
    await settle();
    await h.manager.completeSignal({ runId: id, nodeId: "implement", nonce: h.nonceOf("implement") });
    await settle();
    const run = h.manager.getRun(id)!; // a failed run is KEPT (Tier A: re-run-from-step / dismiss)
    expect(run.nodes.implement).toMatchObject({ status: "failed", reason: "verify gate red" });
    expect(run.nodes.review.status).toBe("blocked");
    expect(runStatus(run)).toBe("failed");
    expect(h.released).toEqual([]); // failed → worktree NOT released (kept for re-run / dismiss)
  });

  it("a node timeout fails the run", async () => {
    const h = makeHarness();
    const id = await h.manager.start(PIPELINE);
    await settle();
    expect(h.timers.length).toBe(1); // research's timeout armed
    h.timers[0].fn(); // fire it
    await settle();
    expect(h.manager.getRun(id)!.nodes.research).toMatchObject({ status: "failed", reason: "timed out" });
    expect(runStatus(h.manager.getRun(id)!)).toBe("failed");
  });
});

describe("PipelineManager — spawn contention never kills a contended session (codex B2)", () => {
  it("a failed spawn fails the node WITHOUT dismissing it (no ownership taken)", async () => {
    const h = makeHarness({ failSpawn: new Set(["research"]) });
    const id = await h.manager.start(PIPELINE);
    await settle();
    expect(h.manager.getRun(id)!.nodes.research.status).toBe("failed");
    expect(runStatus(h.manager.getRun(id)!)).toBe("failed");
    // the node was never owned → it must NOT be dismissed (which would kill the contended/manual session)
    expect(h.dismissed).not.toContain("research");
  });
});

describe("PipelineManager — re-run from a step (Tier A)", () => {
  it("a failed run keeps its worktree; re-run-from-node resets that node + downstream and re-runs", async () => {
    const h = makeHarness({ verify: () => ({ passed: false, stale: false }) });
    const id = await h.manager.start(PIPELINE);
    await settle();
    await h.manager.completeSignal({ runId: id, nodeId: "research", nonce: h.nonceOf("research") });
    await settle();
    await h.manager.completeSignal({ runId: id, nodeId: "implement", nonce: h.nonceOf("implement") }); // verify red → implement fails
    await settle();
    expect(h.manager.getRun(id)!.nodes.implement.status).toBe("failed");
    expect(h.released).toEqual([]); // failed run keeps its worktree

    // re-run from implement: it + review reset to pending, research stays done, and implement re-spawns
    const spawnsBefore = h.spawns.length;
    await h.manager.rerunFrom(id, "implement");
    await settle();
    const run = h.manager.getRun(id)!;
    expect(run.nodes.research.status).toBe("done"); // upstream kept
    expect(run.nodes.implement.status).toBe("running"); // re-spawned
    expect(run.nodes.review.status).toBe("pending"); // downstream reset
    expect(h.spawns.length).toBeGreaterThan(spawnsBefore); // implement was spawned again
  });

  it("dismiss releases the worktree of a kept (failed) run", async () => {
    const h = makeHarness({ verify: () => ({ passed: false, stale: false }) });
    const id = await h.manager.start(PIPELINE);
    await settle();
    await h.manager.completeSignal({ runId: id, nodeId: "research", nonce: h.nonceOf("research") });
    await settle();
    await h.manager.completeSignal({ runId: id, nodeId: "implement", nonce: h.nonceOf("implement") });
    await settle();
    expect(h.released).toEqual([]);
    h.manager.dismiss(id);
    await settle();
    expect(h.released).toEqual(["run-r1"]);
    expect(h.manager.getRun(id)).toBeUndefined();
  });
});

describe("PipelineManager — rehydrate after a reload (dogfood finding)", () => {
  it("restores a running run so a surviving agent's complete_node is accepted", async () => {
    // Simulate the post-reload world: a fresh manager with NO in-memory state, plus a run + nonce
    // persisted on disk (run ledger graph + session-ledger def.env nonce).
    const h = makeHarness();
    const run = initRun("r9", PIPELINE, "run-r9");
    const running = { ...run, nodes: { ...run.nodes, research: { status: "running" as const } } };
    h.manager.rehydrate([{ run: running, cwd: "/wt/r9", nonces: { research: "kept-nonce" } }]);
    await settle();

    // before rehydrate this would be "unknown or closed"; now the restored nonce authenticates
    const ok = await h.manager.completeSignal({ runId: "r9", nodeId: "research", nonce: "kept-nonce" });
    expect(ok).toEqual({ ok: true });
    await settle();
    expect(h.manager.getRun("r9")!.nodes.research.status).toBe("done");
    // and the chain resumes — implement spawns next
    expect(h.spawns.map((s) => s.nodeId)).toContain("implement");
  });

  it("rejects a forged nonce against a rehydrated run", async () => {
    const h = makeHarness();
    const run = initRun("r9", PIPELINE, "run-r9");
    const running = { ...run, nodes: { ...run.nodes, research: { status: "running" as const } } };
    h.manager.rehydrate([{ run: running, cwd: "/wt/r9", nonces: { research: "kept-nonce" } }]);
    await settle();
    expect(await h.manager.completeSignal({ runId: "r9", nodeId: "research", nonce: "forged" })).toMatchObject({ ok: false });
  });
});

describe("PipelineManager — complete_node auth", () => {
  it("rejects a bad nonce and leaves the node running", async () => {
    const h = makeHarness();
    const id = await h.manager.start(PIPELINE);
    await settle();
    const bad = await h.manager.completeSignal({ runId: id, nodeId: "research", nonce: "forged" });
    expect(bad).toEqual({ ok: false, reason: "invalid completion token" });
    expect(h.manager.getRun(id)!.nodes.research.status).toBe("running");
  });

  it("rejects a duplicate signal", async () => {
    const h = makeHarness();
    const id = await h.manager.start(PIPELINE);
    await settle();
    const nonce = h.nonceOf("research");
    const first = await h.manager.completeSignal({ runId: id, nodeId: "research", nonce });
    expect(first.ok).toBe(true);
    await settle();
    const second = await h.manager.completeSignal({ runId: id, nodeId: "research", nonce });
    expect(second).toMatchObject({ ok: false }); // research no longer running (it's done)
  });
});
