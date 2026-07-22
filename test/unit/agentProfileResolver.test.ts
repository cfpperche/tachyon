import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfig, type AgentDef } from "../../src/config/loadConfig.js";
import {
  agentProfileRuntimeSelectorsSha256,
  resolveAgentProfile,
  type NativeRuntimeAttestation,
  type NormalizedAgentDefinition,
  type ResolveAgentProfileInput,
  type ResolveAgentProfileResult,
} from "../../src/config/agentProfileResolver.js";

const roots: string[] = [];
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const INSPECTOR = { adapter: "codex", id: "test-adapter-inspector", version: "1", sha256: "a".repeat(64) };

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-agent-profile-"));
  roots.push(root);
  return root;
}

function digest(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function profileDir(root: string, agent = "codex"): string {
  const directory = path.join(root, ".tachyon", "agents", agent);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function canonical(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    agentId: AGENT_ID,
    runtime: { adapter: "codex", executable: "codex", model: "gpt-5.6-sol" },
    ...overrides,
  };
}

function writeProfile(root: string, profile: Record<string, unknown>, agent = "codex"): string {
  const file = path.join(profileDir(root, agent), "agent.yml");
  fs.writeFileSync(file, stringify(profile));
  return file;
}

function legacyAgent(name = "codex", extra = ""): AgentDef {
  const parsed = parseConfig(`agents:\n  ${name}:\n    cmd: codex --model gpt-5.6-sol\n${extra}`);
  expect(parsed.errors).toEqual([]);
  return parsed.config!.agents[name]!;
}

function legacySource(definition: AgentDef, source?: string): NonNullable<ResolveAgentProfileInput["legacy"]> {
  return {
    ...(source ? { source } : {}),
    definition,
    runtime: { adapterId: "codex", executableId: "codex-adapter" },
  };
}

function resolve(root: string, input: Partial<Omit<ResolveAgentProfileInput, "workspaceRoot" | "agentName">> = {}): ResolveAgentProfileResult {
  const profilePath = path.join(root, ".tachyon", "agents", "codex", "agent.yml");
  const authority = input.authority ?? (fs.existsSync(profilePath)
    ? { revision: "test-profile-r1", canonical: { state: "present" as const, sha256: digest(fs.readFileSync(profilePath)) }, runtimeInspector: INSPECTOR }
    : { revision: "test-profile-r1", canonical: { state: "absent" as const }, runtimeInspector: INSPECTOR });
  const legacyRuntime = input.legacy ? legacyRuntimeDefinition(input.legacy) : undefined;
  const runtime = legacyRuntime ?? {
    adapter: "codex",
    executable: "codex",
    model: "gpt-5.6-sol",
  };
  const nativeRuntime = input.nativeRuntime ?? attestation(runtime);
  return resolveAgentProfile({ workspaceRoot: root, agentName: "codex", ...input, authority, nativeRuntime });
}

function legacyRuntimeDefinition(legacy: NonNullable<ResolveAgentProfileInput["legacy"]>): NormalizedAgentDefinition["runtime"] {
  return {
    adapter: legacy.runtime.adapterId,
    executable: legacy.runtime.executableId,
    legacyCommandSha256: digest(legacy.definition.cmd),
  };
}

function attestation(
  runtime: NormalizedAgentDefinition["runtime"],
  observations: NativeRuntimeAttestation["observations"] = [],
): NativeRuntimeAttestation {
  return {
    adapter: runtime.adapter,
    exhaustive: true,
    authorityRevision: "test-profile-r1",
    selectorsSha256: agentProfileRuntimeSelectorsSha256(runtime),
    inspector: { id: INSPECTOR.id, version: INSPECTOR.version, sha256: INSPECTOR.sha256 },
    observations,
  };
}

function expectSuccess(result: ResolveAgentProfileResult) {
  expect(result.ok, result.ok ? undefined : JSON.stringify(result.errors)).toBe(true);
  if (!result.ok) throw new Error("expected resolver success");
  return result.value;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("resolveAgentProfile", () => {
  it("resolves canonical bytes and pinned local references deterministically with field provenance", () => {
    const root = workspace();
    const instructions = "Always explain the reason.\n";
    fs.writeFileSync(path.join(profileDir(root), "instructions.md"), instructions);
    writeProfile(root, canonical({
      displayName: "Codex",
      prompt: { instructions: "persistent-instructions" },
      references: [{
        id: "persistent-instructions",
        kind: "instructions",
        scope: "profile",
        owner: AGENT_ID,
        path: "instructions.md",
        mode: "pinned",
        sha256: digest(instructions),
      }],
    }));

    const first = expectSuccess(resolve(root));
    const second = expectSuccess(resolve(root));

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      mode: "canonical",
      agentName: "codex",
      agentId: AGENT_ID,
      displayName: "Codex",
      definition: { runtime: { adapter: "codex", executable: "codex", model: "gpt-5.6-sol" } },
    });
    expect(first.references[0]).toMatchObject({ id: "persistent-instructions", resolvedSha256: digest(instructions) });
    expect("bytes" in first.references[0]!).toBe(false);
    expect(first.provenance).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "runtime.adapter", sourceKind: "profile" }),
      expect.objectContaining({ field: "runtime.model", sourceKind: "profile" }),
      expect.objectContaining({ field: "references.persistent-instructions", sha256: digest(instructions) }),
    ]));
    expect(first.effectiveSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("normalizes a legacy stanza only when the canonical profile is absent", () => {
    const root = workspace();
    const value = expectSuccess(resolve(root, { legacy: legacySource(legacyAgent()) }));

    expect(value.mode).toBe("legacy");
    expect(value.agentId).toBeUndefined();
    expect(value.definition.runtime).toMatchObject({
      adapter: "codex",
      executable: "codex-adapter",
      legacyCommandSha256: digest("codex --model gpt-5.6-sol"),
    });
    expect(value.provenance.every((entry) => entry.sourceKind === "legacy")).toBe(true);
  });

  it("rejects double authority and names both canonical and legacy sources", () => {
    const root = workspace();
    writeProfile(root, canonical());
    const result = resolve(root, { legacy: legacySource(legacyAgent(), "tachyon.yml#agents.codex") });

    expect(result).toMatchObject({ ok: false, errors: [{ code: "profile/double-authority" }] });
    if (result.ok) throw new Error("expected failure");
    expect(result.errors[0]!.source).toContain("agent.yml");
    expect(result.errors[0]!.message).toContain("tachyon.yml#agents.codex");
  });

  it("returns an explicit missing-source diagnostic", () => {
    const result = resolve(workspace());
    expect(result).toMatchObject({ ok: false, errors: [{ code: "profile/missing" }] });
  });

  it.each([
    [canonical({ schemaVersion: 2 }), "profile/unsupported-version", "schemaVersion"],
    [canonical({ unexpected: true }), "profile/schema", ""],
    [canonical({ agentId: "not-a-uuid" }), "profile/schema", "agentId"],
    [canonical({ plugins: ["workspace-plugin"] }), "profile/schema", ""],
    [canonical({ references: [{ id: "bad", kind: "instructions", scope: "profile", owner: AGENT_ID, path: "../escape", mode: "pinned", sha256: "0".repeat(64) }] }), "profile/schema", "references"],
    [canonical({ references: [{ id: "bad-owner", kind: "instructions", scope: "profile", owner: "another-agent", path: "instructions.md", mode: "pinned", sha256: "0".repeat(64) }] }), "profile/schema", "references"],
    [canonical({ references: [{ id: "floating-role", kind: "role", scope: "product", owner: "tachyon", path: "roles/coder.md", mode: "floating", version: "1" }] }), "profile/schema", "references"],
    [canonical({ runtime: { adapter: "codex", executable: "codex", model: "typed", args: ["--model=hidden"] } }), "profile/schema", "runtime"],
    [canonical({ runtime: { adapter: "codex", executable: "codex", args: ["--api-key=secret-value"] } }), "profile/schema", "runtime"],
    [canonical({ runtime: { adapter: "codex", executable: "codex --model hidden" } }), "profile/schema", "runtime.executable"],
    [canonical({ workspace: { worktree: { setup: ["echo hidden-command"] } } }), "profile/schema", "workspace.worktree.setup"],
  ])("rejects invalid schema without a partial value", (profile, code, field) => {
    const root = workspace();
    writeProfile(root, profile);
    const result = resolve(root);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.some((error) => error.code === code && (field.length === 0 || error.field?.includes(field)))).toBe(true);
    expect("value" in result).toBe(false);
  });

  it("rejects invalid YAML with a stable code", () => {
    const root = workspace();
    fs.writeFileSync(path.join(profileDir(root), "agent.yml"), "schemaVersion: [\n");
    const result = resolve(root);
    expect(result).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: "profile/invalid-yaml" })] });
  });

  it("applies only explicitly named environment and workspace inheritance", () => {
    const root = workspace();
    writeProfile(root, canonical({
      environment: { values: { EXPLICIT: "profile" } },
      inherit: { environment: ["LANG"], workspace: ["worktree.base", "projectGuidance", "bridgeGuidance"] },
    }));
    const guidanceDigest = digest("project guidance");
    const value = expectSuccess(resolve(root, {
      inheritedEnvironment: {
        LANG: { value: "pt_BR.UTF-8", classification: "non-secret", owner: "workspace.env.LANG" },
        UNDECLARED: { value: "must-not-appear", classification: "non-secret", owner: "workspace.env.UNDECLARED" },
      },
      workspaceDefaults: {
        worktreeBase: "/tmp/tachyon-worktrees",
        worktreeBranch: "ignored/{agent}",
        bridgeGuidance: true,
        projectGuidance: [{ sourcePath: "docs/project-guidance.md", sha256: guidanceDigest }],
      },
    }));

    expect(value.definition.environment?.values).toEqual({ EXPLICIT: "profile", LANG: "pt_BR.UTF-8" });
    expect(value.definition.workspace?.worktree).toEqual({ base: "/tmp/tachyon-worktrees" });
    expect(value.definition.inherited).toEqual({
      bridgeGuidance: true,
      projectGuidance: [{ sourcePath: "docs/project-guidance.md", sha256: guidanceDigest }],
    });
    expect(value.provenance).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "environment.values.EXPLICIT", sourceKind: "profile" }),
      expect.objectContaining({ field: "environment.values.LANG", sourceKind: "environment" }),
      expect.objectContaining({ field: "inherited.projectGuidance.0.sourcePath", sourceKind: "project", sha256: guidanceDigest }),
      expect.objectContaining({ field: "inherited.projectGuidance.0.sha256", sourceKind: "project", sha256: guidanceDigest }),
    ]));
    expect(JSON.stringify(value)).not.toContain("must-not-appear");
    expect(JSON.stringify(value)).not.toContain("ignored/{agent}");
  });

  it("fails when an explicitly named inherited value is unavailable", () => {
    const root = workspace();
    writeProfile(root, canonical({ inherit: { environment: ["LANG"], workspace: ["verify"] } }));
    const result = resolve(root);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.errors.map((error) => error.code)).toEqual(["profile/missing-inheritance", "profile/missing-inheritance"]);
  });

  it("inherits verification only through a matching resolved pinned reference", () => {
    const root = workspace();
    const verifyDigest = digest("npm run verify:full:quiet");
    writeProfile(root, canonical({
      inherit: { workspace: ["verify"] },
      references: [{
        id: "workspace-verify",
        kind: "verification",
        scope: "project",
        owner: "workspace",
        path: "config/verify/full",
        mode: "pinned",
        sha256: verifyDigest,
      }],
    }));
    const externalReferences = [{
      id: "workspace-verify",
      scope: "project" as const,
      owner: "workspace",
      path: "config/verify/full",
      sha256: verifyDigest,
    }];
    const value = expectSuccess(resolve(root, {
      externalReferences,
      workspaceDefaults: { verify: { referenceId: "workspace-verify", sha256: verifyDigest } },
    }));
    expect(value.definition.workspace?.verify).toBe("workspace-verify");
    expect(value.provenance).toContainEqual(expect.objectContaining({ field: "workspace.verify", sha256: verifyDigest }));

    const failed = resolve(root, {
      externalReferences,
      workspaceDefaults: { verify: { referenceId: "workspace-verify", sha256: "f".repeat(64) } },
    });
    expect(failed).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: "profile/missing-inheritance", field: "workspace.verify" })] });
  });

  it("uses explicit channel classification and never adopts an ambient secret", () => {
    const root = workspace();
    writeProfile(root, canonical({ environment: {
      values: { OPENAI_API_KEY: "explicitly-declared-public-placeholder" },
      secrets: { PROVIDER_TOKEN: { provider: "host-store", id: "provider-token-ref", purpose: "model access" } },
    } }));
    const prior = process.env.PROVIDER_TOKEN;
    process.env.PROVIDER_TOKEN = "ambient-secret-value";
    try {
      const value = expectSuccess(resolve(root));
      expect(value.definition.environment).toMatchObject({
        values: { OPENAI_API_KEY: "explicitly-declared-public-placeholder" },
        secrets: { PROVIDER_TOKEN: { id: "provider-token-ref" } },
      });
      expect(JSON.stringify(value)).not.toContain("ambient-secret-value");
    } finally {
      if (prior === undefined) delete process.env.PROVIDER_TOKEN;
      else process.env.PROVIDER_TOKEN = prior;
    }
  });

  it("keeps all legacy environment values out of the public compatibility result", () => {
    const root = workspace();
    const definition = legacyAgent("codex", "    env:\n      PROVIDER_TOKEN: legacy-secret\n");
    const value = expectSuccess(resolve(root, { legacy: legacySource(definition) }));
    expect(value.definition.environment).toEqual({ legacyUnclassifiedNames: ["PROVIDER_TOKEN"] });
    expect(JSON.stringify(value)).not.toContain("legacy-secret");
  });

  it("returns only a digest for a legacy command that may contain secret material", () => {
    const root = workspace();
    const definition = legacyAgent();
    definition.cmd = "env PROVIDER_TOKEN=command-secret codex";
    const value = expectSuccess(resolve(root, { legacy: legacySource(definition) }));
    expect(value.definition.runtime.legacyCommandSha256).toBe(digest(definition.cmd));
    expect(JSON.stringify(value)).not.toContain("command-secret");
  });

  it("returns only digests for opaque legacy setup and verification commands", () => {
    const root = workspace();
    const definition = legacyAgent("codex", "    worktreeSetup:\n      - echo setup-secret\n    verify: echo verify-secret\n");
    const value = expectSuccess(resolve(root, { legacy: legacySource(definition) }));
    expect(value.definition.workspace?.worktree?.legacySetupSha256).toEqual([digest("echo setup-secret")]);
    expect(value.definition.workspace?.legacyVerifySha256).toBe(digest("echo verify-secret"));
    expect(JSON.stringify(value)).not.toContain("setup-secret");
    expect(JSON.stringify(value)).not.toContain("verify-secret");
  });

  it("returns only a digest for opaque legacy instruction content", () => {
    const root = workspace();
    const definition = legacyAgent("codex", "    instructions: private-instruction-content\n");
    const value = expectSuccess(resolve(root, { legacy: legacySource(definition) }));
    expect(value.definition.prompt?.legacyInstructionsSha256).toBe(digest("private-instruction-content"));
    expect(JSON.stringify(value)).not.toContain("private-instruction-content");
  });

  it("rejects unsuppressed native runtime overrides and accepts suppression evidence", () => {
    const root = workspace();
    writeProfile(root, canonical());
    const observation = { field: "runtime.model" as const, source: "private-runtime-config" as const, suppressed: false };
    const runtime = { adapter: "codex", executable: "codex", model: "gpt-5.6-sol" };
    const failed = resolve(root, { nativeRuntime: attestation(runtime, [observation]) });
    expect(failed).toMatchObject({ ok: false, errors: [{ code: "profile/native-override", field: "runtime.model" }] });

    const value = expectSuccess(resolve(root, { nativeRuntime: attestation(runtime, [{ ...observation, suppressed: true }]) }));
    expect(value.nativeRuntime.observations).toEqual([{ ...observation, suppressed: true }]);
  });

  it("fails closed when native inspection is absent, incomplete, or bound to other selectors", () => {
    const root = workspace();
    writeProfile(root, canonical());
    const wrongRuntime = { adapter: "codex", executable: "codex", model: "another-model" };
    const failed = resolve(root, { nativeRuntime: attestation(wrongRuntime) });
    expect(failed).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: "profile/native-attestation" })] });

    const absent = resolveAgentProfile({
      workspaceRoot: root,
      agentName: "codex",
      authority: { revision: "test-profile-r1", canonical: { state: "present", sha256: digest(fs.readFileSync(path.join(root, ".tachyon", "agents", "codex", "agent.yml"))) }, runtimeInspector: INSPECTOR },
      nativeRuntime: undefined as unknown as NativeRuntimeAttestation,
    });
    expect(absent).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: "profile/native-attestation" })] });

    const malformed = resolve(root, { nativeRuntime: {
      ...attestation({ adapter: "codex", executable: "codex", model: "gpt-5.6-sol" }),
      observations: [{ field: "runtime.model", source: "private-runtime-config", suppressed: "true" }],
    } as unknown as NativeRuntimeAttestation });
    expect(malformed).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: "profile/native-attestation" })] });

    const forgedInspector = resolve(root, { nativeRuntime: {
      ...attestation({ adapter: "codex", executable: "codex", model: "gpt-5.6-sol" }),
      inspector: { id: INSPECTOR.id, version: INSPECTOR.version, sha256: "b".repeat(64) },
    } });
    expect(forgedInspector).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: "profile/native-attestation" })] });
  });

  it("binds canonical bytes to the host-custodied profile head", () => {
    const root = workspace();
    writeProfile(root, canonical());
    const result = resolve(root, { authority: { revision: "stale-r1", canonical: { state: "present", sha256: "f".repeat(64) }, runtimeInspector: INSPECTOR } });
    expect(result).toMatchObject({ ok: false, errors: [{ code: "profile/authority-boundary" }] });

    const malformed = resolve(root, { authority: {
      revision: "stale-r1",
      canonical: { state: "present", sha256: "not-a-digest" },
      runtimeInspector: INSPECTOR,
    } as unknown as ResolveAgentProfileInput["authority"] });
    expect(malformed).toMatchObject({ ok: false, errors: [{ code: "profile/authority-boundary" }] });
  });

  it("resolves floating project references from exact owner facts and rejects conflicts", () => {
    const root = workspace();
    writeProfile(root, canonical({
      guidance: { project: ["project-guide"] },
      references: [{
        id: "project-guide",
        kind: "project-guidance",
        scope: "project",
        owner: "workspace",
        path: "docs/project-guidance.md",
        mode: "floating",
      }],
    }));
    const currentDigest = digest("current project guidance");
    const value = expectSuccess(resolve(root, { externalReferences: [{
      id: "project-guide",
      scope: "project",
      owner: "workspace",
      path: "docs/project-guidance.md",
      sha256: currentDigest,
    }] }));
    expect(value.references[0]).toMatchObject({ id: "project-guide", mode: "floating", resolvedSha256: currentDigest });

    const failed = resolve(root, { externalReferences: [{
      id: "project-guide",
      scope: "project",
      owner: "another-owner",
      path: "docs/project-guidance.md",
      sha256: currentDigest,
    }] });
    expect(failed).toMatchObject({ ok: false, errors: [{ code: "profile/reference-conflict" }] });

    const duplicate = resolve(root, { externalReferences: [
      { id: "project-guide", scope: "project", owner: "workspace", path: "docs/project-guidance.md", sha256: currentDigest },
      { id: "project-guide", scope: "project", owner: "workspace", path: "docs/project-guidance.md", sha256: currentDigest },
    ] });
    expect(duplicate).toMatchObject({ ok: false, errors: [{ code: "profile/reference-conflict" }] });
  });

  it("rejects a changed pinned reference instead of adopting new bytes", () => {
    const root = workspace();
    const original = "version one";
    const file = path.join(profileDir(root), "instructions.md");
    fs.writeFileSync(file, original);
    writeProfile(root, canonical({
      prompt: { instructions: "instructions" },
      references: [{
        id: "instructions",
        kind: "instructions",
        scope: "profile",
        owner: AGENT_ID,
        path: "instructions.md",
        mode: "pinned",
        sha256: digest(original),
      }],
    }));
    fs.writeFileSync(file, "version two");

    const result = resolve(root);
    expect(result).toMatchObject({ ok: false, errors: [{ code: "profile/digest-mismatch", field: "references.instructions" }] });
  });

  it("rejects symbolic links in both the canonical path and local references", () => {
    if (process.platform === "win32") return;
    const profileRoot = workspace();
    const outside = workspace();
    writeProfile(outside, canonical());
    fs.mkdirSync(path.join(profileRoot, ".tachyon", "agents"), { recursive: true });
    fs.symlinkSync(path.join(outside, ".tachyon", "agents", "codex"), path.join(profileRoot, ".tachyon", "agents", "codex"), "dir");
    const unsafeProfile = resolve(profileRoot);
    expect(unsafeProfile).toMatchObject({ ok: false, errors: [{ code: "profile/unsafe-path" }] });

    const referenceRoot = workspace();
    const target = path.join(profileDir(referenceRoot), "target.md");
    fs.writeFileSync(target, "target");
    fs.symlinkSync(target, path.join(profileDir(referenceRoot), "instructions.md"));
    writeProfile(referenceRoot, canonical({
      prompt: { instructions: "instructions" },
      references: [{
        id: "instructions",
        kind: "instructions",
        scope: "profile",
        owner: AGENT_ID,
        path: "instructions.md",
        mode: "pinned",
        sha256: digest("target"),
      }],
    }));
    const unsafeReference = resolve(referenceRoot);
    expect(unsafeReference).toMatchObject({ ok: false, errors: [{ code: "profile/unsafe-path", field: "references.instructions" }] });
  });

  it("does not cache reloads and changes both source and effective digests after an edit", () => {
    const root = workspace();
    writeProfile(root, canonical({ displayName: "First" }));
    const first = expectSuccess(resolve(root));

    writeProfile(root, canonical({ displayName: "Second" }));
    const second = expectSuccess(resolve(root));

    expect(second.displayName).toBe("Second");
    expect(second.sourceSha256).not.toBe(first.sourceSha256);
    expect(second.effectiveSha256).not.toBe(first.effectiveSha256);
  });

  it("rejects a profile changed while its validated descriptor is being read", () => {
    const root = workspace();
    const file = writeProfile(root, canonical());
    const authority = { revision: "test-profile-r1", canonical: { state: "present" as const, sha256: digest(fs.readFileSync(file)) }, runtimeInspector: INSPECTOR };
    const originalRead = fs.readSync;
    let changed = false;
    const read = vi.spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const count = originalRead(...args);
      if (!changed && count > 0) {
        changed = true;
        fs.appendFileSync(file, "# changed during read\n");
      }
      return count;
    }) as typeof fs.readSync);
    try {
      const result = resolve(root, { authority });
      expect(result).toMatchObject({ ok: false, errors: [{ code: "profile/changed-during-read" }] });
    } finally {
      read.mockRestore();
    }
  });

  it("keeps local references under the retained profile directory when the pathname is replaced", () => {
    const root = workspace();
    const directory = profileDir(root);
    const original = "trusted original";
    fs.writeFileSync(path.join(directory, "instructions.md"), original);
    writeProfile(root, canonical({
      prompt: { instructions: "instructions" },
      references: [{
        id: "instructions",
        kind: "instructions",
        scope: "profile",
        owner: AGENT_ID,
        path: "instructions.md",
        mode: "pinned",
        sha256: digest(original),
      }],
    }));
    const authority = {
      revision: "test-profile-r1",
      canonical: { state: "present" as const, sha256: digest(fs.readFileSync(path.join(directory, "agent.yml"))) },
      runtimeInspector: INSPECTOR,
    };
    const moved = `${directory}-moved`;
    const originalRead = fs.readSync;
    let replaced = false;
    const read = vi.spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const count = originalRead(...args);
      if (!replaced && count > 0) {
        replaced = true;
        fs.renameSync(directory, moved);
        fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, "instructions.md"), "attacker replacement");
      }
      return count;
    }) as typeof fs.readSync);
    try {
      const value = expectSuccess(resolve(root, { authority }));
      expect(value.references[0]!.resolvedSha256).toBe(digest(original));
      expect("bytes" in value.references[0]!).toBe(false);
    } finally {
      read.mockRestore();
    }
  });

  it("does not depend on localeCompare for public ordering or digests", () => {
    const root = workspace();
    writeProfile(root, canonical({ environment: { values: { ZETA: "z", ALPHA: "a" } } }));
    const locale = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("localeCompare must not contribute to resolution");
    });
    try {
      expectSuccess(resolve(root));
    } finally {
      locale.mockRestore();
    }
  });
});
