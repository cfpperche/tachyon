import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectCodexRuntimeConfig } from "../../apps/vscode-extension/src/runtimeConfig/codexInventory.js";
import { applyCodexNativeConfigChange } from "@tachyon/engine/config/codexNativeConfigProjection.js";
import type { AgentDef } from "@tachyon/engine/config/loadConfig.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-runtime-config-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Codex runtime configuration inventory", () => {
  it("reports only measured scalar values, MCP names, and safe unknown paths", () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), [
      'approval_policy = "on-request"',
      'model = "gpt-5"',
      '[mcp_servers.bridge]',
      'command = "contains-a-secret-argument"',
      '[hooks.SessionStart]',
      'command = "also-hidden"',
      '[hooks.state]',
      'trusted_hash = "runtime-managed"',
    ].join("\n"));

    const snapshot = inspectCodexRuntimeConfig({
      workspaceRoot: root,
      homeDir: home,
      agents: {
        codex: { cmd: "codex", autostart: false, watch: [], attention: {}, restart: {}, kind: "agent" } as unknown as AgentDef,
        claude: { cmd: "claude", autostart: false, watch: [], attention: {}, restart: {}, kind: "agent" } as unknown as AgentDef,
        shell: { cmd: "bash", autostart: false, watch: [], attention: {}, restart: {}, kind: "terminal" } as unknown as AgentDef,
      },
      pendingAgents: ["codex", "claude"],
    });

    expect(snapshot.global.knownSettings).toContainEqual({ key: "approval_policy", label: "Approval policy", value: "on-request", editValue: "on-request", editable: true });
    expect(snapshot.global.knownSettings).toContainEqual({ key: "sandbox_mode", label: "Sandbox mode", editable: true });
    expect(snapshot.global.mcpServers).toEqual([{ name: "bridge", enabled: true }]);
    expect(snapshot.global.unknownKeys).toEqual(["hooks.SessionStart.command", "model"]);
    expect(snapshot.global.internalStateCount).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain("contains-a-secret-argument");
    expect(JSON.stringify(snapshot)).not.toContain("also-hidden");
    expect(JSON.stringify(snapshot)).not.toContain("runtime-managed");
    expect(snapshot.potentialAgents).toEqual(["codex"]);
    expect(snapshot.pendingAgents).toEqual(["codex"]);
    expect(snapshot.workspace.exists).toBe(false);
    expect(snapshot.global.revision).toMatch(/^[a-f0-9]{64}$/);
  });

  it("reports invalid TOML without exposing its contents", () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), "not valid = [");

    const snapshot = inspectCodexRuntimeConfig({ workspaceRoot: root, homeDir: home, agents: {} });

    expect(snapshot.global.parseError).toBeTruthy();
    expect(snapshot.global.knownSettings).toEqual([]);
    expect(snapshot.global.mcpServers).toEqual([]);
  });

  it("patches one measured scalar while preserving unrelated TOML and MCP blocks", () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const file = path.join(home, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      "# retain this user setting",
      'approval_policy = "on-request"',
      'model = "gpt-5"',
      "",
      "[mcp_servers.bridge]",
      'command = "secret-argument"',
      "",
      "[tui]",
      "status_line_use_colors = true",
    ].join("\n"));
    const before = inspectCodexRuntimeConfig({ workspaceRoot: root, homeDir: home, agents: {} });

    applyCodexNativeConfigChange({
      workspaceRoot: root,
      homeDir: home,
      scope: "global",
      expectedRevision: before.global.revision,
      change: { kind: "setting", key: "approval_policy", value: "never" },
    });

    const after = fs.readFileSync(file, "utf8");
    expect(after).toContain('approval_policy = "never"');
    expect(after).toContain("# retain this user setting");
    expect(after).toContain('model = "gpt-5"');
    expect(after).toContain('[mcp_servers.bridge]\ncommand = "secret-argument"');
    expect(after).toContain("[tui]\nstatus_line_use_colors = true");
  });

  it("fails closed when the source changed since its inventory revision", () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const file = path.join(home, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'personality = "pragmatic"\n');
    const before = inspectCodexRuntimeConfig({ workspaceRoot: root, homeDir: home, agents: {} });
    fs.writeFileSync(file, 'personality = "changed-elsewhere"\n');

    expect(() => applyCodexNativeConfigChange({
      workspaceRoot: root,
      homeDir: home,
      scope: "global",
      expectedRevision: before.global.revision,
      change: { kind: "setting", key: "personality", value: "focused" },
    })).toThrow(/changed since it was opened/);
    expect(fs.readFileSync(file, "utf8")).toBe('personality = "changed-elsewhere"\n');
  });

  it("allows Codex runtime-owned hook state to change between inventory and save", () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const file = path.join(home, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'approval_policy = "on-request"\n[hooks.state]\ntrusted_hash = "one"\n');
    const before = inspectCodexRuntimeConfig({ workspaceRoot: root, homeDir: home, agents: {} });
    fs.writeFileSync(file, 'approval_policy = "on-request"\n[hooks.state]\ntrusted_hash = "two"\n');
    applyCodexNativeConfigChange({
      workspaceRoot: root,
      homeDir: home,
      scope: "global",
      expectedRevision: before.global.revision,
      changes: [{ kind: "setting", key: "personality", value: "focused" }],
    });
    expect(fs.readFileSync(file, "utf8")).toContain('trusted_hash = "two"');
    expect(fs.readFileSync(file, "utf8")).toContain('personality = "focused"');
  });

  it("disables and re-enables one MCP without losing its original block", () => {
    const root = tempRoot();
    const file = path.join(root, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      'model = "gpt-5"',
      "",
      "[mcp_servers.keep]",
      'command = "keep"',
      "",
      "[mcp_servers.remove_me]",
      'command = "remove"',
    ].join("\n"));
    const before = inspectCodexRuntimeConfig({ workspaceRoot: root, homeDir: path.join(root, "home"), agents: {} });

    applyCodexNativeConfigChange({
      workspaceRoot: root,
      homeDir: path.join(root, "home"),
      scope: "workspace",
      expectedRevision: before.workspace.revision,
      change: { kind: "set-mcp-enabled", name: "remove_me", enabled: false },
    });

    const after = fs.readFileSync(file, "utf8");
    expect(after).toContain('[mcp_servers.keep]\ncommand = "keep"');
    expect(after).toContain("# tachyon-disabled-mcp: remove_me");
    expect(after).toContain('# [mcp_servers.remove_me]\n# command = "remove"');
    expect(after).toContain('model = "gpt-5"');

    const disabled = inspectCodexRuntimeConfig({ workspaceRoot: root, homeDir: path.join(root, "home"), agents: {} });
    expect(disabled.workspace.mcpServers).toContainEqual({ name: "remove_me", enabled: false });
    applyCodexNativeConfigChange({
      workspaceRoot: root,
      homeDir: path.join(root, "home"),
      scope: "workspace",
      expectedRevision: disabled.workspace.revision,
      change: { kind: "set-mcp-enabled", name: "remove_me", enabled: true },
    });
    expect(fs.readFileSync(file, "utf8")).toContain('[mcp_servers.remove_me]\ncommand = "remove"');
  });
});
