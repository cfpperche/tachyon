/**
 * t-af0d29 — the WIRING proof: a live Workspace whose workspace is destroyed stops, and stops
 * REBUILDING it.
 *
 * `workspaceIdentity.test.ts` proves the state machine in isolation. This file proves the thing the
 * 2026-08-21 incident was actually about: the heartbeat is what kept `.tachyon/` alive under a
 * running `rm -rf` (every store lazily mkdirs its own directory, 154 call sites), so an identity
 * check that nothing consults would be green-but-dead — the failure shape this repository has paid
 * for before.
 */
import { writeWorkspaceConfig } from "../helpers/writeWorkspaceConfig.js";
import { createWorkspaceForTest } from "@tachyon/bridge/workspaceComposition.js";
import { ensureWorkspaceIdentity } from "@tachyon/engine/workspace/workspaceIdentity.js";
import { hermeticLaunchPreflight } from "../helpers/hermeticLaunchPreflight.js";
import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "@tachyon/engine/workspace/Workspace.js";
import type { EngineHost, NoticeAction, ViewKind, WatchEvents } from "@tachyon/engine/workspace/EngineHost.js";
import { TmuxService, type ExecResult } from "@tachyon/engine/tmux/TmuxService.js";
import type { NotifyLevel } from "@tachyon/engine/workspace/EngineHost.js";
import { __resetVscodeMock } from "../mocks/vscode.js";

/**
 * t-35c998 — hermetic launch preflight: production's opencode adapter runs `opencode providers list`
 * to answer "is this authenticated?", which made every `cmd: opencode` spawn below execute an
 * installed CLI. The stub answers as a credentialed home does; other adapters stay real.
 */
const HERMETIC_PREFLIGHT = hermeticLaunchPreflight();

/**
 * t-fb1453 — the completion doorbell that the coordinator never heard.
 *
 * Measured 2026-08-01. `codex-revisor` finished t-21101f and called `notify_agent(to:"claude", …)`.
 * `.tachyon/doorbells.jsonl` witnessed three rings (19:13, 20:56, 21:08 UTC); the coordinator's own
 * `.tachyon/pane-transcripts/claude.log` — which covers that whole window — contains zero occurrences
 * of `codex-revisor →` and zero `[tachyon] X → Y:` envelopes. Both sides obeyed the protocol and the
 * coordinator went blind. The human then killed `codex-revisor` with `kill_agent`, minutes after the
 * third ring, which is what turned a delayed report into a destroyed one.
 *
 * The channel was never the problem: other Claude Code panes in the same workspace HAVE received
 * delivered envelopes (claude-runtime.log has 14). The notice died in `NoticeQueue` before it was ever
 * typed. This file pins each way it could die, and which of those are now closed.
 */
class FakeHost implements EngineHost {
  readonly notices: { message: string; level: NotifyLevel }[] = [];
  private readonly stateMap = new Map<string, unknown>();
  t = (message: string, ...args: (string | number | boolean)[]): string =>
    message.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? ""));
  notify(message: string, level: NotifyLevel = "info", _actions?: NoticeAction[]): void {
    this.notices.push({ message, level });
  }
  focusPrimaryView(): void {}
  openTask(): void {}
  executeCommand(command: string): Promise<unknown> {
    return Promise.reject(new Error(`unexpected host command in headless test: ${command}`));
  }
  watch(_root: string, _glob: string, _events: WatchEvents, _onEvent: () => void): { dispose(): void } {
    return { dispose: () => {} };
  }
  gitExtensionPath(): string | string[] | undefined { return undefined; }
  globalStoragePath(): string { return this.storageDir; }
  getState<T>(key: string): T | undefined { return this.stateMap.get(key) as T | undefined; }
  setState(key: string, value: unknown): void { this.stateMap.set(key, value); }
  private readonly secrets = new Map<string, string>();
  getSecret(key: string): Promise<string | undefined> { return Promise.resolve(this.secrets.get(key)); }
  setSecret(key: string, value: string): Promise<void> { this.secrets.set(key, value); return Promise.resolve(); }
  appVersion(): string { return "0.0.0-test"; }
  mediaPath(...segments: string[]): string { return path.join(this.storageDir, ...segments); }
  webviewRoot(): unknown { return undefined; }
  onViewsChanged(_view: ViewKind): void {}
  constructor(private readonly storageDir: string) {}
}

