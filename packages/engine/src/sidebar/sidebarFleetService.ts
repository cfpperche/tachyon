import { hasLifecycleHooks } from "../agents/agentInstancePolicy.js";
import type { AgentManager } from "../agents/AgentManager.js";
import type { AgentAttention } from "@tachyon/shared/attention/AttentionMonitor.js";
import type { ConfigFailure } from "../config/configFailure.js";
import { degradedRosterExtras, toConfigErrorVM } from "../config/configFailure.js";
import { toConfigDiscardsVM, type ConfigDiscards } from "../config/configDiscards.js";
import type { ConfigLkgSnapshot } from "../config/configLkg.js";
import { asAgent, type TachyonConfig } from "../config/loadConfig.js";
import { ExternalToolRegistry } from "../externalTools/registry.js";
import { isPidAlive, readProcEnvironAgent, readProcEntries, scanExternalToolProcesses } from "../externalTools/procScanner.js";
import type { ProjectHandoffStore } from "../handoff/ProjectHandoffStore.js";
import { nodeSpawnName } from "../pipeline/loadPipeline.js";
import type { PipelineManager } from "../pipeline/PipelineManager.js";
import { runStatus } from "../pipeline/runState.js";
import type { PinStore } from "../pins/PinStore.js";
import { adapterFor, forkable, managesOwnSession } from "@tachyon/shared/resume/adapters.js";
import type { SessionLedger } from "../resume/SessionLedger.js";
import { isResumable } from "../resume/sessionRecord.js";
import type { ProposalStore } from "../schedule/ProposalStore.js";
import type { Scheduler } from "../schedule/Scheduler.js";
import { toAgentVM, type ObservedModelInput } from "./agentModel.js";
import { resolveAgentFocus, type FocusTaskInput } from "./agentFocus.js";
import { projectAgentChecklistLine } from "./agentChecklistLine.js";
import type { InternalChecklistRead } from "../runtime/internalChecklist.js";
import type { InternalChecklistTurnJudgment } from "../runtime/internalChecklistTurn.js";
import type { AgentStatus, AgentVM, EvidenceBadge, FleetVM, RunState } from "@tachyon/shared/sidebar/types.js";
import type { TmuxService } from "../tmux/TmuxService.js";
import { evidenceBadge, type EvidenceSummary } from "../worktree/evidence.js";
import type { WorktreeManager } from "../worktree/WorktreeManager.js";
import type { ResourceSampler } from "../attention/resourceSample.js";
import { truncateByCodePoint } from "../utils/truncateByCodePoint.js";

/** Display-only cap for a notice row; the inbox keeps the whole line. */
const NOTICE_MESSAGE_RENDER_CAP = 240;

export interface SidebarFleetSource {
  workspaceRoot: string;
  wsHash: string;
  folderName: string;
  bridge: { port?: number; url?: string };
  manager: Pick<AgentManager, "listAgents" | "listTerminals" | "defOf" | "resumeReadiness" | "session">;
  ledger: Pick<SessionLedger, "all" | "get">;
  tmux: Pick<TmuxService, "panePid">;
  worktrees: Pick<WorktreeManager, "currentBranch">;
  config: TachyonConfig | undefined;
  configFailure: ConfigFailure | undefined;
  /**
   * t-7d6013 — what the last successful load DISCARDED, already filtered by the human's dismissal
   * (the source owns that, because dismissing is a decision about the workspace, not about one open
   * sidebar). Independent of `configFailure` on purpose: the file loaded, the fleet is live, and the
   * roster must not degrade — this only says some of what was written is not running.
   */
  configDiscards?: ConfigDiscards | undefined;
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
  /**
   * SDD 512 fatia 1 — last action-less status notice. Last write wins; no timer.
   * Absent means nothing to show. Level is a field on the value, never inferred.
   */
  statusNotice?: () => {
    message: string;
    level: "info" | "warn" | "error";
    at: string;
  } | undefined;
  attentionOf(agent: string): AgentAttention | undefined;
  /** spec 390 — open/assigned MC tasks for focus projection (optional when TaskStore absent). */
  focusTasks?: () => FocusTaskInput[];
  /** spec 390 — continuity markdown body for Current Goal parse (optional). */
  continuityBody?: (agent: string) => string | null;
  /** t-281339 — fatia-1 snapshot + fatia-2 verdict for the checklist line. */
  internalChecklist?: (agent: string) => { snapshot: InternalChecklistRead; judgment: InternalChecklistTurnJudgment };
  persistenceHookHealth(agent: string): {
    state: "active" | "skipped" | "failed" | "unknown";
    reason?: string;
    path?: string;
    updatedAt?: string;
  } | undefined;
  evidenceHandoff(agent: string): Promise<EvidenceSummary | undefined>;
  readConfigLkg(): ConfigLkgSnapshot | null;
}

