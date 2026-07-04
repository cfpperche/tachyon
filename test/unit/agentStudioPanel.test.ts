import { describe, it, expect, beforeEach } from "vitest";
import { Uri } from "vscode";
import { __createdPanels, __resetVscodeMock, __setOpenDialogResult } from "../mocks/vscode.js";
import { AgentStudioPanelManager } from "../../src/webview/AgentStudioPanel.js";
import { envelope } from "../../src/webview/shared/studio/protocol.js";
import { blankAgentFields } from "../../src/webview/agent-studio-shell/domain.js";
import type { Workspace } from "../../src/workspace/Workspace.js";
import type { StudioSubmit } from "../../src/webview/AgentForm.js";
import type { AgentDef } from "../../src/config/loadConfig.js";

/**
 * spec 350 Phase 3 T2 — AgentStudioPanelManager's full shell lifecycle against a REAL AgentStudioAdapter (not
 * a synthetic fake): load new/edit, patch, dirty, validation-blocked save, save success/failure, cancel,
 * reveal-on-reopen, refreshAll, panel restore, the one registered domain action (browse), and closed-on-
 * malformed-message — the same coverage shape as pipelineStudioPanel.test.ts (Fake 1's full-lifecycle proof).
 */

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => __resetVscodeMock());

function findType(posted: unknown[], type: string) {
  return posted.filter((m) => (m as { type?: string }).type === type);
}

function agentDef(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    cmd: "claude",
    kind: "agent",
    watch: [],
    autostart: false,
    restart: "never",
    attention: { enabled: true },
    ...overrides,
  } as AgentDef;
}

function fakeWorkspace(opts: { agents?: Record<string, AgentDef>; submitResult?: string[] | undefined } = {}) {
  const agents = opts.agents ?? {};
  const submits: StudioSubmit[] = [];
  const ws = {
    wsHash: "ws1",
    workspaceRoot: "/ws/root",
    config: { agents },
    studioDeps: () => ({
      detectClis: async () => [],
      takenNames: () => Object.keys(agents),
      commandNames: () => [],
      verifyCandidates: () => [],
      defaultCwd: "/ws/root",
      inferKind: () => "agent",
      onSubmit: () => undefined,
    }),
    studioSubmit: (submit: StudioSubmit) => {
      submits.push(submit);
      return opts.submitResult;
    },
  } as unknown as Workspace;
  return { ws, submits };
}

const patchMsg = (patch: unknown) => envelope({ type: "patch" as const, patch });
const dirtyMsg = (dirty: boolean) => envelope({ type: "dirty" as const, dirty });
const saveMsg = () => envelope({ type: "save" as const });
const cancelMsg = () => envelope({ type: "cancel" as const });
const browseMsg = () => envelope({ type: "browse" as const });

