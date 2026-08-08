import { describe, expect, it } from "vitest";
import {
  agentOwnershipView,
  agentOwnershipViewSchemaV1,
  agentProfileStudioMutationSchemaV1,
  agentProfileStudioSnapshotSchemaV1,
  agentProfileStudioLifecycleMutationSchemaV1,
  agentProfileStudioLifecycleResultSchemaV1,
  createProfileFromStudioMutation,
  patchProfileFromStudioMutation,
  ownershipPatchFromStudioMutation,
  projectAgentProfileStudioSnapshot,
  type AgentOwnershipRosterV1,
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
    kind: "agent-instance",
    agentName: "reviewer",
    ...(expectedRevision ? { expectedRevision } : {}),
    editable: {
      displayName: "Review Agent",
      runtime: { adapter: "codex", executable: "codex", model: "gpt-next" },
      role: "tester",
      cwd: "apps/tester",
      lifecycle: { autostart: false, restart: "never", attention: true },
      worktree: { enabled: false, branch: "", setup: [] },
      verify: "",
      selfEvolution: false,
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
      lifecycle: { autostart: true, restart: "on-crash", attention: false },
      // t-afc86e — `setup`/`verify` come back EMPTY here because this fixture's profile declares no
      // workspace-command references, so the snapshot carries no artifact bytes. The populated case
      // is the round trip in `agentWorkspaceCommands.test.ts`, which is what proves the read-back.
      worktree: { enabled: true, branch: "feature/reviewer", setup: [] },
      verify: "",
      // t-f96b2f — this fixture pins `prompt.evolution`, so the toggle projects ON. It is the same
      // fact `bindings.prompt.evolution` asserts below, deliberately: the form saves the editable
      // view back, so a snapshot whose toggle disagreed with its own binding would write the
      // opposite of what it displayed.
      selfEvolution: true,
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

  it("rejects unknown response fields and creates fresh profiles enabled (t-ca9086)", () => {
    const projected = projectAgentProfileStudioSnapshot(lifecycleSnapshot());
    expect(agentProfileStudioSnapshotSchemaV1.safeParse({ ...projected, secret: "leak" }).success).toBe(false);
    expect(createProfileFromStudioMutation(mutation())).toEqual({
      displayName: "Review Agent",
      runtime: { adapter: "codex", executable: "codex", model: "gpt-next" },
      prompt: { role: "tester" },
      // t-bd14d8 — no `watch`: a created Agent has none, and the editable mutation has no field to
      // carry one (the strict schema refuses it outright rather than dropping it silently).
      lifecycle: { enabled: true },
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
      // t-bd14d8 — the stored profile in `lifecycleSnapshot()` carries `watch: ["src/**"]`, and this
      // patch has no `watch` key at all: the edit STRIPS it from disk rather than carrying it forward
      // through the lifecycle spread. That is what makes the first Agent Studio save the repair for a
      // legacy profile, and it is the assertion that fails if the delete is ever removed.
      lifecycle: {
        enabled: false, autostart: false, restart: "never",
        attention: { enabled: true, silenceSec: 12 },
      },
      // t-afc86e — `verify`/`setup` are explicit `undefined` for the same reason `branch` already
      // was: the patch states every field it owns, and absence is how a cleared one is written.
      workspace: { cwd: "apps/tester", verify: undefined, worktree: { enabled: false, branch: undefined, setup: undefined } },
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

  /**
   * t-da80ed — an isolated agent's working directory IS its worktree. `AgentManager` overwrites the
   * resolved cwd with the worktree path unconditionally, so persisting both meant the human typed a
   * path, saved without error, and got nothing.
   */
  it("REFUSES a working directory on an agent that runs in its own worktree", () => {
    const current = lifecycleSnapshot();
    const both = mutation(current.revision);
    both.editable.worktree = { enabled: true, branch: "", setup: [] };

    expect(() => patchProfileFromStudioMutation(both, current))
      .toThrow("the worktree IS its working directory");
  });

  it("still accepts a working directory when the agent is NOT isolated", () => {
    const current = lifecycleSnapshot();
    const only = mutation(current.revision);
    only.editable.worktree = { enabled: false, branch: "", setup: [] };

    expect(patchProfileFromStudioMutation(only, current).workspace)
      .toMatchObject({ cwd: "apps/tester", worktree: { enabled: false } });
  });

  it("accepts an isolated agent that declares no working directory", () => {
    // The refusal must fire on the CONTRADICTION, never on isolation itself — every canonical agent
    // in this workspace is isolated and declares no cwd.
    const current = lifecycleSnapshot();
    const isolated = mutation(current.revision);
    isolated.editable.cwd = "";
    isolated.editable.worktree = { enabled: true, branch: "feature/x", setup: [] };

    expect(patchProfileFromStudioMutation(isolated, current).workspace)
      .toMatchObject({ cwd: undefined, worktree: { enabled: true, branch: "feature/x" } });
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

  /**
   * t-05dff5 — the refused outcome is validated by SHAPE, and that asymmetry is the durability claim.
   *
   * The code list is closed where preconditions are AUTHORED, so a typo cannot invent a refusal. It
   * is open where the payload is DECODED, so a shell running one release behind its engine still
   * renders a refusal code it has never heard of. Pinning the wire to today's list would make every
   * new precondition arrive as "malformed" — that is, as the generic sentence this task removed.
   */
  it("accepts an unknown-but-well-shaped refusal code and rejects a malformed one", () => {
    const refusal = {
      schemaVersion: 1,
      kind: "refused",
      code: "agent-profile/forget-worktree-owned",
      message: "agent 'reviewer' still owns a worktree; remove it explicitly before canonical forget",
    };
    expect(agentProfileStudioLifecycleResultSchemaV1.parse(refusal)).toEqual(refusal);
    expect(agentProfileStudioLifecycleResultSchemaV1.safeParse({
      ...refusal, code: "agent-profile/a-precondition-from-a-newer-engine",
    }).success).toBe(true);
    for (const code of ["lifecycle-failed", "agent-profile/", "agent-profile/Forget", "agent-profile/a--b", "other/forget"]) {
      expect(agentProfileStudioLifecycleResultSchemaV1.safeParse({ ...refusal, code }).success).toBe(false);
    }
    expect(agentProfileStudioLifecycleResultSchemaV1.safeParse({ ...refusal, message: "" }).success).toBe(false);
    expect(agentProfileStudioLifecycleResultSchemaV1.safeParse({ ...refusal, snapshot: {} }).success).toBe(false);
  });
});

describe("declared subagents authoring (t-4c113c)", () => {
  const owner = "codex-canonico";
  type RosterOverride = { kind?: "agent" | "terminal"; subagents?: string[] };
  const roster = (overrides: Record<string, RosterOverride> = {}): AgentOwnershipRosterV1 =>
    Object.entries<RosterOverride>({
      [owner]: {},
      "claude-builder": {},
      "claude-runtime": {},
      "claude-reviewer": {},
      ...overrides,
    }).map(([name, entry]) => ({
      name,
      kind: entry.kind ?? "agent",
      subagents: entry.subagents ?? [],
    }));
  const agents = (entries: AgentOwnershipRosterV1): AgentOwnershipRosterV1 =>
    entries.filter((entry) => entry.kind === "agent");

  const ownerSnapshot = (subagents?: string[]): AgentProfileLifecycleSnapshot => {
    const base = lifecycleSnapshot();
    return {
      ...base,
      agentName: owner,
      profile: { ...base.profile, ...(subagents ? { ownership: { subagents } } : {}) },
    };
  };

  const setSubagents = (subagents: string[], expectedRevision = "a".repeat(64)) => ({
    schemaVersion: 1 as const,
    operation: "set-subagents" as const,
    agentName: owner,
    expectedRevision,
    subagents,
  });

  it("declares the whole team in one authority-preserving patch and clears it with an empty list", () => {
    const team = ["claude-builder", "claude-runtime", "claude-reviewer"];
    expect(ownershipPatchFromStudioMutation(setSubagents(team), ownerSnapshot(), roster())).toEqual({
      ownership: { subagents: team },
    });
    // The key is PRESENT and undefined so the lifecycle patch spread removes the section; an absent
    // key would leave the previous declaration in place and silently ignore the removal.
    const cleared = ownershipPatchFromStudioMutation(setSubagents([]), ownerSnapshot(team), roster({ [owner]: { subagents: team } }));
    expect(cleared).toEqual({ ownership: undefined });
    expect("ownership" in cleared).toBe(true);
  });

  it("refuses a stale revision before it touches the roster", () => {
    expect(() => ownershipPatchFromStudioMutation(setSubagents(["claude-builder"], "e".repeat(64)), ownerSnapshot(), roster()))
      .toThrow("revision conflict");
  });

  it("fails closed on every spec 352 ownership violation with a named target", () => {
    const cases: Array<[string, AgentOwnershipRosterV1, string[], string]> = [
      ["self-reference", roster(), [owner], "cannot reference itself"],
      ["dangling", roster(), ["ghost"], "is not declared in agents/terminals"],
      ["terminal", roster({ shell: { kind: "terminal" } }), ["shell"], "resolves to a terminal"],
      ["multi-owner", roster({ "claude-builder": { subagents: ["claude-runtime"] } }), ["claude-runtime"], "already declared as a subagent of 'claude-builder'"],
      ["direct cycle", roster({ "claude-builder": { subagents: [owner] } }), ["claude-builder"], "direct ownership cycle"],
      ["deep tree", roster({ "claude-builder": { subagents: ["claude-runtime"] } }), ["claude-builder"], "declares its own subagents"],
      ["duplicate", roster(), ["claude-builder", "claude-builder"], "is listed twice"],
    ];
    for (const [label, entries, subagents, message] of cases) {
      expect(() => ownershipPatchFromStudioMutation(setSubagents(subagents), ownerSnapshot(), entries), label).toThrow(message);
    }
  });

  it("refuses to make an owned agent an owner, and offers it no candidates", () => {
    const owned = roster({ "claude-builder": { subagents: [owner] } });
    expect(() => ownershipPatchFromStudioMutation(setSubagents(["claude-runtime"]), ownerSnapshot(), owned))
      .toThrow("nested subagent trees are not supported");
    // Clearing stays possible — an over-strict refusal would strand a profile nobody can repair.
    expect(ownershipPatchFromStudioMutation(setSubagents([]), ownerSnapshot(), owned)).toEqual({ ownership: undefined });
    expect(agentOwnershipView(owner, agents(owned))).toEqual({ subagents: [], candidates: [], ownedBy: "claude-builder" });
  });

  it("offers only targets the transaction would accept, and never drops what is already declared", () => {
    const team = ["claude-builder", "claude-runtime"];
    const current = roster({
      [owner]: { subagents: team },
      "claude-reviewer": { subagents: [] },
      other: { subagents: ["taken"] },
      taken: {},
      shell: { kind: "terminal" },
    });
    expect(agentOwnershipView(owner, agents(current))).toEqual({
      subagents: ["claude-builder", "claude-runtime"],
      // `other` owns something, `taken` is owned, `shell` is a terminal — none may be declared here.
      candidates: ["claude-builder", "claude-reviewer", "claude-runtime"],
    });
  });

  it("keeps the operation strict, revisioned and bounded on the wire", () => {
    expect(agentProfileStudioLifecycleMutationSchemaV1.parse(setSubagents(["claude-builder"])))
      .toEqual(setSubagents(["claude-builder"]));
    expect(agentProfileStudioLifecycleMutationSchemaV1.safeParse(setSubagents([], "stale")).success).toBe(false);
    expect(agentProfileStudioLifecycleMutationSchemaV1.safeParse({ ...setSubagents([]), enabled: true }).success).toBe(false);
    expect(agentProfileStudioLifecycleMutationSchemaV1.safeParse(setSubagents(Array.from({ length: 129 }, (_, i) => `a${i}`))).success).toBe(false);
    expect(agentOwnershipViewSchemaV1.safeParse({ subagents: [], candidates: [], extra: 1 }).success).toBe(false);
  });

  /**
   * t-04052d — the Studio speaks ONE contract, and the retired species is refused rather than mapped.
   *
   * `kind` was the species discriminator: `canonical` designated a second kind of worker beside the
   * ad-hoc one. The cut leaves a single Agent Instance contract, so the literal changes and the old
   * value stops parsing. Refusal is the deliverable — accepting `canonical` as an alias would keep the
   * species alive in the one place a client can still name it.
   */
  it("accepts only the Agent Instance contract and refuses the retired species", () => {
    const accepted = mutation();
    expect(accepted.kind).toBe("agent-instance");
    expect(agentProfileStudioMutationSchemaV1.safeParse(accepted).success).toBe(true);

    const retired = { ...accepted, kind: "canonical" };
    expect(agentProfileStudioMutationSchemaV1.safeParse(retired).success).toBe(false);
    // Not reinterpreted either: the refusal is at the contract, before any field is read.
    expect(() => createProfileFromStudioMutation(retired as never)).toThrow();

    // The snapshot side states the same single contract.
    const snapshot = projectAgentProfileStudioSnapshot(lifecycleSnapshot());
    expect(snapshot.kind).toBe("agent-instance");
    expect(agentProfileStudioSnapshotSchemaV1.safeParse({ ...snapshot, kind: "canonical" }).success).toBe(false);
  });
});
