import { createWorkspaceForTest } from "@tachyon/engine/bridge/workspaceComposition.js";
import { useDisposableRuntimeAuth } from "../helpers/optionalRuntimeAuth.js";
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "@tachyon/engine/workspace/Workspace.js";
import type { EngineHost, NoticeAction, ViewKind } from "@tachyon/engine/workspace/EngineHost.js";
import { TmuxService, type ExecResult } from "@tachyon/engine/tmux/TmuxService.js";
import type { NotifyLevel } from "@tachyon/engine/workspace/EngineHost.js";
import { writeSavedAgent, savedAgentSecrets, savedAgentsYaml } from "../helpers/savedAgentFixture.js";
import type { AttestedRuntime } from "@tachyon/shared/runtime/attestedRuntimes.js";
import { agentLogId } from "@tachyon/engine/activity/logStore.js";

/**
 * spec 241 — headless validation of the continuity WIRING (not just the pure classifier): drive the real
 * Workspace public methods through `createForTest` + a fake tmux that CAPTURES send-keys, and assert the
 * read-brief → classify → inject-into-pane + state-transition side effects. This is as far as the dogfood
 * goes without a GUI / a real claude agent obeying the nudge.
 */

class FakeHost implements EngineHost {
  t = (m: string, ...a: (string | number | boolean)[]): string => m.replace(/\{(\d+)\}/g, (_x, i) => String(a[Number(i)] ?? ""));
  readonly notifications: Array<{ message: string; level: NotifyLevel }> = [];
  notify(message: string, level: NotifyLevel = "info", _act?: NoticeAction[]): void {
    this.notifications.push({ message, level });
  }
  focusPrimaryView(): void {}
  openTask(): void {}
  executeCommand(command: string): Promise<unknown> {
    return Promise.reject(new Error(`unexpected host command in headless test: ${command}`));
  }
  watch(): { dispose(): void } {
    return { dispose() {} };
  }
  gitExtensionPath(): string | string[] | undefined { return undefined; }
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

/** Carries the host-custodied authority the canonical agents below are attested by. */
class SecretHost extends FakeHost {
  constructor(storageDir: string, private readonly backend: Map<string, string>) {
    super(storageDir);
  }
  override getSecret(key: string): Promise<string | undefined> {
    return Promise.resolve(this.backend.get(key));
  }
  override setSecret(key: string, value: string): Promise<void> {
    this.backend.set(key, value);
    return Promise.resolve();
  }
}

/**
 * SDD 478 M7 — continuity is an Agent capability, so these cases need a REAL agent: a canonical
 * profile plus the authority that attests it. They used to declare `agents: <name>: cmd: <runtime>`
 * inline, a shape the product refuses and only `allowLegacyAgentFixtures` kept alive.
 */
async function makeWs(agent = "claude", runtime: AttestedRuntime = "claude", selectors?: { model?: string; reasoningEffort?: string }) {
  const root = mkdir();
  const fixture = writeSavedAgent(root, agent, { runtime, ...(selectors ? { selectors } : {}) });
  const secrets = savedAgentSecrets(root, [fixture]);
  fs.writeFileSync(path.join(root, "tachyon.yml"), savedAgentsYaml([fixture]), "utf8");
  const { tmux, sessions, sent } = capturingTmux();
  const host = new SecretHost(mkdir(), secrets);
  const ws = await createWorkspaceForTest(root, { host, onViewsChanged: () => {} }, { tmux, startBridge: false });
  await ws.manager.spawn(agent); // populates the fake session so hasSession() is true
  return { ws, root, sessions, sent, secrets, host };
}

async function reloadWs(root: string, tmux: TmuxService, secrets: Map<string, string>) {
  return createWorkspaceForTest(root, { host: new SecretHost(mkdir(), secrets), onViewsChanged: () => {} }, { tmux, startBridge: false });
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
  runSchedule(name: string, def: { spawn: string; instructions?: string }): Promise<void>;
};
const priv = (ws: Workspace): WorkspacePrivates => ws as unknown as WorkspacePrivates;

/**
 * t-a12966 — the claude and codex credential these cases need is SUBSTRATE: the harness materializer links a
 * credential file so the spawn can proceed, and nothing below launches a real runtime. Listing the
 * titles here for `skipTestsWithoutOptionalRuntimeAuth` made the result depend on whether the HOST was
 * logged in — measured green on the maintainer's checkout and pending in every agent worktree with a
 * private, credential-free config home. Injected through the door production reads instead.
 */
useDisposableRuntimeAuth(["claude", "codex"]);

describe("continuity wiring (spec 241, headless via Workspace.createForTest)", () => {
  it("automatic injectContinuity stays silent and leaves discontinuity for runtime-native hooks", async () => {
    const { ws, sent } = await makeWs();
    ws.continuityStore.write("claude", "# Current Goal\nship 241", { sourceActivitySeq: 0 });
    ws.continuityState.markDiscontinuity("claude", 5);
    await ws.injectContinuity("claude", "compaction-idle");
    expect(sent.length).toBe(0);
    expect(ws.continuityState.read("claude").discontinuitySinceRestore).toBe(true);
  });

  it("D3: clean resume and post-compaction resume are both silent automatically", async () => {
    const { ws, sent } = await makeWs();
    ws.continuityStore.write("claude", "# Current Goal\nx", {});
    await ws.injectContinuity("claude", "resume"); // no discontinuity flag → must stay silent
    expect(sent.length).toBe(0);
    ws.continuityState.markDiscontinuity("claude");
    await ws.injectContinuity("claude", "resume");
    expect(sent.length).toBe(0);
  });

  it("cold start (no brief) does not inject a create-first-brief nudge automatically", async () => {
    const { ws, sent } = await makeWs();
    ws.continuityState.markDiscontinuity("claude");
    await ws.injectContinuity("claude", "compaction-idle");
    expect(sent.length).toBe(0);
  });

  it("spec 307: plain Temporary Codex and Claude children do not receive automatic cold-start continuity nudges", async () => {
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
    const { ws, root, sent, secrets } = await makeWs();
    const tmux = (ws as unknown as { tmux: TmuxService }).tmux;
    const reloaded = await reloadWs(root, tmux, secrets);
    appendActivity(root, "claude", 30);

    await priv(reloaded).maybeRemindCheckpoint("claude");
    await priv(reloaded).maybeRemindHandoff("claude");

    expect(sent.some((s) => s.includes('set_continuity(agent: "claude"'))).toBe(false);
    expect(sent.some((s) => s.includes("append_project_handoff_note"))).toBe(false);
  });

  it("spec 312 / t-7bcba6: automatic pane reminders stay suppressed for declared agents (no visible-legacy path)", async () => {
    const { ws, root, sent } = await makeWs();
    appendActivity(root, "claude", 30);

    await priv(ws).maybeRemindCheckpoint("claude");
    await priv(ws).maybeRemindHandoff("claude");
    expect(sent.some((s) => s.includes('set_continuity(agent: "claude"'))).toBe(false);
    expect(sent.some((s) => s.includes("append_project_handoff_note"))).toBe(false);
    // Hooks remain the supported path — health is active, not disabled by a kill switch.
    expect(ws.persistenceHookHealth("claude")).toMatchObject({ state: "active" });
  });

  it("t-1a808e: declared Codex model overrides still receive silent persistence hooks", async () => {
    // SDD 478 M7 — a canonical agent expresses a model override as TYPED SELECTORS, not argv: the
    // profile carries model/reasoningEffort and the launcher composes `-c model=…` itself. The
    // assertion is unchanged, because what is being tested is that selectors do not suppress hooks.
    const { ws } = await makeWs("codex", "codex", { model: "gpt-5.6-sol", reasoningEffort: "xhigh" });

    expect(ws.persistenceHookHealth("codex")).toMatchObject({ state: "active" });
  });

  it("spec 312: no visible fallback remains when hook injection did not happen for this spawn", async () => {
    // SDD 478 M7 — this used to declare `cmd: claude --settings custom.json`, i.e. a USER-owned
    // settings layer that displaced Tachyon's. A canonical agent cannot express that: Tachyon owns
    // `--settings` on every canonical Claude launch (the closed private-home contract), so the
    // trigger is unreachable by design rather than merely unconfigured. What the case is really
    // guarding — that an inactive hook state produces NO visible pane fallback — is asserted
    // directly against that state instead of through a command shape the product refuses.
    const { ws, root, sent } = await makeWs();
    (ws as unknown as { writeSilentPersistenceHookState(agent: string, active: boolean): void })
      .writeSilentPersistenceHookState("claude", false);
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
    const coldAgent = writeSavedAgent(root, "claude", { runtime: "claude" });
    fs.writeFileSync(path.join(root, "tachyon.yml"), savedAgentsYaml([coldAgent]), "utf8");
    const cold = await createWorkspaceForTest(
      root,
      { host: new SecretHost(mkdir(), savedAgentSecrets(root, [coldAgent])), onViewsChanged: () => {} },
      { tmux: capturingTmux().tmux, startBridge: false },
    );
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
    const { ws, root, sent } = await makeWs();
    appendActivity(root, "claude", 30);

    await priv(ws).maybeRemindCheckpoint("claude");
    appendActivity(root, "claude", 1);
    await priv(ws).maybeRemindCheckpoint("claude");
    expect(sent.filter((s) => s.includes('set_continuity(agent: "claude"')).length).toBe(0);
  });

  it("spec 307: fork/worktree Temporary rows are still default-off for automatic nudges", async () => {
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

  it("spec 307: UI-origin manual reinject is allowed for a Temporary, generic manual calls are suppressed", async () => {
    const { ws, sent } = await makeWs();
    await ws.manager.spawn("codex-child", { cmd: "codex", parent: "claude", reveal: false });

    await ws.injectContinuity("codex-child", "manual");
    expect(sent.length).toBe(0);

    await ws.injectContinuity("codex-child", "manual", { origin: "ui" });
    expect(sent.some((s) => s.includes('set_continuity(agent: "codex-child"'))).toBe(true);
  });

  it("a malformed brief stays silent automatically + does NOT clear the discontinuity", async () => {
    const { ws, sent } = await makeWs();
    fs.mkdirSync(ws.continuityStore.dir, { recursive: true });
    fs.writeFileSync(ws.continuityStore.pathOf("claude"), "garbage no frontmatter", "utf8");
    ws.continuityState.markDiscontinuity("claude");
    await ws.injectContinuity("claude", "compaction-idle");
    expect(sent.some((s) => s.includes("malformed"))).toBe(false);
    expect(ws.continuityState.read("claude").discontinuitySinceRestore).toBe(true); // still outstanding
  });

  it("manual UI reinject can still warn for a malformed brief", async () => {
    const { ws, root, sent } = await makeWs();
    fs.mkdirSync(ws.continuityStore.dir, { recursive: true });
    fs.writeFileSync(ws.continuityStore.pathOf("claude"), "garbage no frontmatter", "utf8");
    appendActivity(root, "claude", 30);

    await ws.injectContinuity("claude", "manual", { origin: "ui" });
    expect(sent.filter((s) => s.includes("malformed")).length).toBe(1);
    expect(ws.continuityState.read("claude").lastNudgeSeq).toBe(30);
  });

  it("t-ff34db O: a lost continuity Enter stays unconfirmed instead of marking the brief restored", async () => {
    const { ws, root } = await makeWs();
    ws.continuityStore.write("claude", "# Current Goal\nship the fix", { sourceActivitySeq: 0 });
    appendActivity(root, "claude", 30);
    ws.continuityState.markDiscontinuity("claude", 30);
    const tmux = (ws as unknown as { tmux: TmuxService }).tmux;
    const submit = vi.spyOn(tmux, "sendSubmittedLine").mockResolvedValue({
      status: "submit-unconfirmed",
      reason: "still-staged",
      attempts: 4,
    });

    await ws.injectContinuity("claude", "manual", { origin: "ui" });

    expect(submit).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("Continuity available"),
      expect.objectContaining({ composer: expect.any(Object) }),
    );
    expect(ws.continuityState.read("claude").discontinuitySinceRestore).toBe(true);
    expect(ws.continuityState.read("claude").lastNudgeSeq).toBeUndefined();
  });

  it("t-ff34db P: a lost schedule Enter is reported as unconfirmed instead of sent", async () => {
    const { ws, host } = await makeWs();
    vi.spyOn(ws.manager, "runningAgents").mockResolvedValue(["claude"]);
    const tmux = (ws as unknown as { tmux: TmuxService }).tmux;
    const submit = vi.spyOn(tmux, "sendSubmittedLine").mockResolvedValue({
      status: "submit-unconfirmed",
      reason: "still-staged",
      attempts: 4,
    });

    await priv(ws).runSchedule("standup", { spawn: "claude", instructions: "summarize progress" });

    expect(submit).toHaveBeenCalledWith(
      expect.any(String),
      "summarize progress",
      expect.objectContaining({ composer: expect.any(Object) }),
    );
    expect(host.notifications).toContainEqual({
      message: "schedule 'standup' instructions were typed but submission could not be confirmed",
      level: "warn",
    });
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
