import { describe, it, expect, beforeEach } from "vitest";
import { Uri } from "vscode";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { ScheduleStudioPanelManager } from "../../src/webview/ScheduleStudioPanel.js";
import { envelope } from "../../src/webview/shared/studio/protocol.js";
import { blankScheduleFields } from "../../src/webview/schedule-studio-shell/domain.js";
import type { Workspace } from "../../src/workspace/Workspace.js";
import type { StudioSubmit } from "../../src/webview/studioSubmit.js";
import type { AgentDef, CommandDef, RunbookDef, ScheduleDef } from "../../src/config/loadConfig.js";

const agentDef = (cmd: string): AgentDef => ({ cmd, kind: "agent", watch: [], autostart: false, attention: { enabled: true, silenceSec: 8, patterns: [] }, restart: "never" });

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function findType(posted: unknown[], type: string) {
  return posted.filter((m) => (m as { type?: string }).type === type);
}

function fakeWorkspace(opts: {
  schedules?: Record<string, ScheduleDef>;
  commands?: Record<string, CommandDef>;
  runbooks?: Record<string, RunbookDef>;
  agents?: Record<string, AgentDef>;
  submitResult?: string[] | undefined;
  activateOnSubmit?: boolean;
} = {}) {
  const schedules = opts.schedules ?? {};
  const commands = opts.commands ?? {};
  const runbooks = opts.runbooks ?? {};
  const agents = opts.agents ?? {};
  const submits: StudioSubmit[] = [];
  let schedulerActivations = 0;
  const ws = {
    wsHash: "ws1",
    workspaceRoot: "/ws/root",
    config: { schedules, commands, runbooks, agents },
    studioDeps: () => ({
      detectClis: async () => [],
      takenNames: () => Object.keys(agents),
      commandNames: () => Object.keys(commands),
      verifyCandidates: () => [],
      defaultCwd: "/ws/root",
      inferKind: () => "schedule",
      onSubmit: () => undefined,
    }),
    studioSubmit: (submit: StudioSubmit) => {
      submits.push(submit);
      if (opts.activateOnSubmit) schedulerActivations += 1;
      return opts.submitResult;
    },
  } as unknown as Workspace;
  return { ws, submits, commands, runbooks, agents, schedulerActivations: () => schedulerActivations };
}

const patchMsg = (patch: unknown) => envelope({ type: "patch" as const, patch });
const dirtyMsg = (dirty: boolean) => envelope({ type: "dirty" as const, dirty });
const saveMsg = () => envelope({ type: "save" as const });
const cancelMsg = () => envelope({ type: "cancel" as const });

beforeEach(() => __resetVscodeMock());

describe("ScheduleStudioPanelManager", () => {
  it("loads a blank new schedule entity and target referenceData", async () => {
    const { ws } = fakeWorkspace({
      commands: { lint: { cmd: "npm run lint" } },
      runbooks: { ship: { steps: ["lint"] } },
      agents: { claude: agentDef("claude") },
    });
    const manager = new ScheduleStudioPanelManager(Uri.file("/ext"));
    manager.openNew(ws);
    await flush();
    expect(__createdPanels).toHaveLength(1);
    expect(__createdPanels[0].iconPath).toEqual({
      light: Uri.file("/ext/media/icons/light/pulse.svg"),
      dark: Uri.file("/ext/media/icons/dark/pulse.svg"),
    });
    expect(findType(__createdPanels[0].webview.posted, "load").at(-1)).toMatchObject({
      entity: { fields: blankScheduleFields() },
      referenceData: { commandNames: ["lint"], runbookNames: ["ship"], agentNames: ["claude"] },
      concurrency: { kind: "none" },
    });
  });

  it("edit mode loads an existing schedule entry", async () => {
    const { ws } = fakeWorkspace({ schedules: { standup: { at: "09:00", spawn: "claude", instructions: "summarize", catchUp: true } } });
    const manager = new ScheduleStudioPanelManager(Uri.file("/ext"));
    manager.openExisting(ws, "standup");
    await flush();
    expect(findType(__createdPanels[0].webview.posted, "load").at(-1)).toMatchObject({
      entity: { name: "standup", fields: { kind: "schedule", schedTiming: "at", schedAt: "09:00", schedAction: "spawn", schedTarget: "claude", catchUp: true } },
    });
  });

  it("saves through studioSubmit, activates the scheduler, fans out onChanged, and disposes", async () => {
    let changed = 0;
    const { ws, submits, schedulerActivations } = fakeWorkspace({ activateOnSubmit: true });
    const manager = new ScheduleStudioPanelManager(Uri.file("/ext"), () => { changed += 1; });
    manager.openNew(ws);
    await flush();
    const patch = { ...blankScheduleFields(), name: "hourly", schedTarget: "lint" };
    __createdPanels[0].webview.__receive(patchMsg(patch));
    __createdPanels[0].webview.__receive(dirtyMsg(true));
    __createdPanels[0].webview.__receive(saveMsg());
    await flush();
    expect(submits).toEqual([{ state: patch, editingName: undefined }]);
    expect(schedulerActivations()).toBe(1);
    expect(changed).toBe(1);
    expect(__createdPanels[0].disposed).toBe(true);
  });

  it("keeps the panel open on validation failure and cancel disposes without saving", async () => {
    const { ws } = fakeWorkspace({ submitResult: ["target: required"] });
    const manager = new ScheduleStudioPanelManager(Uri.file("/ext"));
    manager.openNew(ws);
    await flush();
    const webview = __createdPanels[0].webview;
    webview.__receive(patchMsg({ ...blankScheduleFields(), name: "hourly" }));
    webview.__receive(saveMsg());
    await flush();
    expect(__createdPanels[0].disposed).toBe(false);
    expect(findType(webview.posted, "error").at(-1)).toMatchObject({ code: "validation/schedule-save-failed", source: "validation" });
    webview.__receive(cancelMsg());
    await flush();
    expect(__createdPanels[0].disposed).toBe(true);
  });

  it("pushes refreshed target catalogs without reloading schedule fields", async () => {
    const { ws, commands, runbooks, agents } = fakeWorkspace({ commands: { lint: { cmd: "npm run lint" } } });
    const manager = new ScheduleStudioPanelManager(Uri.file("/ext"));
    manager.openNew(ws);
    await flush();
    commands.test = { cmd: "npm test" };
    runbooks.ship = { steps: ["test"] };
    agents.claude = agentDef("claude");
    manager.refreshReferenceData();
    await flush();
    expect(findType(__createdPanels[0].webview.posted, "load")).toHaveLength(1);
    expect(findType(__createdPanels[0].webview.posted, "referenceData").at(-1)).toMatchObject({
      referenceData: { commandNames: ["lint", "test"], runbookNames: ["ship"], agentNames: ["claude"] },
    });
  });
});
