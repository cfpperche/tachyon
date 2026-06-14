import * as vscode from "vscode";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TmuxService, workspaceHash, SESSION_PREFIX } from "../tmux/TmuxService.js";
import { ControlModeClient } from "../tmux/ControlModeClient.js";
import { loadConfigFile, CONFIG_FILENAMES, inferKind, type TachyonConfig } from "../config/loadConfig.js";
import { upsertAgent, upsertCommand, upsertRunbook, upsertLayout, upsertSchedule, deleteSchedule, renameAgent as renameAgentInYml } from "../config/YamlConfigEditor.js";
import { AgentManager, ResumeUnavailableError, WatchController } from "../agents/AgentManager.js";
import { SessionLedger } from "../resume/SessionLedger.js";
import { WorktreeManager, resolveWorktreeCwd, type WorktreeRecord } from "../worktree/WorktreeManager.js";
import { effectiveVerify, verifySteps, verifyStale, verifyBadge, suggestVerify, type VerifyState, type VerifyBadge } from "../worktree/verify.js";
import { detectStack, type DetectedProject } from "../init/initLogic.js";
import { resolveCaptureId, resolveCurrentSession } from "../resume/resolvers.js";
import { planResume, autoResumes, offers, type ResumePlanItem } from "../resume/planResume.js";
import { LifecycleMonitor } from "../agents/LifecycleMonitor.js";
import { AttentionMonitor, type AgentAttention } from "../attention/AttentionMonitor.js";
import { compileExtraPatterns } from "../attention/patterns.js";
import { subtreeCpuTicks } from "../attention/cpu.js";
import { Waiters } from "../bridge/Waiters.js";
import { Bridge, derivePort } from "../bridge/Bridge.js";
import { loadOrCreateToken, TOKEN_ENV_VAR, URL_ENV_VAR } from "../bridge/token.js";
import { CMD_WAIT_PREFIX } from "../bridge/tools.js";
import { CommandRunner } from "../commands/CommandRunner.js";
import { RunbookRunner } from "../commands/RunbookRunner.js";
import { Scheduler } from "../schedule/Scheduler.js";
import { ProposalStore } from "../schedule/ProposalStore.js";
import { PinStore } from "../pins/PinStore.js";
import { Terminals } from "../presentation/Terminals.js";
import { applyLayout } from "../presentation/Layouts.js";
import { captureToEntry } from "../presentation/layoutLogic.js";
import { detectInstalledClis } from "../webview/cliDetect.js";
import { validateForm, blockingErrors, toEntry } from "../webview/formLogic.js";
import type { StudioSubmit, StudioDeps } from "../webview/AgentForm.js";
import { notify } from "./notify.js";

const ATTENTION_POLL_MS = 3000;

/**
 * spec 214 — internal label a verify run uses with the runbook executor. MUST be tmux-safe:
 * a `:` is tmux's session:window target separator, so the label can NOT contain one (review
 * fix: `verify:<agent>` broke new-session). The leading `_` is also NAME_RE-impossible (names
 * must start with a letter), so it can never collide with a user-declared runbook/command name
 * (round-2 review fix: `verify-<agent>` could clash with a runbook literally named that).
 */
const VERIFY_LABEL_PREFIX = "_verify-";
const verifyLabel = (agent: string): string => `${VERIFY_LABEL_PREFIX}${agent}`;

/** Which sidebar surface a Workspace event touches. */
export type ViewKind = "agents" | "layouts" | "pins" | "commands" | "schedules";

export interface WorkspaceDeps {
  context: vscode.ExtensionContext;
  /** refresh the (global) sidebar providers + the attention badge */
  onViewsChanged: (view: ViewKind) => void;
}

const warnedPatterns = new Set<string>();

