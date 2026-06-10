import type { AgentDef, TachyonConfig } from "../config/loadConfig.js";
import { TmuxService, sessionName, agentFromSession, SESSION_PREFIX } from "../tmux/TmuxService.js";

export class MaxAgentsError extends Error {
  constructor(max: number) {
    super(`maxAgents limit reached (${max}); kill an agent or raise settings.maxAgents in tachyon.yml`);
    this.name = "MaxAgentsError";
  }
}

export class UnknownAgentError extends Error {
  constructor(name: string) {
    super(`unknown agent '${name}': not declared in tachyon.yml and not running`);
    this.name = "UnknownAgentError";
  }
}

export class AgentNotRunningError extends Error {
  constructor(name: string) {
    super(`agent '${name}' is not running`);
    this.name = "AgentNotRunningError";
  }
}

export interface AgentInfo {
  name: string;
  session: string;
  /** alive process (a crashed dead-pane session is NOT running) */
  running: boolean;
  declared: boolean;
  /** process died on its own; the dead pane is kept for postmortem until dismiss/restart */
  crashed: boolean;
  exitCode?: number;
}

export interface AgentManagerOptions {
  tmux: TmuxService;
  wsHash: string;
  workspaceRoot: string;
  getConfig: () => TachyonConfig | undefined;
  getMaxAgents: () => number;
  onSpawned?: (name: string) => void;
  onKilled?: (name: string) => void;
}

/**
 * Lifecycle orchestration over TmuxService. tmux is the source of truth for what's
 * running; the only in-memory state is the definition of ad-hoc (MCP-spawned) agents,
 * which does not survive an extension restart by design.
 */
export class AgentManager {
  private adhoc = new Map<string, AgentDef>();

  constructor(private readonly opts: AgentManagerOptions) {}

  private get prefix(): string {
    return `${SESSION_PREFIX}-${this.opts.wsHash}-`;
  }

  session(name: string): string {
    return sessionName(this.opts.wsHash, name);
  }

  private definitionOf(name: string): AgentDef | undefined {
    return this.opts.getConfig()?.agents[name] ?? this.adhoc.get(name);
  }

  /** Per-agent session state for this workspace: alive, or dead pane with exit code. */
  async agentStates(): Promise<Map<string, { dead: boolean; exitCode?: number }>> {
    const sessions = await this.opts.tmux.sessionStates(this.prefix);
    const out = new Map<string, { dead: boolean; exitCode?: number }>();
    for (const [session, state] of sessions) {
      const agent = agentFromSession(this.opts.wsHash, session);
      if (agent !== null) out.set(agent, state);
    }
    return out;
  }

  /** Agents whose process is ALIVE — crashed dead panes don't count. */
  async runningAgents(): Promise<string[]> {
    const states = await this.agentStates();
    return [...states.entries()].filter(([, s]) => !s.dead).map(([agent]) => agent);
  }

  async list(): Promise<AgentInfo[]> {
    const states = await this.agentStates();
    const declared = Object.keys(this.opts.getConfig()?.agents ?? {});
    const all = new Set([...declared, ...states.keys(), ...this.adhoc.keys()]);
    return [...all].sort().map((name) => {
      const state = states.get(name);
      return {
        name,
        session: this.session(name),
        running: state !== undefined && !state.dead,
        declared: declared.includes(name),
        crashed: state?.dead ?? false,
        exitCode: state?.exitCode,
      };
    });
  }

