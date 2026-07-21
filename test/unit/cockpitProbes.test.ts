import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { openCockpit, refreshCockpitProbes, type CockpitMissionBoard, type CockpitProbes } from "../../src/webview/Cockpit.js";
import type { WorkspaceProbePresentationTarget } from "../../src/shell/WorkspacePresentation.js";
import { makeFakeCockpitDeps } from "../mocks/cockpitDeps.js";
import type { ProbeView } from "../../src/probe/probeView.js";

/**
 * t-610705 (SDD 410 Phase C.2) — Probes ROUTING coverage for Control → fleet/agent/<name>/probes
 * (agent-probes) and fleet/probes (workspace-probes, the unfiltered debug escape hatch, spec 322).
 * Unlike Activity, Probes has no persistent watcher — it's a plain async fetch (ws.probeView) on
 * route entry/poll/fan-out, so the load-bearing behavior is the SAME-ROUTE double-call ordering
 * guard (mirrors the retired ProbeResultPanelManager's renderToken, ported verbatim as
 * probesRequestToken) plus the route-identity guard (navEpoch).
 */

beforeEach(() => __resetVscodeMock());
afterEach(() => { for (const p of __createdPanels) if (!p.disposed) p.dispose(); });

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function emptyView(caller?: string): ProbeView {
  return { rows: [], total: 0, running: 0, completed: 0, failed: 0, empty: true, ...(caller ? { caller } : {}) };
}

function probeTarget(overrides: Partial<WorkspaceProbePresentationTarget> = {}): WorkspaceProbePresentationTarget {
  return {
    workspaceRoot: "/ws",
    wsHash: "ws-1",
    folderName: "Project",
    probeView: async (caller?: string) => emptyView(caller),
    ...overrides,
  };
}

function depsFor(probes: CockpitProbes) {
  const missionBoard: CockpitMissionBoard = { getWorkspaces: () => [], openTaskStudio: () => {}, onTasksChanged: () => {} };
  return makeFakeCockpitDeps(missionBoard, { probes });
}

const probesMessages = () => __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "probes") as Array<{ vm: { folder: string; view?: ProbeView; error?: string } }>;

async function openProbes(deps: ReturnType<typeof depsFor>, route: { kind: "agent-probes"; wsHash: string; agent: string } | { kind: "workspace-probes"; wsHash: string }): Promise<void> {
  await openCockpit(deps, { route });
  __createdPanels[0].webview.__receive({ type: "ready" });
  await flush();
}

