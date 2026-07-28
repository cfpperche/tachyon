import { describe, expect, it } from "vitest";
import {
  agentProfileStudioSnapshotSchemaV1,
  agentProfileStudioLifecycleMutationSchemaV1,
  agentProfileStudioLifecycleResultSchemaV1,
  createProfileFromStudioMutation,
  patchProfileFromStudioMutation,
  projectAgentProfileStudioSnapshot,
  type AgentProfileStudioMutationV1,
} from "../../src/config/agentProfileStudio.js";
import type { AgentProfileLifecycleSnapshot } from "../../src/config/agentProfileLifecycle.js";

function lifecycleSnapshot(): AgentProfileLifecycleSnapshot {
  return {
    schemaVersion: 1,
    canonicalizationVersion: 1,
    agentName: "reviewer",
    agentId: "123e4567-e89b-42d3-a456-426614174000",
    revision: "a".repeat(64),
    profile: {
      schemaVersion: 1,
      agentId: "123e4567-e89b-42d3-a456-426614174000",
      displayName: "Reviewer",
      runtime: { adapter: "codex", executable: "codex", model: "gpt-example" },
      environment: {
        values: { PUBLIC: "private-enough-not-to-project" },
        secrets: { TOKEN: { provider: "vault", id: "secret-handle", purpose: "auth" } },
      },
      prompt: { soul: "soul", evolution: "evolution", role: "reviewer" },
      lifecycle: {
        enabled: false, autostart: true, restart: "on-crash",
        attention: { enabled: false, silenceSec: 12 }, watch: ["src/**"],
      },
      workspace: { cwd: "apps/reviewer", worktree: { enabled: true, branch: "feature/reviewer" } },
      isolation: "transcript",
      references: [
        { id: "soul", kind: "soul", scope: "profile", owner: "123e4567-e89b-42d3-a456-426614174000", path: "SOUL.md", mode: "pinned", sha256: "b".repeat(64) },
        { id: "evolution", kind: "evolution", scope: "product", owner: "tachyon", path: "evolution.md", mode: "pinned", sha256: "c".repeat(64), version: "1" },
      ],
    },
    provenance: {
      canonical: { scope: "profile", writable: true, sha256: "d".repeat(64) },
      authority: { scope: "host", writable: false, revision: "lifecycle-one", grants: 2 },
      learned: { scope: "profile", writable: false, present: true },
      projection: { scope: "runtime", writable: false, active: false },
    },
  };
}

function mutation(expectedRevision?: string): AgentProfileStudioMutationV1 {
  return {
    schemaVersion: 1,
    kind: "canonical",
    agentName: "reviewer",
    ...(expectedRevision ? { expectedRevision } : {}),
    editable: {
      displayName: "Review Agent",
      runtime: { adapter: "codex", executable: "codex", model: "gpt-next" },
      role: "tester",
      cwd: "apps/tester",
      lifecycle: { autostart: false, restart: "never", attention: true, watch: ["test/**"] },
      worktree: { enabled: false, branch: "" },
      isolation: "",
      nativeConfig: {
        selectors: {
          source: "agent",
          treatment: "overlay",
          refresh: "every-launch",
          lifecycle: ["fresh", "restart", "resume"],
        },
      },
    },
  };
}

