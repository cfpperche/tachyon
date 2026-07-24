import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectCodexRuntimeConfig } from "../../src/runtimeConfig/codexInventory.js";
import type { AgentDef } from "../../src/config/loadConfig.js";

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
        shell: { cmd: "bash", autostart: false, watch: [], attention: {}, restart: {}, kind: "terminal" } as unknown as AgentDef,
      },
    });

    expect(snapshot.global.knownSettings).toEqual([{ key: "approval_policy", label: "Approval policy", value: "on-request" }]);
    expect(snapshot.global.mcpServers).toEqual(["bridge"]);
    expect(snapshot.global.unknownKeys).toEqual(["hooks.SessionStart.command", "model"]);
    expect(snapshot.global.internalStateCount).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain("contains-a-secret-argument");
    expect(JSON.stringify(snapshot)).not.toContain("also-hidden");
    expect(JSON.stringify(snapshot)).not.toContain("runtime-managed");
    expect(snapshot.potentialAgents).toEqual(["codex"]);
    expect(snapshot.workspace.exists).toBe(false);
    expect(snapshot.global.revision).toMatch(/^[a-f0-9]{12}$/);
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
});
