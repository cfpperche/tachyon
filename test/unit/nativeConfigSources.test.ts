import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { loadProfileAwareConfig } from "@tachyon/engine/config/agentProfileConfigLoader.js";
import {
  CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR,
  CODEX_EMPTY_NATIVE_INPUT_INSPECTOR,
  GROK_PRIVATE_HOME_INPUT_INSPECTOR,
} from "@tachyon/engine/config/agentProfileProjection.js";
import type { AgentProfileAuthorityRecord } from "@tachyon/engine/config/agentProfileAuthority.js";
import { Workspace } from "@tachyon/engine/workspace/Workspace.js";
import type { EngineHost, NoticeAction, ViewKind } from "@tachyon/engine/workspace/EngineHost.js";
import { TmuxService } from "@tachyon/engine/tmux/TmuxService.js";
import type { NotifyLevel } from "@tachyon/engine/bridge/tools.js";
import { asAgent } from "@tachyon/engine/config/loadConfig.js";

/**
 * t-59a11b — `sources` is deliberately non-enumerable so it never widens the serialized projection
 * contract, but every copy of a projection used to drop it. It was lost precisely when a family IS
 * selected, which is the only case `markRuntimeConfigPending` cares about, so no live canonical
 * agent was ever marked stale after a runtime-config edit.
 */

const roots: string[] = [];
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const LIFECYCLE = ["fresh", "restart", "resume", "fork"];
const CODEX_LIFECYCLE = ["fresh", "restart", "resume"];

function temporaryRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), label));
  roots.push(root);
  return root;
}

function sha256(bytes: string | Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function writeProfile(root: string, agentName: string, profile: Record<string, unknown>): Buffer {
  const directory = path.join(root, ".tachyon", "agents", agentName);
  fs.mkdirSync(directory, { recursive: true });
  const bytes = Buffer.from(stringify({ schemaVersion: 1, agentId: AGENT_ID, ...profile }));
  fs.writeFileSync(path.join(directory, "agent.yml"), bytes);
  return bytes;
}

function authority(agentName: string, bytes: Buffer, inspector: unknown): AgentProfileAuthorityRecord {
  return {
    schemaVersion: 1,
    agentName,
    agentId: AGENT_ID,
    revision: "profile-r1",
    canonicalSha256: sha256(bytes),
    runtimeInspector: { ...(inspector as object) },
  } as AgentProfileAuthorityRecord;
}

function load(root: string, agentName: string, record: AgentProfileAuthorityRecord, homeDir: string) {
  return loadProfileAwareConfig({
    yamlText: `agents:\n  ${agentName}:\n    profile: .tachyon/agents/${agentName}/agent.yml\n`,
    workspaceRoot: root,
    authorities: new Map([[agentName, record]]),
    homeDir,
  });
}

/** Minimal headless host — markRuntimeConfigPending needs a Workspace, not an editor. */
class HeadlessHost implements EngineHost {
  private readonly state = new Map<string, unknown>();
  private readonly secrets = new Map<string, string>();
  constructor(private readonly storageDir: string) {}
  t(message: string, ...args: (string | number | boolean)[]): string {
    return message.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? ""));
  }
  notify(_message: string, _level: NotifyLevel = "info", _actions?: NoticeAction[]): void {}
  focusPrimaryView(): void {}
  openTask(): void {}
  executeCommand(): Promise<unknown> { return Promise.resolve(undefined); }
  watch(): { dispose(): void } { return { dispose() {} }; }
  gitExtensionPath(): string | string[] | undefined { return undefined; }
  globalStoragePath(): string { return this.storageDir; }
  getState<T>(key: string): T | undefined { return this.state.get(key) as T | undefined; }
  setState(key: string, value: unknown): void { this.state.set(key, value); }
  getSecret(key: string): Promise<string | undefined> { return Promise.resolve(this.secrets.get(key)); }
  setSecret(key: string, value: string): Promise<void> { this.secrets.set(key, value); return Promise.resolve(); }
  appVersion(): string { return "0.0.0-test"; }
  mediaPath(...segments: string[]): string { return path.join(this.storageDir, ...segments); }
  webviewRoot(): unknown { return undefined; }
  onViewsChanged(_view: ViewKind): void {}
}

const workspaces: Workspace[] = [];

