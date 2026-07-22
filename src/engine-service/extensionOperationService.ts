import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ActivityLogManager } from "../activity/ActivityLogManager.js";
import { SoulError, SOUL_MAX_BYTES, type SoulProfileStatus } from "../agents/soul.js";
import type { ProfileMutationResult } from "../agents/soulProfileTransactions.js";
import { EvolutionStoreError } from "../evolution/EvolutionStore.js";
import { executeWait, type BridgeDeps } from "../bridge/tools.js";
import { resolveApproval } from "../bridge/approvalRequest.js";
import { degradedRosterExtras } from "../config/configFailure.js";
import { loadConfigFile } from "../config/loadConfig.js";
import {
  addAgent,
  cloneAgent,
  deleteAgent,
  deleteCommand,
  deleteRunbook,
  setCompanionTabTools,
  setCompanionAllowedHosts,
} from "../config/YamlConfigEditor.js";
import { isResumable } from "../resume/SessionLedger.js";
import { PromptStore } from "../prompts/PromptStore.js";
import { injectTargets, submitRefuseReason } from "../prompts/injectFlow.js";
import {
  isJsonValue,
  scheduleDefFromExtensionCommand,
  type ExtensionCommandV1,
  type ExtensionQueryV1,
  type JsonValue,
} from "../runtime-api/extensionOperations.js";
import type { ViewKind } from "../workspace/EngineHost.js";
import type { Workspace } from "../workspace/Workspace.js";
import type { ProviderObservationService } from "../runtimeObservability/service.js";
import { buildDoctorReport, formatDoctorReport } from "../workspace/doctorReport.js";
import type { StagedPayloadStore } from "./stagedPayloadStore.js";
import {
  doctor,
  findServerPids,
  probeServer,
  SESSION_PREFIX,
  snapshotServerPids,
  socketPath,
  SOCKET_NAME,
  type PaneSnapshot,
} from "../tmux/TmuxService.js";
import { recoverTmuxServer } from "./tmuxAuthority.js";

export interface ExtensionOperationContext {
  workspace: Workspace;
  activityLog: ActivityLogManager;
  providerObservations: ProviderObservationService;
  stagedPayloads?: StagedPayloadStore;
  onViewsChanged(view: ViewKind): void;
}

/**
 * Closed compatibility operations used only by the VS Code shell during the final registry cutover.
 * Domain decisions stay in Workspace/managers/stores; this layer validates routing and turns their
 * results into bounded JSON values without exporting operational objects across the process boundary.
 */