export interface SidebarFleetServiceOptions {
  observedModelFor?: (agentName: string) => ObservedModelInput | undefined;
  now?: () => number;
  resourceSampler?: Pick<ResourceSampler, "sample" | "clear" | "keys">;
  /**
   * t-aa2780 — reads the engine daemon log ring's own "has an error line" flag, for the sidebar's
   * passive engine-error dot (the signal Control's Engine tab used to carry).
   *
   * An OPTION rather than a `SidebarFleetSource` member because it is a fact about the PROCESS doing
   * the projecting, not about the workspace being projected: only the engine that owns the ring can
   * answer it. A caller that cannot (the in-extension legacy adapter, every hand-built test source)
   * omits it, and the field stays absent — never a fabricated `false`.
   *
   * Returning `undefined` says the same thing from inside a caller that HAS the hook but found no
   * ring to read (an engine host that never installed one): still not a measurement, still no dot.
   */
  engineLogHasError?: () => boolean | undefined;
}

/** Builds the complete sidebar projection at the operational authority, never in the editor shell. */
export async function buildSidebarFleet(
  source: SidebarFleetSource,
  options: SidebarFleetServiceOptions = {},
): Promise<FleetVM> {
  const [agentRows, terminalRows] = await Promise.all([
    source.manager.listAgents(),
    source.manager.listTerminals(),
  ]);
  const all = [...agentRows, ...terminalRows];
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

  const evidenceOf = new Map<string, EvidenceBadge>();
  await Promise.all([...worktrees.keys()].map(async (name) => {
    const badge = evidenceBadge(await source.evidenceHandoff(name));
    if (badge) evidenceOf.set(name, badge);
  }));

  type LiveGit = { liveBranch?: string; worktreePath: string; branchDrift?: boolean };
  const liveGitOf = new Map<string, LiveGit>();
  await Promise.all(agentRows.map(async (agent) => {
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

  const engineLogHasError = options.engineLogHasError?.();
  const statusNotice = source.statusNotice?.();
  const running = new Set(all.filter((agent) => agent.running).map((agent) => agent.name));
  const externalTools = source.externalTools ?? new ExternalToolRegistry();
  const liveAgents = agentRows.filter((agent) => agent.running && !agent.dead);
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
  const agents: AgentVM[] = agentRows
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
      let checklist: ReturnType<typeof projectAgentChecklistLine>;
      try {
        const facts = source.internalChecklist?.(agent.name);
        checklist = facts ? projectAgentChecklistLine(facts.snapshot, facts.judgment) : undefined;
      } catch {
        checklist = undefined;
      }
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
        ...(focus ? { focus } : {}),
        ...(checklist ? { checklist } : {}),
        persistenceHooks: hookHealth ? {
          state: hookHealth.state,
          ...(hookHealth.reason ? { reason: hookHealth.reason } : {}),
          ...(hookHealth.path ? { path: hookHealth.path } : {}),
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

  const terminals: AgentVM[] = terminalRows
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
  // t-d4f246 — Human Inbox is the single owner of pending human decisions. The sidebar remains the
  // fleet's active-schedule/status surface; mirroring proposals here recreates two queues.
  const proposals: never[] = [];
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
    // t-7d6013 — beside `configError`, never instead of it: a file can load with discards (banner,
    // live fleet) or fail to load (error banner, degraded roster), and after a fatal reload the
    // record of the still-running config's discards is still true, so both can be present at once.
    ...(source.configDiscards ? { configDiscards: toConfigDiscardsVM(source.configDiscards) } : {}),
    // t-aa2780 — only stated when somebody actually read the ring; see the option's doc for why
    // "unread" must not collapse into `false`.
    ...(engineLogHasError === undefined ? {} : { engineLogHasError }),
    // SDD 512 — last action-less notice. Omitted when the source has none. Level is copied
    // as a field; the projector does not infer it and does not attach an expiry.
    ...(statusNotice ? {
      statusNotice: { message: statusNotice.message, level: statusNotice.level, at: statusNotice.at },
    } : {}),
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

function scheduleSummary(definition: { every?: string; at?: string; spawn?: string }): string {
  const when = definition.every ? `every ${definition.every}` : `at ${definition.at}`;
  return `${when} · spawn ${definition.spawn}`;
}

function nodeStatus(status: string): AgentStatus {
  return status === "running" ? "running"
    : status === "completed" ? "idle"
      : status === "failed" ? "crashed" : "stopped";
}
