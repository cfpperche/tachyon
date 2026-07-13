import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../../src/workspace/Workspace.js";
import type { EngineHost, NoticeAction, ViewKind } from "../../src/workspace/EngineHost.js";
import { TmuxService, type ExecResult } from "../../src/tmux/TmuxService.js";
import type { NotifyLevel } from "../../src/bridge/tools.js";
import { agentLogId } from "../../src/activity/logStore.js";

/**
 * spec 241 — headless validation of the continuity WIRING (not just the pure classifier): drive the real
 * Workspace public methods through `createForTest` + a fake tmux that CAPTURES send-keys, and assert the
 * read-brief → classify → inject-into-pane + state-transition side effects. This is as far as the dogfood
 * goes without a GUI / a real claude agent obeying the nudge.
 */

class FakeHost implements EngineHost {
  t = (m: string, ...a: (string | number | boolean)[]): string => m.replace(/\{(\d+)\}/g, (_x, i) => String(a[Number(i)] ?? ""));
  notify(_m: string, _l: NotifyLevel = "info", _act?: NoticeAction[]): void {}
  focusPrimaryView(): void {}
  executeCommand(command: string): Promise<unknown> {
    return Promise.reject(new Error(`unexpected host command in headless test: ${command}`));
  }
  watch(): { dispose(): void } {
    return { dispose() {} };
  }
  getSetting<T>(_s: string, _k: string, d: T): T {
    return d;
  }
  globalStoragePath(): string {
    return this.storageDir;
  }
  getState<T>(_k: string): T | undefined {
    return undefined;
  }
  setState(): void {}
  private readonly secrets = new Map<string, string>();
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
  mediaPath(...s: string[]): string {
    return path.join(this.storageDir, ...s);
  }
  webviewRoot(): unknown {
    return undefined;
  }
  onViewsChanged(_v: ViewKind): void {}
  constructor(private readonly storageDir: string) {}
}

/** fake tmux that records the literal text of every pane injection (send-keys -l OR bracketed paste via load-buffer). */
function capturingTmux() {
  const sessions = new Set<string>();
  const sent: string[] = [];
  const exec = async (args: string[]): Promise<ExecResult> => {
    if (args.includes("new-session")) {
      sessions.add(args[args.indexOf("-s") + 1]);
      return { stdout: "", stderr: "" };
    }
    if (args[2] === "has-session") {
      const name = args[args.indexOf("-t") + 1].replace(/^=/, "");
      if (sessions.has(name)) return { stdout: "", stderr: "" };
      throw new Error("no session");
    }
    // Short payloads: send-keys -l (run() prefixes 2 args → index 2 is the subcommand).
    if (args[2] === "send-keys" && args.includes("-l")) sent.push(args[args.length - 1]);
    // Multi-line / long payloads (t-17d7ea): load-buffer <path> then paste-buffer — capture file text.
    if (args[2] === "load-buffer") {
      const file = args[args.length - 1];
      if (file && fs.existsSync(file)) {
        try {
          sent.push(fs.readFileSync(file, "utf8"));
        } catch {
          /* ignore */
        }
      }
    }
    return { stdout: "", stderr: "" };
  };
  return { sessions, sent, tmux: new TmuxService(exec) };
}

const dirs: string[] = [];
const mkdir = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cont-wire-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function makeWs(config = "agents:\n  claude:\n    cmd: claude\n", agent = "claude") {
  const root = mkdir();
  fs.writeFileSync(path.join(root, "tachyon.yml"), config, "utf8");
  const { tmux, sessions, sent } = capturingTmux();
  const ws = await Workspace.createForTest(root, { host: new FakeHost(mkdir()), onViewsChanged: () => {} }, { tmux, startBridge: false });
  await ws.manager.spawn(agent); // populates the fake session so hasSession() is true
  return { ws, root, sessions, sent };
}

async function reloadWs(root: string, tmux: TmuxService) {
  return Workspace.createForTest(root, { host: new FakeHost(mkdir()), onViewsChanged: () => {} }, { tmux, startBridge: false });
}

