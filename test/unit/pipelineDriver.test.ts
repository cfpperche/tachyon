import { describe, it, expect } from "vitest";
import { loadPipeline } from "@tachyon/engine/pipeline/loadPipeline.js";
import { initRun, startNode } from "@tachyon/engine/pipeline/runState.js";
import { advance } from "@tachyon/engine/pipeline/pipelineDriver.js";

const AGENTS = new Set(["researcher", "coder", "reviewer"]);

const LINEAR = loadPipeline(
  `name: feature
nodes:
  research: {agent: researcher, task: r, done: signal, timeout: 20m}
  implement: {agent: coder, task: i, needs: [research], done: signal, timeout: 45m}
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

describe("advance — signal completion", () => {
  it("completes a running signal node as soon as it has signalled", () => {
    let run = startNode(initRun("r", LINEAR, "run-r"), "research");
    run = advance(run, { research: { signalled: true } }).run; // research done
    run = startNode(run, "implement");
    const res = advance(run, { implement: { signalled: true } });
    expect(res.run.nodes.implement.status).toBe("done");
    expect(res.actions).toEqual([]);
  });
});

describe("advance — failure", () => {
  it("fails a node on timeout and stops spawning downstream", () => {
    const run = startNode(initRun("r", LINEAR, "run-r"), "research");
    const res = advance(run, { research: { timedOut: true } });
    expect(res.run.nodes.research).toMatchObject({ status: "failed", reason: "timed out" });
    expect(res.run.nodes.implement.status).toBe("blocked");
    expect(res.actions).toEqual([]);
  });
});