export async function executeExtensionQuery(
  context: Pick<ExtensionOperationContext, "workspace">,
  query: ExtensionQueryV1,
): Promise<JsonValue> {
  const { workspace } = context;
  switch (query.action) {
    case "agents.list":
      return json(await workspace.manager.list());
    case "attention.list": {
      const out: Record<string, { state: string; matchedLine?: string }> = {};
      for (const [agent, attention] of workspace.monitor.states()) {
        out[agent] = {
          state: attention.state,
          ...(attention.matchedLine !== undefined ? { matchedLine: attention.matchedLine } : {}),
        };
      }
      return json(out);
    }
    case "pins.list":
      return json(workspace.pinStore.list());
    case "commands.list":
      return json(await workspace.commandRunner.list());
    case "runbooks.list":
      return json(workspace.runbookRunner.list());
    case "schedules.list":
      return json(workspace.scheduler.list());
    case "proposals.list":
      return json(workspace.proposals.list());
    case "doctor.report":
      return doctorReport(workspace);
    case "legacy-delivery.retirement-preview":
      return json(workspace.legacyDeliveryRetirement.preview());
    case "bridge.token":
      return json({ token: workspace.externalToken ?? null, authEnabled: workspace.authEnabled });
    case "companion.status": {
      // SDD 414 — Control Settings: tabTools opt-in + connected devices (not host tab trust).
      const port = workspace.bridge.listenerPort;
      const devices = workspace.companion.listDevices((token) => workspace.companionLive.hasLiveClient(token));
      return json({
        tabTools: workspace.config?.settings.companion?.tabTools === true,
        allowedHosts: Array.isArray(workspace.config?.settings.companion?.allowedHosts)
          ? workspace.config!.settings.companion!.allowedHosts!
          : [],
        paired: workspace.companion.hasPairedDevice(),
        baseUrl: port === undefined ? undefined : `http://127.0.0.1:${port}`,
        engineLabel: path.basename(workspace.workspaceRoot) || "tachyon",
        devices,
      });
    }
    case "companion.pair-code": {
      // SDD 414 — short-lived companion pair code + loopback base URL for Tachyon Companion.
      const issued = workspace.issueCompanionPairCode();
      if ("ok" in issued && issued.ok === false) {
        return json({
          ok: false,
          reason: issued.reason,
          protocolVersion: workspace.companion.protocolVersion,
          prefix: workspace.companionHttpPrefix(),
        });
      }
      return json({ ok: true, ...issued, prefix: workspace.companionHttpPrefix() });
    }
    case "agent.inspect":
      return inspectAgent(workspace, query.agent);
    case "agent.fork-preview":
      return json(await workspace.manager.planFork(query.agent));
    case "soul.profile.status":
      return soulProfileOutcome(() => workspace.refreshSoulProfile(query.agent));
    case "evolution.overview":
      return json(await workspace.readAgentEvolutionOverview(query.agent));
    case "evolution.candidate":
      return json(await workspace.readAgentEvolutionCandidate(query.agent, query.candidateId));
    case "tmux.snapshot":
      return json(await workspace.tmux.serverSnapshot(SESSION_PREFIX));
    case "tmux.capture":
      assertTachyonSession(query.session);
      return json({ session: query.session, text: await workspace.tmux.capturePane(query.session, 200) });
    case "tmux.health": {
      const checkedAt = Date.now();
      const [probe, requirement] = await Promise.all([probeServer(), doctor()]);
      const pids = probe.state === "wedged"
        ? probe.pids
        : probe.state === "healthy"
          ? await findServerPids(SOCKET_NAME).catch(() => [])
          : [];
      return json({
        socketName: SOCKET_NAME,
        socketPath: socketPath(SOCKET_NAME),
        state: probe.state,
        ...(requirement.ok ? { tmuxVersion: requirement.version } : {}),
        pids,
        diagnostics: await snapshotServerPids(pids),
        checkedAt,
      });
    }
    case "prompt.catalog": {
      const library = new PromptStore(workspace.workspaceRoot).list();
      return json({
        relDir: ".tachyon/prompts",
        skippedCount: library.skipped.length,
        templates: library.templates.map((template) => ({
          id: template.id,
          title: template.title,
          body: template.body,
          sha256: createHash("sha256").update(template.body, "utf8").digest("hex"),
        })),
        targets: injectTargets(await workspace.manager.list()),
      });
    }
    case "worktrees.list": {
      // Agent ledger worktrees + spec 392 registry (change + agent). Drop registry rows whose path is gone
      // so VS Code orphan self-heal still works (P1-3).
      const fromLedger = [...workspace.ledger.all()].flatMap(([agent, record]) =>
        record.worktree ? [{ agent, record: record.worktree }] : []);
      const seen = new Set(fromLedger.map((row) => row.record.path));
      const fromRegistry = workspace.managedWorktrees.list({ status: "active" })
        .filter((e) => !seen.has(e.path) && fs.existsSync(e.path))
        .map((e) => ({
          agent: e.agent ?? e.slug ?? e.id,
          record: {
            path: e.path,
            branch: e.branch,
            tachyonCreatedBranch: e.tachyonCreatedBranch,
            baseRef: e.baseRef,
            createdAt: e.createdAt,
          },
        }));
      return json({ worktrees: [...fromLedger, ...fromRegistry] });
    }
    case "worktree.review":
      return inspectWorktree(workspace, "agent" in query ? query.agent : query.runId, "agent" in query);
    case "pipeline.inspect":
      return inspectPipeline(workspace, query.name, query.runId);
    case "agent.wait":
      return json(await executeWait(
        {
          manager: workspace.manager,
          attentionOf: (agent) => workspace.monitor.stateOf(agent)?.state,
          waiters: workspace.waiters,
        } as Pick<BridgeDeps, "manager" | "attentionOf" | "waiters">,
        query.agent,
        query.until,
        query.timeoutSec,
      ));
  }
}

