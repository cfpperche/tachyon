import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentManager, MaxAgentsError, WatchController } from "../../src/agents/AgentManager.js";
import { TmuxService, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";
import { parseConfig, type TachyonConfig } from "../../src/config/loadConfig.js";

const WS = "/repo";
const HASH = workspaceHash(WS);

/** Stateful in-memory tmux fake at the executor level — exercises real TmuxService arg paths. */
function fakeTmux() {
  const sessions = new Set<string>();
  const dead = new Map<string, number>(); // session -> exit code (remain-on-exit dead pane)
  const exec = async (args: string[]): Promise<ExecResult> => {
    const target = () => {
      const i = args.indexOf("-t");
      return args[i + 1].replace(/^=/, "").replace(/:$/, "");
    };
    if (args.includes("new-session")) {
      sessions.add(args[args.indexOf("-s") + 1]);
      return { stdout: "", stderr: "" };
    }
    switch (args[2]) {
      case "has-session":
        if (!sessions.has(target())) throw new Error("can't find session");
        return { stdout: "", stderr: "" };
      case "kill-session":
        if (!sessions.delete(target())) throw new Error("can't find session");
        dead.delete(target());
        return { stdout: "", stderr: "" };
      case "list-sessions":
        if (sessions.size === 0) throw new Error("no server running");
        return { stdout: [...sessions].join("\n") + "\n", stderr: "" };
      case "list-panes":
        if (sessions.size === 0) throw new Error("no server running");
        return {
          stdout: [...sessions].map((s) => `${s}\t${dead.has(s) ? 1 : 0}\t${dead.get(s) ?? ""}`).join("\n") + "\n",
          stderr: "",
        };
      default:
        return { stdout: "", stderr: "" };
    }
  };
  return { sessions, dead, tmux: new TmuxService(exec) };
}

function configOf(yaml: string): TachyonConfig {
  const { config, errors } = parseConfig(yaml);
  if (!config) throw new Error(errors.join("; "));
  return config;
}

function makeManager(yaml: string, maxAgentsSetting = 8) {
  const { sessions, dead, tmux } = fakeTmux();
  const config = configOf(yaml);
  const spawned: string[] = [];
  const killed: string[] = [];
  const manager = new AgentManager({
    tmux,
    wsHash: HASH,
    workspaceRoot: WS,
    getConfig: () => config,
    getMaxAgents: () => maxAgentsSetting,
    onSpawned: (n) => spawned.push(n),
    onKilled: (n) => killed.push(n),
  });
  return { manager, sessions, dead, spawned, killed };
}

describe("AgentManager", () => {
  it("spawns a declared agent into a namespaced session", async () => {
    const { manager, sessions, spawned } = makeManager("agents:\n  claude:\n    cmd: claude\n");
    await manager.spawn("claude");
    expect(sessions.has(`tachyon-${HASH}-claude`)).toBe(true);
    expect(spawned).toEqual(["claude"]);
  });

  it("rejects spawning an unknown agent without an ad-hoc cmd, accepts with one", async () => {
    const { manager, sessions } = makeManager("agents:\n  a:\n    cmd: x\n");
    await expect(manager.spawn("ghost")).rejects.toThrow("unknown agent");
    await manager.spawn("ghost", { cmd: "echo hi" });
    expect(sessions.has(`tachyon-${HASH}-ghost`)).toBe(true);
  });

  it("rejects double-spawn of a running agent", async () => {
    const { manager } = makeManager("agents:\n  a:\n    cmd: x\n");
    await manager.spawn("a");
    await expect(manager.spawn("a")).rejects.toThrow("already running");
  });

  it("enforces maxAgents from tachyon.yml settings over the editor setting", async () => {
    const { manager } = makeManager("agents:\n  a:\n    cmd: x\n  b:\n    cmd: y\nsettings:\n  maxAgents: 1\n", 99);
    await manager.spawn("a");
    await expect(manager.spawn("b")).rejects.toThrow(MaxAgentsError);
  });

  it("falls back to the editor setting when yml has no maxAgents", async () => {
    const { manager } = makeManager("agents:\n  a:\n    cmd: x\n  b:\n    cmd: y\n", 1);
    await manager.spawn("a");
    await expect(manager.spawn("b")).rejects.toThrow("maxAgents limit reached (1)");
  });

  it("kill errors on a non-running agent, restart respawns a running one", async () => {
    const { manager, sessions, killed } = makeManager("agents:\n  a:\n    cmd: x\n");
    await expect(manager.kill("a")).rejects.toThrow("not running");
    await manager.spawn("a");
    await manager.restart("a");
    expect(sessions.has(`tachyon-${HASH}-a`)).toBe(true);
    await manager.kill("a");
    expect(killed).toEqual(["a"]);
    expect(sessions.size).toBe(0);
  });

  it("cannot restart a re-discovered ad-hoc agent (no stored definition)", async () => {
    const { sessions, tmux } = fakeTmux();
    sessions.add(`tachyon-${HASH}-orphan`); // survived a previous extension host
    const manager = new AgentManager({
      tmux,
      wsHash: HASH,
      workspaceRoot: WS,
      getConfig: () => configOf("agents:\n  a:\n    cmd: x\n"),
      getMaxAgents: () => 8,
    });
    await expect(manager.restart("orphan")).rejects.toThrow("no stored definition");
  });

  it("lists declared + running + ad-hoc agents merged", async () => {
    const { manager } = makeManager("agents:\n  a:\n    cmd: x\n  b:\n    cmd: y\n");
    await manager.spawn("a");
    await manager.spawn("extra", { cmd: "sleep 1" });
    const list = await manager.list();
    expect(list.map((i) => [i.name, i.running, i.declared])).toEqual([
      ["a", true, true],
      ["b", false, true],
      ["extra", true, false],
    ]);
  });

  it("crashed agents (dead pane) are not running, carry the exit code, and don't count toward maxAgents", async () => {
    const { manager, dead } = makeManager("agents:\n  a:\n    cmd: x\n  b:\n    cmd: y\nsettings:\n  maxAgents: 1\n");
    await manager.spawn("a");
    dead.set(`tachyon-${HASH}-a`, 137); // process died, pane remains
    const a = (await manager.list()).find((i) => i.name === "a");
    expect(a).toMatchObject({ running: false, crashed: true, exitCode: 137 });
    expect(await manager.runningAgents()).toEqual([]);
    // the dead pane doesn't occupy a maxAgents slot
    await manager.spawn("b");
  });

  it("spawning over a crashed agent replaces the dead pane", async () => {
    const { manager, sessions, dead } = makeManager("agents:\n  a:\n    cmd: x\n");
    await manager.spawn("a");
    dead.set(`tachyon-${HASH}-a`, 1);
    await manager.spawn("a"); // would throw 'already running' if it were alive
    expect(sessions.has(`tachyon-${HASH}-a`)).toBe(true);
    expect(dead.has(`tachyon-${HASH}-a`)).toBe(false);
    const a = (await manager.list()).find((i) => i.name === "a");
    expect(a?.running).toBe(true);
  });

  it("killAll dismisses crashed panes too; autostart never replaces a postmortem", async () => {
    const { manager, sessions, dead } = makeManager(
      "agents:\n  a:\n    cmd: x\n    autostart: true\n  b:\n    cmd: y\n    autostart: true\n",
    );
    await manager.spawn("a");
    dead.set(`tachyon-${HASH}-a`, 2);
    // a is crashed (session present) -> autostart must NOT touch it; b has no session -> pending
    expect(await manager.autostartPending()).toEqual(["b"]);
    const killed = await manager.killAll();
    expect(killed).toEqual(["a"]);
    expect(sessions.size).toBe(0);
  });

  it("lineage: parent recorded, exposed in list, promoted on parent death, cleared on child kill", async () => {
    const { manager } = makeManager("agents:\n  orchestrator:\n    cmd: claude\n");
    await manager.spawn("orchestrator");
    await manager.spawn("worker", { cmd: "sh", parent: "orchestrator" });
    let worker = (await manager.list()).find((a) => a.name === "worker");
    expect(worker?.parent).toBe("orchestrator");

    // killing the parent leaves the child running; render promotes (parent still recorded)
    await manager.kill("orchestrator");
    worker = (await manager.list()).find((a) => a.name === "worker");
    expect(worker?.running).toBe(true);
    expect(worker?.parent).toBe("orchestrator"); // points at a gone agent — UI promotes to root

    // killing the ad-hoc child removes it from the listing entirely (def + lineage cleared)
    await manager.kill("worker");
    expect((await manager.list()).find((a) => a.name === "worker")).toBeUndefined();
  });

  it("ad-hoc spawn with instructions delivers via composeCommand", async () => {
    const calls: string[][] = [];
    const { tmux } = fakeTmux();
    const recording = new (await import("../../src/tmux/TmuxService.js")).TmuxService(async (args) => {
      calls.push(args);
      if (args[2] === "has-session" || args[2] === "list-panes") throw new Error("none");
      return { stdout: "", stderr: "" };
    });
    const manager = new AgentManager({
      tmux: recording,
      wsHash: HASH,
      workspaceRoot: WS,
      getConfig: () => configOf("agents:\n  a:\n    cmd: x\n"),
      getMaxAgents: () => 8,
    });
    await manager.spawn("revisor", { cmd: "claude", instructions: "review prs", parent: "a" });
    const spawnArgs = calls.find((c) => c.includes("new-session"))!;
    expect(spawnArgs[spawnArgs.length - 1]).toBe("claude 'review prs'");
    void tmux;
  });

  it("computes the pending autostart set, skipping survivors", async () => {
    const { manager } = makeManager(
      "agents:\n  a:\n    cmd: x\n    autostart: true\n  b:\n    cmd: y\n    autostart: true\n  c:\n    cmd: z\n",
    );
    await manager.spawn("a"); // simulate a survivor
    expect(await manager.autostartPending()).toEqual(["b"]);
  });

  it("killAll kills only this workspace's sessions", async () => {
    const { manager, sessions } = makeManager("agents:\n  a:\n    cmd: x\n");
    sessions.add("tachyon-otherws0-x"); // other workspace
    await manager.spawn("a");
    const killed = await manager.killAll();
    expect(killed).toEqual(["a"]);
    expect(sessions.has("tachyon-otherws0-x")).toBe(true);
  });
});

describe("WatchController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces bursts of change events into one restart", async () => {
    const restarts: string[] = [];
    const wc = new WatchController(async (a) => {
      restarts.push(a);
    }, 500);
    wc.onChange("dev");
    wc.onChange("dev");
    wc.onChange("dev");
    await vi.advanceTimersByTimeAsync(499);
    expect(restarts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(restarts).toEqual(["dev"]);
  });

  it("tracks agents independently and cancels on dispose", async () => {
    const restarts: string[] = [];
    const wc = new WatchController(async (a) => {
      restarts.push(a);
    }, 100);
    wc.onChange("a");
    wc.onChange("b");
    await vi.advanceTimersByTimeAsync(100);
    expect(restarts.sort()).toEqual(["a", "b"]);

    wc.onChange("a");
    wc.dispose();
    await vi.advanceTimersByTimeAsync(200);
    expect(restarts).toHaveLength(2);
  });
});