afterEach(async () => {
  for (const ws of workspaces.splice(0)) {
    try { await ws.dispose?.(); } catch { /* headless teardown is best-effort */ }
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("native config source ownership (t-59a11b)", () => {
  it("retains Claude source ownership when settings are actually projected", () => {
    const root = temporaryRoot("tachyon-sources-claude-");
    const homeDir = temporaryRoot("tachyon-sources-claude-home-");
    fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".claude", "settings.json"), JSON.stringify({
      theme: "dark",
      alwaysThinkingEnabled: true,
    }));
    const policy = { source: "global", treatment: "overlay", refresh: "every-launch", lifecycle: LIFECYCLE };
    const bytes = writeProfile(root, "claude", {
      runtime: { adapter: "claude", executable: "claude" },
      nativeConfig: { interface: policy, featureFlags: policy },
    });

    const result = load(root, "claude", authority("claude", bytes, CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR), homeDir);
    const projection = asAgent(result.config?.agents.claude)?.profileNativeConfig;

    expect(result.errors).toEqual([]);
    // Settings ARE projected here — the case that previously lost the metadata.
    expect(projection?.settings).toEqual({ theme: "dark", alwaysThinkingEnabled: true });
    expect(projection?.sources).toEqual({ interface: "global", featureFlags: "global" });
  });

  it("retains Codex source ownership when scalars are actually projected", () => {
    const root = temporaryRoot("tachyon-sources-codex-");
    const homeDir = temporaryRoot("tachyon-sources-codex-home-");
    fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".codex", "config.toml"), "approval_policy = \"on-request\"\n");
    const bytes = writeProfile(root, "codex", {
      runtime: { adapter: "codex", executable: "codex", model: "gpt-5" },
      nativeConfig: {
        selectors: { source: "agent", treatment: "overlay", refresh: "every-launch", lifecycle: CODEX_LIFECYCLE },
        permissions: { source: "global", treatment: "overlay", refresh: "every-launch", lifecycle: CODEX_LIFECYCLE },
      },
    });

    const result = load(root, "codex", authority("codex", bytes, CODEX_EMPTY_NATIVE_INPUT_INSPECTOR), homeDir);
    const projection = asAgent(result.config?.agents.codex)?.profileNativeConfig;

    expect(result.errors).toEqual([]);
    expect(projection?.permissions).toEqual({ approvalPolicy: "on-request" });
    expect(projection?.sources).toEqual({ selectors: "agent", permissions: "global" });
  });

  it("keeps the ownership metadata out of the serialized projection shape", () => {
    const root = temporaryRoot("tachyon-sources-shape-");
    const homeDir = temporaryRoot("tachyon-sources-shape-home-");
    fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".claude", "settings.json"), JSON.stringify({ theme: "dark" }));
    const policy = { source: "global", treatment: "overlay", refresh: "every-launch", lifecycle: LIFECYCLE };
    const bytes = writeProfile(root, "claude", {
      runtime: { adapter: "claude", executable: "claude" },
      nativeConfig: { interface: policy },
    });

    const result = load(root, "claude", authority("claude", bytes, CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR), homeDir);
    const projection = asAgent(result.config!.agents.claude)!.profileNativeConfig!;

    // Readable by the lifecycle, invisible to anything that serializes or structurally compares
    // the projection — this is why it stays non-enumerable rather than becoming a normal field.
    expect(projection.sources).toEqual({ interface: "global" });
    expect(Object.keys(projection)).not.toContain("sources");
    expect(JSON.parse(JSON.stringify(projection))).toEqual({
      adapter: "claude",
      selectors: {},
      settings: { theme: "dark" },
    });
    expect(projection).toEqual({
      adapter: "claude",
      selectors: {},
      settings: { theme: "dark" },
    });
  });

  it("marks a live canonical agent pending when its selected scope changes", async () => {
    const root = temporaryRoot("tachyon-sources-pending-");
    const homeDir = temporaryRoot("tachyon-sources-pending-home-");
    fs.mkdirSync(path.join(homeDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".claude", "settings.json"), JSON.stringify({ theme: "dark" }));
    const policy = { source: "global", treatment: "overlay", refresh: "every-launch", lifecycle: LIFECYCLE };
    const bytes = writeProfile(root, "claude", {
      runtime: { adapter: "claude", executable: "claude" },
      nativeConfig: { interface: policy },
    });
    fs.writeFileSync(
      path.join(root, "tachyon.yml"),
      "agents:\n  claude:\n    profile: .tachyon/agents/claude/agent.yml\n",
    );
    const authorityDir = path.join(root, ".tachyon", "authority");
    fs.mkdirSync(authorityDir, { recursive: true });

    const ws = await Workspace.createForTest(
      root,
      { host: new HeadlessHost(temporaryRoot("tachyon-sources-storage-")), onViewsChanged: () => {} },
      { tmux: new TmuxService(async () => ({ stdout: "", stderr: "" })), startBridge: false },
    );
    workspaces.push(ws);

    // Only the process supervisor is faked; the config below comes from the real loader and
    // markRuntimeConfigPending itself runs unmodified.
    const internals = ws as unknown as {
      config?: { agents: Record<string, unknown> };
      manager: { list: () => Promise<Array<{ name: string; running: boolean; kind: string }>> };
    };
    const loaded = load(root, "claude", authority("claude", bytes, CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR), homeDir);
    expect(loaded.errors).toEqual([]);
    internals.config = loaded.config as never;
    internals.manager.list = async () => [{ name: "claude", running: true, kind: "agent" }];

    expect(await ws.markRuntimeConfigPending("claude", "global", "rev-1")).toEqual(["claude"]);
    expect(ws.runtimeConfigPendingAgents()).toEqual(["claude"]);
    // A scope the profile does not select must stay untouched.
    expect(await ws.markRuntimeConfigPending("claude", "workspace", "rev-2")).toEqual([]);
  });

  /**
   * SDD 481 — Grok's WORKSPACE source is not a projection and cannot be one: Grok discovers
   * `.grok/config.toml` from the working directory, so it reaches a live agent even under a private
   * GROK_HOME. This agent is declared by `cmd` with no profile, so the GLOBAL source still cannot
   * reach it — t-26f508 gave canonical Grok PROFILES a global projection, and having none is
   * exactly what makes this the honest negative case.
   */
  it("marks a profile-less Grok agent pending for the workspace source only", async () => {
    const root = temporaryRoot("tachyon-grok-pending-");
    fs.writeFileSync(path.join(root, "tachyon.yml"), "agents:\n  grokkie:\n    cmd: grok\n");

    const ws = await Workspace.createForTest(
      root,
      { host: new HeadlessHost(temporaryRoot("tachyon-grok-pending-storage-")), onViewsChanged: () => {} },
      { tmux: new TmuxService(async () => ({ stdout: "", stderr: "" })), startBridge: false },
    );
    workspaces.push(ws);

    const internals = ws as unknown as {
      config?: { agents: Record<string, unknown> };
      manager: { list: () => Promise<Array<{ name: string; running: boolean; kind: string }>> };
    };
    internals.config = {
      agents: {
        grokkie: { cmd: "grok", kind: "agent" },
        clyde: { cmd: "claude", kind: "agent" },
      },
    } as never;
    internals.manager.list = async () => [
      { name: "grokkie", running: true, kind: "agent" },
      { name: "clyde", running: true, kind: "agent" },
    ];

    expect(await ws.markRuntimeConfigPending("grok", "global", "rev-1")).toEqual([]);
    expect(ws.runtimeConfigPendingAgents()).toEqual([]);
    expect(await ws.markRuntimeConfigPending("grok", "workspace", "rev-2")).toEqual(["grokkie"]);
    expect(ws.runtimeConfigPendingAgents()).toEqual(["grokkie"]);
  });

  /**
   * The other half of the same rule, and the one t-26f508 created while SDD 481 was in flight: a
   * canonical Grok profile DOES project measured families from `~/.grok/config.toml`, so the global
   * document reaches it exactly like Claude's and Codex's do. Before t-26f508 this case could not
   * exist, which is why the adapter's earlier "global reaches nobody" rule was true and is not now.
   */
  it("marks a canonical Grok agent pending for the global source it projects", async () => {
    const root = temporaryRoot("tachyon-grok-profile-pending-");
    const homeDir = temporaryRoot("tachyon-grok-profile-home-");
    fs.mkdirSync(path.join(homeDir, ".grok"), { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".grok", "config.toml"), "[ui]\nmax_thoughts_width = 120\n");
    const scalar = { source: "global", treatment: "overlay", refresh: "every-launch", lifecycle: ["fresh", "restart", "resume"] };
    const bytes = writeProfile(root, "grokkie", {
      runtime: { adapter: "grok", executable: "grok" },
      nativeConfig: { interface: scalar },
    });
    fs.writeFileSync(
      path.join(root, "tachyon.yml"),
      "agents:\n  grokkie:\n    profile: .tachyon/agents/grokkie/agent.yml\n",
    );

    const ws = await Workspace.createForTest(
      root,
      { host: new HeadlessHost(temporaryRoot("tachyon-grok-profile-storage-")), onViewsChanged: () => {} },
      { tmux: new TmuxService(async () => ({ stdout: "", stderr: "" })), startBridge: false },
    );
    workspaces.push(ws);

    const internals = ws as unknown as {
      config?: { agents: Record<string, unknown> };
      manager: { list: () => Promise<Array<{ name: string; running: boolean; kind: string }>> };
    };
    const loaded = load(root, "grokkie", authority("grokkie", bytes, GROK_PRIVATE_HOME_INPUT_INSPECTOR), homeDir);
    expect(loaded.errors).toEqual([]);
    expect(asAgent(loaded.config?.agents.grokkie)?.profileNativeConfig?.sources).toEqual({ interface: "global" });
    internals.config = loaded.config as never;
    internals.manager.list = async () => [{ name: "grokkie", running: true, kind: "agent" }];

    expect(await ws.markRuntimeConfigPending("grok", "global", "rev-1")).toEqual(["grokkie"]);
    expect(ws.runtimeConfigPendingAgents()).toEqual(["grokkie"]);
  });
});
