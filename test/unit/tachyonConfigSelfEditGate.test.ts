import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../../src/workspace/Workspace.js";
import type { EngineHost, NoticeAction, ViewKind, WatchEvents } from "../../src/workspace/EngineHost.js";
import { TmuxService, type ExecResult } from "../../src/tmux/TmuxService.js";
import type { NotifyLevel } from "../../src/bridge/tools.js";
import { asAgent, validateTachyonConfigText } from "../../src/config/loadConfig.js";
import { writeCanonicalAgent, canonicalAgentSecrets, canonicalAgentsYaml, type CanonicalAgentSpec } from "../helpers/canonicalAgentFixture.js";

/**
 * t-099be8 — validate-before-save for agent/UI tachyon.yml edits + dangling subagents degradation.
 */

class FakeHost implements EngineHost {
  readonly notices: { message: string; level: NotifyLevel }[] = [];
  t = (message: string, ...args: (string | number | boolean)[]): string =>
    message.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? ""));
  notify(message: string, level: NotifyLevel = "info", _actions?: NoticeAction[]): void {
    this.notices.push({ message, level });
  }
  focusPrimaryView(): void {}
  openTask(): void {}
  executeCommand(): Promise<unknown> {
    return Promise.reject(new Error("unexpected host command"));
  }
  watch(_root: string, _glob: string, _events: WatchEvents, _onEvent: () => void): { dispose(): void } {
    return { dispose() {} };
  }
  getSetting<T>(_s: string, _k: string, dflt: T): T {
    return dflt;
  }
  globalStoragePath(): string {
    return this.storageDir;
  }
  getState<T>(): T | undefined {
    return undefined;
  }
  setState(): void {}
  readonly secrets = new Map<string, string>();
  getSecret(key: string): Promise<string | undefined> {
    return Promise.resolve(this.secrets.get(key));
  }
  setSecret(): Promise<void> {
    return Promise.resolve();
  }
  appVersion(): string {
    return "0.0.0-test";
  }
  mediaPath(...segments: string[]): string {
    return path.join(this.storageDir, ...segments);
  }
  webviewRoot(): unknown {
    return undefined;
  }
  onViewsChanged(_view: ViewKind): void {}
  constructor(private readonly storageDir: string) {}
}

function fakeTmux(): TmuxService {
  const sessions = new Set<string>();
  const exec = async (args: string[]): Promise<ExecResult> => {
    if (args.includes("new-session")) {
      sessions.add(args[args.indexOf("-s") + 1]);
      return { stdout: "", stderr: "" };
    }
    if (args[2] === "has-session") {
      const name = args[args.indexOf("-t") + 1]?.replace(/^=/, "") ?? "";
      if (sessions.has(name)) return { stdout: "", stderr: "" };
      throw new Error("no session");
    }
    return { stdout: "", stderr: "" };
  };
  return new TmuxService(exec);
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

/**
 * SDD 478 M7 — `yml` is the roster TEXT the gate is asked to accept or refuse; `canonical` declares
 * the agents that text points at (a profile on disk plus the host-custodied authority for it),
 * because an `agents:` entry is a pointer now and cannot carry a definition.
 */
async function makeWs(
  yml: string,
  canonical: ReadonlyArray<{ name: string; spec?: CanonicalAgentSpec }> = [],
): Promise<{ ws: Workspace; root: string; host: FakeHost; roster: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tac-099be8-"));
  roots.push(root);
  const fixtures = canonical.map((entry) => writeCanonicalAgent(root, entry.name, entry.spec ?? {}));
  // With canonical agents the caller passes only the roster TAIL; the pointer block is generated
  // from the profiles just written, so text and authority cannot drift apart.
  const roster = fixtures.length > 0 ? canonicalAgentsYaml(fixtures) + yml : yml;
  fs.writeFileSync(path.join(root, "tachyon.yml"), roster, "utf8");
  const host = new FakeHost(path.join(root, ".storage"));
  for (const [key, value] of canonicalAgentSecrets(root, fixtures)) host.secrets.set(key, value);
  fs.mkdirSync(host.globalStoragePath(), { recursive: true });
  const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux: fakeTmux(), startBridge: false });
  return { ws, root, host, roster };
}