export async function executeExtensionCommand(
  context: ExtensionOperationContext,
  command: ExtensionCommandV1,
): Promise<JsonValue> {
  const { workspace, activityLog, onViewsChanged, stagedPayloads } = context;
  switch (command.action) {
    case "pipeline.seed":
      return json({ runId: workspace.seedPipelineRun(command.name) });
    case "agent.spawn":
      await workspace.manager.spawn(command.agent, command.options);
      return json({ spawned: true });
    case "pin.create": {
      let pin = workspace.pinStore.create(command.text, command.by);
      if (command.done) pin = workspace.pinStore.setDone(pin.id, true);
      onViewsChanged("pins");
      return json(pin);
    }
    case "command.run":
      await workspace.commandRunner.run(command.name);
      return json({ started: true });
    case "command.tick":
      await workspace.commandRunner.tick();
      return json({ ticked: true });
    case "runbook.run":
      return json(await workspace.runbookRunner.run(command.name));
    case "proposal.create": {
      const proposal = workspace.proposals.create(
        command.name,
        scheduleDefFromExtensionCommand(command),
        command.by,
        command.reason,
      );
      onViewsChanged("schedules");
      return json(proposal);
    }
    case "proposal.approve":
      return json({ changed: workspace.approveProposal(command.id) });
    case "proposal.reject":
      workspace.rejectProposal(command.id);
      return json({ changed: true });
    case "approval.resolve": {
      const result = await resolveApproval({
        workspaceRoot: workspace.workspaceRoot,
        id: command.id,
        decision: command.decision,
        resolvedBy: "vscode",
        currentSessionOwner: async (session) => (await workspace.manager.list())
          .find((entry) => entry.session === session && entry.running)?.name,
        inject: async (session, text) => {
          await workspace.tmux.sendSubmittedLine(session, text);
          return { receipt: `tmux:${session}` };
        },
        completePin: (pinId) => workspace.pinStore.setDone(pinId, true),
      });
      // Drop Attention-stack notice cards + Companion SSE (ledger resolve alone does not dismiss UI).
      workspace.afterApprovalResolved(command.id);
      return json(result);
    }
    case "prompt.inject": {
      const template = new PromptStore(workspace.workspaceRoot).list().templates
        .find((candidate) => candidate.id === command.templateId);
      if (!template) throw new Error(`prompt template '${command.templateId}' is unavailable`);
      const sha256 = createHash("sha256").update(template.body, "utf8").digest("hex");
      if (sha256 !== command.expectedSha256) {
        throw new Error(`prompt template '${command.templateId}' changed after preview — review it again`);
      }
      const live = (await workspace.manager.list()).find((agent) => agent.name === command.agent);
      if (!live || live.kind !== "agent" || !live.running || live.dead || live.stopping) {
        throw new Error(`agent '${command.agent}' is no longer available`);
      }
      const session = workspace.manager.session(command.agent);
      if (!(await workspace.tmux.hasSession(session))) throw new Error(`agent '${command.agent}' is not running`);
      if (command.submit) {
        const attention = workspace.attentionOf(command.agent);
        const refused = submitRefuseReason(attention?.state, attention?.composerOccupied);
        if (refused) throw new Error(`prompt submit refused — '${command.agent}' is ${refused}`);
        await workspace.tmux.sendSubmittedLine(session, template.body);
      } else {
        await workspace.tmux.sendKeys(session, template.body, false);
      }
      return json({ injected: true, title: template.title, mode: command.submit ? "submit" : "stage" });
    }
    case "config.health":
      return configHealth(workspace);
    case "companion.unpair": {
      // Host Control: force-revoke active Companion session (no device bearer required).
      const result = workspace.companion.forceUnpair();
      if (result.sessionToken) {
        try {
          workspace.companionLive.dropSession(result.sessionToken);
        } catch {
          /* best-effort */
        }
      }
      return json({ ok: true, hadSession: result.hadSession });
    }
    case "config.agent.add":
      return configMutation(workspace, () => workspace.mutateConfig(
        (text) => addAgent(text, command.agent, command.cmd, command.kind),
        () => onViewsChanged("agents"),
      ));
    case "config.agent.clone":
      return configMutation(workspace, () => workspace.mutateConfig(
        (text) => cloneAgent(text ?? "", command.agent, command.newName),
        () => onViewsChanged("agents"),
      ));
    case "config.agent.rename":
      await workspace.renameAgent(command.agent, command.newName);
      return json({ changed: true });
    case "config.agent.delete":
      return deleteConfiguredAgent(workspace, command.agent, command.removeWorktree, onViewsChanged);
    case "config.agent.promote":
      return promoteAgent(workspace, command.agent, onViewsChanged);
    case "config.command.delete":
      return configMutation(workspace, () => workspace.mutateConfig(
        (text) => deleteCommand(text ?? "", command.name),
        () => onViewsChanged("commands"),
      ));
    case "config.runbook.delete":
      if (workspace.runbookRunner.isRunning(command.name)) {
        throw new Error(`runbook '${command.name}' is running — wait for it to finish before deleting`);
      }
      return configMutation(workspace, () => workspace.mutateConfig(
        (text) => deleteRunbook(text ?? "", command.name),
        () => onViewsChanged("commands"),
      ));
    case "config.companion.tabTools":
      // SDD 414 — human Control toggle; reloadConfig announces tool list change when the bit flips.
      return configMutation(workspace, () => workspace.mutateConfig(
        (text) => setCompanionTabTools(text, command.enabled),
        () => onViewsChanged("agents"),
      ));
    case "config.companion.allowedHosts":
      // SDD 420 — optional host allowlist for user_browser_* (Control Settings).
      return configMutation(workspace, () => workspace.mutateConfig(
        (text) => setCompanionAllowedHosts(text, command.hosts),
        () => onViewsChanged("agents"),
      ));
    case "agent.fork":
      return forkAgent(workspace, activityLog, command.agent);
    case "worktree.remove":
      return removeAgentWorktree(workspace, command.agent, true);
    case "worktree.delete-branch":
      return json({ deleted: await workspace.worktrees.deleteBranch(command.branch) });
    case "agent.verify":
      return json(await workspace.runVerify(command.agent));
    case "agent.reanchor":
      await workspace.reanchor(command.agent);
      return json({ changed: true });
    case "agent.inject-continuity":
      await workspace.injectContinuity(command.agent, "manual", { origin: "ui" });
      return json({ changed: true });
    case "agent.resume-all":
      await workspace.resumeAllOffered();
      return json({ changed: true });
    case "workspace.stop-all": {
      const killed = await workspace.manager.killAll();
      await workspace.commandRunner.killAll();
      await workspace.runbookRunner.killAll();
      return json({ stoppedAgents: killed.length });
    }
    case "pipeline.start":
      return json({ runId: await workspace.startPipeline(command.name, command.input) });
    case "pipeline.approve":
      workspace.pipelines.approve(command.runId, command.nodeId);
      return json({ changed: true });
    case "pipeline.reject":
      workspace.pipelines.reject(command.runId, command.nodeId);
      return json({ changed: true });
    case "pipeline.cancel":
      workspace.pipelines.cancel(command.runId);
      onViewsChanged("agents");
      return json({ changed: true });
    case "pipeline.rerun":
      await workspace.pipelines.rerunFrom(command.runId, command.nodeId);
      return json({ changed: true });
    case "pipeline.dismiss":
      workspace.pipelines.dismiss(command.runId);
      onViewsChanged("agents");
      return json({ changed: true });
    case "pipeline.apply-input":
      workspace.applyRunInput(command.runId);
      return json({ changed: true });
    case "pipeline.delete":
      workspace.deletePipelineFile(command.name);
      return json({ changed: true });
    case "bridge.restart":
      return json({ port: await workspace.restartBridge() });
    case "bridge.stop":
      await workspace.stopBridge();
      return json({ stopped: true });
    case "legacy-delivery.retirement-apply": {
      const preview = workspace.legacyDeliveryRetirement.preview();
      if (preview.snapshotDigest !== command.snapshotDigest || preview.archiveId !== command.archiveId) {
        throw new Error("legacy Delivery metadata changed after preview; review the new snapshot before retiring it");
      }
      return json(workspace.legacyDeliveryRetirement.apply(preview));
    }
    case "tmux.kill": {
      assertTachyonSession(command.expected.session);
      const rows = (await workspace.tmux.serverSnapshot(SESSION_PREFIX))
        .filter((row) => row.session === command.expected.session);
      if (rows.length !== 1 || !samePaneIdentity(rows[0], command.expected)) {
        throw new Error(`tmux session '${command.expected.session}' changed after confirmation`);
      }
      await workspace.tmux.killSession(command.expected.session);
      return json({ killed: true, session: command.expected.session });
    }
    case "tmux.recover":
      return json(await recoverTmuxServer());
    case "terminal.open":
      assertTachyonSession(command.session);
      if (!(await workspace.tmux.hasSession(command.session))) {
        throw new Error(`tmux session '${command.session}' is not running`);
      }
      workspace.terminals.open(command.agent, command.session, undefined, command.title);
      return json({ opened: true, session: command.session });
    case "terminal.close":
      assertTachyonSession(command.session);
      workspace.terminals.close(command.agent, command.session);
      return json({ closed: true, session: command.session });
    case "soul.profile.create":
      return soulProfileMutation(() => workspace.createSoulProfile(command.agent), onViewsChanged);
    case "soul.profile.import": {
      if (!stagedPayloads) throw new Error("Soul payload transport is unavailable");
      const bytes = stagedPayloads.consume(command.payload, SOUL_MAX_BYTES);
      return soulProfileMutation(() => workspace.importSoulProfileBytes(command.agent, bytes), onViewsChanged);
    }
    case "soul.profile.replace": {
      if (!stagedPayloads) throw new Error("Soul payload transport is unavailable");
      const bytes = stagedPayloads.consume(command.payload, SOUL_MAX_BYTES);
      return soulProfileMutation(
        () => workspace.replaceSoulProfileBytes(command.agent, bytes, command.expectedDigest),
        onViewsChanged,
      );
    }
    case "soul.profile.adopt":
      return soulProfileMutation(() => workspace.adoptSoulProfile(command.agent, command.expectedDigest), onViewsChanged);
    case "soul.profile.enable":
      return soulProfileMutation(() => workspace.enableSoulProfile(command.agent), onViewsChanged);
    case "soul.profile.disable":
      return soulProfileMutation(() => workspace.disableSoulProfile(command.agent), onViewsChanged);
    case "soul.profile.delete":
      return soulProfileMutation(() => workspace.deleteSoulProfile(command.agent), onViewsChanged);
    case "evolution.approve":
      return evolutionCandidateMutation(() => workspace.approveAgentEvolutionCandidate(command.agent, command.candidateId, {
        expectedActiveVersion: command.expectedActiveVersion,
        ...(command.expectedTargetDigest !== undefined ? { expectedTargetDigest: command.expectedTargetDigest } : {}),
      }));
    case "evolution.reject":
      return evolutionCandidateMutation(() => workspace.rejectAgentEvolutionCandidate(command.agent, command.candidateId, {
        expectedActiveVersion: command.expectedActiveVersion,
        ...(command.expectedTargetDigest !== undefined ? { expectedTargetDigest: command.expectedTargetDigest } : {}),
      }));
    case "runtime-ops.provider.configure": {
      await context.providerObservations.configureProvider(command.provider, command.enabled
        ? { state: "granted", consent: "explicit-user", sources: ["cli"] }
        : { state: "disabled" });
      if (command.enabled) void context.providerObservations.refresh(command.provider).catch(() => undefined);
      onViewsChanged("agents");
      return json({ changed: true, provider: command.provider, enabled: command.enabled });
    }
    case "handoff.note":
      workspace.handoffStore.appendNote({
        agent: "tachyon",
        kind: "gotcha",
        summary: command.summary,
        evidence: command.evidence,
      });
      onViewsChanged("handoff");
      return json({ changed: true });
  }
}

