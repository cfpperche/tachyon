import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentManager, MaxAgentsError, WatchController } from "../../src/agents/AgentManager.js";
import { TmuxService, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";
import { parseConfig, type TachyonConfig } from "../../src/config/loadConfig.js";

const WS = "/repo";
const HASH = workspaceHash(WS);

/** Stateful in-memory tmux fake at the executor level — exercises real TmuxService arg paths. */
function fakeTmux() {
  const sessions = new Set<string>();
  const exec = async (args: string[]): Promise<ExecResult> => {
    const cmd = args[2];
    const target = () => {
      const i = args.indexOf("-t");
      return args[i + 1].replace(/^=/, "").replace(/:$/, "");
    };
    switch (cmd) {
      case "has-session":
        if (!sessions.has(target())) throw new Error("can't find session");
        return { stdout: "", stderr: "" };
      case "new-session": {
        const i = args.indexOf("-s");
        sessions.add(args[i + 1]);
        return { stdout: "", stderr: "" };
      }
      case "kill-session":
        if (!sessions.delete(target())) throw new Error("can't find session");
        return { stdout: "", stderr: "" };
      case "list-sessions":
        if (sessions.size === 0) throw new Error("no server running");
        return { stdout: [...sessions].join("\n") + "\n", stderr: "" };
      default:
        return { stdout: "", stderr: "" };
    }
  };
  return { sessions, tmux: new TmuxService(exec) };
}

function configOf(yaml: string): TachyonConfig {
  const { config, errors } = parseConfig(yaml);
  if (!config) throw new Error(errors.join("; "));
  return config;
}

function makeManager(yaml: string, maxAgentsSetting = 8) {
  const { sessions, tmux } = fakeTmux();
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
  return { manager, sessions, spawned, killed };
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
