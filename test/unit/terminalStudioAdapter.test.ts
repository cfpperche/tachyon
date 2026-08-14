import { describe, it, expect } from "vitest";
import { TerminalStudioAdapter } from "../../src/webview/TerminalStudioAdapter.js";
import { blankTerminalFields } from "../../packages/webview-ui/src/webview/terminal-studio-shell/domain.js";
import type { Workspace } from "@tachyon/engine/workspace/Workspace.js";
import type { StudioSubmit } from "../../src/webview/studioSubmit.js";
import type { AgentDef } from "@tachyon/engine/config/loadConfig.js";

function terminalDef(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    cmd: "npm run dev",
    kind: "terminal",
    watch: ["src/**"],
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
    config: { agents },
    studioDeps: () => ({
      detectClis: async () => [],
      takenNames: () => Object.keys(agents),
      commandNames: () => [],
      defaultCwd: "/ws/root",
      suggestKindForCommand: () => "terminal",
      onSubmit: () => undefined,
    }),
    studioSubmit: (submit: StudioSubmit) => {
      submits.push(submit);
      return opts.submitResult;
    },
  } as unknown as Workspace;
  return { ws, submits };
}

describe("TerminalStudioAdapter", () => {
  it("loads a blank terminal entity with referenceData outside the entity payload", () => {
    const { ws } = fakeWorkspace();
    const result = new TerminalStudioAdapter(ws).load(undefined);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.entity).toEqual({ fields: blankTerminalFields() });
    expect(result.referenceData).toMatchObject({ defaultCwd: "/ws/root" });
    expect(result.entity).not.toHaveProperty("defaultCwd");
  });

  it("resolves only existing terminal-kind entries through formLogic's fromDef", () => {
    const { ws } = fakeWorkspace({
      agents: {
        dev: terminalDef({ cmd: "npm run dev -- --host", autostart: true, restart: "on-crash" }),
        frontend: { ...terminalDef(), kind: "agent", attention: { enabled: true } } as AgentDef,
      },
    });
    const adapter = new TerminalStudioAdapter(ws);
    const loaded = adapter.load("dev");
    expect(loaded.status).toBe("ok");
    if (loaded.status !== "ok") throw new Error("unreachable");
    expect(loaded.entity).toMatchObject({ name: "dev", fields: { kind: "terminal", cmd: "npm run dev -- --host", watch: "src/**", autostart: true, restartOnCrash: true } });
    expect(adapter.load("frontend").status).toBe("not-found");
  });

  it("delegates save to Workspace.studioSubmit with the edit name", async () => {
    const { ws, submits } = fakeWorkspace();
    const patch = { ...blankTerminalFields(), name: "dev", cmd: "npm run dev" };
    const result = await new TerminalStudioAdapter(ws).save("dev", patch);
    expect(result).toEqual({ status: "ok" });
    expect(submits).toEqual([{ state: patch, editingName: "dev" }]);
  });

  it("surfaces studioSubmit validation failures", async () => {
    const { ws } = fakeWorkspace({ submitResult: ["command: required"] });
    const result = await new TerminalStudioAdapter(ws).save(undefined, { ...blankTerminalFields(), name: "dev" });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error).toMatchObject({ code: "validation/terminal-save-failed", source: "validation" });
  });
});
