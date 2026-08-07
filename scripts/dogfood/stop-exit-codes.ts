/**
 * t-9d76b1 — measure what exit code each runtime returns to a stop TACHYON ASKED FOR.
 *
 * Run: `npm run dogfood -- stop-exit-codes [runtime ...]`
 *
 * ## Why this exists
 *
 * `AgentManager.list()` used to answer "did this die on its own?" with "was the exit code zero?".
 * The owner stopped `grok` and got `exited (130)` in crash red, because 130 is 128+SIGINT — the
 * CORRECT exit of a process that honoured the Ctrl-C Tachyon itself sent. The fix is to remember the
 * request; this command is the evidence that no exit code could have substituted for it, because the
 * runtimes do not agree on which code a requested stop produces.
 *
 * So it measures the ONE number that a special case would have had to key on, per runtime, through
 * the door production uses: `AgentManager.stopGracefully` → the runtime's own measured
 * `gracefulStop` profile → the pane's `pane_dead_status`.
 *
 * ## What it does and does not touch
 *
 * - Private `TMUX_TMPDIR`: its own tmux server, never the fleet socket.
 * - Ambient runtime homes, exactly like a legacy/Temporary Tachyon agent: the runtimes are already
 *   authenticated there, and an unauthenticated private home would measure a sign-in screen's key
 *   handling instead of a working agent's. It writes no runtime config and grants no trust; a
 *   started-and-immediately-stopped session leaves the ordinary session/history entry any spawn
 *   leaves.
 * - `TACHYON_*` is stripped from the environment the panes inherit, so a measured runtime never
 *   receives this session's Bridge token.
 * - No prompt is ever submitted: no model call, no cost, nothing typed but the profile's own stop
 *   keys (`Escape`/`C-c`/`C-d`/`/exit`). No bare Enter is ever sent (project guidance: a blind Enter
 *   answers whatever selector happens to be focused).
 *
 * ## Reading the result
 *
 * `screen` says what state the stop was measured AGAINST — `composer` means the runtime had reached
 * its input composer (`findComposerRegion` on the runtime's measured profile), anything else means
 * the pane was still showing something else and the row is weaker evidence, not silent evidence.
 * `crashed` is Tachyon's own verdict, read back from `list()`: it is the defect when true.
 */
import fs from "node:fs";
import path from "node:path";
import { AgentManager } from "../../src/agents/AgentManager.js";
import { materializePiSessionDir } from "../../src/agents/piSession.js";
import { parseConfig } from "../../src/config/loadConfig.js";
import { SessionLedger } from "../../src/resume/SessionLedger.js";
import { findComposerRegion } from "../../src/runtime/composerRegion.js";
import { gracefulStopForCommand, runtimeProfile } from "../../src/runtime/runtimeProfile.js";
import { SOCKET_NAME, TmuxService, defaultExecutor, sessionName, workspaceHash } from "../../src/tmux/TmuxService.js";
import type { ResumeRuntime } from "../../src/resume/adapters.js";

const ALL_RUNTIMES: ResumeRuntime[] = ["claude", "codex", "grok", "opencode", "hermes", "pi"];
const READY_TIMEOUT_MS = 60_000;
const DEATH_TIMEOUT_MS = 30_000;
const POLL_MS = 500;
const EVIDENCE_DIR = path.resolve(".tachyon/evidence/stop-exit-codes");

interface Measurement {
  runtime: string;
  /** The stop sequence Tachyon actually executed, from the runtime profile. */
  steps: string[];
  stopProfile: { source: string; verified: boolean; verifiedAt?: string };
  screen: "composer" | "other" | "never-started";
  readyMs?: number;
  /** The pane's last lines BEFORE the stop keys — what the measurement was taken against. A TUI
   *  restores the primary screen on exit, so this is unreadable once the process is gone. */
  screenTail?: string[];
  died: boolean;
  deathMs?: number;
  exitCode?: number;
  /** Tachyon's own verdict for the row after the stop it asked for. */
  crashed?: boolean;
  stopFailed?: boolean;
  paneTail?: string[];
  error?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A raw tmux call on the SAME socket `TmuxService` uses — see the teardown note below. */
const onServerSocket = (args: string[]) => defaultExecutor(["-L", SOCKET_NAME, ...args]);

function stripTachyonEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("TACHYON_")) delete process.env[key];
  }
}

