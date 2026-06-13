import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { composeCommand, inferKind, type AgentDef, type EntryKind, type TachyonConfig } from "../config/loadConfig.js";
import { TmuxService, sessionName, agentFromSession, SESSION_PREFIX } from "../tmux/TmuxService.js";
import { adapterFor, adapterForRuntime, managesOwnSession, type ResumeRuntime } from "../resume/adapters.js";
import type { SessionLedger, SessionRecord } from "../resume/SessionLedger.js";

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

/** Resume couldn't proceed (no id / transcript gone) — caller should fall back to a fresh spawn. */
export class ResumeUnavailableError extends Error {
  constructor(
    readonly agent: string,
    reason: string,
  ) {
    super(`cannot resume '${agent}': ${reason}`);
    this.name = "ResumeUnavailableError";
  }
}

export interface AgentInfo {
  name: string;
  session: string;
  /** alive process (a crashed dead-pane session is NOT running) */
  running: boolean;
  declared: boolean;
  /** dead pane present (process ended on its own; postmortem kept until dismiss/restart) */
  dead: boolean;
  /** dead with a NON-ZERO exit — a clean exit (0) is dead but not crashed */
  crashed: boolean;
  exitCode?: number;
  /** agent = AI CLI; terminal = server/shell/build. Inferred or declared in tachyon.yml. */
  kind: EntryKind;
  /** who spawned it (self-declared via spawn_agent's parent param; session-local memory) */
  parent?: string;
}

export interface SpawnOptions {
  /** present = ad-hoc agent (not declared in tachyon.yml) */
  cmd?: string;
  cwd?: string;
  /** role prompt for ad-hoc agents — delivered via composeCommand like declared ones */
  instructions?: string;
  /** lineage: the agent that requested this spawn (self-declared) */
  parent?: string;
  /** open + focus the editor terminal on spawn (default true). The Bridge passes false
   *  so an agent spawning a child doesn't yank the human's focus off the parent (F3). */
  reveal?: boolean;
}

export interface AgentManagerOptions {
  tmux: TmuxService;
  wsHash: string;
  workspaceRoot: string;
  getConfig: () => TachyonConfig | undefined;
  getMaxAgents: () => number;
  /** Env injected into every spawned session (e.g. TACHYON_BRIDGE_URL/TOKEN); agent-declared env wins on conflict. */
  getExtraEnv?: () => Record<string, string>;
  onSpawned?: (name: string, reveal: boolean) => void;
  onKilled?: (name: string) => void;
  /** Fired at the START of a restart (before the session is killed) — lets the UI close the
   * old editor terminal synchronously, so the post-spawn onSpawned re-opens a fresh one
   * instead of reusing the now-dead terminal (which closes async when its tmux client dies). */
  onRestart?: (name: string) => void;
  /** Session-resume ledger (spec 209); absent = resume tracking disabled. */
  ledger?: SessionLedger;
  /** Session-id generator for mint runtimes (claude/gemini); default crypto UUID. */
  newSessionId?: () => string;
  /** Resolve a capture-runtime's session id from disk by cwd (codex/opencode/...); fills "" ledger entries. */
  resolveCaptureId?: (runtime: ResumeRuntime, cwd: string) => Promise<string | null>;
  /** Transcript-existence probe (default fs.existsSync) — injected for tests. */
  fileExists?: (path: string) => boolean;
  /** Home dir resolver (default os.homedir) — injected for tests. */
  homeDir?: () => string;
}

/**
 * Lifecycle orchestration over TmuxService. tmux is the source of truth for what's
 * running; the only in-memory state is the definition of ad-hoc (MCP-spawned) agents,
 * which does not survive an extension restart by design.
 */
export class AgentManager {
  private adhoc = new Map<string, AgentDef>();
  /** child -> parent. Like adhoc defs, lineage is session-local memory: tmux sessions
   * survive an extension restart, the genealogy does not (documented). */
  private lineage = new Map<string, string>();

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

  /** An agent's kind (config wins, then ad-hoc def, else infer from a running session's
   *  command). Used to give ad-hoc TERMINALS terminal defaults (e.g. attention off) — F5. */
  kindOf(name: string): EntryKind {
    return this.definitionOf(name)?.kind ?? "agent";
  }

