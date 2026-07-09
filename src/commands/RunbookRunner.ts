import type { TmuxService } from "../tmux/TmuxService.js";
import type { TachyonConfig } from "../config/loadConfig.js";

/**
 * Runbooks: named sequences of steps, run one at a time with an exit-code gate —
 * a non-zero step stops the procedure and its pane is kept for inspection.
 * Steps resolve against the commands: map by exact name, else run as inline shell.
 * Job history is session-local memory (documented, like command history).
 *
 * Step sessions live in `tachyon-rb-<hash>-<runbook>-<n>` — their own namespace,
 * invisible to agents and plain commands alike.
 */

export interface StepResult {
  index: number;
  /** the step as written in tachyon.yml (command name or inline shell) */
  step: string;
  /** what actually ran */
  cmd: string;
  exitCode?: number;
  durationMs?: number;
  state: "running" | "passed" | "failed" | "skipped";
}

export interface RunbookJob {
  runbook: string;
  startedAt: number;
  finishedAt?: number;
  outcome?: "passed" | "failed";
  steps: StepResult[];
}

export interface RunbookRunnerOptions {
  tmux: TmuxService;
  wsHash: string;
  workspaceRoot: string;
  getConfig: () => TachyonConfig | undefined;
  /** fired when a job ends (either outcome) */
  onFinished?: (job: RunbookJob) => void;
  now?: () => number;
  /** completion poll interval while a step runs (ms) */
  stepPollMs?: number;
}

const HISTORY_CAP = 10;

export class RunbookRunner {
  private jobs = new Map<string, RunbookJob[]>(); // runbook -> history (newest last)
  private active = new Map<string, RunbookJob>();
  private readonly now: () => number;
  private readonly stepPollMs: number;

  constructor(private readonly opts: RunbookRunnerOptions) {
    this.now = opts.now ?? Date.now;
    this.stepPollMs = opts.stepPollMs ?? 1000;
  }

  get prefix(): string {
    return `tachyon-rb-${this.opts.wsHash}-`;
  }

  stepSession(runbook: string, index: number): string {
    return `${this.prefix}${runbook}-${index}`;
  }

  isRunning(runbook: string): boolean {
    return this.active.has(runbook);
  }

  currentJob(runbook: string): RunbookJob | undefined {
    return this.active.get(runbook) ?? this.history(runbook).slice(-1)[0];
  }

  history(runbook: string): RunbookJob[] {
    return [...(this.jobs.get(runbook) ?? [])];
  }

  list(): Array<{ name: string; running: boolean; lastJob?: RunbookJob }> {
    const declared = Object.keys(this.opts.getConfig()?.runbooks ?? {});
    return declared.sort().map((name) => ({
      name,
      running: this.active.has(name),
      lastJob: this.currentJob(name),
    }));
  }

  /** Resolves a step: exact command-name reference wins; otherwise inline shell. */
  resolveStep(step: string): string {
    return this.opts.getConfig()?.commands[step]?.cmd ?? step;
  }

  /**
   * Full resolution of a step for EXECUTION (spec 214 review fix): a command-name reference
   * carries its `cwd`/`env` too (matching CommandRunner), so a referenced command runs in the
   * right environment; an inline step is just its shell string. `cwd` is relative-to-the-root
   * (resolved by the runner against the effective cwd) or absolute, exactly like CommandRunner.
   */
  private resolveStepDef(step: string): { cmd: string; cwd?: string; env?: Record<string, string> } {
    const def = this.opts.getConfig()?.commands[step];
    return def ? { cmd: def.cmd, cwd: def.cwd, env: def.env } : { cmd: step };
  }

  /**
   * Runs the whole runbook to completion (sequential, exit-code gated).
   * Returns the finished job; concurrent runs of the same runbook are refused.
   * Callers that don't want to await it can fire-and-forget — the active job
   * is observable via currentJob()/isRunning(). `cwdOverride` (spec 214) runs the
   * steps in a different root (e.g. a worktree) instead of the workspace root.
   */
  async run(runbook: string, cwdOverride?: string): Promise<RunbookJob> {
    const def = this.opts.getConfig()?.runbooks[runbook];
    if (!def) throw new Error(`unknown runbook '${runbook}' (not declared under runbooks: in tachyon.yml)`);
    return this.runSteps(runbook, def.steps, cwdOverride);
  }

