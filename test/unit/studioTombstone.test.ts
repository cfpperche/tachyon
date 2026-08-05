import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { SingleModeStudioPanelManager } from "../../src/webview/shared/studio/SingleModeStudioPanelManager.js";
import type { StudioHostAdapter, StudioLoadResult, StudioSaveResult } from "../../src/webview/shared/studio/adapter.js";
import { CORE_MESSAGE_TYPES, envelope } from "../../src/webview/shared/studio/protocol.js";
import { acceptsWhileVanished, decideVanishedDraft, isTombstone, readTombstoneMessage } from "../../src/webview/shared/studio/tombstone.js";
import { TaskDocumentEditPolicy } from "../../src/webview/task-detail/editPolicy.js";
import { webviewApp } from "../../src/webview/webviewApps.js";
import type { WorkspaceStudioTarget } from "../../src/shell/WorkspacePresentation.js";

/**
 * t-b643ac — an Agent Studio whose agent was REMOVED (Forget) kept the whole editor mounted under a
 * red "not found" line, with the lifecycle actions live and Save reachable. The cause was a category
 * error at one line: `adapter.load()` answering `not-found` was posted as an `error`, so the client
 * could not tell "your load failed" from "the thing you edit is gone" and drew both as an editor.
 *
 * The fix is the tombstone contract spec 335 already gave the task document (taskDetailVm.ts's
 * `emptyTombstoneVm`), expressed for studios. These tests drive the REAL host every one of the five
 * single-mode studios runs on (`SingleModeStudioPanelManager` — command/terminal/runbook/schedule/
 * agent all extend it), through the door production uses: the webview posts `ready`, the adapter
 * answers, and the assertions read what actually reached the panel.
 *
 * Every guard here was watched FAIL first against the pre-fix tree (the task journal records which
 * assertion each one produced): the tombstone tests saw `type: "error"`, and the save-refusal test
 * saw `adapter.save` called on an agent that no longer existed.
 */

const {
  __resetVscodeMock,
  __createdPanels,
} = vscode as unknown as {
  __resetVscodeMock(): void;
  __createdPanels: Array<{
    title: string;
    disposed: boolean;
    dispose(): void;
    webview: { posted: unknown[]; __receive(msg: unknown): void };
  }>;
};

interface Agent {
  name: string;
  role: string;
}
type AgentFields = { role: string };

interface AdapterCalls {
  saved: Array<{ entityId: string | undefined; patch: AgentFields }>;
  cancelled: Array<string | undefined>;
}

function makeAdapter(roster: Map<string, Agent>, calls: AdapterCalls): StudioHostAdapter<Agent, AgentFields, AgentFields> {
  return {
    entityType: "agent",
    domainMessageNames: ["forgetAgent"],
    concurrency: { kind: "none" },
    allowPatchRestore: true,
    dirty: {
      computeDirty: (entity, fields) => (entity?.role ?? "") !== fields.role,
      serializePatch: (fields, dirty) => (dirty ? fields : undefined),
      canDiscard: () => false,
    },
    titleFor: (mode, entityId) => (mode === "new" ? "New Agent" : `Agent Studio — ${entityId}`),
    load: (entityId): StudioLoadResult<Agent> => {
      if (entityId === undefined) return { status: "ok", entity: { name: "", role: "" } };
      const found = roster.get(entityId);
      return found ? { status: "ok", entity: found } : { status: "not-found" };
    },
    validate: () => ({ blocking: [], nonBlocking: [] }),
    save: (entityId, patch): StudioSaveResult => {
      calls.saved.push({ entityId, patch });
      return { status: "ok" };
    },
    onCancel: (entityId) => { calls.cancelled.push(entityId); },
  };
}

const WS: WorkspaceStudioTarget = { wsHash: "ws-a" } as unknown as WorkspaceStudioTarget;

interface Harness {
  manager: SingleModeStudioPanelManager;
  roster: Map<string, Agent>;
  calls: AdapterCalls;
}

