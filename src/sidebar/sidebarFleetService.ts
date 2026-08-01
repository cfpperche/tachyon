import { hasLifecycleHooks } from "../agents/agentInstancePolicy.js";
import type { AgentManager } from "../agents/AgentManager.js";
import type { AgentAttention } from "../attention/AttentionMonitor.js";
import type { CommandRunner } from "../commands/CommandRunner.js";
import type { RunbookRunner } from "../commands/RunbookRunner.js";
import type { ConfigFailure } from "../config/configFailure.js";
import { degradedRosterExtras, toConfigErrorVM } from "../config/configFailure.js";
import type { ConfigLkgSnapshot } from "../config/configLkg.js";
import { asAgent, type TachyonConfig } from "../config/loadConfig.js";
import { ExternalToolRegistry } from "../externalTools/registry.js";
import { isPidAlive, readProcEnvironAgent, readProcEntries, scanExternalToolProcesses } from "../externalTools/procScanner.js";
import type { ProjectHandoffStore } from "../handoff/ProjectHandoffStore.js";
import { nodeSpawnName } from "../pipeline/loadPipeline.js";
import type { PipelineManager } from "../pipeline/PipelineManager.js";
import { runStatus } from "../pipeline/runState.js";
import type { PinStore } from "../pins/PinStore.js";
import { adapterFor, forkable, managesOwnSession } from "../resume/adapters.js";
import { isResumable, type SessionLedger } from "../resume/SessionLedger.js";
import type { ProposalStore } from "../schedule/ProposalStore.js";
import type { Scheduler } from "../schedule/Scheduler.js";
import { toAgentVM, type ObservedModelInput } from "./agentModel.js";
import { resolveAgentFocus, type FocusTaskInput } from "./agentFocus.js";
import type { AgentStatus, AgentVM, EvidenceBadge, FleetVM, RunState, Verify } from "./types.js";
import type { TmuxService } from "../tmux/TmuxService.js";
import { evidenceBadge, type EvidenceSummary } from "../worktree/evidence.js";
import type { WorktreeManager } from "../worktree/WorktreeManager.js";
import type { ResourceSampler } from "../attention/resourceSample.js";
import { truncateByCodePoint } from "../bridge/notifyAgent.js";

/** Display-only cap for a notice row; the inbox keeps the whole line. */
const NOTICE_MESSAGE_RENDER_CAP = 240;

export interface SidebarFleetSource {
  workspaceRoot: string;
  wsHash: string;
  folderName: string;
  bridge: { port?: number; url?: string };
  manager: Pick<AgentManager, "list" | "defOf" | "resumeReadiness" | "session">;
  ledger: Pick<SessionLedger, "all" | "get">;
  tmux: Pick<TmuxService, "panePid">;
  worktrees: Pick<WorktreeManager, "currentBranch">;
  config: TachyonConfig | undefined;
  configFailure: ConfigFailure | undefined;
  commandRunner: Pick<CommandRunner, "list">;
  runbookRunner: Pick<RunbookRunner, "list">;
  handoffStore: Pick<ProjectHandoffStore, "snapshot">;
  pinStore: Pick<PinStore, "list">;
  proposals: Pick<ProposalStore, "list">;
  scheduler: Pick<Scheduler, "list">;
  pipelines: Pick<PipelineManager, "allRuns">;
  externalTools?: ExternalToolRegistry;
  listPipelines(): string[];
  lastActivityAt(): string | null;
  /** t-7f94f2 — optional notice inbox (daemon host). */
  listNoticeInbox?(): Array<{
    id: string;
    message: string;
    level: "info" | "warn" | "error";
    at: string;
    collapsedCount: number;
    actions: Array<{ id: string; label: string }>;
    read: boolean;
    actionsLive: boolean;
  }>;
  attentionOf(agent: string): AgentAttention | undefined;
  continuityBadge(agent: string): "fresh" | "stale" | "missing" | undefined;
  /** spec 390 — open/assigned MC tasks for focus projection (optional when TaskStore absent). */
  focusTasks?: () => FocusTaskInput[];
  /** spec 390 — continuity markdown body for Current Goal parse (optional). */
  continuityBody?: (agent: string) => string | null;
  persistenceHookHealth(agent: string): {
    state: "active" | "skipped" | "failed" | "unknown";
    reason?: string;
    path?: string;
    updatedAt?: string;
  } | undefined;
  verifyInfo(agent: string): Promise<{ badge: "verified" | "failing" | "stale" } | undefined>;
  evidenceHandoff(agent: string): Promise<EvidenceSummary | undefined>;
  readConfigLkg(): ConfigLkgSnapshot | null;
}