function stepLabel(step: { type: string; key?: string; text?: string; delayMs?: number }): string {
  const what = step.key ?? step.text ?? "";
  const delay = step.delayMs !== undefined ? `+${step.delayMs}ms` : "";
  return `${step.type}${what ? `(${what})` : ""}${delay}`;
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  const runtimes = requested.length
    ? ALL_RUNTIMES.filter((runtime) => requested.includes(runtime))
    : ALL_RUNTIMES;
  if (!runtimes.length) {
    console.error(`no known runtime in ${requested.join(", ")}; known: ${ALL_RUNTIMES.join(", ")}`);
    process.exit(1);
  }

  stripTachyonEnv();
  const repoRoot = process.cwd();
  const base = fs.mkdtempSync("/tmp/stop-exit-codes-");
  const workspace = path.join(base, "ws");
  const tmuxTmp = path.join(base, "t");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(tmuxTmp, { recursive: true, mode: 0o700 });
  process.env.TMUX_TMPDIR = tmuxTmp;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;

  const yaml = [
    "settings:",
    "  maxAgents: 8",
    "agents:",
    ...runtimes.flatMap((runtime) => [
      `  ${runtime}:`,
      `    cmd: ${runtime}`,
      `    cwd: ${repoRoot}`,
      "    autostart: false",
    ]),
  ].join("\n");
  fs.writeFileSync(path.join(workspace, "tachyon.yml"), `${yaml}\n`);
  const { config, errors } = parseConfig(yaml);
  if (!config || errors.length) throw new Error(`fixture config invalid: ${errors.join("; ")}`);

  const wsHash = workspaceHash(workspace);
  const tmux = new TmuxService(defaultExecutor);
  const manager = new AgentManager({
    tmux,
    wsHash,
    workspaceRoot: workspace,
    getConfig: () => config,
    ledger: new SessionLedger(workspace),
    // Pi refuses to launch without its session directory, and only the Workspace normally wires the
    // materializer. Same call the Workspace makes, so the measured pi row is a real managed launch.
    materializePiSessionDir: (name) => materializePiSessionDir(workspace, name),
  });

  const measurements: Measurement[] = [];
  for (const runtime of runtimes) {
    const session = sessionName(wsHash, runtime);
    const profile = runtimeProfile(runtime);
    const stop = gracefulStopForCommand(runtime);
    const measurement: Measurement = {
      runtime,
      steps: stop.steps.map(stepLabel),
      stopProfile: {
        source: stop.source,
        verified: stop.verified,
        ...(stop.verifiedAt ? { verifiedAt: stop.verifiedAt } : {}),
      },
      screen: "never-started",
      died: false,
    };
    measurements.push(measurement);
    console.log(`\n── ${runtime} ──`);
    try {
      await manager.spawn(runtime);
    } catch (err) {
      measurement.error = err instanceof Error ? err.message : String(err);
      console.log(`  spawn refused: ${measurement.error}`);
      continue;
    }

    // Readiness: the runtime's OWN measured composer shape, never a fixed sleep.
    const startedAt = Date.now();
    while (Date.now() - startedAt < READY_TIMEOUT_MS) {
      let pane = "";
      try {
        pane = await tmux.capturePane(session, { joinWrapped: true });
      } catch {
        /* pane not readable yet */
      }
      if (profile?.composer && findComposerRegion(pane.split("\n"), profile.composer)) {
        measurement.screen = "composer";
        measurement.readyMs = Date.now() - startedAt;
        break;
      }
      await sleep(POLL_MS);
    }
    if (measurement.screen !== "composer") {
      measurement.screen = "other";
      console.log(`  no composer within ${READY_TIMEOUT_MS}ms — measuring the stop against whatever the pane shows`);
    } else {
      console.log(`  composer reached in ${measurement.readyMs}ms`);
    }

    try {
      measurement.screenTail = (await tmux.capturePane(session, { joinWrapped: true }))
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .slice(-4);
    } catch {
      /* best-effort evidence */
    }

    console.log(`  stop steps: ${measurement.steps.join(" → ")}`);
    const stopAt = Date.now();
    try {
      await manager.stopGracefully(runtime);
    } catch (err) {
      measurement.error = err instanceof Error ? err.message : String(err);
      console.log(`  stopGracefully threw: ${measurement.error}`);
    }
    while (Date.now() - stopAt < DEATH_TIMEOUT_MS) {
      const row = (await manager.list()).find((entry) => entry.name === runtime);
      if (row?.dead) {
        measurement.died = true;
        measurement.deathMs = Date.now() - stopAt;
        measurement.exitCode = row.exitCode;
        measurement.crashed = row.crashed;
        measurement.stopFailed = row.stopFailed ?? false;
        break;
      }
      await sleep(POLL_MS);
    }
    if (!measurement.died) {
      const row = (await manager.list()).find((entry) => entry.name === runtime);
      measurement.stopFailed = row?.stopFailed ?? false;
      console.log(`  still alive after ${DEATH_TIMEOUT_MS}ms (stopFailed=${measurement.stopFailed})`);
    } else {
      console.log(`  dead in ${measurement.deathMs}ms — exit ${measurement.exitCode ?? "unknown"}, crashed=${measurement.crashed}`);
    }
    try {
      measurement.paneTail = (await tmux.capturePane(session, 40)).split("\n").slice(-6);
    } catch {
      /* the pane may already be gone (a clean exit is collected) */
    }
  }

  // Sessions are torn down at the END, not per runtime. `tmux start-server` does not hold a server open
  // with no sessions in it (measured: it exits, and `list-panes -a` then fails), and Pi's launch
  // admission REFUSES when tmux cannot be inventoried — correctly, since it cannot prove its slot is
  // free. Killing each pane as it was measured therefore made the last runtime in the list unmeasurable,
  // which is the harness reporting its own teardown as a runtime fact.
  for (const runtime of runtimes) {
    try {
      await tmux.killSession(sessionName(wsHash, runtime));
    } catch {
      /* already gone */
    }
  }

  try {
    // The socket matters: `TmuxService.run` prepends `-L <socket>`, so a bare `defaultExecutor` call
    // reaches the DEFAULT tmux server and leaves this run's own server alive with its socket directory
    // already deleted. Measured while writing this: five orphaned servers, one per run.
    await onServerSocket(["kill-server"]);
  } catch {
    /* no server left */
  }
  fs.rmSync(base, { recursive: true, force: true });

  const header = "| runtime | screen | stop steps | exit code | Tachyon says `crashed` |";
  const divider = "| --- | --- | --- | --- | --- |";
  const rows = measurements.map((m) => {
    const exit = m.died ? String(m.exitCode ?? "unknown") : m.error ? "not measured" : "still alive";
    const verdict = m.died ? String(m.crashed) : "—";
    return `| ${m.runtime} | ${m.screen} | ${m.steps.join(" → ")} | ${exit} | ${verdict} |`;
  });
  console.log(`\n${[header, divider, ...rows].join("\n")}`);

  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const report = {
    schemaVersion: 1,
    kind: "stop-exit-codes",
    task: "t-9d76b1",
    stamp,
    measurements,
  };
  const body = `${JSON.stringify(report, null, 2)}\n`;
  fs.writeFileSync(path.join(EVIDENCE_DIR, `${stamp}.json`), body);
  fs.writeFileSync(path.join(EVIDENCE_DIR, "latest.json"), body);
  console.log(`\nevidence: ${path.join(EVIDENCE_DIR, "latest.json")}`);
}

await main();
