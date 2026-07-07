import { describe, it, expect, beforeEach } from "vitest";
import { Uri } from "vscode";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { RunbookStudioPanelManager } from "../../src/webview/RunbookStudioPanel.js";
import { envelope } from "../../src/webview/shared/studio/protocol.js";
import { blankRunbookFields } from "../../src/webview/runbook-studio-shell/domain.js";
import type { Workspace } from "../../src/workspace/Workspace.js";
import type { StudioSubmit } from "../../src/webview/studioSubmit.js";

type RunbookDef = { steps: string[] };

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function findType(posted: unknown[], type: string) {
  return posted.filter((m) => (m as { type?: string }).type === type);
}

function fakeWorkspace(opts: { runbooks?: Record<string, RunbookDef>; commands?: Record<string, { cmd: string }>; submitResult?: string[] | undefined } = {}) {
  const runbooks = opts.runbooks ?? {};
  const commands = opts.commands ?? {};
  const submits: StudioSubmit[] = [];
  const ws = {
    wsHash: "ws1",
    workspaceRoot: "/ws/root",
    config: { runbooks, commands },
    studioDeps: () => ({
      detectClis: async () => [],
      takenNames: () => Object.keys(runbooks),
      commandNames: () => Object.keys(commands),
      verifyCandidates: () => [],
      defaultCwd: "/ws/root",
      inferKind: () => "runbook",
      onSubmit: () => undefined,
    }),
    studioSubmit: (submit: StudioSubmit) => {
      submits.push(submit);
      return opts.submitResult;
    },
  } as unknown as Workspace;
  return { ws, submits, commands };
}

const patchMsg = (patch: unknown) => envelope({ type: "patch" as const, patch });
const dirtyMsg = (dirty: boolean) => envelope({ type: "dirty" as const, dirty });
const saveMsg = () => envelope({ type: "save" as const });
const cancelMsg = () => envelope({ type: "cancel" as const });

beforeEach(() => __resetVscodeMock());

describe("RunbookStudioPanelManager", () => {
  it("loads a blank new runbook entity and uses the runbook icon", async () => {
    const { ws } = fakeWorkspace({ commands: { lint: { cmd: "npm run lint" } } });
    const manager = new RunbookStudioPanelManager(Uri.file("/ext"));
    manager.openNew(ws);
    await flush();
    expect(__createdPanels).toHaveLength(1);
    expect(__createdPanels[0].iconPath).toEqual({
      light: Uri.file("/ext/media/icons/light/book.svg"),
      dark: Uri.file("/ext/media/icons/dark/book.svg"),
    });
    expect(findType(__createdPanels[0].webview.posted, "load").at(-1)).toMatchObject({
      entity: { fields: blankRunbookFields() },
      referenceData: { commandNames: ["lint"] },
      concurrency: { kind: "none" },
    });
  });

  it("edit mode loads an existing runbook entry", async () => {
    const { ws } = fakeWorkspace({ runbooks: { ship: { steps: ["lint", "./deploy.sh"] } } });
    const manager = new RunbookStudioPanelManager(Uri.file("/ext"));
    manager.openExisting(ws, "ship");
    await flush();
    expect(findType(__createdPanels[0].webview.posted, "load").at(-1)).toMatchObject({
      entity: { name: "ship", fields: { kind: "runbook", steps: "lint\n./deploy.sh" } },
    });
  });

  it("saves through studioSubmit, fans out onChanged, and disposes", async () => {
    let changed = 0;
    const { ws, submits } = fakeWorkspace();
    const manager = new RunbookStudioPanelManager(Uri.file("/ext"), () => { changed += 1; });
    manager.openNew(ws);
    await flush();
    const patch = { ...blankRunbookFields(), name: "ship", steps: "lint\ntest" };
    __createdPanels[0].webview.__receive(patchMsg(patch));
    __createdPanels[0].webview.__receive(dirtyMsg(true));
    __createdPanels[0].webview.__receive(saveMsg());
    await flush();
    expect(submits).toEqual([{ state: patch, editingName: undefined }]);
    expect(changed).toBe(1);
    expect(__createdPanels[0].disposed).toBe(true);
  });

  it("keeps the panel open on validation failure and cancel disposes without saving", async () => {
    const { ws } = fakeWorkspace({ submitResult: ["steps: required"] });
    const manager = new RunbookStudioPanelManager(Uri.file("/ext"));
    manager.openNew(ws);
    await flush();
    const webview = __createdPanels[0].webview;
    webview.__receive(patchMsg({ ...blankRunbookFields(), name: "ship" }));
    webview.__receive(saveMsg());
    await flush();
    expect(__createdPanels[0].disposed).toBe(false);
    expect(findType(webview.posted, "error").at(-1)).toMatchObject({ code: "validation/runbook-save-failed", source: "validation" });
    webview.__receive(cancelMsg());
    await flush();
    expect(__createdPanels[0].disposed).toBe(true);
  });

  it("pushes refreshed commandNames without reloading the runbook fields", async () => {
    const { ws, commands } = fakeWorkspace({ commands: { lint: { cmd: "npm run lint" } } });
    const manager = new RunbookStudioPanelManager(Uri.file("/ext"));
    manager.openNew(ws);
    await flush();
    commands.test = { cmd: "npm test" };
    manager.refreshReferenceData();
    await flush();
    expect(findType(__createdPanels[0].webview.posted, "load")).toHaveLength(1);
    expect(findType(__createdPanels[0].webview.posted, "referenceData").at(-1)).toMatchObject({
      referenceData: { commandNames: ["lint", "test"] },
    });
  });
});
