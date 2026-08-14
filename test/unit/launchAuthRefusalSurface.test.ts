/**
 * t-2656d7 (SDD 495, first slice) — the owner's case, through the door production uses.
 *
 * On 2026-08-07 he created a Grok agent, pressed ▶, and Tachyon told him
 * `isolated harness for 'grok': no credentials at /home/gc` in the status bar — clipped. The rest,
 * `— run grok login first`, never arrived. He concluded Grok was unsupported and asked when the
 * product would enable it.
 *
 * `authRequiredLaunchNotice.test.ts` holds the branch invariant in isolation. This file proves the
 * WIRING: that a real `Workspace`, driven the way a start actually arrives, emits that notice to its
 * host with the actions attached. A green test on the pure function would prove only that the
 * function is correct while nothing called it — the shape of green-but-dead this repository already
 * paid for once (`0.56.159`, five call sites bypassing the one that was tested).
 *
 * Every start door converges on `manager.spawn` (sidebar ▶ and Bridge `spawn_agent` reach it through
 * `startAgentWithActivity`; autostart, restart, resume and crash-restart reach it directly), and the
 * refusal is intercepted where the harness is materialized, which is the one place all of them pass
 * through.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Workspace } from "@tachyon/engine/workspace/Workspace.js";
import type { EngineHost, NoticeAction, ViewKind, WatchEvents } from "@tachyon/engine/workspace/EngineHost.js";
import type { NotifyLevel } from "@tachyon/engine/workspace/EngineHost.js";
import { TmuxService, type ExecResult } from "@tachyon/engine/tmux/TmuxService.js";
import { savedAgentSecrets, savedAgentsYaml, writeSavedAgent } from "../helpers/savedAgentFixture.js";
import { __resetVscodeMock } from "../mocks/vscode.js";

interface Notice { message: string; level: NotifyLevel; actions: NoticeAction[] }

class RecordingHost implements EngineHost {
  readonly notices: Notice[] = [];
  private readonly stateMap = new Map<string, unknown>();
  constructor(private readonly storageDir: string, private readonly backend: Map<string, string>) {}
  t = (message: string, ...args: (string | number | boolean)[]): string =>
    message.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? ""));
  notify(message: string, level: NotifyLevel = "info", actions: NoticeAction[] = []): void {
    this.notices.push({ message, level, actions: [...actions] });
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
  getSecret(key: string): Promise<string | undefined> { return Promise.resolve(this.backend.get(key)); }
  setSecret(key: string, value: string): Promise<void> { this.backend.set(key, value); return Promise.resolve(); }
  appVersion(): string { return "0.0.0-test"; }
  mediaPath(...segments: string[]): string { return path.join(this.storageDir, ...segments); }
  webviewRoot(): unknown { return undefined; }
  onViewsChanged(_view: ViewKind): void {}
}

function fakeTmux() {
  const sessions = new Set<string>();
  /** session -> exit code, mirroring tmux's remain-on-exit `pane_dead` / `pane_dead_status`. */
  const dead = new Map<string, number>();
  const newSessions: Array<{ name: string; cmd: string; env: Record<string, string> }> = [];
  const exec = async (args: string[]): Promise<ExecResult> => {
    if (args.includes("new-session")) {
      const name = args[args.indexOf("-s") + 1]!;
      sessions.add(name);
      const env: Record<string, string> = {};
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "-e") {
          const [key, ...rest] = args[i + 1]!.split("=");
          env[key!] = rest.join("=");
        }
      }
      newSessions.push({ name, cmd: args[args.length - 1]!, env });
      return { stdout: "", stderr: "" };
    }
    const target = () => args[args.indexOf("-t") + 1]!.replace(/^=/, "").replace(/:$/, "");
    if (args[2] === "has-session") {
      if (sessions.has(target())) return { stdout: "", stderr: "" };
      throw new Error("can't find session");
    }
    if (args[2] === "list-sessions") {
      return { stdout: [...sessions].join("\n") + (sessions.size ? "\n" : ""), stderr: "" };
    }
    if (args[2] === "list-panes") {
      if (sessions.size === 0) throw new Error("no server");
      return {
        stdout: [...sessions]
          .map((s) => (dead.has(s) ? `${s}\t1\t${dead.get(s)}` : `${s}\t0\t`))
          .join("\n") + "\n",
        stderr: "",
      };
    }
    if (args[2] === "kill-session") sessions.delete(target());
    return { stdout: "", stderr: "" };
  };
  return { sessions, dead, newSessions, tmux: new TmuxService(exec) };
}

