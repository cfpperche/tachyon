import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadPipeline, parseDuration, nodeSpawnName } from "../../src/pipeline/loadPipeline.js";

const SRC = path.resolve(__dirname, "..", "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) ? [full] : [];
  });
}

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
    done: signal
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
    expect(pipeline!.nodes.implement).toMatchObject({ agent: "coder", done: "signal", gate: "approve", needs: ["research"], timeoutMs: 45 * 60_000 });
  });

  it("accepts a cmd node with done: signal — an EPHEMERAL interactive LLM agent (e.g. cmd: codex)", () => {
    const { pipeline, errors } = loadPipeline(`name: p\nnodes:\n  ask: {cmd: codex, task: "review this", done: signal, timeout: 20m}\n`, AGENTS);
    expect(errors).toEqual([]);
    expect(pipeline?.nodes.ask).toMatchObject({ cmd: "codex", done: "signal" });
  });

  it("refuses removed verify completion contracts", () => {
    for (const done of ["signal_then_verify", "exit_then_verify"]) {
      const { pipeline, errors } = loadPipeline(`name: p\nnodes:\n  a: {cmd: codex, task: t, done: ${done}, timeout: 1s}\n`, AGENTS);
      expect(pipeline).toBeUndefined();
      expect(errors).toContain(`nodes.a.done: required, one of exit | signal`);
    }
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
  it("discards the retired expectsChange field", () => {
    const result = loadPipeline("name: p\nnodes:\n  a: {cmd: x, task: t, done: exit, expectsChange: yes, timeout: 1s}\n", AGENTS);
    expect(result.errors).toEqual([]);
    expect(result.pipeline?.nodes.a).not.toHaveProperty("expectsChange");
  });

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

// spec 231 — `input:` enum + the work-source rule for an optional `task`.
describe("loadPipeline — input mode + work-source rule (spec 231)", () => {
  const HAS_PERSONA = (name: string) => name === "coder"; // only `coder` declares a persona

  it("defaults input to 'none' when omitted", () => {
    const { pipeline } = loadPipeline("name: p\nnodes:\n  a: {cmd: x, task: t, done: exit, timeout: 1s}\n", AGENTS);
    expect(pipeline?.input).toBe("none");
  });
  it("accepts input: required", () => {
    const { pipeline, errors } = loadPipeline(
      "name: p\ninput: required\nnodes:\n  a: {agent: coder, task: t, done: signal, timeout: 5m}\n",
      AGENTS,
      HAS_PERSONA,
    );
    expect(errors).toEqual([]);
    expect(pipeline?.input).toBe("required");
  });
  it("rejects an invalid input value", () => {
    const { pipeline, errors } = loadPipeline("name: p\ninput: maybe\nnodes:\n  a: {cmd: x, task: t, done: exit, timeout: 1s}\n", AGENTS);
    expect(pipeline).toBeUndefined();
    expect(errors.some((e) => e.includes("input:"))).toBe(true);
  });

  it("a persona agent under input: required MAY omit task", () => {
    const { pipeline, errors } = loadPipeline(
      "name: p\ninput: required\nnodes:\n  a: {agent: coder, done: signal, timeout: 5m}\n",
      AGENTS,
      HAS_PERSONA,
    );
    expect(errors).toEqual([]);
    expect(pipeline?.nodes.a.task).toBeUndefined();
    expect(pipeline?.nodes.a).toMatchObject({ agent: "coder", done: "signal" });
  });
  it("a persona agent that DOES give a task keeps it (trimmed)", () => {
    const { pipeline } = loadPipeline(
      "name: p\ninput: required\nnodes:\n  a: {agent: coder, task: '  plan only  ', done: signal, timeout: 5m}\n",
      AGENTS,
      HAS_PERSONA,
    );
    expect(pipeline?.nodes.a.task).toBe("plan only");
  });
  it("a PERSONA-LESS agent must provide task even under input: required (fail-closed)", () => {
    const { pipeline, errors } = loadPipeline(
      "name: p\ninput: required\nnodes:\n  a: {agent: researcher, done: signal, timeout: 5m}\n",
      AGENTS,
      HAS_PERSONA,
    );
    expect(pipeline).toBeUndefined();
    expect(errors.some((e) => e.includes(".task:"))).toBe(true);
  });
  it("an agent under input: none must provide task (no run input as work source)", () => {
    const { pipeline, errors } = loadPipeline(
      "name: p\nnodes:\n  a: {agent: coder, done: signal, timeout: 5m}\n",
      AGENTS,
      HAS_PERSONA,
    );
    expect(pipeline).toBeUndefined();
    expect(errors.some((e) => e.includes(".task:"))).toBe(true);
  });
  it("a cmd node always requires task — even under input: required (codex B1)", () => {
    const { pipeline, errors } = loadPipeline(
      "name: p\ninput: required\nnodes:\n  a: {cmd: codex, done: signal, timeout: 5m}\n",
      AGENTS,
      HAS_PERSONA,
    );
    expect(pipeline).toBeUndefined();
    expect(errors.some((e) => e.includes(".task:"))).toBe(true);
  });
  it("default predicate () => false ⇒ even input:required requires task for agents (back-compat caller)", () => {
    const { pipeline, errors } = loadPipeline(
      "name: p\ninput: required\nnodes:\n  a: {agent: coder, done: signal, timeout: 5m}\n",
      AGENTS,
    );
    expect(pipeline).toBeUndefined();
    expect(errors.some((e) => e.includes(".task:"))).toBe(true);
  });
});

describe("an inline node declares its kind through `done` (t-c003e1)", () => {
  it("a signal-based node on an operable runtime is an agent", () => {
    const { pipeline, errors } = loadPipeline(
      `name: p\nnodes:\n  ask: {cmd: codex, task: "review this", done: signal, timeout: 20m}\n`,
      AGENTS,
    );
    expect(errors).toEqual([]);
    // The kind is materialized, not left for the spawn door to guess from the command text.
    expect(pipeline?.nodes.ask).toMatchObject({ cmd: "codex", done: "signal", kind: "agent" });
  });

  it("an exit-based node is a terminal, whatever the command is", () => {
    const { pipeline, errors } = loadPipeline(
      `name: p\nnodes:\n  build: {cmd: "sh -c 'npm run build'", task: "build it", done: exit, timeout: 5m}\n`
      + `  once: {cmd: "codex exec 'summarize'", task: "summarize", needs: [build], done: exit, timeout: 5m}\n`,
      AGENTS,
    );
    expect(errors).toEqual([]);
    expect(pipeline?.nodes.build).toMatchObject({ kind: "terminal" });
    // Even a runtime binary is a Terminal here: an exit-based node is judged by its exit code, and
    // never receives a brief or the complete_node protocol.
    expect(pipeline?.nodes.once).toMatchObject({ kind: "terminal" });
  });

  it("refuses a signal-based node whose command Tachyon cannot operate, naming the other form", () => {
    // `aider` is in the authoring suggestion catalog but has no resume/brief/Bridge machinery, so it
    // can be a Terminal and never an Agent — the same rule the ad-hoc door applies.
    const { pipeline, errors } = loadPipeline(
      `name: p\nnodes:\n  ask: {cmd: aider, task: "review this", done: signal, timeout: 20m}\n`,
      AGENTS,
    );
    expect(pipeline).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("nodes.ask.cmd");
    expect(errors[0]).toContain("cannot run as an agent node");
    expect(errors[0]).toContain("done: exit");
    expect(errors[0]).toContain("agent: <name>");
  });

  it("refuses a shell asked to signal — it has no way to report and never did", () => {
    const { errors } = loadPipeline(
      `name: p\nnodes:\n  wat: {cmd: "sh -c 'sleep 1'", task: "wait", done: signal, timeout: 1m}\n`,
      AGENTS,
    );
    expect(errors.join("\n")).toContain("cannot run as an agent node");
  });

  it("leaves an agent: node's kind to the declared agent it names", () => {
    const { pipeline, errors } = loadPipeline(
      `name: p\nnodes:\n  step: {agent: coder, task: "do it", done: signal, timeout: 5m}\n`,
      AGENTS,
    );
    expect(errors).toEqual([]);
    expect(pipeline?.nodes.step.kind).toBeUndefined();
  });
});

describe("suggestKindForCommand stays an authoring suggestion (t-c003e1)", () => {
  it("no entity-creating path calls it — only the authoring surfaces and M6's declared default", () => {
    // Guarded over source because the property is "who may call this", which no runtime assertion can
    // see: a call added back inside a spawn door would look perfectly correct locally.
    const callers = sourceFiles(path.join(SRC)).filter((file) => {
      const src = readFileSync(file, "utf8");
      // A call, not a mention: doc comments cite the name on purpose.
      return /suggestKindForCommand\s*\(/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""));
    }).map((file) => path.relative(SRC, file)).sort();

    expect(callers).toEqual([
      // M6 — the declared `agents:` default a human sees in their own tachyon.yml, deliberately visible.
      "config/loadConfig.ts",
      // Authoring: the Studio form's pre-selection, which the human then confirms or overrides.
      "webview/formLogic.ts",
    ]);
  });
});
