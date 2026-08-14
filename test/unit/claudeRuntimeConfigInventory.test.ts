import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyClaudeRuntimeConfigChange,
  inspectClaudeRuntimeConfig,
} from "../../apps/vscode-extension/src/runtimeConfig/claudeInventory.js";
import type { AgentDef } from "@tachyon/engine/config/loadConfig.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-claude-runtime-config-"));
  roots.push(root);
  return root;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Claude runtime configuration inventory", () => {
  it("returns measured scalars, MCP names and opaque key names without executable payloads", () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    writeJson(path.join(home, ".claude", "settings.json"), {
      theme: "dark",
      alwaysThinkingEnabled: true,
      statusLine: { type: "command", command: "DO-NOT-EXPOSE-STATUS-SECRET" },
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "DO-NOT-EXPOSE-HOOK-SECRET" }] }] },
      mcpServers: { global_tools: { command: "DO-NOT-EXPOSE-MCP-SECRET", env: { TOKEN: "SECRET" } } },
      customSetting: "DO-NOT-EXPOSE-UNKNOWN-VALUE",
    });
    writeJson(path.join(root, ".mcp.json"), {
      mcpServers: { workspace_tools: { command: "DO-NOT-EXPOSE-WORKSPACE-MCP" } },
    });

    const snapshot = inspectClaudeRuntimeConfig({
      workspaceRoot: root,
      homeDir: home,
      agents: {
        claude: { cmd: "claude", autostart: false, watch: [], attention: {}, restart: {}, kind: "agent" } as unknown as AgentDef,
        codex: { cmd: "codex", autostart: false, watch: [], attention: {}, restart: {}, kind: "agent" } as unknown as AgentDef,
      },
      pendingAgents: ["codex", "claude"],
    });
    const global = snapshot.documents.find((document) => document.id === "claude-global-settings")!;
    const mcp = snapshot.documents.find((document) => document.id === "claude-workspace-mcp")!;

    expect(global.knownSettings).toContainEqual(expect.objectContaining({
      key: "theme",
      editValue: "dark",
      editable: true,
    }));
    expect(global.mcpServers).toEqual([{ name: "global_tools", enabled: true, editable: false }]);
    expect(global.opaqueKeys).toEqual(["hooks", "mcpServers", "statusLine"]);
    expect(global.unknownKeys).toEqual(["customSetting"]);
    expect(mcp.mcpServers).toEqual([{ name: "workspace_tools", enabled: true, editable: false }]);
    expect(snapshot.potentialAgents).toEqual(["claude"]);
    expect(snapshot.pendingAgents).toEqual(["claude"]);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("DO-NOT-EXPOSE");
    expect(serialized).not.toContain('"TOKEN"');
  });

  it("marks workspace settings shadowed by settings.local.json as non-editable without reading values", () => {
    const root = tempRoot();
    writeJson(path.join(root, ".claude", "settings.json"), {
      prefersReducedMotion: false,
      theme: "dark",
    });
    writeJson(path.join(root, ".claude", "settings.local.json"), {
      prefersReducedMotion: "DO-NOT-EXPOSE-LOCAL-VALUE",
    });

    const snapshot = inspectClaudeRuntimeConfig({ workspaceRoot: root, homeDir: path.join(root, "home"), agents: {} });
    const workspace = snapshot.documents.find((document) => document.id === "claude-workspace-settings")!;
    expect(workspace.knownSettings.find((setting) => setting.key === "prefersReducedMotion")).toMatchObject({
      editable: false,
      shadowedBy: path.join(root, ".claude", "settings.local.json"),
    });
    expect(workspace.knownSettings.find((setting) => setting.key === "theme")?.editable).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("DO-NOT-EXPOSE-LOCAL-VALUE");
  });

  it("atomically changes one measured scalar while preserving unknown and opaque JSON values", () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const file = path.join(home, ".claude", "settings.json");
    writeJson(file, {
      theme: "dark",
      permissions: { allow: ["Read"] },
      custom: { nested: "preserve-me" },
    });
    const before = inspectClaudeRuntimeConfig({ workspaceRoot: root, homeDir: home, agents: {} });
    const global = before.documents.find((document) => document.id === "claude-global-settings")!;

    const result = applyClaudeRuntimeConfigChange({
      workspaceRoot: root,
      homeDir: home,
      documentId: global.id,
      expectedRevision: global.revision,
      changes: [{ kind: "setting", key: "theme", value: "light" }],
    });

    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      theme: "light",
      permissions: { allow: ["Read"] },
      custom: { nested: "preserve-me" },
    });
    expect(result.revision).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed on stale revisions, malformed JSON, symlinks and unsupported fields", () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const file = path.join(home, ".claude", "settings.json");
    writeJson(file, { theme: "dark" });
    const before = inspectClaudeRuntimeConfig({ workspaceRoot: root, homeDir: home, agents: {} });
    const revision = before.documents.find((document) => document.id === "claude-global-settings")!.revision;
    writeJson(file, { theme: "changed-elsewhere" });
    expect(() => applyClaudeRuntimeConfigChange({
      workspaceRoot: root,
      homeDir: home,
      documentId: "claude-global-settings",
      expectedRevision: revision,
      changes: [{ kind: "setting", key: "theme", value: "light" }],
    })).toThrow(/changed since it was opened/);

    fs.writeFileSync(file, "{ invalid");
    expect(() => applyClaudeRuntimeConfigChange({
      workspaceRoot: root,
      homeDir: home,
      documentId: "claude-global-settings",
      expectedRevision: before.documents[0]?.revision,
      changes: [{ kind: "setting", key: "theme", value: "light" }],
    })).toThrow();

    fs.unlinkSync(file);
    fs.symlinkSync(path.join(root, "elsewhere.json"), file);
    expect(() => applyClaudeRuntimeConfigChange({
      workspaceRoot: root,
      homeDir: home,
      documentId: "claude-global-settings",
      changes: [{ kind: "setting", key: "theme", value: "light" }],
    })).toThrow(/regular file/);

    fs.unlinkSync(file);
    expect(() => applyClaudeRuntimeConfigChange({
      workspaceRoot: root,
      homeDir: home,
      documentId: "claude-global-settings",
      changes: [{ kind: "setting", key: "permissions", value: {} }],
    })).toThrow(/Unsupported Claude/);
  });
});
