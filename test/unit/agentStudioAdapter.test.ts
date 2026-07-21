import { describe, it, expect } from "vitest";
import { AgentStudioAdapter } from "../../src/webview/AgentStudioAdapter.js";
import { blankAgentFields, createAgentEvolutionLabels } from "../../src/webview/agent-studio-shell/domain.js";
import type { Workspace } from "../../src/workspace/Workspace.js";
import type { StudioSubmit } from "../../src/webview/studioSubmit.js";

/** spec 350 Phase 3 T1 — AgentStudioAdapter in isolation: no vscode, no panel, no protocol — just the
 *  StudioHostAdapter<AgentStudioEntity,AgentStudioFields,AgentStudioPatch> contract WRAPPING formLogic.ts
 *  (via agent-studio-shell/domain.ts) + Workspace.studioSubmit (build-via-formLogic + YamlConfigEditor.
 *  upsertAgent). formLogic.ts itself is untouched — this test proves the wrapping, not a reimplementation. */

interface FakeAgents {
  [name: string]: { cmd: string; kind: "agent" | "terminal"; watch: string[]; autostart: boolean; attention: { enabled: boolean } };
}

function fakeWorkspace(opts: { agents?: FakeAgents; detected?: string[]; submitResult?: string[] | undefined } = {}): {
  ws: Workspace;
  submits: StudioSubmit[];
} {
  const agents: FakeAgents = opts.agents ?? {};
  const submits: StudioSubmit[] = [];
  const ws = {
    config: { agents },
    studioDeps: () => ({
      detectClis: async () => opts.detected ?? [],
      takenNames: () => Object.keys(agents),
      commandNames: () => [],
      verifyCandidates: () => ["npm test"],
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

describe("AgentStudioAdapter — load", () => {
  it("returns a blank new-mode entity with reference data (chips/flagMap/defaultCwd/verifyCandidates)", async () => {
    const { ws } = fakeWorkspace({ agents: { existing: { cmd: "claude", kind: "agent", watch: [], autostart: false, attention: { enabled: true } } }, detected: ["claude"] });
    const adapter = new AgentStudioAdapter(ws);
    const result = await adapter.load(undefined);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.entity.name).toBeUndefined();
    expect(result.entity.fields).toEqual(blankAgentFields());
    expect(result.entity.defaultCwd).toBe("/ws/root");
    expect(result.entity.verifyCandidates).toEqual(["npm test"]);
    expect(result.entity.persistentInstructionsHelp).toBe("When supported, delivered at startup through the selected runtime.");
    expect(result.entity.chips.find((c) => c.bin === "claude")?.detected).toBe(true);
    expect(result.entity.evolutionLabels.title).toBe("Agent Evolution");
  });

  it("projects host-localized Evolution labels into the browser entity", async () => {
    const { ws } = fakeWorkspace();
    const labels = createAgentEvolutionLabels((message) => `localized:${message}`);
    const result = await new AgentStudioAdapter(ws, labels).load(undefined);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.entity.evolutionLabels.title).toBe("localized:Agent Evolution");
    expect(result.entity.evolutionLabels.approve).toBe("localized:Approve");
  });

  it("projects host-localized runtime-neutral Persistent Instructions help", async () => {
    const { ws } = fakeWorkspace();
    const result = await new AgentStudioAdapter(
      ws,
      createAgentEvolutionLabels(),
      "localized:runtime-neutral startup delivery",
    ).load(undefined);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.entity.persistentInstructionsHelp).toBe("localized:runtime-neutral startup delivery");
  });

  it("resolves an existing agent-kind entry via formLogic's fromDef", async () => {
    const { ws } = fakeWorkspace({ agents: { frontend: { cmd: "claude --model sonnet", kind: "agent", watch: [], autostart: true, attention: { enabled: true } } } });
    const adapter = new AgentStudioAdapter(ws);
    const result = await adapter.load("frontend");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.entity.name).toBe("frontend");
    expect(result.entity.fields.cmd).toBe("claude --model sonnet");
    expect(result.entity.fields.autostart).toBe(true);
  });

  it("reports not-found for a terminal-kind entry (coexistence: Terminal edits stay on the legacy form)", async () => {
    const { ws } = fakeWorkspace({ agents: { dev: { cmd: "npm run dev", kind: "terminal", watch: [], autostart: false, attention: { enabled: false } } } });
    const adapter = new AgentStudioAdapter(ws);
    const result = await adapter.load("dev");
    expect(result.status).toBe("not-found");
  });

  it("reports not-found for a name with no declared entry at all", async () => {
    const { ws } = fakeWorkspace();
    const adapter = new AgentStudioAdapter(ws);
    const result = await adapter.load("ghost");
    expect(result.status).toBe("not-found");
  });
});

describe("AgentStudioAdapter — validate", () => {
  it("is a no-op (NO_VALIDATION_ERRORS) — save()'s studioSubmit call is the sole authoritative check", () => {
    const { ws } = fakeWorkspace();
    const adapter = new AgentStudioAdapter(ws);
    expect(adapter.validate({ ...blankAgentFields(), name: "1bad", cmd: "" })).toEqual({ blocking: [], nonBlocking: [] });
  });
});

describe("AgentStudioAdapter — save", () => {
  it("delegates to Workspace.studioSubmit (WRAPS toEntry/upsertAgent — no parallel write path)", async () => {
    const { ws, submits } = fakeWorkspace({ submitResult: undefined });
    const adapter = new AgentStudioAdapter(ws);
    const patch = { ...blankAgentFields(), name: "frontend", cmd: "claude" };
    const result = adapter.save(undefined, patch);
    expect(result).not.toBeInstanceOf(Promise);
    expect(await result).toEqual({ status: "ok" });
    expect(submits).toEqual([{ state: patch, editingName: undefined }]);
  });

  it("passes entityId through as editingName so an edit-mode save targets the right entry", () => {
    const { ws, submits } = fakeWorkspace({ submitResult: undefined });
    const adapter = new AgentStudioAdapter(ws);
    const patch = { ...blankAgentFields(), name: "frontend", cmd: "claude --model opus" };
    adapter.save("frontend", patch);
    expect(submits[0]?.editingName).toBe("frontend");
  });

  it("surfaces a studioSubmit failure as a blocking validation-source error, not a silent no-op", async () => {
    const { ws } = fakeWorkspace({ submitResult: ["name 'frontend' already exists"] });
    const adapter = new AgentStudioAdapter(ws);
    const result = await adapter.save(undefined, { ...blankAgentFields(), name: "frontend", cmd: "claude" });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error.source).toBe("validation");
    expect(result.error.message).toContain("already exists");
  });
});
