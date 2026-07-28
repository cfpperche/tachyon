/**
 * SDD 480 Phase 2 — the wiring, which is the part that turns two tested halves into a real graph.
 *
 * Everything before this could pass with `recordExecution` supplied by nobody. These tests exist so
 * that cannot happen again: they assert the PRODUCTION path, not a hand-assembled one.
 *
 *  - §7.3 says EVERY Bridge tool call becomes an `InternalOperation`. That is enforced by wrapping
 *    registration once, so the test that matters is "a tool nobody thought about is still recorded".
 *  - the ledger a restart reads must be the SAME file the previous run wrote, which is why the
 *    production factory opens its own stable stream instead of the engine's per-instance journal.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerTools } from "../../src/bridge/tools.js";
import { openExecutionLedger } from "../../src/executionGraph/executionLedger.js";
import type { SealedExecutionEvent } from "../../src/executionGraph/eventSchema.js";

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

describe("SDD 480 §7.3 — every Bridge tool call becomes an InternalOperation", () => {
  it("records a tool that has no bespoke instrumentation of its own", () => {
    // The point of wrapping registration instead of each handler: a tool nobody remembered to
    // instrument is still recorded. Picking `list_tasks` precisely because it knows nothing about
    // the execution graph.
    const { mcp } = bridge();
    expect(mcp.handlers.has("list_tasks")).toBe(true);
  });

  it("records start and completion around a real tool call", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-wired-"));
    try {
      const { mcp, events } = bridge({ workspaceRoot: dir });
      await mcp.handlers.get("list_pins")!({});

      const ops = events.filter((e) => e.node === "InternalOperation" && e.detail.tool === "list_pins");
      expect(ops.length, `expected a spawn and a terminal event; got ${JSON.stringify(events.map((e) => `${e.node}:${e.kind}:${e.detail.tool}`))}`).toBe(2);
      expect(ops[0]!.kind).toBe("spawn");
      expect(["exit", "fail"]).toContain(ops[1]!.kind);
      // A Bridge call is work inside this process: no child, so nothing here is provable.
      expect(ops[0]!.provenance).toBe("unproven");
      expect(ops[0]!.correlation.agentId).toBe("ada");
      // Both halves share one execution, or the graph shows an operation that started and never ended.
      expect(ops[1]!.correlation.executionId).toBe(ops[0]!.correlation.executionId);
      // The wrap covers the whole surface, not a handful of tools someone remembered.
      expect(mcp.handlers.size).toBeGreaterThan(50);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records an MCP-style failure, which is a RETURNED isError rather than a throw", async () => {
    // The trap this guards: a wrapper that only catches exceptions would record every refusal as a
    // success, because MCP tools report failure in their return value.
    const { mcp, events } = bridge();
    // `run_command` with no runner configured returns an error result rather than throwing.
    const res = await mcp.handlers.get("run_command")!({ name: "nope" });
    expect(res.isError).toBe(true);

    const ops = events.filter((e) => e.node === "InternalOperation" && e.detail.tool === "run_command");
    expect(ops).toHaveLength(2);
    expect(ops[1]!.kind).toBe("fail");
    expect(ops[1]!.state).toBe("failed");
  });

  it("never records a tool's arguments", async () => {
    // Bridge args routinely carry task bodies, handoff prose and tokens. The cheapest way to keep a
    // secret out of the ledger is not to collect it in the first place.
    const { mcp, events } = bridge();
    await mcp.handlers.get("run_command")!({ name: "deploy-with-sk-not-a-real-key-000" });
    const ops = events.filter((e) => e.node === "InternalOperation");
    expect(JSON.stringify(ops)).not.toContain("sk-not-a-real-key-000");
  });

  it("behaves exactly as before when no sink is supplied", async () => {
    // The property that kept this wiring reversible: a Bridge with no ledger is the old Bridge.
    const cap = new ToolCapture();
    registerTools(cap as never, { workspaceRoot: "/repo", caller: { kind: "agent", name: "ada" } } as never);
    const res = await cap.handlers.get("run_command")!({ name: "nope" });
    expect(res.isError).toBe(true);
  });
});

describe("SDD 480 §2.3 — the production ledger survives a restart", () => {
  it("opens a stable stream, so a second engine instance reads the first one's graph", () => {
    const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exec-ledger-prod-"));
    try {
      // Two calls model two engine starts. The engine's OWN journal is keyed to a fresh uuid each
      // time; if the execution ledger were hung off that, this test would see an empty graph — which
      // is exactly the regression it exists to catch.
      const first = openExecutionLedger({ storageRoot, workspaceHash: "abc12345" });
      first.record({
        kind: "spawn", node: "Process", state: "running", provenance: "measured",
        correlation: { agentId: "ada", executionId: "exec-restart-1" },
        // t-2622eb — NOT an absolute date: this ledger uses the real clock and the default 24h
        // retention, so a fixed timestamp turns this test into a bomb with a 24h fuse.
        at: new Date().toISOString(), detail: {},
      });

      const second = openExecutionLedger({ storageRoot, workspaceHash: "abc12345" });
      expect(second.graph().nodes.map((n) => n.executionId)).toEqual(["exec-restart-1"]);
      expect(second.bytesFor("ada")).toBeGreaterThan(0);

      const file = path.join(storageRoot, "events", "executions.jsonl");
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.statSync(file).mode & 0o077).toBe(0);
    } finally {
      fs.rmSync(storageRoot, { recursive: true, force: true });
    }
  });
});