  /**
   * Spec 211: after a host restart, rebuild the in-memory ad-hoc defs + lineage
   * from the ledger so a re-discovered ad-hoc agent is restartable and re-nests.
   * Only `def`-bearing rows whose name is NOT currently declared in config (config
   * is authoritative) and not already live in memory; idempotent; self-parent links
   * are dropped. Resume rows without a def (none today) are ignored.
   */
  rehydrateFromLedger(): void {
    if (!this.opts.ledger) return;
    const declared = new Set(Object.keys(this.opts.getConfig()?.agents ?? {}));
    for (const [name, rec] of this.opts.ledger.all()) {
      if (!rec.def || rec.declared || declared.has(name)) continue;
      if (!this.adhoc.has(name)) {
        this.adhoc.set(name, {
          cmd: rec.def.cmd,
          instructions: rec.def.instructions,
          autostart: false,
          watch: [],
          attention: { enabled: true, silenceSec: 8, patterns: [] },
          restart: "never",
          kind: rec.def.kind,
        });
      }
      if (rec.def.parent && rec.def.parent !== name && !this.lineage.has(name)) {
        this.lineage.set(name, rec.def.parent);
      }
    }
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
    const infos = [...all].sort().map((name) => {
      const state = states.get(name);
      return {
        name,
        session: this.session(name),
        running: state !== undefined && !state.dead,
        declared: declared.includes(name),
        dead: state?.dead ?? false,
        crashed: (state?.dead ?? false) && state?.exitCode !== 0,
        exitCode: state?.exitCode,
        kind: this.definitionOf(name)?.kind ?? "agent",
        parent: this.lineage.get(name),
      };
    });
    // F6 (spec 211 follow-up): a finished ad-hoc one-shot (clean exit 0) must not
    // survive a window reload as a zombie restartable row — drop its ledger entry
    // so rehydrate skips it. The dead pane stays in-session for postmortem until
    // dismissed; crashed (non-zero) ad-hocs ARE kept (restart/postmortem). remove()
    // is idempotent (writes only when the row existed), so this is render-safe.
    for (const info of infos) {
      if (!info.declared && info.dead && info.exitCode === 0) this.opts.ledger?.remove(info.name);
    }
    return infos;
  }

