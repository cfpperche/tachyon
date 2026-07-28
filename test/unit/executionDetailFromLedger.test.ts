import { describe, expect, it } from "vitest";
import { sealExecutionEvent, type SealedExecutionEvent } from "../../src/executionGraph/eventSchema.js";
import { indexExecutionDetail, projectExecutions } from "../../src/executionGraph/executionProjection.js";
import { buildExecutionDetailVm } from "../../src/cockpit/executionGraphVm.js";
import { buildExecutionGraphSectionVm } from "../../src/webview/Cockpit.js";

/**
 * t-441b0f — the ledger carried `cwd`/`worktree`/`tool` and the panel never showed them.
 *
 * Both halves were already tested and both passed: `buildExecutionDetailVm` honoured a `detailFor`
 * it was given, and the seams recorded the keys. The host in between handed over `undefined`, and
 * nothing looked at the join. So these tests drive the PRODUCTION function, not a hand-assembled
 * call — a test that built its own `detailFor` would have been green before the fix too.
 */

function ev(over: Partial<Parameters<typeof sealExecutionEvent>[0]> = {}): SealedExecutionEvent {
  return sealExecutionEvent({
    kind: "spawn",
    node: "Process",
    state: "running",
    provenance: "measured",
    correlation: { agentId: "ada", executionId: "exec-1" },
    // t-2622eb — relative, never a calendar date: the ledger ages events against the real clock.
    at: new Date().toISOString(),
    ...over,
  });
}

function sectionFor(events: SealedExecutionEvent[]) {
  return buildExecutionGraphSectionVm(
    { executionGraph: () => ({ events, available: true }) } as never,
    "wshash",
  );
}

describe("t-441b0f — the host feeds the panel the detail the ledger already holds", () => {
  it("reaches cwd and tool through the production section builder", () => {
    const vm = sectionFor([
      ev({ detail: { seam: "AgentManager.spawnCore", agent: "ada", cwd: "/repo/checkout" } }),
      // Shaped like the Bridge seam actually emits it: `spawn` of an `InternalOperation`.
      ev({
        node: "InternalOperation",
        correlation: { agentId: "ada", executionId: "exec-2" },
        detail: { tool: "run_command" },
      }),
    ]);

    expect(vm?.status).toBe("ready");
    // This is the assertion the defect would fail: before the fix the host passed no `detailFor`,
    // so every one of these was absent while the ledger held the value all along.
    expect(vm?.details["exec-1"]?.cwd).toBe("/repo/checkout");
    expect(vm?.details["exec-2"]?.tool).toBe("run_command");
  });

  describe("the index the host hands over", () => {
    it("picks the three panel keys and nothing else out of a sanitized detail", () => {
      const index = indexExecutionDetail([
        ev({
          detail: {
            cwd: "/repo/checkout",
            worktree: "tachyon/change/thing",
            tool: "run_command",
            // Present in the ledger, deliberately NOT surfaced: the panel reads named keys only.
            seam: "AgentManager.spawnCore",
            agent: "ada",
          },
        }),
      ]);

      expect(index.get("exec-1")).toEqual({
        cwd: "/repo/checkout",
        worktree: "tachyon/change/thing",
        tool: "run_command",
      });
    });

    it("keeps the FIRST value, so a later event cannot redefine where the work ran", () => {
      const index = indexExecutionDetail([
        ev({ detail: { cwd: "/where/it/started" } }),
        ev({ kind: "exit", state: "completed", detail: { cwd: "/somewhere/else" } }),
      ]);

      expect(index.get("exec-1")?.cwd).toBe("/where/it/started");
    });

    it("treats a blank value as absent rather than as an empty fact", () => {
      // "" is not a working directory. A present-but-empty row would read as a measurement.
      const index = indexExecutionDetail([ev({ detail: { cwd: "", tool: "run_command" } })]);

      expect(index.get("exec-1")).toEqual({ tool: "run_command" });
      expect(index.get("exec-1")).not.toHaveProperty("cwd");
    });

    it("gives an execution carrying none of the keys no entry at all", () => {
      const index = indexExecutionDetail([ev({ detail: { seam: "AgentManager.spawnCore" } })]);

      expect(index.get("exec-1")).toBeUndefined();
    });

    it("keeps executions apart instead of merging their detail", () => {
      const index = indexExecutionDetail([
        ev({ detail: { cwd: "/one" } }),
        ev({ correlation: { agentId: "ada", executionId: "exec-2" }, detail: { cwd: "/two" } }),
      ]);

      expect(index.get("exec-1")?.cwd).toBe("/one");
      expect(index.get("exec-2")?.cwd).toBe("/two");
    });
  });

  it("still renders absent as absent when the ledger recorded nothing to show", () => {
    // The rule the panel already had, kept: wiring a source must not invent a row.
    const events = [ev({ detail: { seam: "AgentManager.spawnCore" } })];
    const detail = buildExecutionDetailVm(projectExecutions(events), "exec-1", (id) =>
      indexExecutionDetail(events).get(id),
    );

    expect(detail).toBeDefined();
    expect(detail).not.toHaveProperty("cwd");
    expect(detail).not.toHaveProperty("worktree");
    expect(detail).not.toHaveProperty("tool");
  });
});