/** Best-effort file read for the verify-stack framework hints (composer/Gemfile); undefined on any failure. */
function safeRead(p: string): string | undefined {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

function safePatterns(sources: string[]): RegExp[] {
  const good: RegExp[] = [];
  for (const src of sources) {
    try {
      good.push(...compileExtraPatterns([src]));
    } catch {
      if (!warnedPatterns.has(src)) {
        warnedPatterns.add(src);
        notify(vscode.l10n.t("invalid attention pattern ignored: {0}", src), "warn");
      }
    }
  }
  return good;
}

const issueMessage = (issue: { code: string; param?: string }): string => {
  switch (issue.code) {
    case "name-invalid":
      return vscode.l10n.t("name: letters/digits/_/-, starting with a letter");
    case "name-taken":
      return vscode.l10n.t("name '{0}' already exists", issue.param ?? "");
    case "cmd-required":
      return vscode.l10n.t("command: required");
    case "steps-required":
      return vscode.l10n.t("steps: at least one step is required");
    case "instructions-not-deliverable":
      return vscode.l10n.t("note: this CLI doesn't accept a startup prompt — instructions will be saved but not auto-delivered");
    default:
      return issue.code;
  }
};

/**
 * Everything Tachyon runs FOR ONE FOLDER — config, agents, monitors, runners,
 * Bridge, engine, pins, watchers. The extension holds a registry of these
 * (multi-root, F9); the isolation underneath (tmux namespace, token, derived
 * port, .tachyon/ files) was always per-folder via wsHash, so this class is
 * the organizational seam, not new isolation.
 */
export class Workspace {
  readonly wsHash: string;
  readonly tmux: TmuxService;
  readonly terminals: Terminals;
  readonly manager: AgentManager;
  readonly ledger: SessionLedger;
  readonly worktrees: WorktreeManager;
  /** Dead agents with a resumable session that we did NOT auto-resume — offered to the human (spec 209). */
  private resumable: ResumePlanItem[] = [];
  readonly monitor: AttentionMonitor;
  readonly waiters: Waiters;
  readonly lifecycle: LifecycleMonitor;
  readonly pinStore: PinStore;
  readonly commandRunner: CommandRunner;
  readonly runbookRunner: RunbookRunner;
  readonly scheduler: Scheduler;
  readonly proposals: ProposalStore;
  readonly bridge: Bridge;
  readonly token: string | undefined;
  readonly authEnabled: boolean;
  config: TachyonConfig | undefined;

  private readonly engine: ControlModeClient;
  private watches: WatchController;
  private readonly disposables: vscode.Disposable[] = [];
  private lifecycleTrigger: NodeJS.Timeout | undefined;
  private ticker: NodeJS.Timeout | undefined;
  private engineWarned = false;

  private constructor(
    readonly workspaceRoot: string,
    private readonly deps: WorkspaceDeps,
  ) {
    this.wsHash = workspaceHash(workspaceRoot);
    this.tmux = new TmuxService();
    // F20 engine: persistent control-mode client — command channel (zero
    // subprocess churn) + event-driven lifecycle; subprocess fallback when down.
    this.engine = new ControlModeClient({
      wsHash: this.wsHash,
      onDeadMapChanged: () => this.triggerLifecycle(),
      onSessionsChanged: () => this.triggerLifecycle(),
      onStateChange: (isUp) => {
        if (!isUp && !this.engineWarned) {
          this.engineWarned = true;
          console.warn(`Tachyon[${this.folderName}]: control-mode engine down — subprocess fallback (reconnecting)`);
        }
        if (isUp) this.engineWarned = false;
      },
    });
    this.tmux.useExecutor(this.engine.makeExecutor());
    this.terminals = new Terminals((_agent, session) => void this.tmux.refreshClients(session));

    // Auth: stable per-workspace token (extension storage — never in a committable file).
    const earlyFile = this.configPath();
    const earlyConfig = earlyFile ? loadConfigFile(earlyFile).config : undefined;
    this.authEnabled = earlyConfig?.settings.auth ?? true;
    this.token = this.authEnabled ? loadOrCreateToken(deps.context.globalStorageUri.fsPath, this.wsHash) : undefined;

    this.ledger = new SessionLedger(workspaceRoot);
    this.worktrees = new WorktreeManager({
      workspaceRoot,
      wsHash: this.wsHash,
      getSettings: () => this.config?.settings ?? {},
    });
    this.manager = new AgentManager({
      tmux: this.tmux,
      wsHash: this.wsHash,
      workspaceRoot,
      ledger: this.ledger,
      resolveCaptureId: (runtime, cwd) => resolveCaptureId(runtime, cwd),
      resolveCurrentSession: (runtime, cwd) => resolveCurrentSession(runtime, cwd), // A3: ownership-follows-/resume

      getConfig: () => this.config,
      getMaxAgents: () => vscode.workspace.getConfiguration("tachyon").get<number>("maxAgents") ?? 8,
      getExtraEnv: () => {
        // Every Tachyon-spawned session can reach (and authenticate to) ITS folder's Bridge.
        const env: Record<string, string> = {};
        if (this.bridge.url) env[URL_ENV_VAR] = this.bridge.url;
        if (this.token) env[TOKEN_ENV_VAR] = this.token;
        return env;
      },
      onSpawned: (name, reveal) => {
        // F3: a Bridge-spawned child passes reveal=false so it doesn't yank the human's
        // editor focus off the parent. It still appears in the tree (nested) — the human
        // opens it on demand. Human ▶ / autostart / resume / restart reveal as before.
        if (reveal) this.terminals.open(name, this.manager.session(name));
        deps.onViewsChanged("agents");
      },
      onKilled: (name) => {
        this.terminals.close(name);
        deps.onViewsChanged("agents");
      },
      // Restart: close the old terminal now (sync) so the post-spawn onSpawned re-opens
      // a fresh one in the editor — fixes the "first restart just closes the panel" bug.
      onRestart: (name) => this.terminals.close(name),
      // spec 210 — worktree isolation: resolve the cwd a session is born in.
      resolveSpawnCwd: (ctx) =>
        resolveWorktreeCwd(
          {
            name: ctx.name,
            worktree: ctx.def.worktree,
            branch: ctx.def.branch,
            worktreeSetup: ctx.def.worktreeSetup,
            parent: ctx.parent,
            isRestart: ctx.isRestart,
          },
          {
            manager: this.worktrees,
            settings: this.config?.settings ?? {},
            parentCwd: (p) => {
              const r = this.ledger.get(p);
              return r?.worktree?.path ?? r?.cwd;
            },
            priorRecord: this.ledger.get(ctx.name)?.worktree,
            runSetup: (rec, setup) => this.runWorktreeSetup(rec, setup),
            notify: (m, level) => notify(m, level ?? "info"),
          },
        ),
    });

    this.waiters = new Waiters();
    this.monitor = new AttentionMonitor(
      {
        runningAgents: () => this.manager.runningAgents(),
        capturePane: (agent) => this.tmux.capturePane(this.manager.session(agent)),
        cpuTicks: async (agent) => {
          try {
            return subtreeCpuTicks(await this.tmux.panePid(this.manager.session(agent)));
          } catch {
            return null;
          }
        },
        settingsOf: (agent) => {
          const att = this.config?.agents[agent]?.attention;
          // Ad-hoc agents (not declared): default attention ON for kind=agent, but OFF for
          // kind=terminal — a Bridge-spawned `sh`/shell shouldn't be monitored like an AI
          // agent (F5: ad-hoc attention now respects the inferred kind, matching declared
          // terminals which already default attention off).
          if (!att) return { enabled: this.manager.kindOf(agent) !== "terminal", silenceSec: 8, patterns: [] };
          return { enabled: att.enabled, silenceSec: att.silenceSec, patterns: safePatterns(att.patterns) };
        },
        now: () => Date.now(),
      },
      (agent, attention, shouldToast) => {
        this.waiters.notifyAttention(agent, attention.state);
        deps.onViewsChanged("agents");
        // Suppress the toast when you're already looking at this agent's terminal —
        // the prompt is right in front of you; the popup would be pure noise. The
        // sidebar badge still updates (onViewsChanged above, outside this gate).
        if (shouldToast && attention.state === "needs-input" && !this.terminals.isActive(agent)) {
          const line = attention.matchedLine ?? "waiting for input";
          void vscode.window
            .showInformationMessage(vscode.l10n.t("Tachyon: '{0}' needs you — {1}", agent, line), vscode.l10n.t("Open"))
            .then((choice) => {
              if (choice === vscode.l10n.t("Open")) this.terminals.open(agent, this.manager.session(agent));
            });
        }
      },
    );

    this.lifecycle = new LifecycleMonitor(
      {
        agentStates: () => this.manager.agentStates(),
        policyOf: (agent) => this.config?.agents[agent]?.restart ?? "never",
        scheduleRestart: (agent, delayMs) => {
          setTimeout(() => {
            this.manager.restart(agent).catch((err) => {
              notify(`auto-restart of '${agent}' failed: ${err instanceof Error ? err.message : String(err)}`, "error");
            });
          }, delayMs);
        },
        now: () => Date.now(),
      },
      {
        onCrash: (agent, exitCode, willRestart, delayMs) => {
          this.waiters.notifyDead(agent, exitCode);
          deps.onViewsChanged("agents");
          const code = exitCode !== undefined ? vscode.l10n.t(" (exit {0})", exitCode) : "";
          if (willRestart) {
            notify(vscode.l10n.t("'{0}' crashed{1} — restarting in {2}s", agent, code, Math.round((delayMs ?? 0) / 1000)), "warn");
          } else {
            void vscode.window
              .showErrorMessage(vscode.l10n.t("Tachyon: '{0}' crashed{1} — dead pane kept for postmortem", agent, code), vscode.l10n.t("Inspect"), vscode.l10n.t("Restart"))
              .then((choice) => {
                if (choice === vscode.l10n.t("Inspect")) this.terminals.open(agent, this.manager.session(agent));
                if (choice === vscode.l10n.t("Restart")) {
                  void this.manager.restart(agent).catch((err) => notify(String(err instanceof Error ? err.message : err), "error"));
                }
              });
          }
        },
        onCleanExit: (agent) => {
          this.waiters.notifyDead(agent, 0);
          deps.onViewsChanged("agents");
          notify(vscode.l10n.t("'{0}' exited cleanly", agent));
        },
        onGone: (agent) => this.waiters.notifyGone(agent),
        onGiveUp: (agent, attempts) => {
          deps.onViewsChanged("agents");
          void vscode.window
            .showErrorMessage(
              vscode.l10n.t("Tachyon: '{0}' crash-looped ({1} restarts in 1 min) — giving up. Fix it and restart manually.", agent, attempts),
              vscode.l10n.t("Inspect"),
            )
            .then((choice) => {
              if (choice === vscode.l10n.t("Inspect")) this.terminals.open(agent, this.manager.session(agent));
            });
        },
      },
    );

    this.pinStore = new PinStore(workspaceRoot);

    // One-shot commands + runbooks (F15/F21): own tmux namespaces, inverted lifecycle.
    this.commandRunner = new CommandRunner({
      tmux: this.tmux,
      wsHash: this.wsHash,
      workspaceRoot,
      getConfig: () => this.config,
      onRerun: (name) => this.terminals.close(`cmd:${name}`),
      onFinished: (name, exitCode, durationMs) => {
        this.waiters.notifyDead(`${CMD_WAIT_PREFIX}${name}`, exitCode);
        deps.onViewsChanged("commands");
        if (exitCode === 0) {
          notify(vscode.l10n.t("command '{0}' passed ({1}s)", name, Math.round((durationMs ?? 0) / 1000)));
        } else {
          void vscode.window
            .showErrorMessage(vscode.l10n.t("Tachyon: command '{0}' failed (exit {1})", name, exitCode ?? "?"), vscode.l10n.t("Inspect"))
            .then((choice) => {
              if (choice === vscode.l10n.t("Inspect")) this.openCommandPane(name);
            });
        }
      },
    });
    this.runbookRunner = new RunbookRunner({
      tmux: this.tmux,
      wsHash: this.wsHash,
      workspaceRoot,
      getConfig: () => this.config,
      onFinished: (job) => {
        deps.onViewsChanged("commands");
        // spec 214 — verify-gate runs use the runbook executor under a `verify-<agent>` label;
        // runVerify owns their messaging + badge, so skip the generic runbook toast here.
        if (job.runbook.startsWith(VERIFY_LABEL_PREFIX)) return;
        if (job.outcome === "passed") {
          notify(vscode.l10n.t("runbook '{0}' passed ({1} steps)", job.runbook, job.steps.length));
        } else {
          const failed = job.steps.find((st) => st.state === "failed");
          void vscode.window
            .showErrorMessage(
              vscode.l10n.t("Tachyon: runbook '{0}' failed at step {1} ({2})", job.runbook, (failed?.index ?? 0) + 1, failed?.step ?? "?"),
              vscode.l10n.t("Inspect"),
            )
            .then((choice) => {
              if (choice === vscode.l10n.t("Inspect") && failed) this.openRunbookStepPane(job.runbook, failed.index);
            });
        }
      },
    });

    // Schedules (F23): a timer over the existing executors; fires only while the
    // workspace is open. Agent proposals land inert in .tachyon/ until approved.
    this.proposals = new ProposalStore(workspaceRoot);
    this.scheduler = new Scheduler({
      getConfig: () => this.config,
      onFire: (name, def) => this.runSchedule(name, def),
      onError: (name, err) => notify(vscode.l10n.t("schedule '{0}' failed: {1}", name, err instanceof Error ? err.message : String(err)), "error"),
    });

    this.bridge = new Bridge(
      {
        manager: this.manager,
        tmux: this.tmux,
        pins: this.pinStore,
        notify,
        attentionOf: (agent) => this.monitor.stateOf(agent)?.state,
        onPinsChanged: () => deps.onViewsChanged("pins"),
        waiters: this.waiters,
        commands: this.commandRunner,
        runbooks: this.runbookRunner,
        scheduler: this.scheduler,
        proposals: this.proposals,
        onScheduleProposed: (name, by) => {
          deps.onViewsChanged("schedules");
          void vscode.window
            .showInformationMessage(vscode.l10n.t("Tachyon: {0} proposed a schedule '{1}' — approve it?", by, name), vscode.l10n.t("Review"))
            .then((choice) => {
              if (choice === vscode.l10n.t("Review")) void vscode.commands.executeCommand("tachyonTree.focus");
            });
        },
        // spec 214 — verify-gate handoff over MCP: list_agents reads this, verify_agent runs it.
        verifyInfo: async (agent) => {
          const info = await this.verifyInfo(agent);
          if (!info) return undefined;
          return { command: info.command, passed: info.state?.passed, atCommit: info.state?.atCommit, ranAt: info.state?.ranAt, stale: info.stale };
        },
        runVerify: async (agent) => {
          const s = await this.runVerify(agent);
          // Recompute staleness freshly (review fix: never hardcode stale:false — HEAD may have
          // moved or the tree gone dirty during a long verify, and a dirty run is stale at once).
          const info = await this.verifyInfo(agent);
          // If verifyInfo vanished (config/ledger changed mid-run), default to STALE — never
          // hand back a non-stale verdict we can no longer validate (round-2 review fix).
          return { command: s.command, passed: s.passed, atCommit: s.atCommit, ranAt: s.ranAt, stale: info?.stale ?? true };
        },
      },
      { token: this.token },
    );

    this.watches = new WatchController(async () => {});
  }

  /** Builds, boots the Bridge/engine/watchers, and (if configured) starts agents. */
  static async create(workspaceRoot: string, deps: WorkspaceDeps): Promise<Workspace> {
    const ws = new Workspace(workspaceRoot, deps);
    void ws.engine.start().catch(() => {
      /* degraded from birth — executor falls back, reconnect loop is running */
    });

    try {
      // Load config before the Bridge so settings.bridgePort applies; default is a
      // stable per-workspace derived port, so registrations survive editor restarts.
      ws.reloadConfig();
      const preferred = ws.config?.settings.bridgePort ?? derivePort(ws.wsHash);
      const port = await ws.bridge.start(preferred);
      if (ws.bridge.usedFallback) {
        notify(
          vscode.l10n.t("Bridge port {0} is in use — fell back to {1}. Registered runtimes need re-connecting (or free the port and reload).", preferred, port),
          "warn",
        );
      }
    } catch (err) {
      notify(vscode.l10n.t("Bridge failed to start: {0}", err instanceof Error ? err.message : String(err)), "error");
    }

    // tachyon.yml edits reflect live (config + watches + views).
    const configWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceRoot, "tachyon.{yml,yaml}"),
    );
    const onConfigChange = () => {
      const portBefore = ws.config?.settings.bridgePort;
      ws.reloadConfig();
      ws.rebuildWatches();
      deps.onViewsChanged("agents");
      deps.onViewsChanged("layouts");
      deps.onViewsChanged("commands");
      if (ws.config?.settings.bridgePort !== portBefore) {
        notify(vscode.l10n.t("bridgePort changed — reload the window to rebind the Bridge"), "warn");
      }
      if ((ws.config?.settings.auth ?? true) !== ws.authEnabled) {
        notify(vscode.l10n.t("settings.auth changed — reload the window to apply it"), "warn");
      }
    };
    configWatcher.onDidChange(onConfigChange);
    configWatcher.onDidCreate(onConfigChange);
    ws.disposables.push(configWatcher);

    // Manual edits to .tachyon/* (or agent writes through another window) reflect live.
    const pinsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(workspaceRoot, ".tachyon/*"),
    );
    const refreshTachyonDir = () => {
      deps.onViewsChanged("pins");
      deps.onViewsChanged("schedules"); // pending proposals live here too
    };
    pinsWatcher.onDidChange(refreshTachyonDir);
    pinsWatcher.onDidCreate(refreshTachyonDir);
    pinsWatcher.onDidDelete(refreshTachyonDir);
    ws.disposables.push(pinsWatcher);

    // Schedules tick on the heartbeat; activate anchors every-schedules + catch-up.
    ws.scheduler.activate();
    ws.ticker = setInterval(() => void ws.tick(), ATTENTION_POLL_MS);

    // Upgrade notice: MCP clients cache the Bridge tool schema at THEIR session start.
    const currentVersion = (deps.context.extension.packageJSON as { version: string }).version;
    const lastVersion = deps.context.globalState.get<string>(`tachyon.version.${ws.wsHash}`);
    if (lastVersion && lastVersion !== currentVersion && (await ws.manager.runningAgents()).length > 0) {
      notify(
        vscode.l10n.t(
          "Tachyon was updated ({0} → {1}) — running agents keep the old Bridge tools until restarted (↻ in the sidebar)",
          lastVersion,
          currentVersion,
        ),
        "warn",
      );
    }
    void deps.context.globalState.update(`tachyon.version.${ws.wsHash}`, currentVersion);

    return ws;
  }

  get folderName(): string {
    return path.basename(this.workspaceRoot);
  }

  /** sidebar accessors */
  bridgeUrl(): string | undefined {
    return this.bridge.url;
  }
  attentionOf(agent: string): AgentAttention | undefined {
    return this.monitor.stateOf(agent);
  }

  configPath(): string | undefined {
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(this.workspaceRoot, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  /**
   * spec 210 — run an agent's `worktreeSetup` in its fresh worktree: sequential,
   * stop on first failure, with `TACHYON_WORKSPACE_ROOT`/`TACHYON_WORKTREE_ROOT`
   * injected. Awaited by the async spawn (off the UI thread); per-command timeout;
   * failure is surfaced but NON-fatal (the agent still spawns).
   */
  private async runWorktreeSetup(rec: WorktreeRecord, setup: string[]): Promise<void> {
    const run = promisify(execFile);
    const env = { ...process.env, TACHYON_WORKSPACE_ROOT: this.workspaceRoot, TACHYON_WORKTREE_ROOT: rec.path };
    for (const cmd of setup) {
      try {
        await run("bash", ["-lc", cmd], { cwd: rec.path, env, timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
      } catch (err) {
        const detail = err instanceof Error ? (err as Error & { stderr?: string }).stderr?.trim() || err.message : String(err);
        notify(vscode.l10n.t("worktree setup for '{0}' failed at: {1} — {2} (agent started anyway)", rec.branch, cmd, detail), "warn");
        return; // stop on first failure
      }
    }
    notify(vscode.l10n.t("worktree setup complete for '{0}'", rec.branch), "info");
  }

  /**
   * spec 214 (C3) — run an agent's verify-gate IN its worktree and record the result. Resolves
   * the effective verify (per-agent `verify:` > global `settings.worktree.verify`) and treats it
   * like a runbook step: a declared runbook → its steps; else a single step (a declared command
   * name → its cmd, else inline shell). Reuses RunbookRunner with the worktree cwd (no new
   * executor). The verdict is keyed to the worktree HEAD, so it goes stale when work moves on.
   * Advisory — surfaces a badge + a toast; never blocks. Returns the recorded state.
   */
  async runVerify(agent: string): Promise<VerifyState> {
    const rec = this.ledger.get(agent);
    const wt = rec?.worktree;
    if (!wt) throw new Error(vscode.l10n.t("'{0}' has no worktree — verify is worktree-scoped", agent));
    if (!fs.existsSync(wt.path)) throw new Error(vscode.l10n.t("'{0}' worktree is gone ({1}) — nothing to verify", agent, wt.path));
    const verify = effectiveVerify(this.config?.agents[agent] ?? {}, this.config?.settings ?? {});
    if (!verify) throw new Error(vscode.l10n.t("'{0}' has no verify declared (set 'verify:' on the agent, or settings.worktree.verify)", agent));

    // Snapshot HEAD BEFORE running, so the verdict is keyed to the commit it actually ran against.
    const { headRef } = await this.worktrees.headState(wt.path);
    const steps = verifySteps(verify, this.config?.commands ?? {}, this.config?.runbooks ?? {});
    const job = await this.runbookRunner.runSteps(verifyLabel(agent), steps, wt.path);
    const passed = job.outcome === "passed";

    const state: VerifyState = { command: verify, passed, atCommit: headRef, ranAt: new Date().toISOString() };
    this.ledger.recordVerify(agent, state);
    this.deps.onViewsChanged("agents");
    if (passed) {
      notify(vscode.l10n.t("✓ '{0}' verified — {1} passed", agent, verify));
    } else {
      const failed = job.steps.find((st) => st.state === "failed");
      void vscode.window
        .showErrorMessage(vscode.l10n.t("Tachyon: '{0}' verify FAILED — {1}", agent, failed?.step ?? verify), vscode.l10n.t("Inspect"))
        .then((choice) => {
          if (choice === vscode.l10n.t("Inspect") && failed) this.openRunbookStepPane(verifyLabel(agent), failed.index);
        });
    }
    return state;
  }

  /**
   * spec 214 — the verify-gate render/handoff view for an agent: the recorded result + a freshly
   * computed staleness (HEAD moved past the verified commit, or the tree is dirty). Returns
   * undefined when verify doesn't apply (no worktree, or no `verify:` declared) → no badge. Used
   * by the sidebar badge AND the MCP handoff (list_agents / verify_agent), one source of truth.
   */
  async verifyInfo(agent: string): Promise<{ command: string; state?: VerifyState; stale: boolean; badge: VerifyBadge } | undefined> {
    const wt = this.ledger.get(agent)?.worktree;
    const command = effectiveVerify(this.config?.agents[agent] ?? {}, this.config?.settings ?? {});
    if (!wt || !command) return undefined;
    // A recorded result only counts if it ran the CURRENTLY-effective verify command (review fix:
    // changing `verify:` must not show the old command's result as fresh — treat it as not-verified).
    const state = wt.verify && wt.verify.command === command ? wt.verify : undefined;
    let stale = true;
    if (state && fs.existsSync(wt.path)) {
      const { headRef, dirty } = await this.worktrees.headState(wt.path);
      stale = verifyStale(state, headRef, dirty);
    }
    return { command, state, stale, badge: verifyBadge(state, stale) };
  }

  reloadConfig(): boolean {
    const file = this.configPath();
    if (!file) {
      this.config = undefined;
      return false;
    }
    const { config, errors } = loadConfigFile(file);
    if (errors.length > 0) {
      notify(vscode.l10n.t("invalid {0} — {1}{2}", path.basename(file), errors[0], errors.length > 1 ? vscode.l10n.t(" (+{0} more)", errors.length - 1) : ""), "error");
      return false;
    }
    this.config = config;
    // Push the user's tmux overlay (settings.tmux) to the server-options layer;
    // empty/absent falls back to Tachyon's defaults. Re-asserted per new-session.
    this.tmux.setServerOptions(config?.settings.tmux ?? {});
    return true;
  }

  private triggerLifecycle(): void {
    // Debounced: a burst of events (layout apply, Stop All) becomes one tick.
    if (this.lifecycleTrigger) clearTimeout(this.lifecycleTrigger);
    this.lifecycleTrigger = setTimeout(() => {
      void this.lifecycle.tick();
      void this.commandRunner.tick();
      this.deps.onViewsChanged("agents");
      this.deps.onViewsChanged("commands");
    }, 250);
  }

  /** the 3s heartbeat (engine events make these happen sooner, never different) */
  async tick(): Promise<void> {
    void this.lifecycle.tick();
    void this.commandRunner.tick();
    this.scheduler.tick(); // fires anything due (workspace-open scope)
    await this.monitor.tick();
    // States with durations ("idle 2m") need periodic re-render even without transitions.
    this.deps.onViewsChanged("agents");
  }

  /** Routes a fired schedule to the right executor. */
  private async runSchedule(name: string, def: import("../config/loadConfig.js").ScheduleDef): Promise<void> {
    notify(vscode.l10n.t("schedule '{0}' fired", name));
    this.deps.onViewsChanged("schedules");
    if (def.run !== undefined) {
      if (this.config?.commands[def.run]) await this.commandRunner.run(def.run);
      else if (this.config?.runbooks[def.run]) await this.runbookRunner.run(def.run);
      this.deps.onViewsChanged("commands");
    } else if (def.spawn !== undefined) {
      const running = await this.manager.runningAgents();
      if (!running.includes(def.spawn)) {
        await this.manager.spawn(def.spawn, def.instructions ? { instructions: def.instructions } : undefined);
      } else if (def.instructions) {
        // already up — deliver the prompt to its terminal
        await this.tmux.sendKeys(this.manager.session(def.spawn), def.instructions, true);
      }
      this.deps.onViewsChanged("agents");
    }
  }

  /** Approve a pending agent proposal: write it into tachyon.yml, drop the proposal. */
  approveProposal(id: string): boolean {
    const proposal = this.proposals.get(id);
    if (!proposal) {
      notify(vscode.l10n.t("that proposal is no longer pending"), "warn");
      return false;
    }
    const ok = this.mutateConfig(
      (text) => upsertSchedule(text, proposal.name, proposal.schedule as Record<string, unknown>, true),
      () => {},
    );
    if (!ok) return false;
    this.proposals.remove(id);
    this.scheduler.activate(); // pick up the freshly-approved schedule's anchor
    this.deps.onViewsChanged("schedules");
    notify(vscode.l10n.t("schedule '{0}' approved — it's now active", proposal.name));
    return true;
  }

  rejectProposal(id: string): void {
    const proposal = this.proposals.get(id);
    this.proposals.remove(id);
    this.deps.onViewsChanged("schedules");
    if (proposal) notify(vscode.l10n.t("proposal '{0}' rejected", proposal.name));
  }

  deleteScheduleEntry(name: string): void {
    this.mutateConfig((text) => deleteSchedule(text ?? "", name), () => this.deps.onViewsChanged("schedules"));
  }

  toggleSchedulePause(name: string): void {
    const paused = !this.scheduler.isPaused(name);
    this.scheduler.setPaused(name, paused);
    this.deps.onViewsChanged("schedules");
    notify(paused ? vscode.l10n.t("schedule '{0}' paused", name) : vscode.l10n.t("schedule '{0}' resumed", name));
  }

  rebuildWatches(): void {
    this.watches.dispose();
    this.watches = new WatchController(async (agent) => {
      try {
        await this.manager.restart(agent);
        notify(vscode.l10n.t("'{0}' restarted (watched file changed)", agent));
      } catch (err) {
        notify(vscode.l10n.t("watch-restart of '{0}' failed: {1}", agent, err instanceof Error ? err.message : String(err)), "error");
      }
    });
    for (const [name, def] of Object.entries(this.config?.agents ?? {})) {
      for (const glob of def.watch) {
        this.watches.watch(name, (onChange) => {
          const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.workspaceRoot, glob),
          );
          watcher.onDidChange(onChange);
          watcher.onDidCreate(onChange);
          watcher.onDidDelete(onChange);
          return () => watcher.dispose();
        });
      }
    }
  }

  async start(): Promise<void> {
    if (!this.reloadConfig()) {
      notify(vscode.l10n.t("no valid tachyon.yml in the workspace root — create one (see the Tachyon README) and run 'Tachyon: Start' again"), "warn");
      return;
    }
    // Re-discover sessions that survived a VSCode restart, then resume agents whose
    // process died (crash/reboot), then spawn the remaining pending autostarts.
    // Survivors are NOT auto-opened as tabs (hidden-tab attach renders blank).
    const surviving = await this.tmux.listSessions(`${SESSION_PREFIX}-${this.wsHash}-`);

    // Resume-on-activation (spec 209): classify ledger agents, auto-resume declared
    // autostart ones whose session is gone, stash the rest as a human-offered set.
    const states = await this.manager.agentStates();
    const liveSessions = new Set([...states].filter(([, s]) => !s.dead).map(([name]) => name));
    const declaredAutostart = new Set(
      Object.entries(this.config?.agents ?? {})
        .filter(([, def]) => def.autostart)
        .map(([name]) => name),
    );
    // Spec 211: rebuild ad-hoc defs + lineage from the ledger BEFORE planning resume,
    // so a re-discovered ad-hoc agent is restartable and re-nests under its parent.
    this.manager.rehydrateFromLedger();
    const plan = planResume({ ledger: this.ledger.all(), declaredAutostart, liveSessions });
    let resumed = 0;
    for (const item of autoResumes(plan)) {
      try {
        await this.manager.resume(item.name, item.record);
        resumed++;
      } catch (err) {
        // No transcript / unresolved id → let the fresh autostart below handle it.
        if (!(err instanceof ResumeUnavailableError)) {
          notify(vscode.l10n.t("resume of '{0}' failed: {1}", item.name, err instanceof Error ? err.message : String(err)), "error");
        }
      }
    }
    this.resumable = offers(plan);

    // Fresh autostart for declared agents not already present (resumed ones now are).
    const pending = await this.manager.autostartPending();
    for (const agent of pending) {
      try {
        await this.manager.spawn(agent);
      } catch (err) {
        notify(vscode.l10n.t("autostart of '{0}' failed: {1}", agent, err instanceof Error ? err.message : String(err)), "error");
      }
    }
    this.rebuildWatches();

    const parts: string[] = [];
    if (surviving.length > 0) parts.push(vscode.l10n.t("{0} re-discovered", surviving.length));
    if (resumed > 0) parts.push(vscode.l10n.t("{0} resumed with context", resumed));
    if (pending.length > 0) parts.push(vscode.l10n.t("{0} started", pending.length));
    if (parts.length > 0) notify(`Tachyon: ${parts.join(", ")}`);
    if (this.resumable.length > 0) this.offerResume();
  }

  /** Notifies that N agents can be resumed and wires a one-click "Resume all". */
  private offerResume(): void {
    const n = this.resumable.length;
    void vscode.window
      .showInformationMessage(vscode.l10n.t("{0} agent(s) can be resumed with their prior context", n), vscode.l10n.t("Resume all"))
      .then((choice) => {
        if (choice) void this.resumeAllOffered();
      });
  }

  /** Names of agents the human can resume (dead session + ledger entry, not auto-resumed). */
  resumableAgents(): string[] {
    return this.resumable.map((p) => p.name);
  }

  /** Resume one offered/known agent by name (sidebar ↻ / command). */
  async resumeAgent(name: string): Promise<void> {
    const record = this.ledger.get(name);
    if (!record) throw new Error(`no resumable session for '${name}'`);
    await this.manager.resume(name, record);
    this.resumable = this.resumable.filter((p) => p.name !== name);
    this.deps.onViewsChanged("agents");
  }

  /** Resume every currently-offered agent (best-effort; a failure falls back to fresh). */
  async resumeAllOffered(): Promise<void> {
    for (const item of [...this.resumable]) {
      try {
        await this.manager.resume(item.name, item.record);
      } catch (err) {
        if (err instanceof ResumeUnavailableError && item.record.declared) {
          await this.manager.spawn(item.name).catch(() => undefined);
        }
      }
    }
    this.resumable = [];
    this.deps.onViewsChanged("agents");
  }

  /**
   * Applies a UI-driven mutation to tachyon.yml (the file stays the source of
   * truth), then reloads config and refreshes. Surfaces warnings.
   */
  mutateConfig(
    mutate: (text: string | undefined) => { text: string; warnings: string[] },
    afterReload?: () => void,
  ): boolean {
    const file = this.configPath() ?? path.join(this.workspaceRoot, "tachyon.yml");
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
    try {
      const { text, warnings } = mutate(existing);
      fs.writeFileSync(file, text, "utf8");
      this.reloadConfig();
      this.rebuildWatches();
      afterReload?.();
      for (const warning of warnings) notify(warning, "warn");
      return true;
    } catch (err) {
      notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      return false;
    }
  }

  /** F22: apply = grid + auto-spawn of stopped declared agents + focus first. */
  async applyLayoutWithSpawn(name: string, def: NonNullable<TachyonConfig["layouts"][string]>): Promise<void> {
    await applyLayout(def, this.terminals, (a) => this.manager.session(a), {
      ensureRunning: async (agent) => {
        if (!this.config?.agents[agent]) return; // ad-hoc names in a layout: nothing to spawn
        const running = await this.manager.runningAgents();
        if (running.includes(agent)) return;
        try {
          await this.manager.spawn(agent);
        } catch (err) {
          notify(vscode.l10n.t("layout '{0}': could not start '{1}': {2}", name, agent, err instanceof Error ? err.message : String(err)), "warn");
        }
      },
    });
  }

  /** settings.layout — the workspace opens already arranged. */
  async applyDefaultLayout(): Promise<void> {
    const wanted = this.config?.settings.layout;
    if (!wanted) return;
    const def = this.config?.layouts[wanted];
    if (!def) return; // parse already validated; stale only on mid-flight edits
    await this.applyLayoutWithSpawn(wanted, def);
  }

  /** Save the CURRENT editor arrangement as a named layout (capture path). */
  async saveLayoutAs(nameArg?: string, overwriteArg?: boolean): Promise<string | undefined> {
    const raw = (await vscode.commands.executeCommand("vscode.getEditorLayout")) as { orientation: number; groups: unknown[] };
    // tabGroups order == leaf (visual) order — find each group's Tachyon terminal.
    const agentsByGroup = vscode.window.tabGroups.all.map((group) => {
      const tab = group.tabs.find((t) => t.label.startsWith("⚡ "));
      return tab ? tab.label.slice(2).trim() : undefined;
    });
    const entry = captureToEntry(raw, agentsByGroup);
    if ("error" in entry) {
      notify(vscode.l10n.t("no Tachyon agent panes are open — arrange some agents first, then save"), "warn");
      return undefined;
    }
    const name =
      nameArg ??
      (await vscode.window.showInputBox({
        prompt: vscode.l10n.t("Save the current arrangement as… (layout name)"),
        validateInput: (v) => (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(v) ? undefined : vscode.l10n.t("letters/digits/_/-, starting with a letter")),
      }));
    if (!name) return undefined;
    let overwrite = overwriteArg ?? false;
    if (!overwrite && this.config?.layouts[name]) {
      const answer = await vscode.window.showWarningMessage(
        vscode.l10n.t("Layout '{0}' already exists — overwrite it?", name),
        { modal: true },
        vscode.l10n.t("Overwrite"),
      );
      if (answer !== vscode.l10n.t("Overwrite")) return undefined;
      overwrite = true;
    }
    const ok = this.mutateConfig((text) => upsertLayout(text, name, entry, overwrite), () => this.deps.onViewsChanged("layouts"));
    if (ok) notify(vscode.l10n.t("layout '{0}' saved ({1} agent(s), proportions kept)", name, entry.agents.length));
    return ok ? name : undefined;
  }

  /** Agent Studio submit pipeline — webview form and the internal test seam. */
  studioSubmit = (submit: StudioSubmit): string[] | undefined => {
    const kind = submit.state.kind;
    const takenMap =
      kind === "command" ? this.config?.commands : kind === "runbook" ? this.config?.runbooks : kind === "schedule" ? this.config?.schedules : this.config?.agents;
    const errors = blockingErrors(validateForm(submit.state, Object.keys(takenMap ?? {}), submit.editingName));
    if (errors.length > 0) return errors.map(issueMessage);
    const entry = toEntry(submit.state);
    const isScheduleOrCommandOrRunbook = kind === "command" || kind === "runbook" || kind === "schedule";
    const ok = this.mutateConfig(
      (text) =>
        kind === "command"
          ? upsertCommand(text, submit.state.name, entry, submit.editingName)
          : kind === "runbook"
            ? upsertRunbook(text, submit.state.name, entry as { steps: string[] }, submit.editingName)
            : kind === "schedule"
              ? upsertSchedule(text, submit.state.name, entry, submit.editingName !== undefined)
              : upsertAgent(text, submit.state.name, entry, submit.editingName),
      () => this.deps.onViewsChanged(kind === "schedule" ? "schedules" : isScheduleOrCommandOrRunbook ? "commands" : "agents"),
    );
    if (!ok) return [vscode.l10n.t("could not write tachyon.yml — see the notification")];
    if (kind === "schedule") this.scheduler.activate(); // anchor a freshly-created schedule
    // F2 (dogfood): a freshly-CREATED agent declared autostart:true should start now —
    // not only on the next workspace open. Targeted to the create path (editingName
    // undefined) so editing the yml never auto-(re)starts an intentionally-stopped agent.
    const isAgentKind = !isScheduleOrCommandOrRunbook;
    const autostarted = isAgentKind && submit.editingName === undefined && !!this.config?.agents[submit.state.name]?.autostart;
    if (autostarted) {
      void this.manager.spawn(submit.state.name).then(() => this.deps.onViewsChanged("agents")).catch((err) => {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      });
    }
    notify(
      kind === "command"
        ? vscode.l10n.t("command '{0}' saved — ▶ in the sidebar (or run_command) runs it", submit.state.name)
        : kind === "runbook"
          ? vscode.l10n.t("runbook '{0}' saved — ▶ in the sidebar (or run_runbook) runs it", submit.state.name)
          : kind === "schedule"
            ? vscode.l10n.t("schedule '{0}' saved — it's now active", submit.state.name)
            : autostarted
              ? vscode.l10n.t("'{0}' saved & started (autostart)", submit.state.name)
              : vscode.l10n.t("'{0}' saved — ▶ in the sidebar starts it", submit.state.name),
    );
    return undefined;
  };

  studioDeps(): StudioDeps {
    return {
      extensionUri: this.deps.context.extensionUri,
      detectClis: detectInstalledClis,
      takenNames: () => Object.keys(this.config?.agents ?? {}),
      commandNames: () => Object.keys(this.config?.commands ?? {}),
      verifyCandidates: () => this.verifyCandidates(),
      defaultCwd: this.workspaceRoot,
      inferKind,
      onSubmit: this.studioSubmit,
    };
  }

  /**
   * spec 214 — the Studio's verify-gate suggestions: stack-derived candidates (Node package.json
   * scripts, cargo/go/pytest/…) FIRST, then the project's already-declared command + runbook
   * names. Offered as pick-or-edit chips; the human always has the final word (can type their own).
   */
  verifyCandidates(): string[] {
    const manifests = ["package.json", "composer.json", "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt", "Gemfile"];
    const files = manifests.filter((f) => fs.existsSync(path.join(this.workspaceRoot, f)));
    let packageJson: DetectedProject["packageJson"];
    if (files.includes("package.json")) {
      try {
        packageJson = JSON.parse(fs.readFileSync(path.join(this.workspaceRoot, "package.json"), "utf8"));
      } catch {
        /* unreadable/invalid → no script suggestions */
      }
    }
    const readText = (f: string) => (files.includes(f) ? safeRead(path.join(this.workspaceRoot, f)) : undefined);
    const stack = detectStack({ files, packageJson, composerJson: readText("composer.json"), gemfile: readText("Gemfile"), installedClis: [] });
    const fromStack = suggestVerify(stack.label, packageJson?.scripts ?? {});
    const commands = Object.keys(this.config?.commands ?? {});
    const runbooks = Object.keys(this.config?.runbooks ?? {});
    return [...new Set([...fromStack, ...commands, ...runbooks])];
  }

  /**
   * Live rename across every subsystem: the tmux session follows (attached
   * clients ride along), session-local memory rekeys (ad-hoc def, lineage,
   * resume ledger), the yml updates for declared agents, and an open editor
   * pane is reopened under the new name (terminal titles can't change in place).
   * Attention state self-heals on the next tick; watchers rebuild on reload.
   */
  async renameAgent(oldName: string, newName: string): Promise<void> {
    const wasOpen = this.terminals.has(oldName);
    if (wasOpen) this.terminals.close(oldName);
    await this.manager.rename(oldName, newName);
    if (this.config?.agents[oldName] !== undefined) {
      if (!this.mutateConfig((text) => renameAgentInYml(text ?? "", oldName, newName))) {
        // yml refused after the session moved — move it back so tree and config agree.
        await this.manager.rename(newName, oldName);
        if (wasOpen) this.terminals.open(oldName, this.manager.session(oldName));
        return;
      }
    }
    if (wasOpen) this.terminals.open(newName, this.manager.session(newName));
    this.deps.onViewsChanged("agents");
  }

  openCommandPane(name: string): void {
    this.terminals.open(`cmd:${name}`, this.commandRunner.session(name), undefined, `$ ${name}`);
  }

  openRunbookStepPane(runbook: string, index: number): void {
    this.terminals.open(`rb:${runbook}:${index}`, this.runbookRunner.stepSession(runbook, index), undefined, `$ ${runbook}#${index + 1}`);
  }

  /** Folder removed from the window (or extension deactivating). tmux sessions survive. */
  async dispose(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker);
    if (this.lifecycleTrigger) clearTimeout(this.lifecycleTrigger);
    for (const d of this.disposables) d.dispose();
    this.watches.dispose();
    this.terminals.dispose();
    this.waiters.dispose();
    await Promise.allSettled([this.bridge.dispose(), this.engine.dispose()]);
  }
}
