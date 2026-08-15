import { createWorkspaceForTest } from "@tachyon/engine/bridge/workspaceComposition.js";
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "@tachyon/engine/workspace/Workspace.js";
import { TmuxService, type ExecResult } from "@tachyon/engine/tmux/TmuxService.js";
import type { EngineHost, NoticeAction, ViewKind, WatchEvents } from "@tachyon/engine/workspace/EngineHost.js";
import type { NotifyLevel } from "@tachyon/engine/workspace/EngineHost.js";
import type { TerminalPresentationOptions } from "@tachyon/engine/workspace/TerminalPresentation.js";
import { Terminals } from "../../apps/vscode-extension/src/presentation/Terminals.js";
import { encodeClaudeCwd } from "@tachyon/shared/resume/adapters.js";
import { __resetVscodeMock } from "../mocks/vscode.js";
import { writeSavedAgent, savedAgentSecrets, savedAgentsYaml } from "../helpers/savedAgentFixture.js";
import { useDisposableRuntimeAuth } from "../helpers/optionalRuntimeAuth.js";

/**
 * t-f6aa7c — a process that died on its own must not cost an AGENT its memory.
 *
 * The owner's decision (2026-08-07): crash recovery for an agent "volta lembrando". The three cases
 * below are the three answers the one branch has to give, and they are named after them, because a
 * suite that only proved the happy path would let the fallback silently become a refusal.
 *
 * These drive the real `Workspace`, the real `AgentManager` and a real `SessionLedger` — only the
 * tmux channel and the editor widget are substituted. The recovery is asserted through what the
 * launch command actually says, not through a spy on `restart`: a spy would have passed just as
 * happily while resume fell through to a fresh spawn.
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
      dead.delete(name); // a relaunch replaces the postmortem pane
      return { stdout: "", stderr: "" };
    }
    if (args[2] === "has-session") {
      const name = args[args.indexOf("-t") + 1]!.replace(/^=/, "");
      if (sessions.has(name)) return { stdout: "", stderr: "" };
      throw new Error("can't find session"); // non-zero exit = does not exist
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
  vi.useRealTimers();
  __resetVscodeMock();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * t-a12966 — the claude credential these cases need is SUBSTRATE, not subject.
 *
 * Spawning a Saved claude agent materializes its isolated harness home, and that refuses without a
 * real credential to link (`HarnessUnavailableError: … run claude /login first`). Nothing below
 * launches a real claude — the tmux channel is fake-exec'd and the assertions read the command line
 * — so requiring the MACHINE to be logged in made four of these cases answer "is this host
 * credentialed?" instead of "does a crash cost an agent its memory?". Measured: green in the primary
 * checkout, red in every agent worktree whose private `CLAUDE_CONFIG_DIR` has no credential, which
 * is how it landed four unrelated reds on an agent that had written only markdown.
 *
 * The state goes in through the door production reads it from — `CLAUDE_CONFIG_DIR`, resolved by
 * `realConfigHome()` when the Workspace builds its `HarnessManager`.
 */
useDisposableRuntimeAuth(["claude"]);

/** `worker` is a canonical Saved AGENT on `restart: on-crash`; `dev` is a TERMINAL on the same policy. */
async function makeWorkspace() {
  const root = mkdir("crash-restart-memory-");
  const fixtures = [writeSavedAgent(root, "worker", { runtime: "claude", extra: { lifecycle: { restart: "on-crash" } } })];
  fs.writeFileSync(
    path.join(root, "tachyon.yml"),
    savedAgentsYaml(fixtures) + "terminals:\n  dev:\n    cmd: sh\n    restart: on-crash\n",
    "utf8",
  );
  const host = new FakeHost(mkdir("crash-restart-storage-"), savedAgentSecrets(root, fixtures));
  const fake = fakeTmux();
  const ws = await createWorkspaceForTest(root, { host, onViewsChanged: () => {} }, { tmux: fake.tmux, startBridge: false });
  return { root, ws, host, ...fake };
}

/** The private door BOTH crash actors go through — the scheduled policy restart and the toast button. */
function recoveryOf(ws: Workspace) {
  return (ws as unknown as { recoverFromCrash(agent: string): Promise<void> }).recoverFromCrash.bind(ws);
}

/**
 * The command line of the last LAUNCH, whichever tmux verb carried it. A relaunch onto an existing
 * (or dead) pane is a `respawn-pane -k` (t-4d2630) and only falls back to kill + `new-session`, so a
 * helper that watched one verb would read the previous launch and pass on a relaunch that never
 * happened — measured here, where it made two of these cases green for the wrong reason.
 */
function lastLaunch(calls: string[][]): string {
  const launch = [...calls].reverse().find((args) => args.includes("new-session") || args.includes("respawn-pane"));
  return (launch ?? []).join(" ");
}

/** How many launches have run — a relaunch that never happened is not a pass. */
function launchCount(calls: string[][]): number {
  return calls.filter((args) => args.includes("new-session") || args.includes("respawn-pane")).length;
}

/**
 * Materialize the transcript for the session the LAUNCH itself recorded, so resume has something
 * real to reopen. Deliberately derived from the ledger row the manager wrote rather than from a
 * hand-made one: the config home of a Saved agent is its isolated harness dir, and a fixture that
 * guessed it would test resume against a path production never reads.
 *
 * Skipping this call is the other half of the fixture — it leaves the agent with a resume block
 * whose transcript is gone, which is case 2.
 */