const dirs: string[] = [];
const mkdir = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-launch-auth-"));
  dirs.push(d);
  return d;
};

/**
 * A workspace whose Grok AUTHORITY home is empty, so the harness fails closed at materialize.
 *
 * The env stub is what makes this deterministic on any host: `defaultRealGrokHome` reads `GROK_HOME`
 * and `HarnessManager` resolves it at construction, so the machine's real `~/.grok` — which on the
 * owner's box is signed in — never decides whether this case runs.
 */
async function unauthenticatedGrokWorkspace() {
  const root = mkdir();
  const emptyGrokHome = path.join(mkdir(), "grok-signed-out");
  fs.mkdirSync(emptyGrokHome, { recursive: true });
  vi.stubEnv("GROK_HOME", emptyGrokHome);

  const fixture = writeSavedAgent(root, "grok-builder", { runtime: "grok" });
  fs.writeFileSync(path.join(root, "tachyon.yml"), savedAgentsYaml([fixture]), "utf8");
  const host = new RecordingHost(mkdir(), savedAgentSecrets(root, [fixture]));
  const fake = fakeTmux();
  const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux: fake.tmux, startBridge: false });
  return { ws, host, root, emptyGrokHome, ...fake };
}

const authNotice = (host: RecordingHost): Notice | undefined =>
  host.notices.find((notice) => notice.message.includes("is not authenticated"));