describe("t-099be8 tachyon.yml self-edit gate", () => {
  it("validateTachyonConfigText rejects hard-invalid YAML before any write", () => {
    const r = validateTachyonConfigText("agents: [not-a-mapping");
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.config).toBeUndefined();
  });

  it("writeTachyonConfigText refuses invalid content and leaves the file unchanged", async () => {
    // SDD 478 M7 — the old bad text was a self-referencing `subagents:`, which no text can carry
    // any more: `subagents` is agent-only and an `agents:` entry is a pointer. The gate's guarantee
    // is unchanged, so it is proven with a hard error the roster text can still express.
    const base = "agents: {}\nterminals:\n  build:\n    cmd: sh\n  coder:\n    cmd: sh\n";
    const { ws, root } = await makeWs(base);
    const before = fs.readFileSync(path.join(root, "tachyon.yml"), "utf8");
    const bad = "agents: {}\nterminals:\n  build:\n    cmd: sh\n    restart: sometimes\n";
    const result = ws.writeTachyonConfigText(bad);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected reject");
    expect(result.errors.some((e) => e.includes("must be 'never' or 'on-crash'"))).toBe(true);
    expect(fs.readFileSync(path.join(root, "tachyon.yml"), "utf8")).toBe(before);
    expect(Object.keys(ws.config?.agents ?? {}).sort()).toEqual(["build", "coder"]);
  });

  it("writeTachyonConfigText accepts valid content and reloads the roster", async () => {
    const { ws, root } = await makeWs("agents: {}\nterminals:\n  build:\n    cmd: sh\n");
    const next = "agents: {}\nterminals:\n  build:\n    cmd: sh\n  helper:\n    cmd: sh\n";
    const result = ws.writeTachyonConfigText(next);
    expect(result.ok).toBe(true);
    expect(Object.keys(ws.config?.agents ?? {}).sort()).toEqual(["build", "helper"]);
    expect(fs.readFileSync(path.join(root, "tachyon.yml"), "utf8")).toContain("helper:");
  });

  it("writeTachyonConfigText with dangling subagents saves, warns, and keeps the fleet", async () => {
    // SDD 478 M7 — the incident shape (a `subagents:` entry naming an agent that no longer exists)
    // is authored in the canonical profile now, not in the roster text. The degradation under test
    // is the same: a dangling reference must warn and drop the key, never break the fleet.
    const { ws, host, roster } = await makeWs("terminals:\n  coder:\n    cmd: sh\n", [
      { name: "claude", spec: { runtime: "claude", extra: { ownership: { subagents: ["reviewer"] } } } },
    ]);
    const result = ws.writeTachyonConfigText(roster);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.warnings.some((w) => w.includes("reviewer") && w.includes("dangling"))).toBe(true);
    expect(Object.keys(ws.config?.agents ?? {}).sort()).toEqual(["claude", "coder"]);
    expect(asAgent(ws.config?.agents.claude)?.subagents).toBeUndefined();
    // reload from disk proves cold-load parity — through the profile-aware parse, since the roster
    // on disk is a pointer that only resolves against the workspace's authorities.
    const cold = ws.parseTrustedConfigText(fs.readFileSync(path.join(ws.workspaceRoot, "tachyon.yml"), "utf8"));
    expect(cold.errors).toEqual([]);
    expect(Object.keys(cold.config?.agents ?? {}).sort()).toEqual(["claude", "coder"]);
    expect(host.notices.some((n) => n.level === "warn" && n.message.includes("reviewer"))).toBe(true);
  });

  it("mutateConfig does not persist a hard-invalid mutation", async () => {
    const { ws, root } = await makeWs("agents:\n  claude:\n    cmd: claude\n");
    const before = fs.readFileSync(path.join(root, "tachyon.yml"), "utf8");
    const ok = ws.mutateConfig(() => ({
      text: "agents:\n  claude:\n    cmd: claude\n    subagents: [claude]\n",
      warnings: [],
    }));
    expect(ok).toBe(false);
    expect(fs.readFileSync(path.join(root, "tachyon.yml"), "utf8")).toBe(before);
  });

  it("agent-path gate function refuses invalid text (same seam Bridge write_tachyon_config uses)", async () => {
    const { ws, root } = await makeWs("agents:\n  claude:\n    cmd: claude\n");
    const before = fs.readFileSync(path.join(root, "tachyon.yml"), "utf8");
    // Mirrors the Bridge tool body: validate → refuse → never write.
    const gate = (text: string) => ws.writeTachyonConfigText(text);
    const bad = gate("agents:\n  only:\n    cmd: claude\n    subagents: [only]\n");
    expect(bad.ok).toBe(false);
    expect(fs.readFileSync(path.join(root, "tachyon.yml"), "utf8")).toBe(before);
  });
});
