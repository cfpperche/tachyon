import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../../src/workspace/Workspace.js";
import type { EngineHost, NoticeAction, ViewKind, WatchEvents } from "../../src/workspace/EngineHost.js";
import { TmuxService, type ExecResult } from "../../src/tmux/TmuxService.js";
import type { NotifyLevel } from "../../src/bridge/tools.js";
import { parseConfig, validateTachyonConfigText } from "../../src/config/loadConfig.js";

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
  getSecret(): Promise<string | undefined> {
    return Promise.resolve(undefined);
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

async function makeWs(yml: string): Promise<{ ws: Workspace; root: string; host: FakeHost }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tac-099be8-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "tachyon.yml"), yml, "utf8");
  const host = new FakeHost(path.join(root, ".storage"));
  fs.mkdirSync(host.globalStoragePath(), { recursive: true });
  const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux: fakeTmux(), startBridge: false });
  return { ws, root, host };
}

describe("t-099be8 tachyon.yml self-edit gate", () => {
  it("validateTachyonConfigText rejects hard-invalid YAML before any write", () => {
    const r = validateTachyonConfigText("agents: [not-a-mapping");
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.config).toBeUndefined();
  });

  it("writeTachyonConfigText refuses invalid content and leaves the file unchanged", async () => {
    const base = "agents:\n  claude:\n    cmd: claude\n  coder:\n    cmd: codex\n";
    const { ws, root } = await makeWs(base);
    const before = fs.readFileSync(path.join(root, "tachyon.yml"), "utf8");
    const bad = "agents:\n  claude:\n    cmd: claude\n    subagents: [claude]\n"; // self-ref hard error
    const result = ws.writeTachyonConfigText(bad);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected reject");
    expect(result.errors.some((e) => e.includes("cannot reference itself"))).toBe(true);
    expect(fs.readFileSync(path.join(root, "tachyon.yml"), "utf8")).toBe(before);
    expect(Object.keys(ws.config?.agents ?? {}).sort()).toEqual(["claude", "coder"]);
  });

  it("writeTachyonConfigText accepts valid content and reloads the roster", async () => {
    const { ws, root } = await makeWs("agents:\n  claude:\n    cmd: claude\n");
    const next = "agents:\n  claude:\n    cmd: claude\n  helper:\n    cmd: codex\n";
    const result = ws.writeTachyonConfigText(next);
    expect(result.ok).toBe(true);
    expect(Object.keys(ws.config?.agents ?? {}).sort()).toEqual(["claude", "helper"]);
    expect(fs.readFileSync(path.join(root, "tachyon.yml"), "utf8")).toContain("helper:");
  });

  it("writeTachyonConfigText with dangling subagents saves, warns, and keeps the fleet", async () => {
    const { ws, host } = await makeWs("agents:\n  claude:\n    cmd: claude\n  coder:\n    cmd: codex\n");
    // Incident shape: reviewer removed, subagents still lists it.
    const incident = `agents:
  claude:
    cmd: claude
    subagents: [reviewer]
  coder:
    cmd: codex
`;
    const result = ws.writeTachyonConfigText(incident);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.warnings.some((w) => w.includes("reviewer") && w.includes("dangling"))).toBe(true);
    expect(Object.keys(ws.config?.agents ?? {}).sort()).toEqual(["claude", "coder"]);
    expect(ws.config?.agents.claude.subagents).toBeUndefined();
    // reload from disk proves cold-load parity
    const cold = parseConfig(fs.readFileSync(path.join(ws.workspaceRoot, "tachyon.yml"), "utf8"));
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