function assertTachyonSession(session: string): void {
  if (session !== SESSION_PREFIX && !session.startsWith(`${SESSION_PREFIX}-`)) {
    throw new Error("tmux session is outside Tachyon's namespace");
  }
}

function samePaneIdentity(
  row: PaneSnapshot,
  expected: { session: string; window: number; pane: number; pid: number; startCommand: string; createdAt?: number },
): boolean {
  return row.session === expected.session
    && row.window === expected.window
    && row.pane === expected.pane
    && row.pid === expected.pid
    && row.startCommand === expected.startCommand
    && row.createdAt === expected.createdAt;
}

async function soulProfileMutation(
  run: () => Promise<ProfileMutationResult>,
  onViewsChanged: (view: ViewKind) => void,
): Promise<JsonValue> {
  const outcome = await soulProfileOutcome(run);
  if (isSuccessfulSoulProfileOutcome(outcome)) onViewsChanged("agents");
  return outcome;
}

async function evolutionCandidateMutation(
  run: () => Promise<{ candidateId: string; activeVersion: number }>,
): Promise<JsonValue> {
  try {
    return json({ outcome: "ok", ...(await run()) });
  } catch (error) {
    if (error instanceof EvolutionStoreError) return json({ outcome: "error", code: error.code });
    throw error;
  }
}

