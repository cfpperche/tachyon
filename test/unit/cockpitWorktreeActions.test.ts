import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Uri } from "vscode";
import { __createdPanels, __getWarningMessageCalls, __resetVscodeMock } from "../mocks/vscode.js";
import { WORKTREES_VIEW_TYPE, WorktreesPanelManager, type WorktreesDeps } from "../../src/webview/WorktreesPanel.js";
import { readyMessage } from "../../src/webview/worktrees/messages.js";
import type { CockpitWorkspaceBundle, CockpitWorktreeRow } from "../../src/cockpit/model.js";

/**
 * SDD 485 D6 — retargeted from Control's retired Worktrees handler to the standalone dashboard host.
 * The decisive containment case sends project B's wsHash through project A's panel and proves the host
 * still calls the mutation port with A: the immutable panel target is authority; client fields are not.
 */

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  for (const panel of __createdPanels) if (!panel.disposed) panel.dispose();
});

function row(wsHash: string, id: string): CockpitWorktreeRow {
  return {
    id,
    kind: "change",
    path: `/cache/${wsHash}/${id}`,
    branch: `tachyon/${id}`,
    status: "active",
    wsHash,
    classification: {
      state: "ready-to-remove",
      reasons: [],
      pathExists: true,
      dirty: false,
      aheadOfBase: 0,
      containedInBase: true,
      containedInTrunk: true,
      trunkRef: "main",
    },
  };
}

function bundle(wsHash: string, worktree: CockpitWorktreeRow): CockpitWorkspaceBundle {
  return {
    control: {
      folderName: wsHash,
      workspaceRoot: `/${wsHash}`,
      wsHash,
      bridgeUrl: "http://127.0.0.1:1",
      identity: null,
      notes: [],
    } as CockpitWorkspaceBundle["control"],
    agents: [],
    worktrees: [worktree],
    approvals: [],
  };
}

function harness(over: Partial<WorktreesDeps> = {}): {
  manager: WorktreesPanelManager;
  removed: Array<{ id: string; deleteBranch: boolean; wsHash: string }>;
  forgotten: Array<{ id: string; wsHash: string }>;
  released: Array<{ id: string; wsHash: string }>;
} {
  const removed: Array<{ id: string; deleteBranch: boolean; wsHash: string }> = [];
  const forgotten: Array<{ id: string; wsHash: string }> = [];
  const released: Array<{ id: string; wsHash: string }> = [];
  const deps: WorktreesDeps = {
    collect: async () => [bundle("ws-a", row("ws-a", "a-only")), bundle("ws-b", row("ws-b", "b-only"))],
    revealPath: () => {},
    remove: async (id, deleteBranch, wsHash) => { removed.push({ id, deleteBranch, wsHash }); return undefined; },
    forget: async (id, wsHash) => { forgotten.push({ id, wsHash }); return undefined; },
    releaseLock: async (id, wsHash) => { released.push({ id, wsHash }); return undefined; },
    ...over,
  };
  return { manager: new WorktreesPanelManager(Uri.file("/ext"), deps), removed, forgotten, released };
}

async function open(manager: WorktreesPanelManager, wsHash: string): Promise<typeof __createdPanels[number]> {
  manager.open(wsHash);
  const panel = __createdPanels.at(-1)!;
  panel.webview.__receive(readyMessage());
  await flush();
  await flush();
  return panel;
}

function modelIds(panel: typeof __createdPanels[number]): string[] {
  const message = panel.webview.posted.filter((item) => (item as { type?: string }).type === "worktreesModel").at(-1) as
    | { model?: { worktrees?: Array<{ id: string }> } }
    | undefined;
  return message?.model?.worktrees?.map((item) => item.id) ?? [];
}

describe("SDD 485 D6 — standalone Worktrees dashboard", () => {
  it("gives two projects distinct panels and distinct content", async () => {
    const h = harness();
    const panelA = await open(h.manager, "ws-a");
    const panelB = await open(h.manager, "ws-b");
    expect(h.manager.openKeys).toEqual([`${WORKTREES_VIEW_TYPE}|ws-a`, `${WORKTREES_VIEW_TYPE}|ws-b`]);
    expect(modelIds(panelA)).toEqual(["a-only"]);
    expect(modelIds(panelB)).toEqual(["b-only"]);
  });

  it("panel A cannot remove project B even when the message claims B", async () => {
    const h = harness();
    const panelA = await open(h.manager, "ws-a");
    panelA.webview.__receive({ type: "worktreeRemove", id: "a-only", deleteBranch: true, wsHash: "ws-b" });
    await flush();
    expect(h.removed).toEqual([{ id: "a-only", deleteBranch: true, wsHash: "ws-a" }]);
  });

  it("forget uses the immutable panel project too", async () => {
    const h = harness();
    const panelA = await open(h.manager, "ws-a");
    panelA.webview.__receive({ type: "worktreeForgetRecord", id: "ghost", wsHash: "ws-b" });
    await flush();
    expect(h.forgotten).toEqual([{ id: "ghost", wsHash: "ws-a" }]);
  });

  // t-d29398 — the door added for a checkout an interrupted launch left quarantined takes the same
  // immutable-project rule as its neighbours: a row that claims another project is still acted on in
  // the panel's own.
  it("release lock uses the immutable panel project too", async () => {
    const h = harness();
    const panelA = await open(h.manager, "ws-a");
    panelA.webview.__receive({ type: "worktreeReleaseLock", id: "a-only", wsHash: "ws-b" });
    await flush();
    expect(h.released).toEqual([{ id: "a-only", wsHash: "ws-a" }]);
  });

  it("surfaces a refused release instead of claiming the lock is gone", async () => {
    const h = harness({ releaseLock: async () => "refused: agent 'codex' occupies this checkout (live)" });
    const panelA = await open(h.manager, "ws-a");
    panelA.webview.__receive({ type: "worktreeReleaseLock", id: "a-only" });
    await flush();
    expect(__getWarningMessageCalls().map((call) => call.message))
      .toContain("refused: agent 'codex' occupies this checkout (live)");
  });

  it("batch cleanup revalidates every well-formed item and ignores malformed entries", async () => {
    const h = harness();
    const panelA = await open(h.manager, "ws-a");
    panelA.webview.__receive({
      type: "worktreeBatchCleanup",
      items: [{ id: "one", op: "remove", wsHash: "ws-b" }, { id: 42, op: "forget" }, { id: "two", op: "forget" }],
    });
    await flush();
    await flush();
    expect(h.removed).toEqual([{ id: "one", deleteBranch: false, wsHash: "ws-a" }]);
    expect(h.forgotten).toEqual([{ id: "two", wsHash: "ws-a" }]);
  });

  it("surfaces an engine refusal instead of claiming success", async () => {
    const h = harness({ remove: async () => "occupied by codex" });
    const panelA = await open(h.manager, "ws-a");
    panelA.webview.__receive({ type: "worktreeRemove", id: "a-only" });
    await flush();
    expect(__getWarningMessageCalls().map((call) => call.message)).toContain("occupied by codex");
  });
});