  /**
   * Core executor (spec 214) — run an arbitrary ordered `steps` list under `label` to
   * completion, exit-code gated, in `cwdOverride ?? workspaceRoot`. `run()` delegates here for
   * a declared runbook; the verify-gate delegates here for a single command-name/inline step.
   * Each step resolves via `resolveStep` (declared command name → its cmd, else inline shell).
   * Concurrent runs of the same `label` are refused.
   */
  async runSteps(label: string, steps: string[], cwdOverride?: string): Promise<RunbookJob> {
    if (this.active.has(label)) throw new Error(`runbook '${label}' is already running`);
    const cwd = cwdOverride ?? this.opts.workspaceRoot;

    const job: RunbookJob = {
      runbook: label,
      startedAt: this.now(),
      steps: steps.map((step, index) => ({
        index,
        step,
        cmd: this.resolveStep(step),
        state: "skipped",
      })),
    };
    this.active.set(label, job);

    try {
      // sweep panes from a previous job of this label
      const stale = (await this.opts.tmux.sessionStates(`${this.prefix}${label}-`)) ?? new Map();
      for (const session of stale.keys()) await this.opts.tmux.killSession(session);

      for (const step of job.steps) {
        step.state = "running";
        const started = this.now();
        const session = this.stepSession(label, step.index);
        // A referenced command brings its own cwd/env; a relative cwd resolves under the
        // effective root (the worktree for verify, else workspaceRoot) — same rule as CommandRunner.
        const def = this.resolveStepDef(step.step);
        const stepCwd = def.cwd ? (def.cwd.startsWith("/") ? def.cwd : `${cwd.replace(/\/$/, "")}/${def.cwd}`) : cwd;
        await this.opts.tmux.newSession({ name: session, cmd: def.cmd, cwd: stepCwd, env: def.env });

        // poll this step's pane until it dies (steps are one-shots by definition)
        let exitCode: number | undefined;
        for (;;) {
          const states = (await this.opts.tmux.sessionStates(`${this.prefix}${label}-`)) ?? new Map();
          const st = states.get(session);
          if (!st) {
            exitCode = undefined; // killed externally — treat as failure
            break;
          }
          if (st.dead) {
            exitCode = st.exitCode;
            break;
          }
          await new Promise((r) => setTimeout(r, this.stepPollMs));
        }

        step.exitCode = exitCode;
        step.durationMs = this.now() - started;
        step.state = exitCode === 0 ? "passed" : "failed";

        if (step.state === "passed") {
          // tidy panes of successful steps; failed panes are kept for inspection
          try {
            await this.opts.tmux.killSession(session);
          } catch {
            /* already gone */
          }
        } else {
          break; // gate: stop on first failure
        }
      }

      job.finishedAt = this.now();
      job.outcome = job.steps.every((s) => s.state === "passed") ? "passed" : "failed";
      return job;
    } finally {
      this.active.delete(label);
      const history = this.jobs.get(label) ?? [];
      history.push(job);
      while (history.length > HISTORY_CAP) history.shift();
      this.jobs.set(label, history);
      if (job.finishedAt === undefined) {
        job.finishedAt = this.now();
        job.outcome = "failed";
      }
      this.opts.onFinished?.(job);
    }
  }

  /** Last lines of a step's pane (failed steps keep theirs). */
  async stepTail(runbook: string, index: number, lines = 40): Promise<string> {
    return this.opts.tmux.capturePane(this.stepSession(runbook, index), { lines, joinWrapped: true });
  }

  async killAll(): Promise<void> {
    const states = (await this.opts.tmux.sessionStates(this.prefix)) ?? new Map();
    for (const session of states.keys()) {
      await this.opts.tmux.killSession(session);
    }
  }
}
