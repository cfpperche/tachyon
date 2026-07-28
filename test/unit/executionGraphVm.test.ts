/**
 * SDD 480 Phase 4 — the Execution Graph view-model.
 *
 * The plan asks for a deterministic, testable representation BEFORE anything visual, and these tests
 * are what that buys: the canvas is asserted here rather than eyeballed, so a screenshot diff later
 * means a real change instead of a re-run.
 *
 * Two properties get the most attention because they are the ones that rot quietly:
 *  - SEMANTIC PARITY. The table is not a second query that happens to agree with the canvas today;
 *    both are built from one model, and the parity test states that directly.
 *  - VOLUME HONESTY. A thousand-event graph must stay readable WITHOUT quietly becoming a
 *    forty-event graph. Grouping is allowed; silent truncation is not.
 */
import { describe, it, expect } from "vitest";
import {
  buildExecutionGraphVm,
  buildExecutionDetailVm,
  applyFilters,
  semanticParity,
  COLUMN_WIDTH,
  LANE_HEIGHT,
  GROUP_THRESHOLD,
} from "../../src/cockpit/executionGraphVm.js";
import { projectExecutions } from "../../src/executionGraph/executionProjection.js";
import { sealExecutionEvent, type SealedExecutionEvent } from "../../src/executionGraph/eventSchema.js";

function ev(over: Partial<Parameters<typeof sealExecutionEvent>[0]>): SealedExecutionEvent {
  return sealExecutionEvent({
    kind: "spawn", node: "Process", state: "running", provenance: "measured",
    correlation: { agentId: "ada", executionId: "exec-1" },
    at: "2026-07-28T12:00:00.000Z",
    ...over,
  });
}

/** A projection with `count` processes, deterministic timestamps and ids. */
function heavy(count: number, kind: "Process" | "InternalOperation" = "Process") {
  const events: SealedExecutionEvent[] = [];
  for (let i = 0; i < count; i++) {
    events.push(ev({
      node: kind,
      correlation: { agentId: `agent-${i % 4}`, executionId: `exec-${String(i).padStart(5, "0")}` },
      at: new Date(Date.parse("2026-07-28T12:00:00.000Z") + i * 1000).toISOString(),
    }));
  }
  return projectExecutions(events);
}

