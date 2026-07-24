import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadProfileAwareConfig,
  type LoadProfileAwareConfigInput,
} from "../../src/config/agentProfileConfigLoader.js";
import {
  CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR,
  CODEX_EMPTY_NATIVE_INPUT_INSPECTOR,
  GROK_PRIVATE_HOME_INPUT_INSPECTOR,
  PI_PRIVATE_CAPABILITY_INPUT_INSPECTOR,
} from "../../src/config/agentProfileProjection.js";
import { agentProfileSchemaV1 } from "../../src/config/agentProfileSchema.js";
import type { AgentProfileAuthorityRecord } from "../../src/config/agentProfileAuthority.js";
import { scanAgentProfilePointers } from "../../src/config/agentProfilePointer.js";
import { digestCapturedCapability, type CapturedCapabilityEntry } from "../../src/config/agentCapabilitySource.js";

const roots: string[] = [];
const AGENT_ID = "11111111-1111-4111-8111-111111111111";

function temporaryRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), label));
  roots.push(root);
  return root;
}

function sha256(bytes: string | Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function treeSha256(root: string): string {
  const entries: CapturedCapabilityEntry[] = [];
  const visit = (current: string, relative: string): void => {
    const stat = fs.lstatSync(current);
    entries.push({ path: relative || ".", type: stat.isDirectory() ? "directory" : "file", mode: stat.mode & 0o777, ...(stat.isFile() ? { bytes: fs.readFileSync(current) } : {}) });
    if (stat.isDirectory()) for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name), relative ? `${relative}/${name}` : name);
  };
  visit(root, "");
  return digestCapturedCapability("tree", entries);
}

function writeProfile(root: string, overrides: Record<string, unknown> = {}): Buffer {
  const directory = path.join(root, ".tachyon", "agents", "codex");
  fs.mkdirSync(directory, { recursive: true });
  const bytes = Buffer.from(stringify({
    schemaVersion: 1,
    agentId: AGENT_ID,
    runtime: { adapter: "codex", executable: "codex" },
    ...overrides,
  }));
  fs.writeFileSync(path.join(directory, "agent.yml"), bytes);
  return bytes;
}

function authority(bytes: Buffer, overrides: Partial<AgentProfileAuthorityRecord> = {}): AgentProfileAuthorityRecord {
  return {
    schemaVersion: 1,
    agentName: "codex",
    agentId: AGENT_ID,
    revision: "profile-r1",
    canonicalSha256: sha256(bytes),
    runtimeInspector: { ...CODEX_EMPTY_NATIVE_INPUT_INSPECTOR },
    ...overrides,
  };
}

