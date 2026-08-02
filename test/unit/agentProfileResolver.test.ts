import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asAgent, parseConfig, type AgentEntry } from "../../src/config/loadConfig.js";
import {
  agentProfileRuntimeSelectorsSha256,
  resolveAgentProfile,
  type NativeRuntimeAttestation,
  type NormalizedAgentDefinition,
  type ResolveAgentProfileInput,
  type ResolveAgentProfileResult,
} from "../../src/config/agentProfileResolver.js";
import { digestCapturedCapability, type CapturedCapabilityEntry } from "../../src/config/agentCapabilitySource.js";

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

function treeDigest(root: string): string {
  const entries: CapturedCapabilityEntry[] = [];
  const visit = (current: string, relative: string): void => {
    const stat = fs.lstatSync(current);
    entries.push({ path: relative || ".", type: stat.isDirectory() ? "directory" : "file", mode: stat.mode & 0o777, ...(stat.isFile() ? { bytes: fs.readFileSync(current) } : {}) });
    if (stat.isDirectory()) for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name), relative ? `${relative}/${name}` : name);
  };
  visit(root, "");
  return digestCapturedCapability("tree", entries);
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

function legacyAgent(name = "codex", extra = ""): AgentEntry {
  const parsed = parseConfig(`agents:\n  ${name}:\n    cmd: codex --model gpt-5.6-sol\n${extra}`);
  expect(parsed.errors).toEqual([]);
  const agent = asAgent(parsed.config!.agents[name]);
  expect(agent, `${name} must parse as an agent`).toBeDefined();
  return agent!;
}