async function soulProfileOutcome(
  run: () => Promise<ProfileMutationResult | SoulProfileStatus>,
): Promise<JsonValue> {
  try {
    const raw = await run();
    const mutation: ProfileMutationResult | undefined = "status" in raw ? raw : undefined;
    const status: SoulProfileStatus = mutation ? mutation.status : raw as SoulProfileStatus;
    return json({
      outcome: "ok",
      status: projectSoulProfileStatus(status),
      ...(mutation?.selfSelected !== undefined ? { selfSelected: mutation.selfSelected } : {}),
    });
  } catch (error) {
    if (error instanceof SoulError) return json({ outcome: "error", code: error.code });
    throw error;
  }
}

function projectSoulProfileStatus(status: SoulProfileStatus): JsonValue {
  return json({
    agent: status.agent,
    relativePath: status.relativePath,
    lifecycle: status.lifecycle,
    ...(status.profileId !== undefined ? { profileId: status.profileId } : {}),
    ...(status.sha256 !== undefined ? { sha256: status.sha256 } : {}),
    ...(status.chars !== undefined ? { chars: status.chars } : {}),
    ...(status.bytes !== undefined ? { bytes: status.bytes } : {}),
    soulEnabled: status.soulEnabled,
    resolvable: status.resolvable,
    transactionDegraded: status.transactionDegraded,
    ...(status.preview !== undefined ? { preview: status.preview } : {}),
  });
}

