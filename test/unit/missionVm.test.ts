import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../../src/tasks/TaskStore.js";
import { ValidationStore } from "../../src/validations/ValidationStore.js";
import { MISSION_CONTROL_AGENT_LIST_TIMEOUT_MS, MissionAgentLists, buildMissionVm } from "../../src/cockpit/missionVm.js";
import { legacyMissionControlTarget, type WorkspaceMissionControlTarget } from "../../src/shell/MissionControlTarget.js";
import type { Workspace } from "../../src/workspace/Workspace.js";

// t-610705 Phase B #6 — the bounded/coalesced agent-liveness pass, ported from the retired
// MissionControlPanelManager into src/cockpit/missionVm.ts (Control → Mission is the one board now).
// These tests carry over the panel-era coverage of the SAME mechanism: liveness must enrich the
// board, never gate its task snapshot.

const dirs: string[] = [];
const mkroot = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mission-vm-"));
  dirs.push(dir);
  return dir;
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeWorkspace(root = mkroot(), agents: Record<string, unknown> = {}, opts: { hash?: string; name?: string; managedEntries?: Array<{ name: string; running?: boolean; lifetime?: "saved" | "temporary"; kind?: "agent" | "terminal" }> } = {}) {
  return {
    wsHash: opts.hash ?? "ws-1",
    folderName: opts.name ?? "Project",
    workspaceRoot: root,
    taskStore: new TaskStore(root),
    validationStore: new ValidationStore(root),
    config: { agents },
    manager: {
      listAgents: async () => (opts.managedEntries ?? []).filter((a) => (a.kind ?? "agent") === "agent").map((a) => ({
        session: `tachyon-test-${a.name}`,
        dead: false,
        crashed: false,
        ...a,
        running: a.running ?? true,
        lifetime: a.lifetime ?? "temporary",
        kind: a.kind ?? "agent",
      })),
    },
  } as unknown as Workspace;
}

const target = (workspace: Workspace): WorkspaceMissionControlTarget => legacyMissionControlTarget(workspace);

describe("buildMissionVm (bounded agent liveness)", () => {
  it("computes liveness + live ad-hoc chips when the agent list resolves in time", async () => {
    const ws = fakeWorkspace(undefined, { codex: {} }, { managedEntries: [{ name: "codex", lifetime: "saved" }, { name: "live-ad-hoc" }] });
    const t = await ws.taskStore.create({ title: "seed", author: "human" });
    await ws.taskStore.update(t.id, { status: "triaged", assignee: "open-ad-hoc" });

    const vm = await buildMissionVm(target(ws), new MissionAgentLists(), () => {});

    expect(vm.agentLiveness).toEqual({ status: "available" });
    expect(vm.snapshot.chips.map((c) => c.agent)).toEqual(["codex", "human", "live-ad-hoc", "open-ad-hoc"]);
  });

  it("renders the task snapshot with liveness unavailable when the list never resolves — and a late rejection stays observed", async () => {
    const pending = deferred<never>();
    const ws = fakeWorkspace();
    ws.manager.listAgents = () => pending.promise;
    await ws.taskStore.create({ title: "task store survives", author: "human" });

    const vmPromise = buildMissionVm(target(ws), new MissionAgentLists(), () => {});
    await vi.advanceTimersByTimeAsync(MISSION_CONTROL_AGENT_LIST_TIMEOUT_MS);
    const vm = await vmPromise;

    expect(vm.agentLiveness).toEqual({ status: "unavailable" });
    expect(vm.snapshot.views.map((v) => v.task.title)).toEqual(["task store survives"]);

    pending.reject(new Error("late tmux failure"));
    await vi.advanceTimersByTimeAsync(0); // an unhandled rejection here would fail the test run
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejection before the timeout also falls back to unavailable without gating the snapshot", async () => {
    const ws = fakeWorkspace();
    ws.manager.listAgents = async () => { throw new Error("tmux down"); };
    await ws.taskStore.create({ title: "still renders", author: "human" });

    const vmPromise = buildMissionVm(target(ws), new MissionAgentLists(), () => {});
    await vi.advanceTimersByTimeAsync(0);
    const vm = await vmPromise;

    expect(vm.agentLiveness).toEqual({ status: "unavailable" });
    expect(vm.snapshot.views.map((v) => v.task.title)).toEqual(["still renders"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("MissionAgentLists (per-workspace coalescing + trailing retry)", () => {
  it("coalesces concurrent refreshes onto one list() call and fires exactly one trailing retry after a timed-out list settles", async () => {
    const pending = deferred<never[]>();
    const list = vi.fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce([]);
    const lists = new MissionAgentLists();
    let retries = 0;
    const retry = () => { retries += 1; };

    // three concurrent refreshes before the timeout: ONE underlying list() call
    const first = lists.bounded("ws-1", list, retry);
    void lists.bounded("ws-1", list, retry);
    void lists.bounded("ws-1", list, retry);
    await Promise.resolve();
    expect(list).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MISSION_CONTROL_AGENT_LIST_TIMEOUT_MS);
    expect((await first).status).toEqual({ status: "unavailable" });

    // refreshes AFTER the fallback keep coalescing on the still-pending source and mark it trailing
    void lists.bounded("ws-1", list, retry);
    void lists.bounded("ws-1", list, retry);
    await Promise.resolve();
    expect(list).toHaveBeenCalledTimes(1);
    expect(retries).toBe(0);

    pending.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(retries).toBe(1); // exactly one trailing retry, not one per coalesced refresh

    // the retry's own refresh starts a FRESH request
    const recovered = await lists.bounded("ws-1", list, retry);
    expect(list).toHaveBeenCalledTimes(2);
    expect(recovered.status).toEqual({ status: "available" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not fire a trailing retry when the list settles in time (no fallback happened)", async () => {
    const lists = new MissionAgentLists();
    let retries = 0;
    const result = lists.bounded("ws-1", async () => [], () => { retries += 1; });
    await vi.advanceTimersByTimeAsync(0);
    expect((await result).status).toEqual({ status: "available" });
    expect(retries).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps workspaces independent — a wedged list in one workspace does not coalesce another's", async () => {
    const wedged = deferred<never[]>();
    const listA = vi.fn(() => wedged.promise);
    const listB = vi.fn(async () => []);
    const lists = new MissionAgentLists();

    const a = lists.bounded("ws-a", listA, () => {});
    const b = lists.bounded("ws-b", listB, () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect((await b).status).toEqual({ status: "available" });

    await vi.advanceTimersByTimeAsync(MISSION_CONTROL_AGENT_LIST_TIMEOUT_MS);
    expect((await a).status).toEqual({ status: "unavailable" });
    expect(listA).toHaveBeenCalledTimes(1);
    expect(listB).toHaveBeenCalledTimes(1);
    wedged.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
  });
});
