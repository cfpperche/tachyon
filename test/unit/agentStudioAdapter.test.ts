import { describe, it, expect } from "vitest";
import { AgentStudioAdapter } from "../../src/webview/AgentStudioAdapter.js";
import {
  blankAgentFields,
  canonicalAgentFields,
  codexNativeConfigChoice,
  createAgentEvolutionLabels,
  createAgentProfileLabels,
  serializeAgentPatch,
  setCodexNativeConfigChoice,
  setNativeConfigChoice,
  nativeConfigAuthorized,
  nativeConfigSourceChoices,
  permissionAuthorizationChoices,
  setNativeConfigAuthorized,
} from "../../src/webview/agent-studio-shell/domain.js";
import { validateAgentNativeConfigPolicy } from "../../src/config/agentNativeConfigPolicy.js";
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
    readiness: { state: "limited", limitations: ["fork-unavailable"] },
    editable: {
      displayName: "Frontend", runtime: { adapter: "codex", executable: "codex", model: "gpt-example" }, role: "reviewer",
      cwd: "apps/web", lifecycle: { autostart: true, restart: "on-crash", attention: false, watch: ["src/**"] },
      worktree: { enabled: true, branch: "feature/web" }, isolation: "transcript",
    },
    bindings: {
      environmentValueNames: ["PUBLIC_VALUE"],
      secretNames: ["API_TOKEN"],
      prompt: { soul: true, instructions: false, evolution: true },
      capabilities: { skills: 1, mcp: 0, hooks: 0, pi: 0 },
      tooling: { skills: [], mcp: [], hooks: [] },
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
      suggestKindForCommand: () => "agent",
      onSubmit: () => undefined,
    }),
    studioSubmit: (submit: StudioSubmit) => {
      submits.push(submit);
      return opts.submitResult;
    },
    inspectAgentProfileStudio: async () => opts.inspectResult ?? profileSnapshot(),
    agentOwnershipView: async () => ({ subagents: [], candidates: [] }),
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
    expect(result.entity.fields.canonical?.nativeConfig).toEqual({
      permissions: {
        source: "global",
        treatment: "overlay",
        refresh: "every-launch",
        lifecycle: ["fresh", "restart", "resume"],
      },
      interface: {
        source: "global",
        treatment: "overlay",
        refresh: "every-launch",
        lifecycle: ["fresh", "restart", "resume"],
      },
      featureFlags: {
        source: "global",
        treatment: "overlay",
        refresh: "every-launch",
        lifecycle: ["fresh", "restart", "resume"],
      },
    });
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
    expect(result.entity.profileLabels?.newAgentSetupHelp).toBe("localized:Save this agent to create its canonical profile. Then choose pre-authorized MCP servers, skills, and hooks in Runtime tooling.");
    expect(result.entity.profileLabels?.nativeConfigGlobal).toBe("localized:Use global defaults");
    expect(result.entity.profileLabels?.canonicalTrustHelp).toContain("localized:Enabling or starting this canonical agent");
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
    expect(result.entity.fields).toMatchObject({
      cwd: "apps/web",
      autostart: true,
      restartOnCrash: true,
      attention: false,
      watch: "src/**",
      worktree: true,
      branch: "feature/web",
      isolate: true,
    });
    expect(result.entity.profile?.bindings.secretNames).toEqual(["API_TOKEN"]);
    expect(JSON.stringify(result.entity)).not.toContain("secret-handle");
    expect(new AgentStudioAdapter(ws).revisionOf(result.entity)).toBe(snapshot.revision);
  });

  it("carries canonical tooling selections while retaining transcript isolation in the mutation state", () => {
    const snapshot = profileSnapshot();
    snapshot.editable.capabilities = { skills: ["research"], mcp: [], hooks: [] };
    snapshot.bindings.tooling = { skills: [{ id: "research", scope: "project" }], mcp: [], hooks: [] };
    const fields = canonicalAgentFields(snapshot);
    const patch = serializeAgentPatch(fields, true);

    expect(fields.isolate).toBe(true);
    expect(patch).toMatchObject({
      kind: "canonical",
      editable: { isolation: "transcript", capabilities: { skills: ["research"], mcp: [], hooks: [] } },
    });
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
    expect(mutations[0]?.editable).toEqual(expect.objectContaining({
      role: "tester",
      runtime: expect.objectContaining({ executable: "codex" }),
      cwd: "apps/web",
      lifecycle: { autostart: true, restart: "on-crash", attention: false, watch: ["src/**"] },
      worktree: { enabled: true, branch: "feature/web" },
      isolation: "transcript",
    }));
    expect(submits).toEqual([]);
  });

  it("keeps unsupported Quick Add runtimes on the legacy creation path", async () => {
    const { ws, submits } = fakeWorkspace({ submitResult: undefined });
    const fields = canonicalAgentFields();
    fields.name = "opencode-helper";
    fields.cmd = "opencode";
    fields.kind = "agent";

    const patch = serializeAgentPatch(fields, true)!;
    expect(patch).not.toHaveProperty("canonical");
    expect(patch).not.toHaveProperty("editable");
    expect(await new AgentStudioAdapter(ws).save(undefined, patch)).toEqual({ status: "ok", entityId: "opencode-helper" });
    expect(submits).toEqual([{ state: expect.objectContaining({ name: "opencode-helper", cmd: "opencode" }), editingName: undefined }]);
  });

  it.each(["claude", "grok"])("creates measured %s runtimes through canonical mutation", (runtime) => {
    const fields = canonicalAgentFields();
    fields.name = `${runtime}-helper`;
    fields.cmd = runtime;
    const patch = serializeAgentPatch(fields, true)!;
    expect(patch).toMatchObject({
      kind: "canonical",
      agentName: `${runtime}-helper`,
      editable: { runtime: { adapter: runtime, executable: runtime } },
    });
    if (runtime === "claude") {
      expect((patch as AgentProfileStudioMutationV1).editable.nativeConfig).toMatchObject({
        permissions: { source: "global", lifecycle: ["fresh", "restart", "resume", "fork"] },
        interface: { source: "global", lifecycle: ["fresh", "restart", "resume", "fork"] },
        featureFlags: { source: "global", lifecycle: ["fresh", "restart", "resume", "fork"] },
      });
    } else {
      // t-26f508 — Grok now authors its own families: global-sourced scalars on its measured
      // fresh/restart/resume lifecycle, plus the refusals that keep the private home closed.
      expect((patch as AgentProfileStudioMutationV1).editable.nativeConfig).toMatchObject({
        permissions: { source: "global", lifecycle: ["fresh", "restart", "resume", "fork"] },
        interface: { source: "global", lifecycle: ["fresh", "restart", "resume", "fork"] },
        featureFlags: { source: "global", lifecycle: ["fresh", "restart", "resume", "fork"] },
        tooling: { source: "workspace", treatment: "exclude" },
        memory: { source: "agent", treatment: "exclude" },
        authentication: { source: "global", treatment: "external" },
      });
    }
  });

  it("authors Claude model/effort and exact policies while dropping unsupported hidden selectors", () => {
    const fields = canonicalAgentFields();
    fields.name = "canonical-claude";
    fields.cmd = "claude";
    fields.canonical!.runtime = {
      adapter: "codex",
      executable: "",
      model: "claude-opus-5",
      provider: "must-drop",
      reasoningEffort: "xhigh",
      serviceTier: "must-drop",
    };
    const workspace = setCodexNativeConfigChoice(fields, "permissions", "workspace");
    const patch = serializeAgentPatch(workspace, true) as AgentProfileStudioMutationV1;

    expect(patch.editable.runtime).toEqual({
      adapter: "claude",
      executable: "claude",
      model: "claude-opus-5",
      reasoningEffort: "xhigh",
    });
    expect(patch.editable.nativeConfig).toMatchObject({
      selectors: {
        source: "agent",
        treatment: "overlay",
        refresh: "every-launch",
        lifecycle: ["fresh", "restart", "resume", "fork"],
      },
      permissions: {
        source: "workspace",
        treatment: "overlay",
        refresh: "every-launch",
        lifecycle: ["fresh", "restart", "resume", "fork"],
      },
    });
    expect(JSON.stringify(patch)).not.toContain("must-drop");
  });

  it("round-trips the fixed Codex scalar source choices without exposing unsupported tuples", () => {
    const initial = canonicalAgentFields();
    const workspace = setCodexNativeConfigChoice(initial, "permissions", "workspace");
    const excluded = setCodexNativeConfigChoice(workspace, "interface", "exclude");

    expect(codexNativeConfigChoice(workspace, "permissions")).toBe("workspace");
    expect(codexNativeConfigChoice(excluded, "interface")).toBe("exclude");
    expect(excluded.canonical?.nativeConfig.permissions).toEqual({
      source: "workspace",
      treatment: "overlay",
      refresh: "every-launch",
      lifecycle: ["fresh", "restart", "resume"],
    });
    expect(excluded.canonical?.nativeConfig.interface).toBeUndefined();

    excluded.name = "canonical-codex";
    excluded.cmd = "codex";
    const patch = serializeAgentPatch(excluded, true);
    expect(patch).toMatchObject({
      kind: "canonical",
      editable: {
        nativeConfig: {
          permissions: { source: "workspace" },
          featureFlags: { source: "global" },
        },
      },
    });
    expect((patch as AgentProfileStudioMutationV1).editable.nativeConfig?.interface).toBeUndefined();
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

  describe("SDD 471/472 — permission authorizations", () => {
    function claudeFields() {
      const snapshot = profileSnapshot();
      snapshot.editable.runtime = { adapter: "claude", executable: "claude" };
      snapshot.editable.nativeConfig = {
        permissions: {
          source: "global", treatment: "overlay", refresh: "every-launch",
          lifecycle: ["fresh", "restart", "resume", "fork"],
        },
      };
      return canonicalAgentFields(snapshot);
    }

    function codexFields() {
      const snapshot = profileSnapshot();
      snapshot.editable.nativeConfig = {
        permissions: {
          source: "global", treatment: "overlay", refresh: "every-launch",
          lifecycle: ["fresh", "restart", "resume"],
        },
      };
      return canonicalAgentFields(snapshot);
    }

    it("is off by default and each runtime is offered only its own authorizations", () => {
      const claude = claudeFields();
      expect(nativeConfigAuthorized(claude, "bypassPermissions")).toBe(false);
      expect(permissionAuthorizationChoices(claude)).toEqual(["bypassPermissions"]);

      // Excluding the family removes the control — there is nothing left to authorize.
      expect(permissionAuthorizationChoices(setNativeConfigChoice(claude, "permissions", "exclude"))).toEqual([]);

      // A Codex agent is offered its OWN authorizations, never Claude's (SDD 472).
      const codex = codexFields();
      expect(permissionAuthorizationChoices(codex)).toEqual(["neverAskForApproval", "dangerFullAccess"]);
      expect(permissionAuthorizationChoices(codex)).not.toContain("bypassPermissions");
      expect(nativeConfigAuthorized(codex, "neverAskForApproval")).toBe(false);
      expect(nativeConfigAuthorized(codex, "dangerFullAccess")).toBe(false);

      // And with no permissions family projected there is nothing to authorize on either runtime.
      expect(permissionAuthorizationChoices(canonicalAgentFields(profileSnapshot()))).toEqual([]);
      expect(permissionAuthorizationChoices(setNativeConfigChoice(codex, "permissions", "exclude"))).toEqual([]);
    });

    it("SDD 472: round-trips each Codex authorization independently", () => {
      const codex = setNativeConfigAuthorized(codexFields(), "dangerFullAccess", true);
      expect(nativeConfigAuthorized(codex, "dangerFullAccess")).toBe(true);
      expect(nativeConfigAuthorized(codex, "neverAskForApproval")).toBe(false);

      const patch = serializeAgentPatch(codex, true) as AgentProfileStudioMutationV1;
      expect(patch.editable.nativeConfig?.permissions?.authorize).toEqual(["dangerFullAccess"]);

      // Both together, and preserved through the per-adapter policy rebuild on save.
      const both = setNativeConfigAuthorized(codex, "neverAskForApproval", true);
      const bothPatch = serializeAgentPatch(setNativeConfigChoice(both, "interface", "workspace"), true) as AgentProfileStudioMutationV1;
      expect(bothPatch.editable.nativeConfig?.permissions?.authorize)
        .toEqual(["neverAskForApproval", "dangerFullAccess"]);
    });

    it("round-trips the authorization through a save", () => {
      const authorized = setNativeConfigAuthorized(claudeFields(), "bypassPermissions", true);
      expect(nativeConfigAuthorized(authorized, "bypassPermissions")).toBe(true);

      const patch = serializeAgentPatch(authorized, true) as AgentProfileStudioMutationV1;
      expect(patch.editable.nativeConfig?.permissions?.authorize).toEqual(["bypassPermissions"]);

      // Reloading the saved profile shows the control still enabled.
      const reloaded = profileSnapshot();
      reloaded.editable.runtime = { adapter: "claude", executable: "claude" };
      reloaded.editable.nativeConfig = patch.editable.nativeConfig;
      expect(nativeConfigAuthorized(canonicalAgentFields(reloaded), "bypassPermissions")).toBe(true);
    });

    it("survives an unrelated edit that rebuilds the policy on save", () => {
      // normalizedNativeConfig rebuilds every family policy from the dropdown at serialize time,
      // so an authorization would silently reset unless it is carried through.
      const authorized = setNativeConfigAuthorized(claudeFields(), "bypassPermissions", true);
      const switched = setNativeConfigChoice(authorized, "interface", "workspace");
      const patch = serializeAgentPatch(switched, true) as AgentProfileStudioMutationV1;
      expect(patch.editable.nativeConfig?.permissions?.authorize).toEqual(["bypassPermissions"]);
    });

    it("drops the authorization when it is turned off or its family is excluded", () => {
      const authorized = setNativeConfigAuthorized(claudeFields(), "bypassPermissions", true);

      const off = setNativeConfigAuthorized(authorized, "bypassPermissions", false);
      expect(nativeConfigAuthorized(off, "bypassPermissions")).toBe(false);
      expect((serializeAgentPatch(off, true) as AgentProfileStudioMutationV1)
        .editable.nativeConfig?.permissions?.authorize).toBeUndefined();

      const excluded = setNativeConfigChoice(authorized, "permissions", "exclude");
      expect((serializeAgentPatch(excluded, true) as AgentProfileStudioMutationV1)
        .editable.nativeConfig?.permissions).toBeUndefined();
    });

    it("t-26f508: a Grok profile offers only its own source and its own authorization", () => {
      const snapshot = profileSnapshot();
      snapshot.editable.runtime = { adapter: "grok", executable: "grok", model: "grok-4.5" };
      snapshot.editable.nativeConfig = {
        permissions: {
          source: "global", treatment: "overlay", refresh: "every-launch",
          lifecycle: ["fresh", "restart", "resume"],
        },
      };
      const grok = canonicalAgentFields(snapshot);
      // No `workspace` option: Grok's project config contributes none of these families.
      expect(nativeConfigSourceChoices(grok)).toEqual(["global"]);
      expect(permissionAuthorizationChoices(grok)).toEqual(["alwaysApprove"]);
      expect(permissionAuthorizationChoices(grok)).not.toContain("bypassPermissions");

      // Saving records the three refusals alongside the selected families, so the profile states
      // what it will not inherit rather than leaving it to the materializer.
      const authorized = setNativeConfigAuthorized(grok, "alwaysApprove", true);
      const patch = serializeAgentPatch(authorized, true) as AgentProfileStudioMutationV1;
      const nativeConfig = patch.editable.nativeConfig!;
      expect(nativeConfig.permissions?.authorize).toEqual(["alwaysApprove"]);
      expect(nativeConfig.permissions?.lifecycle).toEqual(["fresh", "restart", "resume", "fork"]);
      expect(nativeConfig.tooling).toMatchObject({ source: "workspace", treatment: "exclude" });
      expect(nativeConfig.memory).toMatchObject({ source: "agent", treatment: "exclude" });
      expect(nativeConfig.authentication).toMatchObject({ source: "global", treatment: "external" });
      expect(nativeConfig.selectors).toMatchObject({ source: "agent", treatment: "overlay" });
      expect(validateAgentNativeConfigPolicy("grok", nativeConfig)).toEqual([]);

      // A workspace choice cannot be smuggled in through the setter either.
      const clamped = setNativeConfigChoice(grok, "interface", "workspace");
      expect(clamped.canonical?.nativeConfig.interface?.source).toBe("global");
    });
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
