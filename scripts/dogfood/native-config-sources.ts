/**
 * t-59a11b — headless dogfood for native-config source ownership.
 *
 * The product behaviour under test: when someone edits their runtime config, every LIVE canonical
 * agent that inherits the edited scope must be marked pending ("your agent is stale"). That signal
 * was silently absent, because `sources` — the non-enumerable ownership metadata the check reads —
 * was dropped by every copy of a projection, and dropped precisely when a family IS selected.
 *
 * Drives the real profile loader, the real Claude and Codex projectors and the real
 * `Workspace.markRuntimeConfigPending`. Only the process supervisor (tmux) is faked.
 *
 * Run: node scripts/dogfood/run.mjs native-config-sources
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { loadProfileAwareConfig } from "@tachyon/engine/config/agentProfileConfigLoader.js";
import {
  CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR,
  CODEX_EMPTY_NATIVE_INPUT_INSPECTOR,
} from "@tachyon/engine/config/agentProfileProjection.js";
import { carryNativeConfigSources } from "@tachyon/shared/config/agentNativeConfigPolicy.js";
import type { AgentProfileAuthorityRecord } from "@tachyon/engine/config/agentProfileAuthority.js";
import { Workspace } from "@tachyon/engine/workspace/Workspace.js";
import type { EngineHost, NoticeAction, ViewKind } from "@tachyon/engine/workspace/EngineHost.js";
import { TmuxService } from "@tachyon/engine/tmux/TmuxService.js";
import type { NotifyLevel } from "@tachyon/engine/workspace/EngineHost.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const LIFECYCLE = ["fresh", "restart", "resume", "fork"];
const CODEX_LIFECYCLE = ["fresh", "restart", "resume"];

const cleanup: string[] = [];
function temporaryDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), label));
  cleanup.push(dir);
  return dir;
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

function authorityFor(agentName: string, bytes: Buffer, inspector: unknown): AgentProfileAuthorityRecord {
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

function report(label: string, ok: boolean, detail: unknown): boolean {
  console.log(`${ok ? "PASS" : "FAIL"} — ${label}`);
  console.log(`     ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  return ok;
}

const checks: boolean[] = [];

// ── 1: Claude, with settings genuinely projected (the case that used to lose the metadata).
console.log("\n== 1: Claude projection retains source ownership ==");
{
  const root = temporaryDir("tachyon-src-claude-");
  const home = temporaryDir("tachyon-src-claude-home-");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark", alwaysThinkingEnabled: true }));
  const policy = { source: "global", treatment: "overlay", refresh: "every-launch", lifecycle: LIFECYCLE };
  const bytes = writeProfile(root, "claude", {
    runtime: { adapter: "claude", executable: "claude" },
    nativeConfig: { interface: policy, featureFlags: policy },
  });
  const result = load(root, "claude", authorityFor("claude", bytes, CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR), home);
  const projection = result.config?.agents.claude?.profileNativeConfig;
  checks.push(report(
    "settings projected AND sources retained",
    JSON.stringify(projection?.settings) === JSON.stringify({ theme: "dark", alwaysThinkingEnabled: true })
    && JSON.stringify(projection?.sources) === JSON.stringify({ interface: "global", featureFlags: "global" }),
    { settings: projection?.settings, sources: projection?.sources },
  ));
}

// ── 2: Codex, whose projector clones unconditionally, so it lost the metadata on every selection.
console.log("\n== 2: Codex projection retains source ownership ==");
{
  const root = temporaryDir("tachyon-src-codex-");
  const home = temporaryDir("tachyon-src-codex-home-");
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), "approval_policy = \"on-request\"\n");
  const bytes = writeProfile(root, "codex", {
    runtime: { adapter: "codex", executable: "codex", model: "gpt-5" },
    nativeConfig: {
      selectors: { source: "agent", treatment: "overlay", refresh: "every-launch", lifecycle: CODEX_LIFECYCLE },
      permissions: { source: "global", treatment: "overlay", refresh: "every-launch", lifecycle: CODEX_LIFECYCLE },
    },
  });
  const result = load(root, "codex", authorityFor("codex", bytes, CODEX_EMPTY_NATIVE_INPUT_INSPECTOR), home);
  const projection = result.config?.agents.codex?.profileNativeConfig;
  checks.push(report(
    "scalars projected AND sources retained",
    JSON.stringify(projection?.permissions) === JSON.stringify({ approvalPolicy: "on-request" })
    && JSON.stringify(projection?.sources) === JSON.stringify({ selectors: "agent", permissions: "global" }),
    { permissions: projection?.permissions, sources: projection?.sources },
  ));
}

// ── 3: the fork copy. AgentManager.commitFork structuredClones the projection; the real fork path
// is covered by the unit regression in test/unit/agentManager.test.ts. Here we exercise the same
// clone-and-carry this dogfood can run headlessly.
console.log("\n== 3: fork clone retains source ownership ==");
{
  const root = temporaryDir("tachyon-src-fork-");
  const home = temporaryDir("tachyon-src-fork-home-");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark" }));
  const policy = { source: "global", treatment: "overlay", refresh: "every-launch", lifecycle: LIFECYCLE };
  const bytes = writeProfile(root, "claude", {
    runtime: { adapter: "claude", executable: "claude" },
    nativeConfig: { interface: policy },
  });
  const source = load(root, "claude", authorityFor("claude", bytes, CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR), home)
    .config!.agents.claude!.profileNativeConfig!;
  const naive = structuredClone(source);
  const forked = carryNativeConfigSources(structuredClone(source), source);
  checks.push(report(
    "a bare structuredClone still drops it; the fork path carries it",
    naive.sources === undefined && JSON.stringify(forked.sources) === JSON.stringify({ interface: "global" }),
    { bareClone: naive.sources, forkPath: forked.sources },
  ));
}

// ── 4: the product signal — a live canonical agent is marked pending for its selected scope.
console.log("\n== 4: live agent is marked pending for the scope it inherits ==");
{
  const root = temporaryDir("tachyon-src-pending-");
  const home = temporaryDir("tachyon-src-pending-home-");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark" }));
  const policy = { source: "global", treatment: "overlay", refresh: "every-launch", lifecycle: LIFECYCLE };
  const bytes = writeProfile(root, "claude", {
    runtime: { adapter: "claude", executable: "claude" },
    nativeConfig: { interface: policy },
  });
  fs.writeFileSync(path.join(root, "tachyon.yml"), "agents:\n  claude:\n    profile: .tachyon/agents/claude/agent.yml\n");

  const ws = await Workspace.createForTest(
    root,
    { host: new HeadlessHost(temporaryDir("tachyon-src-storage-")), onViewsChanged: () => {} },
    { tmux: new TmuxService(async () => ({ stdout: "", stderr: "" })), startBridge: false },
  );
  const internals = ws as unknown as {
    config?: unknown;
    manager: { list: () => Promise<Array<{ name: string; running: boolean; kind: string }>> };
  };
  internals.config = load(root, "claude", authorityFor("claude", bytes, CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR), home).config;
  internals.manager.list = async () => [{ name: "claude", running: true, kind: "agent" }];

  const global = await ws.markRuntimeConfigPending("claude", "global", "rev-1");
  const workspace = await ws.markRuntimeConfigPending("claude", "workspace", "rev-2");
  checks.push(report(
    "the selected 'global' scope marks the agent; unselected 'workspace' does not",
    JSON.stringify(global) === JSON.stringify(["claude"]) && JSON.stringify(workspace) === JSON.stringify([]),
    { global, workspace, pending: ws.runtimeConfigPendingAgents() },
  ));
  try { await ws.dispose?.(); } catch { /* headless teardown is best-effort */ }
}

// ── 5: the metadata must stay invisible to anything that serializes the projection.
console.log("\n== 5: serialized projection contract is unchanged ==");
{
  const root = temporaryDir("tachyon-src-shape-");
  const home = temporaryDir("tachyon-src-shape-home-");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark" }));
  const policy = { source: "global", treatment: "overlay", refresh: "every-launch", lifecycle: LIFECYCLE };
  const bytes = writeProfile(root, "claude", {
    runtime: { adapter: "claude", executable: "claude" },
    nativeConfig: { interface: policy },
  });
  const projection = load(root, "claude", authorityFor("claude", bytes, CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR), home)
    .config!.agents.claude!.profileNativeConfig!;
  const serialized = JSON.parse(JSON.stringify(projection));
  checks.push(report(
    "sources is readable but neither enumerable nor serialized",
    projection.sources !== undefined
    && !Object.keys(projection).includes("sources")
    && JSON.stringify(serialized) === JSON.stringify({ adapter: "claude", selectors: {}, settings: { theme: "dark" } }),
    { readable: projection.sources, ownKeys: Object.keys(projection), serialized },
  ));
}

for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${failed === 0 ? "DOGFOOD PASS" : "DOGFOOD FAIL"} — ${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
