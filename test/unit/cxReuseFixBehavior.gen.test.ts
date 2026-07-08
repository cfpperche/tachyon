import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Workspace } from "../../src/workspace/Workspace.js";
import type { EngineHost, NoticeAction, ViewKind, WatchEvents } from "../../src/workspace/EngineHost.js";
import { TmuxService, type ExecResult } from "../../src/tmux/TmuxService.js";
import type { NotifyLevel } from "../../src/bridge/tools.js";
import { readDelegationRecord, writeDelegationRecord } from "../../src/bridge/delegationRecord.js";

class FakeHost implements EngineHost {
  private readonly stateMap = new Map<string, unknown>();
  private readonly secrets = new Map<string, string>();
  t = (message: string, ...args: (string | number | boolean)[]): string => message.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? ""));
  notify(_message: string, _level: NotifyLevel = "info", _actions?: NoticeAction[]): void {}
  focusPrimaryView(): void {}
  executeCommand(command: string): Promise<unknown> {
    return Promise.reject(new Error(`unexpected host command in cxReuseFix test: ${command}`));
  }
  watch(_root: string, _glob: string, _events: WatchEvents, _onEvent: () => void): { dispose(): void } {
    return { dispose() {} };
  }
  getSetting<T>(_section: string, _key: string, dflt: T): T {
    return dflt;
  }
  globalStoragePath(): string {
    return this.storageDir;
  }
  getState<T>(key: string): T | undefined {
    return this.stateMap.get(key) as T | undefined;
  }
  setState(key: string, value: unknown): void {
    this.stateMap.set(key, value);
  }
  getSecret(key: string): Promise<string | undefined> {
    return Promise.resolve(this.secrets.get(key));
  }
  setSecret(key: string, value: string): Promise<void> {
    this.secrets.set(key, value);
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

function fakeTmux() {
  const sessions = new Set<string>();
  const newSessionArgs: string[][] = [];
  const exec = async (args: string[]): Promise<ExecResult> => {
    if (args.includes("new-session")) {
      sessions.add(args[args.indexOf("-s") + 1]);
      newSessionArgs.push(args);
      return { stdout: "", stderr: "" };
    }
    if (args[2] === "has-session") {
      const name = args[args.indexOf("-t") + 1].replace(/^=/, "");
      if (sessions.has(name)) return { stdout: "", stderr: "" };
      throw new Error("can't find session");
    }
    if (args[2] === "list-sessions") {
      if (sessions.size === 0) throw new Error("no server running");
      return { stdout: [...sessions].join("\n") + "\n", stderr: "" };
    }
    if (args[2] === "list-panes") {
      if (sessions.size === 0) throw new Error("no server running");
      return { stdout: [...sessions].map((s) => `${s}\t0\t`).join("\n") + "\n", stderr: "" };
    }
    if (args[2] === "kill-session") {
      const name = args[args.indexOf("-t") + 1].replace(/^=/, "");
      sessions.delete(name);
      return { stdout: "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  return { sessions, newSessionArgs, tmux: new TmuxService(exec) };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function latestDelegationRecordPath(root: string, agent: string): string {
  const dir = path.join(root, ".tachyon", "delegations");
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(`${agent}-`)).sort();
  return path.join(dir, files.at(-1)!);
}

describe("container-generated delegation behavior", () => {
  it("a gated delegation record persists its worktree path and reuse_worktree resolves it end-to-end", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-cxreusefix-"));
    try {
      const root = path.join(base, "ws");
      const storage = path.join(base, "storage");
      const wtBase = path.join(base, "worktrees");
      fs.mkdirSync(root, { recursive: true });
      fs.mkdirSync(storage, { recursive: true });
      fs.writeFileSync(
        path.join(root, "tachyon.yml"),
        `settings:\n  worktree:\n    base: ${JSON.stringify(wtBase)}\nagents:\n  boss:\n    cmd: sh\n`,
        "utf8",
      );
      git(root, ["init"]);
      git(root, ["config", "user.email", "test@example.com"]);
      git(root, ["config", "user.name", "Test User"]);
      fs.writeFileSync(path.join(root, "README.md"), "base\n", "utf8");
      git(root, ["add", "README.md"]);
      git(root, ["commit", "-m", "base"]);

      const { tmux, newSessionArgs } = fakeTmux();
      const ws = await Workspace.createForTest(root, { host: new FakeHost(storage), onViewsChanged: () => {} }, { tmux, startBridge: false });
      await ws.manager.spawn("reviewer", {
        cmd: "sh",
        delegator: "boss",
        contract: { task: "fix reuse", context: "durable delegation record", constraints: "stay scoped", doneWhen: "reuse resolves" },
        gate: { behaviorTest: "reuse durable worktree path", owns: ["src"] },
        reveal: false,
      });

      const recordPath = latestDelegationRecordPath(root, "reviewer");
      const record = readDelegationRecord(recordPath);
      const worktree = ws.ledger.get("reviewer")?.worktree;
      expect(worktree).toBeTruthy();
      expect(record.worktreePath).toBe(worktree!.path);
      expect(fs.existsSync(record.worktreePath!)).toBe(true);

      await ws.manager.kill("reviewer");
      await ws.manager.spawn("fixer", { cmd: "sh", reuseWorktree: { delegationId: record.id, ownsSubset: ["src"] }, reveal: false });
      const fixerArgs = newSessionArgs.find((args) => args[args.indexOf("-s") + 1] === ws.manager.session("fixer"))!;
      expect(fixerArgs[fixerArgs.indexOf("-c") + 1]).toBe(record.worktreePath);
      expect(readDelegationRecord(recordPath).fixerAttempts?.[0]).toMatchObject({ occupantAgent: "fixer", requestedOwnsSubset: ["src"] });

      const legacyPath = writeDelegationRecord(root, {
        id: "legacy-no-worktree-path",
        agent: "legacy",
        baseSha: "base",
        taskRef: "tachyon/legacy-missing",
        owns: ["src"],
        behaviorTest: "legacy behavior",
        contract: { task: "legacy" },
        createdAt: "2026-07-08T00:00:00.000Z",
      });
      expect(readDelegationRecord(legacyPath).worktreePath).toBeUndefined();
      await expect(
        ws.manager.spawn("legacy-fixer", { cmd: "sh", reuseWorktree: { delegationId: "legacy-no-worktree-path", ownsSubset: ["src"] }, reveal: false }),
      ).rejects.toThrow(/legacy record with no persisted worktreePath/);

      ws.dispose();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
