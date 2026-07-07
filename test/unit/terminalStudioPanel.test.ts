import { describe, it, expect, beforeEach } from "vitest";
import { Uri } from "vscode";
import { __createdPanels, __resetVscodeMock, __setOpenDialogResult } from "../mocks/vscode.js";
import { TerminalStudioPanelManager } from "../../src/webview/TerminalStudioPanel.js";
import { envelope } from "../../src/webview/shared/studio/protocol.js";
import { blankTerminalFields } from "../../src/webview/terminal-studio-shell/domain.js";
import type { Workspace } from "../../src/workspace/Workspace.js";
import type { StudioSubmit } from "../../src/webview/AgentForm.js";
import type { AgentDef } from "../../src/config/loadConfig.js";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function findType(posted: unknown[], type: string) {
  return posted.filter((m) => (m as { type?: string }).type === type);
}

function terminalDef(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    cmd: "npm run dev",
    kind: "terminal",
    watch: [],
    autostart: false,
    restart: "never",
    attention: { enabled: false },
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
      verifyCandidates: () => ["npm test"],
      defaultCwd: "/ws/root",
      inferKind: () => "terminal",
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

beforeEach(() => __resetVscodeMock());

describe("TerminalStudioPanelManager", () => {
  it("loads a blank new terminal entity and uses the terminal icon", async () => {
    const { ws } = fakeWorkspace();
    const manager = new TerminalStudioPanelManager(Uri.file("/ext"));
    manager.openNew(ws);
    await flush();
    expect(__createdPanels).toHaveLength(1);
    expect(__createdPanels[0].iconPath).toEqual({
      light: Uri.file("/ext/media/icons/light/terminal.svg"),
      dark: Uri.file("/ext/media/icons/dark/terminal.svg"),
    });
    expect(findType(__createdPanels[0].webview.posted, "load").at(-1)).toMatchObject({
      entity: { fields: blankTerminalFields() },
      referenceData: { defaultCwd: "/ws/root", verifyCandidates: ["npm test"] },
      concurrency: { kind: "none" },
    });
  });

  it("edit mode loads an existing terminal-kind entry", async () => {
    const { ws } = fakeWorkspace({ agents: { dev: terminalDef({ cmd: "npm run dev -- --host", watch: ["src/**"] }) } });
    const manager = new TerminalStudioPanelManager(Uri.file("/ext"));
    manager.openExisting(ws, "dev");
    await flush();
    expect(findType(__createdPanels[0].webview.posted, "load").at(-1)).toMatchObject({
      entity: { name: "dev", fields: { kind: "terminal", cmd: "npm run dev -- --host", watch: "src/**" } },
    });
  });

  it("saves through studioSubmit, fans out onChanged, and disposes", async () => {
    let changed = 0;
    const { ws, submits } = fakeWorkspace();
    const manager = new TerminalStudioPanelManager(Uri.file("/ext"), () => { changed += 1; });
    manager.openNew(ws);
    await flush();
    const patch = { ...blankTerminalFields(), name: "dev", cmd: "npm run dev" };
    __createdPanels[0].webview.__receive(patchMsg(patch));
    __createdPanels[0].webview.__receive(dirtyMsg(true));
    __createdPanels[0].webview.__receive(saveMsg());
    await flush();
    expect(submits).toEqual([{ state: patch, editingName: undefined }]);
    expect(changed).toBe(1);
    expect(__createdPanels[0].disposed).toBe(true);
  });

  it("keeps the panel open on validation failure and cancel disposes without saving", async () => {
    const { ws } = fakeWorkspace({ submitResult: ["name: invalid"] });
    const manager = new TerminalStudioPanelManager(Uri.file("/ext"));
    manager.openNew(ws);
    await flush();
    const webview = __createdPanels[0].webview;
    webview.__receive(patchMsg({ ...blankTerminalFields(), name: "1bad" }));
    webview.__receive(saveMsg());
    await flush();
    expect(__createdPanels[0].disposed).toBe(false);
    expect(findType(webview.posted, "error").at(-1)).toMatchObject({ code: "validation/terminal-save-failed", source: "validation" });
    webview.__receive(cancelMsg());
    await flush();
    expect(__createdPanels[0].disposed).toBe(true);
  });

  it("round-trips the browse domain action", async () => {
    __setOpenDialogResult([Uri.file("/picked/dir")]);
    const { ws } = fakeWorkspace();
    const manager = new TerminalStudioPanelManager(Uri.file("/ext"));
    manager.openNew(ws);
    await flush();
    __createdPanels[0].webview.__receive(browseMsg());
    await flush();
    expect(findType(__createdPanels[0].webview.posted, "cwd").at(-1)).toMatchObject({ value: "/picked/dir" });
  });
});
