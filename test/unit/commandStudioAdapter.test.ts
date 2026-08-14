import { describe, it, expect } from "vitest";
import { CommandStudioAdapter } from "../../src/webview/CommandStudioAdapter.js";
import { blankCommandFields } from "../../packages/webview-ui/src/webview/command-studio-shell/domain.js";
import type { Workspace } from "@tachyon/engine/workspace/Workspace.js";
import type { StudioSubmit } from "../../src/webview/studioSubmit.js";
import type { AgentDef, CommandDef } from "@tachyon/engine/config/loadConfig.js";

function commandDef(overrides: Partial<CommandDef> = {}): CommandDef {
  return {
    cmd: "npm run dev",
    ...overrides,
  };
}

function fakeWorkspace(opts: { commands?: Record<string, CommandDef>; agents?: Record<string, AgentDef>; submitResult?: string[] | undefined } = {}) {
  const commands = opts.commands ?? {};
  const agents = opts.agents ?? {};
  const submits: StudioSubmit[] = [];
  const ws = {
    config: { agents, commands },
    studioDeps: () => ({
      detectClis: async () => [],
      takenNames: () => [...Object.keys(agents), ...Object.keys(commands)],
      commandNames: () => Object.keys(commands),
      defaultCwd: "/ws/root",
      suggestKindForCommand: () => "command",
      onSubmit: () => undefined,
    }),
    studioSubmit: (submit: StudioSubmit) => {
      submits.push(submit);
      return opts.submitResult;
    },
  } as unknown as Workspace;
  return { ws, submits };
}

describe("CommandStudioAdapter", () => {
  it("loads a blank command entity with referenceData outside the entity payload", () => {
    const { ws } = fakeWorkspace();
    const result = new CommandStudioAdapter(ws).load(undefined);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.entity).toEqual({ fields: blankCommandFields() });
    expect(result.referenceData).toMatchObject({ defaultCwd: "/ws/root" });
    expect(result.entity).not.toHaveProperty("defaultCwd");
  });

  it("resolves only existing command entries through formLogic's fromCommandDef", () => {
    const { ws } = fakeWorkspace({
      commands: {
        dev: commandDef({ cmd: "npm run dev -- --host", cwd: "apps/web" }),
      },
      agents: {
        frontend: { ...commandDef(), kind: "agent", attention: { enabled: true } } as AgentDef,
      },
    });
    const adapter = new CommandStudioAdapter(ws);
    const loaded = adapter.load("dev");
    expect(loaded.status).toBe("ok");
    if (loaded.status !== "ok") throw new Error("unreachable");
    expect(loaded.entity).toMatchObject({ name: "dev", fields: { kind: "command", cmd: "npm run dev -- --host", cwd: "apps/web" } });
    expect(adapter.load("frontend").status).toBe("not-found");
  });

  it("delegates save to Workspace.studioSubmit with the edit name", async () => {
    const { ws, submits } = fakeWorkspace();
    const patch = { ...blankCommandFields(), name: "dev", cmd: "npm run dev" };
    const result = await new CommandStudioAdapter(ws).save("dev", patch);
    expect(result).toEqual({ status: "ok" });
    expect(submits).toEqual([{ state: patch, editingName: "dev" }]);
  });

  it("surfaces studioSubmit validation failures", async () => {
    const { ws } = fakeWorkspace({ submitResult: ["command: required"] });
    const result = await new CommandStudioAdapter(ws).save(undefined, { ...blankCommandFields(), name: "dev" });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error).toMatchObject({ code: "validation/command-save-failed", source: "validation" });
  });
});
