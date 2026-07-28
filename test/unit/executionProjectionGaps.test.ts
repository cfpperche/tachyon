/**
 * SDD 480 Phase 3 GATE — the four measured gaps of spec §3.4, each demonstrably closed.
 *
 * The plan states the gate in exactly those terms, so this file is organised by gap rather than by
 * module: what matters is that the thing the spec said was missing can now be shown to exist, end to
 * end, rather than that some function returns the right shape.
 *
 * Each block names the gap verbatim and then proves it against the real seams — the Bridge tools with
 * their instrumentation, and the projection reading the events those seams actually emit.
 */
import { describe, it, expect } from "vitest";
import { registerTools } from "../../src/bridge/tools.js";
import { sealExecutionEvent, type SealedExecutionEvent } from "../../src/executionGraph/eventSchema.js";
import { projectExecutions, projectForAgent, causalChain } from "../../src/executionGraph/executionProjection.js";

class ToolCapture {
  handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>>();
  registerTool(name: string, _schema: unknown, handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>) {
    this.handlers.set(name, handler);
  }
}

function bridge(extra: Record<string, unknown> = {}) {
  const mcp = new ToolCapture();
  const events: SealedExecutionEvent[] = [];
  registerTools(mcp as never, {
    workspaceRoot: "/repo",
    caller: { kind: "agent", name: "ada" },
    recordExecution: (e: SealedExecutionEvent) => events.push(e),
    ...extra,
  } as never);
  return { mcp, events };
}

function ev(over: Partial<Parameters<typeof sealExecutionEvent>[0]>): SealedExecutionEvent {
  return sealExecutionEvent({
    kind: "spawn", node: "Process", state: "running", provenance: "measured",
    correlation: { agentId: "ada", executionId: "exec-1" },
    at: "2026-07-28T12:00:00.000Z",
    ...over,
  });
}

