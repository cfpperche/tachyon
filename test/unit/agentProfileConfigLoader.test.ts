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
import { asAgent } from "../../src/config/loadConfig.js";

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

  it("t-984061: refuses the unimplemented runtime-managed memory policy while keeping the implemented ones", () => {
    const base = {
      schemaVersion: 1,
      agentId: AGENT_ID,
      runtime: { adapter: "codex", executable: "codex" },
    };
    const withPolicy = (policy: string, extra: Record<string, unknown> = {}) =>
      agentProfileSchemaV1.safeParse({ ...base, prompt: { memory: { policy, ...extra } } });

    // The two policies that have a real reader stay accepted — this must not over-reject.
    expect(withPolicy("disabled").success).toBe(true);
    expect(withPolicy("human-approved").success).toBe(true);

    // `runtime-managed` is specified by SDD 423 but nothing reads it: no code detects, enables or
    // disables runtime-native memory. Accepting it would present governance that does not exist.
    const refused = withPolicy("runtime-managed");
    expect(refused.success).toBe(false);
    if (refused.success) throw new Error("unreachable");
    const issue = refused.error.issues.find((candidate) => candidate.path.join(".") === "prompt.memory.policy");
    expect(issue?.message).toMatch(/not implemented/);

    // The refusal is about the policy itself, so it holds regardless of any accompanying reference.
    expect(withPolicy("runtime-managed", { reference: "selected-memory" }).success).toBe(false);
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
    expect(asAgent(result.config?.agents.codex)?.profileNativeConfig).toEqual({
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
    expect(asAgent(result.config?.agents.codex)?.profileNativeConfig).toEqual({
      adapter: "codex",
      selectors: {},
      permissions: { approvalPolicy: "on-request", sandboxMode: "workspace-write" },
      interface: {
        statusLine: ["model", "git-branch"],
        statusLineUseColors: false,
      },
      featureFlags: { terminalResizeReflow: true },
    });
    expect(JSON.stringify(asAgent(result.config?.agents.codex)?.profileNativeConfig)).not.toContain("must-not-project");
    expect(JSON.stringify(asAgent(result.config?.agents.codex)?.profileNativeConfig)).not.toContain("memories");
  });

  it("keeps an existing agent loadable while omitting newly gated dangerous global values", () => {
    const root = temporaryRoot("tachyon-agent-profile-codex-upgrade-");
    const homeDir = temporaryRoot("tachyon-agent-profile-codex-upgrade-global-");
    fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, ".codex", "config.toml"),
      'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n',
    );
    const bytes = writeProfile(root, {
      nativeConfig: {
        permissions: {
          source: "global",
          treatment: "overlay",
          refresh: "every-launch",
          lifecycle: ["fresh", "restart", "resume"],
        },
      },
    });

    const result = load(root, authority(bytes), { homeDir });

    expect(result.errors).toEqual([]);
    expect(result.config).toBeDefined();
    expect(asAgent(result.config?.agents.codex)?.profileNativeConfig?.permissions).toEqual({});
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.join("\n")).toContain("authorize it for this agent");
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

  it("projects only selected allowlisted Claude workspace settings", () => {
    const root = temporaryRoot("tachyon-agent-profile-claude-settings-");
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({
      permissions: { allow: ["Read"], deny: ["Bash(rm:*)"] },
      prefersReducedMotion: true,
      // t-af504e — a selected Interface family projects the status line from EITHER source, the
      // same posture the Codex projector takes with `tui.status_line`. Selecting `workspace` is
      // what authorizes project-owned config to supply it; it is never picked up unselected.
      statusLine: { type: "command", command: "workspace-status" },
      alwaysThinkingEnabled: false,
    }));
    fs.writeFileSync(path.join(root, ".claude", "settings.local.json"), JSON.stringify({
      permissions: { allow: ["Bash"] },
    }));
    const policy = {
      source: "workspace",
      treatment: "overlay",
      refresh: "every-launch",
      lifecycle: ["fresh", "restart", "resume", "fork"],
    };
    const bytes = writeProfile(root, {
      runtime: { adapter: "claude", executable: "claude" },
      nativeConfig: { permissions: policy, interface: policy, featureFlags: policy },
    });
    const result = load(root, authority(bytes, {
      runtimeInspector: { ...CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR },
    }));

    expect(result.errors).toEqual([]);
    expect(asAgent(result.config?.agents.codex)?.profileNativeConfig).toEqual({
      adapter: "claude",
      selectors: {},
      settings: {
        permissions: { allow: ["Read"], deny: ["Bash(rm:*)"] },
        prefersReducedMotion: true,
        statusLine: { type: "command", command: "workspace-status" },
        alwaysThinkingEnabled: false,
      },
    });
  });

  it("rejects unselected executable Claude settings instead of relocating them into the private home", () => {
    const root = temporaryRoot("tachyon-agent-profile-claude-settings-closed-");
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({
      permissions: { allow: ["Read"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "ambient" }] }] },
    }));
    const bytes = writeProfile(root, {
      runtime: { adapter: "claude", executable: "claude" },
      nativeConfig: {
        permissions: {
          source: "workspace",
          treatment: "overlay",
          refresh: "every-launch",
          lifecycle: ["fresh", "restart", "resume", "fork"],
        },
      },
    });
    const result = load(root, authority(bytes, {
      runtimeInspector: { ...CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR },
    }));

    expect(result.config).toBeUndefined();
    expect(result.errors.join("\n")).toContain("Claude workspace key 'hooks' is outside the selected family allowlist");
  });

  it("projects measured Claude selectors and global scalars through the private-home contract", () => {
    const root = temporaryRoot("tachyon-agent-profile-claude-global-");
    const homeDir = temporaryRoot("tachyon-agent-profile-claude-home-");
    fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".claude", "settings.json"), JSON.stringify({
      prefersReducedMotion: true,
      alwaysThinkingEnabled: false,
    }));
    const lifecycle = ["fresh", "restart", "resume", "fork"];
    const bytes = writeProfile(root, {
      runtime: {
        adapter: "claude",
        executable: "claude",
        model: "claude-opus-5",
        reasoningEffort: "xhigh",
      },
      nativeConfig: {
        selectors: { source: "agent", treatment: "overlay", refresh: "every-launch", lifecycle },
        interface: { source: "global", treatment: "overlay", refresh: "every-launch", lifecycle },
        featureFlags: { source: "global", treatment: "overlay", refresh: "every-launch", lifecycle },
      },
    });

    const result = load(root, authority(bytes, {
      runtimeInspector: { ...CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR },
    }), { homeDir });

    expect(result.errors).toEqual([]);
    expect(asAgent(result.config?.agents.codex)?.profileNativeConfig).toEqual({
      adapter: "claude",
      selectors: { model: "claude-opus-5", reasoningEffort: "xhigh" },
      settings: { prefersReducedMotion: true, alwaysThinkingEnabled: false },
    });
  });

  it("ignores unselected Claude global settings keys instead of blocking activation", () => {
    const root = temporaryRoot("tachyon-agent-profile-claude-global-extra-");
    const homeDir = temporaryRoot("tachyon-agent-profile-claude-home-extra-");
    fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
    // A real ~/.claude/settings.json carries personal keys the canonical profile never authors.
    fs.writeFileSync(path.join(homeDir, ".claude", "settings.json"), JSON.stringify({
      $schema: "https://json.schemastore.org/claude-code-settings.json",
      _comment: "personal",
      mcpServers: { local: { command: "x" } },
      statusLine: { type: "command", command: "personal-status" },
      tui: { theme: "dark" },
      skipDangerousModePermissionPrompt: true,
      switchModelsOnFlag: true,
      skipAutoPermissionPrompt: true,
      theme: "dark",
      alwaysThinkingEnabled: true,
    }));
    const lifecycle = ["fresh", "restart", "resume", "fork"];
    const bytes = writeProfile(root, {
      runtime: { adapter: "claude", executable: "claude" },
      nativeConfig: {
        interface: { source: "global", treatment: "overlay", refresh: "every-launch", lifecycle },
        featureFlags: { source: "global", treatment: "overlay", refresh: "every-launch", lifecycle },
      },
    });

    const result = load(root, authority(bytes, {
      runtimeInspector: { ...CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR },
    }), { homeDir });

    expect(result.errors).toEqual([]);
    // `statusLine` belongs to the selected Interface family (t-af504e), so it is projected here;
    // the rest of the personal file stays opaque and unauthored instead of blocking activation.
    expect(asAgent(result.config?.agents.codex)?.profileNativeConfig).toEqual({
      adapter: "claude",
      selectors: {},
      settings: {
        theme: "dark",
        statusLine: { type: "command", command: "personal-status" },
        alwaysThinkingEnabled: true,
      },
    });
  });

  it("t-af504e: projects the global status line so a private home does not silently drop it", () => {
    const root = temporaryRoot("tachyon-agent-profile-claude-statusline-");
    const homeDir = temporaryRoot("tachyon-agent-profile-claude-statusline-home-");
    fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".claude", "settings.json"), JSON.stringify({
      statusLine: { type: "command", command: "bash ~/.claude/statusline-command.sh", padding: 1 },
      theme: "dark",
    }));
    const lifecycle = ["fresh", "restart", "resume", "fork"];
    const bytes = writeProfile(root, {
      runtime: { adapter: "claude", executable: "claude" },
      nativeConfig: {
        interface: { source: "global", treatment: "overlay", refresh: "every-launch", lifecycle },
      },
    });

    const result = load(root, authority(bytes, {
      runtimeInspector: { ...CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR },
    }), { homeDir });

    expect(result.errors).toEqual([]);
    // Optional `padding` survives: the capture transport carries it through to the wrapper setting.
    expect(asAgent(result.config?.agents.codex)?.profileNativeConfig?.settings).toEqual({
      theme: "dark",
      statusLine: { type: "command", command: "bash ~/.claude/statusline-command.sh", padding: 1 },
    });
  });

  it("t-af504e: names the offending status line subkey instead of failing the whole agent", () => {
    const lifecycle = ["fresh", "restart", "resume", "fork"];
    const cases: Array<[string, unknown, string]> = [
      ["not-an-object", "bash x", "Claude global key 'statusLine' must be an object, got 'bash x'"],
      [
        "unknown-subkey",
        { type: "command", command: "x", theme: "dark" },
        "Claude global key 'statusLine.theme' is not a projectable status line field"
          + " (supported: type, command, padding)",
      ],
      [
        "wrong-type",
        { type: "static", command: "x" },
        "Claude global key 'statusLine.type' must be 'command', got 'static'",
      ],
      [
        "empty-command",
        { type: "command", command: "" },
        "Claude global key 'statusLine.command' must be a non-empty string, got ''",
      ],
      [
        "bad-padding",
        { type: "command", command: "x", padding: 99 },
        "Claude global key 'statusLine.padding' must be an integer between 0 and 10, got 99",
      ],
    ];

    for (const [label, statusLine, expected] of cases) {
      const root = temporaryRoot(`tachyon-agent-profile-claude-statusline-${label}-`);
      const homeDir = temporaryRoot(`tachyon-agent-profile-claude-statusline-${label}-home-`);
      fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(homeDir, ".claude", "settings.json"), JSON.stringify({ statusLine }));
      const bytes = writeProfile(root, {
        runtime: { adapter: "claude", executable: "claude" },
        nativeConfig: {
          interface: { source: "global", treatment: "overlay", refresh: "every-launch", lifecycle },
        },
      });

      const result = load(root, authority(bytes, {
        runtimeInspector: { ...CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR },
      }), { homeDir });

      expect(result.config, label).toBeUndefined();
      // Every refusal names the subkey and the way out, exactly like the permissions path (t-111190).
      expect(result.errors.join("\n"), label).toContain(expected);
      expect(result.errors.join("\n"), label).toContain("set the Interface family to Exclude");
    }
  });

  it("still rejects an invalid value on a selected Claude global family", () => {
    const root = temporaryRoot("tachyon-agent-profile-claude-global-invalid-");
    const homeDir = temporaryRoot("tachyon-agent-profile-claude-home-invalid-");
    fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".claude", "settings.json"), JSON.stringify({
      $schema: "https://json.schemastore.org/claude-code-settings.json",
      permissions: { defaultMode: "bypassPermissions" },
    }));
    const lifecycle = ["fresh", "restart", "resume", "fork"];
    const bytes = writeProfile(root, {
      runtime: { adapter: "claude", executable: "claude" },
      nativeConfig: {
        permissions: { source: "global", treatment: "overlay", refresh: "every-launch", lifecycle },
      },
    });

    const result = load(root, authority(bytes, {
      runtimeInspector: { ...CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR },
    }), { homeDir });

    expect(result.config).toBeUndefined();
    // The refusal names the offending subkey, the value, and the ways out (t-111190, SDD 471).
    expect(result.errors.join("\n")).toContain(
      "Claude global key 'permissions.defaultMode' value 'bypassPermissions' is not projectable"
      + " (supported: acceptEdits, auto, manual, dontAsk, plan)"
      + "; authorize it explicitly for this agent, set the Permissions family to Exclude,"
      + " or change the global value",
    );
    expect(result.errors.join("\n")).not.toContain("outside the selected family allowlist");
  });

  it("SDD 471: projects bypassPermissions only when the profile explicitly authorizes it", () => {
    const homeDir = temporaryRoot("tachyon-bypass-optin-home-");
    fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".claude", "settings.json"), JSON.stringify({
      $schema: "https://json.schemastore.org/claude-code-settings.json",
      permissions: { defaultMode: "bypassPermissions", allow: ["Read"] },
    }));
    const lifecycle = ["fresh", "restart", "resume", "fork"];
    const policy = { source: "global", treatment: "overlay", refresh: "every-launch", lifecycle };

    // Same global file, two agents: only the one that authorized it projects the value.
    const authorizedRoot = temporaryRoot("tachyon-bypass-optin-yes-");
    const authorizedBytes = writeProfile(authorizedRoot, {
      runtime: { adapter: "claude", executable: "claude" },
      nativeConfig: { permissions: { ...policy, authorize: ["bypassPermissions"] } },
    });
    const authorized = load(authorizedRoot, authority(authorizedBytes, {
      runtimeInspector: { ...CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR },
    }), { homeDir });

    expect(authorized.errors).toEqual([]);
    expect(asAgent(authorized.config?.agents.codex)?.profileNativeConfig).toEqual({
      adapter: "claude",
      selectors: {},
      settings: { permissions: { defaultMode: "bypassPermissions", allow: ["Read"] } },
    });

    const unauthorizedRoot = temporaryRoot("tachyon-bypass-optin-no-");
    const unauthorizedBytes = writeProfile(unauthorizedRoot, {
      runtime: { adapter: "claude", executable: "claude" },
      nativeConfig: { permissions: policy },
    });
    const unauthorized = load(unauthorizedRoot, authority(unauthorizedBytes, {
      runtimeInspector: { ...CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR },
    }), { homeDir });

    expect(unauthorized.config).toBeUndefined();
    expect(unauthorized.errors.join("\n")).toContain("'bypassPermissions' is not projectable");
  });

  it("SDD 471: an authorization never widens anything beyond the mode it names", () => {
    const root = temporaryRoot("tachyon-bypass-optin-scope-");
    const homeDir = temporaryRoot("tachyon-bypass-optin-scope-home-");
    fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".claude", "settings.json"), JSON.stringify({
      permissions: { defaultMode: "somethingElse" },
    }));
    const lifecycle = ["fresh", "restart", "resume", "fork"];
    const bytes = writeProfile(root, {
      runtime: { adapter: "claude", executable: "claude" },
      nativeConfig: {
        permissions: {
          source: "global", treatment: "overlay", refresh: "every-launch", lifecycle,
          authorize: ["bypassPermissions"],
        },
      },
    });

    const result = load(root, authority(bytes, {
      runtimeInspector: { ...CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR },
    }), { homeDir });

    expect(result.config).toBeUndefined();
    expect(result.errors.join("\n")).toContain("value 'somethingElse' is not projectable");
  });

  it("names the offending subkey for every Claude settings rejection shape", () => {
    const lifecycle = ["fresh", "restart", "resume", "fork"];
    const policy = { source: "global", treatment: "overlay", refresh: "every-launch", lifecycle };
    const cases: Array<{ settings: Record<string, unknown>; expected: string }> = [
      {
        settings: { permissions: { allow: "Read" } },
        expected: "key 'permissions.allow' must be a list of strings, got 'Read'",
      },
      {
        settings: { permissions: { hooks: ["x"] } },
        expected: "key 'permissions.hooks' is not a projectable permission field",
      },
      {
        settings: { permissions: ["nope"] },
        expected: "key 'permissions' must be an object, got a list",
      },
      {
        settings: { theme: 3 },
        expected: "key 'theme' must be a string, got 3; set the Interface family to Exclude",
      },
      {
        settings: { alwaysThinkingEnabled: "yes" },
        expected: "key 'alwaysThinkingEnabled' must be a boolean, got 'yes'"
          + "; set the Feature flags family to Exclude",
      },
    ];

    for (const { settings, expected } of cases) {
      const root = temporaryRoot("tachyon-agent-profile-claude-reject-");
      const homeDir = temporaryRoot("tachyon-agent-profile-claude-reject-home-");
      fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(homeDir, ".claude", "settings.json"), JSON.stringify(settings));
      const bytes = writeProfile(root, {
        runtime: { adapter: "claude", executable: "claude" },
        nativeConfig: { permissions: policy, interface: policy, featureFlags: policy },
      });

      const result = load(root, authority(bytes, {
        runtimeInspector: { ...CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR },
      }), { homeDir });

      expect(result.config).toBeUndefined();
      expect(result.errors.join("\n")).toContain(expected);
      expect(result.errors.join("\n")).not.toContain("has an unsupported value");
    }
  });

  it("rejects unmeasured Claude selectors and bypass permission defaults", () => {
    const root = temporaryRoot("tachyon-agent-profile-claude-closed-selectors-");
    fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({
      permissions: { defaultMode: "bypassPermissions" },
    }));
    const lifecycle = ["fresh", "restart", "resume", "fork"];
    const bytes = writeProfile(root, {
      runtime: {
        adapter: "claude",
        executable: "claude",
        model: "claude-opus-5",
        provider: "anthropic",
        reasoningEffort: "ultra",
        serviceTier: "fast",
      },
      nativeConfig: {
        selectors: { source: "agent", treatment: "overlay", refresh: "every-launch", lifecycle },
        permissions: { source: "workspace", treatment: "overlay", refresh: "every-launch", lifecycle },
      },
    });

    const result = load(root, authority(bytes, {
      runtimeInspector: { ...CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR },
    }));

    expect(result.config).toBeUndefined();
    expect(result.errors.join("\n")).toContain("Claude provider has no measured canonical materialization");
    expect(result.errors.join("\n")).toContain("Claude serviceTier has no measured canonical materialization");
    expect(result.errors.join("\n")).toContain("Claude reasoningEffort 'ultra' is unsupported");
    expect(result.errors.join("\n")).toContain(
      "Claude workspace key 'permissions.defaultMode' value 'bypassPermissions' is not projectable",
    );
  });

  it("projects only captured, Claude-granted skills, hooks and MCP", () => {
    const root = temporaryRoot("tachyon-agent-profile-claude-capabilities-");
    const capabilityRoot = path.join(root, ".tachyon", "agents", "codex", "capabilities");
    const skill = path.join(capabilityRoot, "review");
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, "SKILL.md"), "# Review\n");
    const skillDigest = treeSha256(skill);
    const mcp = "schemaVersion: 1\nname: docs\ncommand: node\nargs: [docs.js]\nenv:\n  DOCS_TOKEN: ${DOCS_TOKEN}\n";
    const hook = "schemaVersion: 1\nclass: observability\nhooks:\n  PostToolUseFailure:\n    - hooks:\n        - type: command\n          command: node observe.js\n";
    fs.writeFileSync(path.join(capabilityRoot, "docs.yml"), mcp);
    fs.writeFileSync(path.join(capabilityRoot, "observe.yml"), hook);
    const bytes = writeProfile(root, {
      runtime: { adapter: "claude", executable: "claude" },
      capabilities: { skills: ["review"], mcp: ["docs"], hooks: ["observe"] },
      references: [
        { id: "review", kind: "skill", scope: "profile", owner: AGENT_ID, path: "capabilities/review", mode: "pinned", sha256: skillDigest },
        { id: "docs", kind: "mcp", scope: "profile", owner: AGENT_ID, path: "capabilities/docs.yml", mode: "pinned", sha256: sha256(mcp) },
        { id: "observe", kind: "hook", scope: "profile", owner: AGENT_ID, path: "capabilities/observe.yml", mode: "pinned", sha256: sha256(hook) },
      ],
    });
    const claudeAuthority = authority(bytes, {
      runtimeInspector: { ...CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR },
      capabilityGrants: [
        { referenceId: "review", sourceSha256: skillDigest, adapter: "claude", kind: "skill" },
        { referenceId: "docs", sourceSha256: sha256(mcp), adapter: "claude", kind: "mcp" },
        { referenceId: "observe", sourceSha256: sha256(hook), adapter: "claude", kind: "hook", hookClass: "observability" },
      ],
    });
    const result = load(root, claudeAuthority);

    expect(result.errors).toEqual([]);
    expect(asAgent(result.config?.agents.codex)?.profileCapabilities).toMatchObject({
      adapter: "claude",
      skills: [{ name: "review", source: { sha256: skillDigest } }],
      mcp: { docs: { command: "node", args: ["docs.js"], env: { DOCS_TOKEN: "${DOCS_TOKEN}" } } },
      hooks: { PostToolUseFailure: expect.any(Array) },
    });

    const denied = load(root, authority(bytes, {
      runtimeInspector: { ...CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR },
      capabilityGrants: claudeAuthority.capabilityGrants?.filter((grant) => grant.kind !== "skill"),
    }));
    expect(denied.config).toBeUndefined();
    expect(denied.errors.join("\n")).toContain("lacks an exact host-custodied skill grant");
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

  it("t-26f508: projects the selected Grok families and refuses ambient project tooling", () => {
    const root = temporaryRoot("tachyon-agent-profile-grok-native-");
    const directory = path.join(root, ".tachyon", "agents", "grok-n");
    fs.mkdirSync(directory, { recursive: true });
    const home = path.join(root, "home");
    fs.mkdirSync(path.join(home, ".grok"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".grok", "config.toml"),
      // `[cli]` is the person's own unrelated key: it must stay opaque instead of blocking activation.
      '[cli]\ninstaller = "internal"\n\n[ui]\nmax_thoughts_width = 120\npermission_mode = "ask"\n',
    );
    const scalar = {
      source: "global",
      treatment: "overlay",
      refresh: "every-launch",
      lifecycle: ["fresh", "restart", "resume"],
    };
    const bytes = Buffer.from(stringify({
      schemaVersion: 1,
      agentId: AGENT_ID,
      runtime: { adapter: "grok", executable: "grok", model: "grok-4.5" },
      nativeConfig: {
        selectors: { source: "agent", treatment: "overlay", refresh: "every-launch", lifecycle: ["fresh", "restart", "resume"] },
        permissions: scalar,
        interface: scalar,
      },
    }));
    fs.writeFileSync(path.join(directory, "agent.yml"), bytes);
    const record: AgentProfileAuthorityRecord = {
      schemaVersion: 1,
      agentName: "grok-n",
      agentId: AGENT_ID,
      revision: "profile-r1",
      canonicalSha256: sha256(bytes),
      runtimeInspector: { ...GROK_PRIVATE_HOME_INPUT_INSPECTOR },
    };
    const options = {
      yamlText: "agents:\n  grok-n:\n    profile: .tachyon/agents/grok-n/agent.yml\n",
      workspaceRoot: root,
      authorities: new Map([["grok-n", record]]),
      homeDir: home,
    };
    const result = loadProfileAwareConfig(options);

    expect(result.errors).toEqual([]);
    expect(result.config?.agents["grok-n"]).toMatchObject({ kind: "agent" });
    expect((result.config?.agents["grok-n"] as { profileNativeConfig?: unknown }).profileNativeConfig).toMatchObject({
      adapter: "grok",
      toml: { "models.default": "grok-4.5", "ui.permission_mode": "ask", "ui.max_thoughts_width": 120 },
    });

    // Redirecting GROK_HOME does not stop project discovery, so an ambient `.grok` is refused.
    fs.mkdirSync(path.join(root, ".grok"), { recursive: true });
    fs.writeFileSync(path.join(root, ".grok", "config.toml"), "[mcp_servers.ambient]\ncommand = \"echo\"\n");
    const blocked = loadProfileAwareConfig(options);
    expect(blocked.config).toBeUndefined();
    expect(blocked.errors.join("\n")).toContain("ambient Grok input must be absent: .grok/config.toml");
  });

  it("t-26f508 review: a Grok authority created under the superseded v1 inspector still loads", () => {
    // The hazard this covers is NOT scoped to the stale agent: one projection error makes
    // loadProfileAwareConfig return {errors} for the WHOLE config, so an upgrade would stop every
    // agent of every runtime in that workspace from loading — with no in-product repair, because
    // authorityFor copies the prior inspector on every edit.
    const root = temporaryRoot("tachyon-agent-profile-grok-superseded-");
    const directory = path.join(root, ".tachyon", "agents", "grok-old");
    fs.mkdirSync(directory, { recursive: true });
    const bytes = Buffer.from(stringify({
      schemaVersion: 1,
      agentId: AGENT_ID,
      runtime: { adapter: "grok", executable: "grok" },
    }));
    fs.writeFileSync(path.join(directory, "agent.yml"), bytes);
    const v1 = {
      adapter: "grok",
      id: "tachyon.grok-private-home-inputs",
      version: "1",
      sha256: crypto.createHash("sha256").update([
        "tachyon/grok-private-home-input-inspector/v1",
        "literal executable grok",
        "GROK_HOME is Tachyon-owned bridge-mcp/<agent>.grok on every canonical launch",
        "config.toml and trusted_folders.toml are rewritten before launch",
        "auth.json is an external credential symlink",
        "ambient ~/.grok config, memory and plugins are not inherited",
      ].join("\n")).digest("hex"),
    };
    expect(v1.sha256).not.toBe(GROK_PRIVATE_HOME_INPUT_INSPECTOR.sha256);
    const result = loadProfileAwareConfig({
      yamlText: "agents:\n  grok-old:\n    profile: .tachyon/agents/grok-old/agent.yml\n",
      workspaceRoot: root,
      authorities: new Map([["grok-old", {
        schemaVersion: 1 as const,
        agentName: "grok-old",
        agentId: AGENT_ID,
        revision: "profile-r1",
        canonicalSha256: sha256(bytes),
        runtimeInspector: v1,
      }]]),
    });

    expect(result.errors).toEqual([]);
    expect(result.config?.agents["grok-old"]).toMatchObject({ cmd: "grok" });

    // Acceptance is per named sha, not "any older version": an unrecognized descriptor still refuses.
    const forged = loadProfileAwareConfig({
      yamlText: "agents:\n  grok-old:\n    profile: .tachyon/agents/grok-old/agent.yml\n",
      workspaceRoot: root,
      authorities: new Map([["grok-old", {
        schemaVersion: 1 as const,
        agentName: "grok-old",
        agentId: AGENT_ID,
        revision: "profile-r1",
        canonicalSha256: sha256(bytes),
        runtimeInspector: { ...v1, sha256: "f".repeat(64) },
      }]]),
    });
    expect(forged.config).toBeUndefined();
    expect(forged.errors.join("\n")).toContain("host authority does not select the registered grok inspector");
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
    expect(asAgent(result.config?.agents.codex)?.profileCapabilities).toMatchObject({
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
    expect(authored.errors.join("\n")).toContain("inline agent definitions are no longer supported");
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
    expect(asAgent(result.config?.agents.codex)?.harness).toBeUndefined();
    expect(asAgent(result.config?.agents.codex)?.profileCapabilities?.mcp.docs).toEqual({ command: "node", args: ["docs.js"], env: { DOCS_TOKEN: "${DOCS_TOKEN}" } });
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
  it("loads a profile and retains its trusted source metadata beside terminals", () => {
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
        "terminals:",
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
    expect(result.config?.agentSources.helper?.mode).toBe("terminal");

    const authored = loadProfileAwareConfig({
      yamlText: "agents:\n  codex:\n    cmd: codex\n    profileLifecycle:\n      enabled: false\n",
      workspaceRoot: temporaryRoot("tachyon-profile-authored-lifecycle-"),
      authorities: new Map(),
    });
    expect(authored.errors.join("\n")).toContain("inline agent definitions are no longer supported");
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

  it("rejects inline agents even when canonical bytes exist", () => {
    const root = temporaryRoot("tachyon-agent-profile-workspace-");
    writeProfile(root);
    const result = loadProfileAwareConfig({
      yamlText: "agents:\n  codex:\n    cmd: codex\n",
      workspaceRoot: root,
      authorities: new Map(),
      homeDir: temporaryRoot("tachyon-agent-profile-home-"),
    });
    expect(result.errors.join("\n")).toContain("inline agent definitions are no longer supported");
  });
});

/**
 * t-588644 — one agent's refused profile must not take the roster with it.
 *
 * Measured before the split: two agents, one with a pin left stale by a plugin update. The healthy
 * one produced no error at all, `config` came back undefined, and no agent survived. The fix is not
 * "ignore the failure" — the failure still reaches the human through `profileErrors`, and the
 * refused agent is absent from the config rather than silently degraded into something spawnable.
 */
describe("t-588644 — a refused profile is not a refused config", () => {
  function twoAgents(): { root: string; healthySha: string; input: LoadProfileAwareConfigInput } {
    const root = temporaryRoot("tachyon-blast-");
    const homeDir = temporaryRoot("tachyon-blast-home-");
    const skill = (name: string, body: string) => {
      const dir = path.join(root, ".tachyon", "plugins", name, "skills", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), body);
      return treeSha256(dir);
    };
    const healthySha = skill("good", "v1\n");
    const otherSha = skill("other", "v1\n");

    // t-b0cfd4 — this fixture used a plugin whose bytes had drifted off their pin as its example of
    // a refused profile. That is no longer a refusal: a stale pin withholds the one skill and the
    // agent still loads, which is what that task changed. The isolation guarantee THIS task proves is
    // unchanged and still needs a per-agent fatal failure, so the broken agent now carries one that
    // genuinely describes a different agent rather than a smaller one — a profile schema this build
    // cannot read at all.
    const write = (name: string, id: string, plugin: string, sha: string, schemaVersion = 1) => {
      const dir = path.join(root, ".tachyon", "agents", name);
      fs.mkdirSync(dir, { recursive: true });
      const bytes = Buffer.from(stringify({
        schemaVersion, agentId: id,
        runtime: { adapter: "codex", executable: "codex" },
        capabilities: { skills: [plugin] },
        references: [{
          id: plugin, kind: "skill", scope: "project", owner: `plugin:${plugin}`,
          path: `.tachyon/plugins/${plugin}/skills/${plugin}`, mode: "pinned", sha256: sha, version: "1.0.0",
        }],
      }));
      fs.writeFileSync(path.join(dir, "agent.yml"), bytes);
      return {
        schemaVersion: 1, agentName: name, agentId: id, revision: "profile-r1",
        canonicalSha256: sha256(bytes), runtimeInspector: { ...CODEX_EMPTY_NATIVE_INPUT_INSPECTOR },
        capabilityGrants: [{ kind: "skill", referenceId: plugin, sourceSha256: sha, adapter: "codex" }],
      } as unknown as AgentProfileAuthorityRecord;
    };
    const healthy = write("healthy", "11111111-1111-4111-8111-111111111111", "good", healthySha);
    const broken = write("broken", "22222222-2222-4222-8222-222222222222", "other", otherSha, 2);

    return {
      root,
      healthySha,
      input: {
        yamlText: "agents:\n  healthy:\n    profile: .tachyon/agents/healthy/agent.yml\n  broken:\n    profile: .tachyon/agents/broken/agent.yml\n",
        workspaceRoot: root,
        authorities: new Map([["healthy", healthy], ["broken", broken]]),
        homeDir,
      },
    };
  }

  it("loads the healthy agent and refuses only the one whose pinned plugin drifted", () => {
    const result = loadProfileAwareConfig(twoAgents().input);

    expect(result.config).toBeDefined();
    expect(Object.keys(result.config!.agents)).toEqual(["healthy"]);
    expect(result.profileErrors.join("\n")).toContain("agents.broken.profile: profile/schema: schemaVersion");
    expect(result.profileErrors.join("\n")).not.toContain("healthy");
  });

  it("keeps every isolatable error in `errors` too, so a validity check refuses exactly what it did before", () => {
    const result = loadProfileAwareConfig(twoAgents().input);

    expect(result.errors).toEqual(result.profileErrors);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  // t-0ad300 — the refused agent has to stay NAMED somewhere. Deleting it from `config.agents` is
  // what the legacy parser needs; leaving it nowhere else is what made it vanish from the sidebar
  // and stranded the repair, since Agent Studio opens from a roster row.
  it("names the refused agent in agentSources, with why, even though it is not in config.agents", () => {
    const result = loadProfileAwareConfig(twoAgents().input);

    expect(Object.keys(result.config!.agents)).toEqual(["healthy"]);
    const refused = result.config!.agentSources.broken;
    expect(refused?.mode).toBe("refused");
    // The reason travels with the name: a row that says only "refused" sends the human to a banner
    // on another surface to find out what broke.
    expect(refused).toMatchObject({ reason: expect.stringContaining("profile/schema: schemaVersion") });
    expect(refused).not.toHaveProperty("cmd");
    expect(result.config!.agentSources.healthy?.mode).toBe("profile");
  });

  it("does not invent a refused entry when every agent projects", () => {
    const { input } = twoAgents();
    const healthyOnly = {
      ...input,
      yamlText: "agents:\n  healthy:\n    profile: .tachyon/agents/healthy/agent.yml\n",
    };

    const result = loadProfileAwareConfig(healthyOnly);

    expect(Object.values(result.config!.agentSources).map((source) => source.mode)).toEqual(["profile"]);
  });

  it("still fails the whole file when the failure is not one agent's profile", () => {
    // Pointer syntax describes the declaration itself: there is no healthy subset to salvage.
    const result = loadProfileAwareConfig({
      ...twoAgents().input,
      yamlText: "agents:\n  healthy:\n    profile: not/a/canonical/pointer.yml\n",
    });

    expect(result.config).toBeUndefined();
    expect(result.profileErrors).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

/**
 * t-b0cfd4 — a plugin cannot invalidate the whole configuration.
 *
 * Measured on 2026-08-02: the owner updated the plugins to v2.3.1 through the Plugins screen,
 * agent-browser went 3.0.0 → 3.1.0, and the sidebar answered "Invalid tachyon.yml —
 * agents.claude.profile: profile/digest-mismatch", marked the coordinator `config invalid`, and
 * offered "Open tachyon.yml" and "Doctor" as the only exits. The pin's purpose — keep bytes no human
 * approved away from the agent — was already satisfied by not delivering them; taking the rest of the
 * agent down added no protection at all.
 */
describe("t-b0cfd4 — a stale pin withholds one skill and leaves the agent standing", () => {
  const AGENT = "22222222-2222-4222-8222-222222222222";

  function workspace(pin: "current" | "stale"): { root: string; input: LoadProfileAwareConfigInput; digests: Record<string, string> } {
    const root = temporaryRoot("tachyon-withheld-");
    const homeDir = temporaryRoot("tachyon-withheld-home-");
    const install = (name: string, body: string) => {
      const dir = path.join(root, ".tachyon", "plugins", name, "skills", name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), body);
      return treeSha256(dir);
    };
    const sddSha = install("sdd", "# sdd 1.7.1\n");
    const authorizedSha = install("agent-browser", "# agent-browser 3.0.0\n");
    // The plugin update: same path, same name, new bytes.
    fs.writeFileSync(path.join(root, ".tachyon/plugins/agent-browser/skills/agent-browser/SKILL.md"), "# agent-browser 3.1.0\n");
    const installedSha = treeSha256(path.join(root, ".tachyon/plugins/agent-browser/skills/agent-browser"));
    // "stale" is the profile as the owner left it: pinned at what they approved, 3.0.0. "current" is
    // the same profile after a human Reauthorize re-pinned it to the bytes on disk.
    const browserSha = pin === "stale" ? authorizedSha : installedSha;

    const reference = (id: string, sha: string, version: string) => ({
      id, kind: "skill", scope: "project", owner: `plugin:${id}`,
      path: `.tachyon/plugins/${id}/skills/${id}`, mode: "pinned", sha256: sha, version,
    });
    const dir = path.join(root, ".tachyon", "agents", "codex");
    fs.mkdirSync(dir, { recursive: true });
    const bytes = Buffer.from(stringify({
      schemaVersion: 1, agentId: AGENT,
      runtime: { adapter: "codex", executable: "codex" },
      capabilities: { skills: ["agent-browser", "sdd"] },
      references: [reference("agent-browser", browserSha, "3.0.0"), reference("sdd", sddSha, "1.7.1")],
    }));
    fs.writeFileSync(path.join(dir, "agent.yml"), bytes);

    return {
      root,
      digests: { authorizedSha, installedSha, sddSha },
      input: {
        yamlText: "agents:\n  codex:\n    profile: .tachyon/agents/codex/agent.yml\n",
        workspaceRoot: root,
        authorities: new Map([["codex", {
          schemaVersion: 1, agentName: "codex", agentId: AGENT, revision: "profile-r1",
          canonicalSha256: sha256(bytes), runtimeInspector: { ...CODEX_EMPTY_NATIVE_INPUT_INSPECTOR },
          capabilityGrants: [
            { kind: "skill", referenceId: "agent-browser", sourceSha256: browserSha, adapter: "codex" },
            { kind: "skill", referenceId: "sdd", sourceSha256: sddSha, adapter: "codex" },
          ],
        } as unknown as AgentProfileAuthorityRecord]]),
        homeDir,
      },
    };
  }

  it("keeps the config valid and the agent loadable when a pinned plugin skill drifts", () => {
    const result = loadProfileAwareConfig(workspace("stale").input);

    // The whole point: the file is not invalid, and the agent is not refused.
    expect(result.errors).toEqual([]);
    expect(result.profileErrors).toEqual([]);
    expect(result.config!.agentSources.codex?.mode).toBe("profile");
    expect(asAgent(result.config!.agents.codex)?.cmd).toBe("codex");
  });

  it("withholds the drifted skill by name and delivers every other one", () => {
    const result = loadProfileAwareConfig(workspace("stale").input);

    const agent = asAgent(result.config!.agents.codex)!;
    // The unapproved bytes reach nothing: not the projection the agent launches with, not its sources.
    expect(agent.profileCapabilities?.skills.map((skill) => skill.name)).toEqual(["sdd"]);
    expect(agent.profileCapabilities?.sources.map((source) => source.referenceId)).toEqual(["sdd"]);
    // And the sibling skill, which never moved, still crosses.
    expect(Buffer.from(agent.profileCapabilities!.skills[0]!.source.entries
      .find((entry) => entry.path === "SKILL.md")?.bytes ?? []).toString()).toBe("# sdd 1.7.1\n");
  });

  it("names the skill, both digests and the re-authorization gesture in the alert", () => {
    const { input, digests } = workspace("stale");

    const result = loadProfileAwareConfig(input);

    const alert = result.warnings.find((warning) => warning.includes("agent-browser"));
    expect(alert).toBeDefined();
    // The four things the owner had to reconstruct by hand last time.
    expect(alert).toContain("agent-browser");
    expect(alert).toContain(digests.authorizedSha!.slice(0, 16));
    expect(alert).toContain(digests.installedSha!.slice(0, 16));
    expect(alert).toContain("Reauthorize");
    // …and it says what still works, because a warning that only names a loss reads like a failure.
    expect(alert).toContain("keeps running without it");
  });

  it("carries the withholding on the agent, so delegation can withhold the same thing", () => {
    const { input, digests } = workspace("stale");

    const agent = asAgent(loadProfileAwareConfig(input).config!.agents.codex)!;

    expect(agent.profileWithheldCapabilities).toEqual([{
      referenceId: "agent-browser",
      name: "agent-browser",
      kind: "skill",
      path: ".tachyon/plugins/agent-browser/skills/agent-browser",
      code: "profile/digest-mismatch",
      expectedSha256: digests.authorizedSha,
      consumedSha256: digests.installedSha,
      version: "3.0.0",
      detail: expect.stringContaining("profile/digest-mismatch"),
    }]);
  });

  it("delivers the skill again, silently, once a human re-authorizes it", () => {
    // The repair is not automated anywhere: this is the profile AFTER `authorizeAgentSkill(…,
    // { reauthorize: true })` re-pinned it to the digest on disk. Nothing else changed.
    const result = loadProfileAwareConfig(workspace("current").input);

    const agent = asAgent(result.config!.agents.codex)!;
    expect(agent.profileCapabilities?.skills.map((skill) => skill.name)).toEqual(["agent-browser", "sdd"]);
    expect(agent.profileWithheldCapabilities).toBeUndefined();
    expect(result.warnings).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});
