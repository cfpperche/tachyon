import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GROK_GLOBAL_CONFIG_DOCUMENT,
  GROK_TRUST_DOCUMENT,
  GROK_WORKSPACE_CONFIG_DOCUMENT,
  applyGrokRuntimeConfigChange,
  grokConfigHome,
  grokDocumentScope,
  inspectGrokRuntimeConfig,
} from "../../src/runtimeConfig/grokInventory.js";
import type { AgentDef } from "../../src/config/loadConfig.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-grok-runtime-config-"));
  roots.push(root);
  return root;
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function agent(cmd: string): AgentDef {
  return { cmd, autostart: false, watch: [], attention: {}, restart: {}, kind: "agent" } as unknown as AgentDef;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Grok runtime configuration inventory", () => {
  it("reports measured scalars, MCP names and opaque section names without payloads or credentials", () => {
    const root = tempRoot();
    const home = path.join(root, "grok-home");
    write(path.join(home, "config.toml"), [
      "[cli]",
      'installer = "internal"',
      "auto_update = false",
      "",
      "[models]",
      'default = "grok-4.5"',
      "",
      '[models."corp-proxy"]',
      'api_key = "DO-NOT-EXPOSE-MODEL-KEY"',
      'base_url = "https://DO-NOT-EXPOSE-HOST"',
      "",
      "[ui]",
      "max_thoughts_width = 120",
      "compact_mode = false",
      'permission_mode = "always-approve"',
      "",
      "[session]",
      "auto_compact_threshold_percent = 85",
      "",
      "[telemetry]",
      'events_api_key = "DO-NOT-EXPOSE-TELEMETRY-KEY"',
      "",
      "[[hooks.PreToolUse]]",
      'command = "DO-NOT-EXPOSE-HOOK-COMMAND"',
      "",
      "[mcp_servers.global_tools]",
      'command = "DO-NOT-EXPOSE-MCP-COMMAND"',
      'env = { TOKEN = "DO-NOT-EXPOSE-MCP-TOKEN" }',
      "",
      "[mcp_servers.turned_off]",
      'command = "/bin/true"',
      "enabled = false",
      "",
      "[experimental]",
      "some_future_key = 1",
      "",
    ].join("\n"));

    const snapshot = inspectGrokRuntimeConfig({
      workspaceRoot: root,
      grokHome: home,
      agents: { grokkie: agent("grok"), clyde: agent("claude") },
      pendingAgents: ["grokkie", "clyde"],
    });
    const global = snapshot.documents.find((document) => document.id === GROK_GLOBAL_CONFIG_DOCUMENT)!;

    expect(global.knownSettings).toContainEqual(expect.objectContaining({
      key: "models.default",
      editValue: "grok-4.5",
      editable: true,
    }));
    expect(global.knownSettings).toContainEqual(expect.objectContaining({
      key: "ui.max_thoughts_width",
      editValue: 120,
      inputKind: "number",
      editable: true,
    }));
    // Authority keys are visible, never writable.
    expect(global.knownSettings).toContainEqual(expect.objectContaining({
      key: "ui.permission_mode",
      value: "always-approve",
      editable: false,
      readOnlyReason: expect.stringContaining("authority"),
    }));
    expect(global.mcpServers).toEqual([
      { name: "global_tools", enabled: true, editable: true },
      { name: "turned_off", enabled: false, editable: true },
    ]);
    expect(global.opaqueKeys).toEqual(["hooks", "mcp_servers", "models", "telemetry"]);
    expect(global.unknownKeys).toEqual(["experimental.some_future_key"]);
    expect(global.internalStateCount).toBe(1); // cli.installer is Grok's own bookkeeping
    expect(snapshot.potentialAgents).toEqual(["grokkie"]);
    expect(snapshot.pendingAgents).toEqual(["grokkie"]);

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("DO-NOT-EXPOSE");
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toContain("events_api_key");
  });

  /**
   * The opacity list is a convenience, not the security boundary — a secret that sits at a depth or
   * in a section nobody predicted must still not escape. The actual invariant is stricter and does
   * not depend on the list at all: a VALUE reaches the snapshot only for a measured key. Everything
   * else contributes a key NAME and nothing more. This pins that invariant with secret-shaped values
   * planted at every shape the list could miss.
   */
  it("never serializes a value for any key outside the measured set, at any depth", () => {
    const root = tempRoot();
    const home = path.join(root, "grok-home");
    write(path.join(home, "config.toml"), [
      'top_level_secret = "LEAK-ROOT"',
      "",
      "[models]",
      'default = "grok-4.5"',
      'api_key = "LEAK-DEPTH-2"',            // depth 2 under a partly-owned table
      "",
      '[models."proxy"]',
      'env_key = "LEAK-DEPTH-3"',
      "",
      '[models."proxy".nested]',
      'deeper = "LEAK-DEPTH-4"',
      "",
      "[section_nobody_predicted]",
      'token = "LEAK-UNKNOWN-TABLE"',
      "",
      "[section_nobody_predicted.deeper]",
      'password = "LEAK-UNKNOWN-NESTED"',
      "",
    ].join("\n"));

    const snapshot = inspectGrokRuntimeConfig({ workspaceRoot: root, grokHome: home, agents: {} });
    const serialized = JSON.stringify(snapshot);
    for (const secret of ["LEAK-ROOT", "LEAK-DEPTH-2", "LEAK-DEPTH-3", "LEAK-DEPTH-4", "LEAK-UNKNOWN-TABLE", "LEAK-UNKNOWN-NESTED"]) {
      expect(serialized).not.toContain(secret);
    }
    // The measured key keeps its value — that is the whole point of the editor.
    const global = snapshot.documents.find((document) => document.id === GROK_GLOBAL_CONFIG_DOCUMENT)!;
    expect(global.knownSettings.find((setting) => setting.key === "models.default")?.editValue).toBe("grok-4.5");
    // Unowned keys contribute names only, and every value-bearing field is accounted for.
    // `models.api_key` is absent by NAME too: everything under `models` that Control does not own is
    // opaque at any depth (review note, t-ce83a2).
    expect(global.unknownKeys).toEqual([
      "section_nobody_predicted.deeper.password",
      "section_nobody_predicted.token",
      "top_level_secret",
    ]);
    expect(global.opaqueKeys).toContain("models");
    expect(global.knownSettings.filter((setting) => setting.value !== undefined).map((setting) => setting.key))
      .toEqual(["models.default"]);
  });

  it("offers no scalar editor in workspace scope, because Grok reads only [mcp_servers] there", () => {
    const root = tempRoot();
    write(path.join(root, ".grok", "config.toml"), [
      "[mcp_servers.repo_tools]",
      'command = "/bin/true"',
      "",
      "[models]",
      'default = "ignored-in-project-scope"',
      "",
    ].join("\n"));

    const snapshot = inspectGrokRuntimeConfig({ workspaceRoot: root, grokHome: path.join(root, "grok-home"), agents: {} });
    const workspace = snapshot.documents.find((document) => document.id === GROK_WORKSPACE_CONFIG_DOCUMENT)!;

    expect(workspace.knownSettings).toEqual([]);
    expect(workspace.mcpServers).toEqual([{ name: "repo_tools", enabled: true, editable: true }]);
    expect(workspace.unknownKeys).toEqual(["models"]);
    expect(workspace.impact).toContain("Only [mcp_servers] is read in project scope");
    expect(() => applyGrokRuntimeConfigChange({
      workspaceRoot: root,
      grokHome: path.join(root, "grok-home"),
      documentId: GROK_WORKSPACE_CONFIG_DOCUMENT,
      expectedRevision: workspace.revision,
      changes: [{ kind: "setting", key: "models.default", value: "grok-4.5" }],
    })).toThrow(/only \[mcp_servers\]/);
  });

  it("says the global document does not reach Tachyon-managed agents", () => {
    const root = tempRoot();
    const snapshot = inspectGrokRuntimeConfig({ workspaceRoot: root, grokHome: path.join(root, "grok-home"), agents: {} });
    const global = snapshot.documents.find((document) => document.id === GROK_GLOBAL_CONFIG_DOCUMENT)!;
    expect(global.impact).toContain("private GROK_HOME");
    expect(grokDocumentScope(GROK_GLOBAL_CONFIG_DOCUMENT)).toBe("global");
    expect(grokDocumentScope(GROK_WORKSPACE_CONFIG_DOCUMENT)).toBe("workspace");
  });

  it("reports folder trust read-only and never leaks other trusted paths", () => {
    const root = tempRoot();
    const home = path.join(root, "grok-home");
    write(path.join(home, "trusted_folders.toml"), [
      `[folders."${root}"]`,
      "trusted = true",
      "decided_at = 1784138766",
      "",
      '[folders."/home/someone/DO-NOT-EXPOSE-OTHER-REPO"]',
      "trusted = true",
      "decided_at = 1784138000",
      "",
    ].join("\n"));

    const snapshot = inspectGrokRuntimeConfig({ workspaceRoot: root, grokHome: home, agents: {} });
    const trust = snapshot.documents.find((document) => document.id === GROK_TRUST_DOCUMENT)!;

    expect(trust.readOnly).toBe(true);
    expect(trust.knownSettings.find((setting) => setting.key === "trusted")).toMatchObject({ value: "true", editable: false });
    expect(trust.internalStateCount).toBe(0);
    expect(JSON.stringify(snapshot)).not.toContain("DO-NOT-EXPOSE-OTHER-REPO");
    expect(() => applyGrokRuntimeConfigChange({
      workspaceRoot: root,
      grokHome: home,
      documentId: GROK_TRUST_DOCUMENT,
      expectedRevision: trust.revision,
      changes: [{ kind: "setting", key: "trusted", value: true }],
    })).toThrow(/read-only/);
  });

  it("reports an undecided workspace as not trusted", () => {
    const root = tempRoot();
    const home = path.join(root, "grok-home");
    write(path.join(home, "trusted_folders.toml"), '[folders."/somewhere/else"]\ntrusted = true\n');
    const snapshot = inspectGrokRuntimeConfig({ workspaceRoot: root, grokHome: home, agents: {} });
    const trust = snapshot.documents.find((document) => document.id === GROK_TRUST_DOCUMENT)!;
    expect(trust.knownSettings.find((setting) => setting.key === "trusted")?.value).toBe("Not decided");
  });

  it("patches one scalar in place, preserving comments, unknown tables and credential sections", () => {
    const root = tempRoot();
    const home = path.join(root, "grok-home");
    const file = path.join(home, "config.toml");
    write(file, [
      "# hand-written header",
      "[models]",
      'default = "grok-4.5"',
      "",
      '[models."corp-proxy"]',
      'api_key = "keep-me"',
      "",
      "[experimental]",
      "some_future_key = 1",
      "",
    ].join("\n"));
    const before = inspectGrokRuntimeConfig({ workspaceRoot: root, grokHome: home, agents: {} });
    const global = before.documents.find((document) => document.id === GROK_GLOBAL_CONFIG_DOCUMENT)!;

    const result = applyGrokRuntimeConfigChange({
      workspaceRoot: root,
      grokHome: home,
      documentId: GROK_GLOBAL_CONFIG_DOCUMENT,
      expectedRevision: global.revision,
      changes: [
        { kind: "setting", key: "models.default", value: "grok-build" },
        { kind: "setting", key: "ui.max_thoughts_width", value: 140 },
      ],
    });

    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("# hand-written header");
    expect(text).toContain('default = "grok-build"');
    expect(text).toContain('api_key = "keep-me"');
    expect(text).toContain("some_future_key = 1");
    expect(text).toContain("max_thoughts_width = 140");
    expect(result.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(`${file}.tachyon-runtime-config.lock`)).toBe(false);
  });

  it("toggles an MCP server with Grok's native enabled field and refuses a non-table declaration", () => {
    const root = tempRoot();
    const home = path.join(root, "grok-home");
    const file = path.join(home, "config.toml");
    write(file, [
      "[mcp_servers.linear]",
      'command = "/bin/true"',
      "",
      "[mcp_servers]",
      'inline_one = { command = "/bin/true" }',
      "",
    ].join("\n"));
    const before = inspectGrokRuntimeConfig({ workspaceRoot: root, grokHome: home, agents: {} });
    const global = before.documents.find((document) => document.id === GROK_GLOBAL_CONFIG_DOCUMENT)!;
    expect(global.mcpServers).toEqual([
      { name: "inline_one", enabled: true, editable: false },
      { name: "linear", enabled: true, editable: true },
    ]);

    applyGrokRuntimeConfigChange({
      workspaceRoot: root,
      grokHome: home,
      documentId: GROK_GLOBAL_CONFIG_DOCUMENT,
      expectedRevision: global.revision,
      changes: [{ kind: "set-mcp-enabled", name: "linear", enabled: false }],
    });
    expect(fs.readFileSync(file, "utf8")).toContain("enabled = false");

    const after = inspectGrokRuntimeConfig({ workspaceRoot: root, grokHome: home, agents: {} });
    const reread = after.documents.find((document) => document.id === GROK_GLOBAL_CONFIG_DOCUMENT)!;
    expect(reread.mcpServers.find((server) => server.name === "linear")?.enabled).toBe(false);
    expect(() => applyGrokRuntimeConfigChange({
      workspaceRoot: root,
      grokHome: home,
      documentId: GROK_GLOBAL_CONFIG_DOCUMENT,
      expectedRevision: reread.revision,
      changes: [{ kind: "set-mcp-enabled", name: "inline_one", enabled: false }],
    })).toThrow(/not declared as a \[mcp_servers/);
  });

  it("fails closed on stale revisions, invalid TOML, symlinks, unknown keys and out-of-range numbers", () => {
    const root = tempRoot();
    const home = path.join(root, "grok-home");
    const file = path.join(home, "config.toml");
    write(file, '[models]\ndefault = "grok-4.5"\n');
    const before = inspectGrokRuntimeConfig({ workspaceRoot: root, grokHome: home, agents: {} });
    const revision = before.documents.find((document) => document.id === GROK_GLOBAL_CONFIG_DOCUMENT)!.revision;

    write(file, '[models]\ndefault = "changed-elsewhere"\n');
    expect(() => applyGrokRuntimeConfigChange({
      workspaceRoot: root, grokHome: home, documentId: GROK_GLOBAL_CONFIG_DOCUMENT,
      expectedRevision: revision, changes: [{ kind: "setting", key: "models.default", value: "grok-build" }],
    })).toThrow(/changed since it was opened/);

    const current = () => inspectGrokRuntimeConfig({ workspaceRoot: root, grokHome: home, agents: {} })
      .documents.find((document) => document.id === GROK_GLOBAL_CONFIG_DOCUMENT)!;
    expect(() => applyGrokRuntimeConfigChange({
      workspaceRoot: root, grokHome: home, documentId: GROK_GLOBAL_CONFIG_DOCUMENT,
      expectedRevision: current().revision, changes: [{ kind: "setting", key: "features.support_permission", value: false }],
    })).toThrow(/Unsupported Grok/);
    expect(() => applyGrokRuntimeConfigChange({
      workspaceRoot: root, grokHome: home, documentId: GROK_GLOBAL_CONFIG_DOCUMENT,
      expectedRevision: current().revision, changes: [{ kind: "setting", key: "session.auto_compact_threshold_percent", value: 500 }],
    })).toThrow(/Unsupported value/);
    expect(() => applyGrokRuntimeConfigChange({
      workspaceRoot: root, grokHome: home, documentId: GROK_GLOBAL_CONFIG_DOCUMENT,
      expectedRevision: current().revision, changes: [{ kind: "setting", key: "ui.max_thoughts_width", value: 100.5 }],
    })).toThrow(/Unsupported value/);
    expect(() => applyGrokRuntimeConfigChange({
      workspaceRoot: root, grokHome: home, documentId: GROK_GLOBAL_CONFIG_DOCUMENT,
      expectedRevision: current().revision, changes: [],
    })).toThrow(/No runtime configuration changes/);

    fs.writeFileSync(file, "[models\ndefault =");
    expect(() => applyGrokRuntimeConfigChange({
      workspaceRoot: root, grokHome: home, documentId: GROK_GLOBAL_CONFIG_DOCUMENT,
      expectedRevision: current().revision, changes: [{ kind: "setting", key: "models.default", value: "grok-build" }],
    })).toThrow(/invalid TOML/);
    expect(current().parseError).toBeTruthy();

    fs.unlinkSync(file);
    fs.symlinkSync(path.join(root, "elsewhere.toml"), file);
    expect(() => applyGrokRuntimeConfigChange({
      workspaceRoot: root, grokHome: home, documentId: GROK_GLOBAL_CONFIG_DOCUMENT,
      changes: [{ kind: "setting", key: "models.default", value: "grok-build" }],
    })).toThrow(/regular file/);
  });

  it("creates a missing global config from an absent source under CAS", () => {
    const root = tempRoot();
    const home = path.join(root, "grok-home");
    const snapshot = inspectGrokRuntimeConfig({ workspaceRoot: root, grokHome: home, agents: {} });
    const global = snapshot.documents.find((document) => document.id === GROK_GLOBAL_CONFIG_DOCUMENT)!;
    expect(global.exists).toBe(false);
    expect(global.revision).toBeUndefined();

    applyGrokRuntimeConfigChange({
      workspaceRoot: root,
      grokHome: home,
      documentId: GROK_GLOBAL_CONFIG_DOCUMENT,
      expectedRevision: undefined,
      changes: [{ kind: "setting", key: "features.telemetry", value: false }],
    });
    expect(fs.readFileSync(path.join(home, "config.toml"), "utf8")).toContain("telemetry = false");
  });

  it("resolves the config home, honoring GROK_HOME but never a Tachyon-managed private home", () => {
    expect(grokConfigHome({ homeDir: "/home/me", env: {} })).toBe(path.join("/home/me", ".grok"));
    expect(grokConfigHome({ homeDir: "/home/me", env: { GROK_HOME: "/custom/grok" } })).toBe("/custom/grok");
    expect(grokConfigHome({ homeDir: "/home/me", env: { GROK_HOME: "/ws/.tachyon/bridge-mcp/agent.grok" } }))
      .toBe(path.join("/home/me", ".grok"));
    // A Dev Host profile home always wins, so dogfood cannot escape to the real Grok home.
    expect(grokConfigHome({ homeDir: "/tmp/profile", env: { GROK_HOME: "/custom/grok" }, profileHome: true }))
      .toBe(path.join("/tmp/profile", ".grok"));
  });
});