function seedTranscriptOfLastSession(ws: Workspace, agent: string): string {
  const record = ws.ledger.get(agent);
  if (!record?.resume?.configHome) throw new Error(`fixture: launch recorded no resume block for '${agent}'`);
  const { sessionId, configHome } = record.resume;
  const projects = path.join(configHome, "projects", encodeClaudeCwd(record.cwd));
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(projects, `${sessionId}.jsonl`), "{}\n", "utf8");
  return sessionId;
}

describe("t-f6aa7c — a crash must not cost an agent its memory", () => {
  it("case 1 — an AGENT with a session to resume comes back RESUMED", async () => {
    const { ws, host, calls, dead } = await makeWorkspace();
    try {
      await ws.manager.spawn("worker");
      const sessionId = seedTranscriptOfLastSession(ws, "worker");
      dead.set(ws.manager.session("worker"), 7); // died on its own, exit 7

      await recoveryOf(ws)("worker");

      // The proof is the command the relaunch actually ran, not the call: resume appends `--resume`.
      expect(launchCount(calls)).toBe(2);
      expect(lastLaunch(calls)).toContain(`--resume ${sessionId}`);
      // Nothing to explain — continuity was kept, so the human is not told it was lost.
      expect(host.notices.map((n) => n.message).join("\n")).not.toContain("prior context is gone");
    } finally {
      ws.dispose();
    }
  });

  it("case 2 — an AGENT with NOTHING to resume comes back on a new session and the human is told why", async () => {
    const { ws, host, calls, dead } = await makeWorkspace();
    try {
      await ws.manager.spawn("worker"); // no transcript materialized — the session is not reopenable
      dead.set(ws.manager.session("worker"), 7);

      await recoveryOf(ws)("worker");

      // Resuming did not become refusing: the agent IS back, just on a fresh section.
      expect(launchCount(calls)).toBe(2);
      expect(lastLaunch(calls)).not.toContain("--resume");
      const notice = host.notices.find((n) => n.message.includes("prior context is gone"));
      expect(notice?.level).toBe("warn");
      // …and it names WHICH reason, so the human does not have to infer the loss from behaviour.
      expect(notice?.message).toContain("transcript no longer on disk");
    } finally {
      ws.dispose();
    }
  });

  it("case 3 — a TERMINAL still comes back zeroed, with nothing to explain", async () => {
    const { ws, host, calls, dead } = await makeWorkspace();
    try {
      await ws.manager.spawn("dev");
      dead.set(ws.manager.session("dev"), 1);

      await recoveryOf(ws)("dev");

      expect(launchCount(calls)).toBe(2);
      expect(lastLaunch(calls)).not.toContain("--resume");
      expect(host.notices.map((n) => n.message).join("\n")).not.toContain("prior context is gone");
    } finally {
      ws.dispose();
    }
  });

  it("the `restart: on-crash` policy reaches that same recovery — the door production uses", async () => {
    // The three cases above call the recovery directly. This one proves the POLICY door arrives
    // there too, so a future edit cannot leave the scheduled restart on its own force+new path.
    vi.useFakeTimers();
    const { ws, calls, dead } = await makeWorkspace();
    try {
      await ws.manager.spawn("worker");
      const sessionId = seedTranscriptOfLastSession(ws, "worker");
      dead.set(ws.manager.session("worker"), 7);

      await ws.tick(); // lifecycle observes the dead pane and schedules the restart
      await vi.advanceTimersByTimeAsync(5000); // past the first backoff delay (2s)
      await vi.waitFor(() => expect(lastLaunch(calls)).toContain(`--resume ${sessionId}`));
    } finally {
      ws.dispose();
    }
  });

  it("an agent STOPPED on request is not resumed — it is not restarted at all", async () => {
    // The seam between this change and t-9d76b1, asserted where the two actually meet. t-9d76b1 owns
    // WHETHER a death restarts (`wasStopRequested` short-circuits in `tick`, upstream of the only
    // caller of `scheduleRestart`); this change owns HOW one that does comes back. Teaching crash
    // recovery to resume must not turn a deliberate Stop into a relaunch with the memory re-attached
    // — that would be worse than the defect either change fixed. `stopclean` pins this at the monitor
    // with a fake `scheduleRestart`; here it runs through the real Workspace, manager and policy.
    const { ws, calls, dead } = await makeWorkspace();
    try {
      await ws.manager.spawn("worker");
      seedTranscriptOfLastSession(ws, "worker"); // resumable — so a relaunch WOULD resume if one ran
      const launchesBefore = launchCount(calls);

      await ws.manager.stopGracefully("worker"); // Tachyon asked; the human ordered it
      dead.set(ws.manager.session("worker"), 130); // grok/hermes honour ^C with 130 — a non-zero exit

      vi.useFakeTimers(); // only now: the graceful stop above has its own real waits
      await ws.tick();
      await vi.advanceTimersByTimeAsync(15_000); // past every backoff delay, not just the first

      expect(launchCount(calls)).toBe(launchesBefore);
    } finally {
      ws.dispose();
    }
  });
});
