import { describe, it, expect } from "vitest";
import { loadPipeline, type PipelineDef } from "../../src/pipeline/loadPipeline.js";
import {
  initRun,
  runnableNodes,
  startNode,
  completeNode,
  approveNode,
  failNode,
  rejectNode,
  runStatus,
} from "../../src/pipeline/runState.js";

const AGENTS = new Set(["researcher", "coder", "reviewer"]);

// research → implement → review(gate:approve)
const LINEAR = loadPipeline(
  `name: feature
nodes:
  research: {agent: researcher, task: r, done: signal, timeout: 20m}
  implement: {agent: coder, task: i, needs: [research], done: signal_then_verify, timeout: 45m}
  review: {agent: reviewer, task: v, needs: [implement], done: signal, gate: approve, timeout: 30m}
`,
  AGENTS,
).pipeline!;

// diamond: a → (b, c) → d. Built directly: the state machine supports DAGs (Phase 2), but the v1
// loader rejects fan-in/fan-out for worktree:own, so we don't construct this via loadPipeline.
const DIAMOND: PipelineDef = {
  name: "dia",
  worktree: "own",
  nodes: {
    a: { cmd: "x", task: "t", needs: [], done: "exit", timeoutMs: 1000 },
    b: { cmd: "x", task: "t", needs: ["a"], done: "exit", timeoutMs: 1000 },
    c: { cmd: "x", task: "t", needs: ["a"], done: "exit", timeoutMs: 1000 },
    d: { cmd: "x", task: "t", needs: ["b", "c"], done: "exit", timeoutMs: 1000 },
  },
};

describe("runState — happy path", () => {
  it("initRun sets all nodes pending; only the root is runnable", () => {
    const run = initRun("r1", LINEAR, "run-r1");
    expect(Object.values(run.nodes).every((n) => n.status === "pending")).toBe(true);
    expect(runnableNodes(run)).toEqual(["research"]);
    expect(runStatus(run)).toBe("running");
  });

  it("a node becomes runnable only after its dependency is done", () => {
    let run = initRun("r1", LINEAR, "run-r1");
    run = completeNode(startNode(run, "research"), "research");
    expect(run.nodes.research.status).toBe("done");
    expect(runnableNodes(run)).toEqual(["implement"]);
  });

  it("a gate:approve node parks in awaiting-approval, then approve → done completes the run", () => {
    let run = initRun("r1", LINEAR, "run-r1");
    run = completeNode(startNode(run, "research"), "research");
    run = completeNode(startNode(run, "implement"), "implement");
    run = completeNode(startNode(run, "review"), "review");
    expect(run.nodes.review.status).toBe("awaiting-approval");
    expect(runStatus(run)).toBe("paused");
    run = approveNode(run, "review");
    expect(run.nodes.review.status).toBe("done");
    expect(runStatus(run)).toBe("completed");
  });
});

describe("runState — failure cascade", () => {
  it("failing a node blocks all transitive downstream nodes with the reason; run = failed", () => {
    let run = initRun("r1", LINEAR, "run-r1");
    run = startNode(run, "research");
    run = failNode(run, "research", "boom");
    expect(run.nodes.research).toEqual({ status: "failed", reason: "boom" });
    expect(run.nodes.implement).toEqual({ status: "blocked", reason: "upstream 'research' failed" });
    expect(run.nodes.review).toEqual({ status: "blocked", reason: "upstream 'research' failed" });
    expect(runStatus(run)).toBe("failed");
    expect(runnableNodes(run)).toEqual([]);
  });

  it("reject at the approval gate fails the node", () => {
    let run = initRun("r1", LINEAR, "run-r1");
    run = completeNode(startNode(run, "research"), "research");
    run = completeNode(startNode(run, "implement"), "implement");
    run = completeNode(startNode(run, "review"), "review");
    run = rejectNode(run, "review");
    expect(run.nodes.review).toMatchObject({ status: "failed", reason: "rejected at approval gate" });
    expect(runStatus(run)).toBe("failed");
  });
});

describe("runState — diamond fan-in", () => {
  it("d is runnable only after BOTH b and c are done", () => {
    let run = initRun("r1", DIAMOND, "run-r1");
    run = completeNode(startNode(run, "a"), "a");
    expect(runnableNodes(run).sort()).toEqual(["b", "c"]);
    run = completeNode(startNode(run, "b"), "b");
    expect(runnableNodes(run)).toEqual(["c"]); // d still waits on c
    run = completeNode(startNode(run, "c"), "c");
    expect(runnableNodes(run)).toEqual(["d"]);
    run = completeNode(startNode(run, "d"), "d");
    expect(runStatus(run)).toBe("completed");
  });

  it("failing one fan-in parent blocks the join node", () => {
    let run = initRun("r1", DIAMOND, "run-r1");
    run = completeNode(startNode(run, "a"), "a");
    run = failNode(run, "b", "b broke");
    expect(run.nodes.d.status).toBe("blocked");
    expect(run.nodes.c.status).toBe("pending"); // c is independent of b — not blocked
    expect(runnableNodes(run)).toEqual(["c"]);
  });
});