describe("§3.4 gap 1 — no turn or tool-call identity exists", () => {
  it("gives every Bridge call a tool-call id that reaches the ledger", async () => {
    const { mcp, events } = bridge();
    await mcp.handlers.get("list_pins")!({});
    const op = events.find((e) => e.node === "InternalOperation" && e.detail.tool === "list_pins");
    expect(op, "no InternalOperation recorded").toBeDefined();
    // The gap was that NO tool-call identity existed at all — episodeKey was a UI refresh token.
    expect(op!.correlation.toolCallId).toMatch(/^tc-/);
  });

  it("gives distinct calls distinct ids, so two calls never look like one", async () => {
    const { mcp, events } = bridge();
    await mcp.handlers.get("list_pins")!({});
    await mcp.handlers.get("list_pins")!({});
    const ids = events.filter((e) => e.kind === "spawn" && e.detail.tool === "list_pins").map((e) => e.correlation.toolCallId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("surfaces turnId and toolCallId through the projection", () => {
    const projected = projectExecutions([
      ev({ correlation: { agentId: "ada", executionId: "exec-turn", turnId: "turn-7" }, node: "Turn" }),
      ev({ correlation: { agentId: "ada", executionId: "exec-op", toolCallId: "tc-9" }, node: "InternalOperation" }),
    ]);
    expect(projected.executions.find((e) => e.executionId === "exec-turn")!.turnId).toBe("turn-7");
    expect(projected.executions.find((e) => e.executionId === "exec-op")!.toolCallId).toBe("tc-9");
  });
});

describe("§3.4 gap 2 — no execution id crosses the Bridge", () => {
  it("joins a process started by a tool to the ToolCall that started it", async () => {
    // The gap verbatim: run_command "knew its caller but emitted nothing an observer could later join
    // on". The join is what is tested here, not the presence of two records.
    const { mcp, events } = bridge({
      commands: {
        status: async () => ({ declared: true, state: "idle" }),
        run: async () => undefined,
        tail: async () => "",
      },
      waiters: { wait: async () => ({ state: "dead", exitCode: 0, waitedMs: 5 }) },
    });
    await mcp.handlers.get("run_command")!({ name: "build", timeoutSec: 1 });

    const op = events.find((e) => e.node === "InternalOperation" && e.detail.tool === "run_command" && e.kind === "spawn");
    const session = events.find((e) => e.node === "TmuxSession" && e.kind === "spawn");
    expect(op, "no InternalOperation for the Bridge call").toBeDefined();
    expect(session, "no TmuxSession for the command").toBeDefined();

    // Same tool call on both, and an explicit edge from the process to the operation.
    expect(session!.correlation.toolCallId).toBe(op!.correlation.toolCallId);
    expect(session!.edge).toEqual({ kind: "invoked", toExecutionId: op!.correlation.executionId });

    // And it is traversable: the read API walks the process back to its cause.
    const chain = causalChain(projectExecutions(events), session!.correlation.executionId);
    expect(chain.map((c) => c.node)).toEqual(["TmuxSession", "InternalOperation"]);
  });

  it("keeps concurrent Bridge calls from stealing each other's children", async () => {
    // Why the ambient call is async-local and not a module variable. With a shared mutable "current
    // call", the slow tool's process would be attributed to the fast tool that overwrote it.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    const { mcp, events } = bridge({
      commands: {
        status: async () => ({ declared: true, state: "idle" }),
        run: async () => { if (first) { first = false; await gate; } },
        tail: async () => "",
      },
      waiters: { wait: async () => ({ state: "dead", exitCode: 0, waitedMs: 1 }) },
    });
    const slow = mcp.handlers.get("run_command")!({ name: "slow", timeoutSec: 1 });
    const fast = await mcp.handlers.get("run_command")!({ name: "fast", timeoutSec: 1 });
    expect(fast.isError).not.toBe(true);
    release!();
    await slow;

    const sessions = events.filter((e) => e.node === "TmuxSession" && e.kind === "spawn");
    expect(sessions).toHaveLength(2);
    for (const session of sessions) {
      const parent = events.find((e) => e.node === "InternalOperation" && e.kind === "spawn"
        && e.correlation.executionId === session.edge!.toExecutionId);
      // Each process points at the operation whose command it actually was.
      expect(parent!.detail.command ?? session.detail.command).toBe(session.detail.command);
      expect(session.correlation.toolCallId).toBe(parent!.correlation.toolCallId);
    }
    expect(new Set(sessions.map((s) => s.edge!.toExecutionId)).size).toBe(2);
  });
});

describe("§3.4 gap 3 — nothing records exit", () => {
  it("reads an exit with its code and time back off the ledger", () => {
    const projected = projectExecutions([
      ev({ kind: "spawn", state: "running", at: "2026-07-28T12:00:00.000Z" }),
      ev({ kind: "exit", state: "failed", at: "2026-07-28T12:05:00.000Z", detail: { exitCode: 137 } }),
    ]);
    const execution = projected.executions[0]!;
    expect(execution.exit, "the exit is not readable").toBeDefined();
    expect(execution.exit!.code).toBe("137");
    expect(execution.exit!.at).toBe("2026-07-28T12:05:00.000Z");
    expect(execution.state).toBe("failed");
  });

  it("distinguishes a clean exit from one whose code was never seen", () => {
    // "we did not see the code" and "the code was 0" are different facts, and a graph that merges them
    // reports crashes as clean shutdowns.
    const clean = projectExecutions([ev({ kind: "exit", state: "completed", detail: { exitCode: 0 } })]).executions[0]!;
    const unknown = projectExecutions([ev({ kind: "exit", state: "failed", detail: {} })]).executions[0]!;
    expect(clean.exit!.code).toBe("0");
    expect(unknown.exit!.code).toBeUndefined();
    expect(unknown.state).toBe("failed");
  });
});

describe("§3.4 gap 4 — sharing is unrepresentable", () => {
  const sharedDaemon = [
    ev({ correlation: { agentId: "ada", executionId: "exec-daemon" }, node: "SystemdUnit", state: "running" }),
    ev({ correlation: { agentId: "bob", executionId: "exec-daemon" }, node: "SystemdUnit", state: "running" }),
  ];

  it("links a shared daemon to every agent using it and to none exclusively", () => {
    const execution = projectExecutions(sharedDaemon).executions[0]!;
    expect(execution.claims.map((c) => c.agentId)).toEqual(["ada", "bob"]);
    expect(execution.shared).toBe(true);
    expect(execution.exclusivelyOwned).toBe(false);
  });

  it("shows the same daemon in BOTH agents' projections", () => {
    // The gap was that it was "either owned by whichever asked last, or invisible". Neither now.
    for (const agent of ["ada", "bob"]) {
      const view = projectForAgent(sharedDaemon, agent);
      expect(view.executions.map((e) => e.executionId)).toEqual(["exec-daemon"]);
      expect(view.shared.map((e) => e.executionId)).toEqual(["exec-daemon"]);
      expect(view.exclusivelyOwned).toEqual([]);
    }
  });

  it("does not let a later event collapse sharing back to single ownership", () => {
    // Last-write-wins is precisely how sharing was lost before. A third, routine event from one agent
    // must not make the daemon look like that agent's alone.
    const withLater = [...sharedDaemon, ev({ correlation: { agentId: "ada", executionId: "exec-daemon" }, node: "SystemdUnit", kind: "exit", state: "completed" })];
    const execution = projectExecutions(withLater).executions[0]!;
    expect(execution.shared).toBe(true);
    expect(execution.exclusivelyOwned).toBe(false);
    expect(execution.claims).toHaveLength(2);
  });
});

describe("Phase 3 — shared, orphaned and unproven survive the fold", () => {
  it("keeps per-agent provenance instead of aggregating it", () => {
    // Collapsing to one provenance either promotes the guess or demotes the measurement.
    const execution = projectExecutions([
      ev({ correlation: { agentId: "ada", executionId: "exec-d" }, provenance: "measured" }),
      ev({ correlation: { agentId: "bob", executionId: "exec-d" }, provenance: "unproven" }),
    ]).executions[0]!;
    expect(execution.claims.find((c) => c.agentId === "ada")!.provenance).toBe("measured");
    expect(execution.claims.find((c) => c.agentId === "bob")!.provenance).toBe("unproven");
    expect(execution.unproven).toBe(false); // at least one claim is proven
  });

  it("marks an execution unproven only when NO claim was ever proven", () => {
    const execution = projectExecutions([ev({ provenance: "unproven" }), ev({ provenance: "unproven", kind: "exit", state: "failed" })]).executions[0]!;
    expect(execution.unproven).toBe(true);
    expect(execution.exclusivelyOwned).toBe(false);
  });

  it("does not let a routine later event bury `orphaned`", () => {
    const execution = projectExecutions([
      ev({ state: "running" }),
      ev({ kind: "orphan", state: "orphaned" }),
      ev({ kind: "spawn", state: "running" }),
    ]).executions[0]!;
    expect(execution.orphaned).toBe(true);
    expect(execution.observedStates).toContain("orphaned");
  });

  it("clears `orphaned` only when the execution actually ends", () => {
    const execution = projectExecutions([
      ev({ kind: "orphan", state: "orphaned" }),
      ev({ kind: "exit", state: "completed" }),
    ]).executions[0]!;
    expect(execution.orphaned).toBe(false);
    // Still recoverable as history — ended, but it did outlive its parent, and that stays legible.
    expect(execution.observedStates).toContain("orphaned");
  });

  it("does not loop forever on a cyclic ledger", () => {
    const chain = causalChain(projectExecutions([
      ev({ correlation: { agentId: "ada", executionId: "a" }, edge: { kind: "spawned", toExecutionId: "b" } }),
      ev({ correlation: { agentId: "ada", executionId: "b" }, edge: { kind: "spawned", toExecutionId: "a" } }),
    ]), "a");
    expect(chain.map((c) => c.executionId)).toEqual(["a", "b"]);
  });
});
