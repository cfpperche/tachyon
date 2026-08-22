import { writeWorkspaceConfig } from "../helpers/writeWorkspaceConfig.js";
import { createWorkspaceForTest } from "@tachyon/bridge/workspaceComposition.js";
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "@tachyon/engine/workspace/Workspace.js";
import { AgentMidTurnError } from "@tachyon/engine/agents/AgentManager.js";
import { TmuxService, type ExecResult } from "@tachyon/engine/tmux/TmuxService.js";
import type { EngineHost, NoticeAction, ViewKind, WatchEvents } from "@tachyon/engine/workspace/EngineHost.js";
import type { NotifyLevel } from "@tachyon/engine/workspace/EngineHost.js";
import type { TerminalPresentationOptions } from "@tachyon/engine/workspace/TerminalPresentation.js";
import { Terminals } from "../../apps/vscode-extension/src/presentation/Terminals.js";
import { planResume } from "@tachyon/engine/resume/planResume.js";
import { encodeClaudeCwd } from "@tachyon/shared/resume/adapters.js";
import { __resetVscodeMock } from "../mocks/vscode.js";
import { writeSavedAgent, savedAgentSecrets, savedAgentsYaml } from "../helpers/savedAgentFixture.js";
import { useDisposableRuntimeAuth } from "../helpers/optionalRuntimeAuth.js";

/**
 * t-a281e7 — `resume()` must not replace the process of an agent that is MID-TURN.
 *
 * Measured 2026-08-18 (`docs/research/t-83d04e-grok-parada-no-meio-do-turno.md`): five agents were
 * cut mid-sentence in two days. The relaunch uses `-r <sessionId>`, which restores the CONVERSATION
 * and not the TURN, so the in-flight work is discarded, the replacement comes up idle, and nobody is
 * told. The runtime's own ledger says it: `turn_ended outcome=cancelled
 * cancellation_category=mid_turn_abort trigger=ctrl_c`, at the same second `ps -o lstart` shows the
 * NEW process starting.
 *
 * **The names below are the card's ACTOR × TRIGGER table, one case per row**, which is this
 * repository's rule for a mechanism a second caller can reach (`docs/project-guidance.md`, "Who else
 * can reach this?"). Three rows come from the card. The last three are doors the card's table does
 * not list and that this suite found at the point of use — they are here so that "who else reaches
 * a process replacement" is answered in the tests rather than in a comment.
 *
 * These drive the real `Workspace`, the real `AgentManager` and a real `SessionLedger`; only the
 * tmux channel, the editor widget, and the attention snapshot are substituted. The refusal is
 * asserted through what tmux was actually asked to do — a spy on `resume` would pass just as
 * happily while the pane was replaced by the fallback underneath it.
 */

class FakeHost implements EngineHost {
  readonly notices: { message: string; level: NotifyLevel; actions: NoticeAction[] }[] = [];
  private readonly stateMap = new Map<string, unknown>();
  constructor(private readonly storageDir: string, private readonly backend: Map<string, string>) {}
  t = (message: string, ...args: (string | number | boolean)[]): string => message.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? ""));
  notify(message: string, level: NotifyLevel = "info", actions: NoticeAction[] = []): void {
    this.notices.push({ message, level, actions: [...actions] });
  }
  focusPrimaryView(): void {}
  openTask(): void {}
  executeCommand(command: string): Promise<unknown> {
    return Promise.reject(new Error(`unexpected host command in headless test: ${command}`));
  }
  watch(_root: string, _glob: string, _events: WatchEvents, _onEvent: () => void): { dispose(): void } {
    return { dispose() {} };
  }
  gitExtensionPath(): string | string[] | undefined { return undefined; }
  globalStoragePath(): string { return this.storageDir; }
  getState<T>(key: string): T | undefined { return this.stateMap.get(key) as T | undefined; }
  setState(key: string, value: unknown): void { this.stateMap.set(key, value); }
  getSecret(key: string): Promise<string | undefined> { return Promise.resolve(this.backend.get(key)); }
  setSecret(key: string, value: string): Promise<void> { this.backend.set(key, value); return Promise.resolve(); }
  appVersion(): string { return "0.0.0-test"; }
  mediaPath(...segments: string[]): string { return path.join(this.storageDir, ...segments); }
  webviewRoot(): unknown { return undefined; }
  createTerminalPresentation(options: TerminalPresentationOptions): Terminals {
    return new Terminals(options.onReveal, options.kindOf, options.manifest);
  }
  onViewsChanged(_view: ViewKind): void {}
}

