import { describe, it, expect } from "vitest";
import { AgentStudioAdapter } from "../../src/webview/AgentStudioAdapter.js";
import { blankAgentFields, canonicalAgentFields, createAgentEvolutionLabels, createAgentProfileLabels, serializeAgentPatch } from "../../src/webview/agent-studio-shell/domain.js";
import type { AgentProfileStudioMutationV1, AgentProfileStudioSnapshotV1 } from "../../src/config/agentProfileStudio.js";
import type { WorkspaceAgentStudioTarget } from "../../src/shell/WorkspacePresentation.js";
import type { StudioSubmit } from "../../src/webview/studioSubmit.js";

/** spec 350 Phase 3 T1 — AgentStudioAdapter in isolation: no vscode, no panel, no protocol — just the
 *  StudioHostAdapter<AgentStudioEntity,AgentStudioFields,AgentStudioPatch> contract WRAPPING formLogic.ts
 *  (via agent-studio-shell/domain.ts) + Workspace.studioSubmit (build-via-formLogic + YamlConfigEditor.
 *  upsertAgent). formLogic.ts itself is untouched — this test proves the wrapping, not a reimplementation. */

interface FakeAgents {
  [name: string]: { cmd: string; kind: "agent" | "terminal"; watch: string[]; autostart: boolean; attention: { enabled: boolean }; profileLifecycle?: { agentId: string; enabled: boolean }; profilePointer?: true };
}

function profileSnapshot(agentName = "frontend"): AgentProfileStudioSnapshotV1 {
  return {
    schemaVersion: 1,
    kind: "canonical",
    agentName,
    agentId: "123e4567-e89b-42d3-a456-426614174000",
    revision: "a".repeat(64),
    enabled: false,
    editable: { displayName: "Frontend", runtime: { adapter: "codex", executable: "codex", model: "gpt-example" }, role: "reviewer" },
    bindings: {
      environmentValueNames: ["PUBLIC_VALUE"],
      secretNames: ["API_TOKEN"],
      prompt: { soul: true, instructions: false, evolution: true },
      capabilities: { skills: 1, mcp: 0, hooks: 0, pi: 0 },
      externalReferences: 1,
    },
    provenance: {
      canonical: { scope: "profile", writable: true, sha256: "b".repeat(64) },
      authority: { scope: "host", writable: false, revision: "lifecycle-one", grants: 0 },
      learned: { scope: "profile", writable: false, present: true },
      projection: { scope: "runtime", writable: false, active: false },
    },
  };
}