export interface SidebarFleetServiceOptions {
  observedModelFor?: (agentName: string) => ObservedModelInput | undefined;
  now?: () => number;
  resourceSampler?: Pick<ResourceSampler, "sample" | "clear" | "keys">;
}

/** Builds the complete sidebar projection at the operational authority, never in the editor shell. */
export async function buildSidebarFleet(
  source: SidebarFleetSource,
  options: SidebarFleetServiceOptions = {},
): Promise<FleetVM> {
  const all = await source.manager.list();
  const ledger = [...source.ledger.all()];
  const resumable = new Set(ledger.filter(([, record]) => isResumable(record)).map(([name]) => name));
  const worktrees = new Map(ledger.filter(([, record]) => record.worktree).map(([name, record]) => [name, record.worktree!.branch]));
  const ledgerByName = new Map(ledger);
  const canFork = (name: string, running: boolean, kind: string): boolean => {
    if (!running || kind !== "agent") return false;
    const definition = source.manager.defOf(name);
    const command = definition?.cmd;
    return !!command && !asAgent(definition)?.harness && forkable(adapterFor(command)) && !managesOwnSession(command);
  };

  const verifyOf = new Map<string, Verify>();
  const evidenceOf = new Map<string, EvidenceBadge>();
  await Promise.all([...worktrees.keys()].map(async (name) => {
    const info = await source.verifyInfo(name);
    if (info) verifyOf.set(name, info.badge === "verified" ? "pass" : info.badge === "failing" ? "fail" : "stale");
    const badge = evidenceBadge(await source.evidenceHandoff(name));
    if (badge) evidenceOf.set(name, badge);
  }));

  type LiveGit = { liveBranch?: string; worktreePath: string; branchDrift?: boolean };
  const liveGitOf = new Map<string, LiveGit>();
  await Promise.all(all.filter((agent) => agent.kind === "agent").map(async (agent) => {
    const record = ledgerByName.get(agent.name);
    const cwd = record?.cwd || record?.worktree?.path || source.workspaceRoot;
    let liveBranch: string | undefined;
    try { liveBranch = await source.worktrees.currentBranch(cwd); } catch { /* additive best-effort fact */ }
    const configuredBranch = record?.worktree?.branch;
    liveGitOf.set(agent.name, {
      worktreePath: cwd,
      ...(liveBranch ? { liveBranch } : {}),
      ...(liveBranch && configuredBranch && liveBranch !== configuredBranch ? { branchDrift: true } : {}),
    });
  }));

  const running = new Set(all.filter((agent) => agent.running).map((agent) => agent.name));
  const externalTools = source.externalTools ?? new ExternalToolRegistry();
  const liveAgents = all.filter((agent) => agent.kind === "agent" && agent.running && !agent.dead);
  const paneRoots = (await Promise.all(liveAgents.map(async (agent) => {
    try {
      return { agent: agent.name, panePid: await source.tmux.panePid(source.manager.session(agent.name)) };
    } catch {
      return undefined;
    }
  }))).filter((row): row is { agent: string; panePid: number } => !!row);
  if (paneRoots.length > 0) {
    for (const sighting of scanExternalToolProcesses(paneRoots, readProcEntries(), options.now?.() ?? Date.now(), readProcEnvironAgent)) {
      externalTools.upsert(sighting);
    }
  }
  externalTools.reconcile({ isPidAlive });
  const resourcesOf = new Map<string, { cpuPct?: number; memMb: number }>();
  if (options.resourceSampler) {
    const livePane = new Set(paneRoots.map((row) => row.agent));
    for (const { agent, panePid } of paneRoots) {
      const sample = options.resourceSampler.sample(agent, panePid);
      if (sample) resourcesOf.set(agent, sample);
    }
    for (const agent of options.resourceSampler.keys()) {
      if (!livePane.has(agent)) options.resourceSampler.clear(agent);
    }
  }

  const resumeReadyOf = new Map<string, boolean>();
  await Promise.all([...resumable].filter((name) => !running.has(name)).map(async (name) => {
    const record = source.ledger.get(name);
    if (record) resumeReadyOf.set(name, await source.manager.resumeReadiness(name, record));
  }));

  const configFailure = source.configFailure;
  // spec 390 — load task list once per fleet build for focus resolution.
  const focusTasks = source.focusTasks?.() ?? [];
  const agents: AgentVM[] = all
    .filter((agent) => agent.kind === "agent")
    .map((agent) => {
      const definition = source.manager.defOf(agent.name);
      const live = agent.running ? source.attentionOf(agent.name) : undefined;
      // SDD 482 phase 3 — reads the instance's declared CAPABILITY, not its identity. Deriving this
      // from identity would be sound today and would still be a derivation; a promoted agent is the
      // case that separates them, since it has a Saved Profile while this running instance kept the
      // ownership-only hooks it launched with.
      const hookHealth = hasLifecycleHooks(agent) ? source.persistenceHookHealth(agent.name) : undefined;
      const externalSummary = externalTools.summary(agent.name);
      const liveGit = liveGitOf.get(agent.name);
      const ledgerDef = source.ledger.get(agent.name)?.def;
      let continuityBody: string | null = null;
      try {
        continuityBody = source.continuityBody?.(agent.name) ?? null;
      } catch {
        continuityBody = null;
      }
      const focus = resolveAgentFocus({
        agent: agent.name,
        kind: "agent",
        tasks: focusTasks,
        ledger: {
          contractTask: typeof ledgerDef?.contract?.task === "string" ? ledgerDef.contract.task : undefined,
          taskBrief: typeof ledgerDef?.taskBrief === "string" ? ledgerDef.taskBrief : undefined,
        },
        continuityBody,
      });
      return toAgentVM({ ...agent, cmd: definition?.cmd }, {
        attention: live?.state,
        awaitingHuman: live?.awaitingHuman ? { reason: live.awaitingHumanReason ?? "" } : undefined,
        authRequired: live?.authRequired
          ? { runtime: live.authRequired.runtime, action: live.authRequired.humanAction }
          : undefined,
        unseen: live?.unseen === true,
        model: options.observedModelFor?.(agent.name),
        worktree: worktrees.get(agent.name),
        liveBranch: liveGit?.liveBranch,
        branchDrift: liveGit?.branchDrift,
        worktreePath: liveGit?.worktreePath,
        resources: agent.running && !agent.dead ? resourcesOf.get(agent.name) : undefined,
        verify: verifyOf.get(agent.name),
        verifiable: verifyOf.has(agent.name),
        evidence: evidenceOf.get(agent.name),
        harness: !!asAgent(definition)?.harness,
        forkable: canFork(agent.name, agent.running, agent.kind),
        forked: source.ledger.get(agent.name)?.def?.fork === true,
        resumable: !agent.running && resumable.has(agent.name),
        freshStart: !agent.running && resumable.has(agent.name) && resumeReadyOf.get(agent.name) === false,
        kind: "agent",
        // "Is this a Temporary Agent?" — asked of the ROSTER's resolved answer, not of the instance
        // policy directly. A Saved agent that has never been started has no ledger row and therefore no
        // policy; asking the policy would render it as Temporary and offer to dismiss it.
        adhoc: agent.lifetime === "temporary",
        // The continuity pointer is part of the same injected hook set, so it asks the same
        // capability question rather than re-deriving from identity.
        continuity: agent.running && hasLifecycleHooks(agent) ? source.continuityBadge(agent.name) : undefined,
        ...(focus ? { focus } : {}),
        persistenceHooks: hookHealth ? {
          state: hookHealth.state,
          ...(hookHealth.reason !== undefined ? { reason: hookHealth.reason } : {}),
          ...(hookHealth.path !== undefined ? { path: hookHealth.path } : {}),
          ...(hookHealth.updatedAt !== undefined ? { updatedAt: hookHealth.updatedAt } : {}),
        } : undefined,
        externalTools: externalSummary ? { ...externalSummary, items: externalSummary.items.slice(0, 100) } : undefined,
        // "May this row be dismissed?" — only a Temporary instance can be; a Saved one always exists
        // in its store. Identity question, converted.
        canDismiss: agent.lifetime === "temporary" && !agent.running,
        ...(configFailure ? { configInvalid: true } : {}),
        ...(agent.refused ? { refused: agent.refused } : {}),
      });
    });

  const terminals: AgentVM[] = all
    .filter((agent) => agent.kind === "terminal")
    .map((agent) => {
      const view = toAgentVM(agent, {
        kind: "terminal",
        adhoc: agent.lifetime === "temporary",
        resumable: !agent.running && resumable.has(agent.name),
        ...(configFailure ? { configInvalid: true } : {}),
      });
      if (agent.lifetime === "temporary" && !agent.running) view.canDismiss = true;
      const command = source.manager.defOf(agent.name)?.cmd;
      return command && !view.sub ? { ...view, sub: command } : view;
    });

  if (configFailure) {
    const existing = new Set([...agents, ...terminals].map((agent) => agent.name));
    const extras = degradedRosterExtras({ existingNames: existing, ledger, lkg: source.readConfigLkg() });
    for (const extra of extras) {
      const raw = {
        name: extra.name,
        cmd: extra.cmd,
        running: false,
        dead: false,
        crashed: false,
        parent: extra.parent,
        delegator: extra.delegator,
        declaredOwner: extra.declaredOwner,
      };
      if (extra.kind === "terminal") {
        const view = toAgentVM(raw, {
          kind: "terminal",
          adhoc: extra.lifetime === "temporary",
          resumable: extra.resumable,
          configInvalid: true,
        });
        if (extra.cmd && !view.sub) view.sub = extra.cmd;
        terminals.push(view);
      } else {
        agents.push(toAgentVM(raw, {
          kind: "agent",
          // The degraded roster asks the same identity question as the live one, off the same resolved
          // field. An LKG row has no instance policy at all — a config snapshot never had one — and its
          // `lifetime` is `saved` because being in that snapshot IS the durable Profile.
          adhoc: extra.lifetime === "temporary",
          resumable: extra.resumable,
          worktree: extra.worktreeBranch,
          configInvalid: true,
        }));
      }
    }
  }

  const commands = (await source.commandRunner.list()).map((command) => {
    const duration = command.lastRun?.finishedAt !== undefined
      ? command.lastRun.finishedAt - command.lastRun.startedAt
      : undefined;
    const detail = command.state === "running" ? "running"
      : command.state === "passed" ? (duration !== undefined ? `exit 0 · ${Math.round(duration / 1000)}s` : "exit 0")
        : command.state === "failed" ? `exit ${command.exitCode ?? "?"}`
          : "never run";
    return { name: command.name, cmd: source.config?.commands?.[command.name]?.cmd ?? "", state: command.state, detail };
  });
  const runbooks = source.runbookRunner.list().map((runbook) => {
    const job = runbook.lastJob;
    const failed = job?.outcome === "failed";
    const detail = runbook.running ? "running"
      : job?.outcome === "passed" ? `passed · ${job.steps.length} steps`
        : failed ? `failed at step ${(job.steps.find((step) => step.state === "failed")?.index ?? 0) + 1}`
          : "never run";
    const steps = (job?.steps ?? []).map((step) => ({
      n: step.index + 1,
      label: step.step,
      state: step.state,
      detail: step.state === "passed" ? (step.durationMs !== undefined ? `${Math.round(step.durationMs / 1000)}s` : undefined)
        : step.state === "failed" ? `exit ${step.exitCode ?? "?"}` : undefined,
    }));
    return { name: runbook.name, running: runbook.running, failed, detail, steps };
  });
  const handoffSnapshot = source.handoffStore.snapshot(source.lastActivityAt());
  const pins = source.pinStore.list().map((pin) => ({
    id: pin.id,
    text: pin.text,
    done: pin.done,
    by: pin.by,
    tags: pin.tags ?? [],
    detail: pin.detail,
    attachmentCount: pin.attachmentCount,
  }));
  const notices = (source.listNoticeInbox?.() ?? []).slice(0, 50).map((n) => ({
    id: n.id,
    // t-b15872 — by CODE POINT: `slice` counts UTF-16 units, so a cut landing inside a surrogate
    // pair rendered a lone surrogate. The full line is kept in the notice inbox either way, so this
    // is display-only shortening; the marker says how much is not shown.
    message: truncateByCodePoint(n.message, NOTICE_MESSAGE_RENDER_CAP, "— open the notice for the rest"),
    level: n.level,
    at: n.at,
    collapsedCount: n.collapsedCount,
    actions: n.actions.map((a) => ({ id: a.id, label: a.label })),
    read: n.read,
    actionsLive: n.actionsLive,
  }));
  const proposals = source.proposals.list().map((proposal) => ({
    id: proposal.id,
    name: proposal.name,
    by: proposal.by,
    reason: proposal.reason,
    when: scheduleSummary(proposal.schedule),
  }));
  const now = options.now?.() ?? Date.now();
  const schedules = source.scheduler.list().map((schedule) => ({
    name: schedule.name,
    when: scheduleSummary(schedule.def),
    next: schedule.paused ? "paused" : schedule.nextRun ? `next ${relativeTime(schedule.nextRun, now)}` : "not scheduled",
    paused: !!schedule.paused,
  }));
  const pipelines = source.listPipelines().map((name) => {
    const run = source.pipelines.allRuns().find((candidate) => candidate.pipeline.name === name && runStatus(candidate) !== "completed");
    const nodes = run ? Object.entries(run.nodes).map(([id, state]) => ({
      id,
      status: nodeStatus(state.status),
      label: String(state.status),
      reason: state.reason,
      agentName: nodeSpawnName(run.id, id, run.pipeline.nodes[id] ?? {}),
    })) : [];
    const status = (run ? runStatus(run) : "idle") as RunState;
    return { name, status, nodes };
  });

  return {
    folder: { hash: source.wsHash, name: source.folderName },
    bridge: { port: source.bridge.port?.toString() ?? "—", connected: !!source.bridge.url },
    agents,
    terminals,
    commands,
    runbooks,
    pins,
    notices,
    schedules,
    pipelines,
    proposals,
    handoff: {
      exists: handoffSnapshot.exists,
      staleness: handoffSnapshot.staleness,
      pendingCount: handoffSnapshot.pendingCount,
    },
    ...(configFailure ? { configError: toConfigErrorVM(configFailure) } : {}),
    // SDD 479 — the project's card layout, or the reason a written one was refused. Never both:
    // `parseCardTemplate` returns a template or errors, so a half-applied layout has no path here.
    // `settings` is optional in practice even though the type declares it: a hand-built config (every
    // headless test, and a degraded/last-known-good projection) can arrive without it. Guarding only
    // `config` here threw and took the WHOLE fleet push down with it.
    ...(source.config?.settings?.sidebar?.cardTemplate
      ? { cardTemplate: source.config.settings.sidebar.cardTemplate }
      : {}),
    ...(source.config?.settings?.sidebar?.cardTemplateRefusal?.length
      ? { cardTemplateRefusal: { file: "tachyon.yml", errors: source.config.settings.sidebar.cardTemplateRefusal } }
      : {}),
  };
}

function relativeTime(milliseconds: number, now: number): string {
  const delta = Math.round((milliseconds - now) / 1000);
  const absolute = Math.abs(delta);
  const unit = absolute < 90 ? `${absolute}s`
    : absolute < 5400 ? `${Math.round(absolute / 60)}m`
      : `${Math.round(absolute / 3600)}h`;
  return delta >= 0 ? `in ${unit}` : `${unit} ago`;
}

function scheduleSummary(definition: { every?: string; at?: string; run?: string; spawn?: string }): string {
  const when = definition.every ? `every ${definition.every}` : `at ${definition.at}`;
  const what = definition.run ? `run ${definition.run}` : `spawn ${definition.spawn}`;
  return `${when} · ${what}`;
}

function nodeStatus(status: string): AgentStatus {
  return status === "running" ? "running"
    : status === "done" || status === "completed" ? "idle"
      : status === "failed" ? "crashed" : "stopped";
}
