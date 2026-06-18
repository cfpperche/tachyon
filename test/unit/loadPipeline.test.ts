import { describe, it, expect } from "vitest";
import { loadPipeline, parseDuration, nodeSpawnName } from "../../src/pipeline/loadPipeline.js";

const AGENTS = new Set(["researcher", "coder", "reviewer"]);

/** A valid two-node pipeline used as the happy-path baseline. */
const VALID = `
name: feature
worktree: own
nodes:
  research:
    agent: researcher
    task: "Research \${input.task}"
    done: signal
    timeout: 20m
  implement:
    agent: coder
    task: "Implement it"
    needs: [research]
    done: signal_then_verify
    gate: approve
    timeout: 45m
`;

describe("loadPipeline — happy path", () => {
  it("parses a valid pipeline into a typed PipelineDef", () => {
    const { pipeline, errors } = loadPipeline(VALID, AGENTS);
    expect(errors).toEqual([]);
    expect(pipeline?.name).toBe("feature");
    expect(pipeline?.worktree).toBe("own");
    expect(Object.keys(pipeline!.nodes)).toEqual(["research", "implement"]);
    expect(pipeline!.nodes.research).toMatchObject({ agent: "researcher", done: "signal", needs: [], timeoutMs: 20 * 60_000 });
    expect(pipeline!.nodes.implement).toMatchObject({ agent: "coder", done: "signal_then_verify", gate: "approve", needs: ["research"], timeoutMs: 45 * 60_000 });
  });

  it("accepts a cmd node with done: signal — an EPHEMERAL interactive LLM agent (e.g. cmd: codex)", () => {
    const { pipeline, errors } = loadPipeline(`name: p\nnodes:\n  ask: {cmd: codex, task: "review this", done: signal, timeout: 20m}\n`, AGENTS);
    expect(errors).toEqual([]);
    expect(pipeline?.nodes.ask).toMatchObject({ cmd: "codex", done: "signal" });
  });

  it("defaults worktree to 'own' when omitted", () => {
    const { pipeline, errors } = loadPipeline(`name: p\nnodes:\n  a: {cmd: "echo hi", task: t, done: exit, timeout: 30s}\n`, AGENTS);
    expect(errors).toEqual([]);
    expect(pipeline?.worktree).toBe("own");
    expect(pipeline?.nodes.a).toMatchObject({ cmd: "echo hi", done: "exit", timeoutMs: 30_000 });
  });
});

describe("nodeSpawnName", () => {
  it("a declared agent node spawns under the agent's own name (persistent specialist)", () => {
    expect(nodeSpawnName("r1", "implement", { agent: "implementer" })).toBe("implementer");
  });
  it("an inline cmd node spawns under an ephemeral pl-<runId>-<nodeId> name", () => {
    expect(nodeSpawnName("r1", "build", {})).toBe("pl-r1-build");
  });
});

describe("parseDuration", () => {
  it("parses s/m/h and rejects junk", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("45m")).toBe(45 * 60_000);
    expect(parseDuration("2h")).toBe(2 * 3_600_000);
    expect(parseDuration("0m")).toBeNull();
    expect(parseDuration("5")).toBeNull();
    expect(parseDuration("5min")).toBeNull();
    expect(parseDuration(undefined)).toBeNull();
  });
});