function legacySource(definition: AgentEntry, source?: string): NonNullable<ResolveAgentProfileInput["legacy"]> {
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
  it("resolves an exact captured local skill tree into the effective capability digest", () => {
    const root = workspace();
    const skill = path.join(profileDir(root), "capabilities", "research");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: research\ndescription: research\n---\nUse evidence.\n");
    const skillSha = treeDigest(skill);
    writeProfile(root, canonical({
      capabilities: { skills: ["research-skill"] },
      references: [{ id: "research-skill", kind: "skill", scope: "profile", owner: AGENT_ID, path: "capabilities/research", mode: "pinned", sha256: skillSha }],
    }));

    const value = expectSuccess(resolve(root));
    expect(value.capabilityProjection).toMatchObject({
      adapter: "codex",
      sources: [{ referenceId: "research-skill", scope: "profile", sha256: skillSha }],
      skills: [{ name: "research", source: { type: "tree", sha256: skillSha } }],
    });
    expect(value.capabilityProjection?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(value.effectiveSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("requires an exact host grant for MCP and hook payloads", () => {
    const root = workspace();
    const directory = path.join(profileDir(root), "capabilities");
    fs.mkdirSync(directory, { recursive: true });
    const mcp = "schemaVersion: 1\nname: docs\ncommand: node\nargs: [server.js]\nenv:\n  DOCS_TOKEN: ${DOCS_TOKEN}\n";
    const hook = "schemaVersion: 1\nclass: enforcement\nhooks:\n  PreToolUse:\n    - hooks:\n        - type: command\n          command: node guard.js\n";
    fs.writeFileSync(path.join(directory, "mcp.yml"), mcp);
    fs.writeFileSync(path.join(directory, "hook.yml"), hook);
    writeProfile(root, canonical({
      capabilities: { mcp: ["docs-mcp"], hooks: ["guard-hook"] },
      references: [
        { id: "docs-mcp", kind: "mcp", scope: "profile", owner: AGENT_ID, path: "capabilities/mcp.yml", mode: "pinned", sha256: digest(mcp) },
        { id: "guard-hook", kind: "hook", scope: "profile", owner: AGENT_ID, path: "capabilities/hook.yml", mode: "pinned", sha256: digest(hook) },
      ],
    }));
    const profilePath = path.join(root, ".tachyon", "agents", "codex", "agent.yml");
    const baseAuthority = { revision: "test-profile-r1", canonical: { state: "present" as const, sha256: digest(fs.readFileSync(profilePath)) }, runtimeInspector: INSPECTOR };
    // t-dfc4de — missing grants withhold those capabilities; the agent still resolves.
    const denied = expectSuccess(resolve(root, { authority: baseAuthority }));
    expect(denied.capabilityProjection).toBeUndefined();
    expect(denied.withheldCapabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ referenceId: "docs-mcp", code: "profile/capability-authority" }),
      expect.objectContaining({ referenceId: "guard-hook", code: "profile/capability-authority" }),
    ]));
    expect(denied.withheldCapabilities).toHaveLength(2);

    const value = expectSuccess(resolve(root, { authority: { ...baseAuthority, capabilityGrants: [
      { referenceId: "docs-mcp", sourceSha256: digest(mcp), adapter: "codex", kind: "mcp" },
      { referenceId: "guard-hook", sourceSha256: digest(hook), adapter: "codex", kind: "hook", hookClass: "enforcement" },
    ] } }));
    expect(value.capabilityProjection?.mcp.docs).toEqual({ command: "node", args: ["server.js"], env: { DOCS_TOKEN: "${DOCS_TOKEN}" } });
    expect(value.capabilityProjection?.hooks.PreToolUse).toBeDefined();
    expect(JSON.stringify(value.capabilityProjection)).not.toContain("ambient-secret");
    expect(value.withheldCapabilities).toBeUndefined();

    const invalidHook = hook.replace("PreToolUse", "MadeUpEvent");
    fs.writeFileSync(path.join(directory, "hook.yml"), invalidHook);
    writeProfile(root, canonical({
      capabilities: { mcp: ["docs-mcp"], hooks: ["guard-hook"] },
      references: [
        { id: "docs-mcp", kind: "mcp", scope: "profile", owner: AGENT_ID, path: "capabilities/mcp.yml", mode: "pinned", sha256: digest(mcp) },
        { id: "guard-hook", kind: "hook", scope: "profile", owner: AGENT_ID, path: "capabilities/hook.yml", mode: "pinned", sha256: digest(invalidHook) },
      ],
    }));
    const invalidProfile = path.join(root, ".tachyon", "agents", "codex", "agent.yml");
    // t-dfc4de — a half-parsed hook costs the hook, not the agent; sibling MCP still delivers.
    const rejected = expectSuccess(resolve(root, { authority: {
      revision: "test-profile-r1",
      canonical: { state: "present", sha256: digest(fs.readFileSync(invalidProfile)) },
      runtimeInspector: INSPECTOR,
      capabilityGrants: [
        { referenceId: "docs-mcp", sourceSha256: digest(mcp), adapter: "codex", kind: "mcp" },
        { referenceId: "guard-hook", sourceSha256: digest(invalidHook), adapter: "codex", kind: "hook", hookClass: "enforcement" },
      ],
    } }));
    expect(rejected.capabilityProjection?.mcp.docs).toEqual({ command: "node", args: ["server.js"], env: { DOCS_TOKEN: "${DOCS_TOKEN}" } });
    expect(rejected.capabilityProjection?.hooks).toEqual({});
    expect(rejected.withheldCapabilities).toEqual([
      expect.objectContaining({
        referenceId: "guard-hook",
        code: "profile/capability",
        detail: expect.stringContaining("MadeUpEvent"),
      }),
    ]);
  });

  // t-b0cfd4 — the tree is still never captured; what changed is that refusing it no longer refuses
  // the agent around it. Withholding IS the protection here: unsafe bytes reach nothing, and the
  // profile that selected them still resolves, without that capability.
  it("withholds a capability tree containing a symlink, and never delivers its bytes", () => {
    const root = workspace();
    const skill = path.join(profileDir(root), "capabilities", "unsafe");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, "SKILL.md"), "body");
    fs.symlinkSync("SKILL.md", path.join(skill, "alias"));
    writeProfile(root, canonical({
      capabilities: { skills: ["unsafe-skill"] },
      references: [{ id: "unsafe-skill", kind: "skill", scope: "profile", owner: AGENT_ID, path: "capabilities/unsafe", mode: "pinned", sha256: "0".repeat(64) }],
    }));
    const result = resolve(root);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected the agent to resolve without the unsafe capability");
    expect(result.value.capabilityProjection).toBeUndefined();
    expect(result.value.references.some((reference) => reference.id === "unsafe-skill")).toBe(false);
    expect(result.value.withheldCapabilities).toMatchObject([{ referenceId: "unsafe-skill", code: "profile/unsafe-path" }]);
  });

  it("withholds BOTH claimants when destination names collide after normalization", () => {
    // t-dfc4de — picking the first as winner would hide the conflict. Both stay out until a human
    // renames or deselects so only one capability claims the delivered name.
    const root = workspace();
    const first = path.join(profileDir(root), "capabilities", "one", "Research");
    const second = path.join(profileDir(root), "capabilities", "two", "research");
    for (const directory of [first, second]) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "SKILL.md"), "skill\n");
    }
    writeProfile(root, canonical({
      capabilities: { skills: ["first-skill", "second-skill"] },
      references: [
        { id: "first-skill", kind: "skill", scope: "profile", owner: AGENT_ID, path: "capabilities/one/Research", mode: "pinned", sha256: treeDigest(first) },
        { id: "second-skill", kind: "skill", scope: "profile", owner: AGENT_ID, path: "capabilities/two/research", mode: "pinned", sha256: treeDigest(second) },
      ],
    }));
    const result = expectSuccess(resolve(root));
    expect(result.capabilityProjection).toBeUndefined();
    expect(result.definition.capabilities?.skills ?? []).toEqual([]);
    expect(result.withheldCapabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ referenceId: "first-skill", code: "profile/capability-collision" }),
      expect.objectContaining({ referenceId: "second-skill", code: "profile/capability-collision" }),
    ]));
    expect(result.withheldCapabilities).toHaveLength(2);
  });

  it("withholds a THIRD claimant of a name that already collided, instead of handing it the name", () => {
    // Releasing the key after the first collision would make the rule "the third one wins" — the same
    // silent winner, one claimant further along. A collided name stays unavailable for the whole resolve.
    const root = workspace();
    const directories = ["one/Research", "two/research", "three/RESEARCH"].map((rel) => {
      const directory = path.join(profileDir(root), "capabilities", ...rel.split("/"));
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "SKILL.md"), `skill ${rel}\n`);
      return { rel, directory };
    });
    writeProfile(root, canonical({
      capabilities: { skills: ["first-skill", "second-skill", "third-skill"] },
      references: directories.map(({ rel, directory }, index) => ({
        id: ["first-skill", "second-skill", "third-skill"][index]!,
        kind: "skill" as const,
        scope: "profile" as const,
        owner: AGENT_ID,
        path: `capabilities/${rel}`,
        mode: "pinned" as const,
        sha256: treeDigest(directory),
      })),
    }));

    const result = expectSuccess(resolve(root));
    expect(result.capabilityProjection).toBeUndefined();
    expect(result.definition.capabilities?.skills ?? []).toEqual([]);
    const withheld = result.withheldCapabilities ?? [];
    expect(withheld.map((entry) => entry.referenceId).sort())
      .toEqual(["first-skill", "second-skill", "third-skill"]);
    for (const entry of withheld) expect(entry.code).toBe("profile/capability-collision");
  });

  it("does not open an unselected capability reference", () => {
    const root = workspace();
    const outside = path.join(root, "outside-skill");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "SKILL.md"), "outside\n");
    fs.symlinkSync(outside, path.join(profileDir(root), "dormant-skill"));
    writeProfile(root, canonical({
      capabilities: {},
      references: [{ id: "dormant", kind: "skill", scope: "profile", owner: AGENT_ID, path: "dormant-skill", mode: "pinned", sha256: "0".repeat(64) }],
    }));

    const value = expectSuccess(resolve(root));
    expect(value.references).toEqual([]);
    expect(value.capabilityProjection).toBeUndefined();
  });
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