function fakeTmux() {
  const sessions = new Set<string>();
  const sent = new Map<string, string[]>();
  const exec = async (args: string[]): Promise<ExecResult> => {
    if (args.includes("new-session")) {
      sessions.add(args[args.indexOf("-s") + 1]);
      return { stdout: "", stderr: "" };
    }
    if (args[2] === "has-session") {
      const name = args[args.indexOf("-t") + 1].replace(/^=/, "");
      if (sessions.has(name)) return { stdout: "", stderr: "" };
      throw new Error("can't find session");
    }
    if (args[2] === "list-panes") {
      if (sessions.size === 0) throw new Error("no server");
      return { stdout: [...sessions].map((s) => `${s}\t0\t`).join("\n") + "\n", stderr: "" } as ExecResult;
    }
    if (args[2] === "list-sessions") {
      return { stdout: [...sessions].join("\n") + (sessions.size ? "\n" : ""), stderr: "" };
    }
    if (args[2] === "send-keys" && args.includes("-l")) {
      const name = args[args.indexOf("-t") + 1].replace(/^=/, "").replace(/:$/, "");
      sent.set(name, [...(sent.get(name) ?? []), args[args.length - 1]]);
    }
    if (args[2] === "kill-session") {
      sessions.delete(args[args.indexOf("-t") + 1].replace(/^=/, ""));
    }
    return { stdout: "", stderr: "" };
  };
  return { sessions, sent, tmux: new TmuxService(exec) };
}

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function liveWorkspace(): Promise<{ ws: Workspace; root: string; host: FakeHost; lost: string[] }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-af0d29-"));
  roots.push(root);
  writeWorkspaceConfig(root, "terminals:\n  dev:\n    cmd: sh\n");
  const host = new FakeHost(path.join(root, ".storage"));
  fs.mkdirSync(host.globalStoragePath(), { recursive: true });
  const lost: string[] = [];
  const { tmux } = fakeTmux();
  const ws = await createWorkspaceForTest(
    root,
    { host, onViewsChanged: () => {}, onWorkspaceLost: (_w, reason) => lost.push(reason) },
    { tmux, startBridge: false, launchPreflight: HERMETIC_PREFLIGHT },
  );
  return { ws, root, host, lost };
}

describe("t-af0d29: an engine stops serving a workspace that stopped existing", () => {
  it("mints the workspace marker on first run", async () => {
    const { ws, root } = await liveWorkspace();
    expect(fs.existsSync(path.join(root, ".tachyon/workspace.json"))).toBe(true);
    await ws.dispose();
  });

  it("a deleted workspace stops the engine instead of being rebuilt by it", async () => {
    const { ws, root, host, lost } = await liveWorkspace();

    // The rm the human actually ran. `.tachyon` goes with it.
    fs.rmSync(root, { recursive: true, force: true });
    await ws.tick();

    expect(lost, "the host was told its workspace is gone").toHaveLength(1);
    expect(lost[0]).toContain("no longer exists");
    expect(host.notices.some((n) => n.level === "warn" && n.message.includes("stopped serving"))).toBe(true);
    // THE POINT: the heartbeat must not have recreated the folder it was serving.
    expect(fs.existsSync(root), "the engine rebuilt the workspace the human deleted").toBe(false);

    // Further ticks stay quiet and keep the workspace deleted.
    await ws.tick();
    await ws.tick();
    expect(lost).toHaveLength(1);
    expect(fs.existsSync(root)).toBe(false);
    await ws.dispose();
  });

  it("a re-clone at the same path is a loss, not a continuation", async () => {
    const { ws, root, lost } = await liveWorkspace();

    // Destroy and recreate at the SAME path — indistinguishable from continuity before this task.
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    writeWorkspaceConfig(root, "terminals:\n  dev:\n    cmd: sh\n");
    await ws.tick();

    // A fresh checkout carries no marker yet — nobody has served it. That is already a loss for the
    // engine that was serving the old one, which is what stops it from adopting the new folder.
    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain("no longer carries its Tachyon workspace marker");
    await ws.dispose();
  });

  it("a re-clone another engine has already claimed reads as a different workspace", async () => {
    const { ws, root, lost } = await liveWorkspace();

    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    writeWorkspaceConfig(root, "terminals:\n  dev:\n    cmd: sh\n");
    // The new checkout gets its own identity, exactly as a newly attached engine would mint it.
    const fresh = ensureWorkspaceIdentity(root)!;
    await ws.tick();

    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain("different Tachyon workspace");
    // and the old engine left the new workspace's identity untouched
    expect(JSON.parse(fs.readFileSync(path.join(root, ".tachyon/workspace.json"), "utf8")).id).toBe(fresh.id);
    await ws.dispose();
  });

  it("an intact workspace ticks normally — the check costs a live fleet nothing", async () => {
    const { ws, root, lost } = await liveWorkspace();
    await ws.tick();
    await ws.tick();
    expect(lost).toEqual([]);
    expect(fs.existsSync(path.join(root, ".tachyon/workspace.json"))).toBe(true);
    await ws.dispose();
  });
});
