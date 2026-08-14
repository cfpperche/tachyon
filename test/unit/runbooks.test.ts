import { describe, it, expect } from "vitest";
import { RunbookRunner } from "@tachyon/engine/commands/RunbookRunner.js";
import { TmuxService, workspaceHash, type ExecResult } from "@tachyon/engine/tmux/TmuxService.js";
import { parseConfig, type TachyonConfig } from "@tachyon/engine/config/loadConfig.js";

const WS = "/repo";
const HASH = workspaceHash(WS);

/**
 * tmux fake where each new step session "finishes" with a scripted exit code
 * on the next list-panes read — simulating instant one-shot steps.
 */
function fakeTmux(exitFor: (cmd: string) => number, listPanesFault?: () => string | undefined) {
  const sessions = new Map<string, { cmd: string; cwd?: string; env: string[]; dead: boolean; exit?: number }>();
  const exec = async (args: string[]): Promise<ExecResult> => {
    const target = () => args[args.indexOf("-t") + 1].replace(/^=/, "").replace(/:$/, "");
    if (args.includes("list-panes") && listPanesFault) {
      const msg = listPanesFault();
      if (msg !== undefined) throw new Error(msg);
    }
    if (args.includes("new-session")) {
      const name = args[args.indexOf("-s") + 1];
      const ci = args.indexOf("-c");
      const env = args.flatMap((a, i) => (args[i - 1] === "-e" ? [a] : []));
      sessions.set(name, { cmd: args[args.length - 1], cwd: ci >= 0 ? args[ci + 1] : undefined, env, dead: false });
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
  const { config, warnings } = parseConfig(yaml);
  if (!config) throw new Error(warnings.join("; "));
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
    expect(parseConfig("agents:\n  a: {cmd: x}\nrunbooks:\n  r:\n    steps: []\n").warnings[0]).toContain("non-empty");
    expect(parseConfig("agents:\n  a: {cmd: x}\nrunbooks:\n  r:\n    steps: [ok]\n    extra: 1\n").warnings[0]).toContain("unknown key");
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

  // spec 214 — runSteps (the verify-gate executor) + cwd override. The real verify label is
  // `_verify-<agent>` (tmux-safe + NAME_RE-impossible so it can't collide with a user runbook).
  it("runSteps runs an ad-hoc label's steps (resolving command names) in the cwd override", async () => {
    const { runner, sessions } = makeRunner(() => 0);
    const job = await runner.runSteps("_verify-rev", ["lint", "npm test"], "/wt/rev");
    expect(job.outcome).toBe("passed");
    expect(job.steps.map((s) => s.cmd)).toEqual(["npm run lint", "npm test"]); // command name resolved; inline kept
    // history is keyed by the label, observable like a runbook
    expect(runner.currentJob("_verify-rev")?.outcome).toBe("passed");
    expect(sessions.size).toBe(0); // all passed → tidied
  });

  it("runSteps gates on failure and keeps the failed pane (label-scoped session names)", async () => {
    const { runner, sessions } = makeRunner((cmd) => (cmd === "npm test" ? 1 : 0));
    const job = await runner.runSteps("_verify-rev", ["npm test"], "/wt/rev");
    expect(job.outcome).toBe("failed");
    expect(sessions.has(`tachyon-rb-${HASH}-_verify-rev-0`)).toBe(true);
  });

  it("run(runbook, cwd) threads the override into every step", async () => {
    const { runner, sessions } = makeRunner((cmd) => (cmd === "npm test" ? 1 : 0)); // fail at step 2 to keep panes
    await runner.run("deploy", "/wt/rev");
    const lintSession = sessions.get(`tachyon-rb-${HASH}-deploy-1`); // the failed (test) step pane is kept
    expect(lintSession?.cwd).toBe("/wt/rev");
  });

  // spec 214 review fix — a command-name step carries the command's cwd/env (matches CommandRunner)
  it("a referenced command's cwd/env flow into the step (relative cwd under the override)", async () => {
    const { sessions, tmux } = fakeTmux((cmd) => (cmd === "./m.sh" ? 1 : 0)); // fail so the pane is kept
    const yml = "agents:\n  a: {cmd: x}\ncommands:\n  migrate: {cmd: ./m.sh, cwd: db, env: {DB: prod}}\nrunbooks:\n  mig:\n    steps: [migrate]\n";
    const runner = new RunbookRunner({ tmux, wsHash: HASH, workspaceRoot: WS, getConfig: () => configOf(yml), stepPollMs: 1 });
    await runner.run("mig", "/wt/rev");
    const s = sessions.get(`tachyon-rb-${HASH}-mig-0`);
    expect(s?.cmd).toBe("./m.sh");
    expect(s?.cwd).toBe("/wt/rev/db"); // relative command cwd resolved under the worktree override
    expect(s?.env).toContain("DB=prod");
  });

  // t-37b7b8 — the verify-gate flake. `sessionStates` returns null for a read it could not make
  // (transient tmux client failure under load: "lost server: connection reset by peer", EPIPE, a
  // client timeout — all measured verbatim during a real `verify:full`). The poll loop used to
  // coerce that null to an empty map, conclude the pane had been killed externally, and record the
  // step as FAILED — turning a step that had already exited 0 into a red gate, once, unreproducibly.
  it("an unreadable tmux poll does not turn a passing step into a failing one (t-37b7b8)", async () => {
    let polls = 0;
    // the first two reads of the running step are unreadable; the third answers truthfully
    const { tmux } = fakeTmux(() => 0, () => (++polls <= 3 ? "lost server: connection reset by peer" : undefined));
    const runner = new RunbookRunner({ tmux, wsHash: HASH, workspaceRoot: WS, getConfig: () => configOf(YML), stepPollMs: 1 });
    const job = await runner.runSteps("_verify-a", ["lint"], "/wt/a");
    expect(job.outcome).toBe("passed");
    expect(job.steps[0].exitCode).toBe(0);
  });

  it("a read that SUCCEEDS and finds no pane is still an externally-killed step (t-37b7b8)", async () => {
    const { sessions, tmux } = fakeTmux(() => 0);
    const runner = new RunbookRunner({ tmux, wsHash: HASH, workspaceRoot: WS, getConfig: () => configOf(YML), stepPollMs: 1 });
    const kill = tmux.newSession.bind(tmux);
    tmux.newSession = async (o) => {
      await kill(o);
      sessions.delete(o.name); // vanished before the first poll — an authoritative absence
      sessions.set("tachyon-rb-x-decoy-0", { cmd: "x", env: [], dead: false }); // keep the fake's server "up"
    };
    const job = await runner.runSteps("_verify-b", ["lint"], "/wt/b");
    expect(job.outcome).toBe("failed");
    expect(job.steps[0].exitCode).toBeUndefined();
  });

  it("gives up loudly rather than guessing when tmux stays unreadable (t-37b7b8)", async () => {
    const { tmux } = fakeTmux(() => 0, () => "lost server: connection reset by peer");
    const runner = new RunbookRunner({
      tmux, wsHash: HASH, workspaceRoot: WS, getConfig: () => configOf(YML), stepPollMs: 1, unreadablePollBudget: 3,
    });
    await expect(runner.runSteps("_verify-c", ["lint"], "/wt/c")).rejects.toThrow(/unreadable/);
  });
});