/**
 * t-dfc4de — resolveCapabilities per-capability refusals withhold; they do not refuse the agent.
 *
 * Fail-before on both sides: the field-reachable validation miss withholds one skill and leaves the
 * sibling; profile-identity failures still refuse the whole agent.
 */
describe("t-dfc4de — resolveCapabilities withholds one capability, not the agent", () => {
  it("withholds a skill tree that captured cleanly but has no root SKILL.md, and delivers its sibling", () => {
    // Field path: re-authorize a plugin tree that lost SKILL.md. Capture succeeds (bytes match pin);
    // validation used to mark the whole agent config-invalid with re-authorization as the cause.
    const root = workspace();
    const good = path.join(profileDir(root), "capabilities", "good");
    const broken = path.join(profileDir(root), "capabilities", "broken");
    fs.mkdirSync(good, { recursive: true });
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(good, "SKILL.md"), "# good\n");
    fs.writeFileSync(path.join(broken, "README.md"), "not a skill\n");
    const goodSha = treeDigest(good);
    const brokenSha = treeDigest(broken);
    writeProfile(root, canonical({
      capabilities: { skills: ["good-skill", "broken-skill"] },
      references: [
        { id: "good-skill", kind: "skill", scope: "profile", owner: AGENT_ID, path: "capabilities/good", mode: "pinned", sha256: goodSha },
        { id: "broken-skill", kind: "skill", scope: "profile", owner: AGENT_ID, path: "capabilities/broken", mode: "pinned", sha256: brokenSha },
      ],
    }));

    const value = expectSuccess(resolve(root));
    expect(value.capabilityProjection?.skills.map((skill) => skill.name)).toEqual(["good"]);
    expect(value.definition.capabilities?.skills).toEqual(["good-skill"]);
    expect(value.references.map((reference) => reference.id)).toEqual(["good-skill"]);
    expect(value.withheldCapabilities).toEqual([{
      referenceId: "broken-skill",
      name: "broken",
      kind: "skill",
      path: "capabilities/broken",
      code: "profile/capability",
      detail: expect.stringContaining("SKILL.md"),
    }]);
  });

  it("still refuses the whole agent when a non-capability reference fails — that defines the agent", () => {
    // Inverse of the withhold rule: instructions are part of what the agent IS, not one tool it has.
    const root = workspace();
    writeProfile(root, canonical({
      prompt: { instructions: "persistent-instructions" },
      references: [{
        id: "persistent-instructions",
        kind: "instructions",
        scope: "profile",
        owner: AGENT_ID,
        path: "instructions.md",
        mode: "pinned",
        sha256: digest("missing on purpose"),
      }],
    }));
    const result = resolve(root);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected whole-agent refusal for instructions");
    expect(result.errors.some((error) => error.field === "references.persistent-instructions")).toBe(true);
    expect(result.errors.every((error) => error.code !== "profile/capability")).toBe(true);
  });

  it("still refuses the whole agent when the profile head does not match host authority", () => {
    const root = workspace();
    writeProfile(root, canonical({}));
    const result = resolve(root, {
      authority: {
        revision: "test-profile-r1",
        canonical: { state: "present", sha256: "f".repeat(64) },
        runtimeInspector: INSPECTOR,
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected authority refusal");
    expect(result.errors.some((error) => error.code === "profile/authority-boundary")).toBe(true);
  });
});
