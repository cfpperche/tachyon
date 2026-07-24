import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { openCockpit, type CockpitMissionBoard } from "../../src/webview/Cockpit.js";
import { makeFakeCockpitDeps } from "../mocks/cockpitDeps.js";

/**
 * spec 444 (t-9f8dfc) — host-side dispatch coverage for the Worktrees hygiene actions. The engine
 * re-validates every call fail-closed; these tests prove the Cockpit host layer (a) forwards
 * single actions with their consent flags, (b) surfaces refusals as toasts instead of silent
 * success, and (c) implements the batch's drop-on-state-change semantics: a refused item is
 * SKIPPED with its reason while the rest of the batch proceeds (the spec's preview/confirm
 * concurrency acceptance criterion).
 */

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  for (const p of __createdPanels) if (!p.disposed) p.dispose();
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const missionBoard: CockpitMissionBoard = { getWorkspaces: () => [], openTaskStudio: () => {}, onTasksChanged: () => {} };

function toasts(): string[] {
  return __createdPanels[0].webview.posted
    .filter((m) => (m as { type?: string }).type === "toast")
    .map((m) => (m as { text: string }).text);
}

describe("Worktrees hygiene actions (spec 444)", () => {
  it("worktreeRemove forwards id + deleteBranch consent and stays silent on success", async () => {
    const calls: Array<{ id: string; deleteBranch: boolean; wsHash?: string }> = [];
    const deps = makeFakeCockpitDeps(missionBoard, {
      worktreeRemove: async (id, deleteBranch, wsHash) => {
        calls.push({ id, deleteBranch, wsHash });
        return undefined;
      },
    });
    await openCockpit(deps, { section: "worktrees" });
    __createdPanels[0].webview.__receive({ type: "worktreeRemove", id: "mw-1", deleteBranch: true, wsHash: "ws-1" });
    await flush();
    expect(calls).toEqual([{ id: "mw-1", deleteBranch: true, wsHash: "ws-1" }]);
    expect(toasts()).toEqual([]);
  });

  it("a refusal (state changed since render) surfaces as a toast, never silent success", async () => {
    const deps = makeFakeCockpitDeps(missionBoard, {
      worktreeRemove: async () => "refused: worktree is occupied by 'codex'",
    });
    await openCockpit(deps, { section: "worktrees" });
    __createdPanels[0].webview.__receive({ type: "worktreeRemove", id: "mw-1" });
    await flush();
    expect(toasts()).toEqual(["refused: worktree is occupied by 'codex'"]);
  });

  it("worktreeForgetRecord forwards and surfaces its refusal the same way", async () => {
    const forgotten: string[] = [];
    const deps = makeFakeCockpitDeps(missionBoard, {
      worktreeForgetRecord: async (id) => {
        forgotten.push(id);
        return id === "mw-gone" ? undefined : `record not found or refused: ${id}`;
      },
    });
    await openCockpit(deps, { section: "worktrees" });
    __createdPanels[0].webview.__receive({ type: "worktreeForgetRecord", id: "mw-gone" });
    __createdPanels[0].webview.__receive({ type: "worktreeForgetRecord", id: "mw-nope" });
    await flush();
    expect(forgotten).toEqual(["mw-gone", "mw-nope"]);
    expect(toasts()).toEqual(["record not found or refused: mw-nope"]);
  });

  it("batch cleanup: a refused item drops out with its reason while the rest proceed", async () => {
    const executed: string[] = [];
    const deps = makeFakeCockpitDeps(missionBoard, {
      worktreeRemove: async (id) => {
        executed.push(`remove:${id}`);
        // mw-b's state changed between the client's preview and this execution — refuse it.
        return id === "mw-b" ? "an agent started occupying this path" : undefined;
      },
      worktreeForgetRecord: async (id) => {
        executed.push(`forget:${id}`);
        return undefined;
      },
    });
    await openCockpit(deps, { section: "worktrees" });
    __createdPanels[0].webview.__receive({
      type: "worktreeBatchCleanup",
      items: [
        { id: "mw-a", op: "remove" },
        { id: "mw-b", op: "remove" },
        { id: "mw-c", op: "forget" },
      ],
    });
    await flush();
    expect(executed).toEqual(["remove:mw-a", "remove:mw-b", "forget:mw-c"]);
    const summary = toasts().at(-1) ?? "";
    expect(summary).toContain("2 done");
    expect(summary).toContain("1 skipped");
    expect(summary).toContain("mw-b: an agent started occupying this path");
  });

  it("batch cleanup ignores malformed items instead of crashing the batch", async () => {
    const executed: string[] = [];
    const deps = makeFakeCockpitDeps(missionBoard, {
      worktreeForgetRecord: async (id) => {
        executed.push(id);
        return undefined;
      },
    });
    await openCockpit(deps, { section: "worktrees" });
    __createdPanels[0].webview.__receive({
      type: "worktreeBatchCleanup",
      items: [{ id: "mw-ok", op: "forget" }, { id: 42, op: "forget" }, { op: "forget" }, "garbage", null],
    });
    await flush();
    expect(executed).toEqual(["mw-ok"]);
    expect(toasts().at(-1)).toContain("1 done");
  });
});