describe("Control → Probes routing", () => {
  it("agent-probes fetches the CALLER-scoped view", async () => {
    let seenCaller: string | undefined;
    const target = probeTarget({ probeView: async (caller) => { seenCaller = caller; return emptyView(caller); } });
    const deps = depsFor({ getWorkspaces: () => [target] });
    await openProbes(deps, { kind: "agent-probes", wsHash: "ws-1", agent: "claude" });

    expect(seenCaller).toBe("claude");
    expect(probesMessages().at(-1)?.vm.view?.caller).toBe("claude");
  });

  it("workspace-probes fetches the UNFILTERED view (caller undefined — spec 322 debug escape hatch)", async () => {
    let seenCaller: string | undefined | "unset" = "unset";
    const target = probeTarget({ probeView: async (caller) => { seenCaller = caller; return emptyView(caller); } });
    const deps = depsFor({ getWorkspaces: () => [target] });
    await openProbes(deps, { kind: "workspace-probes", wsHash: "ws-1" });

    expect(seenCaller).toBeUndefined();
    expect(probesMessages().at(-1)?.vm.view?.caller).toBeUndefined();
  });

  it("a load failure renders a distinct error VM, never a false-empty ledger", async () => {
    const target = probeTarget({ probeView: async () => { throw new Error("disk read failed"); } });
    const deps = depsFor({ getWorkspaces: () => [target] });
    await openProbes(deps, { kind: "agent-probes", wsHash: "ws-1", agent: "claude" });

    const msg = probesMessages().at(-1);
    expect(msg?.vm.error).toBe("disk read failed");
    expect(msg?.vm.view).toBeUndefined();
  });

  it("a slower FIRST response resolving after a second same-route request never overwrites the fresher one", async () => {
    // mirrors the retired ProbeResultPanelManager's renderToken guard — two requests for the SAME
    // route can legitimately overlap (e.g. ready racing the refreshCockpitProbes fan-out).
    let resolveFirst!: (v: ProbeView) => void;
    const first = new Promise<ProbeView>((res) => { resolveFirst = res; });
    let calls = 0;
    const target = probeTarget({
      probeView: async () => {
        calls += 1;
        if (calls === 1) return first;
        return { ...emptyView(), total: 2, rows: [] };
      },
    });
    const deps = depsFor({ getWorkspaces: () => [target] });
    await openCockpit(deps, { route: { kind: "agent-probes", wsHash: "ws-1", agent: "claude" } });
    __createdPanels[0].webview.__receive({ type: "ready" }); // wedges on `first`
    await flush();
    expect(probesMessages()).toHaveLength(0);

    refreshCockpitProbes(); // a second request for the SAME route — resolves immediately (calls===2)
    await flush();
    const fresh = probesMessages().at(-1);
    expect(fresh?.vm.view?.total).toBe(2);

    resolveFirst(emptyView()); // the wedged FIRST call finally settles — its token is now stale
    await flush();
    await flush();

    expect(probesMessages().at(-1)?.vm.view?.total).toBe(2); // still the fresh one, never overwritten
  });

  it("a workspace switch (navEpoch bump) discards a slow in-flight response built for the old scope", async () => {
    let resolveClaude!: (v: ProbeView) => void;
    const wedged = new Promise<ProbeView>((res) => { resolveClaude = res; });
    const claudeTarget = probeTarget({ wsHash: "ws-1", probeView: async () => wedged });
    const codexTarget = probeTarget({ wsHash: "ws-2", probeView: async () => ({ ...emptyView(), total: 9 }) });
    const deps = depsFor({ getWorkspaces: () => [claudeTarget, codexTarget] });
    await openCockpit(deps, { route: { kind: "agent-probes", wsHash: "ws-1", agent: "claude" } });
    __createdPanels[0].webview.__receive({ type: "ready" }); // wedges
    await flush();

    // navigate to a DIFFERENT probes route (bumps navEpoch via navigate())
    await openCockpit(deps, { route: { kind: "agent-probes", wsHash: "ws-2", agent: "codex" } });
    await flush();
    expect(probesMessages().at(-1)?.vm.view?.total).toBe(9);

    resolveClaude(emptyView()); // the stale ws-1 response settles after the switch
    await flush();
    await flush();

    expect(probesMessages().at(-1)?.vm.view?.total).toBe(9); // unchanged — the stale response was dropped
  });

  it("refreshCockpitProbes re-fetches and re-posts an open probes route", async () => {
    let total = 1;
    const target = probeTarget({ probeView: async () => ({ ...emptyView(), total }) });
    const deps = depsFor({ getWorkspaces: () => [target] });
    await openProbes(deps, { kind: "agent-probes", wsHash: "ws-1", agent: "claude" });
    expect(probesMessages().at(-1)?.vm.view?.total).toBe(1);

    total = 2;
    refreshCockpitProbes();
    await flush();

    expect(probesMessages().at(-1)?.vm.view?.total).toBe(2);
  });

  it("refreshCockpitProbes is a no-op off a probes route", async () => {
    const target = probeTarget();
    const deps = depsFor({ getWorkspaces: () => [target] });
    await openCockpit(deps, { section: "overview" });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();

    expect(() => refreshCockpitProbes()).not.toThrow();
    await flush();
    expect(probesMessages()).toHaveLength(0);
  });

  it("a missing workspace posts an explicit 'no workspace' error, not a throw", async () => {
    const deps = depsFor({ getWorkspaces: () => [] });
    await openProbes(deps, { kind: "agent-probes", wsHash: "gone", agent: "claude" });

    const msg = probesMessages().at(-1);
    expect(msg?.vm.error).toMatch(/No Tachyon workspace/);
  });
});
