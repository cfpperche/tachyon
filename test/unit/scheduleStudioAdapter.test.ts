import { describe, it, expect } from "vitest";
import { ScheduleStudioAdapter } from "../../src/webview/ScheduleStudioAdapter.js";
import { blankScheduleFields } from "../../src/webview/schedule-studio-shell/domain.js";
import type { Workspace } from "../../src/workspace/Workspace.js";
import type { StudioSubmit } from "../../src/webview/studioSubmit.js";
import type { AgentDef, CommandDef, RunbookDef, ScheduleDef } from "../../src/config/loadConfig.js";

const agentDef = (cmd: string): AgentDef => ({ cmd, kind: "agent", watch: [], autostart: false, attention: { enabled: true, silenceSec: 8, patterns: [] }, restart: "never" });

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
    config: { schedules, commands, runbooks, agents },
    studioDeps: () => ({
      detectClis: async () => [],
      takenNames: () => Object.keys(agents),
      commandNames: () => Object.keys(commands),
      verifyCandidates: () => [],
      defaultCwd: "/ws/root",
      suggestKindForCommand: () => "schedule",
      onSubmit: () => undefined,
    }),
    studioSubmit: (submit: StudioSubmit) => {
      submits.push(submit);
      if (opts.activateOnSubmit) schedulerActivations += 1;
      return opts.submitResult;
    },
  } as unknown as Workspace;
  return { ws, submits, schedulerActivations: () => schedulerActivations };
}

describe("ScheduleStudioAdapter", () => {
  it("loads a blank schedule entity with target catalogs in referenceData only", () => {
    const { ws } = fakeWorkspace({
      commands: { lint: { cmd: "npm run lint" } },
      runbooks: { ship: { steps: ["lint"] } },
      agents: { claude: agentDef("claude") },
    });
    const result = new ScheduleStudioAdapter(ws).load(undefined);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.entity).toEqual({ fields: blankScheduleFields() });
    expect(result.referenceData).toEqual({ commandNames: ["lint"], runbookNames: ["ship"], agentNames: ["claude"] });
    expect(result.entity).not.toHaveProperty("commandNames");
  });

  it("resolves only existing schedule entries through formLogic's fromScheduleDef", () => {
    const { ws } = fakeWorkspace({
      schedules: { hourly: { every: "1h", run: "lint" } },
    });
    const adapter = new ScheduleStudioAdapter(ws);
    const loaded = adapter.load("hourly");
    expect(loaded.status).toBe("ok");
    if (loaded.status !== "ok") throw new Error("unreachable");
    expect(loaded.entity).toMatchObject({ name: "hourly", fields: { kind: "schedule", schedTiming: "every", schedEvery: "1h", schedAction: "run", schedTarget: "lint" } });
    expect(adapter.load("ghost").status).toBe("not-found");
  });

  it("delegates save to Workspace.studioSubmit with the edit name", async () => {
    const { ws, submits } = fakeWorkspace();
    const patch = { ...blankScheduleFields(), name: "hourly", schedTarget: "lint" };
    const result = await new ScheduleStudioAdapter(ws).save("hourly", patch);
    expect(result).toEqual({ status: "ok" });
    expect(submits).toEqual([{ state: patch, editingName: "hourly" }]);
  });

  it("preserves scheduler activation by saving through Workspace.studioSubmit", async () => {
    const { ws, schedulerActivations } = fakeWorkspace({ activateOnSubmit: true });
    const patch = { ...blankScheduleFields(), name: "hourly", schedTarget: "lint" };
    expect(await new ScheduleStudioAdapter(ws).save(undefined, patch)).toEqual({ status: "ok", entityId: "hourly" });
    expect(schedulerActivations()).toBe(1);
  });

  it("surfaces studioSubmit validation failures", async () => {
    const { ws } = fakeWorkspace({ submitResult: ["target: required"] });
    const result = await new ScheduleStudioAdapter(ws).save(undefined, { ...blankScheduleFields(), name: "hourly" });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error).toMatchObject({ code: "validation/schedule-save-failed", source: "validation" });
  });
});
