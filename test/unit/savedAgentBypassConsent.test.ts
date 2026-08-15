import { createWorkspaceForTest } from "@tachyon/engine/bridge/workspaceComposition.js";
import { useDisposableRuntimeAuth } from "../helpers/optionalRuntimeAuth.js";
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EngineHost, NoticeAction, ViewKind } from "@tachyon/engine/workspace/EngineHost.js";
import { TmuxService, type ExecResult } from "@tachyon/engine/tmux/TmuxService.js";
import type { NotifyLevel } from "@tachyon/engine/workspace/EngineHost.js";
import { writeSavedAgent, savedAgentSecrets, savedAgentsYaml } from "../helpers/savedAgentFixture.js";

/**
 * t-084b28 — a Saved Agent must not be parked at the bypass-permissions disclaimer on every launch.
 *
 * The per-spawn `--settings` file is where Claude reads `skipDangerousModePermissionPrompt`. The wiring
 * used to write it as `!!opts?.ownershipOnly`, and `ownershipOnly` is `!lifecycleHooks`, which is
 * `temporary`. So the flag reached Temporary agents and skipped SAVED ones — backwards, because the
 * Saved agent is the one whose profile carries the explicit `authorize: [bypassPermissions]`.
 *
 * Measured on 0.56.126/0.56.127: this workspace's Saved coordinator hit the disclaimer on every resume
 * and sat at `needs input` until a human pressed a key. The projected `permissions.defaultMode` in the
 * private home does not answer it — the CLI resolves this gate from a different key on a different read
 * path.
 *
 * Asserted on the file the runtime actually reads, not on the option passed to the writer: the writer
 * always honoured the option, and the defect was entirely in who decided to pass it.
 */
class HeadlessHost implements EngineHost {
  constructor(private readonly storageDir: string) {}
  t(message: string, ...args: (string | number | boolean)[]): string {
    return message.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? ""));
  }
  notify(_message: string, _level: NotifyLevel = "info", _actions?: NoticeAction[]): void {}
  focusPrimaryView(): void {}
  openTask(): void {}
  executeCommand(command: string): Promise<unknown> {
    return Promise.reject(new Error(`unexpected host command in headless test: ${command}`));
  }
  watch(): { dispose(): void } {
    return { dispose() {} };
  }
  gitExtensionPath(): string | string[] | undefined { return undefined; }
  globalStoragePath(): string { return this.storageDir; }
  getState<T>(_key: string): T | undefined { return undefined; }
  setState(_key: string, _value: unknown): void {}
  getSecret(key: string): Promise<string | undefined> { return Promise.resolve(this.secrets.get(key)); }
  setSecret(key: string, value: string): Promise<void> { this.secrets.set(key, value); return Promise.resolve(); }
  appVersion(): string { return "0.0.0-test"; }
  mediaPath(...segments: string[]): string { return path.join(this.storageDir, ...segments); }
  webviewRoot(): unknown { return undefined; }
  onViewsChanged(_view: ViewKind): void {}
  readonly secrets = new Map<string, string>();
}

function fakeTmux() {
  const sessions = new Set<string>();
  const exec = async (args: string[]): Promise<ExecResult> => {
    if (args.includes("new-session")) {
      sessions.add(args[args.indexOf("-s") + 1]);
      return { stdout: "", stderr: "" };
    }
    const target = () => args[args.indexOf("-t") + 1]?.replace(/^=/, "").replace(/:$/, "");
    switch (args[2]) {
      case "has-session":
        if (!sessions.has(target())) throw new Error("can't find session");
        return { stdout: "", stderr: "" };
      case "list-sessions":
        if (sessions.size === 0) throw new Error("no server");
        return { stdout: [...sessions].join("\n"), stderr: "" };
      case "list-panes":
        if (sessions.size === 0) throw new Error("no server");
        return { stdout: [...sessions].map((s) => `${s}\t0\t`).join("\n"), stderr: "" };
      default:
        return { stdout: "", stderr: "" };
    }
  };
  return { sessions, tmux: new TmuxService(exec) };
}

/**
 * t-a12966 — the claude credential these cases need is SUBSTRATE: the harness materializer links a
 * credential file so the spawn can proceed, and nothing below launches a real runtime. Listing the
 * titles here for `skipTestsWithoutOptionalRuntimeAuth` made the result depend on whether the HOST was
 * logged in — measured green on the maintainer's checkout and pending in every agent worktree with a
 * private, credential-free config home. Injected through the door production reads instead.
 */
useDisposableRuntimeAuth(["claude"]);

describe("t-084b28 — Saved Agent bypass consent is seeded, not asked every launch", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function mkdir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-bypass-consent-"));
    dirs.push(d);
    return d;
  }

  it("writes skipDangerousModePermissionPrompt into the per-spawn settings a Saved Agent launches with", async () => {
    const root = mkdir();
    const canonical = [writeSavedAgent(root, "claude", { runtime: "claude" })];
    fs.writeFileSync(path.join(root, "tachyon.yml"), savedAgentsYaml(canonical), "utf8");
    const host = new HeadlessHost(mkdir());
    for (const [key, value] of savedAgentSecrets(root, canonical)) host.secrets.set(key, value);
    const { tmux } = fakeTmux();
    const ws = await createWorkspaceForTest(root, { host, onViewsChanged: () => {} }, { tmux, startBridge: false });

    try {
      await ws.manager.spawn("claude");

      const spawnSettings = path.join(root, ".tachyon", "spawn-settings", "claude.json");
      expect(fs.existsSync(spawnSettings)).toBe(true);
      const settings = JSON.parse(fs.readFileSync(spawnSettings, "utf8")) as Record<string, unknown>;
      expect(settings.skipDangerousModePermissionPrompt).toBe(true);
      // The lifecycle hooks a Saved Agent gets must still be there — this file carries both, and the
      // regression would be "fixed" uselessly if seeding the consent cost the agent its hooks.
      expect(settings.hooks).toBeTruthy();
    } finally {
      ws.dispose();
    }
  });
});
