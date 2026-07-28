import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "../helpers/tempDir.js";
import { makeExecutionGraphDep, type ExecutionGraphWorkspace } from "../../src/cockpit/executionGraphDep.js";
import { buildExecutionGraphSectionVm } from "../../src/webview/Cockpit.js";
import { openExecutionLedger, executionLedgerLocation } from "../../src/executionGraph/executionLedger.js";
import { sealExecutionEvent } from "../../src/executionGraph/eventSchema.js";
import type { EngineCurrency } from "../../src/engine-service/engineCurrency.js";

/**
 * t-c6a89e — the wiring, driven end to end: workspace → ledger on disk → the section's view-model.
 *
 * Every piece of this already had tests and they all passed while Control showed `no-telemetry` for
 * every workspace forever, because nobody supplied the dependency. So these tests start from
 * `makeExecutionGraphDep` — the function `activate()` actually calls — and end at
 * `buildExecutionGraphSectionVm`, the function the panel actually renders from.
 */

const HASH = "a2e81f24";
const OTHER = "b349073a";

function workspace(over: Partial<ExecutionGraphWorkspace> & { currency?: EngineCurrency } = {}): ExecutionGraphWorkspace {
  return {
    workspaceRoot: over.workspaceRoot ?? "/repo",
    wsHash: over.wsHash ?? HASH,
    client: { engineCurrency: over.currency ?? { kind: "unknown" } },
  };
}

function recordInto(storageRoot: string, workspaceHash: string, ids: string[]): void {
  const ledger = openExecutionLedger({ storageRoot, workspaceHash });
  for (const id of ids) {
    ledger.record(sealExecutionEvent({
      kind: "spawn", node: "Process", state: "running", provenance: "measured",
      correlation: { agentId: "ada", executionId: id },
      // t-2622eb — relative, never a calendar date: the ledger ages events against the real clock.
      at: new Date().toISOString(),
      detail: { cwd: "/repo/checkout" },
    }));
  }
}

describe("t-c6a89e — Control's execution dependency, as production builds it", () => {
  it("takes the section from no-telemetry to a real graph", () => {
    const storageRoot = makeTempDir("exec-dep-ready-");
    recordInto(storageRoot, HASH, ["exec-1", "exec-2"]);
    const dep = makeExecutionGraphDep(() => workspace(), () => storageRoot);

    const vm = buildExecutionGraphSectionVm({ executionGraph: dep } as never, HASH);

    expect(vm?.status).toBe("ready");
    expect(vm?.matched).toBe(2);
    // t-441b0f's detail arrives with it — the whole chain, not just the status.
    expect(vm?.details["exec-1"]?.cwd).toBe("/repo/checkout");
  });

  describe("it reads the ledger of the workspace it was asked about", () => {
    it("uses the resolved workspace's own root and hash", () => {
      // Two workspaces, two storage roots: asking for one must never return the other's history.
      const mine = makeTempDir("exec-dep-mine-");
      const theirs = makeTempDir("exec-dep-theirs-");
      recordInto(mine, HASH, ["exec-mine"]);
      recordInto(theirs, OTHER, ["exec-theirs-1", "exec-theirs-2"]);
      const roots = new Map([["/mine", mine], ["/theirs", theirs]]);
      const dep = makeExecutionGraphDep(
        (hash) => hash === OTHER
          ? workspace({ workspaceRoot: "/theirs", wsHash: OTHER })
          : workspace({ workspaceRoot: "/mine", wsHash: HASH }),
        (root) => roots.get(root)!,
      );

      expect(dep(HASH).events.map((e) => e.correlation.executionId)).toEqual(["exec-mine"]);
      expect(dep(OTHER).events).toHaveLength(2);
    });

    it("answers absent, not empty-with-an-excuse, when no workspace resolves", () => {
      // None open, or several with none selected. There is no engine here whose age could explain
      // anything, so no currency is offered either.
      const dep = makeExecutionGraphDep(() => undefined, () => makeTempDir("exec-dep-nows-"));

      expect(dep(undefined)).toEqual({ events: [], available: false });
    });
  });

  describe("fail honest", () => {
    it("reports no-telemetry when the workspace has never recorded", () => {
      const dep = makeExecutionGraphDep(() => workspace(), () => makeTempDir("exec-dep-virgin-"));

      expect(buildExecutionGraphSectionVm({ executionGraph: dep } as never, HASH)?.status).toBe("no-telemetry");
    });

    it("surfaces a corrupt ledger as an error with its reason, never as 'nothing ran'", () => {
      const storageRoot = makeTempDir("exec-dep-corrupt-");
      recordInto(storageRoot, HASH, ["exec-1"]);
      fs.appendFileSync(executionLedgerLocation({ storageRoot, workspaceHash: HASH }).filePath, "{nope}\n");
      const dep = makeExecutionGraphDep(() => workspace(), () => storageRoot);

      const vm = buildExecutionGraphSectionVm({ executionGraph: dep } as never, HASH);

      expect(vm?.status).toBe("error");
      expect(vm?.errorDetail).toBeTruthy();
    });
  });

  describe("an empty section explains itself when the engine is the reason", () => {
    it("carries the stale-daemon note through to the view-model", () => {
      const dep = makeExecutionGraphDep(
        () => workspace({
          currency: {
            kind: "outdated",
            runningBundleId: "old",
            expectedBundleId: "new",
            startedAt: "2026-07-26T16:32:34.000Z",
          },
        }),
        () => makeTempDir("exec-dep-stale-"),
      );

      const vm = buildExecutionGraphSectionVm({ executionGraph: dep } as never, HASH);

      expect(vm?.status).toBe("no-telemetry");
      expect(vm?.statusNote).toContain("2026-07-26T16:32:34.000Z");
    });

    it("says nothing extra when the client never compared", () => {
      // `unknown` must not become an explanation: a guess here sends someone to restart production.
      const dep = makeExecutionGraphDep(() => workspace(), () => makeTempDir("exec-dep-unknown-"));

      expect(buildExecutionGraphSectionVm({ executionGraph: dep } as never, HASH)?.statusNote).toBeUndefined();
    });
  });

  /**
   * A TRIPWIRE, and I am not going to call it more than that.
   *
   * Everything above drives `makeExecutionGraphDep`, so all of it would stay green if `activate()`
   * stopped calling it — which is precisely the defect this task exists to fix, one level up.
   * `src/extension.ts` only loads inside a real extension host, so the honest behavioural guard is
   * the editor gate, not a unit test.
   *
   * Matching source text is a weak check and I have been burned by one before (t-0d689f): it proves
   * a string is present, not that a dependency is wired. It earns its place only because the
   * alternative here is no guard at all, and because it fails LOUDLY and specifically — anyone who
   * renames or moves this has to come and change it on purpose.
   */
  it("is actually supplied by the extension host's dependency factory", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "..", "..", "src/extension.ts"), "utf8");

    expect(source).toContain("executionGraph: makeExecutionGraphDep(byHash)");
  });

  it("does not create the state directory for a workspace that never recorded", () => {
    // The read-only contract, asserted where production calls it: the engine is the single writer.
    const storageRoot = makeTempDir("exec-dep-noowrite-");
    const dep = makeExecutionGraphDep(() => workspace(), () => storageRoot);

    dep(HASH);

    expect(fs.existsSync(path.join(storageRoot, "events"))).toBe(false);
  });
});
