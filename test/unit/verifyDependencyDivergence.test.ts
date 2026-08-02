import { describe, expect, it, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../../src/workspace/Workspace.js";
import type { EngineHost, NoticeAction, ViewKind, WatchEvents } from "../../src/workspace/EngineHost.js";
import { TmuxService, type ExecResult } from "../../src/tmux/TmuxService.js";
import type { NotifyLevel } from "../../src/bridge/tools.js";
import { DEPENDENCY_DIR, shareDependencies } from "../../src/worktree/dependencySharing.js";
import { __resetVscodeMock } from "../mocks/vscode.js";

/**
 * t-3f93b4 — the verify gate refuses to grade a worktree whose shared dependencies no longer match it.
 *
 * Creation and relaunch both re-decide sharing, so a rebase between launches is caught. The door
 * neither of them covers is the agent editing `package-lock.json` at 10:00 and running the gate at
 * 10:05 — nothing relaunches in between. That run would produce a recorded, durable green computed
 * from the PRIMARY checkout's packages while claiming to be about this branch's tree: a plausible
 * value where "I don't know" belongs, which is the defect family `t-b4a799` catalogued.
 *
 * `runVerify` already refuses three ways to be unable to answer (no worktree, worktree gone, no gate
 * declared). This is the fourth, and it is a refusal for the same reason, not a new policy gate.
 */
class FakeHost implements EngineHost {
  readonly notices: { message: string; level: NotifyLevel }[] = [];
  private readonly stateMap = new Map<string, unknown>();
  private readonly secrets = new Map<string, string>();
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
  getSecret(key: string): Promise<string | undefined> { return Promise.resolve(this.secrets.get(key)); }
  setSecret(key: string, value: string): Promise<void> { this.secrets.set(key, value); return Promise.resolve(); }
  appVersion(): string { return "0.0.0-test"; }
  mediaPath(...segments: string[]): string { return path.join(this.storageDir, ...segments); }
  webviewRoot(): unknown { return undefined; }
  onViewsChanged(_view: ViewKind): void {}
  constructor(private readonly storageDir: string) {}
}

function fakeTmux(): TmuxService {
  const exec = async (args: string[]): Promise<ExecResult> => {
    if (args[2] === "has-session") throw new Error("can't find session");
    if (args[2] === "list-panes" || args[2] === "list-sessions") return { stdout: "", stderr: "" };
    return { stdout: "", stderr: "" };
  };
  return new TmuxService(exec);
}

const dirs: string[] = [];
const mkdir = (prefix: string): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  __resetVscodeMock();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8" });

/** A primary checkout with a lockfile and an installed `node_modules`, plus a worktree linked to it. */
async function workspaceWithLinkedChild() {
  const root = mkdir("verify-deps-root-");
  git(["init", "-b", "main"], root);
  git(["config", "user.email", "t@t.dev"], root);
  git(["config", "user.name", "T"], root);
  fs.writeFileSync(path.join(root, "package-lock.json"), '{"lockfileVersion":3}');
  fs.writeFileSync(path.join(root, ".gitignore"), `${DEPENDENCY_DIR}\n`);
  git(["add", "-A"], root);
  git(["commit", "-m", "init"], root);
  fs.mkdirSync(path.join(root, DEPENDENCY_DIR));

  const base = mkdir("verify-deps-base-");
  fs.writeFileSync(
    path.join(root, "tachyon.yml"),
    `terminals:\n  shell:\n    cmd: sh\nsettings:\n  worktree:\n    base: ${JSON.stringify(base)}\n    verify: "exit 0"\n`,
    "utf8",
  );

  const ws = await Workspace.createForTest(
    root,
    { host: new FakeHost(mkdir("verify-deps-store-")), onViewsChanged: () => {} },
    { tmux: fakeTmux(), startBridge: false },
  );

  const wtPath = path.join(base, "child");
  git(["worktree", "add", "-b", "tachyon/tmp.child.x", wtPath, "HEAD"], root);
  const dependencies = shareDependencies({ workspaceRoot: root, worktreePath: wtPath });
  expect(dependencies?.mode).toBe("linked"); // precondition, not the assertion under test

  ws.ledger.record("child", {
    kind: "agent",
    cwd: wtPath,
    worktree: {
      path: wtPath,
      branch: "tachyon/tmp.child.x",
      tachyonCreatedBranch: true,
      baseRef: git(["rev-parse", "HEAD"], root).trim(),
      createdAt: new Date().toISOString(),
      dependencies,
    },
  } as Parameters<typeof ws.ledger.record>[1]);

  return { ws, root, wtPath, dependencies: dependencies! };
}

describe("t-3f93b4 — runVerify and a mid-session lockfile edit", () => {
  it("REFUSES to grade a worktree whose lockfile moved under the shared node_modules", async () => {
    const { ws, wtPath, dependencies } = await workspaceWithLinkedChild();

    // The agent adds a dependency. Nothing relaunches; the link still points at the primary's tree.
    fs.writeFileSync(path.join(wtPath, "package-lock.json"), '{"lockfileVersion":3,"added":"a-package-the-primary-does-not-have"}');

    await expect(ws.runVerify("child")).rejects.toThrow(/cannot be verified/);
    await expect(ws.runVerify("child")).rejects.toThrow(new RegExp(dependencies.lockDigest.slice(0, 12)));
    // No verdict was recorded: the refusal has to leave the badge un-green, not write a failing one.
    expect(ws.ledger.get("child")?.worktree?.verify).toBeUndefined();
  });

  it("says it out loud to the human as well, not only to the caller", async () => {
    const { ws, wtPath } = await workspaceWithLinkedChild();
    const host = (ws as unknown as { host: FakeHost }).host;
    fs.writeFileSync(path.join(wtPath, "package-lock.json"), '{"lockfileVersion":3,"added":"x"}');

    await expect(ws.runVerify("child")).rejects.toThrow();

    const spoken = host.notices.filter((n) => n.level === "error" && n.message.includes("cannot be verified"));
    expect(spoken).toHaveLength(1);
    expect(spoken[0]!.message).toContain("Replace the link with this branch's own install");
  });

  it("the recorded digest survives the ledger round-trip — without it the guard is dead code", async () => {
    // Found by the test above before it passed: `parseWorktree` rebuilds the row field by field and
    // dropped `dependencies` on the floor, so `auditSharedDependencies` read undefined and concluded
    // there was nothing to check. The guard existed and could never fire.
    const { ws, dependencies } = await workspaceWithLinkedChild();
    const persisted = ws.ledger.get("child")?.worktree?.dependencies;
    expect(persisted).toMatchObject({ mode: "linked", lockDigest: dependencies.lockDigest });
  });

  it("does NOT refuse while the lockfile still matches — the guard is divergence, not sharing", async () => {
    const { ws } = await workspaceWithLinkedChild();

    // The gate itself needs a runner this headless fixture does not provide, so assert on the reason
    // it stops: anything BUT the dependency refusal means the guard let it through.
    const failure = await ws.runVerify("child").then(() => undefined, (err: Error) => err);
    expect(failure?.message ?? "").not.toMatch(/cannot be verified/);
  });
});