function load(root: string, record: AgentProfileAuthorityRecord, extra: Partial<LoadProfileAwareConfigInput> = {}) {
  const homeDir = temporaryRoot("tachyon-agent-profile-home-");
  return loadProfileAwareConfig({
    yamlText: "agents:\n  codex:\n    profile: .tachyon/agents/codex/agent.yml\n",
    workspaceRoot: root,
    authorities: new Map([["codex", record]]),
    homeDir,
    ...extra,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("agent profile pointer syntax", () => {
  it("accepts only the exact conventional pointer", () => {
    const valid = scanAgentProfilePointers("agents:\n  codex:\n    profile: .tachyon/agents/codex/agent.yml\n");
    expect(valid.errors).toEqual([]);
    expect(valid.pointers.get("codex")?.path).toBe(".tachyon/agents/codex/agent.yml");

    const mixed = scanAgentProfilePointers("agents:\n  codex:\n    profile: .tachyon/agents/codex/agent.yml\n    cmd: codex\n");
    expect(mixed.errors).toContain("agents.codex: profile pointer cannot coexist with inline field(s): cmd");

    const arbitrary = scanAgentProfilePointers("agents:\n  codex:\n    profile: profiles/codex.yml\n");
    expect(arbitrary.errors[0]).toContain("expected \".tachyon/agents/codex/agent.yml\"");
  });
});

describe("loadProfileAwareConfig", () => {
  it("accepts the closed native configuration policy shape and rejects duplicate lifecycle phases", () => {
    const profile = {
      schemaVersion: 1,
      agentId: AGENT_ID,
      runtime: { adapter: "codex", executable: "codex" },
      nativeConfig: {
        permissions: {
          source: "workspace",
          treatment: "overlay",
          refresh: "every-launch",
          lifecycle: ["fresh", "resume"],
        },
      },
    };
    expect(agentProfileSchemaV1.safeParse(profile).success).toBe(true);
    expect(agentProfileSchemaV1.safeParse({
      ...profile,
      nativeConfig: {
        permissions: {
          ...profile.nativeConfig.permissions,
          lifecycle: ["fresh", "fresh"],
        },
      },
    }).success).toBe(false);
    expect(agentProfileSchemaV1.safeParse({
      ...profile,
      nativeConfig: { unsupportedFamily: profile.nativeConfig.permissions },
    }).success).toBe(false);
  });

  it("fails closed when a profile authors policy before its adapter declares support", () => {
    const root = temporaryRoot("tachyon-agent-profile-native-policy-");
    const bytes = writeProfile(root, {
      nativeConfig: {
        permissions: {
          source: "workspace",
          treatment: "overlay",
          refresh: "every-launch",
          lifecycle: ["fresh", "resume"],
        },
      },
    });
    const result = load(root, authority(bytes));

    expect(result.config).toBeUndefined();
    expect(result.errors[0]).toContain("has not declared native configuration support for 'permissions'");
  });

  it("projects typed Codex selectors only under the exact agent-owned policy", () => {
    const root = temporaryRoot("tachyon-agent-profile-codex-selectors-");
    const bytes = writeProfile(root, {
      runtime: {
        adapter: "codex",
        executable: "codex",
        model: "gpt-5.6",
        provider: "openai",
        reasoningEffort: "high",
        serviceTier: "fast",
      },
      nativeConfig: {
        selectors: {
          source: "agent",
          treatment: "overlay",
          refresh: "every-launch",
          lifecycle: ["fresh", "restart", "resume"],
        },
      },
    });
    const result = load(root, authority(bytes));

    expect(result.errors).toEqual([]);
    expect(result.config?.agents.codex.profileNativeConfig).toEqual({
      adapter: "codex",
      selectors: {
        model: "gpt-5.6",
        provider: "openai",
        reasoningEffort: "high",
        serviceTier: "fast",
      },
    });
  });

  it("projects only approved Codex scalar values from the selected global source", () => {
    const root = temporaryRoot("tachyon-agent-profile-codex-scalars-");
    const homeDir = temporaryRoot("tachyon-agent-profile-codex-global-");
    fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".codex", "config.toml"), [
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      'model_provider = "must-not-project"',
      '[tui]',
      'status_line = ["model", "git-branch"]',
      'status_line_use_colors = false',
      '[features]',
      'terminal_resize_reflow = true',
      'memories = true',
    ].join("\n"));
    const scalarPolicy = {
      source: "global",
      treatment: "overlay",
      refresh: "every-launch",
      lifecycle: ["fresh", "restart", "resume"],
    };
    const bytes = writeProfile(root, {
      nativeConfig: {
        permissions: scalarPolicy,
        interface: scalarPolicy,
        featureFlags: scalarPolicy,
      },
    });

    const result = load(root, authority(bytes), { homeDir });

    expect(result.errors).toEqual([]);
    expect(result.config?.agents.codex.profileNativeConfig).toEqual({
      adapter: "codex",
      selectors: {},
      permissions: { approvalPolicy: "on-request", sandboxMode: "workspace-write" },
      interface: {
        statusLine: ["model", "git-branch"],
        statusLineUseColors: false,
      },
      featureFlags: { terminalResizeReflow: true },
    });
    expect(JSON.stringify(result.config?.agents.codex.profileNativeConfig)).not.toContain("must-not-project");
    expect(JSON.stringify(result.config?.agents.codex.profileNativeConfig)).not.toContain("memories");
  });

  it("fails closed when selected workspace config contains an ambient unapproved key", () => {
    const root = temporaryRoot("tachyon-agent-profile-codex-workspace-scalars-");
    fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codex", "config.toml"), [
      'approval_policy = "never"',
      'model = "ambient-model"',
    ].join("\n"));
    const bytes = writeProfile(root, {
      nativeConfig: {
        permissions: {
          source: "workspace",
          treatment: "overlay",
          refresh: "every-launch",
          lifecycle: ["fresh", "restart", "resume"],
        },
      },
    });

    const result = load(root, authority(bytes));

    expect(result.config).toBeUndefined();
    expect(result.errors).toContain(
      "agents.codex.profile: profile/native-config-key: source 'workspace' key 'model' is outside the selected family allowlist",
    );
  });

  it("rejects typed Codex selectors without their explicit native policy", () => {
    const root = temporaryRoot("tachyon-agent-profile-codex-selector-no-policy-");
    const bytes = writeProfile(root, {
      runtime: { adapter: "codex", executable: "codex", model: "gpt-5.6" },
    });
    const result = load(root, authority(bytes));

    expect(result.config).toBeUndefined();
    expect(result.errors.join("\n")).toContain("runtime selector migration requires a later measured projector");
  });

  it("projects a literal Claude profile through its closed private-home contract", () => {
    const root = temporaryRoot("tachyon-agent-profile-claude-");
    const bytes = writeProfile(root, { runtime: { adapter: "claude", executable: "claude" } });
    const result = load(root, authority(bytes, {
      runtimeInspector: { ...CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR },
    }));

    expect(result.errors).toEqual([]);
    expect(result.config?.agents.codex).toMatchObject({
      cmd: "claude",
      profileLifecycle: { agentId: AGENT_ID, authorityRevision: "profile-r1" },
    });
  });

  it("rejects a Claude profile when authority selects another runtime inspector", () => {
    const root = temporaryRoot("tachyon-agent-profile-claude-wrong-inspector-");
    const bytes = writeProfile(root, { runtime: { adapter: "claude", executable: "claude" } });
    const result = load(root, authority(bytes));

    expect(result.config).toBeUndefined();
    expect(result.errors.join("\n")).toContain("does not select the registered claude inspector");
  });

  it("rejects ambient Claude prompt roots that cannot be disabled without breaking OAuth and hooks", () => {
    const root = temporaryRoot("tachyon-agent-profile-claude-ambient-");
    const bytes = writeProfile(root, { runtime: { adapter: "claude", executable: "claude" } });
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "ambient prompt");
    const result = load(root, authority(bytes, {
      runtimeInspector: { ...CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR },
    }));

    expect(result.config).toBeUndefined();
    expect(result.errors.join("\n")).toContain("ambient Claude input must be absent: CLAUDE.md");
  });

  it("projects a literal Grok profile through its Tachyon-owned private home contract", () => {
    const root = temporaryRoot("tachyon-agent-profile-grok-");
    const directory = path.join(root, ".tachyon", "agents", "grok-x");
    fs.mkdirSync(directory, { recursive: true });
    const bytes = Buffer.from(stringify({
      schemaVersion: 1,
      agentId: AGENT_ID,
      runtime: { adapter: "grok", executable: "grok" },
      workspace: { cwd: "/workspaces/external" },
    }));
    fs.writeFileSync(path.join(directory, "agent.yml"), bytes);
    const record: AgentProfileAuthorityRecord = {
      schemaVersion: 1,
      agentName: "grok-x",
      agentId: AGENT_ID,
      revision: "profile-r1",
      canonicalSha256: sha256(bytes),
      runtimeInspector: { ...GROK_PRIVATE_HOME_INPUT_INSPECTOR },
    };
    const result = loadProfileAwareConfig({
      yamlText: "agents:\n  grok-x:\n    profile: .tachyon/agents/grok-x/agent.yml\n",
      workspaceRoot: root,
      authorities: new Map([["grok-x", record]]),
    });

    expect(result.errors).toEqual([]);
    expect(result.config?.agents["grok-x"]).toMatchObject({
      cmd: "grok",
      cwd: "/workspaces/external",
      profileLifecycle: { agentId: AGENT_ID, authorityRevision: "profile-r1" },
    });
    expect(result.config?.agentSources["grok-x"].mode).toBe("profile");
  });

  it("rejects a Grok profile when authority selects another runtime inspector", () => {
    const root = temporaryRoot("tachyon-agent-profile-grok-wrong-inspector-");
    const directory = path.join(root, ".tachyon", "agents", "grok");
    fs.mkdirSync(directory, { recursive: true });
    const bytes = Buffer.from(stringify({
      schemaVersion: 1,
      agentId: AGENT_ID,
      runtime: { adapter: "grok", executable: "grok" },
    }));
    fs.writeFileSync(path.join(directory, "agent.yml"), bytes);
    const result = loadProfileAwareConfig({
      yamlText: "agents:\n  grok:\n    profile: .tachyon/agents/grok/agent.yml\n",
      workspaceRoot: root,
      authorities: new Map([["grok", {
        schemaVersion: 1 as const,
        agentName: "grok",
        agentId: AGENT_ID,
        revision: "profile-r1",
        canonicalSha256: sha256(bytes),
        runtimeInspector: { ...CODEX_EMPTY_NATIVE_INPUT_INSPECTOR },
      }]]),
    });

    expect(result.errors.join("\n")).toContain("host authority does not select the registered grok inspector");
  });

  it("attaches a captured project-owned skill only after legacy YAML parsing", () => {
    const root = temporaryRoot("tachyon-agent-profile-workspace-");
    const skill = path.join(root, "shared", "skills", "research");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: research\ndescription: research\n---\nShared bytes.\n");
    const skillDigest = treeSha256(skill);
    const bytes = writeProfile(root, {
      capabilities: { skills: ["shared-research"] },
      references: [{ id: "shared-research", kind: "skill", scope: "project", owner: "workspace", path: "shared/skills/research", mode: "pinned", sha256: skillDigest }],
    });
    const result = load(root, authority(bytes));

    expect(result.errors).toEqual([]);
    expect(result.config?.agents.codex.profileCapabilities).toMatchObject({
      adapter: "codex",
      effectiveProfileSha256: result.config?.agentSources.codex.mode === "profile" ? result.config.agentSources.codex.effectiveSha256 : undefined,
      sources: [{ referenceId: "shared-research", scope: "project", owner: "workspace", sha256: skillDigest }],
      skills: [{ name: "research" }],
    });

    const authored = loadProfileAwareConfig({
      yamlText: "agents:\n  codex:\n    cmd: codex\n    profileCapabilities: {}\n",
      workspaceRoot: temporaryRoot("tachyon-profile-authored-internal-"),
      authorities: new Map(),
    });
    expect(authored.errors.join("\n")).toContain("unknown key 'profileCapabilities'");
  });

  it("projects an authority-granted local MCP declaration without exposing an authorable harness field", () => {
    const root = temporaryRoot("tachyon-agent-profile-workspace-");
    const capabilityDir = path.join(root, ".tachyon", "agents", "codex", "capabilities");
    fs.mkdirSync(capabilityDir, { recursive: true });
    const mcp = "schemaVersion: 1\nname: docs\ncommand: node\nargs: [docs.js]\nenv:\n  DOCS_TOKEN: ${DOCS_TOKEN}\n";
    fs.writeFileSync(path.join(capabilityDir, "docs-mcp.yml"), mcp);
    const bytes = writeProfile(root, {
      capabilities: { mcp: ["docs-mcp"] },
      references: [{ id: "docs-mcp", kind: "mcp", scope: "profile", owner: AGENT_ID, path: "capabilities/docs-mcp.yml", mode: "pinned", sha256: sha256(mcp) }],
    });
    const result = load(root, authority(bytes, { capabilityGrants: [{ referenceId: "docs-mcp", sourceSha256: sha256(mcp), adapter: "codex", kind: "mcp" }] }));

    expect(result.errors).toEqual([]);
    expect(result.config?.agents.codex.harness).toBeUndefined();
    expect(result.config?.agents.codex.profileCapabilities?.mcp.docs).toEqual({ command: "node", args: ["docs.js"], env: { DOCS_TOKEN: "${DOCS_TOKEN}" } });
  });

  it("activates the measured Pi profile resource projection and rejects no ambient resource inheritance", () => {
    const root = temporaryRoot("tachyon-agent-profile-pi-");
    const directory = path.join(root, ".tachyon", "agents", "pi-a");
    fs.mkdirSync(path.join(directory, "capabilities"), { recursive: true });
    const prompt = "Review the exact diff.\n";
    const extension = "export default function register() {}\n";
    fs.writeFileSync(path.join(directory, "capabilities", "review.md"), prompt);
    fs.writeFileSync(path.join(directory, "capabilities", "guard.ts"), extension);
    const bytes = Buffer.from(stringify({
      schemaVersion: 1,
      agentId: AGENT_ID,
      runtime: { adapter: "pi", executable: "pi" },
      capabilities: { pi: { prompts: ["review-prompt"], extensions: ["guard-extension"] } },
      references: [
        { id: "review-prompt", kind: "pi-prompt", scope: "profile", owner: AGENT_ID, path: "capabilities/review.md", mode: "pinned", sha256: sha256(prompt) },
        { id: "guard-extension", kind: "pi-extension", scope: "profile", owner: AGENT_ID, path: "capabilities/guard.ts", mode: "pinned", sha256: sha256(extension) },
      ],
    }));
    fs.writeFileSync(path.join(directory, "agent.yml"), bytes);
    const result = loadProfileAwareConfig({
      yamlText: "agents:\n  pi-a:\n    profile: .tachyon/agents/pi-a/agent.yml\n",
      workspaceRoot: root,
      authorities: new Map([["pi-a", {
        schemaVersion: 1 as const,
        agentName: "pi-a",
        agentId: AGENT_ID,
        revision: "profile-r1",
        canonicalSha256: sha256(bytes),
        runtimeInspector: { ...PI_PRIVATE_CAPABILITY_INPUT_INSPECTOR },
        capabilityGrants: [{ referenceId: "guard-extension", sourceSha256: sha256(extension), adapter: "pi" as const, kind: "pi-extension" as const }],
      }]]),
    });

    expect(result.errors).toEqual([]);
    expect(result.config?.agents["pi-a"]).toMatchObject({
      cmd: "pi",
      profileCapabilities: { adapter: "pi", pi: { prompts: [{ name: "review.md" }], extensions: [{ name: "guard.ts" }] } },
    });
  });

  it("rejects Pi package resources that collide with an explicit runtime resource", () => {
    const root = temporaryRoot("tachyon-agent-profile-pi-collision-");
    const directory = path.join(root, ".tachyon", "agents", "pi-collision");
    const packageRoot = path.join(directory, "capabilities", "review-package");
    fs.mkdirSync(path.join(packageRoot, "prompts"), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "prompts", "review.md"), "package prompt\n");
    fs.writeFileSync(path.join(directory, "capabilities", "review.md"), "explicit prompt\n");
    const packageDigest = treeSha256(packageRoot);
    const profile = Buffer.from(stringify({
      schemaVersion: 1,
      agentId: AGENT_ID,
      runtime: { adapter: "pi", executable: "pi" },
      capabilities: { pi: { prompts: ["explicit-prompt"], packages: ["review-package"] } },
      references: [
        { id: "explicit-prompt", kind: "pi-prompt", scope: "profile", owner: AGENT_ID, path: "capabilities/review.md", mode: "pinned", sha256: sha256("explicit prompt\n") },
        { id: "review-package", kind: "pi-package", scope: "profile", owner: AGENT_ID, path: "capabilities/review-package", mode: "pinned", sha256: packageDigest },
      ],
    }));
    fs.writeFileSync(path.join(directory, "agent.yml"), profile);
    const result = loadProfileAwareConfig({
      yamlText: "agents:\n  pi-collision:\n    profile: .tachyon/agents/pi-collision/agent.yml\n",
      workspaceRoot: root,
      authorities: new Map([["pi-collision", {
        schemaVersion: 1 as const,
        agentName: "pi-collision",
        agentId: AGENT_ID,
        revision: "profile-r1",
        canonicalSha256: sha256(profile),
        runtimeInspector: { ...PI_PRIVATE_CAPABILITY_INPUT_INSPECTOR },
        capabilityGrants: [{ referenceId: "review-package", sourceSha256: packageDigest, adapter: "pi" as const, kind: "pi-package" as const }],
      }]]),
    });

    expect(result.errors.some((error) => error.includes("profile/capability-collision") && error.includes("review.md"))).toBe(true);
  });
  it("loads a profile and retains its trusted source metadata beside legacy agents", () => {
    const root = temporaryRoot("tachyon-agent-profile-workspace-");
    const bytes = writeProfile(root, {
      prompt: { role: "reviewer" },
      lifecycle: { enabled: false, autostart: true, restart: "on-crash" },
    });
    const result = load(root, authority(bytes), {
      yamlText: [
        "agents:",
        "  codex:",
        "    profile: .tachyon/agents/codex/agent.yml",
        "  helper:",
        "    cmd: claude",
        "",
      ].join("\n"),
    });

    expect(result.errors).toEqual([]);
    expect(result.config?.agents.codex).toMatchObject({
      cmd: "codex",
      role: "reviewer",
      autostart: true,
      restart: "on-crash",
      profileLifecycle: {
        enabled: false,
        agentId: AGENT_ID,
        canonicalSha256: sha256(bytes),
        authorityRevision: "profile-r1",
      },
    });
    expect(result.config?.agentSources.codex).toMatchObject({
      mode: "profile",
      agentId: AGENT_ID,
      profileSha256: sha256(bytes),
      authorityRevision: "profile-r1",
    });
    expect(result.config?.agentSources.helper?.mode).toBe("legacy");

    const authored = loadProfileAwareConfig({
      yamlText: "agents:\n  codex:\n    cmd: codex\n    profileLifecycle:\n      enabled: false\n",
      workspaceRoot: temporaryRoot("tachyon-profile-authored-lifecycle-"),
      authorities: new Map(),
    });
    expect(authored.errors.join("\n")).toContain("unknown key 'profileLifecycle'");
  });

  it("fails closed when authority is absent, stale, or an effective native config is non-empty", () => {
    const root = temporaryRoot("tachyon-agent-profile-workspace-");
    const bytes = writeProfile(root);
    const record = authority(bytes);

    const missing = loadProfileAwareConfig({
      yamlText: "agents:\n  codex:\n    profile: .tachyon/agents/codex/agent.yml\n",
      workspaceRoot: root,
      authorities: new Map(),
      homeDir: temporaryRoot("tachyon-agent-profile-home-"),
    });
    expect(missing.errors).toContain("agents.codex.profile: host profile authority is missing");

    const stale = load(root, { ...record, canonicalSha256: "f".repeat(64) });
    expect(stale.errors.join("\n")).toContain("profile/authority-boundary");

    const homeDir = temporaryRoot("tachyon-agent-profile-home-");
    fs.mkdirSync(path.join(homeDir, ".codex"));
    fs.writeFileSync(path.join(homeDir, ".codex", "config.toml"), "model = 'configured'\n");
    const native = load(root, record, { homeDir });
    expect(native.errors).toEqual([]);

    fs.mkdirSync(path.join(root, ".codex"));
    fs.writeFileSync(path.join(root, ".codex", "config.toml"), "model = 'workspace-configured'\n");
    const workspaceNative = load(root, record, { homeDir });
    expect(workspaceNative.errors.join("\n")).toContain("non-empty native config is not supported");

    const emptyCapabilitiesRoot = temporaryRoot("tachyon-agent-profile-empty-capabilities-");
    const emptyBytes = writeProfile(emptyCapabilitiesRoot, { capabilities: {} });
    const privateHome = temporaryRoot("tachyon-agent-profile-empty-capabilities-home-");
    fs.mkdirSync(path.join(emptyCapabilitiesRoot, ".tachyon", "harness", "codex"), { recursive: true });
    fs.writeFileSync(path.join(emptyCapabilitiesRoot, ".tachyon", "harness", "codex", "config.toml"), "model = 'unmeasured'\n");
    const emptyCapabilities = load(emptyCapabilitiesRoot, authority(emptyBytes), { homeDir: privateHome });
    expect(emptyCapabilities.errors).toEqual([]);
  });

  it("rejects simultaneous inline and canonical owners", () => {
    const root = temporaryRoot("tachyon-agent-profile-workspace-");
    writeProfile(root);
    const result = loadProfileAwareConfig({
      yamlText: "agents:\n  codex:\n    cmd: codex\n",
      workspaceRoot: root,
      authorities: new Map(),
      homeDir: temporaryRoot("tachyon-agent-profile-home-"),
    });
    expect(result.errors.join("\n")).toContain("inline configuration conflicts with canonical profile");
  });
});