  /** Spawns a declared agent, or an ad-hoc one when `cmd` is given. No-op error if already running. */
  async spawn(name: string, adhocDef?: { cmd: string; cwd?: string }): Promise<void> {
    let def = this.definitionOf(name);
    if (adhocDef) {
      def = {
        cmd: adhocDef.cmd,
        cwd: adhocDef.cwd,
        autostart: false,
        watch: [],
        attention: { enabled: true, silenceSec: 8, patterns: [] },
        restart: "never",
      };
    }
    if (!def) throw new UnknownAgentError(name);

    const session = this.session(name);
    if (await this.opts.tmux.hasSession(session)) {
      const state = (await this.agentStates()).get(name);
      if (state && state.dead) {
        // Spawning over a crashed agent replaces the dead postmortem pane.
        await this.opts.tmux.killSession(session);
      } else {
        throw new Error(`agent '${name}' is already running`);
      }
    }

    const liveCount = (await this.runningAgents()).length;
    const max = this.opts.getConfig()?.settings.maxAgents ?? this.opts.getMaxAgents();
    if (liveCount >= max) throw new MaxAgentsError(max);

    await this.opts.tmux.newSession({
      name: session,
      cmd: def.cmd,
      cwd: resolveCwd(this.opts.workspaceRoot, def.cwd),
      env: def.env,
    });
    if (adhocDef) this.adhoc.set(name, def);
    this.opts.onSpawned?.(name);
  }

  async kill(name: string): Promise<void> {
    const session = this.session(name);
    if (!(await this.opts.tmux.hasSession(session))) throw new AgentNotRunningError(name);
    await this.opts.tmux.killSession(session);
    this.opts.onKilled?.(name);
  }

  async restart(name: string): Promise<void> {
    const def = this.definitionOf(name);
    if (!def) {
      throw new Error(
        `cannot restart '${name}': no stored definition (re-discovered ad-hoc agents lose their definition across extension restarts — kill and re-spawn instead)`,
      );
    }
    const session = this.session(name);
    if (await this.opts.tmux.hasSession(session)) {
      await this.opts.tmux.killSession(session);
    }
    await this.opts.tmux.newSession({
      name: session,
      cmd: def.cmd,
      cwd: resolveCwd(this.opts.workspaceRoot, def.cwd),
      env: def.env,
    });
    this.opts.onSpawned?.(name);
  }

  /** Kills every session of this workspace — alive agents and crashed postmortem panes alike. */
  async killAll(): Promise<string[]> {
    const all = [...(await this.agentStates()).keys()];
    for (const name of all) {
      await this.opts.tmux.killSession(this.session(name));
      this.opts.onKilled?.(name);
    }
    return all;
  }

  /**
   * Declared autostart agents with no session at all (the activation spawn set).
   * Crashed agents are excluded — replacing their dead pane would erase the
   * postmortem; the restart policy or the human decides that.
   */
  async autostartPending(): Promise<string[]> {
    const config = this.opts.getConfig();
    if (!config) return [];
    const present = new Set((await this.agentStates()).keys());
    return Object.entries(config.agents)
      .filter(([name, def]) => def.autostart && !present.has(name))
      .map(([name]) => name);
  }
}

function resolveCwd(workspaceRoot: string, cwd?: string): string {
  if (!cwd) return workspaceRoot;
  if (cwd.startsWith("/")) return cwd;
  return `${workspaceRoot.replace(/\/$/, "")}/${cwd}`;
}

/**
 * Debounced restart-on-file-change. The watcher primitive is injected so this stays
 * testable outside the VSCode host (the extension wires vscode.FileSystemWatcher).
 */
export class WatchController {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposables: Array<() => void> = [];

  constructor(
    private readonly restart: (agent: string) => Promise<void>,
    private readonly debounceMs = 500,
  ) {}

  /** Registers a change-event source for an agent; returns the controller for chaining. */
  watch(agent: string, subscribe: (onChange: () => void) => () => void): this {
    const dispose = subscribe(() => this.onChange(agent));
    this.disposables.push(dispose);
    return this;
  }

  onChange(agent: string): void {
    const existing = this.timers.get(agent);
    if (existing) clearTimeout(existing);
    this.timers.set(
      agent,
      setTimeout(() => {
        this.timers.delete(agent);
        void this.restart(agent);
      }, this.debounceMs),
    );
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const dispose of this.disposables) dispose();
    this.disposables = [];
  }
}