function isSuccessfulSoulProfileOutcome(value: JsonValue): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && value.outcome === "ok";
}

async function configHealth(workspace: Workspace): Promise<JsonValue> {
  const reloadOk = workspace.reloadConfig();
  const failure = workspace.configFailure ?? null;
  const lkg = workspace.readConfigLkg();
  const ledgerPairs = [...workspace.ledger.all()];
  const live = await workspace.manager.list();
  const extras = degradedRosterExtras({
    existingNames: new Set(live.map((agent) => agent.name)),
    ledger: ledgerPairs,
    lkg,
  });
  const rosterNames = [...new Set([...live.map((agent) => agent.name), ...extras.map((entry) => entry.name)])].sort();
  let lkgSpawn: { name: string; refused: boolean; message?: string } | undefined;
  if (failure && lkg?.agents.length) {
    const candidate = extras.find((entry) => entry.source === "lkg")?.name
      ?? lkg.agents.find((agent) => !workspace.config?.agents[agent.name] && !workspace.manager.defOf(agent.name))?.name
      ?? lkg.agents[0]?.name;
    if (candidate) {
      try {
        await workspace.manager.spawn(candidate);
        lkgSpawn = { name: candidate, refused: false };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lkgSpawn = {
          name: candidate,
          refused: /render-only|config is invalid|cannot spawn|unknown agent/i.test(message),
          message,
        };
      }
    }
  }
  return json({
    ok: true,
    reloadOk,
    configFailure: failure
      ? { file: failure.file, path: failure.path, errors: failure.errors, at: failure.at }
      : null,
    lkg: lkg
      ? { savedAt: lkg.savedAt, sourceFile: lkg.sourceFile, agents: lkg.agents.map((agent) => agent.name) }
      : null,
    ledger: ledgerPairs.map(([name, record]) => ({ name, declared: record.declared, resumable: isResumable(record) })),
    live: live.map((agent) => ({ name: agent.name, running: agent.running, declared: agent.declared, kind: agent.kind })),
    extras: extras.map((entry) => ({
      name: entry.name,
      source: entry.source,
      declared: entry.declared,
      resumable: entry.resumable,
    })),
    rosterNames,
    lkgSpawn,
    emptyRosterOnly: !!failure && rosterNames.length === 0,
  });
}

