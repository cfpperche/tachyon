import { describe, it, expect } from "vitest";
import { RunbookRunner } from "../../src/commands/RunbookRunner.js";
import { TmuxService, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";
import { parseConfig, type TachyonConfig } from "../../src/config/loadConfig.js";

const WS = "/repo";
const HASH = workspaceHash(WS);

/**
 * tmux fake where each new step session "finishes" with a scripted exit code
 * on the next list-panes read — simulating instant one-shot steps.
 */
function fakeTmux(exitFor: (cmd: string) => number) {
  const sessions = new Map<string, { cmd: string; dead: boolean; exit?: number }>();
  const exec = async (args: string[]): Promise<ExecResult> => {
    const target = () => args[args.indexOf("-t") + 1].replace(/^=/, "").replace(/:$/, "");
    if (args.includes("new-session")) {
      const name = args[args.indexOf("-s") + 1];
      sessions.set(name, { cmd: args[args.length - 1], dead: false });
      return { stdout: "", stderr: "" };
    }
    switch (args[2]) {
      case "kill-session":
        if (!sessions.delete(target())) throw new Error("can't find session");
        return { stdout: "", stderr: "" };
      case "list-panes": {
        if (sessions.size === 0) throw new Error("no server");
        // steps die on observation — instant one-shots
        for (const s of sessions.values()) {
          if (!s.dead) {
            s.dead = true;
            s.exit = exitFor(s.cmd);
          }
        }
        return {
          stdout: [...sessions.entries()].map(([n, s]) => `${n}\t${s.dead ? 1 : 0}\t${s.exit ?? ""}`).join("\n") + "\n",
          stderr: "",
        };
      }
      case "capture-pane":
        return { stdout: `boom from ${target()}\n`, stderr: "" };
      default:
        return { stdout: "", stderr: "" };
    }
  };
  return { sessions, tmux: new TmuxService(exec) };
}

const YML = [
  "agents:",
  "  a: {cmd: x}",
  "commands:",
  "  lint: {cmd: npm run lint}",
  "  test: {cmd: npm test}",
  "runbooks:",
  "  deploy:",
  "    steps: [lint, test, ./deploy.sh]",
  "",
].join("\n");

function configOf(yaml: string): TachyonConfig {
  const { config, errors } = parseConfig(yaml);
  if (!config) throw new Error(errors.join("; "));
  return config;
}

function makeRunner(exitFor: (cmd: string) => number) {
  const { sessions, tmux } = fakeTmux(exitFor);
  const finished: string[] = [];
  const runner = new RunbookRunner({
    tmux,
    wsHash: HASH,
    workspaceRoot: WS,
    getConfig: () => configOf(YML),
    onFinished: (job) => finished.push(`${job.runbook}:${job.outcome}`),
    stepPollMs: 1,
  });
  return { runner, sessions, finished };
}

describe("runbooks config", () => {
  it("parses and validates", () => {
    expect(configOf(YML).runbooks.deploy.steps).toEqual(["lint", "test", "./deploy.sh"]);
    expect(parseConfig("agents:\n  a: {cmd: x}\nrunbooks:\n  r:\n    steps: []\n").errors[0]).toContain("non-empty");
    expect(parseConfig("agents:\n  a: {cmd: x}\nrunbooks:\n  r:\n    steps: [ok]\n    extra: 1\n").errors[0]).toContain("unknown key");
  });
});

describe("RunbookRunner", () => {
  it("step references resolve to commands; inline strings run literally", () => {
    const { runner } = makeRunner(() => 0);
    expect(runner.resolveStep("lint")).toBe("npm run lint");
    expect(runner.resolveStep("./deploy.sh")).toBe("./deploy.sh");
  });

  it("runs all steps sequentially to a passed job; successful panes are tidied", async () => {
    const { runner, sessions, finished } = makeRunner(() => 0);
    const job = await runner.run("deploy");
    expect(job.outcome).toBe("passed");
    expect(job.steps.map((s) => s.state)).toEqual(["passed", "passed", "passed"]);
    expect(job.steps.map((s) => s.cmd)).toEqual(["npm run lint", "npm test", "./deploy.sh"]);
    expect(job.steps.every((s) => typeof s.durationMs === "number")).toBe(true);
    expect(sessions.size).toBe(0); // all tidied
    expect(finished).toEqual(["deploy:passed"]);
  });

  it("gates on the first failure: later steps skipped, failed pane kept", async () => {
    const { runner, sessions } = makeRunner((cmd) => (cmd === "npm test" ? 2 : 0));
    const job = await runner.run("deploy");
    expect(job.outcome).toBe("failed");
    expect(job.steps.map((s) => s.state)).toEqual(["passed", "failed", "skipped"]);
    expect(job.steps[1].exitCode).toBe(2);
    expect(sessions.has(`tachyon-rb-${HASH}-deploy-1`)).toBe(true); // postmortem kept
    expect(await runner.stepTail("deploy", 1)).toContain("boom");
  });

  it("refuses concurrent runs of the same runbook; unknown runbook refused", async () => {
    const { runner } = makeRunner(() => 0);
    const first = runner.run("deploy");
    await expect(runner.run("deploy")).rejects.toThrow("already running");
    await first;
    await expect(runner.run("ghost")).rejects.toThrow("unknown runbook");
  });

  it("keeps job history and exposes the latest via currentJob/list", async () => {
    const { runner } = makeRunner(() => 0);
    await runner.run("deploy");
    expect(runner.history("deploy")).toHaveLength(1);
    expect(runner.currentJob("deploy")?.outcome).toBe("passed");
    expect(runner.list()).toEqual([
      expect.objectContaining({ name: "deploy", running: false }),
    ]);
  });
});