describe("canonical Agent Studio projection", () => {
  it("projects only authored editable values plus content-free binding/provenance metadata", () => {
    const projected = projectAgentProfileStudioSnapshot(lifecycleSnapshot());
    expect(projected.editable).toEqual({
      displayName: "Reviewer",
      runtime: { adapter: "codex", executable: "codex", model: "gpt-example" },
      role: "reviewer",
      cwd: "apps/reviewer",
      lifecycle: { autostart: true, restart: "on-crash", attention: false, watch: ["src/**"] },
      worktree: { enabled: true, branch: "feature/reviewer" },
      isolation: "transcript",
      nativeConfig: {},
      capabilities: { skills: [], mcp: [], hooks: [] },
    });
    expect(projected.bindings).toMatchObject({
      environmentValueNames: ["PUBLIC"],
      secretNames: ["TOKEN"],
      prompt: { soul: true, evolution: true },
    });
    expect(projected.readiness).toEqual({ state: "limited", limitations: ["fork-unavailable"] });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("private-enough-not-to-project");
    expect(serialized).not.toContain("secret-handle");
    expect(serialized).not.toContain("vault");
    expect(serialized).not.toContain("SOUL.md");
    expect(serialized).not.toContain("capabilityReferenceIds");
  });

  it("derives canonical readiness from runtime capability evidence instead of form copy", () => {
    const current = lifecycleSnapshot();
    current.profile.runtime.adapter = "claude";
    expect(projectAgentProfileStudioSnapshot(current).readiness).toEqual({
      state: "ready",
      limitations: [],
    });
    current.profile.runtime.adapter = "pi";
    expect(projectAgentProfileStudioSnapshot(current).readiness).toEqual({
      state: "limited",
      limitations: ["oauth-concurrency-single-live"],
    });
    current.profile.runtime.adapter = "unmeasured-runtime";
    expect(projectAgentProfileStudioSnapshot(current).readiness).toEqual({
      state: "limited",
      limitations: ["runtime-baseline-unverified"],
    });
  });

  it("rejects unknown response fields and creates fresh profiles disabled", () => {
    const projected = projectAgentProfileStudioSnapshot(lifecycleSnapshot());
    expect(agentProfileStudioSnapshotSchemaV1.safeParse({ ...projected, secret: "leak" }).success).toBe(false);
    expect(createProfileFromStudioMutation(mutation())).toEqual({
      displayName: "Review Agent",
      runtime: { adapter: "codex", executable: "codex", model: "gpt-next" },
      prompt: { role: "tester" },
      lifecycle: { enabled: false, watch: ["test/**"] },
      workspace: { cwd: "apps/tester" },
      nativeConfig: {
        selectors: {
          source: "agent",
          treatment: "overlay",
          refresh: "every-launch",
          lifecycle: ["fresh", "restart", "resume"],
        },
      },
    });
    const selected = mutation();
    selected.editable.capabilities = { skills: ["research"], mcp: [], hooks: [] };
    expect(() => createProfileFromStudioMutation(selected)).toThrow("before host authorization");
  });

  it("accepts exact Claude authoring and rejects hidden or malformed selector fields before write", () => {
    const edited = mutation();
    edited.editable.runtime = {
      adapter: "claude",
      executable: "claude",
      model: "claude-opus-5",
      reasoningEffort: "xhigh",
    };
    edited.editable.nativeConfig = {
      selectors: {
        source: "agent",
        treatment: "overlay",
        refresh: "every-launch",
        lifecycle: ["fresh", "restart", "resume", "fork"],
      },
      permissions: {
        source: "global",
        treatment: "overlay",
        refresh: "every-launch",
        lifecycle: ["fresh", "restart", "resume", "fork"],
      },
    };
    expect(createProfileFromStudioMutation(edited)).toMatchObject({
      runtime: { adapter: "claude", model: "claude-opus-5", reasoningEffort: "xhigh" },
      nativeConfig: {
        selectors: { source: "agent", lifecycle: ["fresh", "restart", "resume", "fork"] },
        permissions: { source: "global", lifecycle: ["fresh", "restart", "resume", "fork"] },
      },
    });

    edited.editable.runtime.provider = "hidden-provider";
    expect(() => createProfileFromStudioMutation(edited)).toThrow("Claude provider is not authorable");
    delete edited.editable.runtime.provider;
    edited.editable.runtime.reasoningEffort = "ultra";
    expect(() => createProfileFromStudioMutation(edited)).toThrow("Claude effort must be");
    edited.editable.runtime.reasoningEffort = "high";
    edited.editable.nativeConfig!.selectors!.lifecycle = ["fresh", "restart", "resume"];
    expect(() => createProfileFromStudioMutation(edited)).toThrow("has not declared native configuration support");
  });

  it("round-trips authored native policy and exposes only content-free support provenance", () => {
    const current = lifecycleSnapshot();
    current.profile.nativeConfig = {
      permissions: {
        source: "workspace",
        treatment: "overlay",
        refresh: "every-launch",
        lifecycle: ["fresh", "resume"],
        authorize: ["neverAskForApproval", "dangerFullAccess"],
      },
    };
    const projected = projectAgentProfileStudioSnapshot(current);

    expect(projected.editable.nativeConfig).toEqual(current.profile.nativeConfig);
    expect(projected.provenance.nativeConfig).toEqual([{
      family: "permissions",
      source: "workspace",
      treatment: "overlay",
      refresh: "every-launch",
      lifecycle: ["fresh", "resume"],
      support: "unsupported",
      reason: "runtime adapter 'codex' has not declared native configuration support for 'permissions'",
    }]);
    expect(projected.provenance.nativeConfig?.[0]).not.toHaveProperty("authorize");

    const edited = mutation(current.revision);
    edited.editable.nativeConfig = projected.editable.nativeConfig;
    expect(patchProfileFromStudioMutation(edited, current).nativeConfig).toEqual(current.profile.nativeConfig);
  });

  it("lists only host-authorized tooling references and permits selection without authoring a reference", () => {
    const current = lifecycleSnapshot();
    current.profile.references!.push(
      { id: "research", kind: "skill", scope: "project", owner: "workspace", path: "hidden/skill", mode: "pinned", sha256: "e".repeat(64) },
      { id: "ungranted-skill", kind: "skill", scope: "project", owner: "workspace", path: "hidden/skill", mode: "pinned", sha256: "f".repeat(64) },
    );
    current.provenance.authority.capabilityReferenceIds = ["research"];
    const projected = projectAgentProfileStudioSnapshot(current);

    expect(projected.bindings.tooling).toEqual({ skills: [{ id: "research", scope: "project" }], mcp: [], hooks: [] });
    expect(JSON.stringify(projected)).not.toContain("hidden/");
    const edited = mutation(current.revision);
    edited.editable.capabilities = { skills: ["research"], mcp: [], hooks: [] };
    expect(patchProfileFromStudioMutation(edited, current).capabilities).toEqual({ skills: ["research"], mcp: [], hooks: [] });
    edited.editable.capabilities = { skills: ["ungranted-skill"], mcp: [], hooks: [] };
    expect(() => patchProfileFromStudioMutation(edited, current)).toThrow("not a host-authorized skill reference");
  });

  it("keeps Pi selections and preserves existing capabilities for legacy Studio clients", () => {
    const current = lifecycleSnapshot();
    current.profile.capabilities = { skills: ["research"], pi: { extensions: ["pi-extension"] } };
    current.profile.references!.push(
      { id: "research", kind: "skill", scope: "project", owner: "workspace", path: "captured/research", mode: "pinned", sha256: "e".repeat(64) },
      { id: "pi-extension", kind: "pi-extension", scope: "project", owner: "workspace", path: "captured/pi", mode: "pinned", sha256: "f".repeat(64) },
    );
    current.provenance.authority.capabilityReferenceIds = ["research", "pi-extension"];

    const edited = mutation(current.revision);
    edited.editable.capabilities = { skills: [], mcp: [], hooks: [] };
    expect(patchProfileFromStudioMutation(edited, current).capabilities).toEqual({
      skills: [], mcp: [], hooks: [], pi: { extensions: ["pi-extension"] },
    });

    const legacy = mutation(current.revision);
    expect(patchProfileFromStudioMutation(legacy, current)).not.toHaveProperty("capabilities");

    const forged = mutation(current.revision) as unknown as { editable: { capabilities: unknown } };
    forged.editable.capabilities = { skills: [], mcp: [], hooks: [], pi: ["research"] };
    expect(() => patchProfileFromStudioMutation(forged as AgentProfileStudioMutationV1, current)).toThrow();
  });

  it("builds a narrow edit while retaining unrelated prompt bindings and rejects stale revisions", () => {
    const current = lifecycleSnapshot();
    expect(patchProfileFromStudioMutation(mutation(current.revision), current)).toEqual({
      displayName: "Review Agent",
      runtime: { adapter: "codex", executable: "codex", model: "gpt-next" },
      prompt: { soul: "soul", evolution: "evolution", role: "tester" },
      lifecycle: {
        enabled: false, autostart: false, restart: "never",
        attention: { enabled: true, silenceSec: 12 }, watch: ["test/**"],
      },
      workspace: { cwd: "apps/tester", worktree: { enabled: false, branch: undefined } },
      isolation: undefined,
      nativeConfig: {
        selectors: {
          source: "agent",
          treatment: "overlay",
          refresh: "every-launch",
          lifecycle: ["fresh", "restart", "resume"],
        },
      },
    });
    expect(() => patchProfileFromStudioMutation(mutation("e".repeat(64)), current)).toThrow("revision conflict");
  });

  it("keeps lifecycle operations strict, revisioned, and free of form fields", () => {
    const setEnabled = {
      schemaVersion: 1,
      operation: "set-enabled",
      agentName: "reviewer",
      expectedRevision: "a".repeat(64),
      enabled: true,
    };
    expect(agentProfileStudioLifecycleMutationSchemaV1.parse(setEnabled)).toEqual(setEnabled);
    expect(agentProfileStudioLifecycleMutationSchemaV1.safeParse({ ...setEnabled, editable: {} }).success).toBe(false);
    expect(agentProfileStudioLifecycleMutationSchemaV1.safeParse({
      schemaVersion: 1,
      operation: "forget",
      agentName: "reviewer",
      expectedRevision: "stale",
      confirmation: "reviewer",
    }).success).toBe(false);
    expect(agentProfileStudioLifecycleResultSchemaV1.safeParse({
      schemaVersion: 1,
      kind: "forgotten",
      agentName: "reviewer",
      agentId: "123e4567-e89b-42d3-a456-426614174000",
      privatePath: "/secret",
    }).success).toBe(false);
  });
});