function fakeWorkspace(opts: {
  agents?: FakeAgents;
  detected?: string[];
  submitResult?: string[] | undefined;
  inspectResult?: AgentProfileStudioSnapshotV1;
  commit?: (mutation: AgentProfileStudioMutationV1) => Promise<AgentProfileStudioSnapshotV1>;
} = {}): {
  ws: WorkspaceAgentStudioTarget;
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
    inspectAgentProfileStudio: async () => opts.inspectResult ?? profileSnapshot(),
    commitAgentProfileStudio: opts.commit ?? (async (mutation: AgentProfileStudioMutationV1) => profileSnapshot(mutation.agentName)),
  } as unknown as WorkspaceAgentStudioTarget;
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
    expect(result.entity.storage).toBe("canonical");
    expect(result.entity.fields).toEqual(canonicalAgentFields());
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

  it("projects host-localized canonical profile labels", async () => {
    const { ws } = fakeWorkspace();
    const result = await new AgentStudioAdapter(
      ws,
      createAgentEvolutionLabels(),
      "help",
      createAgentProfileLabels((message) => `localized:${message}`),
    ).load(undefined);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.entity.profileLabels?.provenanceTitle).toBe("localized:Profile sources and authority");
    expect(result.entity.profileLabels?.retryRefresh).toBe("localized:Refresh and retry");
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
    expect(result.entity.storage).toBe("legacy");
  });

  it("loads a canonical profile through the redacted revisioned target instead of fromDef", async () => {
    const snapshot = profileSnapshot();
    const { ws } = fakeWorkspace({
      agents: { frontend: { cmd: "resolved-command-must-not-win", kind: "agent", watch: [], autostart: true, attention: { enabled: true }, profileLifecycle: { agentId: snapshot.agentId, enabled: false } } },
      inspectResult: snapshot,
    });
    const result = await new AgentStudioAdapter(ws).load("frontend");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.entity.storage).toBe("canonical");
    expect(result.entity.fields.cmd).toBe("codex");
    expect(result.entity.fields.role).toBe("reviewer");
    expect(result.entity.profile?.bindings.secretNames).toEqual(["API_TOKEN"]);
    expect(JSON.stringify(result.entity)).not.toContain("secret-handle");
    expect(new AgentStudioAdapter(ws).revisionOf(result.entity)).toBe(snapshot.revision);
  });

  it("loads a shell-discovered canonical pointer through the engine snapshot", async () => {
    const snapshot = profileSnapshot();
    const { ws } = fakeWorkspace({
      agents: { frontend: { cmd: "codex", kind: "agent", watch: [], autostart: false, attention: { enabled: true }, profilePointer: true } },
      inspectResult: snapshot,
    });
    const result = await new AgentStudioAdapter(ws).load("frontend");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.entity.storage).toBe("canonical");
    expect(result.entity.profile?.revision).toBe(snapshot.revision);
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
  it("sends canonical create/edit through the CAS target and never through studioSubmit", async () => {
    const mutations: AgentProfileStudioMutationV1[] = [];
    const { ws, submits } = fakeWorkspace({ commit: async (mutation) => { mutations.push(mutation); return profileSnapshot(mutation.agentName); } });
    const adapter = new AgentStudioAdapter(ws);
    const fields = canonicalAgentFields(profileSnapshot());
    fields.role = "tester";
    const patch = serializeAgentPatch(fields, true)!;

    expect(await adapter.save("frontend", patch)).toEqual({ status: "ok" });
    expect(mutations).toEqual([expect.objectContaining({ kind: "canonical", agentName: "frontend", expectedRevision: "a".repeat(64) })]);
    expect(mutations[0]?.editable).toEqual(expect.objectContaining({ role: "tester", runtime: expect.objectContaining({ executable: "codex" }) }));
    expect(submits).toEqual([]);
  });

  it("keeps unsupported Quick Add runtimes on the legacy creation path", async () => {
    const { ws, submits } = fakeWorkspace({ submitResult: undefined });
    const fields = canonicalAgentFields();
    fields.name = "claude-helper";
    fields.cmd = "claude";
    fields.kind = "agent";

    const patch = serializeAgentPatch(fields, true)!;
    expect(patch).not.toHaveProperty("canonical");
    expect(patch).not.toHaveProperty("editable");
    expect(await new AgentStudioAdapter(ws).save(undefined, patch)).toEqual({ status: "ok", entityId: "claude-helper" });
    expect(submits).toEqual([{ state: expect.objectContaining({ name: "claude-helper", cmd: "claude" }), editingName: undefined }]);
  });

  it("maps a stale canonical save to a redacted Studio conflict", async () => {
    const { ws } = fakeWorkspace({ commit: async () => { throw new Error("agent 'frontend' profile revision conflict"); } });
    const fields = canonicalAgentFields(profileSnapshot());
    fields.role = "tester";
    const result = await new AgentStudioAdapter(ws).save("frontend", serializeAgentPatch(fields, true)!);
    expect(result).toEqual({ status: "conflict", error: { code: "agent-profile/revision-conflict", message: "This profile changed. Reload before saving again." } });
    expect(JSON.stringify(result)).not.toContain("tester");
  });

  it("delegates to Workspace.studioSubmit (WRAPS toEntry/upsertAgent — no parallel write path)", async () => {
    const { ws, submits } = fakeWorkspace({ submitResult: undefined });
    const adapter = new AgentStudioAdapter(ws);
    const patch = { ...blankAgentFields(), name: "frontend", cmd: "claude" };
    const result = adapter.save(undefined, patch);
    expect(result).not.toBeInstanceOf(Promise);
    expect(await result).toEqual({ status: "ok", entityId: "frontend" });
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