describe("Phase 4 — the model is deterministic", () => {
  it("places the same input at the same coordinates every time", () => {
    const projection = heavy(12);
    const a = buildExecutionGraphVm({ projection });
    const b = buildExecutionGraphVm({ projection });
    // Byte-equal, not merely similar: a canvas that drifts between renders cannot be screenshot-tested.
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("orders a lane by start time, breaking ties by id", () => {
    // The tiebreak is the point: two executions in the same millisecond must not swap between renders.
    const same = "2026-07-28T12:00:00.000Z";
    const projection = projectExecutions([
      ev({ correlation: { agentId: "ada", executionId: "exec-b" }, at: same }),
      ev({ correlation: { agentId: "ada", executionId: "exec-a" }, at: same }),
    ]);
    const vm = buildExecutionGraphVm({ projection });
    expect(vm.nodes.map((n) => n.executionId)).toEqual(["exec-a", "exec-b"]);
    expect(vm.nodes[0]!.x).toBe(0);
    expect(vm.nodes[1]!.x).toBe(COLUMN_WIDTH);
  });

  it("puts each node kind in its own lane, in causal order", () => {
    const projection = projectExecutions([
      ev({ node: "Process", correlation: { agentId: "ada", executionId: "exec-p" } }),
      ev({ node: "Turn", correlation: { agentId: "ada", executionId: "exec-t" } }),
    ]);
    const vm = buildExecutionGraphVm({ projection });
    const turn = vm.nodes.find((n) => n.kind === "Turn")!;
    const process = vm.nodes.find((n) => n.kind === "Process")!;
    // Reading down the canvas is reading the direction of causation.
    expect(turn.y).toBeLessThan(process.y);
    expect(turn.y % LANE_HEIGHT).toBe(0);
  });
});

describe("Phase 4 — canvas and table are the same information", () => {
  it("has exactly one row per node and one node per row", () => {
    const vm = buildExecutionGraphVm({ projection: heavy(25) });
    const parity = semanticParity(vm);
    expect(parity.equal, `canvas and table disagree: ${parity.nodeIds.length} nodes vs ${parity.rowIds.length} rows`).toBe(true);
  });

  it("keeps parity under grouping, which is where a naive table would drift", () => {
    const vm = buildExecutionGraphVm({ projection: heavy(GROUP_THRESHOLD + 30) });
    expect(vm.grouped).toBe(true);
    expect(semanticParity(vm).equal).toBe(true);
  });

  it("keeps parity under every filter", () => {
    const projection = heavy(30);
    for (const filters of [
      { states: ["running" as const] },
      { kinds: ["Process" as const] },
      { agentId: "agent-1" },
      { since: "2026-07-28T12:00:10.000Z" },
    ]) {
      const vm = buildExecutionGraphVm({ projection, filters });
      expect(semanticParity(vm).equal, `parity broke for ${JSON.stringify(filters)}`).toBe(true);
    }
  });
});

describe("Phase 4 — thousands of events stay readable AND honest", () => {
  it("groups the tail instead of truncating it", () => {
    const vm = buildExecutionGraphVm({ projection: heavy(1000) });
    // Readable: the lane did not become a thousand nodes.
    expect(vm.nodes.length).toBeLessThanOrEqual(GROUP_THRESHOLD + 1);
    // Honest: the true total is still reported, and the group says how many it stands for.
    expect(vm.matched).toBe(1000);
    expect(vm.grouped).toBe(true);
    const group = vm.nodes.find((n) => n.groupSize > 1)!;
    expect(group.groupSize).toBe(1000 - GROUP_THRESHOLD);
    expect(group.memberIds).toHaveLength(1000 - GROUP_THRESHOLD);
    expect(group.label).toContain("more");
  });

  it("builds a 5000-event graph well within an interactive budget", () => {
    const projection = heavy(5000);
    const started = Date.now();
    const vm = buildExecutionGraphVm({ projection });
    // Not a benchmark — a regression tripwire. An accidental O(n^2) would blow straight through this.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(vm.matched).toBe(5000);
    expect(semanticParity(vm).equal).toBe(true);
  });

  it("never reports fewer matches than it found, grouped or not", () => {
    for (const count of [1, GROUP_THRESHOLD - 1, GROUP_THRESHOLD, GROUP_THRESHOLD + 1, 500]) {
      expect(buildExecutionGraphVm({ projection: heavy(count) }).matched).toBe(count);
    }
  });
});

describe("Phase 4 — the side-panel details are bounded", () => {
  it("ships one detail per PLACED node, not one per matched execution", () => {
    // The whole point of bounding it here: a thousand-event ledger must not push a thousand detail
    // records into the webview on the off-chance one is clicked.
    const vm = buildExecutionGraphVm({ projection: heavy(1000) });
    expect(vm.matched).toBe(1000);
    expect(Object.keys(vm.details).length).toBeLessThanOrEqual(GROUP_THRESHOLD + 1);
    // And every placed non-group node can actually be opened — bounded must not mean missing.
    for (const node of vm.nodes.filter((n) => n.groupSize === 1)) {
      expect(vm.details[node.executionId], `no detail for placed node ${node.executionId}`).toBeDefined();
    }
  });
});

describe("Phase 4 — filters", () => {
  const projection = projectExecutions([
    ev({ correlation: { agentId: "ada", executionId: "exec-a", turnId: "turn-1" }, at: "2026-07-28T12:00:00.000Z" }),
    ev({ correlation: { agentId: "bob", executionId: "exec-b", turnId: "turn-2" }, node: "InternalOperation", at: "2026-07-28T12:10:00.000Z" }),
    ev({ kind: "exit", state: "failed", correlation: { agentId: "bob", executionId: "exec-b" }, node: "InternalOperation", at: "2026-07-28T12:11:00.000Z" }),
  ]);

  it("filters by turn, state, kind and agent", () => {
    expect(applyFilters(projection.executions, { turnId: "turn-1" }).map((e) => e.executionId)).toEqual(["exec-a"]);
    expect(applyFilters(projection.executions, { states: ["failed"] }).map((e) => e.executionId)).toEqual(["exec-b"]);
    expect(applyFilters(projection.executions, { kinds: ["Process"] }).map((e) => e.executionId)).toEqual(["exec-a"]);
    expect(applyFilters(projection.executions, { agentId: "bob" }).map((e) => e.executionId)).toEqual(["exec-b"]);
  });

  it("treats the time filter as overlap, not containment", () => {
    // An execution that began before the window but was still alive inside it is part of what
    // happened in that window; requiring containment would hide exactly the long-running things a
    // reader is most likely looking for.
    const spanning = projectExecutions([
      ev({ correlation: { agentId: "ada", executionId: "exec-long" }, at: "2026-07-28T11:00:00.000Z" }),
      ev({ correlation: { agentId: "ada", executionId: "exec-long" }, at: "2026-07-28T13:00:00.000Z" }),
    ]);
    const inside = applyFilters(spanning.executions, { since: "2026-07-28T12:00:00.000Z", until: "2026-07-28T12:30:00.000Z" });
    expect(inside.map((e) => e.executionId)).toEqual(["exec-long"]);
  });

  it("offers only filter values the data actually contains", () => {
    const vm = buildExecutionGraphVm({ projection });
    expect(vm.available.turnIds).toEqual(["turn-1", "turn-2"]);
    expect(vm.available.agentIds).toEqual(["ada", "bob"]);
    expect(vm.available.kinds).toContain("InternalOperation");
  });
});

describe("Phase 4 — the explicit states", () => {
  it("distinguishes an empty result from a workspace with no telemetry", () => {
    // The distinction the section exists to make honestly: "your filters matched nothing" and
    // "nothing is being recorded here" look identical in a blank list and mean opposite things.
    const filtered = buildExecutionGraphVm({ projection: heavy(5), filters: { turnId: "turn-nope" } });
    expect(filtered.status).toBe("empty");

    const off = buildExecutionGraphVm({ projection: heavy(5), status: "no-telemetry" });
    expect(off.status).toBe("no-telemetry");
    expect(off.nodes).toEqual([]);
  });

  it("carries loading and error through without inventing nodes", () => {
    for (const status of ["loading", "error"] as const) {
      const vm = buildExecutionGraphVm({ projection: heavy(5), status, errorDetail: "ledger unreadable" });
      expect(vm.status).toBe(status);
      expect(vm.nodes).toEqual([]);
      expect(vm.rows).toEqual([]);
    }
    expect(buildExecutionGraphVm({ projection: heavy(1), status: "error", errorDetail: "boom" }).errorDetail).toBe("boom");
  });

  it("still offers the filter vocabulary while loading, so the controls do not jump", () => {
    const vm = buildExecutionGraphVm({ projection: heavy(4), status: "loading" });
    expect(vm.available.agentIds.length).toBeGreaterThan(0);
  });
});

describe("Phase 4 — shared, orphaned and unproven reach the surface", () => {
  const shared = projectExecutions([
    ev({ correlation: { agentId: "ada", executionId: "exec-daemon" }, node: "SystemdUnit" }),
    ev({ correlation: { agentId: "bob", executionId: "exec-daemon" }, node: "SystemdUnit" }),
  ]);

  it("shows a shared daemon as shared, owned by neither", () => {
    const node = buildExecutionGraphVm({ projection: shared }).nodes[0]!;
    expect(node.shared).toBe(true);
    expect(node.exclusivelyOwned).toBe(false);
    expect(node.agentIds).toEqual(["ada", "bob"]);
    expect(buildExecutionGraphVm({ projection: shared }).rows[0]!.attribution).toBe("shared");
  });

  it("shows per-agent identity proof in the detail, not one merged verdict", () => {
    const mixed = projectExecutions([
      ev({ correlation: { agentId: "ada", executionId: "exec-d" }, provenance: "measured" }),
      ev({ correlation: { agentId: "bob", executionId: "exec-d" }, provenance: "unproven" }),
    ]);
    const detail = buildExecutionDetailVm(mixed, "exec-d")!;
    expect(detail.identityProof).toEqual([
      { agentId: "ada", provenance: "measured" },
      { agentId: "bob", provenance: "unproven" },
    ]);
  });

  it("reports duration and exit code when the ledger has them, and omits them when it does not", () => {
    const withExit = projectExecutions([
      ev({ correlation: { agentId: "ada", executionId: "exec-x" }, at: "2026-07-28T12:00:00.000Z" }),
      ev({ kind: "exit", state: "failed", correlation: { agentId: "ada", executionId: "exec-x" }, at: "2026-07-28T12:00:30.000Z", detail: { exitCode: 137 } }),
    ]);
    const detail = buildExecutionDetailVm(withExit, "exec-x")!;
    expect(detail.durationMs).toBe(30_000);
    expect(detail.exitCode).toBe("137");
    // Absent stays absent — an unknown cwd is not rendered as an empty string that reads like a fact.
    expect(detail.cwd).toBeUndefined();
    expect(buildExecutionDetailVm(withExit, "exec-nope")).toBeUndefined();
  });

  it("surfaces cwd, worktree and tool origin when the ledger recorded them", () => {
    const detail = buildExecutionDetailVm(
      heavy(1),
      "exec-00000",
      () => ({ cwd: "/repo", worktree: "/wt/feature", tool: "run_command" }),
    )!;
    expect(detail.cwd).toBe("/repo");
    expect(detail.worktree).toBe("/wt/feature");
    expect(detail.tool).toBe("run_command");
  });
});

describe("Phase 4 — edges", () => {
  it("drops an edge whose other end was filtered away rather than drawing into nothing", () => {
    // A line to a node the viewer cannot see reads as a relationship to something hidden, which is
    // worse than no line at all.
    const projection = projectExecutions([
      ev({ node: "InternalOperation", correlation: { agentId: "ada", executionId: "exec-op" } }),
      ev({ node: "TmuxSession", correlation: { agentId: "ada", executionId: "exec-cmd" }, edge: { kind: "invoked", toExecutionId: "exec-op" } }),
    ]);
    expect(buildExecutionGraphVm({ projection }).edges).toHaveLength(1);
    const filtered = buildExecutionGraphVm({ projection, filters: { kinds: ["TmuxSession"] } });
    expect(filtered.nodes).toHaveLength(1);
    expect(filtered.edges).toHaveLength(0);
  });
});