/** fake-exec tmux (tmux global flags occupy args[0..1], so the verb is args[2]). */
function fakeTmux() {
  const sessions = new Set<string>();
  /** session -> exit code, mirroring a remain-on-exit dead pane. */
  const dead = new Map<string, number>();
  const calls: string[][] = [];
  const exec = async (args: string[]): Promise<ExecResult> => {
    calls.push(args);
    if (args.includes("new-session")) {
      const name = args[args.indexOf("-s") + 1]!;
      sessions.add(name);
      dead.delete(name);
      return { stdout: "", stderr: "" };
    }
    if (args[2] === "has-session") {
      const name = args[args.indexOf("-t") + 1]!.replace(/^=/, "");
      if (sessions.has(name)) return { stdout: "", stderr: "" };
      throw new Error("can't find session");
    }
    if (args[2] === "list-panes") {
      if (sessions.size === 0) throw new Error("error connecting to /tmp/tmux-1000/fake (No such file or directory)");
      return { stdout: [...sessions].map((s) => `${s}\t${dead.has(s) ? 1 : 0}\t${dead.get(s) ?? ""}`).join("\n") + "\n", stderr: "" };
    }
    if (args[2] === "list-sessions") {
      return { stdout: [...sessions].join("\n") + (sessions.size ? "\n" : ""), stderr: "" };
    }
    if (args[2] === "kill-session") {
      const name = args[args.indexOf("-t") + 1]!.replace(/^=/, "");
      sessions.delete(name);
      dead.delete(name);
    }
    return { stdout: "", stderr: "" };
  };
  return { sessions, dead, calls, tmux: new TmuxService(exec) };
}

const dirs: string[] = [];
function mkdir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  __resetVscodeMock();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * t-a12966 — the claude credential these cases need is SUBSTRATE, not subject. Spawning a Saved
 * claude agent materializes its isolated harness home, which refuses without a real credential to
 * link. Nothing below launches a real claude.
 */
useDisposableRuntimeAuth(["claude"]);

/** `worker` is a Saved AGENT; `dev` is a TERMINAL, which runs with attention monitoring OFF. */
async function makeWorkspace() {
  const root = mkdir("mid-turn-guard-");
  const fixtures = [writeSavedAgent(root, "worker", { runtime: "claude" })];
  writeWorkspaceConfig(root, savedAgentsYaml(fixtures) + "terminals:\n  dev:\n    cmd: sh\n");
  const host = new FakeHost(mkdir("mid-turn-guard-storage-"), savedAgentSecrets(root, fixtures));
  const fake = fakeTmux();
  const ws = await createWorkspaceForTest(root, { host, onViewsChanged: () => {} }, { tmux: fake.tmux, startBridge: false });
  return { root, ws, host, ...fake };
}

/**
 * Put `agent` mid-turn, through the door production reads it from.
 *
 * `Workspace.attentionOf` — which is what the guard is wired to — composes `monitor.stateOf` with
 * the completion-hint layer, so forcing the monitor snapshot exercises the real chain instead of
 * stubbing the answer the guard asks for. `hasStartedTurn: true` is the half that makes it a REAL
 * turn: `isEvidencedWorking` refuses a synthetic `working` on a pane that never started one, and
 * the last case below pins exactly that.
 */
function forceStateOf(ws: Workspace, agent: string, state: string, extra: Record<string, unknown> = {}) {
  const original = ws.monitor.stateOf.bind(ws.monitor);
  (ws.monitor as unknown as { stateOf(a: string): unknown }).stateOf = (a: string) =>
    a === agent ? { state, hasStartedTurn: state === "working", since: 0, contentSince: 0, outputStableSince: 0, episodeKey: "e", stalled: false, awaitingHuman: false, ...extra } : original(a);
}

/** Every tmux verb that would end the running process, in order. A refusal must add none of them. */
function destructiveCalls(calls: string[][]): string[] {
  return calls
    .filter((args) => args.includes("new-session") || args.includes("respawn-pane") || args[2] === "kill-session" || args[2] === "send-keys")
    .map((args) => args.filter((a) => a === "new-session" || a === "respawn-pane" || a === "kill-session" || a === "send-keys").join());
}

function launchCount(calls: string[][]): number {
  return calls.filter((args) => args.includes("new-session") || args.includes("respawn-pane")).length;
}

/** Materialize the transcript for the session the LAUNCH recorded, so resume has something real to reopen. */
function seedTranscriptOfLastSession(ws: Workspace, agent: string): string {
  const record = ws.ledger.get(agent);
  if (!record?.resume?.configHome) throw new Error(`fixture: launch recorded no resume block for '${agent}'`);
  const { sessionId, configHome } = record.resume;
  const projects = path.join(configHome, "projects", encodeClaudeCwd(record.cwd));
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(projects, `${sessionId}.jsonl`), "{}\n", "utf8");
  return sessionId;
}