  /** Spawns a declared agent, or an ad-hoc one when `opts.cmd` is given. No-op error if already running. */
  async spawn(name: string, opts?: SpawnOptions): Promise<void> {
    let def = this.definitionOf(name);
    if (opts?.cmd) {
      def = {
        cmd: opts.cmd,
        cwd: opts.cwd,
        instructions: opts.instructions,
        autostart: false,
        watch: [],
        attention: { enabled: true, silenceSec: 8, patterns: [] },
        restart: "never",
        kind: inferKind(opts.cmd),
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

    const cwd = resolveCwd(this.opts.workspaceRoot, def.cwd);
    const adhoc = !!opts?.cmd;
    const parent = opts?.parent && opts.parent !== name ? opts.parent : undefined;
    // Session-resume bookkeeping (spec 209): mint a session id for runtimes that
    // accept one (claude/gemini). The ORIGINAL cmd is kept for the ledger def +
    // adhoc map; the injected one is only what we spawn.
    const adapter = adapterFor(def.cmd);
    const originalCmd = def.cmd;
    // A self-resuming cmd (the user already passed --resume/--continue/--session-id)
    // is run verbatim: we neither mint our own id (claude exits 1 on --session-id +
    // --resume without --fork-session) nor record a resume block (its own cmd resumes
    // on restart). Without this, every start of such an agent crashes.
    const selfManaged = !!adapter?.mintsId && managesOwnSession(def.cmd);
    let resumeId = "";
    // Mint only when we can persist the id (a ledger exists) — an injected id we
    // never record is useless and unresumable.
    if (adapter?.mintsId && this.opts.ledger && !selfManaged) {
      resumeId = (this.opts.newSessionId ?? (() => crypto.randomUUID()))();
      def = { ...def, cmd: adapter.injectId(def.cmd, resumeId) };
    }

    await this.opts.tmux.newSession({
      name: session,
      cmd: composeCommand(def),
      cwd,
      env: { ...this.opts.getExtraEnv?.(), ...def.env },
    });

    // Persist ONLY after a successful spawn (spec 211: no phantom rows). Record a
    // `def` for every ad-hoc agent (drives restart + lineage, incl. non-AI `sh`);
    // a `resume` block only for adapter-backed runtimes.
    if (this.opts.ledger && (adhoc || adapter)) {
      const defBlock = {
        cmd: originalCmd,
        kind: def.kind,
        ...(def.instructions ? { instructions: def.instructions } : {}),
        ...(parent ? { parent } : {}),
      };
      const resumeBlock = adapter && !selfManaged ? { runtime: adapter.runtime, sessionId: resumeId } : undefined;
      this.opts.ledger.record(name, { def: defBlock, resume: resumeBlock, cwd, declared: !adhoc });
    }
    if (adhoc) this.adhoc.set(name, { ...def, cmd: originalCmd });
    if (parent) this.lineage.set(name, parent);
    this.opts.onSpawned?.(name, opts?.reveal ?? true);
  }

  async kill(name: string): Promise<void> {
    const session = this.session(name);
    if (!(await this.opts.tmux.hasSession(session))) throw new AgentNotRunningError(name);
    await this.opts.tmux.killSession(session);
    const wasAdhoc = this.adhoc.has(name);
    this.lineage.delete(name); // children of a killed parent are promoted at render time
    this.adhoc.delete(name); // a killed ad-hoc agent leaves the listing entirely
    // Spec 211: an ad-hoc agent's ledger row must go too, or it resurrects as a
    // permanent stopped entry on the next activation. Declared agents keep their
    // row (still resumable later).
    if (wasAdhoc) this.opts.ledger?.remove(name);
    this.opts.onKilled?.(name);
  }

  /**
   * Live rename: moves the tmux session (alive or dead pane — attached clients
   * follow it) plus every piece of session-local memory keyed by the old name:
   * ad-hoc definition, lineage (its own parent AND children pointing at it),
   * and the resume-ledger record. The yml definition is the caller's job
   * (declared agents only — ad-hoc ones have nothing in the config).
   */
  async rename(oldName: string, newName: string): Promise<void> {
    if (oldName === newName) return;
    if (this.definitionOf(newName)) throw new Error(`agent '${newName}' already exists`);
    const states = await this.agentStates();
    if (states.has(newName)) throw new Error(`a session named '${newName}' already exists`);
    if (states.has(oldName)) {
      await this.opts.tmux.renameSession(this.session(oldName), this.session(newName));
    }

    const def = this.adhoc.get(oldName);
    if (def) {
      this.adhoc.delete(oldName);
      this.adhoc.set(newName, def);
    }
    const parent = this.lineage.get(oldName);
    if (parent) {
      this.lineage.delete(oldName);
      this.lineage.set(newName, parent);
    }
    for (const [child, p] of this.lineage) {
      if (p === oldName) this.lineage.set(child, newName);
    }
    if (this.opts.ledger) {
      const rec = this.opts.ledger.get(oldName);
      if (rec) {
        this.opts.ledger.remove(oldName);
        this.opts.ledger.record(newName, rec);
      }
      // Spec 211: rewrite the persisted parent of every child pointing at oldName,
      // so lineage survives a rename across a restart.
      for (const [child, crec] of this.opts.ledger.all()) {
        if (crec.def?.parent === oldName) {
          this.opts.ledger.record(child, { ...crec, def: { ...crec.def, parent: newName } });
        }
      }
    }
  }

  /** Drop an ad-hoc agent's in-memory def + lineage (spec 211: after promotion to
   *  tachyon.yml, config is authoritative — no lingering ad-hoc shadow). */
  forgetAdhoc(name: string): void {
    this.adhoc.delete(name);
    this.lineage.delete(name);
  }

  /**
   * Fully forget an ad-hoc agent — in-memory def + lineage AND its persisted
   * ledger row — so a sessionless/finished one won't rehydrate after a reload.
   * (The live dead-pane clean-exit case is auto-handled by list(); this is the
   * explicit user "dismiss" for a stopped row, or a one-shot whose pane vanished
   * before list() observed its exit.) Idempotent.
   */
  dismissAdhoc(name: string): void {
    this.forgetAdhoc(name);
    this.opts.ledger?.remove(name);
  }

  async restart(name: string): Promise<void> {
    const def = this.definitionOf(name);
    if (!def) {
      throw new Error(
        `cannot restart '${name}': no stored definition (re-discovered ad-hoc agents lose their definition across extension restarts — kill and re-spawn instead)`,
      );
    }
    // Close the old editor terminal up front (synchronously) so onSpawned re-opens a
    // fresh one. Killing the session below would otherwise close it async, racing the
    // re-open into reusing a dead terminal (it'd take a second restart to reappear).
    this.opts.onRestart?.(name);
    const session = this.session(name);
    if (await this.opts.tmux.hasSession(session)) {
      await this.opts.tmux.killSession(session);
    }
    await this.opts.tmux.newSession({
      name: session,
      cmd: composeCommand(def),
      cwd: resolveCwd(this.opts.workspaceRoot, def.cwd),
      env: { ...this.opts.getExtraEnv?.(), ...def.env },
    });
    this.opts.onSpawned?.(name, true); // restart is a human action — reveal the fresh terminal
  }

  /**
   * Respawns an agent from a ledger record with the runtime's resume command, so it
   * recovers its prior conversation (spec 209). For capture runtimes with no stored
   * id, resolves it from disk by cwd. Throws ResumeUnavailableError when the id can't
   * be resolved or the transcript is gone — the caller falls back to a fresh spawn.
   */
  async resume(name: string, record: SessionRecord): Promise<void> {
    if (!record.resume) throw new ResumeUnavailableError(name, "record is not resumable (no resume block)");
    const { runtime } = record.resume;
    const cmd = record.def?.cmd;
    if (!cmd) throw new ResumeUnavailableError(name, "record has no command to resume");
    const adapter = adapterForRuntime(runtime);
    if (!adapter) throw new ResumeUnavailableError(name, `no resume adapter for '${runtime}'`);

    let id = record.resume.sessionId;
    if (!id) id = (await this.opts.resolveCaptureId?.(runtime, record.cwd)) ?? "";
    // qwen (resumesWithoutId) resumes the last session for its cwd via --continue,
    // so an empty id is fine; every other runtime needs a concrete id.
    if (!id && !adapter.resumesWithoutId) throw new ResumeUnavailableError(name, "no session id (capture runtime not resolved)");

    if (id && adapter.transcriptPath) {
      const exists = this.opts.fileExists ?? fs.existsSync;
      if (!exists(adapter.transcriptPath((this.opts.homeDir ?? os.homedir)(), record.cwd, id))) {
        throw new ResumeUnavailableError(name, "transcript no longer on disk (retention/deleted)");
      }
    }

    const session = this.session(name);
    if (await this.opts.tmux.hasSession(session)) await this.opts.tmux.killSession(session);
    const liveCount = (await this.runningAgents()).length;
    const max = this.opts.getConfig()?.settings.maxAgents ?? this.opts.getMaxAgents();
    if (liveCount >= max) throw new MaxAgentsError(max);

    await this.opts.tmux.newSession({
      name: session,
      cmd: adapter.resumeCommand(cmd, id),
      cwd: record.cwd,
      // Re-apply the declared agent's env on resume (spec 211 review fix) — spawn/restart
      // include def.env, but resume previously injected only bridge env, silently dropping
      // e.g. an ANTHROPIC_BASE_URL model-swap. definitionOf = config (declared) or adhoc def.
      env: { ...this.opts.getExtraEnv?.(), ...this.definitionOf(name)?.env },
    });
    this.opts.ledger?.record(name, { ...record, resume: { runtime, sessionId: id } });
    this.opts.onSpawned?.(name, true); // resume is activation/human-driven — reveal
  }

  /** Kills every session of this workspace — alive agents and crashed postmortem panes alike. */
  async killAll(): Promise<string[]> {
    const all = [...(await this.agentStates()).keys()];
    for (const name of all) {
      await this.opts.tmux.killSession(this.session(name));
      this.lineage.delete(name);
      this.adhoc.delete(name);
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