describe("loadPipeline — validation (fail-closed)", () => {
  const expectError = (yaml: string, substr: string, agents = AGENTS) => {
    const { pipeline, errors } = loadPipeline(yaml, agents);
    expect(pipeline).toBeUndefined();
    expect(errors.some((e) => e.includes(substr))).toBe(true);
  };

  it("invalid YAML", () => expectError("name: [unterminated", "invalid YAML"));
  it("non-mapping root", () => expectError("- a\n- b\n", "must be a mapping"));
  it("missing/invalid name", () => expectError("nodes:\n  a: {cmd: x, task: t, done: exit, timeout: 1s}\n", "name:"));
  it("empty nodes", () => expectError("name: p\nnodes: {}\n", "non-empty mapping"));
  it("invalid worktree", () => expectError("name: p\nworktree: shared\nnodes:\n  a: {cmd: x, task: t, done: exit, timeout: 1s}\n", "only 'own'"));

  it("node with both agent and cmd", () =>
    expectError("name: p\nnodes:\n  a: {agent: coder, cmd: x, task: t, done: exit, timeout: 1s}\n", "exactly one of"));
  it("node with neither agent nor cmd", () =>
    expectError("name: p\nnodes:\n  a: {task: t, done: exit, timeout: 1s}\n", "exactly one of"));
  it("unknown agent ref", () =>
    expectError("name: p\nnodes:\n  a: {agent: ghost, task: t, done: signal, timeout: 1s}\n", "not a declared agent"));
  it("missing task", () =>
    expectError("name: p\nnodes:\n  a: {cmd: x, done: exit, timeout: 1s}\n", "task:"));
  it("missing timeout", () =>
    expectError("name: p\nnodes:\n  a: {cmd: x, task: t, done: exit}\n", "timeout:"));
  it("bad timeout", () =>
    expectError("name: p\nnodes:\n  a: {cmd: x, task: t, done: exit, timeout: soon}\n", "timeout:"));
  it("bad done kind", () =>
    expectError("name: p\nnodes:\n  a: {cmd: x, task: t, done: whenever, timeout: 1s}\n", "done:"));
  it("bad gate", () =>
    expectError("name: p\nnodes:\n  a: {cmd: x, task: t, done: exit, gate: maybe, timeout: 1s}\n", "gate:"));

  it("agent node with exit-based done is rejected (a declared LLM agent is interactive)", () =>
    expectError("name: p\nnodes:\n  a: {agent: coder, task: t, done: exit, timeout: 1s}\n", "exit-based"));

  it("self-dependency", () =>
    expectError("name: p\nnodes:\n  a: {cmd: x, task: t, done: exit, needs: [a], timeout: 1s}\n", "cannot depend on itself"));
  it("unknown needs ref", () =>
    expectError("name: p\nnodes:\n  a: {cmd: x, task: t, done: exit, needs: [ghost], timeout: 1s}\n", "unknown node"));
  it("duplicate declared agent ref across nodes", () =>
    expectError(
      "name: p\nnodes:\n  a: {agent: coder, task: t, done: signal, timeout: 1s}\n  b: {agent: coder, task: t, needs: [a], done: signal, timeout: 1s}\n",
      "only one node per run",
    ));
  it("dependency cycle", () =>
    expectError(
      "name: p\nnodes:\n  a: {cmd: x, task: t, done: exit, needs: [b], timeout: 1s}\n  b: {cmd: y, task: t, done: exit, needs: [a], timeout: 1s}\n",
      "cycle",
    ));
  it("invalid node id", () =>
    expectError("name: p\nnodes:\n  '1bad': {cmd: x, task: t, done: exit, timeout: 1s}\n", "invalid node id"));

  it("rejects fan-out (v1 must be linear)", () =>
    expectError(
      "name: p\nnodes:\n  a: {cmd: x, task: t, done: exit, timeout: 1s}\n  b: {cmd: x, task: t, needs: [a], done: exit, timeout: 1s}\n  c: {cmd: x, task: t, needs: [a], done: exit, timeout: 1s}\n",
      "single linear chain",
    ));
  it("rejects fan-in (v1 must be linear)", () =>
    expectError(
      "name: p\nnodes:\n  a: {cmd: x, task: t, done: exit, timeout: 1s}\n  b: {cmd: x, task: t, done: exit, timeout: 1s}\n  c: {cmd: x, task: t, needs: [a, b], done: exit, timeout: 1s}\n",
      "single linear chain",
    ));
  it("rejects two disconnected roots (v1 must be linear)", () =>
    expectError(
      "name: p\nnodes:\n  a: {cmd: x, task: t, done: exit, timeout: 1s}\n  b: {cmd: x, task: t, done: exit, timeout: 1s}\n",
      "single linear chain",
    ));
});