async function doctorReport(workspace: Workspace): Promise<JsonValue> {
  const configPath = workspace.configPath();
  const fileExists = !!configPath && fs.existsSync(configPath);
  let configValid = !workspace.configFailure && !!workspace.config;
  let configFailure = workspace.configFailure ?? null;
  let configWarnings: string[] = [];
  if (configPath && fileExists) {
    const { errors, warnings } = loadConfigFile(configPath);
    configWarnings = [...warnings];
    if (errors.length > 0) {
      configValid = false;
      configFailure = { path: configPath, file: path.basename(configPath), errors: [...errors], at: new Date().toISOString() };
    } else {
      configValid = true;
      configFailure = null;
    }
  }
  const states = await workspace.manager.agentStates();
  const liveSessions = new Set([...states].filter(([, state]) => !state.dead).map(([name]) => name));
  const transcriptPresence = new Map<string, boolean>();
  for (const [name, record] of workspace.ledger.all()) {
    if (!isResumable(record)) continue;
    try { transcriptPresence.set(name, await workspace.manager.resumeReadiness(name, record)); }
    catch { transcriptPresence.set(name, false); }
  }
  const reachable = workspace.bridge.port === undefined ? undefined : await canConnect(workspace.bridge.port);
  const report = buildDoctorReport({
    workspaceRoot: workspace.workspaceRoot,
    configPath,
    configFailure,
    configFileExists: fileExists,
    configValid,
    configWarnings,
    lkg: workspace.readConfigLkg(),
    ledger: [...workspace.ledger.all()],
    liveSessions,
    knownSessions: new Set(states.keys()),
    bridge: {
      port: workspace.bridge.port,
      url: workspace.bridge.url,
      reachable,
      authConfigured: workspace.authEnabled,
      failure: workspace.bridgeStartFailureInfo(),
    },
    companionLanAccess: workspace.config?.settings.companion?.lanAccess === true,
    transcriptPresence,
    mechanismOnlyDelivery: true,
  });
  return json({
    text: formatDoctorReport(report),
    hasErrors: report.findings.some((finding) => finding.severity === "error"),
  });
}

async function inspectAgent(workspace: Workspace, agent: string): Promise<JsonValue> {
  const [agents, states, descendants] = await Promise.all([
    workspace.manager.list(),
    workspace.manager.agentStates(),
    workspace.manager.liveDescendants(agent),
  ]);
  const record = workspace.ledger.get(agent);
  const worktreeStatus = record?.worktree
    ? await workspace.worktrees.status(record.worktree.path, record.worktree.baseRef)
    : undefined;
  return json({
    agent: agents.find((entry) => entry.name === agent) ?? null,
    state: states.get(agent) ?? null,
    descendants,
    record: record ?? null,
    worktreeStatus: worktreeStatus ?? null,
    resumable: record ? isResumable(record) : false,
    declared: workspace.config?.agents[agent] !== undefined,
  });
}

async function inspectWorktree(workspace: Workspace, identity: string, isAgent: boolean): Promise<JsonValue> {
  const record = isAgent ? workspace.ledger.get(identity)?.worktree : workspace.pipelineRunWorktree(identity);
  if (!record) return json({ record: null, status: null, changedFiles: [] });
  const [status, changedFiles] = await Promise.all([
    workspace.worktrees.status(record.path, record.baseRef),
    workspace.worktrees.changedFiles(record.path, record.baseRef),
  ]);
  return json({
    record,
    status,
    changedFiles,
    ...(isAgent ? { verify: await workspace.verifyInfo(identity) ?? null } : {}),
  });
}

function inspectPipeline(workspace: Workspace, name?: string, runId?: string): JsonValue {
  return json({
    names: workspace.listPipelines(),
    runs: workspace.pipelines.allRuns(),
    ...(name !== undefined ? {
      name,
      filePath: workspace.pipelineFilePath(name),
      needsInput: workspace.pipelineNeedsInput(name),
    } : {}),
    ...(runId !== undefined ? {
      run: workspace.pipelines.getRun(runId) ?? null,
      inputPath: workspace.runInputFilePath(runId),
      inputExists: fs.existsSync(workspace.runInputFilePath(runId)),
      worktree: workspace.pipelineRunWorktree(runId) ?? null,
    } : {}),
  });
}

function configMutation(workspace: Workspace, mutate: () => boolean): JsonValue {
  void workspace;
  const changed = mutate();
  if (!changed) throw new Error("tachyon.yml mutation was refused");
  return json({ changed: true });
}