function appendActivity(root: string, agent: string, n: number): void {
  const dir = path.join(root, ".tachyon", "activity");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${agentLogId(agent)}.jsonl`);
  fs.appendFileSync(file, Array.from({ length: n }, (_x, i) => JSON.stringify({ schemaVersion: 1, i })).join("\n") + "\n", "utf8");
}

type WorkspacePrivates = {
  maybeRemindCheckpoint(agent: string): Promise<void>;
  maybeRemindHandoff(agent: string): Promise<void>;
};
const priv = (ws: Workspace): WorkspacePrivates => ws as unknown as WorkspacePrivates;

describe("continuity wiring (spec 241, headless via Workspace.createForTest)", () => {
  it("automatic injectContinuity stays silent and leaves discontinuity for runtime-native hooks", async () => {
    const { ws, sent } = await makeWs("agents:\n  claude:\n    cmd: claude\n");
    ws.continuityStore.write("claude", "# Current Goal\nship 241", { sourceActivitySeq: 0 });
    ws.continuityState.markDiscontinuity("claude", 5);
    await ws.injectContinuity("claude", "compaction-idle");
    expect(sent.length).toBe(0);
    expect(ws.continuityState.read("claude").discontinuitySinceRestore).toBe(true);
  });

  it("D3: clean resume and post-compaction resume are both silent automatically", async () => {
    const { ws, sent } = await makeWs("agents:\n  claude:\n    cmd: claude\n");
    ws.continuityStore.write("claude", "# Current Goal\nx", {});
    await ws.injectContinuity("claude", "resume"); // no discontinuity flag → must stay silent
    expect(sent.length).toBe(0);
    ws.continuityState.markDiscontinuity("claude");
    await ws.injectContinuity("claude", "resume");
    expect(sent.length).toBe(0);
  });

  it("cold start (no brief) does not inject a create-first-brief nudge automatically", async () => {
    const { ws, sent } = await makeWs("agents:\n  claude:\n    cmd: claude\n");
    ws.continuityState.markDiscontinuity("claude");
    await ws.injectContinuity("claude", "compaction-idle");
    expect(sent.length).toBe(0);
  });

  it("spec 307: plain ad-hoc Codex and Claude children do not receive automatic cold-start continuity nudges", async () => {
    const { ws, sent } = await makeWs();
    await ws.manager.spawn("codex-child", { cmd: "codex", parent: "claude", reveal: false });
    await ws.manager.spawn("claude-child", { cmd: "claude", parent: "claude", reveal: false });

    for (const agent of ["codex-child", "claude-child"]) {
      ws.continuityState.markDiscontinuity(agent);
      await ws.injectContinuity(agent, "compaction-idle");
    }

    expect(sent.some((s) => s.includes('set_continuity(agent: "codex-child"'))).toBe(false);
    expect(sent.some((s) => s.includes('set_continuity(agent: "claude-child"'))).toBe(false);
  });

  it("spec 312: automatic checkpoint and handoff pane reminders are suppressed for declared agents with silent hooks", async () => {
    const { ws, root, sent } = await makeWs();
    await ws.manager.spawn("codex-child", { cmd: "codex", parent: "claude", reveal: false });
    appendActivity(root, "claude", 30);
    appendActivity(root, "codex-child", 30);

    await priv(ws).maybeRemindCheckpoint("codex-child");
    await priv(ws).maybeRemindHandoff("codex-child");
    expect(sent.length).toBe(0);

    await priv(ws).maybeRemindCheckpoint("claude");
    await priv(ws).maybeRemindHandoff("claude");
    expect(sent.some((s) => s.includes('set_continuity(agent: "claude"'))).toBe(false);
    expect(sent.some((s) => s.includes("append_project_handoff_note"))).toBe(false);
  });

  it("spec 312: silent hook suppression survives a VS Code reload while the tmux session keeps running", async () => {
    const { ws, root, sent } = await makeWs();
    const tmux = (ws as unknown as { tmux: TmuxService }).tmux;
    const reloaded = await reloadWs(root, tmux);
    appendActivity(root, "claude", 30);

    await priv(reloaded).maybeRemindCheckpoint("claude");
    await priv(reloaded).maybeRemindHandoff("claude");

    expect(sent.some((s) => s.includes('set_continuity(agent: "claude"'))).toBe(false);
    expect(sent.some((s) => s.includes("append_project_handoff_note"))).toBe(false);
  });

  it("spec 312 / t-7bcba6: automatic pane reminders stay suppressed for declared agents (no visible-legacy path)", async () => {
    const { ws, root, sent } = await makeWs("agents:\n  claude:\n    cmd: claude\n");
    appendActivity(root, "claude", 30);

    await priv(ws).maybeRemindCheckpoint("claude");
    await priv(ws).maybeRemindHandoff("claude");
    expect(sent.some((s) => s.includes('set_continuity(agent: "claude"'))).toBe(false);
    expect(sent.some((s) => s.includes("append_project_handoff_note"))).toBe(false);
    // Hooks remain the supported path — health is active, not disabled by a kill switch.
    expect(ws.persistenceHookHealth("claude")).toMatchObject({ state: "active" });
  });

  it("t-1a808e: declared Codex model overrides still receive silent persistence hooks", async () => {
    const { ws } = await makeWs(
      "agents:\n  codex:\n    cmd: codex -c model=gpt-5.6-sol -c model_reasoning_effort=xhigh\n",
      "codex",
    );

    expect(ws.persistenceHookHealth("codex")).toMatchObject({ state: "active" });
  });

  it("spec 312: no visible fallback remains when Claude --settings prevents hook injection", async () => {
    const { ws, root, sent } = await makeWs("agents:\n  claude:\n    cmd: claude --settings custom.json\n");
    appendActivity(root, "claude", 30);

    await priv(ws).maybeRemindCheckpoint("claude");
    await priv(ws).maybeRemindHandoff("claude");
    expect(sent.some((s) => s.includes('set_continuity(agent: "claude"'))).toBe(false);
    expect(sent.some((s) => s.includes("append_project_handoff_note"))).toBe(false);
    expect(ws.persistenceHookHealth("claude")).toMatchObject({ state: "skipped" });
  });

  it("spec 316: persistence hook health reports active and failed from current-spawn evidence plus failure ledger", async () => {
    const { ws, root } = await makeWs();
    expect(ws.persistenceHookHealth("claude")).toMatchObject({ state: "active" });

    const failureFile = path.join(root, ".tachyon", "activity", "persistence-hooks-failures.jsonl");
    fs.mkdirSync(path.dirname(failureFile), { recursive: true });
    fs.appendFileSync(failureFile, JSON.stringify({
      agent: "claude",
      event: "SessionStart",
      script: "continuity-pointer",
      path: "/bad/path",
      reason: "syntax-error",
      ts: "2999-01-01T00:00:00.000Z",
    }) + "\n");

    expect(ws.persistenceHookHealth("claude")).toMatchObject({
      state: "failed",
      reason: "syntax-error",
      script: "continuity-pointer",
      path: "/bad/path",
    });
  });

  it("spec 316: persistence hook health treats stale or absent evidence conservatively", async () => {
    const root = mkdir();
    fs.writeFileSync(path.join(root, "tachyon.yml"), "agents:\n  claude:\n    cmd: claude\n", "utf8");
    const cold = await Workspace.createForTest(root, { host: new FakeHost(mkdir()), onViewsChanged: () => {} }, { tmux: capturingTmux().tmux, startBridge: false });
    expect(cold.persistenceHookHealth("claude")).toMatchObject({ state: "unknown" });

    const { ws, root: liveRoot } = await makeWs();
    const active = ws.persistenceHookHealth("claude");
    expect(active).toMatchObject({ state: "active" });
    const updatedAt = active?.state === "active" ? active.updatedAt : "2026-07-01T00:00:00.000Z";
    const failureFile = path.join(liveRoot, ".tachyon", "activity", "persistence-hooks-failures.jsonl");
    fs.mkdirSync(path.dirname(failureFile), { recursive: true });
    fs.appendFileSync(failureFile, JSON.stringify({ agent: "claude", event: "SessionStart", script: "continuity-pointer", path: "/old", reason: "old", ts: "2000-01-01T00:00:00.000Z" }) + "\n");
    expect(ws.persistenceHookHealth("claude")).toMatchObject({ state: "active" });

    fs.appendFileSync(failureFile, JSON.stringify({ agent: "claude", event: "SessionStart", script: "continuity-pointer", path: "/tie", reason: "tie", ts: updatedAt }) + "\n");
    expect(ws.persistenceHookHealth("claude")).toMatchObject({ state: "active" });

    fs.appendFileSync(failureFile, JSON.stringify({ agent: "claude", event: "SessionStart", script: "continuity-pointer", path: "/bad-ts", reason: "bad-ts", ts: "not-a-date" }) + "\n");
    expect(ws.persistenceHookHealth("claude")).toMatchObject({ state: "failed", reason: "bad-ts" });
  });

  it("spec 309: cold-start checkpoint reminder is retired, even after new activity", async () => {
    const { ws, root, sent } = await makeWs("agents:\n  claude:\n    cmd: claude\n");
    appendActivity(root, "claude", 30);

    await priv(ws).maybeRemindCheckpoint("claude");
    appendActivity(root, "claude", 1);
    await priv(ws).maybeRemindCheckpoint("claude");
    expect(sent.filter((s) => s.includes('set_continuity(agent: "claude"')).length).toBe(0);
  });

  it("spec 307: fork/worktree ad-hoc rows are still default-off for automatic nudges", async () => {
    const { ws, root, sent } = await makeWs();
    await ws.manager.spawn("codex-child", { cmd: "codex", parent: "claude", reveal: false });
    const rec = ws.ledger.get("codex-child")!;
    ws.ledger.record("codex-child", {
      ...rec,
      def: { ...rec.def!, fork: true },
      worktree: { path: path.join(root, ".tachyon", "worktrees", "codex-child"), branch: "b", tachyonCreatedBranch: true, baseRef: "HEAD", createdAt: "t0" },
    });
    appendActivity(root, "codex-child", 30);

    ws.continuityState.markDiscontinuity("codex-child");
    await ws.injectContinuity("codex-child", "compaction-idle");
    await priv(ws).maybeRemindCheckpoint("codex-child");
    await priv(ws).maybeRemindHandoff("codex-child");

    expect(sent.length).toBe(0);
  });

  it("spec 307: UI-origin manual reinject is allowed for ad-hoc, generic manual calls are suppressed", async () => {
    const { ws, sent } = await makeWs();
    await ws.manager.spawn("codex-child", { cmd: "codex", parent: "claude", reveal: false });

    await ws.injectContinuity("codex-child", "manual");
    expect(sent.length).toBe(0);

    await ws.injectContinuity("codex-child", "manual", { origin: "ui" });
    expect(sent.some((s) => s.includes('set_continuity(agent: "codex-child"'))).toBe(true);
  });

  it("a malformed brief stays silent automatically + does NOT clear the discontinuity", async () => {
    const { ws, sent } = await makeWs("agents:\n  claude:\n    cmd: claude\n");
    fs.mkdirSync(ws.continuityStore.dir, { recursive: true });
    fs.writeFileSync(ws.continuityStore.pathOf("claude"), "garbage no frontmatter", "utf8");
    ws.continuityState.markDiscontinuity("claude");
    await ws.injectContinuity("claude", "compaction-idle");
    expect(sent.some((s) => s.includes("malformed"))).toBe(false);
    expect(ws.continuityState.read("claude").discontinuitySinceRestore).toBe(true); // still outstanding
  });

  it("manual UI reinject can still warn for a malformed brief", async () => {
    const { ws, root, sent } = await makeWs("agents:\n  claude:\n    cmd: claude\n");
    fs.mkdirSync(ws.continuityStore.dir, { recursive: true });
    fs.writeFileSync(ws.continuityStore.pathOf("claude"), "garbage no frontmatter", "utf8");
    appendActivity(root, "claude", 30);

    await ws.injectContinuity("claude", "manual", { origin: "ui" });
    expect(sent.filter((s) => s.includes("malformed")).length).toBe(1);
    expect(ws.continuityState.read("claude").lastNudgeSeq).toBe(30);
  });

  it("continuityBadge: missing → fresh after a write", async () => {
    const { ws } = await makeWs();
    expect(ws.continuityBadge("claude")).toBe("missing");
    ws.continuityStore.write("claude", "# Current Goal\nx", { sourceActivitySeq: 0 });
    expect(ws.continuityBadge("claude")).toBe("fresh");
  });

  it("snapshotContinuityForFork copies a paused snapshot with fork provenance + a re-scope note (D8)", async () => {
    const { ws } = await makeWs();
    ws.continuityStore.write("claude", "# Current Goal\nparent work", { sourceSessionId: "sess-1" });
    ws.snapshotContinuityForFork("claude", "claude-fork");
    const fork = ws.continuityStore.read("claude-fork")!;
    expect(fork.meta.status).toBe("paused");
    expect(fork.meta.forked_from_agent).toBe("claude");
    expect(fork.meta.forked_from_session_id).toBe("sess-1");
    expect(fork.body).toContain("Inherited from `claude`");
  });

  it("removeContinuity reaps the brief + state on delete", async () => {
    const { ws } = await makeWs();
    ws.continuityStore.write("claude", "# Current Goal\nx", {});
    ws.continuityState.markDiscontinuity("claude");
    ws.removeContinuity("claude");
    expect(ws.continuityStore.exists("claude")).toBe(false);
    expect(ws.continuityState.read("claude").discontinuitySinceRestore).toBe(false);
  });
});
