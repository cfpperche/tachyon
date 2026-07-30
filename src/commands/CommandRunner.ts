import { sweepSessions } from "../tmux/sessionSweep.js";
import type { TmuxService } from "../tmux/TmuxService.js";
import type { TachyonConfig, CommandDef } from "../config/loadConfig.js";

/**
 * One-shot commands: run → exit → show result. The lifecycle is INVERTED
 * relative to agents/terminals — exiting is the expected behavior (exit 0 =
 * pass, non-zero = fail), so command sessions live in their own namespace
 * (`tachyon-cmd-<hash>-…`), invisible to the AgentManager/LifecycleMonitor
 * (no crash toasts, no restart policies, no maxAgents slot).
 *
 * remain-on-exit (F2 infra) keeps the finished pane: exit code via
 * pane_dead_status and the output frozen for inspection. Run history is
 * session-local memory (like lineage/Temporary defs — documented).
 */

export interface CommandRun {
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
}

export type CommandState = "running" | "passed" | "failed" | "idle";

export interface CommandStatus {
  name: string;
  declared: boolean;
  state: CommandState;
  exitCode?: number;
  lastRun?: CommandRun;
}

export interface CommandRunnerOptions {
  tmux: TmuxService;
  wsHash: string;
  workspaceRoot: string;
  getConfig: () => TachyonConfig | undefined;
  /** fired when a run completes (tick-detected); durationMs from our start record when known */
  onFinished?: (name: string, exitCode: number | undefined, durationMs: number | undefined) => void;
  /** fired before a re-run kills the previous (finished) session — lets the UI close the old
   * editor terminal synchronously, so the post-run pane re-opens fresh instead of reusing the
   * dead one (which closes async when its tmux client dies). */
  onRerun?: (name: string) => void;
  now?: () => number;
}

const HISTORY_CAP = 20;

export class CommandRunner {
  private runs = new Map<string, CommandRun[]>(); // name -> history (newest last)
  private readonly now: () => number;

  constructor(private readonly opts: CommandRunnerOptions) {
    this.now = opts.now ?? Date.now;
  }

  get prefix(): string {
    return `tachyon-cmd-${this.opts.wsHash}-`;
  }

  session(name: string): string {
    return `${this.prefix}${name}`;
  }

  private nameFromSession(session: string): string | null {
    return session.startsWith(this.prefix) ? session.slice(this.prefix.length) : null;
  }

  private definitionOf(name: string): CommandDef | undefined {
    return this.opts.getConfig()?.commands[name];
  }

  /**
   * Starts a run; a finished pane is replaced, a live run refuses. `cwdOverride` (spec 214)
   * replaces the workspace root as the base the command runs in (e.g. a worktree) — a relative
   * `def.cwd` still resolves against it; an absolute `def.cwd` still wins.
   */
  async run(name: string, cwdOverride?: string): Promise<void> {
    const def = this.definitionOf(name);
    if (!def) throw new Error(`unknown command '${name}' (not declared under commands: in tachyon.yml)`);
    const states = (await this.opts.tmux.sessionStates(this.prefix)) ?? new Map();
    const existing = states.get(this.session(name));
    if (existing && !existing.dead) throw new Error(`command '${name}' is already running`);
    if (existing) {
      // Close the old editor pane up front so openCommandPane re-opens a fresh one
      // (killing the session below closes its terminal async — the re-open would
      // otherwise reuse the dead tab and show nothing).
      this.opts.onRerun?.(name);
      await this.opts.tmux.killSession(this.session(name));
    }

    const base = (cwdOverride ?? this.opts.workspaceRoot).replace(/\/$/, "");
    const cwd = def.cwd ? (def.cwd.startsWith("/") ? def.cwd : `${base}/${def.cwd}`) : base;
    await this.opts.tmux.newSession({ name: this.session(name), cmd: def.cmd, cwd, env: def.env });

    const history = this.runs.get(name) ?? [];
    history.push({ startedAt: this.now() });
    while (history.length > HISTORY_CAP) history.shift();
    this.runs.set(name, history);
  }

  /** Detects completed runs; called from the extension's existing ticker. */
  async tick(): Promise<void> {
    const states = (await this.opts.tmux.sessionStates(this.prefix)) ?? new Map();
    for (const [session, state] of states) {
      if (!state.dead) continue;
      const name = this.nameFromSession(session);
      if (!name) continue;
      const history = this.runs.get(name) ?? [];
      let open: CommandRun | undefined;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].finishedAt === undefined) {
          open = history[i];
          break;
        }
      }
      if (open) {
        open.finishedAt = this.now();
        open.exitCode = state.exitCode;
        this.opts.onFinished?.(name, state.exitCode, open.finishedAt - open.startedAt);
      }
    }
  }

  async status(name: string): Promise<CommandStatus> {
    const states = (await this.opts.tmux.sessionStates(this.prefix)) ?? new Map();
    const live = states.get(this.session(name));
    const history = this.runs.get(name) ?? [];
    const lastRun = history[history.length - 1];
    const declared = this.definitionOf(name) !== undefined;
    if (live && !live.dead) return { name, declared, state: "running", lastRun };
    if (live && live.dead) {
      return { name, declared, state: live.exitCode === 0 ? "passed" : "failed", exitCode: live.exitCode, lastRun };
    }
    return { name, declared, state: "idle", lastRun };
  }

  /** Declared commands + any leftover sessions (e.g. survivors of a restart). */
  async list(): Promise<CommandStatus[]> {
    const declared = Object.keys(this.opts.getConfig()?.commands ?? {});
    const states = (await this.opts.tmux.sessionStates(this.prefix)) ?? new Map();
    const present = [...states.keys()].map((s) => this.nameFromSession(s)).filter((n): n is string => n !== null);
    const all = [...new Set([...declared, ...present])].sort();
    return Promise.all(all.map((name) => this.status(name)));
  }

  /** Last lines of the run's pane — works on finished (dead) panes too. */
  async tail(name: string, lines = 40): Promise<string> {
    const text = await this.opts.tmux.capturePane(this.session(name), { lines, joinWrapped: true });
    const rows = text.split("\n");
    return rows.slice(-lines).join("\n").trim();
  }

  history(name: string): CommandRun[] {
    return [...(this.runs.get(name) ?? [])];
  }

  /** Kills every command session of this workspace (Stop All). */
  async killAll(): Promise<void> {
    // t-2d2ce7 — sweep until empty. The old `?? new Map()` turned an AMBIGUOUS read into "nothing to
    // kill", so a tmux hiccup silently made Stop All a no-op here; and a single pass could not catch
    // a session born while it ran.
    await sweepSessions(this.opts.tmux, this.prefix);
  }
}