async function deleteConfiguredAgent(
  workspace: Workspace,
  agent: string,
  removeWorktree: boolean,
  onViewsChanged: (view: ViewKind) => void,
): Promise<JsonValue> {
  const record = workspace.ledger.get(agent);
  if (record?.worktree && !removeWorktree) {
    throw new Error(`agent '${agent}' still owns a worktree; remove it before deleting the agent`);
  }
  if (record?.worktree) await removeAgentWorktree(workspace, agent, true);
  const states = await workspace.manager.agentStates();
  if (states.has(agent)) {
    await workspace.manager.kill(agent).catch(() => undefined);
    if ((await workspace.manager.agentStates()).has(agent)) {
      throw new Error(`could not stop '${agent}' — it was not removed`);
    }
  }
  if (workspace.config?.agents[agent] === undefined) {
    workspace.manager.dismissAdhoc(agent);
    await workspace.forgetAgent(agent);
  } else {
    const changed = workspace.mutateConfig((text) => deleteAgent(text ?? "", agent));
    if (!changed) throw new Error(`could not remove '${agent}' from tachyon.yml`);
    await workspace.forgetAgent(agent);
    onViewsChanged("agents");
  }
  return json({ changed: true });
}

async function promoteAgent(
  workspace: Workspace,
  agent: string,
  onViewsChanged: (view: ViewKind) => void,
): Promise<JsonValue> {
  const record = workspace.ledger.get(agent);
  const definition = record?.def;
  if (!definition) throw new Error(`'${agent}' has no stored definition to save`);
  if (workspace.config?.agents[agent] !== undefined) throw new Error(`'${agent}' is already declared in tachyon.yml`);
  const changed = workspace.mutateConfig(
    (text) => addAgent(text ?? "", agent, definition.cmd, definition.kind, definition.instructions),
    () => onViewsChanged("agents"),
  );
  if (!changed) throw new Error(`could not save '${agent}' to tachyon.yml`);
  if (isResumable(record)) workspace.ledger.record(agent, { ...record, declared: true });
  else workspace.ledger.remove(agent);
  workspace.manager.forgetAdhoc(agent);
  return json({ changed: true });
}

async function forkAgent(
  workspace: Workspace,
  activityLog: ActivityLogManager,
  agent: string,
): Promise<JsonValue> {
  const plan = await workspace.manager.planFork(agent);
  activityLog.noteLifecycle(workspace.wsHash, plan.forkName, "forked");
  try {
    const created = await workspace.manager.commitFork(plan);
    workspace.snapshotContinuityForFork(agent, created);
    activityLog.armLifecycle(workspace.wsHash, created);
    return json({ agent: created });
  } catch (error) {
    activityLog.clearLifecycle(workspace.wsHash, plan.forkName);
    throw error;
  }
}

async function removeAgentWorktree(workspace: Workspace, agent: string, deleteBranch: boolean): Promise<JsonValue> {
  const descendants = await workspace.manager.liveDescendants(agent);
  if (descendants.length > 0) throw new Error(`cannot remove '${agent}' worktree while descendants are live: ${descendants.join(", ")}`);
  const record = workspace.ledger.get(agent)?.worktree;
  if (!record) throw new Error(`'${agent}' has no worktree`);
  if ((await workspace.manager.agentStates()).has(agent)) {
    await workspace.manager.kill(agent).catch(() => undefined);
    if ((await workspace.manager.agentStates()).has(agent)) {
      throw new Error(`could not stop '${agent}' before removing its worktree`);
    }
  }
  const result = await workspace.worktrees.remove(record, deleteBranch);
  if (!result.removed) throw new Error(result.error ?? `could not remove '${agent}' worktree`);
  workspace.ledger.clearWorktree(agent);
  workspace.managedWorktrees.syncAgentRecord(agent, null);
  return json(result);
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.end();
      resolve(true);
    });
    socket.setTimeout(800);
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function json(value: unknown): JsonValue {
  const encoded = JSON.stringify(value === undefined ? null : value);
  if (encoded === undefined) throw new Error("extension operation produced no JSON value");
  const parsed: unknown = JSON.parse(encoded);
  if (!isJsonValue(parsed)) throw new Error("extension operation produced an invalid JSON value");
  return parsed;
}