function harness(): Harness {
  const roster = new Map<string, Agent>([["grok", { name: "grok", role: "prober" }]]);
  const calls: AdapterCalls = { saved: [], cancelled: [] };
  const manager = new SingleModeStudioPanelManager(vscode.Uri.file("/ext"), {
    app: webviewApp("agent-studio-shell"),
    styleFiles: ["codicon.css", "design-system.css", "studio-frame.css", "agent-studio-shell.css"],
    iconName: "agent",
    getWorkspaces: () => [WS],
    makeAdapter: () => makeAdapter(roster, calls),
    onChanged: () => {},
  });
  return { manager, roster, calls };
}

/** The adapter's load/save are awaited even when synchronous — drain the microtask queue. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const panel = (index = 0) => __createdPanels[index];
const postedOfType = (type: string, index = 0) =>
  panel(index).webview.posted.filter((m): m is Record<string, unknown> => (m as { type?: string })?.type === type);
const ready = (index = 0) => panel(index).webview.__receive(envelope({ type: "ready" }));

beforeEach(() => {
  __resetVscodeMock();
});

describe("t-b643ac — the studio tombstone contract", () => {
  it("posts `tombstone`, NOT `error`, when the entity is gone", async () => {
    const h = harness();
    h.manager.openExisting("ws-a", "grok");
    ready();
    await flush();
    expect(postedOfType("load")).toHaveLength(1);

    h.roster.delete("grok");
    h.manager.refresh();
    await flush();

    // The RED assertion: pre-fix this was `[{type:"error", code:"transport/unknown", ...}]`.
    expect(postedOfType("error")).toHaveLength(0);
    expect(postedOfType("tombstone")).toMatchObject([
      { type: "tombstone", entityType: "agent", entityId: "grok", discardedDraft: false },
    ]);
  });

  it("tombstones through refreshReferenceData — the door extension.ts ACTUALLY uses", async () => {
    // The trap this repo has paid for before (0.56.159): a green test proves the door you called
    // works, never that it was the only door. `SingleModeStudioPanelManager.refresh()` is not called
    // from extension.ts AT ALL — every external invalidation into an open studio arrives as
    // `refreshReferenceData()` (extension.ts's views-changed fan-out). So THIS is the path a Forget
    // travels, and testing only `refresh()` above would have left the reported bug alive.
    const h = harness();
    h.manager.openExisting("ws-a", "grok");
    ready();
    await flush();

    h.roster.delete("grok");
    h.manager.refreshReferenceData();
    await flush();

    expect(postedOfType("error")).toHaveLength(0);
    expect(postedOfType("referenceData")).toHaveLength(0);
    expect(postedOfType("tombstone")).toMatchObject([{ entityId: "grok", title: "Agent Studio — grok" }]);
  });

  it("carries the last GOOD title so the tombstone can name what it was (spec 335's last projection)", async () => {
    const h = harness();
    h.manager.openExisting("ws-a", "grok");
    ready();
    await flush();

    h.roster.delete("grok");
    h.manager.refresh();
    await flush();

    expect(postedOfType("tombstone")[0]).toMatchObject({ title: "Agent Studio — grok" });
  });

  it("omits the title when the panel never completed a load (emptyTombstoneVm's no-last-known case)", async () => {
    const h = harness();
    h.roster.delete("grok");
    // A tab revived onto an entity removed while the window was closed: the FIRST load already fails.
    h.manager.openExisting("ws-a", "grok");
    ready();
    await flush();

    const tombstone = postedOfType("tombstone")[0];
    expect(tombstone).toMatchObject({ entityId: "grok", discardedDraft: false });
    expect(tombstone).not.toHaveProperty("title");
  });

  it("REFUSES save on a vanished entity — the button is not the only door", async () => {
    const h = harness();
    h.manager.openExisting("ws-a", "grok");
    ready();
    await flush();
    // The human edits, so a patch exists host-side; then the agent is removed underneath them.
    panel().webview.__receive(envelope({ type: "patch", patch: { role: "edited" } }));
    panel().webview.__receive(envelope({ type: "dirty", dirty: true }));
    h.roster.delete("grok");
    h.manager.refresh();
    await flush();

    // A `save` that was already in flight when the tombstone landed — no button involved.
    panel().webview.__receive(envelope({ type: "save" }));
    await flush();

    // The RED assertion: pre-fix `adapter.save` ran and wrote a removed agent back to disk.
    expect(h.calls.saved).toEqual([]);
    expect(postedOfType("save")).toHaveLength(0);
  });

  it("REFUSES adapter domain actions on a vanished entity (Forget/Rename/Export on a gone agent)", async () => {
    const domain: Array<{ type: string }> = [];
    const roster = new Map<string, Agent>([["grok", { name: "grok", role: "prober" }]]);
    const calls: AdapterCalls = { saved: [], cancelled: [] };
    const manager = new SingleModeStudioPanelManager(vscode.Uri.file("/ext"), {
      app: webviewApp("agent-studio-shell"),
      styleFiles: ["codicon.css"],
      iconName: "agent",
      getWorkspaces: () => [WS],
      makeAdapter: () => makeAdapter(roster, calls),
      onChanged: () => {},
      handleDomainMessage: (_ws, _ctx, message) => { domain.push(message); },
    });
    manager.openExisting("ws-a", "grok");
    ready();
    await flush();
    panel().webview.__receive(envelope({ type: "forgetAgent" }));
    expect(domain).toHaveLength(1);

    roster.delete("grok");
    manager.refresh();
    await flush();
    panel().webview.__receive(envelope({ type: "forgetAgent" }));

    expect(domain).toHaveLength(1);
  });

  it("still accepts `cancel` — closing the tab is the only action left", async () => {
    const h = harness();
    h.manager.openExisting("ws-a", "grok");
    ready();
    await flush();
    h.roster.delete("grok");
    h.manager.refresh();
    await flush();

    panel().webview.__receive(envelope({ type: "cancel" }));
    await flush();
    expect(panel().disposed).toBe(true);
  });

  it("re-tells a remounted webview it is a tombstone instead of leaving it loading", async () => {
    const h = harness();
    h.manager.openExisting("ws-a", "grok");
    ready();
    await flush();
    h.roster.delete("grok");
    h.manager.refresh();
    await flush();
    expect(postedOfType("tombstone")).toHaveLength(1);

    ready(); // the webview remounted (retainContextWhenHidden off, or a reload)
    await flush();

    expect(postedOfType("tombstone")).toHaveLength(2);
    expect(postedOfType("load")).toHaveLength(1);
  });

  it("reports a discarded draft once, and does not re-claim the loss on a replay", async () => {
    const h = harness();
    h.manager.openExisting("ws-a", "grok");
    ready();
    await flush();
    panel().webview.__receive(envelope({ type: "patch", patch: { role: "edited" } }));
    panel().webview.__receive(envelope({ type: "dirty", dirty: true }));

    h.roster.delete("grok");
    h.manager.refresh();
    await flush();
    ready();
    await flush();

    const tombstones = postedOfType("tombstone");
    expect(tombstones).toHaveLength(2);
    expect(tombstones[0]).toMatchObject({ discardedDraft: true });
    // Told once. The second telling must not claim work was still there to lose.
    expect(tombstones[1]).toMatchObject({ discardedDraft: true });
  });

  it("EVICTS the retained draft so a later namesake never inherits a dead entity's edits", async () => {
    const h = harness();
    h.manager.openExisting("ws-a", "grok");
    ready();
    await flush();
    panel().webview.__receive(envelope({ type: "patch", patch: { role: "edited" } }));
    panel().webview.__receive(envelope({ type: "dirty", dirty: true }));

    h.roster.delete("grok");
    h.manager.refresh();
    await flush();
    // The human CLOSES THE TAB — deliberately not `cancel`. Cancel clears the draft on every path,
    // including the broken one, so a cancel-based scenario is a guard that cannot fail: it passed
    // against the pre-fix tree on the first run of this file. Tab close is the door that RETAINS a
    // draft (`policy.close()` → `this.drafts.set`), which is the door the defect lives behind.
    panel().dispose();
    await flush();

    // Someone creates a NEW agent under the same name. Same identity ⇒ same retained-draft key.
    h.roster.set("grok", { name: "grok", role: "fresh" });
    h.manager.openExisting("ws-a", "grok");
    ready(1);
    await flush();

    // The RED assertion: pre-fix the dead agent's unsaved `role: "edited"` was restored onto this one.
    expect(postedOfType("restore", 1)).toHaveLength(0);
    expect(postedOfType("load", 1)[0]).toMatchObject({ entity: { role: "fresh" } });
  });

  it("keeps a not-found on a NEW-entity panel an error — nothing was ever supposed to exist there", async () => {
    const roster = new Map<string, Agent>();
    const calls: AdapterCalls = { saved: [], cancelled: [] };
    const adapter = makeAdapter(roster, calls);
    const manager = new SingleModeStudioPanelManager(vscode.Uri.file("/ext"), {
      app: webviewApp("agent-studio-shell"),
      styleFiles: ["codicon.css"],
      iconName: "agent",
      getWorkspaces: () => [WS],
      makeAdapter: () => ({ ...adapter, load: () => ({ status: "not-found" as const }) }),
      onChanged: () => {},
    });
    manager.openNew("ws-a");
    ready();
    await flush();

    expect(postedOfType("tombstone")).toHaveLength(0);
    expect(postedOfType("error")).toHaveLength(1);
  });
});

describe("t-b643ac — the tombstone decision module", () => {
  it("tombstones a missing SAVED entity and nothing else", () => {
    expect(isTombstone({ status: "not-found", entityId: "grok" })).toBe(true);
    expect(isTombstone({ status: "not-found", entityId: undefined })).toBe(false);
    expect(isTombstone({ status: "error", entityId: "grok" })).toBe(false);
    expect(isTombstone({ status: "ok", entityId: "grok" })).toBe(false);
  });

  it("reports a draft as discarded only when there was unsaved work to discard", () => {
    expect(decideVanishedDraft({ dirty: true, hasPatch: true })).toBe(true);
    expect(decideVanishedDraft({ dirty: true, hasPatch: false })).toBe(false);
    expect(decideVanishedDraft({ dirty: false, hasPatch: true })).toBe(false);
  });

  it("lets exactly `ready` and `cancel` through a vanished panel", () => {
    expect(acceptsWhileVanished("ready")).toBe(true);
    expect(acceptsWhileVanished("cancel")).toBe(true);
    for (const type of ["save", "patch", "dirty", "forgetAgent", "renameAgent"]) {
      expect(acceptsWhileVanished(type), type).toBe(false);
    }
  });

  it("carries every field across the boundary, and omits the absent ones", () => {
    expect(readTombstoneMessage({ entityType: "agent", entityId: "grok", title: "Agent Studio — grok", discardedDraft: true }))
      .toEqual({ entityType: "agent", entityId: "grok", title: "Agent Studio — grok", discardedDraft: true });
    expect(readTombstoneMessage({ entityType: "command", discardedDraft: false }))
      .toEqual({ entityType: "command", discardedDraft: false });
  });

  it("registers `tombstone` as a CORE protocol name so the boundary decoder accepts it", () => {
    expect(CORE_MESSAGE_TYPES).toContain("tombstone");
  });
});

describe("t-b643ac — decision 3: what a dirty draft does when the entity vanishes", () => {
  it("severs the draft from the identity and latches, so an in-flight patch cannot resurrect it", () => {
    const policy = new TaskDocumentEditPolicy<{ role: string }>("edit");
    policy.receivePatch({ role: "edited" });
    policy.receiveDirty(true);

    expect(policy.entityVanished()).toBe(true);
    expect(policy.isVanished).toBe(true);
    expect(policy.draft).toEqual({ dirty: false });

    // The messages already queued behind the tombstone.
    policy.receivePatch({ role: "later" });
    policy.receiveDirty(true);
    expect(policy.draft).toEqual({ dirty: false });
    // The RED assertion: pre-fix `close()` handed the draft back and the manager re-cached it.
    expect(policy.close()).toBeUndefined();
  });

  it("says there was nothing to discard when the human had not edited", () => {
    const policy = new TaskDocumentEditPolicy<{ role: string }>("edit");
    expect(policy.entityVanished()).toBe(false);
  });

  it("leaves the ordinary close-with-pending-edit retention untouched", () => {
    const policy = new TaskDocumentEditPolicy<{ role: string }>("edit");
    policy.receivePatch({ role: "edited" });
    policy.receiveDirty(true);
    expect(policy.close()).toEqual({ dirty: true, patch: { role: "edited" } });
  });
});