describe("AgentStudioPanelManager — Phase 3 pilot full lifecycle", () => {
  it("loads a blank new-mode entity and reveals instead of duplicating on reopen", async () => {
    const { ws } = fakeWorkspace();
    const manager = new AgentStudioPanelManager(Uri.file("/ext"));
    manager.openNew(ws);
    manager.openNew(ws);
    await flush();
    expect(__createdPanels).toHaveLength(1);
    expect(__createdPanels[0].revealCount).toBe(1);
    const load = findType(__createdPanels[0].webview.posted, "load").at(-1);
    expect(load).toMatchObject({ entity: { fields: blankAgentFields() }, concurrency: { kind: "none" } });
  });

  it("edit mode loads the persisted agent-kind entry via formLogic's fromDef", async () => {
    const { ws } = fakeWorkspace({ agents: { frontend: agentDef({ cmd: "claude --model sonnet", autostart: true }) } });
    const manager = new AgentStudioPanelManager(Uri.file("/ext"));
    manager.openExisting(ws, "frontend");
    await flush();
    const load = findType(__createdPanels[0].webview.posted, "load").at(-1);
    expect(load).toMatchObject({ entity: { name: "frontend", fields: { cmd: "claude --model sonnet", autostart: true } } });
  });

  it("blocks save (via the studioSubmit error path) until the form is valid, without disposing the panel", async () => {
    const { ws, submits } = fakeWorkspace({ submitResult: ["command: required"] });
    const manager = new AgentStudioPanelManager(Uri.file("/ext"));
    manager.openNew(ws);
    await flush();
    const webview = __createdPanels[0].webview;
    webview.__receive(patchMsg({ ...blankAgentFields(), name: "frontend", cmd: "" }));
    webview.__receive(dirtyMsg(true));
    webview.__receive(saveMsg());
    await flush();

    expect(__createdPanels[0].disposed).toBe(false);
    expect(submits).toHaveLength(1);
    const err = findType(webview.posted, "error").at(-1);
    expect(err).toMatchObject({ code: "validation/agent-save-failed", blocking: true });
  });

  it("saves successfully once valid, then disposes the panel and fans out onChanged", async () => {
    let changed = 0;
    const { ws } = fakeWorkspace({ submitResult: undefined });
    const manager = new AgentStudioPanelManager(Uri.file("/ext"), () => { changed += 1; });
    manager.openNew(ws);
    await flush();
    const webview = __createdPanels[0].webview;
    const patch = { ...blankAgentFields(), name: "frontend", cmd: "claude" };
    webview.__receive(patchMsg(patch));
    webview.__receive(dirtyMsg(true));
    webview.__receive(saveMsg());
    await flush();

    expect(__createdPanels[0].disposed).toBe(true);
    expect(changed).toBe(1);
  });

  it("a second save on an existing panel passes the entity id through as editingName", async () => {
    const { ws, submits } = fakeWorkspace({ agents: { frontend: agentDef() }, submitResult: undefined });
    const manager = new AgentStudioPanelManager(Uri.file("/ext"));
    manager.openExisting(ws, "frontend");
    await flush();
    const webview = __createdPanels[0].webview;
    webview.__receive(patchMsg({ ...blankAgentFields(), name: "frontend", cmd: "claude --model opus" }));
    webview.__receive(dirtyMsg(true));
    webview.__receive(saveMsg());
    await flush();
    expect(submits[0]?.editingName).toBe("frontend");
    expect(__createdPanels[0].disposed).toBe(true);
  });

  it("cancel disposes without persisting", async () => {
    const { ws, submits } = fakeWorkspace();
    const manager = new AgentStudioPanelManager(Uri.file("/ext"));
    manager.openNew(ws);
    await flush();
    __createdPanels[0].webview.__receive(patchMsg({ ...blankAgentFields(), name: "abandoned" }));
    __createdPanels[0].webview.__receive(cancelMsg());
    await flush();
    expect(__createdPanels[0].disposed).toBe(true);
    expect(submits).toHaveLength(0);
  });

  it("refreshAll re-posts every open panel with the latest store state", async () => {
    const { ws } = fakeWorkspace({ agents: { frontend: agentDef() } });
    const manager = new AgentStudioPanelManager(Uri.file("/ext"));
    manager.openExisting(ws, "frontend");
    await flush();
    manager.refreshAll();
    await flush();
    const loads = findType(__createdPanels[0].webview.posted, "load");
    expect(loads.length).toBeGreaterThanOrEqual(2);
  });

  it("the registered domain action (browse) round-trips a native folder pick to a 'cwd' reply", async () => {
    __setOpenDialogResult([Uri.file("/picked/dir")]);
    const { ws } = fakeWorkspace();
    const manager = new AgentStudioPanelManager(Uri.file("/ext"));
    manager.openNew(ws);
    await flush();
    const webview = __createdPanels[0].webview;
    webview.__receive(browseMsg());
    await flush();
    const reply = findType(webview.posted, "cwd").at(-1);
    expect(reply).toMatchObject({ value: "/picked/dir" });
  });

  it("panel restore across a simulated reload: a dirty draft survives", async () => {
    const { ws } = fakeWorkspace();
    const manager = new AgentStudioPanelManager(Uri.file("/ext"));
    manager.openNew(ws);
    await flush();
    __createdPanels[0].webview.__receive(patchMsg({ ...blankAgentFields(), name: "draft" }));
    __createdPanels[0].webview.__receive(dirtyMsg(true));
    const snapshot = manager.captureSnapshot(ws)!;
    expect(snapshot).toMatchObject({ mode: "new", patch: { name: "draft" } });

    __resetVscodeMock();
    const restored = new AgentStudioPanelManager(Uri.file("/ext"));
    restored.restoreFromSnapshot(ws, snapshot);
    await flush();
    const restoreMsg = findType(__createdPanels[0].webview.posted, "restore").at(-1);
    expect(restoreMsg).toMatchObject({ snapshot: { patch: { name: "draft" } } });
  });

  it("fails closed on a malformed/unversioned message instead of silently dropping it", async () => {
    const { ws } = fakeWorkspace();
    const manager = new AgentStudioPanelManager(Uri.file("/ext"));
    manager.openNew(ws);
    await flush();
    __createdPanels[0].webview.__receive(envelope({ type: "totallyUnknownType" }));
    await flush();
    const err = findType(__createdPanels[0].webview.posted, "error").at(-1);
    expect(err).toMatchObject({ blocking: true });
  });
});