describe("t-2656d7 — starting an unauthenticated agent", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    __resetVscodeMock();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the refusal reaches the host as an ACTIONED notice, not a bare string", async () => {
    const { ws, host } = await unauthenticatedGrokWorkspace();
    try {
      await expect(ws.manager.spawn("grok-builder")).rejects.toThrow(/no credentials/);

      const notice = authNotice(host);
      expect(notice, "the launch refusal must reach the human").toBeDefined();
      // THE assertion. An empty array here is `setStatusBarMessage(…, 8_000)` — clipped, on a timer,
      // nothing to press. That is the whole of the owner's 2026-08-07 incident.
      expect(notice!.actions.length).toBeGreaterThan(0);
      expect(notice!.message).toContain("grok-builder");
      expect(notice!.message).toContain("grok runtime reports it is not authenticated");
    } finally { ws.dispose(); }
  });

  it("carries a Log in button and an explicit Retry, and presses neither by itself", async () => {
    const { ws, host, sessions } = await unauthenticatedGrokWorkspace();
    try {
      await expect(ws.manager.spawn("grok-builder")).rejects.toThrow();
      const labels = authNotice(host)!.actions.map((a) => a.label);
      expect(labels).toContain("Log in");
      expect(labels).toContain("Retry");
      // SDD 495 Q3: nothing started. No agent session, and no login pane either — a login pane is
      // opened only when a human presses the button.
      expect([...sessions]).toEqual([]);
    } finally { ws.dispose(); }
  });

  it("Log in opens a governed pane running that runtime's own command against the REAL home", async () => {
    const { ws, host, newSessions, emptyGrokHome } = await unauthenticatedGrokWorkspace();
    try {
      await expect(ws.manager.spawn("grok-builder")).rejects.toThrow();
      await authNotice(host)!.actions.find((a) => a.label === "Log in")!.run();

      const login = newSessions.find((s) => s.name.includes("-login-") || s.name.startsWith("tachyon-login-"));
      expect(login, "a login pane must exist").toBeDefined();
      // Its own namespace: invisible to AgentManager/LifecycleMonitor, so a pane whose job is to exit
      // is never read as an agent that died.
      expect(login!.name).toBe(`tachyon-login-${ws.wsHash}-grok`);
      expect(login!.cmd).toBe("grok login --device-code");
      // The login must write the AUTHORITY private homes are projected from, never a private home.
      expect(login!.env.GROK_HOME).toBe(emptyGrokHome);
    } finally { ws.dispose(); }
  });

  it("a second refused agent JOINS the live login instead of racing a second device flow", async () => {
    const { ws, host, newSessions } = await unauthenticatedGrokWorkspace();
    try {
      await expect(ws.manager.spawn("grok-builder")).rejects.toThrow();
      const login = authNotice(host)!.actions.find((a) => a.label === "Log in")!;
      await login.run();
      await login.run();

      // One credential, one config home, one login. Two device flows for one account is the race.
      expect(newSessions.filter((s) => s.name.startsWith("tachyon-login-"))).toHaveLength(1);
    } finally { ws.dispose(); }
  });

  it("Retry is the human's, and it goes back through the same door", async () => {
    const { ws, host } = await unauthenticatedGrokWorkspace();
    try {
      await expect(ws.manager.spawn("grok-builder")).rejects.toThrow();
      const before = host.notices.length;

      // Still signed out, so the retry is refused again — and re-presents itself the same way rather
      // than degrading into a bare error or going quiet.
      await authNotice(host)!.actions.find((a) => a.label === "Retry")!.run();

      expect(host.notices.length).toBeGreaterThan(before);
      const latest = host.notices[host.notices.length - 1]!;
      expect(latest.message).toContain("is not authenticated");
      expect(latest.actions.length).toBeGreaterThan(0);
    } finally { ws.dispose(); }
  });

  it("when the login pane exits, the agent WAITS and is offered an explicit Retry", async () => {
    const { ws, host, dead } = await unauthenticatedGrokWorkspace();
    try {
      await expect(ws.manager.spawn("grok-builder")).rejects.toThrow();
      await authNotice(host)!.actions.find((a) => a.label === "Log in")!.run();

      // The human finished (or abandoned) the flow and the pane exited.
      dead.set(`tachyon-login-${ws.wsHash}-grok`, 0);
      await ws.loginRunner.tick();

      const finished = host.notices.find((n) => n.message.includes("login pane has exited"));
      expect(finished, "the pane exiting must reach the human").toBeDefined();
      // SDD 495 Q3, the owner's decision against his own live case: Tachyon offers the retry and
      // does NOT take it. A zero exit is not a login verdict either — this slice does not probe.
      expect(finished!.message).toContain("Tachyon will not start it for you");
      expect(finished!.actions.map((a) => a.label)).toContain("Retry grok-builder");
      expect(finished!.actions.length).toBeGreaterThan(0);

      // Nothing was started by the exit itself: the only sessions are the login pane.
      expect([...(host.notices)].filter((n) => n.message.includes("Retry of"))).toEqual([]);
    } finally { ws.dispose(); }
  });

  it("reports a finished login pane once, not on every heartbeat", async () => {
    const { ws, host, dead } = await unauthenticatedGrokWorkspace();
    try {
      await expect(ws.manager.spawn("grok-builder")).rejects.toThrow();
      await authNotice(host)!.actions.find((a) => a.label === "Log in")!.run();
      dead.set(`tachyon-login-${ws.wsHash}-grok`, 0);

      await ws.loginRunner.tick();
      await ws.loginRunner.tick();
      await ws.loginRunner.tick();

      // remain-on-exit keeps the dead pane inspectable forever, so the one-shot has to live here.
      expect(host.notices.filter((n) => n.message.includes("login pane has exited"))).toHaveLength(1);
    } finally { ws.dispose(); }
  });

  it("autostart states the login as its own outcome instead of an anonymous failure count", async () => {
    const root = mkdir();
    const emptyGrokHome = path.join(mkdir(), "grok-signed-out");
    fs.mkdirSync(emptyGrokHome, { recursive: true });
    vi.stubEnv("GROK_HOME", emptyGrokHome);

    const fixture = writeSavedAgent(root, "grok-builder", { runtime: "grok", autostart: true });
    fs.writeFileSync(path.join(root, "tachyon.yml"), savedAgentsYaml([fixture]), "utf8");
    const host = new RecordingHost(mkdir(), savedAgentSecrets(root, [fixture]));
    const ws = await Workspace.createForTest(root, { host, onViewsChanged: () => {} }, { tmux: fakeTmux().tmux, startBridge: false });
    try {
      await ws.start();

      // The actioned notice fires here too — the autostart path used to be WORSE than the owner's:
      // the recovery instruction was dropped entirely, not merely truncated.
      const notice = authNotice(host);
      expect(notice, "autostart must not swallow the instruction").toBeDefined();
      expect(notice!.actions.length).toBeGreaterThan(0);

      // And the summary names the condition rather than folding it into "N failed to start".
      const summary = host.notices.filter((n) => n.message.includes("waiting for a runtime login"));
      expect(summary).toHaveLength(1);
      expect(summary[0]!.message).toContain("grok-builder");
      expect(host.notices.some((n) => n.message.includes("failed to start"))).toBe(false);
    } finally { ws.dispose(); }
  });
});
