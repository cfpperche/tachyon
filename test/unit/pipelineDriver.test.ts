import { describe, it, expect } from "vitest";
import { loadPipeline } from "../../src/pipeline/loadPipeline.js";
import { initRun, startNode } from "../../src/pipeline/runState.js";
import { advance } from "../../src/pipeline/pipelineDriver.js";

const AGENTS = new Set(["researcher", "coder", "reviewer"]);

const LINEAR = loadPipeline(
  `name: feature
nodes:
  research: {agent: researcher, task: r, done: signal, timeout: 20m}
  implement: {agent: coder, task: i, needs: [research], done: signal_then_verify, timeout: 45m}
`,
  AGENTS,
).pipeline!;

describe("advance — spawning", () => {
  it("spawns the root node from a fresh run", () => {
    const { run, actions } = advance(initRun("r", LINEAR, "run-r"), {});
    expect(actions).toEqual([{ type: "spawn", nodeId: "research" }]);
    expect(run.nodes.research.status).toBe("pending"); // driver doesn't mark running — the adapter does on spawn
  });

  it("does not re-spawn a node already running", () => {
    const run = startNode(initRun("r", LINEAR, "run-r"), "research");
    const { actions } = advance(run, { research: {} });
    expect(actions).toEqual([]); // research is running (pending signal), implement still blocked by deps
  });

  it("spawns a downstream node once its dependency is done", () => {
    let run = startNode(initRun("r", LINEAR, "run-r"), "research");
    // research signalled → done; advance should transition it and spawn implement
    const res = advance(run, { research: { signalled: true } });
    expect(res.run.nodes.research.status).toBe("done");
    expect(res.actions).toEqual([{ type: "spawn", nodeId: "implement" }]);
  });
});

describe("advance — verify gate request", () => {
  it("requests verify for a running signal_then_verify node that has signalled", () => {
    let run = startNode(initRun("r", LINEAR, "run-r"), "research");
    run = advance(run, { research: { signalled: true } }).run; // research done
    run = startNode(run, "implement");
    const { actions } = advance(run, { implement: { signalled: true } });
    expect(actions).toEqual([{ type: "runVerify", nodeId: "implement" }]);
  });

  it("does NOT re-request verify once it's been requested", () => {
    let run = startNode(initRun("r", LINEAR, "run-r"), "research");
    run = advance(run, { research: { signalled: true } }).run;
    run = startNode(run, "implement");
    const { actions } = advance(run, { implement: { signalled: true } }, new Set(["implement"]));
    expect(actions).toEqual([]); // verify already in flight
  });

  it("completes the node when verify comes back green and not stale", () => {
    let run = startNode(initRun("r", LINEAR, "run-r"), "research");
    run = advance(run, { research: { signalled: true } }).run;
    run = startNode(run, "implement");
    const res = advance(run, { implement: { signalled: true, verify: { passed: true, stale: false } } }, new Set(["implement"]));
    expect(res.run.nodes.implement.status).toBe("done");
    expect(res.actions).toEqual([]);
  });
});

describe("advance — failure", () => {
  it("fails a node on a red verify and blocks nothing downstream of a leaf", () => {
    let run = startNode(initRun("r", LINEAR, "run-r"), "research");
    run = advance(run, { research: { signalled: true } }).run;
    run = startNode(run, "implement");
    const res = advance(run, { implement: { signalled: true, verify: { passed: false, stale: false } } }, new Set(["implement"]));
    expect(res.run.nodes.implement).toMatchObject({ status: "failed", reason: "verify gate red" });
    expect(res.actions).toEqual([]);
  });

  it("fails a node on timeout and stops spawning downstream", () => {
    const run = startNode(initRun("r", LINEAR, "run-r"), "research");
    const res = advance(run, { research: { timedOut: true } });
    expect(res.run.nodes.research).toMatchObject({ status: "failed", reason: "timed out" });
    expect(res.run.nodes.implement.status).toBe("blocked");
    expect(res.actions).toEqual([]);
  });
});
