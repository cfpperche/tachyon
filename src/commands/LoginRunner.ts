import type { TmuxService } from "../tmux/TmuxService.js";
import { RUNTIME_LOGIN } from "../runtime/authRequired.js";
import type { ResumeRuntime } from "../resume/adapters.js";

/**
 * t-2656d7 (SDD 495, first slice) — the pane a human logs a runtime in from.
 *
 * A sibling of `CommandRunner`, not a reuse of it, for two reasons the plan states: a login command
 * is NOT user-declared (`CommandRunner` resolves its command from `tachyon.yml commands:`, and its
 * comment block is a contract about declared commands), and this session's completion semantics are
 * different — a login pane exiting says the flow ENDED, never that it SUCCEEDED. It inherits the
 * tmux mechanics and the namespace property, which is the part worth sharing.
 *
 * Its own namespace (`tachyon-login-<wsHash>-<runtime>`) buys exactly what `CommandRunner`'s buys:
 * invisible to `AgentManager`/`LifecycleMonitor` — no crash toast, no restart policy, no `maxAgents`
 * slot — because none of those mean anything for a pane whose job is to exit.
 *
 * **Keyed by RUNTIME, never by agent.** A credential belongs to a config home, not to an agent, so
 * one login serves every agent on that runtime. Keying this way makes the same-key refusal below the
 * concurrency policy at no cost: N unauthenticated agents cannot race N device flows for one
 * account, because the second `run` for a live runtime session refuses and the caller reveals the
 * pane that already exists.
 *
 * Three rules this class holds, each from the SDD 495 threat model:
 *
 *  - **It never writes to the pane.** No stdin, no `send-keys`. The human types; Tachyon allocates
 *    the PTY. Claude's login ends at a paste-back prompt, which is the worst possible place for a
 *    blind keystroke.
 *  - **It never reads the pane.** No capture consumer exists for this prefix. A device code is a
 *    bearer secret for the duration of the flow — Grok's own screen says so — and capturing it into
 *    a log or an attention record would publish it.
 *  - **It runs against the REAL config home.** The login must write the authority that private homes
 *    are projected from; a private home is a projection and must never become the auth source.
 */

export interface LoginRunnerOptions {
  tmux: TmuxService;
  wsHash: string;
  /** Where the pane starts. The login writes a config home, so this only decides the shell's cwd. */
  workspaceRoot: string;
  /**
   * The env the login runs under: the REAL credential home for that runtime, resolved by the caller
   * from the same authorities `HarnessManager` projects from. Passed in rather than computed here so
   * there is one place that decides what "the real home" means.
   */
  realHomeEnv: (runtime: ResumeRuntime) => Record<string, string>;
  /** Fired when a login pane is observed dead (tick-detected). Exit code is NOT a login verdict. */
  onFinished?: (runtime: ResumeRuntime, exitCode: number | undefined) => void;
}

export class LoginRunner {
  /** Runtimes with a session this process started and has not yet reported as finished. */
  private readonly open = new Set<ResumeRuntime>();

  constructor(private readonly opts: LoginRunnerOptions) {}

  get prefix(): string {
    return `tachyon-login-${this.opts.wsHash}-`;
  }

  session(runtime: ResumeRuntime): string {
    return `${this.prefix}${runtime}`;
  }

  private runtimeFromSession(session: string): ResumeRuntime | null {
    if (!session.startsWith(this.prefix)) return null;
    const name = session.slice(this.prefix.length);
    return name in RUNTIME_LOGIN ? (name as ResumeRuntime) : null;
  }

  /**
   * Start the runtime's login pane, or answer `already-running` when one is live.
   *
   * `already-running` is not an error: the caller's next move is the same either way — reveal the
   * pane — and a second agent joining an in-flight login is the expected case, not a fault.
   */
  async run(runtime: ResumeRuntime): Promise<"started" | "already-running"> {
    const profile = RUNTIME_LOGIN[runtime];
    if (!profile) throw new Error(`no measured login command for runtime '${runtime}'`);
    const session = this.session(runtime);
    const states = (await this.opts.tmux.sessionStates(this.prefix)) ?? new Map();
    const existing = states.get(session);
    if (existing && !existing.dead) return "already-running";
    // A finished pane is replaced rather than reused: its exit code and output belong to the
    // previous attempt, and remain-on-exit would otherwise hand the human a frozen screen.
    if (existing) await this.opts.tmux.killSession(session);
    await this.opts.tmux.newSession({
      name: session,
      cmd: profile.command,
      cwd: this.opts.workspaceRoot,
      env: this.opts.realHomeEnv(runtime),
    });
    this.open.add(runtime);
    return "started";
  }

  /** True while this process is waiting on a login pane it started for `runtime`. */
  isOpen(runtime: ResumeRuntime): boolean {
    return this.open.has(runtime);
  }

  /**
   * Detect finished login panes; called from the workspace heartbeat.
   *
   * Reports each pane exactly once — `open` is the one-shot. The pane itself is left alive
   * (remain-on-exit) so a cancelled or failed flow stays inspectable instead of vanishing.
   */
  async tick(): Promise<void> {
    if (this.open.size === 0) return;
    const states = (await this.opts.tmux.sessionStates(this.prefix)) ?? new Map();
    for (const [session, state] of states) {
      if (!state.dead) continue;
      const runtime = this.runtimeFromSession(session);
      if (!runtime || !this.open.has(runtime)) continue;
      this.open.delete(runtime);
      this.opts.onFinished?.(runtime, state.exitCode);
    }
  }
}