/** The private field `resumeAllOffered` iterates — the offers computed at activation. */
function offerResumeOf(ws: Workspace, names: string[]) {
  (ws as unknown as { resumable: { name: string; record: unknown; action: string }[] }).resumable =
    names.map((name) => ({ name, record: ws.ledger.get(name)!, action: "offer" }));
}

describe("t-a281e7 — ACTOR × TRIGGER: who else can replace a live agent's process?", () => {
  it("Tachyon × reconciliation at start — a live session is REATTACH, and never reaches resume", async () => {
    // Row 1 of the card's table: "manter". The automatic door was already protected, and this pins
    // it so the guard below is not mistaken for the thing that protects it. `planResume` is pure, so
    // the classification is asserted directly rather than through a resume that must not happen.
    const record = { cwd: "/repo", resume: { runtime: "claude" as const, sessionId: "s1" } };
    const plan = planResume({
      ledger: new Map([["worker", record as never]]),
      declaredAutostart: new Set(["worker"]),
      liveSessions: new Set(["worker"]), // alive — mid-turn or not, activation must not touch it
    });
    expect(plan).toEqual([{ name: "worker", action: "reattach", record }]);
  });

  it("Interface × sidebar ↻ on an agent mid-turn — REFUSED, and the conversation is not thrown away", async () => {
    // Row 2. The second assertion is the one that matters most: `resumeAgent` answers a
    // `ResumeUnavailableError` by SPAWNING A FRESH SESSION, so a refusal typed as that class would
    // have upgraded "your agent is busy" into "your agent's conversation is gone".
    const { ws, calls, sessions } = await makeWorkspace();
    try {
      await ws.manager.spawn("worker");
      seedTranscriptOfLastSession(ws, "worker");
      forceStateOf(ws, "worker", "working");
      const before = [...destructiveCalls(calls)];

      await expect(ws.resumeAgent("worker")).rejects.toBeInstanceOf(AgentMidTurnError);

      expect(destructiveCalls(calls)).toEqual(before); // the running process was never touched
      expect(sessions.has(ws.manager.session("worker"))).toBe(true);
    } finally {
      ws.dispose();
    }
  });

  it("Interface × \"Resume all\" with an agent mid-turn — REFUSED, and the loop keeps the offer actionable", async () => {
    // Row 3. The measured incident was this shape: a sequential loop over the fleet, 3.15 s and
    // 3.24 s apart. One busy agent must be skipped without aborting the sweep, and must stay in the
    // offer list so the human can retry it when it goes idle.
    const { ws, host, calls, sessions } = await makeWorkspace();
    try {
      await ws.manager.spawn("worker");
      seedTranscriptOfLastSession(ws, "worker");
      forceStateOf(ws, "worker", "working");
      offerResumeOf(ws, ["worker"]);
      const before = [...destructiveCalls(calls)];

      await ws.resumeAllOffered(); // never throws — it reports per agent

      expect(destructiveCalls(calls)).toEqual(before);
      expect(sessions.has(ws.manager.session("worker"))).toBe(true);
      expect(ws.resumableAgents()).toEqual(["worker"]); // still offered, not silently dropped
      expect(host.notices.map((n) => n.message).join("\n")).toContain("mid-turn");
    } finally {
      ws.dispose();
    }
  });

  it("Agent × restart via Bridge — REFUSED BEFORE the stop phase, so the turn is still running", async () => {
    // Row 4, and the row whose stated premise only half held. The card reads restart as covered
    // because it "passes through the same resume". Measured at the point of use, that is true of one
    // mode out of three: `graceful + resume` stops BEFORE resuming, so a guard living only in
    // `resume()` meets a pane that is already dead; `force + new` never calls resume at all; only
    // `force + resume` respawns in place. That is the `t-e73e54` shape — one actor, another trigger —
    // so all three modes are asserted, and the assertion is that NOTHING was killed rather than
    // merely that restart threw.
    const { ws, calls, sessions } = await makeWorkspace();
    try {
      await ws.manager.spawn("worker");
      seedTranscriptOfLastSession(ws, "worker");
      forceStateOf(ws, "worker", "working");
      const before = [...destructiveCalls(calls)];

      for (const mode of [
        {}, // product default: graceful + resume, what restart_agent sends when told nothing
        { stop: "force", session: "resume" },
        { stop: "force", session: "new" },
      ] as const) {
        await expect(ws.manager.restart("worker", mode)).rejects.toBeInstanceOf(AgentMidTurnError);
      }

      expect(destructiveCalls(calls)).toEqual(before); // no graceful ^C, no kill, no respawn
      expect(sessions.has(ws.manager.session("worker"))).toBe(true);
    } finally {
      ws.dispose();
    }
  });

  it("Agent × restart of ITSELF — ALLOWED: the turn being discarded is the caller's own", async () => {
    // The ACTOR axis of row 4, and the case that keeps the refusal from deleting a declared
    // operation. An agent restarting itself is mid-turn by construction — the tool call it is making
    // IS the turn — so a guard that only looked at the target's state would refuse it forever: the
    // caller can never go idle while it is the one asking. `restart_agent` names "yourself" first in
    // its governance line, and the Bridge passes the AUTHENTICATED caller, so this cannot be reached
    // by claiming to be someone else.
    const { ws, calls } = await makeWorkspace();
    try {
      await ws.manager.spawn("worker");
      seedTranscriptOfLastSession(ws, "worker");
      forceStateOf(ws, "worker", "working");
      const before = launchCount(calls);

      await ws.manager.restart("worker", { stop: "force", initiatedBy: "worker" });

      expect(launchCount(calls)).toBeGreaterThan(before);
      // …and the exemption is keyed on identity, not on the flag merely being present.
      await expect(ws.manager.restart("worker", { stop: "force", initiatedBy: "someone-else" }))
        .rejects.toBeInstanceOf(AgentMidTurnError);
    } finally {
      ws.dispose();
    }
  });

  it("Tachyon × recovery after the process is gone — a dead pane has no turn to lose, so resume still runs", async () => {
    // Not in the card's table; found at the point of use. Crash recovery, restart's own
    // `tryResumeAfterStop`, and the spec-380 client rebind all call `resume()` AFTER the process is
    // dead. They pass because the guard's rule is "live AND mid-turn" — which is what lets this
    // change need no force flag, and a force flag is how the hole would grow back.
    const { ws, calls, dead } = await makeWorkspace();
    try {
      await ws.manager.spawn("worker");
      const sessionId = seedTranscriptOfLastSession(ws, "worker");
      // The last attention snapshot still says working — a killed process leaves no idle edge behind
      // it, so this is the state the recovery paths genuinely arrive in.
      forceStateOf(ws, "worker", "working");
      dead.set(ws.manager.session("worker"), 130); // remain-on-exit pane: the process is gone

      await ws.manager.resume("worker", ws.ledger.get("worker")!);

      expect(launchCount(calls)).toBe(2);
      expect(ws.ledger.get("worker")?.resume?.sessionId).toBe(sessionId);
    } finally {
      ws.dispose();
    }
  });

  it("Tachyon × watch-restart of a TERMINAL — attention is off, so untracked stays resumable", async () => {
    // Not in the card's table either. A watched file change force-restarts its entry, and a dev
    // server must keep restarting on save. Terminals run with attention monitoring disabled, so the
    // state is `undefined` — treated as safe here exactly as `write_input` and the notice queue
    // already treat it. Without that, this change would have silently broken a declared capability.
    const { ws, calls } = await makeWorkspace();
    try {
      await ws.manager.spawn("dev");
      const before = launchCount(calls);

      await ws.manager.restart("dev", { stop: "force", session: "new" });

      expect(launchCount(calls)).toBeGreaterThan(before);
    } finally {
      ws.dispose();
    }
  });

  it("an IDLE agent is resumed with no friction — the door's real use case is untouched", async () => {
    const { ws, calls } = await makeWorkspace();
    try {
      await ws.manager.spawn("worker");
      const sessionId = seedTranscriptOfLastSession(ws, "worker");
      forceStateOf(ws, "worker", "idle");

      await ws.resumeAgent("worker");

      expect(launchCount(calls)).toBe(2);
      expect(ws.ledger.get("worker")?.resume?.sessionId).toBe(sessionId);
    } finally {
      ws.dispose();
    }
  });

  it("a synthetic `working` with no turn behind it is still resumable — the guard needs EVIDENCE", async () => {
    // `isEvidencedWorking` exists because a freshly launched pane can present `working` before any
    // turn has started. Refusing on the label alone would make a just-spawned agent unresumable,
    // which is a worse failure than the one being fixed: it has no idle edge to wait for.
    const { ws, calls } = await makeWorkspace();
    try {
      await ws.manager.spawn("worker");
      seedTranscriptOfLastSession(ws, "worker");
      forceStateOf(ws, "worker", "working", { hasStartedTurn: false });

      await ws.resumeAgent("worker");

      expect(launchCount(calls)).toBe(2);
    } finally {
      ws.dispose();
    }
  });
});
