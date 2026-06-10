import { describe, it, expect } from "vitest";
import { CommandRunner } from "../../src/commands/CommandRunner.js";
import { TmuxService, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";
import { parseConfig, type TachyonConfig } from "../../src/config/loadConfig.js";

const WS = "/repo";
const HASH = workspaceHash(WS);

/** tmux fake with controllable dead panes (same style as the manager suite). */
function fakeTmux() {
  const sessions = new Set<string>();
  const dead = new Map<string, number>();
  const exec = async (args: string[]): Promise<ExecResult> => {
    const target = () => args[args.indexOf("-t") + 1].replace(/^=/, "").replace(/:$/, "");
    if (args.includes("new-session")) {
      sessions.add(args[args.indexOf("-s") + 1]);
      return { stdout: "", stderr: "" };
    }
    switch (args[2]) {
      case "kill-session":
        if (!sessions.delete(target())) throw new Error("can't find session");
        dead.delete(target());
        return { stdout: "", stderr: "" };
      case "list-panes":
        if (sessions.size === 0) throw new Error("no server");
        return {
          stdout: [...sessions].map((s) => `${s}\t${dead.has(s) ? 1 : 0}\t${dead.get(s) ?? ""}`).join("\n") + "\n",
          stderr: "",
        };
      case "capture-pane":
        return { stdout: `output of ${target()}\nlast line\n`, stderr: "" };
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

const YML = "agents:\n  a:\n    cmd: x\ncommands:\n  test:\n    cmd: npm test\n  lint:\n    cmd: npm run lint\n    cwd: web\n";

function makeRunner() {
  const { sessions, dead, tmux } = fakeTmux();
  const finished: Array<{ name: string; exitCode?: number }> = [];
  let now = 1_000_000;
  const runner = new CommandRunner({
    tmux,
    wsHash: HASH,
    workspaceRoot: WS,
    getConfig: () => configOf(YML),
    onFinished: (name, exitCode) => finished.push({ name, exitCode }),
    now: () => now,
  });
  return { runner, sessions, dead, finished, advance: (ms: number) => (now += ms) };
}

describe("commands config", () => {
  it("parses the commands map with validation", () => {
    const config = configOf(YML);
    expect(config.commands.test.cmd).toBe("npm test");
    expect(config.commands.lint.cwd).toBe("web");
    expect(parseConfig("agents:\n  a:\n    cmd: x\ncommands:\n  bad:\n    nope: 1\n").errors[0]).toContain("commands.bad");
    expect(parseConfig("agents:\n  a:\n    cmd: x\ncommands:\n  t:\n    cmd: x\n    extra: 1\n").errors[0]).toContain("unknown key 'extra'");
  });
});

describe("CommandRunner", () => {
  it("runs in its own namespace — invisible to the agent prefix", async () => {
    const { runner, sessions } = makeRunner();
    await runner.run("test");
    expect(sessions.has(`tachyon-cmd-${HASH}-test`)).toBe(true);
    for (const s of sessions) expect(s.startsWith(`tachyon-${HASH}-`)).toBe(false);
  });

  it("inverted lifecycle: exit 0 = passed, non-zero = failed; tick fires onFinished once", async () => {
    const { runner, dead, finished, advance } = makeRunner();
    await runner.run("test");
    expect((await runner.status("test")).state).toBe("running");

    advance(3000);
    dead.set(`tachyon-cmd-${HASH}-test`, 0);
    await runner.tick();
    await runner.tick(); // no double-fire
    expect(finished).toEqual([{ name: "test", exitCode: 0 }]);
    const status = await runner.status("test");
    expect(status).toMatchObject({ state: "passed", exitCode: 0 });
    expect(runner.history("test")[0]).toMatchObject({ exitCode: 0 });

    await runner.run("lint");
    dead.set(`tachyon-cmd-${HASH}-lint`, 2);
    await runner.tick();
    expect((await runner.status("lint")).state).toBe("failed");
  });

  it("refuses a live re-run; replaces a finished pane on re-run", async () => {
    const { runner, dead } = makeRunner();
    await runner.run("test");
    await expect(runner.run("test")).rejects.toThrow("already running");
    dead.set(`tachyon-cmd-${HASH}-test`, 1);
    await runner.tick();
    await runner.run("test"); // replaces postmortem
    expect((await runner.status("test")).state).toBe("running");
  });

  it("unknown command refused; list merges declared + sessions; killAll clears", async () => {
    const { runner, sessions } = makeRunner();
    await expect(runner.run("ghost")).rejects.toThrow("unknown command");
    await runner.run("test");
    const list = await runner.list();
    expect(list.map((c) => [c.name, c.state])).toEqual([
      ["lint", "idle"],
      ["test", "running"],
    ]);
    await runner.killAll();
    expect([...sessions].filter((s) => s.startsWith(`tachyon-cmd-`))).toEqual([]);
  });

  it("tail returns the pane's last lines (works for finished panes)", async () => {
    const { runner, dead } = makeRunner();
    await runner.run("test");
    dead.set(`tachyon-cmd-${HASH}-test`, 0);
    await runner.tick();
    expect(await runner.tail("test")).toContain("last line");
  });
});
