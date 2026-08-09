import fs from "node:fs";
import net from "node:net";
import { approvalResolutionPorts } from "../bridge/approvalResolutionPorts.js";
import { createProfileFromStudioMutation } from "../config/agentProfileStudio.js";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ActivityLogManager } from "../activity/ActivityLogManager.js";
import { removeAgentWorktree, stopAgentSessionForDelete } from "../agents/agentRemovalCascade.js";
import { isAgentProfileRefusal } from "../config/agentProfileRefusal.js";
import type { AgentForgetPlanResultV1 } from "../config/agentForgetPlan.js";
import { EvolutionStoreError } from "../evolution/EvolutionStore.js";
import { executeWait, type BridgeDeps } from "../bridge/tools.js";
import { APPROVAL_CHANNEL_VSCODE_COMMAND, resolveApproval } from "../bridge/approvalRequest.js";
import { degradedRosterExtras } from "../config/configFailure.js";
import { PORTABLE_AGENT_PROFILE_BUNDLE_MAX_BYTES } from "../config/agentProfileBundle.js";
import { projectAgentProfileStudioSnapshot } from "../config/agentProfileStudio.js";
import {
  upsertAgent,
  cloneAgent,
  deleteAgent,
  deleteCommand,
  deleteRunbook,
  setCompanionTabTools,
  setCompanionAllowedHosts,
  setIdeBrowserEnabled,
  setIdleAfterMinutes,
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
      const out: Record<string, { state: string; composerOccupied?: boolean; matchedLine?: string }> = {};
      for (const [agent, attention] of workspace.monitor.states()) {
        out[agent] = {
          state: attention.state,
          // Design Mode chat send uses this to avoid clobbering a human draft (t-348c9a).
          composerOccupied: !!attention.composerOccupied,
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
    case "agent-profile.studio-inspect":
      return json(await workspace.inspectAgentProfileStudio(query.agent));
    case "agent-profile.studio-ownership":
      return json(await workspace.agentOwnershipView(query.agent));
    case "agent-profile.forget-plan":
      return json(await agentForgetPlanResult(workspace, query.agent, query.expectedRevision));
    case "agent-profile.authorizable-capabilities":
      return json(await workspace.authorizableCapabilitiesFor(query.agent));
    case "agent-profile.studio-bundle-export": {
      const exported = await workspace.exportAgentProfileStudioBundle(query.agent, query.expectedRevision);
      return json({
        schemaVersion: 1,
        agentName: query.agent,
        revision: query.expectedRevision,
        fileName: `${query.agent}.tachyon-agent-profile.json`,
        contentBase64: exported.bytes.toString("base64"),
        byteSize: exported.bytes.length,
        sha256: exported.sha256,
        requiresReauthorization: exported.bundle.requiresReauthorization,
      });
    }
    case "bridge.token":
      return json({ token: workspace.externalToken ?? null, authEnabled: workspace.authEnabled });
    case "companion.status": {
      // SDD 414 — Control Settings: tabTools opt-in + connected devices (not host tab trust).
      const devices = workspace.companion.listDevices((token) => workspace.companionLive.hasLiveClient(token));
      return json({
        tabTools: workspace.config?.settings.companion?.tabTools === true,
        allowedHosts: Array.isArray(workspace.config?.settings.companion?.allowedHosts)
          ? workspace.config!.settings.companion!.allowedHosts!
          : [],
        paired: workspace.companion.hasPairedDevice(),
        baseUrl: workspace.companionBaseUrl(),
        baseUrls: workspace.companionBaseUrlCandidates(),
        lanAccess: workspace.config?.settings.companion?.lanAccess === true,
        /** SDD 488 F4 — piggybacked so Settings can show the Integrated Browser gate without a second query. */
        ideBrowserEnabled: workspace.config?.settings.ideBrowser?.enabled === true,
        engineLabel: path.basename(workspace.workspaceRoot) || "tachyon",
        devices,
      });
    }
    case "companion.pair-code": {
      // SDD 414/422 — short-lived pair code + baseUrl(s) + QR payload for Companion (browser/mobile).
      const issued = workspace.issueCompanionPairCode();
      if ("ok" in issued && issued.ok === false) {
        return json({
          ok: false,
          reason: issued.reason,
          protocolVersion: workspace.companion.protocolVersion,
          prefix: workspace.companionHttpPrefix(),
        });
      }
      let qrDataUrl: string | undefined;
      try {
        const { companionPairQrDataUrl } = await import("../companion/pairQr.js");
        // Prefer openUrl so phone camera opens engine-served PWA and auto-pairs (one-QR dogfood).
        const openUrl = "openUrl" in issued && typeof issued.openUrl === "string" ? issued.openUrl : "";
        const payload = "qrPayload" in issued ? String(issued.qrPayload) : "";
        const qrContent = openUrl || payload;
        if (qrContent) qrDataUrl = await companionPairQrDataUrl(qrContent);
      } catch {
        /* QR optional — UI still shows openUrl / payload text */
      }
      return json({
        ok: true,
        ...issued,
        prefix: workspace.companionHttpPrefix(),
        ...(qrDataUrl ? { qrDataUrl } : {}),
      });
    }
    case "agent.inspect":
      return inspectAgent(workspace, query.agent);
    case "agent.session-inspection":
      return json(await workspace.inspectAgentSession(query.agent));
    case "agent.fork-preview":
      return json(await workspace.manager.planFork(query.agent));
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
        targets: injectTargets(await workspace.manager.listAgents()),
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
    case "worktrees.classified": {
      // spec 444 — the ONE classified read for Control's Worktrees tab. Every row flows through
      // ManagedWorktreeService (fail-closed loader + reconcile) + classify.ts; no raw JSON parsing.
      return json({ worktrees: (await workspace.managedWorktrees.listClassified()) as unknown as JsonValue });
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
        // t-86e59a — the CHANNEL, not an actor. This action is reachable by anything that can speak the
        // control socket (door 1, t-6edd70), so "a human clicked in VS Code" is not a fact this site has.
        resolvedBy: APPROVAL_CHANNEL_VSCODE_COMMAND,
        ...approvalResolutionPorts({
          listEntries: () => workspace.manager.list(),
          // t-d79534 — queue-aware delivery; see the twin note in Workspace.ts.
          deliverNotice: (agent, line) => workspace.deliverNotice(agent, line),
        }),
        // Left as it was: this path lets a failing pin completion surface. See t-a77fe6 — the two
        // callers disagree about that and the disagreement is reported, not silently settled here.
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
      // Host Control: force-revoke Companion session(s). Optional deviceId clears one row.
      const deviceId = typeof command.deviceId === "string" ? command.deviceId : undefined;
      const result = workspace.companion.forceUnpair(deviceId);
      for (const token of result.sessionTokens) {
        try {
          workspace.companionLive.dropSession(token);
        } catch {
          /* best-effort */
        }
      }
      return json({ ok: true, hadSession: result.hadSession });
    }
    case "config.agent.clone": {
      if (workspace.isAgentProfileAgent(command.agent)) {
        await workspace.cloneAgentProfileAgent(command.agent, command.newName);
        onViewsChanged("agents");
        return json({ changed: true });
      }
      if (workspace.config?.agents[command.agent]?.kind !== "terminal") {
        throw new Error(`'${command.agent}' is not a canonical agent or declared terminal`);
      }
      return configMutation(workspace, () => workspace.mutateConfig(
        (text) => cloneAgent(text ?? "", command.agent, command.newName),
        () => onViewsChanged("agents"),
      ));
    }
    case "config.agent.rename":
      await workspace.renameAgent(command.agent, command.newName);
      return json({ changed: true });
    case "config.agent.delete":
      return deleteConfiguredAgent(workspace, command.agent, command.removeWorktree, onViewsChanged);
    case "config.agent.promote":
      return promoteAgent(workspace, command.agent, onViewsChanged);
    case "agent-profile.studio-commit":
      return json(await workspace.commitAgentProfileStudio(command.mutation));
    case "agent-profile.saved-agent-create": {
      // One transaction covering both subjects; the snapshot returned is the CREATED agent's.
      const created = await workspace.commitSavedAgentCreation({
        agentName: command.mutation.agentName,
        createProfile: createProfileFromStudioMutation(command.mutation),
        owner: command.owner,
      });
      return json({ revision: created.revision, txid: created.txid });
    }
    case "agent-profile.saved-agent-create-v2": {
      const profile = createProfileFromStudioMutation(command.mutation);
      const created = await workspace.commitSavedAgentCreation({
        agentName: command.mutation.agentName,
        createProfile: command.grants ? { ...profile, grants: command.grants } : profile,
        owner: command.owner,
      });
      return json({ revision: created.revision, txid: created.txid });
    }
    case "agent-profile.authorize-skill": {
      // t-5498a6 — a refusal is a RESULT, not a thrown error. "this plugin does not install for
      // codex" is an answer the human needs to read, and turning it into an exception would surface
      // it as an engine failure with no way to tell it from a broken transaction.
      const authorized = await workspace.authorizeAgentSkill(command.agentName, command.skillName, {
        ...(command.reauthorize ? { reauthorize: true } : {}),
      });
      return json(authorized);
    }
    case "agent-profile.authorize-plugin": {
      // Whole-plugin authorization: a refusal is a RESULT here too, for the same reason as the skill
      // door — "also installs settings-hook, which no capability grant can carry yet" is the answer.
      const authorized = await workspace.authorizeAgentPlugin(command.agentName, command.pluginName, {
        ...(command.reauthorize ? { reauthorize: true } : {}),
      });
      return json(authorized);
    }
    case "agent-profile.studio-lifecycle":
      return json(await workspace.commitAgentProfileStudioLifecycle(command.mutation));
    case "agent-profile.studio-bundle-clone": {
      const result = await workspace.cloneAgentProfileStudioBundle(command.agent, command.expectedRevision, command.destinationAgentName);
      return json({
        schemaVersion: 1,
        kind: "created",
        operation: "clone",
        snapshot: projectAgentProfileStudioSnapshot(result.lifecycle.snapshot),
        bundleSha256: result.bundleSha256,
        requiresReauthorization: result.requiresReauthorization,
      });
    }
    case "agent-profile.studio-bundle-import": {
      if (!stagedPayloads) throw new Error("Agent profile bundle payload transport is unavailable");
      const bytes = stagedPayloads.consume(command.payload, PORTABLE_AGENT_PROFILE_BUNDLE_MAX_BYTES);
      const result = await workspace.importAgentProfileBundle(command.destinationAgentName, bytes);
      return json({
        schemaVersion: 1,
        kind: "created",
        operation: "import",
        snapshot: projectAgentProfileStudioSnapshot(result.lifecycle.snapshot),
        bundleSha256: result.bundleSha256,
        requiresReauthorization: result.requiresReauthorization,
      });
    }
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
    case "config.ideBrowser.enabled":
      // SDD 488 F4 — human surface + call-time gate; does not drop ide_browser_* from the catalog.
      return configMutation(workspace, () => workspace.mutateConfig(
        (text) => setIdeBrowserEnabled(text, command.enabled),
        () => onViewsChanged("agents"),
      ));
    case "config.notifications.idleAfterMinutes":
      // t-585d5c — Control → Settings writes the idle-notification window. Same `onViewsChanged`
      // signal as the companion writers above; the monitor itself needs none, because it re-reads
      // the live config on its next tick instead of holding a copy of this value.
      return configMutation(workspace, () => workspace.mutateConfig(
        (text) => setIdleAfterMinutes(text, command.minutes),
        () => onViewsChanged("agents"),
      ));
    case "agent.fork":
      return forkAgent(workspace, activityLog, command.agent);
    case "agent.continue-task":
      return json(await workspace.continueTaskAcrossRuntime({
        fromAgent: command.fromAgent,
        toAgent: command.toAgent,
        reason: command.reason,
        taskSummary: command.taskSummary,
      }));
    case "worktree.remove":
      return json({ ...(await removeAgentWorktree(workspace, command.agent, true)) });
    case "worktree.delete-branch":
      return json({ deleted: await workspace.worktrees.deleteBranch(command.branch) });
    // spec 444 — registry-id-scoped hygiene actions from Control's Worktrees tab. Both are
    // human-initiated (the tab is a human surface); the service re-validates fail-closed on every
    // call (occupancy, dirty, ownership), so a stale UI verdict can never force a removal through.
    case "worktree.forget-record": {
      const forgotten = workspace.managedWorktrees.unregister(command.id, { kind: "human" });
      return json({ forgotten });
    }
    case "worktree.remove-managed": {
      // t-e722ce — Control → Worktrees keeps the CHANGE worktrees and hands the agent ones back.
      //
      // This tab is a human surface with exactly one caller (the Cockpit's `worktreeRemove` dep), so
      // refusing here refuses a button and nothing else: the Bridge reaches `removeClassified`
      // directly and `worktree.remove` is untouched, which is what "the way agents do it stays the
      // same" means in code. It has to be refused rather than merely hidden, because the removal it
      // performs is real and partial — it drops the registry entry and leaves the session ledger
      // still owning the checkout, so canonical forget goes on refusing `forget-worktree-owned`
      // while the surface that could fix it no longer offers the branch. That is the exact dead end
      // measured on 0.56.142, and the classifier cannot catch it: `classifyManagedWorktree` never
      // reads `kind`, so an agent's checkout classifies `ready-to-remove` like any other.
      const managed = workspace.managedWorktrees.list().find((entry) => entry.id === command.id);
      // t-621613 — the refusal below names Agent Studio → Forget as the way out, and that door is
      // reached BY AGENT NAME: it needs a roster row to be listed and a ledger row to plan the
      // removal. For an entry whose agent has neither, it names nothing reachable, and the measured
      // result was a checkout that only raw `git worktree remove` + hand-editing the registry could
      // clear. So an entry PROVED to have no inhabitant falls through to the same
      // classification-gated removal every change worktree takes. Only `absent` falls through;
      // `unknown` refuses. The partial-removal worry above cannot arise here either — the ledger row
      // that would be left owning the checkout is precisely what this entry does not have.
      const orphaned = managed?.kind === "agent"
        && (await workspace.managedWorktrees.ownerPresenceOf(managed)) === "absent";
      if (managed?.kind === "agent" && !orphaned) {
        return json({
          removed: false,
          error: `'${managed.agent ?? managed.slug ?? command.id}' is an agent's worktree. `
            + "Its checkout is released by Agent Studio → Forget, which plans the whole removal and "
            + "keeps the session ledger and the worktree registry in agreement. This tab manages "
            + "change worktrees.",
        });
      }
      // removeClassified re-runs the FULL classifier at execution time (occupancy + dirtiness +
      // base-containment) — a render-time "ready-to-remove" verdict is never trusted at click time.
      const result = await workspace.managedWorktrees.removeClassified(command.id, {
        actor: { kind: "human" },
        deleteBranch: command.deleteBranch === true,
      });
      return json(result as unknown as JsonValue);
    }
    case "worktree.release-lock": {
      // t-d29398 — and this one deliberately does NOT hand agent entries back to Agent Studio the way
      // the removal above does. The refusal there protects a checkout from being DELETED by a surface
      // that would leave the session ledger owning it; releasing a quarantine deletes nothing and
      // leaves no half-state to disagree about. It is also exactly the entry a human is stuck on: the
      // measured incident was an agent's own worktree, and sending them to Forget would have offered
      // to erase the agent when all they wanted was to launch it again.
      const result = await workspace.managedWorktrees.releaseLock(command.id, { actor: { kind: "human" } });
      return json(result as unknown as JsonValue);
    }
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
    case "bridge.refresh-tools":
      // IDE browser start/stop (and similar): close live MCP sessions so registerTools re-runs
      // and runtimes re-discover ide_browser_* / design_mode_chat_reply.
      workspace.bridge.forceToolListRefresh();
      return json({ refreshed: true });
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
    case "runtime-config.mark-pending": {
      const agents = await workspace.markRuntimeConfigPending(command.runtime ?? "codex", command.scope, command.revision);
      return json({ changed: agents.length > 0, agents });
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
    ledger: ledgerPairs.map(([name, record]) => ({ name, lifetime: record.instance?.lifetime ?? null, resumable: isResumable(record) })),
    live: live.map((agent) => ({ name: agent.name, running: agent.running, lifetime: agent.lifetime, kind: agent.kind })),
    extras: extras.map((entry) => ({
      name: entry.name,
      source: entry.source,
      lifetime: entry.lifetime,
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
  const refusedProfiles = Object.entries(workspace.refusedAgents())
    .map(([name, reason]) => ({ name, reason }))
    .sort((left, right) => left.name.localeCompare(right.name));
  // A loader failure is authoritative, especially when the file exists but cannot be read. Re-reading
  // here would either throw away that retained diagnostic or make the Doctor operation itself fail.
  if (configPath && fileExists && !workspace.configFailure) {
    const { config, errors, warnings, profileErrors } = workspace.parseTrustedConfigText(fs.readFileSync(configPath, "utf8"));
    configWarnings = [...warnings];
    const onlyRefusedProfiles = errors.length > 0 && errors.length === profileErrors.length && config !== undefined;
    if (errors.length > 0 && !onlyRefusedProfiles) {
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
    refusedProfiles,
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
    companionTailscaleReady:
      workspace.config?.settings.companion?.lanAccess === true
        ? !!(await import("../companion/lanReachability.js")).resolveTailscaleIPv4()
        : undefined,
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
  // t-6c8cb4 — do not reintroduce `declared` here. It was config-roster membership on the wire
  // with zero readers (agentInspection callers use descendants/worktree/status only).
  return json({
    agent: agents.find((entry) => entry.name === agent) ?? null,
    state: states.get(agent) ?? null,
    descendants,
    record: record ?? null,
    worktreeStatus: worktreeStatus ?? null,
    resumable: record ? isResumable(record) : false,
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

/**
 * t-e722ce — the plan, as a VALUE on the success channel.
 *
 * `planAgentProfileForget` refuses with an `AgentProfileRefusal` when the profile moved under the
 * panel. Letting that travel as an exception would flatten it to `COMMAND_FAILED` on the wire and
 * strand the one sentence that tells the human what to do, which is the failure this whole change
 * exists to remove. Only refusals are converted; a broken transaction stays an exception, because
 * a stack is not an answer anybody can act on.
 */
async function agentForgetPlanResult(
  workspace: Workspace,
  agent: string,
  expectedRevision: string,
): Promise<AgentForgetPlanResultV1> {
  try {
    return { schemaVersion: 1, kind: "plan", plan: await workspace.planAgentProfileForget(agent, expectedRevision) };
  } catch (error) {
    if (!isAgentProfileRefusal(error)) throw error;
    return { schemaVersion: 1, kind: "refused", code: error.code, message: error.message };
  }
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
  // t-e722ce — the profile-backed cascade lives on the Workspace now, because Agent Studio's Forget
  // runs the SAME one. This operation and that button are two callers of one implementation rather
  // than two implementations of one promise, which is what let them disagree in the first place.
  if (workspace.isSavedAgentMember(agent)) {
    await workspace.forgetAgentProfileAgentCascade(agent);
    onViewsChanged("agents");
    return json({ changed: true });
  }
  if (record?.worktree) await removeAgentWorktree(workspace, agent, true);
  await stopAgentSessionForDelete(workspace.manager, agent);
  if (workspace.config?.agents[agent] === undefined) {
    workspace.manager.dismissTemporary(agent);
    await workspace.forgetAgent(agent);
  } else {
    if (workspace.config.agents[agent]?.kind !== "terminal") {
      throw new Error(`'${agent}' is not a canonical agent or declared terminal`);
    }
    // t-af4a5f — the FOOTPRINT goes first and the ROSTER ROW goes last. This order used to be the
    // other way round, and between the two lines there is no journal, no lock and no barrier: a
    // crash there left the row already deleted and the whole footprint intact, unreachable by any
    // door. Measured, not assumed — a declared terminal holds NO session-ledger row, so `gcLedger`
    // (the only startup sweep that runs this cleanup for a name that left `tachyon.yml`) never fires
    // for it, and this door writes no journal, so no reconcile ever revisits it. The sweep does
    // report the leftover home as `orphan-home`, and it then hands the human an `rmdir` that the
    // surviving `evolution/` makes refuse.
    //
    // Reversed, the same crash leaves a name that is still declared, still listed and still
    // addressable, with the footprint of a terminal that has never been launched — which is not
    // residue, and which the human's next Remove finishes, because every step of `forgetAgent` is
    // idempotent. Deleting the ADDRESS last is the same trailing-edge property the project guidance
    // states for suppression: never drop the handle to the thing you still have to clean.
    //
    // The trade, stated: if the config edit refuses AFTER the footprint is cleared, the activity
    // log, transcript and Evolution profile are gone while the terminal stays declared. That loss
    // was already this door's shape before the edit — `removeAgentWorktree` and
    // `stopAgentSessionForDelete` above destroy far more, irreversibly, ahead of the same line — and
    // it leaves a working entry rather than an orphan nobody can name.
    await workspace.forgetAgent(agent);
    const changed = workspace.mutateConfig((text) => deleteAgent(text ?? "", agent));
    if (!changed) {
      throw new Error(
        `could not remove '${agent}' from tachyon.yml; its per-agent footprint is already cleared and the entry is still declared — run the removal again`,
      );
    }
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
  // t-d06da3 — promotion may not strand a checkout by OMISSION. Measured, in this order:
  //
  //  1. This door writes the profile with `upsertAgent(text, agent, { cmd }, undefined, "terminals")` —
  //     cmd, nothing else. There is no parameter for `worktree` and adding one would not help: config
  //     validation refuses `worktree` on a terminal entry outright ("this entry is a terminal — it gets
  //     no git worktree", loadConfig.ts). So this promotion CANNOT carry isolation. That is the measured
  //     reason the spec's "carry the flag" outcome is not what this door does.
  //  2. Nothing is orphaned today, and the protection is incidental rather than stated: a worktree is an
  //     Agent capability (`asAgent(ctx.def)` in Workspace's `resolveSpawnCwd` — a terminal never reaches
  //     the create path), and the gate below refuses every instance that is not a terminal. The two sets
  //     do not intersect, so the refusal an isolated child actually hears is "only a terminal instance
  //     can be saved", which says nothing about the checkout it is standing in.
  //
  // This makes the exclusion EXPLICIT and says the discarded intent out loud (t-da80ed). It fires before
  // the kind gate so the reader hears the fact that decides their case, and it is the pin the spec asked
  // for rather than trust: lift the terminal-only gate later and this refuses instead of silently
  // writing a profile that relocates the agent and abandons its tree — including through
  // `ledger.remove(agent)` below, which for a non-resumable instance drops the row that OWNS the record.
  if (record?.worktree) {
    throw new Error(
      `'${agent}' runs in its own git worktree (${record.worktree.path}, branch ${record.worktree.branch}) and saving it to `
      + "tachyon.yml here would leave that checkout behind: this promotion writes a terminal entry, and a terminal entry "
      + "cannot declare a worktree. Create the Saved Agent in Agent Studio, where a profile can declare its own worktree, "
      + "or dismiss the instance — dismissing removes the checkout with it.",
    );
  }
  if (definition.kind !== "terminal") {
    throw new Error("only a terminal instance can be saved to tachyon.yml; create an agent in Agent Studio instead");
  }
  if (workspace.config?.agents[agent] !== undefined) throw new Error(`'${agent}' is already declared in tachyon.yml`);
  const changed = workspace.mutateConfig(
    // t-c1ef82 — the `terminals:` block, because that is the only block this file still declares
    // anything in. The former `addAgent` wrote into `agents:` regardless of kind; since t-ae221c that
    // block is retired and read-and-dropped, so an entry written there would simply never come back.
    (text) => upsertAgent(text ?? "", agent, { cmd: definition.cmd }, undefined, "terminals"),
    () => onViewsChanged("agents"),
  );
  if (!changed) throw new Error(`could not save '${agent}' to tachyon.yml`);
  // t-04052d — PROMOTION, and the one place the two axes and the capability must be written apart.
  // A durable Profile now exists for this name (the config edit above), so the definition outlives the
  // process: `lifetime` becomes `saved` and it may be started again from that Profile. What does NOT
  // change is what this RUNNING instance was given: it launched ownership-only and keeps
  // `lifecycleHooks: false`. That asymmetry is the human's promotion ruling, and it is the reason
  // `lifecycleHooks` is a recorded field instead of something derived from `lifetime` — derive it and
  // promotion silently claims hooks this process never got.
  if (isResumable(record)) {
    workspace.ledger.record(agent, {
      ...record,
      instance: { lifetime: "saved", resumePolicy: "restartable", lifecycleHooks: record.instance?.lifecycleHooks ?? false },
    });
  }
  else workspace.ledger.remove(agent);
  workspace.manager.forgetTemporary(agent);
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
