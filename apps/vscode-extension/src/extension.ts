import * as vscode from "vscode";
import { engineSystemdUnitName } from "@tachyon/engine/engine-service/engineSupervisor.js";
import { reapOrphanedEngineDaemons } from "@tachyon/engine/engine-service/engineOrphanHygiene.js";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { doctor, probeServer, TmuxService, workspaceHash, SOCKET_NAME, type PaneSnapshot } from "@tachyon/engine/tmux/TmuxService.js";
import { subtreeCpuTicks } from "@tachyon/engine/attention/cpu.js";
import { classifySession } from "./inspector/classify.js";
import type { TmuxServerSnapshot } from "@tachyon/webview-ui/inspector/model";
import { asAgent } from "@tachyon/engine/config/loadConfig.js";
import { WORKSPACE_SETTINGS_FILE, workspaceSettingsPath } from "@tachyon/engine/config/workspaceSettingsFile.js";
import { FilesystemBackupAdapter } from "@tachyon/engine/statesync/adapter.js";
import { listGenerationIds, readGenerationManifest, runRestore } from "@tachyon/engine/statesync/backup.js";
import { reclaimQuarantineRoot, runReclaim } from "@tachyon/engine/reclaim/reclaimService.js";
import { setSettingsValue } from "@tachyon/engine/config/YamlConfigEditor.js";
import { parse as parseYaml } from "yaml";
import { type InspectorDeps } from "./webview/ServerInspector.js";
import { TMUX_VIEW_TYPE, TmuxPanelManager } from "./webview/TmuxPanel.js";
import { RUNTIME_OPS_VIEW_TYPE, RuntimeOpsPanelManager } from "./webview/RuntimeOpsPanel.js";
import { HUMAN_INBOX_VIEW_TYPE, HumanInboxPanelManager } from "./webview/HumanInboxPanel.js";
import { WORKTREES_VIEW_TYPE, WorktreesPanelManager } from "./webview/WorktreesPanel.js";
import { KEYS_VIEW_TYPE, KeysPanelManager } from "./webview/KeysPanel.js";
import { ONBOARDING_VIEW_TYPE, OnboardingPanelManager } from "./webview/OnboardingPanel.js";
import { scanAgentRosterDirectory } from "@tachyon/engine/config/agentRosterDirectory.js";
import { probeEngineNodeRuntime } from "@tachyon/engine/onboarding/nodeProbe.js";
import type { WorktreeLandResult } from "@tachyon/webview-ui/webview/worktrees/messages";
import { SETTINGS_VIEW_TYPE, SettingsPanelManager } from "./webview/SettingsPanel.js";
import { COMPANION_VIEW_TYPE, CompanionPanelManager } from "./webview/CompanionPanel.js";
import { SYSTEM_VIEW_TYPE, SystemPanelManager } from "./webview/SystemPanel.js";
import { RUNTIME_CONFIG_VIEW_TYPE, RuntimeConfigPanelManager, type RuntimeConfigDeps } from "./webview/RuntimeConfigPanel.js";
import { COLLECT_EVERYTHING, type SectionCollectNeeds, type WorkspaceBundle } from "@tachyon/webview-ui/sections/model";
import { SidebarPrototypeProvider } from "./webview/SidebarPrototype.js";
import { UserAppPanels } from "./webview/UserAppPanels.js";
import { UserAppBridgeCaller } from "./webview/userAppBridgeCaller.js";
import type { SidebarBootFolderVM, SidebarBootVM } from "@tachyon/shared/sidebar/types.js";
import { resolveSection, appIdOfSection } from "./sections/resolveSection.js";
import { resolveSectionDestination } from "./sections/route";
import { AgentPanePanelManager, AGENT_PANE_VIEW_TYPE, type AgentPanePanelState } from "./webview/AgentPanePanel.js";
import { deliverAgentPaneText } from "./webview/agentPaneDelivery.js";
import { pinTitleFromSelection } from "./webview/agent-pane/protocol";
import { ACTIVITY_VIEW_TYPE, ActivityPanelManager, type ActivityPanelState } from "./webview/ActivityPanel.js";
import { PluginsPanelManager, PLUGINS_VIEW_TYPE, type PluginsPanelState } from "./webview/PluginsPanel.js";
import { HandoffPanelManager, HANDOFF_VIEW_TYPE, type HandoffPanelState } from "./webview/HandoffPanel.js";
import { pendingApprovalRows } from "./webview/approval/viewModel";
import { readIdeBrowserEnabled } from "./webview/ideBrowserControlState";
import { validationAwaitsHuman } from "@tachyon/webview-ui/humanInbox/model";
import { decodeHumanInboxDeepLink } from "./humanInbox/deepLink.js";
import { approveSavedAgentProposal, type SavedAgentCommitResult } from "./agents/savedAgentProposalCommit.js";
import { approveSavedAgentRemovalProposal, type SavedAgentRemovalCommitResult } from "./agents/savedAgentRemovalProposalCommit.js";
import { savedAgentCreateMutation } from "@tachyon/engine/agents/savedAgentProposal.js";
import { readAgentProfileGrants, workspaceConfigSha256 } from "@tachyon/engine/config/agentProfileGrants.js";
import { PROBES_VIEW_TYPE, ProbeResultPanelManager, type ProbesPanelState } from "./webview/ProbeResultPanel.js";
import { PIN_STUDIO_VIEW_TYPE, type PinStudioPanelState } from "./webview/PinStudioPanel.js";
import { BOARD_VIEW_TYPE, BoardPanelManager } from "./webview/BoardPanel.js";
import { REVIEW_VIEW_TYPE, ReviewPanelManager, type ReviewPanelHost } from "./webview/ReviewPanel.js";
import { controlWorkspaceScope } from "./webview/shared/ControlWorkspaceScope.js";
import type { SectionPanelState } from "./webview/shared/SectionPanelManager.js";
import { TaskDetailPanelManager, TASK_DETAIL_VIEW_TYPE, type TaskDetailPanelState } from "./webview/TaskDetailPanel.js";
import { PinDetailPanelManager, PIN_DETAIL_VIEW_TYPE, type LegacyPinDetailState } from "./webview/PinDetailPanel.js";
import { TASK_STUDIO_VIEW_TYPE, type TaskStudioPanelState } from "./webview/TaskStudioPanel.js";
import { mintTaskId } from "@tachyon/engine/tasks/TaskStore.js";
import { mintPinId } from "@tachyon/engine/pins/PinStore.js";
import { AGENT_STUDIO_SHELL_VIEW_TYPE, AgentStudioPanelManager, type AgentStudioPanelState } from "./webview/AgentStudioPanel.js";
import { TERMINAL_STUDIO_SHELL_VIEW_TYPE, TerminalStudioPanelManager, type TerminalStudioPanelState } from "./webview/TerminalStudioPanel.js";
import { SCHEDULE_STUDIO_SHELL_VIEW_TYPE, ScheduleStudioPanelManager, type ScheduleStudioPanelState } from "./webview/ScheduleStudioPanel.js";
import { registerIdeBrowserBridge } from "./webview/ide-browser-bridge/register.js";
import { registerTachyonChatBridge } from "./webview/chat-bridge/register.js";
import { normalizeAgentRows } from "./webview/chat-bridge/ops.js";
import { syncToolLauncher } from "./plugins/toolProvisionRun.js";
import { reconcileGitHookHarness } from "./plugins/engine.js";
import { buildOffers, type RegistrationOffer } from "@tachyon/engine/registration/adapters.js";
import { runtimeOpsFleetView } from "./shell/RuntimeOpsTarget.js";
import { inspectCodexRuntimeConfig } from "./runtimeConfig/codexInventory.js";
import { applyCodexNativeConfigChange, type CodexEditableSettingKey } from "@tachyon/engine/config/codexNativeConfigProjection.js";
import { applyClaudeRuntimeConfigChange, inspectClaudeRuntimeConfig } from "./runtimeConfig/claudeInventory.js";
import {
  applyGrokRuntimeConfigChange,
  grokConfigHome,
  grokDocumentScope,
  inspectGrokRuntimeConfig,
} from "./runtimeConfig/grokInventory.js";
import type {
  AgentItem,
  PinItem,
  ScheduleItem,
  ProposalItem,
  PipelineDefItem,
  PipelineNodeItem,
  WorktreeRowItem,
  WorktreeReviewSelection,
} from "./presentation/items.js";
import { isTemporaryItem } from "./presentation/contextValue.js";
import type { WorkspacePresentationTarget } from "./shell/WorkspacePresentation.js";
import type { WorktreeStatus } from "@tachyon/engine/worktree/WorktreeManager.js";
import type { WorktreeRecord } from "@tachyon/engine/worktree/worktreeRecord.js";
import { previewBody } from "@tachyon/engine/prompts/injectFlow.js";
import { createGitExec, resolveBase } from "@tachyon/engine/worktree/WorktreeManager.js";
import { resolveGitBinary } from "@tachyon/engine/worktree/gitBinary.js";
import { sharedGlobalSettings } from "@tachyon/engine/config/globalSettings.js";
import {
  SETTINGS_IMPORT_MARKER_FILENAME,
  planGlobalImport,
  planYmlImport,
  recordSettingsImport,
  settingsImportAlreadyRan,
  settingsImportMarkerPath,
} from "./config/settingsImport.js";
import { readLegacyVsCodeSettings } from "./workspace/legacyVsCodeSettings.js";
import { type ChangedFile } from "@tachyon/engine/worktree/review.js";
import { persistEvidenceRecord } from "@tachyon/engine/worktree/evidenceStore.js";
import {
  sendReviewNotesBatch,
  type ReviewCommentsHost,
  type ReviewDocumentLocation,
  type ReviewWorktreeRow,
} from "./review/batch.js";
import { probePrReadiness, composePrTitle, composePrBody, createWorktreePr, isWorktreeDirty } from "@tachyon/engine/worktree/pr.js";
import { computeWorkspaceFolderOps, revealableWorktrees, shouldActivateFolder, type WorkspaceWorktrees } from "./workspace/workspaceFolderOps.js";
import type { ViewKind } from "@tachyon/engine/workspace/EngineHost.js";

/** Assigned in activate(); reviewWorktreeDiff is declared above that and opens this tab. */
let reviewPanels: ReviewPanelManager;
import { initializeVsCodeNotifications, notify } from "./workspace/notify.js";
import { showNotification } from "./workspace/NotificationService.js";
import { recordShellFailure, recordShellNote } from "./workspace/shellDiagnosticLog.js";
import {
  HOST_LAG_INTERVAL_MS,
  classifyHostLag,
  formatHostLagLog,
  localizeHostLagNotice,
  readLinuxRunDelayMs,
  shouldNotifyHostLag,
} from "./workspace/hostEventLoopLag.js";
import { startHostSyncIoProbe, takeHostSyncIoHit } from "./workspace/hostSyncIoProbe.js";
import { detectInstalledClis } from "@tachyon/engine/webview/cliDetect.js";
import { buildStarterFiles, ensureTachyonGitignore, type DetectedProject } from "./init/initLogic.js";
import { registerDisposePanelSerializer, registerTrustedPanelSerializer } from "./webview/shared/panelSerializer.js";
import { openRuntimeOps } from "./runtimeOps/openRuntimeOps.js";
import type { InspectedSession } from "@tachyon/engine/runtimeOps/sessionInspection.js";
import { assessBuildProvenance, type BuildStamp } from "./provenance/verify.js";
import { readEmbeddedProvenanceRecord } from "./provenance/record.js";
import { Terminals } from "./presentation/Terminals.js";
import { SessionViewportRegistry } from "./presentation/sessionViewport.js";
import { connectPackagedWorkspaceClient } from "./shell/WorkspaceClient.js";
import { isHostEngineRefusal } from "@tachyon/engine/engine-service/engineBundleStore.js";
import { collectLegacyEngineStateMigration } from "@tachyon/engine/engine-service/stateMigration.js";
import { bridgeStateMigrationStorage } from "@tachyon/bridge/stateMigrationStorage.js";
import { ENGINE_UI_CAPABILITY } from "@tachyon/engine/engine-service/uiRequestBroker.js";
import type { WorkspaceCommandResultV1 } from "@tachyon/engine/engine-service/protocol.js";
import { assertMarkedDevHostWorkspace, engineShellReleasePolicy } from "./engine-service/devHostBoundary.js";
import { WorkspaceClientRegistry } from "./shell/WorkspaceClientRegistry.js";
import { WorkspaceShellHandle } from "./shell/WorkspaceShellHandle.js";
import { DAEMON_SETTING_KEYS, type DaemonSettingsSnapshot } from "@tachyon/engine/workspace/DaemonEngineHost.js";
import { isJsonValue, type ExtensionCommandV1, type ExtensionQueryV1, type JsonValue, type TmuxPaneIdentityV1 } from "@tachyon/engine/runtime-api/extensionOperations.js";

/**
 * Thin multi-root shell: one detachable client handle per Tachyon workspace.
 * Commands are registered once and resolve their target from presentation identity,
 * an explicit workspace hash, or a folder picker.
 */

const registry = new Map<string, WorkspaceShellHandle>(); // folder fsPath -> ephemeral shell handle
let activeClientRegistry: WorkspaceClientRegistry | undefined;

declare const __TACHYON_BUILD__: BuildStamp;

function workspaces(): WorkspaceShellHandle[] {
  return [...registry.values()];
}

function tachyonBuildStamp(): BuildStamp {
  try {
    if (typeof __TACHYON_BUILD__ === "object" && __TACHYON_BUILD__ !== null) return __TACHYON_BUILD__;
  } catch {
    /* esbuild injects this in packaged bundles; unbundled tests/dev fail closed. */
  }
  return { commit: null, treeSha: null, dirty: true };
}

async function sha256File(filePath: string): Promise<string | null> {
  try {
    return crypto.createHash("sha256").update(await fs.promises.readFile(filePath)).digest("hex");
  } catch {
    return null;
  }
}

async function readTextFileOrNull(absPath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(absPath, "utf8");
  } catch (err) {
    console.debug(`[tachyon] build provenance record unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * The extension's build provenance is a fact about the INSTALLED EXTENSION (a machine/install
 * fact), not about any open project — so this reads the embedded record from the extension root
 * ONCE, regardless of which (or how many) workspaces are open. Only the human-facing incident
 * note, if any, fans out per open workspace.
 */
async function checkTachyonBuildProvenance(context: vscode.ExtensionContext): Promise<void> {
  try {
    const versionValue = (context.extension.packageJSON as { version?: unknown }).version;
    const version = typeof versionValue === "string" ? versionValue : "unknown";
    const extensionRoot = context.extensionUri.fsPath;
    const stamp = tachyonBuildStamp();

    const record = await readEmbeddedProvenanceRecord(extensionRoot, readTextFileOrNull);
    const warnings = await assessBuildProvenance({
      version,
      stamp,
      record,
      hashDistFile: async (relPath) => {
        const abs = path.resolve(extensionRoot, relPath);
        if (!abs.startsWith(path.resolve(extensionRoot) + path.sep)) return null;
        return sha256File(abs);
      },
    });
    for (const warning of warnings) {
      notify(warning.message, "warn");
      await Promise.allSettled(workspaces().map((ws) => ws.extension.invoke({
        action: "handoff.note",
        summary: warning.message,
        evidence: warning.kind === "dist-mismatch" ? [warning.file] : [],
      })));
    }
  } catch (err) {
    console.debug(`[tachyon] build provenance check skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface WorkspaceMembershipRefreshDeps<T extends object> {
  registry: Map<string, T>;
  detachWorkspace: (workspace: T) => void | Promise<void>;
  hasConfig: (folderPath: string) => boolean;
  currentWorktreesBase: () => string;
  addWorkspace: (folderPath: string, autostart: boolean, refreshOnSuccess?: boolean) => Promise<T>;
  refreshAll: () => void;
  reportError: (error: unknown) => void;
}

/** Registers the live multi-root membership path after activation has built its refresh fan-out. */
export function registerWorkspaceMembershipRefresh<T extends object>(
  onDidChangeWorkspaceFolders: (listener: (event: vscode.WorkspaceFoldersChangeEvent) => void) => vscode.Disposable,
  deps: WorkspaceMembershipRefreshDeps<T>,
): vscode.Disposable {
  return onDidChangeWorkspaceFolders((event) => {
    void refreshWorkspaceMembership(event, deps).catch((error) => reportWorkspaceMembershipError(deps, error));
  });
}

function reportWorkspaceMembershipError<T extends object>(deps: WorkspaceMembershipRefreshDeps<T>, error: unknown): void {
  try {
    deps.reportError(error);
  } catch {
    // A detached workspace event must not turn notification failures into unhandled rejections.
  }
}

async function refreshWorkspaceMembership<T extends object>(event: vscode.WorkspaceFoldersChangeEvent, deps: WorkspaceMembershipRefreshDeps<T>): Promise<void> {
  try {
    for (const removed of event.removed) {
      try {
        const ws = deps.registry.get(removed.uri.fsPath);
        if (ws) {
          deps.registry.delete(removed.uri.fsPath);
          await deps.detachWorkspace(ws);
        }
      } catch (error) {
        reportWorkspaceMembershipError(deps, error);
      }
    }
    for (const added of event.added) {
      try {
        // t-2a73d6: same worktree-base exclusion as the startup loop above, applied live —
        // a revealed worktree folder must never boot its own Bridge/tmux/agent instance.
        if (!deps.registry.has(added.uri.fsPath) && shouldActivateFolder(deps.hasConfig(added.uri.fsPath), added.uri.fsPath, deps.currentWorktreesBase())) {
          await deps.addWorkspace(added.uri.fsPath, true, false);
        }
      } catch (error) {
        reportWorkspaceMembershipError(deps, error);
      }
    }
  } finally {
    try {
      deps.refreshAll();
    } catch (error) {
      reportWorkspaceMembershipError(deps, error);
    }
  }
}

// spec 210/263 — reveal each agent's isolated git worktree as a folder in the multi-root
// workspace, and self-heal any left over from a prior reload (see computeWorkspaceFolderOps).
let notifiedSingleFolderNoReveal = false;

function jsonObject(value: unknown, label: string): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} returned an invalid object`);
  return value as Record<string, JsonValue>;
}

function jsonArray(value: unknown, label: string): JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${label} returned an invalid list`);
  return value;
}

function tmuxPaneSnapshots(value: unknown): PaneSnapshot[] {
  return jsonArray(value, "tmux.snapshot").map((entry) => {
    const row = jsonObject(entry, "tmux.snapshot row");
    if (typeof row.session !== "string"
      || !Number.isSafeInteger(row.window) || (row.window as number) < 0
      || !Number.isSafeInteger(row.pane) || (row.pane as number) < 0
      || !Number.isSafeInteger(row.pid) || (row.pid as number) < 0
      || typeof row.dead !== "boolean"
      || (row.exitCode !== undefined && !Number.isSafeInteger(row.exitCode))
      || typeof row.currentCommand !== "string"
      || typeof row.startCommand !== "string"
      || (row.createdAt !== undefined && (!Number.isSafeInteger(row.createdAt) || (row.createdAt as number) < 0))) {
      throw new Error("tmux.snapshot returned an invalid row");
    }
    return {
      session: row.session,
      window: row.window as number,
      pane: row.pane as number,
      pid: row.pid as number,
      dead: row.dead,
      ...(row.exitCode !== undefined ? { exitCode: row.exitCode as number } : {}),
      currentCommand: row.currentCommand,
      startCommand: row.startCommand,
      ...(row.createdAt !== undefined ? { createdAt: row.createdAt as number } : {}),
    };
  });
}

function tmuxPaneIdentity(row: PaneSnapshot): TmuxPaneIdentityV1 {
  return {
    session: row.session,
    window: row.window,
    pane: row.pane,
    pid: row.pid,
    startCommand: row.startCommand,
    ...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {}),
  };
}

function tmuxHealthSnapshot(value: unknown): TmuxServerSnapshot {
  const result = jsonObject(value, "tmux.health");
  const state = result.state;
  if (typeof result.socketName !== "string"
    || typeof result.socketPath !== "string"
    || (state !== "healthy" && state !== "no-server" && state !== "wedged" && state !== "unknown")
    || (result.tmuxVersion !== undefined && typeof result.tmuxVersion !== "string")
    || !Array.isArray(result.pids) || !result.pids.every((pid) => Number.isSafeInteger(pid) && (pid as number) > 0)
    || (result.diagnostics !== undefined && typeof result.diagnostics !== "string")
    || !Number.isSafeInteger(result.checkedAt) || (result.checkedAt as number) < 0) {
    throw new Error("tmux.health returned an invalid result");
  }
  return {
    socketName: result.socketName,
    socketPath: result.socketPath,
    state,
    ...(result.tmuxVersion !== undefined ? { tmuxVersion: result.tmuxVersion } : {}),
    pids: result.pids as number[],
    ...(result.diagnostics !== undefined ? { diagnostics: result.diagnostics } : {}),
    checkedAt: result.checkedAt as number,
  };
}

function configPathOf(ws: WorkspaceShellHandle): string | undefined {
  const settings = workspaceSettingsPath(ws.workspaceRoot);
  return fs.existsSync(settings) ? settings : undefined;
}

async function extensionQuery(ws: WorkspaceShellHandle, input: ExtensionQueryV1): Promise<JsonValue> {
  return ws.extension.query(input);
}

async function extensionInvoke(ws: WorkspaceShellHandle, input: ExtensionCommandV1): Promise<JsonValue> {
  return ws.extension.invoke(input);
}

async function presentTerminal(
  ws: WorkspaceShellHandle,
  agent: string,
  session: string,
  title?: string,
): Promise<void> {
  await extensionInvoke(ws, {
    action: "terminal.open",
    agent,
    session,
    ...(title !== undefined ? { title } : {}),
  });
}

async function invokeAgentLifecycle(
  ws: WorkspaceShellHandle,
  method: "agent.start" | "agent.stop" | "agent.kill" | "agent.restart" | "agent.resume",
  agent: string,
  restartOpts?: { stop?: "graceful" | "force"; session?: "resume" | "new" },
): Promise<WorkspaceCommandResultV1> {
  const input = method === "agent.restart"
    ? {
      agent,
      ...(restartOpts?.stop !== undefined ? { stop: restartOpts.stop } : {}),
      ...(restartOpts?.session !== undefined ? { session: restartOpts.session } : {}),
    }
    : { agent };
  const result = await ws.client.invoke(`vscode-agent:${crypto.randomUUID()}`, {
    schemaVersion: 1,
    method,
    input,
  });
  if (result.status === "error") throw new Error(result.message);
  if (result.method !== method) throw new Error("persistent engine returned a mismatched agent result");
  return result;
}

/**
 * spec 389 — sidebar one-click Restart.
 * force+resume: replace the process with the resume command (keeps conversation).
 * Avoids stopGracefully → "stopping…" badge (resume path never cleared that flag on the
 * old engine; graceful stop is also wrong UX when the editor pane is already open).
 * "Restart new section" stays force+new-ish via graceful|force options below.
 */
const RESTART_DEFAULT = { stop: "force" as const, session: "resume" as const };
/** Graceful stop then new section — clean exit when possible, then fresh session. */
const RESTART_NEW = { stop: "graceful" as const, session: "new" as const };
/** Immediate hard replace, new section. */
const RESTART_FORCE_NEW = { stop: "force" as const, session: "new" as const };

function agentProjection(ws: WorkspaceShellHandle, agent: string) {
  return ws.client.presentation.agents.items.find((row) => row.name === agent);
}

/** t-aaad95 — per-project `revealInWorkspace`; the rule itself lives in `revealableWorktrees`. */
async function liveWorktreesAcrossWorkspaces(): Promise<{ path: string; agent: string }[]> {
  const perWorkspace: WorkspaceWorktrees[] = [];
  for (const ws of workspaces()) {
    const worktrees: { path: string; agent: string }[] = [];
    const payload = jsonObject(await extensionQuery(ws, { action: "worktrees.list" }), "worktrees.list");
    for (const entry of jsonArray(payload.worktrees, "worktrees.list")) {
      const row = jsonObject(entry, "worktrees.list row");
      const record = jsonObject(row.record, "worktrees.list record");
      if (typeof row.agent === "string" && typeof record.path === "string") {
        worktrees.push({ path: record.path, agent: row.agent });
      }
    }
    perWorkspace.push({
      ...(ws.config?.settings.worktree?.revealInWorkspace === undefined
        ? {}
        : { revealInWorkspace: ws.config.settings.worktree.revealInWorkspace }),
      worktrees,
    });
  }
  return revealableWorktrees(perWorkspace);
}

// spec 210 — worktree.base is documented as global-only; the first workspace that configures
// it wins, else the shared XDG-aware default.
function currentWorktreesBase(): string {
  for (const ws of workspaces()) {
    if (ws.config?.settings.worktree?.base) return resolveBase(ws.config.settings);
  }
  return resolveBase({});
}

async function applyWorktreeFolderReveal(): Promise<void> {
  // t-aaad95 — the per-project opt-out is applied inside `liveWorktreesAcrossWorkspaces`, not as a
  // window-level gate; see the comment there for why a single yes/no was the wrong shape.
  // A single-folder window has no .code-workspace file: the FIRST updateWorkspaceFolders call
  // there would force the single→multi-root reload this feature is meant to avoid — skip it.
  if (vscode.workspace.workspaceFile === undefined) {
    if (!notifiedSingleFolderNoReveal) {
      notifiedSingleFolderNoReveal = true;
      notify(
        vscode.l10n.t("Tachyon can't reveal agent worktrees in a single-folder window without a reload — open the multi-root .code-workspace to see them in the file tree."),
        "info",
      );
    }
    return;
  }
  const currentFolders = (vscode.workspace.workspaceFolders ?? []).map((f) => ({ path: f.uri.fsPath, name: f.name }));
  let live: { path: string; agent: string }[];
  try {
    live = await liveWorktreesAcrossWorkspaces();
  } catch (error) {
    console.debug(`[tachyon] worktree reveal snapshot unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const ops = computeWorkspaceFolderOps(currentFolders, live, currentWorktreesBase());
  if (ops.add.length === 0 && ops.remove.length === 0) return;
  // Remove highest index first so earlier indices in the same batch stay valid, then append adds.
  for (const idx of [...ops.remove].sort((a, b) => b - a)) vscode.workspace.updateWorkspaceFolders(idx, 1);
  if (ops.add.length > 0) {
    const start = (vscode.workspace.workspaceFolders ?? []).length;
    vscode.workspace.updateWorkspaceFolders(start, 0, ...ops.add.map((f) => ({ uri: vscode.Uri.file(f.path), name: f.name })));
  }
}

function byHash(hash?: string): WorkspaceShellHandle | undefined {
  if (hash) return workspaces().find((ws) => ws.wsHash === hash);
  const all = workspaces();
  return all.length === 1 ? all[0] : undefined;
}

/**
 * Workspaces backed by an on-disk tachyon.yml — the ONLY ones any picker offers.
 * Registry membership alone isn't enough: a creation command can boot an
 * unconfigured folder on demand (ensureWorkspaceFor), which then lingers in the
 * registry; hasConfig() is the robust "is this a Tachyon project" predicate.
 */
function configuredWorkspaces(): WorkspaceShellHandle[] {
  return workspaces().filter((ws) => hasConfig(ws.workspaceRoot));
}

/** Folder disambiguation: 0 configured → undefined+warn, 1 → it, N → QuickPick (configured only).
 *
 *  t-be359b — the QuickPick below STAYS NATIVE, and the call shape is the reason. Every one of this
 *  function's callers is written `hash ? byHash(hash) : await pickWorkspace()`: a webview or a tree
 *  item PASSES the hash and never reaches here. This picker is the fallback that exists precisely
 *  because the caller had no surface to say which workspace it meant — the Command Palette door. A
 *  picker of ours would have nowhere to draw, which is worse than the native one. */
async function pickWorkspace(): Promise<WorkspaceShellHandle | undefined> {
  const all = configuredWorkspaces();
  if (all.length === 0) {
    notify(vscode.l10n.t("no Tachyon workspace is active"), "warn");
    return undefined;
  }
  if (all.length === 1) return all[0];
  const picked = await vscode.window.showQuickPick(
    all.map((ws) => ({ label: ws.folderName, description: ws.bridgeUrl, ws })),
    { placeHolder: vscode.l10n.t("Which folder?") },
  );
  return picked?.ws;
}

/** Resolves the target for arg-style commands: explicit hash beats the single default. */
function targetOf(hash?: string): WorkspaceShellHandle | undefined {
  const ws = byHash(hash);
  if (!ws) notify(vscode.l10n.t("no Tachyon workspace is active"), "warn");
  return ws;
}

/** Presentation items carry only identity; resolve them against the current shell-client registry. */
function wsOf<T extends { ws?: WorkspacePresentationTarget; workspaceHash?: string }>(item: T): WorkspaceShellHandle | undefined {
  const target = item.ws;
  const ws = target
    ? workspaces().find((candidate) => candidate.wsHash === target.wsHash && candidate.workspaceRoot === target.workspaceRoot)
    : byHash(item.workspaceHash);
  if (!ws) notify(vscode.l10n.t("no Tachyon workspace is active"), "warn");
  return ws;
}


type PromptPicker = (request: {
  title: string;
  placeholder?: string;
  items: Array<{ id: string; label: string; description?: string; detail?: string }>;
}) => Promise<string | undefined>;

/** spec 381 — shell selection/confirmation; the persistent engine revalidates and delivers.
 *  Returns true only when inject completed (false on cancel / empty catalog / refused).
 *
 *  t-de3dfc — the Agent Pane supplies `pickInSurface`: host lists, webview chooses, host executes.
 *  Without that surface (Command Palette / sidebar), the picks stay native. The AGENT pick remains
 *  native in every case because the Agent Pane always supplies `preselectedAgent` and never reaches it.
 *  Three doors reach this function: the agent pane webview (`openTemplateInject`), the Command
 *  Palette, and the sidebar's agent row. Only the pane supplies `pickInSurface`; its template and
 *  delivery questions therefore render in that live webview. The AGENT pick is unreachable there
 *  because the pane always passes `preselectedAgent` — it remains native by construction. */
async function injectPromptTemplateFlow(
  ws: WorkspaceShellHandle,
  preselectedAgent?: string,
  pickInSurface?: PromptPicker,
): Promise<boolean> {
  const catalog = jsonObject(await extensionQuery(ws, { action: "prompt.catalog" }), "prompt.catalog");
  const relDir = typeof catalog.relDir === "string" ? catalog.relDir : ".tachyon/prompts";
  const skippedCount = typeof catalog.skippedCount === "number" ? catalog.skippedCount : 0;
  const templates = jsonArray(catalog.templates, "prompt.catalog templates").map((value) => {
    const row = jsonObject(value, "prompt template");
    if (typeof row.id !== "string" || typeof row.title !== "string"
      || typeof row.body !== "string" || typeof row.sha256 !== "string") {
      throw new Error("prompt catalog returned an invalid template");
    }
    return { id: row.id, title: row.title, body: row.body, sha256: row.sha256 };
  });
  const targets = jsonArray(catalog.targets, "prompt.catalog targets").map((value) => {
    const row = jsonObject(value, "prompt target");
    if (typeof row.name !== "string" || typeof row.description !== "string") {
      throw new Error("prompt catalog returned an invalid target");
    }
    return { name: row.name, description: row.description };
  });
  if (templates.length === 0) {
    const skipHint = skippedCount > 0 ? vscode.l10n.t(" ({0} file(s) skipped)", skippedCount) : "";
    notify(vscode.l10n.t("No prompt templates in {0}/ — add <id>.md files there.{1}", relDir, skipHint), "warn");
    return false;
  }

  const templateRows = templates.map((template) => ({
    label: template.title,
    description: template.id,
    detail: template.body.split("\n")[0]?.slice(0, 120),
    template,
  }));
  const pickedTemplateId = pickInSurface
    ? await pickInSurface({
        title: vscode.l10n.t("Inject prompt template"),
        placeholder: vscode.l10n.t("Choose a template"),
        items: templateRows.map((row) => ({ id: row.template.id, label: row.label, description: row.description, detail: row.detail })),
      })
    : undefined;
  const tplPick = pickInSurface
    ? templateRows.find((row) => row.template.id === pickedTemplateId)
    // No product surface is open for the Command Palette / sidebar door, so native is intentional.
    : await vscode.window.showQuickPick(templateRows, {
        title: vscode.l10n.t("Inject prompt template"), placeHolder: vscode.l10n.t("Choose a template"),
      });
  if (!tplPick) return false;
  const template = tplPick.template;

  let agentName = preselectedAgent;
  if (!agentName) {
    if (targets.length === 0) {
      notify(vscode.l10n.t("No running AI agent available for prompt injection."), "warn");
      return false;
    }
    const agentPick = await vscode.window.showQuickPick(
      targets.map((target) => ({ label: target.name, description: target.description })),
      { title: vscode.l10n.t("Send to agent"), placeHolder: vscode.l10n.t("Choose a running AI agent") },
    );
    if (!agentPick) return false;
    agentName = agentPick.label;
  }

  const modeRows = [
    {
      label: vscode.l10n.t("Stage in composer"),
      description: vscode.l10n.t("default"),
      detail: vscode.l10n.t("Paste without Enter — review before sending"),
      mode: "stage" as const,
    },
    {
      label: vscode.l10n.t("Submit now"),
      description: vscode.l10n.t("explicit"),
      detail: vscode.l10n.t("Paste + Enter — refused when the agent is busy"),
      mode: "submit" as const,
    },
  ];
  const modeTitle = vscode.l10n.t("Delivery for '{0}' → {1}", template.title, agentName);
  const pickedModeId = pickInSurface
    ? await pickInSurface({
        title: modeTitle,
        placeholder: vscode.l10n.t("Stage or submit?"),
        items: modeRows.map((row) => ({ id: row.mode, label: row.label, description: row.description, detail: row.detail })),
      })
    : undefined;
  const modePick = pickInSurface
    ? modeRows.find((row) => row.mode === pickedModeId)
    // Same no-surface door as the template choice above.
    : await vscode.window.showQuickPick(modeRows, { title: modeTitle, placeHolder: vscode.l10n.t("Stage or submit?") });
  if (!modePick) return false;
  const submit = modePick.mode === "submit";

  const actionLabel = submit ? vscode.l10n.t("Submit") : vscode.l10n.t("Stage");
  const ok = await showNotification(
    submit
      ? vscode.l10n.t("Submit prompt template into '{0}'?", agentName)
      : vscode.l10n.t("Stage prompt template into '{0}'?", agentName),
    "info",
    [actionLabel],
    { modal: true, detail: previewBody(template.body) },
  );
  if (ok !== actionLabel) return false;

  try {
    await extensionInvoke(ws, {
      action: "prompt.inject",
      agent: agentName,
      templateId: template.id,
      expectedSha256: template.sha256,
      submit,
    });
    notify(submit
      ? vscode.l10n.t("Prompt template '{0}' submitted to '{1}'.", template.title, agentName)
      : vscode.l10n.t("Prompt template '{0}' staged into '{1}' (not submitted).", template.title, agentName));
    return true;
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), "warn");
    return false;
  }
}

/**
 * The two sides a review compares. `headRef` is what SDD 501 added: absent, the current side is the
 * file on disk (spec 213's question — what has this agent touched *so far*, uncommitted work included);
 * present, it is read out of that commit instead, and the pair is committed history.
 */
interface ReviewSides {
  /** The checkout both sides are read from. */
  cwd: string;
  baseRef: string;
  /** SDD 501 — read the current side from this commit rather than from the working tree. */
  headRef?: string;
  workspaceHash: string;
  worktree: string;
}

/** spec 213 / 230 / SDD 513 — resolve a worktree's changed files and open the Tachyon review tab.
 *  THE one implementation: the agent worktree review, the pipeline run "View changes" and
 *  (SDD 501) the land door all resolve an identity and arrive here.
 *
 *  t-ea5425 — `select` is how a caller says WHICH CHROME picks the file:
 *    · omitted → open the Tachyon tab with the first file selected. The screen lists the rest.
 *    · `"list"` → pick nothing, open nothing, and hand the candidates back. The Worktrees dashboard
 *      draws its own picker in the card the human clicked.
 *    · `{ file }` → that webview already chose; open the Tachyon tab on this path.
 *  Native vscode.diff is no longer this door. */
/** t-ea5425 — the candidate set a caller with its own picker gets back from `"list"`. */
export interface ReviewCandidates {
  label: string;
  base: string;
  /** The current side's name — a commit when the comparison is committed history, else "worktree". */
  current: string;
  files: ChangedFile[];
}

async function reviewWorktreeDiff(
  sides: ReviewSides,
  changes: ChangedFile[],
  label: string,
  select?: WorktreeReviewSelection,
): Promise<ReviewCandidates | undefined> {
  if (changes.length === 0) {
    notify(vscode.l10n.t("Nothing to review — '{0}' has no changes yet.", label), "info");
    return;
  }
  // The current side names itself: a diff read out of a commit must not be titled "worktree".
  const currentLabel = sides.headRef
    ? (sides.headRef.length > 8 ? sides.headRef.slice(0, 8) : sides.headRef)
    : "worktree";
  if (select === "list") return { label, base: sides.baseRef, current: currentLabel, files: changes };
  const chosen = select
    ? changes.find((c) => c.path === select.file)
    : changes[0];
  if (!chosen) {
    // A file that is no longer in the list is a REFUSAL. The webview drew its candidates at click
    // time and the human chooses later — a commit landing in between must say so rather than open
    // nothing and look broken.
    if (select) notify(vscode.l10n.t("'{0}' is no longer among the changed files of '{1}'.", select.file, label), "warn");
    return;
  }
  reviewPanels.open({
    workspaceHash: sides.workspaceHash,
    worktree: sides.worktree,
    cwd: sides.cwd,
    baseRef: sides.baseRef,
    currentLabel,
    files: changes,
    selectedPath: chosen.path,
    ...(sides.headRef !== undefined ? { headRef: sides.headRef } : {}),
  });
  return undefined;
}

const DRAFT_INPUT_SEED =
  "<!-- Describe the input for this pipeline run (the issue / task). Lines starting with <!-- are ignored.\n" +
  "     Save the file, then click Start in the notification. -->\n\n";

/** Strip leading HTML-comment guidance lines from a drafted input. */
const stripInputComments = (raw: string): string =>
  raw
    .split("\n")
    .filter((l) => !l.trim().startsWith("<!--") && !l.trim().endsWith("-->"))
    .join("\n")
    .trim();

/**
 * spec 231 — start a pipeline, collecting a run input first when it declares `input: required`. The input
 * is edited in a real `.md` file (NOT a single-line InputBox — codex MINOR); the non-modal notification
 * lets the human edit + save, then Start. Falls through to a plain start for `input: none` pipelines.
 */
async function startPipelineWithInput(ws: WorkspaceShellHandle, name: string): Promise<void> {
  const inspected = jsonObject(await extensionQuery(ws, { action: "pipeline.inspect", name }), "pipeline.inspect");
  if (inspected.needsInput !== true) {
    await extensionInvoke(ws, { action: "pipeline.start", name });
    return;
  }
  const draftPath = path.join(ws.workspaceRoot, ".tachyon", "runs", `draft-${name}.input.md`);
  try {
    fs.mkdirSync(path.dirname(draftPath), { recursive: true });
    if (!fs.existsSync(draftPath)) fs.writeFileSync(draftPath, DRAFT_INPUT_SEED, "utf8");
  } catch {
    /* best-effort */
  }
  await vscode.window.showTextDocument(vscode.Uri.file(draftPath));
  const pick = await showNotification(
    vscode.l10n.t("Write the input for pipeline '{0}', save the file, then Start.", name),
    "info",
    [
      vscode.l10n.t("Start"),
      vscode.l10n.t("Cancel"),
    ],
  );
  if (pick !== vscode.l10n.t("Start")) return;
  let text = "";
  try {
    text = stripInputComments(fs.readFileSync(draftPath, "utf8"));
  } catch {
    /* empty → handled below */
  }
  if (text.length === 0) {
    notify(vscode.l10n.t("pipeline '{0}' not started — the input is empty", name), "warn");
    return;
  }
  const started = jsonObject(await extensionInvoke(ws, { action: "pipeline.start", name, input: text }), "pipeline.start");
  if (typeof started.runId === "string") {
    try {
      fs.rmSync(draftPath, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * spec 210 — the kill/dismiss worktree cleanup. Blocked while a descendant session is
 * alive; otherwise shows path + dirty + ahead/unpushed + branch ownership, then removes
 * the worktree. The branch is auto-deleted ONLY when it's Tachyon-created AND safely
 * mergeable (git branch -d refuses unmerged work). A branch with unmerged commits — or any
 * pre-existing (human) branch — is KEPT and only force-deleted via a spelled-out 2nd
 * confirm, so committed-but-unmerged work is never lost in one click. Returns the outcome
 * so the caller knows whether to proceed with removing the agent itself.
 */
function worktreeRecordFrom(value: unknown): WorktreeRecord {
  const row = jsonObject(value, "worktree record");
  if (typeof row.path !== "string" || typeof row.branch !== "string"
    || typeof row.tachyonCreatedBranch !== "boolean" || typeof row.baseRef !== "string"
    || typeof row.createdAt !== "string") throw new Error("worktree record is incomplete");
  return {
    path: row.path,
    branch: row.branch,
    tachyonCreatedBranch: row.tachyonCreatedBranch,
    baseRef: row.baseRef,
    ...(typeof row.baseBranch === "string" ? { baseBranch: row.baseBranch } : {}),
    createdAt: row.createdAt,
  };
}

function worktreeStatusFrom(value: unknown): WorktreeStatus {
  const row = jsonObject(value, "worktree status");
  const numbers = ["staged", "unstaged", "untracked", "conflicts", "aheadOfBase", "unpushed"] as const;
  if (numbers.some((key) => typeof row[key] !== "number")
    || typeof row.detached !== "boolean" || (row.branch !== null && typeof row.branch !== "string")
    || typeof row.hasUpstream !== "boolean") throw new Error("worktree status is incomplete");
  return row as unknown as WorktreeStatus;
}

/**
 * t-7cb971 — accept the engine's land suggestion only in a shape this can render, and NEVER repair or
 * re-derive one. It returns undefined (the row simply has no land block) rather than throwing, because
 * an engine that predates this field is an ordinary state, not a broken worktrees payload — throwing
 * here would take the whole tab down over a section that is additive.
 *
 * `command` is carried exactly as sent. The rule that a command exists only when every precondition
 * passed belongs to `landSuggestion`; asserting it a second time here would be a copy free to drift
 * from the one that produced the checks — the failure the maintainer measured three times in one day.
 */
type LandRow = NonNullable<NonNullable<WorkspaceBundle["worktrees"]>[number]["land"]>;

function landRowFrom(value: unknown): LandRow | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.head !== "string" || typeof row.branch !== "string" || typeof row.trunkRef !== "string") return undefined;
  if (typeof row.commits !== "number" || !Array.isArray(row.checks) || row.checks.length === 0) return undefined;
  if (row.primaryPath !== null && typeof row.primaryPath !== "string") return undefined;
  if (row.command !== undefined && typeof row.command !== "string") return undefined;
  const wellFormed = row.checks.every((check) => {
    const c = check as Record<string, unknown>;
    return !!c && typeof c === "object" && typeof c.id === "string" && typeof c.ok === "boolean"
      && typeof c.detail === "string" && (c.fix === undefined || typeof c.fix === "string");
  });
  return wellFormed ? (row as unknown as LandRow) : undefined;
}

function changedFilesFrom(value: unknown): ChangedFile[] {
  return jsonArray(value, "worktree changed files").map((entry) => {
    const row = jsonObject(entry, "worktree changed file");
    if ((row.status !== "A" && row.status !== "M" && row.status !== "D" && row.status !== "R" && row.status !== "C")
      || typeof row.path !== "string" || (row.from !== undefined && typeof row.from !== "string")) {
      throw new Error("worktree changed file is invalid");
    }
    return { status: row.status, path: row.path, ...(typeof row.from === "string" ? { from: row.from } : {}) };
  });
}

/**
 * SDD 501 — a third identity (`worktreeId`, the managed-registry row behind a land block) alongside the
 * agent and the pipeline run. `comparison.base` is the resolved review base (local trunk, then birth).
 * `comparison.head` is present only on the land door, where the review is of committed history.
 */
async function worktreeReview(
  ws: WorkspaceShellHandle,
  input: { agent: string } | { runId: string } | { worktreeId: string },
): Promise<{
  record: WorktreeRecord | null;
  status: WorktreeStatus | null;
  changedFiles: ChangedFile[];
  comparison?: { base: string; head?: string };
}> {
  const payload = jsonObject(await extensionQuery(ws, { action: "worktree.review", ...input }), "worktree.review");
  const comparison = payload.comparison === undefined || payload.comparison === null
    ? undefined
    : jsonObject(payload.comparison, "worktree review comparison");
  if (comparison && typeof comparison.base !== "string") {
    throw new Error("worktree review comparison is incomplete");
  }
  if (comparison && comparison.head !== undefined && typeof comparison.head !== "string") {
    throw new Error("worktree review comparison is incomplete");
  }
  return {
    record: payload.record === null ? null : worktreeRecordFrom(payload.record),
    status: payload.status === null ? null : worktreeStatusFrom(payload.status),
    changedFiles: changedFilesFrom(payload.changedFiles),
    ...(comparison ? {
      comparison: {
        base: comparison.base as string,
        ...(typeof comparison.head === "string" ? { head: comparison.head } : {}),
      },
    } : {}),
  };
}

function isReviewCommandItem(item: unknown): item is AgentItem | WorktreeRowItem {
  return !!item && typeof item === "object" && ("worktreeId" in item || "agentName" in item);
}

function reviewCommentsHost(): ReviewCommentsHost {
  return {
    async listWorktrees() {
      const rows: ReviewWorktreeRow[] = [];
      for (const ws of workspaces()) {
        try {
          const payload = jsonObject(await extensionQuery(ws, { action: "worktrees.list" }), "worktrees.list");
          for (const entry of jsonArray(payload.worktrees, "worktrees.list")) {
            const row = jsonObject(entry, "worktrees.list row");
            const record = jsonObject(row.record, "worktrees.list record");
            if (typeof row.agent === "string" && typeof record.path === "string" && typeof record.baseRef === "string") {
              rows.push({ agent: row.agent, path: record.path, baseRef: record.baseRef, workspaceHash: ws.wsHash });
            }
          }
        } catch {
          /* a workspace that cannot list is skipped */
        }
      }
      return rows;
    },
    async viewNotes(worktree, k, workspaceHash) {
      const ws = byHash(workspaceHash);
      if (!ws) throw new Error("no Tachyon workspace is active");
      const result = await ws.client.query({ schemaVersion: 1, method: "review.view", input: { worktree, k } });
      if (result.status === "error") throw new Error(result.message);
      if (result.method !== "review.view") throw new Error("review.view returned the wrong view");
      return result.view.notes;
    },
    async upsert(input, workspaceHash) {
      const ws = byHash(workspaceHash);
      if (!ws) throw new Error("no Tachyon workspace is active");
      const result = await ws.client.invoke(`review:${crypto.randomUUID()}`, {
        schemaVersion: 1,
        method: "review.mutate",
        input,
      });
      if (result.status === "error") throw new Error(result.message);
      if (result.method !== "review.mutate" || result.action !== input.action || result.id !== input.id) {
        throw new Error("review.mutate returned a mismatched result");
      }
    },
    async hint(input, workspaceHash) {
      const ws = byHash(workspaceHash);
      if (!ws) return;
      try {
        await ws.client.invoke(`review-hint:${crypto.randomUUID()}`, {
          schemaVersion: 1,
          method: "review.mutate",
          input,
        });
      } catch {
        /* hint is a hint; the next review.view re-derives */
      }
    },
    async listAgentsForWorktree(cwd, workspaceHash) {
      const ws = byHash(workspaceHash);
      if (!ws) return [];
      const names = new Set<string>();
      try {
        const payload = jsonObject(await extensionQuery(ws, { action: "worktrees.list" }), "worktrees.list");
        for (const entry of jsonArray(payload.worktrees, "worktrees.list")) {
          const row = jsonObject(entry, "worktrees.list row");
          const record = jsonObject(row.record, "worktrees.list record");
          if (typeof row.agent === "string" && typeof record.path === "string"
            && record.path.replace(/\\/g, "/").replace(/\/+$/, "") === cwd.replace(/\\/g, "/").replace(/\/+$/, "")) {
            names.add(row.agent);
          }
        }
      } catch {
        return [];
      }
      for (const name of [...names]) {
        try {
          const inspected = await agentInspection(ws, name);
          for (const descendant of inspected.descendants) names.add(descendant);
        } catch {
          /* skip an inspect that cannot run */
        }
      }
      return [...names].map((name) => {
        const row = ws.client.presentation.agents.items.find((agent) => agent.name === name);
        return {
          name,
          ...(row?.attention ? { detail: row.attention } : row?.running === true ? { detail: "running" } : {}),
        };
      });
    },
    async sendPrompt(agent, text, workspaceHash) {
      const ws = byHash(workspaceHash);
      if (!ws) throw new Error("no Tachyon workspace is active");
      await ws.activity.sendAgentInput(agent, text, true);
    },
    async attachEvidence(workspaceHash, record) {
      const ws = byHash(workspaceHash);
      if (!ws) throw new Error("no Tachyon workspace is active");
      persistEvidenceRecord(ws.workspaceRoot, record);
    },
    async resolveHead(cwd) {
      const git = createGitExec(() => resolveGitBinary({
        configuredPath: sharedGlobalSettings().current().gitPath,
        gitExtensionPath: vscode.workspace.getConfiguration("git").get<string | string[]>("path"),
      }));
      const result = await git(["rev-parse", "HEAD"], cwd);
      if (result.code !== 0) return undefined;
      const head = result.stdout.trim();
      return /^[0-9a-f]{40}$/i.test(head) ? head : undefined;
    },
    notify,
  };
}

function reviewPanelHost(): ReviewPanelHost {
  const comments = reviewCommentsHost();
  return {
    async loadSession(worktree, workspaceHash) {
      const ws = byHash(workspaceHash);
      if (!ws) return undefined;
      let review = await worktreeReview(ws, { agent: worktree });
      if (!review.record) review = await worktreeReview(ws, { worktreeId: worktree });
      if (!review.record) return undefined;
      const baseRef = review.comparison?.base ?? review.record.baseRef;
      const headRef = review.comparison?.head;
      return {
        workspaceHash,
        worktree,
        cwd: review.record.path,
        baseRef,
        currentLabel: headRef ? (headRef.length > 8 ? headRef.slice(0, 8) : headRef) : "worktree",
        files: review.changedFiles,
        ...(headRef ? { headRef } : {}),
      };
    },
    viewNotes: comments.viewNotes,
    async viewDiff(input, workspaceHash) {
      const ws = byHash(workspaceHash);
      if (!ws) throw new Error("no Tachyon workspace is active");
      const result = await ws.client.query({ schemaVersion: 1, method: "review.diff", input });
      if (result.status === "error") throw new Error(result.message);
      if (result.method !== "review.diff") throw new Error("review.diff returned the wrong view");
      return result.view;
    },
    upsert: comments.upsert,
    listAgents: comments.listAgentsForWorktree,
    sendPrompt: comments.sendPrompt,
    attachEvidence: comments.attachEvidence,
    resolveHead: comments.resolveHead,
    notify,
  };
}

async function reviewWorktreeFromPalette(): Promise<undefined> {
  const ws = await pickWorkspace();
  if (!ws) return undefined;
  const payload = jsonObject(await extensionQuery(ws, { action: "worktrees.list" }), "worktrees.list");
  const rows = jsonArray(payload.worktrees, "worktrees.list").flatMap((entry) => {
    try {
      const row = jsonObject(entry, "worktrees.list row");
      const record = jsonObject(row.record, "worktrees.list record");
      if (typeof row.agent !== "string" || typeof record.path !== "string" || typeof record.baseRef !== "string") return [];
      return [{ agent: row.agent, path: record.path, baseRef: record.baseRef, branch: typeof record.branch === "string" ? record.branch : "" }];
    } catch {
      return [];
    }
  });
  if (rows.length === 0) {
    notify(vscode.l10n.t("No worktree is available to review."), "warn");
    return undefined;
  }
  const picked = rows.length === 1 ? rows[0] : (await vscode.window.showQuickPick(
    rows.map((row) => ({ label: row.agent, description: row.branch || row.path, row })),
    { title: vscode.l10n.t("Review Changes"), placeHolder: vscode.l10n.t("Which worktree?") },
  ))?.row;
  if (!picked) return undefined;
  let review = await worktreeReview(ws, { agent: picked.agent });
  if (!review.record) review = await worktreeReview(ws, { worktreeId: picked.agent });
  if (!review.record) {
    notify(vscode.l10n.t("'{0}' has no worktree", picked.agent), "warn");
    return undefined;
  }
  if (review.comparison) {
    await reviewWorktreeDiff(
      {
        cwd: review.record.path,
        baseRef: review.comparison.base,
        headRef: review.comparison.head,
        workspaceHash: ws.wsHash,
        worktree: picked.agent,
      },
      review.changedFiles,
      review.record.branch,
    );
    return undefined;
  }
  await reviewWorktreeDiff({
    cwd: review.record.path,
    baseRef: review.record.baseRef,
    workspaceHash: ws.wsHash,
    worktree: picked.agent,
  }, review.changedFiles, picked.agent);
  return undefined;
}

async function locationFromReviewItem(item: AgentItem | WorktreeRowItem): Promise<ReviewDocumentLocation | undefined> {
  const ws = wsOf(item);
  if (!ws) return undefined;
  if ("worktreeId" in item) {
    const review = await worktreeReview(ws, { worktreeId: item.worktreeId });
    if (!review.record) return undefined;
    const row = (await reviewCommentsHost().listWorktrees())
      .find((candidate) => candidate.workspaceHash === ws.wsHash && candidate.path === review.record!.path);
    return {
      worktree: row?.agent ?? item.worktreeId,
      cwd: review.record.path,
      path: "",
      baseRef: review.comparison?.base ?? review.record.baseRef,
      workspaceHash: ws.wsHash,
      ...(review.comparison?.head ? { headRef: review.comparison.head } : {}),
    };
  }
  const review = await worktreeReview(ws, { agent: item.agentName });
  if (!review.record) {
    notify(vscode.l10n.t("'{0}' has no worktree", item.agentName), "warn");
    return undefined;
  }
  return {
    worktree: item.agentName,
    cwd: review.record.path,
    path: "",
    baseRef: review.comparison?.base ?? review.record.baseRef,
    workspaceHash: ws.wsHash,
  };
}

async function sendReviewNotesCommand(item?: AgentItem | WorktreeRowItem): Promise<void> {
  const host = reviewCommentsHost();
  let location: ReviewDocumentLocation | undefined;
  if (isReviewCommandItem(item)) {
    location = await locationFromReviewItem(item);
  } else {
    const rows = await host.listWorktrees();
    if (rows.length === 1) {
      location = {
        worktree: rows[0].agent,
        cwd: rows[0].path,
        path: "",
        baseRef: rows[0].baseRef,
        workspaceHash: rows[0].workspaceHash,
      };
    } else if (rows.length > 1) {
      const picked = await vscode.window.showQuickPick(
        rows.map((row) => ({ label: row.agent, description: row.path, row })),
        { title: vscode.l10n.t("Send review notes to…"), placeHolder: vscode.l10n.t("Which worktree?") },
      );
      if (picked) {
        location = {
          worktree: picked.row.agent,
          cwd: picked.row.path,
          path: "",
          baseRef: picked.row.baseRef,
          workspaceHash: picked.row.workspaceHash,
        };
      }
    }
  }
  if (!location) {
    notify(vscode.l10n.t("Nothing to send — open a worktree review or pick an agent."), "warn");
    return;
  }
  const result = await sendReviewNotesBatch({
    host,
    location,
    pickAgent: async (agents) => {
      const picked = await vscode.window.showQuickPick(
        agents.map((agent) => ({ label: agent.name, description: agent.detail, name: agent.name })),
        {
          title: vscode.l10n.t("Send review notes to…"),
          placeHolder: vscode.l10n.t("{0} agent(s) on this worktree", agents.length),
        },
      );
      return picked?.name;
    },
  });
  if (!result.sent) {
    if (result.reason === "empty") notify(vscode.l10n.t("No review notes to send."), "info");
    else if (result.reason === "no-agents") notify(vscode.l10n.t("No agents belong to this worktree."), "warn");
    return;
  }
  if (result.evidence === "failed") {
    notify(vscode.l10n.t("Could not record the sent notes as evidence: {0}", "persist failed"), "warn");
  } else if (result.evidence === "no-head") {
    notify(vscode.l10n.t("Review notes were sent, but evidence was not recorded — worktree HEAD is unresolvable."), "warn");
  }
  notify(vscode.l10n.t("Review notes sent to '{0}'.", result.agent), "info");
}

async function agentInspection(ws: WorkspaceShellHandle, agent: string): Promise<{
  descendants: string[];
  record: Record<string, JsonValue> | null;
  worktree: WorktreeRecord | null;
  status: WorktreeStatus | null;
}> {
  // t-6c8cb4 — `declared` was a dead wire field: producer computed config-roster membership,
  // but no agentInspection() caller ever read the returned value. Dropped from type, validation,
  // and return (and from the producer) so it cannot be "reused" as agent-species vocabulary.
  const payload = jsonObject(await extensionQuery(ws, { action: "agent.inspect", agent }), "agent.inspect");
  const descendants = jsonArray(payload.descendants, "agent descendants").map((entry) => {
    if (typeof entry !== "string") throw new Error("agent descendant name is invalid");
    return entry;
  });
  const record = payload.record === null ? null : jsonObject(payload.record, "agent record");
  const worktree = record?.worktree === undefined ? null : worktreeRecordFrom(record.worktree);
  const status = payload.worktreeStatus === null ? null : worktreeStatusFrom(payload.worktreeStatus);
  return { descendants, record, worktree, status };
}

async function confirmAndRemoveWorktree(
  ws: WorkspaceShellHandle,
  name: string,
  rec: WorktreeRecord,
  knownStatus?: WorktreeStatus | null,
): Promise<"removed" | "kept" | "blocked"> {
  const inspected = await agentInspection(ws, name);
  const live = inspected.descendants;
  if (live.length > 0) {
    notify(vscode.l10n.t("Stop '{0}'s sub-agents first ({1}) — they share its worktree.", name, live.join(", ")), "warn");
    return "blocked";
  }
  const st = knownStatus ?? inspected.status;
  if (!st) throw new Error(`worktree status for '${name}' is unavailable`);
  const dirty = st.staged + st.unstaged + st.untracked + st.conflicts;
  const lines = [
    vscode.l10n.t("Worktree: {0}", rec.path),
    rec.tachyonCreatedBranch
      ? vscode.l10n.t("Branch: {0} (created by Tachyon)", rec.branch)
      : vscode.l10n.t("Branch: {0} (pre-existing — will be kept)", rec.branch),
    vscode.l10n.t(
      "Tachyon activity, pane transcripts, and the agent private runtime home are deleted. A harness home keeps its runtime-native caches, which are not a uniform archive.",
    ),
  ];
  if (dirty > 0) lines.push(vscode.l10n.t("⚠ {0} uncommitted change(s) will be lost", dirty));
  if (st.aheadOfBase > 0) lines.push(vscode.l10n.t("⚠ {0} commit(s) ahead of base, {1} unpushed — the branch is kept unless you confirm again", st.aheadOfBase, st.unpushed));
  // The branch is only auto-deleted when it's Tachyon-created AND safely mergeable (git
  // branch -d refuses unmerged work) — so the primary action just removes the worktree.
  const removeLabel = vscode.l10n.t("Remove worktree");
  const keepLabel = vscode.l10n.t("Keep worktree");
  const answer = await showNotification(lines.join("\n"), "warn", [removeLabel, keepLabel], { modal: true });
  if (answer !== removeLabel) return "kept"; // dismiss/Esc OR explicit keep → destroy nothing
  const res = jsonObject(await extensionInvoke(ws, { action: "worktree.remove", agent: name }), "worktree.remove");
  if (res.removed !== true) throw new Error(`worktree removal for '${name}' was not confirmed`);
  if (res.checkoutAlreadyAbsent === true) {
    // t-05dff5 — the checkout was already gone (removed through Control → Worktrees, or by hand).
    // The ownership record is what we just released, so say that instead of claiming a deletion,
    // and skip the branch follow-up: nothing here proved what that branch still holds.
    notify(vscode.l10n.t("'{0}' no longer owns a worktree — its checkout was already gone; branch '{1}' was left alone.", name, rec.branch), "info");
    return "removed";
  }
  if (res.branchDeleted === true) {
    notify(vscode.l10n.t("Removed worktree and merged branch '{0}'.", rec.branch), "info");
    return "removed";
  }
  // The branch was KEPT — either a pre-existing (human) branch, or a Tachyon branch with
  // UNMERGED commits (safe-delete refused). Offer a separate, spelled-out force-delete.
  const reason = rec.tachyonCreatedBranch
    ? vscode.l10n.t("Worktree removed. Branch '{0}' has unmerged commits and was kept — force-delete it and LOSE that work?", rec.branch)
    : vscode.l10n.t("Worktree removed. The pre-existing branch '{0}' was kept — delete it too? This is destructive.", rec.branch);
  const del = vscode.l10n.t("Force-delete '{0}'", rec.branch);
  const a2 = await showNotification(reason, "warn", [del], { modal: true });
  if (a2 === del) {
    const deleted = jsonObject(await extensionInvoke(ws, { action: "worktree.delete-branch", branch: rec.branch }), "worktree.delete-branch");
    const ok = deleted.deleted === true;
    notify(ok ? vscode.l10n.t("Branch '{0}' deleted.", rec.branch) : vscode.l10n.t("Could not delete '{0}' (unmerged? checked out?).", rec.branch), ok ? "info" : "warn");
  }
  return "removed";
}

function hasConfig(folderPath: string): boolean {
  return fs.existsSync(path.join(folderPath, WORKSPACE_SETTINGS_FILE));
}

/** t-be359b — STAYS NATIVE. All three callers (openAgentPane, restartAgent, openAgentTerminal) are
 *  bare palette commands whose first act is `await pickWorkspace()`, so reaching this line already
 *  proves the Command Palette door: no webview of ours is on screen to host a product picker. The
 *  sidebar and tree doors act on the agent they were clicked on and never ask. */
async function pickAgent(ws: WorkspaceShellHandle, placeholder: string, runningOnly: boolean): Promise<string | undefined> {
  const agents = ws.client.presentation.agents;
  if (agents.truncated) throw new Error("agent list is truncated");
  const candidates = runningOnly ? agents.items.filter((agent) => agent.running) : agents.items;
  if (candidates.length === 0) {
    notify(runningOnly ? vscode.l10n.t("no agents running") : vscode.l10n.t("no agents declared or running"), "warn");
    return undefined;
  }
  return vscode.window.showQuickPick(
    candidates.map((a) => a.name),
    { placeHolder: placeholder },
  );
}

async function connectRuntime(ws: WorkspaceShellHandle): Promise<void> {
  const url = ws.bridgeUrl;
  if (!url) {
    notify(vscode.l10n.t("Bridge is not running"), "error");
    return;
  }
  const readWorkspaceFile = (rel: string): string | undefined => {
    const p = path.join(ws.workspaceRoot, rel);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined;
  };
  let offers: RegistrationOffer[];
  try {
    offers = buildOffers(
      url,
      {
        claudeMcpJson: readWorkspaceFile(".mcp.json"),
        opencodeJson: readWorkspaceFile("opencode.json"),
        codexToml: readWorkspaceFile(".codex/config.toml"),
      },
      (ws.config?.settings.auth ?? true),
    );
  } catch (err) {
    notify(vscode.l10n.t("cannot build registration: {0}", err instanceof Error ? err.message : String(err)), "error");
    return;
  }
  // t-be359b — STAYS NATIVE. One caller (tachyon.connectRuntime), a bare palette command that opens
  // with `await pickWorkspace()`; there is no surface of ours on screen to draw a product picker in.
  const picked = await vscode.window.showQuickPick(
    offers.map((o) => ({ label: o.title, detail: o.notes, offer: o })),
    { placeHolder: vscode.l10n.t("Which agent runtime should connect to the Bridge?") },
  );
  if (!picked) return;
  const offer = picked.offer;

  if (offer.file && offer.content !== undefined) {
    if (offer.upToDate) {
      notify(vscode.l10n.t("{0} already registers the Bridge at {1} — nothing to do", offer.file, url));
      return;
    }
    // Idempotent merge: only the 'tachyon' key is (re)written; every other MCP
    // entry in a pre-existing file is preserved untouched.
    const target = path.join(ws.workspaceRoot, offer.file);
    fs.mkdirSync(path.dirname(target), { recursive: true }); // .codex/ may not exist yet
    fs.writeFileSync(target, offer.content, "utf8");
    notify(vscode.l10n.t("{0}: tachyon entry set to {1} — restart the agent runtime to pick it up", offer.file, url));
  } else {
    const doc = await vscode.workspace.openTextDocument({ content: offer.snippet, language: "plaintext" });
    await vscode.window.showTextDocument(doc, { preview: false });
    await vscode.env.clipboard.writeText(offer.snippet);
    notify(vscode.l10n.t("{0}: snippet opened and copied to clipboard", offer.title));
  }
}

/** The global half of the import: machine-wide, so it runs once per machine, not once per folder. */
function importLegacyGlobalSettings(): void {
  const store = sharedGlobalSettings();
  const markerPath = path.join(path.dirname(store.file), SETTINGS_IMPORT_MARKER_FILENAME);
  if (settingsImportAlreadyRan(markerPath)) return;
  // A document this build could not read is one a person may be mid-way through repairing, and it is
  // also the documented recovery surface. Importing over it would destroy it. Leave the marker
  // unwritten so a later, healthy activation still gets its one chance.
  if (store.refusal()) return;
  try {
    const patch = planGlobalImport(readLegacyVsCodeSettings(), store.authored());
    if (Object.keys(patch).length > 0) {
      store.update(patch);
      notify(vscode.l10n.t(
        "Tachyon moved {0} of your settings out of VS Code and into {1}. Edit them there or in Control → Settings.",
        String(Object.keys(patch).length),
        store.file,
      ));
    }
    recordSettingsImport(markerPath, Object.keys(patch));
  } catch (error) {
    // Never block activation on a migration: the defaults are usable and the person can re-run this
    // by deleting the marker. Failing loudly here would turn a cosmetic import into a broken start.
    console.debug(`[tachyon] global settings import skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The per-workspace half: values that describe how THIS project runs go into `.tachyon/settings.yml`
 * (t-a65335 — the retired tachyon.yml's settings block). The write is never silent — it names the
 * file and the keys it wrote so the person sees what landed.
 */
function importLegacyWorkspaceSettings(workspaceRoot: string): void {
  const markerPath = settingsImportMarkerPath(workspaceRoot);
  if (settingsImportAlreadyRan(markerPath)) return;
  try {
    const file = workspaceSettingsPath(workspaceRoot);
    if (!fs.existsSync(file)) return; // no settings yet: nothing to import into, and no marker so a later init still gets it
    let text = fs.readFileSync(file, "utf8");
    let parsedSettings: unknown;
    try {
      parsedSettings = parseYaml(text) ?? {};
    } catch {
      // A file that did not parse cannot answer "is this key already set", and `already()` would
      // then say "no" for every key — turning the import into an overwrite of decisions it merely
      // failed to read. Skip, and leave the marker unwritten so a later, healthy activation still
      // gets its one chance.
      return;
    }
    if (parsedSettings === null || typeof parsedSettings !== "object" || Array.isArray(parsedSettings)) return;
    const already = (keyPath: string[]): boolean => {
      let node: unknown = parsedSettings;
      for (const key of keyPath) {
        if (node === null || typeof node !== "object") return false;
        node = (node as Record<string, unknown>)[key];
      }
      return node !== undefined;
    };
    const writes = planYmlImport(readLegacyVsCodeSettings(vscode.Uri.file(workspaceRoot)), already);
    for (const write of writes) text = setSettingsValue(text, write.keyPath, write.value).text;
    if (writes.length > 0) {
      fs.writeFileSync(file, text, "utf8");
      notify(vscode.l10n.t(
        "Tachyon wrote {0} setting(s) you had in VS Code into {1} ({2}) — review it before committing.",
        String(writes.length),
        path.basename(file),
        writes.map((w) => w.keyPath.join(".")).join(", "),
      ), "warn");
    }
    recordSettingsImport(markerPath, writes.map((w) => `settings.${w.keyPath.join(".")}`));
  } catch (error) {
    console.debug(`[tachyon] workspace settings import skipped for ${workspaceRoot}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function daemonSettingsSnapshot(workspaceRoot: string): DaemonSettingsSnapshot {
  const scopes = {
    global: {} as Record<string, unknown>,
    workspace: {} as Record<string, unknown>,
    workspaceFolder: {} as Record<string, unknown>,
  };
  const resource = vscode.Uri.file(workspaceRoot);
  for (const qualified of DAEMON_SETTING_KEYS) {
    const split = qualified.indexOf(".");
    const section = qualified.slice(0, split);
    const key = qualified.slice(split + 1);
    const inspected = vscode.workspace.getConfiguration(section, resource).inspect<unknown>(key);
    if (inspected?.globalValue !== undefined) scopes.global[qualified] = inspected.globalValue;
    if (inspected?.workspaceValue !== undefined) scopes.workspace[qualified] = inspected.workspaceValue;
    if (inspected?.workspaceFolderValue !== undefined) scopes.workspaceFolder[qualified] = inspected.workspaceFolderValue;
  }
  return Object.fromEntries(Object.entries(scopes).filter(([, values]) => Object.keys(values).length > 0));
}

function viewKind(value: unknown): ViewKind | undefined {
  return value === "agents" || value === "pins" || value === "tasks" || value === "commands"
    || value === "schedules" || value === "handoff" || value === "probes" ? value : undefined;
}

/** t-af3eef — control-flow marker for "this view did not ask for that slice". Never surfaced. */
const SKIP_SLICE = Symbol("tachyon.collect.skip");

/**
 * t-aaad95 — the documented text-file recovery path for the global Tachyon settings.
 *
 * It CREATES the document when absent rather than failing on a missing file: this is the command a
 * person reaches for when something is misconfigured, and "the file you were told to edit does not
 * exist" is the least useful thing it could say at that moment. A REFUSED document is opened as-is
 * and named — the person is here to repair it, and `update` would overwrite what they came to fix.
 */
function registerGlobalSettingsRecovery(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand("tachyon.openGlobalSettings", async () => {
    const store = sharedGlobalSettings();
    try {
      const refusal = store.refusal();
      if (!refusal && !fs.existsSync(store.file)) store.update({});
      const doc = await vscode.workspace.openTextDocument(store.file);
      await vscode.window.showTextDocument(doc, { preview: false });
      if (refusal) notify(vscode.l10n.t("Tachyon settings were refused and the last known good is in use: {0}", refusal.errors.join("; ")), "warn");
    } catch (err) {
      notify(vscode.l10n.t("Could not open Tachyon settings: {0}", err instanceof Error ? err.message : String(err)), "error");
    }
  }));
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // t-45921f — Development/Test isolation belongs to the extension host, which knows the mode.
  // Apply the seam before ANY global-settings consumer: the zero-folder recovery command and the
  // one-time import both run before workspace boot. Production deliberately ignores the test/dev
  // environment and keeps the store's documented os.homedir() default.
  const settingsHome = context.extensionMode === vscode.ExtensionMode.Production
    ? undefined
    : process.env.TACHYON_GLOBAL_SETTINGS_HOME?.trim() || undefined;
  if (settingsHome) {
    const { useGlobalSettingsHome } = await import("@tachyon/engine/config/globalSettings.js");
    useGlobalSettingsHome(settingsHome);
  }

  initializeVsCodeNotifications(async (message, level) => {
    const clients = activeClientRegistry?.list() ?? [];
    if (clients.length === 0) throw new Error("no workspace engine is attached");
    const results = await Promise.all(clients.map((client) => client.invoke(crypto.randomUUID(), {
      schemaVersion: 1,
      method: "status-notice.set",
      input: { message, level },
    })));
    const failure = results.find((result) => result.status === "error");
    if (failure?.status === "error") throw new Error(`${failure.code}: ${failure.message}`);
  });

  // t-aaad95 — BEFORE any early return. The global settings file is per person, not per project:
  // zero workspaces open is exactly when someone needs `agentPane.enabled` answered and the recovery
  // command available. Registering it later left a contributed command with no handler in the one
  // state it was most needed, and left the one-time import unrun for a machine that never opens a
  // folder before upgrading.
  registerGlobalSettingsRecovery(context);
  importLegacyGlobalSettings();

  const engineHygiene = await reapOrphanedEngineDaemons();
  if (engineHygiene.stopped.length > 0) {
    console.warn(`[tachyon] stopped ${engineHygiene.stopped.length} orphaned persistent engine(s): ${engineHygiene.stopped.join(", ")}`);
  }
  if (engineHygiene.refused.length > 0) {
    notify(vscode.l10n.t("Tachyon left an orphaned engine running because its identity could not be proven: {0}", engineHygiene.refused.join("; ")), "warn");
  }

  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    // A fact about the installed extension, not any project — the check still runs with no
    // folder open; there's just no workspace to append an incident note to (notify() still fires).
    void checkTachyonBuildProvenance(context);
    return;
  }

  // Fail closed without tmux (or on native Windows) — actionable message, no half-spawned state.
  const health = await doctor();
  if (!health.ok) {
    notify(health.message, "error");
    return;
  }

  // t-aaad95 — the per-workspace half. The global half already ran above, before the early return.
  for (const folder of folders) importLegacyWorkspaceSettings(folder.uri.fsPath);

  // t-72ff5a — the project scope now governs seven sidebar tabs, so it is restored BEFORE any surface
  // reads it: the first fleet push must already carry the project this window was left on.
  controlWorkspaceScope.attach(context.workspaceState);
  // spec 237 — the Preact webview sidebar is THE Tachyon view (the native tree was retired). refreshAll
  // pushes the live fleet to it on every state change; it's registered below.
  /**
   * SDD 504 — the window's boot projection: one entry per open folder, plus whether the host has
   * looked yet.
   *
   * It exists because `!fleets.length` was answering two questions with one — "no Tachyon workspace
   * here" and "I have not heard from the engine yet" — and rendering the second as the first for the
   * whole of boot. Everything below is already known to this file; none of it is new information,
   * only newly projected.
   *
   * WHO ELSE CAN REACH THIS? Every door that can boot a folder goes through `addWorkspace`, so the
   * phase transitions live THERE rather than at each caller: the activation loop, `ensureWorkspaceFor`
   * (Init / New Agent / Studio), the folder-membership watcher, and Retry are one code path here.
   * That is deliberate — the alternative is four call sites that must each remember to mark a phase,
   * and the fourth one always arrives after the plan stops being read.
   */
  const bootFolders = new Map<string, SidebarBootFolderVM>();
  let bootDiscovered = false;
  const bootVM = (): SidebarBootVM => ({ discovered: bootDiscovered, folders: [...bootFolders.values()] });
  /** The SAME identity the attached fleet carries (`client.workspaceHash`), so Retry resolves it. */
  const bootHash = (folderPath: string): string => {
    try { return workspaceHash(fs.realpathSync(folderPath)); } catch { return workspaceHash(folderPath); }
  };
  const bootName = (folderPath: string): string =>
    (vscode.workspace.workspaceFolders ?? []).find((f) => f.uri.fsPath === folderPath)?.name ?? path.basename(folderPath);
  const setBootFolder = (folderPath: string, entry: SidebarBootFolderVM): void => {
    bootFolders.set(folderPath, entry);
    sidebarProto.refresh();
  };
  const markBootStarting = (folderPath: string): void => {
    const existing = bootFolders.get(folderPath);
    // An attach already in flight keeps its ORIGINAL `startedAt`. Restamping it here would reset the
    // "taking longer than usual" clock every time anything asked for a refresh, so a genuinely stuck
    // folder could never reach the delayed copy — the plan's "refresh while attach is pending: state
    // remains starting" row, which is about the timer as much as about not attaching twice.
    if (existing?.phase === "starting") return;
    setBootFolder(folderPath, { hash: bootHash(folderPath), name: bootName(folderPath), phase: "starting", startedAt: Date.now() });
  };
  const markBootReady = (folderPath: string): void => {
    setBootFolder(folderPath, { hash: bootHash(folderPath), name: bootName(folderPath), phase: "ready" });
  };
  const markBootFailed = (folderPath: string, error: unknown): void => {
    // Reuses the existing diagnostic recorder, so the full detail lands in Output → Tachyon and the
    // sidebar carries only the one line that fits. No second failure store.
    const { summary } = recordShellFailure("sidebar.startWorkspace", error);
    setBootFolder(folderPath, { hash: bootHash(folderPath), name: bootName(folderPath), phase: "failed", detail: summary });
  };
  /**
   * Enumerate open folders and answer `hasConfig` for each — the whole of discovery, synchronous.
   *
   * This is the plan's finding made real: absence needs no engine and no first sync, so `discovered`
   * is not a spinner. Called once in the activation turn and again on folder membership changes.
   *
   * Folders already in flight keep their phase; only membership is reconciled. Re-running it must
   * never knock a ready folder back to starting, which is what a naive rebuild would do on every
   * add/remove.
   *
   * `shouldActivateFolder` — not bare `hasConfig` — decides "configured", and that difference is on
   * purpose: a Tachyon-managed worktree folder carries a `tachyon.yml` but is deliberately never
   * booted (t-2a73d6). Calling it `starting` would produce exactly the mirrored lie this change
   * exists to avoid — an "iniciando…" that never ends. It reports as unconfigured, which is what the
   * window actually does with it.
   */
  const discoverBootFolders = (): void => {
    const open = new Map((vscode.workspace.workspaceFolders ?? []).map((f) => [f.uri.fsPath, f.name]));
    for (const known of [...bootFolders.keys()]) if (!open.has(known)) bootFolders.delete(known);
    for (const [folderPath, name] of open) {
      const configured = shouldActivateFolder(hasConfig(folderPath), folderPath, currentWorktreesBase());
      const existing = bootFolders.get(folderPath);
      if (existing) {
        // Configuration appearing under a folder that had none is the Agent-writes-tachyon.yml door.
        // It is the one promotion allowed here; a ready folder is left alone because its fleet is
        // real regardless of what a later re-read of the config directory says.
        if (existing.phase === "unconfigured" && configured) {
          bootFolders.set(folderPath, { hash: existing.hash, name, phase: "starting", startedAt: Date.now() });
        } else if (existing.name !== name) {
          bootFolders.set(folderPath, { ...existing, name });
        }
        continue;
      }
      bootFolders.set(folderPath, configured
        ? { hash: bootHash(folderPath), name, phase: "starting", startedAt: Date.now() }
        : { hash: bootHash(folderPath), name, phase: "unconfigured" });
    }
    bootDiscovered = true;
    sidebarProto.refresh();
  };
  /** SDD 504 — `addWorkspace` is defined much later; the sidebar's Retry reaches it through this. */
  let retryStartFromSidebar: ((wsHash: string) => void) | undefined;
  let openPinDocumentFromSidebar: ((wsHash: string, pinId: string) => void) | undefined;
  // t-41117e — continueFleetTask is defined later; wire through a late-bound ref like pin open.
  let continueTaskFromSidebar: ((fromName: string, toName: string, wsHash: string) => Promise<void>) | undefined;
  /**
   * 514 — the installed apps of this window, kept as the sidebar's answer between pushes.
   *
   * A cache and not a live read because the sidebar pushes synchronously and the catalog comes from
   * the engine over a promise. It is refreshed by the events that can change it — an install, a
   * workspace attaching — and never on a timer: a stale tile is corrected by the next refresh, and
   * the panel that opens an app resolves the app AGAIN from the engine, so a tile the disk no longer
   * backs cannot open anything stale.
   */
  let installedAppTiles: { id: string; title: string; iconPath: string }[] = [];
  // 514 — one Bridge client per workspace, made on the first call an app makes and dropped when it
  // fails; and one editor tab per installed app, revealed rather than duplicated.
  const userAppBridge = new UserAppBridgeCaller();
  const userAppPanels = new UserAppPanels(async (target, tool, args) => {
    const ws = (controlWorkspaceScope.current ? byHash(controlWorkspaceScope.current) : undefined) ?? workspaces()[0];
    if (!ws) return { ok: false, error: "no Tachyon workspace is attached in this window" };
    let token: string | undefined;
    try {
      const payload = jsonObject(await extensionQuery(ws, { action: "bridge.token" }), "bridge.token");
      token = typeof payload.token === "string" ? payload.token : undefined;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    return userAppBridge.call(`${ws.wsHash}:${target.id}`, { bridgeUrl: ws.bridgeUrl, token }, tool, args);
  });
  context.subscriptions.push({ dispose: () => { userAppPanels.dispose(); userAppBridge.dispose(); } });
  const sidebarProto = new SidebarPrototypeProvider(
    context.extensionUri,
    () => workspaces().map((ws) => ws.sidebar),
    context.globalState,
    (context.extension.packageJSON as { version?: string }).version,
    (wsHash, pinId) => openPinDocumentFromSidebar?.(wsHash, pinId),
    (fromName, toName, wsHash) => {
      if (!continueTaskFromSidebar) return Promise.reject(new Error("continue task is not ready"));
      return continueTaskFromSidebar(fromName, toName, wsHash);
    },
    bootVM,
    (wsHash) => retryStartFromSidebar?.(wsHash),
    () => installedAppTiles,
  );
  context.subscriptions.push(sidebarProto);
  // Runtime Ops lives in Control → Runtime only (bottom-panel webview contribution removed).
  // t-610705 (SDD 410 Phase C.2) — the standalone Activity panel was retired: it's a Control
  // subroute now (fleet/agent/<name>/activity; packages/webview-ui/src/webview/activity/App.tsx stays, lazy-imported by
  // cockpit/App.tsx; the watcher moved to src/webview/activity/activityFeed.ts).
  // t-610705 (SDD 410 Phase C.3) — the standalone Project Handoff panel was retired: it's a Control
  // section now (packages/webview-ui/src/webview/handoff/App.tsx stays, lazy-imported by cockpit/App.tsx).
  // spec 250 → SDD 485 D2 — the editor-area Plugins app (browse/install/update/remove), a standalone
  // `dashboard`: ONE editor tab per project, revealed rather than duplicated. Per-project is the whole of
  // its cardinality and it is a fact about the domain rather than a policy — the lockfile, the runtime
  // detection and every apply are rooted at one `workspaceRoot`.
  const pluginsPanels = new PluginsPanelManager(
    context.extensionUri,
    // t-b1940c — the Plugins panel's remove flow needs the revoke door beside gitExec, so it gets
    // the plugin-profile target rather than the bare git one.
    () => workspaces().map((ws) => ws.pluginProfile),
    undefined,
    undefined,
    controlWorkspaceScope,
  );
  context.subscriptions.push({ dispose: () => pluginsPanels.dispose() });
  const handoffPanels = new HandoffPanelManager(
    context.extensionUri,
    { getWorkspaces: () => workspaces().map((ws) => ws.handoff) },
    undefined,
    controlWorkspaceScope,
  );
  context.subscriptions.push({ dispose: () => handoffPanels.dispose() });
  const openHandoffTab = (hash?: string): boolean => {
    const ws = (hash ? byHash(hash) : undefined)
      ?? (controlWorkspaceScope.current ? byHash(controlWorkspaceScope.current) : undefined)
      ?? workspaces()[0];
    if (!ws) {
      notify(vscode.l10n.t("No Tachyon workspace is attached in this window, so there is no project handoff to open."), "warn");
      return false;
    }
    handoffPanels.open(ws.wsHash);
    return true;
  };
  /**
   * Open (or reveal) Plugins for a project — the same shape as `openBoard` below, and for the same reason:
   * a dashboard is opened AGAINST a project, so an ambient caller resolves one ONCE, here, rather than
   * handing the panel a scope it would later observe changing.
   */
  /**
   * 514 — the app catalog, read from the engine and handed to the sidebar.
   *
   * Failure is silence on purpose: an engine that is still starting, or a workspace with no
   * `.tachyon/apps`, both mean "no tiles", and neither is a condition to interrupt the human about.
   * The warnings a broken `app.json` produces are the app's problem and belong on the Apps screen,
   * not in a window notification the human did not ask for.
   */
  const refreshInstalledApps = async (): Promise<void> => {
    const ws = (controlWorkspaceScope.current ? byHash(controlWorkspaceScope.current) : undefined) ?? workspaces()[0];
    if (!ws) {
      installedAppTiles = [];
      sidebarProto.refresh();
      return;
    }
    try {
      const payload = jsonObject(await extensionQuery(ws, { action: "apps.list" }), "apps.list");
      installedAppTiles = jsonArray(payload.apps, "apps.list").map((entry) => {
        const row = jsonObject(entry, "apps.list row");
        const root = String(row.root ?? "");
        return {
          id: String(row.id ?? ""),
          title: String(row.title ?? ""),
          iconPath: path.join(root, String(row.icon ?? "")),
        };
      }).filter((tile) => tile.id.length > 0);
    } catch {
      installedAppTiles = [];
    }
    sidebarProto.refresh();
  };
  /**
   * 514 — open an installed app's tab, resolving it from the engine rather than from the tile.
   *
   * The tile is a cached projection; the disk is the catalog. Resolving here means a tile whose app
   * was removed or renamed says so instead of opening a panel over a directory that is gone.
   */
  const openUserApp = async (appId: string): Promise<void> => {
    const ws = (controlWorkspaceScope.current ? byHash(controlWorkspaceScope.current) : undefined) ?? workspaces()[0];
    if (!ws) {
      notify(vscode.l10n.t("No Tachyon workspace is attached in this window."), "warn");
      return;
    }
    let target: { id: string; title: string; root: string; entry: string } | undefined;
    try {
      const payload = jsonObject(await extensionQuery(ws, { action: "apps.list" }), "apps.list");
      for (const entry of jsonArray(payload.apps, "apps.list")) {
        const row = jsonObject(entry, "apps.list row");
        if (String(row.id ?? "") !== appId) continue;
        target = { id: appId, title: String(row.title ?? appId), root: String(row.root ?? ""), entry: String(row.entry ?? "") };
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), "error");
      return;
    }
    if (!target || !target.root) {
      notify(vscode.l10n.t("App '{0}' is not installed in this workspace.", appId), "warn");
      void refreshInstalledApps();
      return;
    }
    userAppPanels.open(target);
  };
  const openPluginsTab = (hash?: string): void => {
    const ws = (hash ? byHash(hash) : undefined) ?? (controlWorkspaceScope.current ? byHash(controlWorkspaceScope.current) : undefined) ?? workspaces()[0];
    if (!ws) {
      notify(vscode.l10n.t("No Tachyon workspace is attached in this window, so there are no plugins to manage."), "warn");
      return;
    }
    pluginsPanels.open(ws.wsHash);
  };
  // t-610705 (SDD 410 Phase C.2) — the standalone Probes inspector was retired: it's a Control
  // subroute now (fleet/agent/<name>/probes; packages/webview-ui/src/webview/probes/App.tsx stays, lazy-imported by
  // cockpit/App.tsx).
  // spec 335 — the Task board + Task Detail are both Control subroutes now (Board since t-610705
  // Phase B #6; Task Detail since Phase C.1 — standalone TaskDetailPanelManager retired).
  // dogfood round 1 (#1) — the ONE fan-out path for any task mutation: an MCP tool call (onViewsChanged("tasks")
  // below) and an engine-side panel mutation (board drag/edit, detail edit) must reach the same three targets,
  // so a board-side edit is never invisible to an open Detail tab (and vice versa).
  const onTasksChanged = () => {
    boardPanels.refresh(); // SDD 485 C5 — every open Board panel, gated: hidden ones journal and do nothing
    taskDetailPanels.refresh(); // SDD 485 C4 — EVERY open task-detail document, each re-reading its own task
    sidebarProto.refresh();
  };
  // t-0bf709 — the timer only sees that a tick was late. Classification (ELU +
  // cpuUsage + run_delay + Date.now vs hrtime) decides the message; a clock jump
  // is silent. The log line goes to Output → Tachyon, which does not reveal itself.
  let lastBridgeLagNoticeAt = 0;
  let bridgeLagExpectedAt = Date.now() + HOST_LAG_INTERVAL_MS;
  let prevHostLagHr = process.hrtime.bigint();
  let prevHostLagElu = performance.eventLoopUtilization();
  let prevHostLagCpu = process.cpuUsage();
  let prevHostLagRunDelay = readLinuxRunDelayMs();
  startHostSyncIoProbe();
  takeHostSyncIoHit();
  const bridgeLagTimer = setInterval(() => {
    const now = Date.now();
    const hr = process.hrtime.bigint();
    const currentElu = performance.eventLoopUtilization();
    const elu = performance.eventLoopUtilization(currentElu, prevHostLagElu);
    const cpu = process.cpuUsage(prevHostLagCpu);
    const runDelay = readLinuxRunDelayMs();
    const sample = classifyHostLag({
      wallLagMs: now - bridgeLagExpectedAt,
      hrLagMs: Number(hr - prevHostLagHr) / 1e6 - HOST_LAG_INTERVAL_MS,
      eluActiveMs: elu.active,
      eluIdleMs: elu.idle,
      cpuMs: (cpu.user + cpu.system) / 1000,
      loadavg1: os.loadavg()[0] ?? 0,
      cpuCount: os.cpus().length || 1,
      runDelayMs: runDelay !== undefined && prevHostLagRunDelay !== undefined
        ? Math.max(0, runDelay - prevHostLagRunDelay)
        : undefined,
    });
    bridgeLagExpectedAt = now + HOST_LAG_INTERVAL_MS;
    prevHostLagHr = hr;
    prevHostLagElu = currentElu;
    prevHostLagCpu = process.cpuUsage();
    prevHostLagRunDelay = runDelay;
    if (shouldNotifyHostLag(sample) && now - lastBridgeLagNoticeAt > 60_000) {
      lastBridgeLagNoticeAt = now;
      recordShellNote("host-event-loop-lag", formatHostLagLog(sample, takeHostSyncIoHit()));
      notify(localizeHostLagNotice(vscode.l10n, sample.cause, sample.wallLagMs), "warn");
    } else {
      takeHostSyncIoHit();
    }
  }, HOST_LAG_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(bridgeLagTimer) });

  // Any engine/Bridge-driven state change re-pushes the whole fleet to the webview.
  const onViewsChanged = (view: ViewKind) => {
    if (view === "handoff") handoffPanels.refresh();
    if (view === "probes") probesPanels.refresh();
    if (view === "tasks") onTasksChanged(); // spec 335 — same fan-out path engine-side mutations use directly
    // t-610705 (Phase D, D1a) — Runbook/Schedule's refreshReferenceData() retired with their panel
    // managers; the Control-route equivalent did not need a per-studio "which kind changed" gate.
    // t-337cdf — that Control-route host (studioHost.ts) is now deleted along with the renderer it
    // served, so the equivalent it described no longer exists; only the standalone panels below run.
    if (view === "commands" || view === "agents") {
      for (const manager of Object.values(studioPanels)) manager.refreshReferenceData();
    }
    if (view === "agents") void applyWorktreeFolderReveal(); // spec 210/263 — onSpawned/onStopping/onKilled fire this
    // t-505f13 (owner validation, devhost) — the roster changed: the Onboarding tab's step 3 counts
    // roster members, so a VISIBLE panel re-sends the model now and a HIDDEN one journals the refresh
    // and rebuilds on reveal (SectionPanelManager's gate). Without this line the step never closed
    // after the first agent was created — the method existed and nothing called it.
    if (view === "agents") onboardingPanels.refresh();
    sidebarProto.refresh();
  };
  const refreshAll = () => {
    void applyWorktreeFolderReveal(); // spec 210/263 — the worktree-remove commands only re-render through here
    // 514 — the app catalog rides the same fan-out as everything else the sidebar paints, so a
    // workspace that just attached brings its tiles with it instead of on the next install.
    void refreshInstalledApps();
    sidebarProto.refresh();
    for (const manager of Object.values(studioPanels)) manager.refreshReferenceData();
  };
  // SDD 485 C4 — Task Detail is a standalone `document` app again: one editor tab per (project, task),
  // so two task details stand side by side and neither is retargeted by a later scope change. Control
  // asks it to open a tab (`deps.taskDetail.openDocument`) and never renders one itself.
  const taskDetailPanels = new TaskDetailPanelManager(
    context.extensionUri,
    () => workspaces().map((ws) => ws.taskDetail),
    {
      onTasksChanged: () => onTasksChanged(),
      // Task Studio is still a Control route (SDD 485 Phase D owns it), so "Open in Studio" from a task's
      // own tab lands in Control — the same door the Board's card menu already uses.
      openTaskStudio: (ws, taskId) => {
        taskDetailPanels.openEdit(ws.wsHash, taskId);
      },
    },
    undefined,
    controlWorkspaceScope,
    () => workspaces().map((ws) => ws.taskStudio),
  );
  context.subscriptions.push({ dispose: () => taskDetailPanels.dispose() });
  const pinDetailPanels = new PinDetailPanelManager(
    context.extensionUri,
    () => workspaces().map((ws) => ws.sidebar),
    () => workspaces().map((ws) => ws.pinStudio),
    () => { pinDetailPanels.refresh(); sidebarProto.refresh(); },
    undefined,
    controlWorkspaceScope,
  );
  openPinDocumentFromSidebar = (wsHash, pinId) => pinDetailPanels.open(wsHash, pinId);
  context.subscriptions.push({ dispose: () => pinDetailPanels.dispose() });
  const studioPanels = {
    terminal: new TerminalStudioPanelManager(context.extensionUri, workspaces, refreshAll, controlWorkspaceScope),
    schedule: new ScheduleStudioPanelManager(context.extensionUri, workspaces, refreshAll, controlWorkspaceScope),
    agent: new AgentStudioPanelManager(context.extensionUri, workspaces, refreshAll, controlWorkspaceScope),
  } as const;
  for (const manager of Object.values(studioPanels)) context.subscriptions.push({ dispose: () => manager.dispose() });
  // SDD 485 C5 — the Board is a standalone `dashboard` app: ONE editor tab per project, revealed rather
  // than duplicated, so it can be read beside an agent terminal. `openTask` hands the card's own workspace
  // to the task-detail app above — the Board never learns where a task detail lives, which is what let C4
  // and C5 land in either order.
  const boardPanels = new BoardPanelManager(context.extensionUri, {
    getWorkspaces: () => workspaces().map((ws) => ws.board),
    openTask: (ws, taskId) => taskDetailPanels.open(ws.wsHash, taskId),
    openTaskStudio: (ws, id) => {
      // t-3c8f2a — the Board's "+ Task" (no id) is a CREATE: the document opens against a pre-minted
      // id nothing has written, so Cancel must close the tab rather than fall back to reading a task
      // that never existed. An id means an existing task, and that stays an edit.
      if (id) taskDetailPanels.openEdit(ws.wsHash, id);
      else taskDetailPanels.openCreate(ws.wsHash, mintTaskId());
    },
    // Deliberately a call THROUGH the shared fan-out rather than a direct self-refresh: a board edit must
    // reach every open Task Detail and the sidebar too, which is the whole reason that function exists.
    onTasksChanged: () => onTasksChanged(),
  }, undefined, controlWorkspaceScope);
  context.subscriptions.push({ dispose: () => boardPanels.dispose() });
  reviewPanels = new ReviewPanelManager(context.extensionUri, reviewPanelHost());
  context.subscriptions.push({ dispose: () => reviewPanels.dispose() });
  /**
   * Open (or reveal) the Board for a project. `hash` is the caller's preference; with none, the first
   * attached workspace answers — the same fallback Control's own scope resolution uses, and the point at
   * which C6's sidebar project selector will become the authority.
   */
  const openBoard = (hash?: string): void => {
    const ws = (hash ? byHash(hash) : undefined) ?? (controlWorkspaceScope.current ? byHash(controlWorkspaceScope.current) : undefined) ?? workspaces()[0];
    if (!ws) {
      notify(vscode.l10n.t("No Tachyon workspace is attached in this window, so there is no Board to open."), "warn");
      return;
    }
    boardPanels.open(ws.wsHash);
  };

  // t-feaaea — one exclusive tmux client per session. Both viewports attach with `-d`, so without
  // an arbiter the second one evicts the first mid-redraw: dot fill, then `attach ended`.
  const sessionViewports = new SessionViewportRegistry();
  const makeServerInspectorDeps = (): InspectorDeps => {
    const folderByHash = () => new Map(workspaces().map((ws) => [ws.wsHash, ws.folderName]));
    const tmuxWorkspace = (): WorkspaceShellHandle => {
      const workspace = workspaces()[0];
      if (!workspace) throw new Error("no Tachyon workspace is active");
      return workspace;
    };
    let displayedRows = new Map<string, PaneSnapshot>();
    const snapshot = async (): Promise<PaneSnapshot[]> => {
      const rows = tmuxPaneSnapshots(await extensionQuery(tmuxWorkspace(), { action: "tmux.snapshot" }));
      displayedRows = new Map(rows.map((row) => [row.session, row]));
      return rows;
    };
    const prevCpu = new Map<number, { ticks: number; at: number }>();
    const cpuBusy = (rows: { pid: number; dead: boolean; session: string }[]) => {
      const now = Date.now();
      const out = new Map<string, boolean>();
      const seen = new Set<number>();
      for (const r of rows) {
        if (r.dead || r.pid <= 0) continue;
        const ticks = subtreeCpuTicks(r.pid);
        if (ticks === null) continue;
        seen.add(r.pid);
        const prev = prevCpu.get(r.pid);
        prevCpu.set(r.pid, { ticks, at: now });
        if (!prev) continue;
        const dt = (now - prev.at) / 1000;
        if (dt <= 0) continue;
        const rate = (ticks - prev.ticks) / dt;
        out.set(r.session, rate > 3);
      }
      for (const pid of [...prevCpu.keys()]) if (!seen.has(pid)) prevCpu.delete(pid);
      return out;
    };
    const termBySession = new Map<string, vscode.Terminal>();
    const openSession = (session: string) => {
      const existing = termBySession.get(session);
      if (existing) {
        existing.show(false);
        return;
      }
      // Inspector is a third door onto the same sessions — it claims like any other viewport, or a
      // human debugging a session silently evicts that agent's pane (t-feaaea).
      sessionViewports.claim(session, "terminal", () => {
        termBySession.get(session)?.dispose();
        termBySession.delete(session);
      });
      const terminal = vscode.window.createTerminal({
        name: session,
        iconPath: new vscode.ThemeIcon("zap"),
        location: { viewColumn: vscode.ViewColumn.Active, preserveFocus: true },
        shellPath: "tmux",
        shellArgs: ["-L", SOCKET_NAME, "attach-session", "-d", "-t", `=${session}`],
        isTransient: true,
      });
      termBySession.set(session, terminal);
      terminal.show(true);
    };
    context.subscriptions.push(
      vscode.window.onDidCloseTerminal((t) => {
        for (const [s, term] of termBySession) {
          if (term !== t) continue;
          termBySession.delete(s);
          sessionViewports.release(s, "terminal");
        }
      }),
    );
    const killExpected = async (row: PaneSnapshot): Promise<void> => {
      await extensionInvoke(tmuxWorkspace(), { action: "tmux.kill", expected: tmuxPaneIdentity(row) });
    };
    const reap = async (label: string, targets: PaneSnapshot[]) => {
      if (targets.length === 0) return 0;
      const ok = await showNotification(
        vscode.l10n.t("Kill {0} {1} session(s)? This cannot be undone.", targets.length, label),
        "warn",
        [vscode.l10n.t("Kill")],
        { modal: true },
      );
      if (!ok) return 0;
      let killed = 0;
      for (const row of targets) {
        try {
          await killExpected(row);
          killed++;
        } catch {
          /* gone or replaced after confirmation: engine refuses the stale receipt */
        }
      }
      return killed;
    };
    return {
      snapshot,
      serverHealth: async () => tmuxHealthSnapshot(await extensionQuery(tmuxWorkspace(), { action: "tmux.health" })),
      folderByHash,
      cpuBusy,
      capture: async (session) => {
        const result = jsonObject(
          await extensionQuery(tmuxWorkspace(), { action: "tmux.capture", session }),
          "tmux.capture",
        );
        if (result.session !== session || typeof result.text !== "string") {
          throw new Error("tmux.capture returned an invalid result");
        }
        return result.text;
      },
      open: openSession,
      kill: async (session) => {
        const expected = displayedRows.get(session);
        if (!expected) throw new Error(`tmux session '${session}' is no longer in the displayed snapshot`);
        await killExpected(expected);
      },
      reapDead: async () => {
        const rows = await snapshot();
        return reap(vscode.l10n.t("dead"), rows.filter((row) => row.dead));
      },
      reapOrphans: async () => {
        const rows = await snapshot();
        const open = folderByHash();
        const targets = rows.filter((row) => {
          const h = classifySession(row.session).wsHash;
          return h !== undefined && !open.has(h);
        });
        return reap(vscode.l10n.t("orphaned"), targets);
      },
    };
  };

  /**
   * SDD 485 D1 — the tmux Server Inspector is a standalone `window` app: ONE editor tab for the whole
   * window, because the socket it reads is shared by every workspace in it and its own screen already
   * filters by workspace with an "all" option. The deps are built ONCE here rather than per open, because
   * `makeServerInspectorDeps` closes over live state the panel must not lose between opens: the terminal
   * registry `open()` reuses (`termBySession`), the per-pid CPU-tick baselines `cpuBusy` differences
   * against, and the `displayedRows` receipt `kill` refuses a stale identity with.
   *
   * t-6b5dea — it also READS the window scope, to open on the project the sidebar has selected. Reading
   * only: the sidebar remains the one writer of that scope, and this screen's own Workspace filter still
   * reaches the closed-folder and other-window sessions no attached-project selector can name.
   */
  const tmuxPanels = new TmuxPanelManager(context.extensionUri, makeServerInspectorDeps(), controlWorkspaceScope);
  context.subscriptions.push({ dispose: () => tmuxPanels.dispose() });

  /**
   * SDD 485 D3 — Runtime Ops is a standalone `window` app: ONE editor tab for the whole window, because
   * the inventory it shows is not per-project. `buildSnapshot` takes no workspace and merges every
   * attached one (`runtimeOpsFleetView`); the provider quota it renders is account-wide. Note the deps
   * below are the SAME three `makeCockpitDeps` used to pass as `runtimeOps` — the domain did not change,
   * only who owns the panel. Built once here, like tmux's, though for a weaker reason: these three close
   * over `workspaces()` and `byHash`, which are stable for the window's life.
   */
  const runtimeOpsPanels = new RuntimeOpsPanelManager(context.extensionUri, {
    buildSnapshot: () => runtimeOpsFleetView(workspaces().map((ws) => ws.runtimeOps)),
    configureProviderObservation: async (provider, enabled) => {
      await Promise.all(
        workspaces().map((ws) =>
          extensionInvoke(ws, {
            action: "runtime-ops.provider.configure",
            provider,
            enabled,
          }),
        ),
      );
    },
    // t-283149 — the panel's agent rows carry `workspaceKey`, which IS the wsHash the snapshot was
    // built from (runtimeOps/snapshotService.ts), so the row addresses its own workspace directly
    // rather than this fanning out and guessing which reply belongs to the row. It is also the reason
    // this app cannot be a `dashboard`: the row's workspace and the panel's would be two different
    // answers, and only the row's is right.
    inspectAgentSession: async (workspaceKey, agent) => {
      const ws = byHash(workspaceKey);
      if (!ws) throw new Error(`Workspace '${workspaceKey}' is no longer open.`);
      return jsonObject(
        await extensionQuery(ws, { action: "agent.session-inspection", agent }),
        "agent.session-inspection",
      ) as unknown as InspectedSession;
    },
  });
  context.subscriptions.push({ dispose: () => runtimeOpsPanels.dispose() });

  /*
   * SDD 485 D4 — the two Saved Agent commit doors, lifted out of `makeCockpitDeps` because Control is no
   * longer their caller: the Human Inbox is the surface an approval is redeemed on, and it left. Both are
   * unchanged inside — same canonical transactions, same ports, same receipts — and they are consts here
   * rather than inline in the manager's deps so their reasoning stays readable at this width.
   */
  /**
   * SDD 482 phase 4C — commit an approved Saved Agent proposal.
   *
   * NO PROTOCOL BUMP WAS NEEDED, and finding that out changed the design. `commitAgentProfileStudio`
   * with no `expectedRevision` already IS the canonical create, and it already crosses the
   * engine/shell seam as `agent-profile.studio-commit`; `set-subagents` crosses it too. So this door
   * opens on paths a human already uses, rather than on a new operation — which also means the
   * canonical validator, not this code, is what refuses capability references at creation.
   *
   * TWO transactions, because the lifecycle transaction is per-agent and the second one edits the
   * PROPOSER's profile. That window is real and is why the receipt has an `owning` state: a crash
   * between them leaves an existing, unowned agent, and re-approving finishes it.
   */
  const commitSavedAgentProposal = async ({ workspaceRoot, proposalId, approvedDigest }: { workspaceRoot: string; proposalId: string; approvedDigest: string }): Promise<SavedAgentCommitResult> => {
    const ws = workspaces().find((candidate) => candidate.workspaceRoot === workspaceRoot);
    if (!ws) return { ok: false, code: "commit_failed", reason: "no Tachyon workspace for this folder" };
    return approveSavedAgentProposal({
      workspaceRoot,
      proposalId,
      approvedDigest,
      approvedBy: "human",
      nowMs: Date.now(),
      ports: {
        createSavedAgent: async ({ agentName, spec, owner, grants }) => {
          // ONE canonical transaction for both subjects — the new agent's profile/authority/roster
          // and the proposer's ownership edge. Ratified 2026-07-29 after an audit rejected the
          // two-transaction version: ownership is parent-side, so committing separately left a
          // window where the agent existed unowned.
          // t-ca9086 (create writes enabled, autostart never) and t-4071e4 (isolation the proposal
          // asked for) both live in `savedAgentCreateMutation`, which is unit-tested. This closure
          // stays wiring only — the previous inline literal is what let the isolation bug hide.
          return ws.createSavedAgent(savedAgentCreateMutation(agentName, spec), {
            ...(owner ? { owner } : {}),
            ...(grants ? { grants: { proposeSavedAgent: true } } : {}),
          });
        },
        // Re-read at commit time, which is what makes a revoked capability effective on a proposal
        // queued before the revocation.
        // t-5498a6 — the SAME door the Studio uses. Reaching the shared function here is what keeps
        // the two approval surfaces from drifting into different rules about pinning and refusals.
        authorizeSkill: async ({ agentName, skillName }) => {
          const result = await ws.authorizeAgentSkill(agentName, skillName);
          return result.ok ? { ok: true } : { ok: false, error: result.error };
        },
        readProposerGrants: (agentName) => readAgentProfileGrants(workspaceRoot, agentName),
        currentConfigSha256: () => workspaceConfigSha256(workspaceRoot),
        deliverNotice: (agent, line) => ws.deliverNotice(agent, line),
      },
    });
  };
  /**
   * t-afe120 — host-only commit for Saved Agent removal. Reaches the SAME studio-lifecycle forget
   * door Agent Studio uses (cascade: stop → governed worktree → profile+authority+roster).
   */
  const commitSavedAgentRemoval = async ({ workspaceRoot, proposalId, approvedDigest }: { workspaceRoot: string; proposalId: string; approvedDigest: string }): Promise<SavedAgentRemovalCommitResult> => {
    const ws = workspaces().find((candidate) => candidate.workspaceRoot === workspaceRoot);
    if (!ws) return { ok: false, code: "commit_failed", reason: "no Tachyon workspace for this folder" };
    return approveSavedAgentRemovalProposal({
      workspaceRoot,
      proposalId,
      approvedDigest,
      approvedBy: "human",
      nowMs: Date.now(),
      ports: {
        forgetSavedAgent: async ({ agentName, expectedRevision }) => {
          const result = await ws.commitAgentProfileStudioLifecycle({
            schemaVersion: 1,
            operation: "forget",
            agentName,
            expectedRevision,
            confirmation: agentName,
          });
          if (result.kind === "refused") {
            throw new Error(`${result.code}: ${result.message}`);
          }
          if (result.kind !== "forgotten") {
            throw new Error(`unexpected lifecycle result '${result.kind}' for Saved Agent removal`);
          }
          // The cascade does not surface a separate txid on the forgotten receipt; the agentId is the
          // durable identity that was retired. Bind revision to the approved one for the receipt.
          return { txid: result.agentId, revision: expectedRevision };
        },
        readTargetIdentity: async (agentName) => {
          try {
            const snapshot = await ws.inspectAgentProfileStudio(agentName);
            return { agentId: snapshot.agentId, revision: snapshot.revision };
          } catch {
            return undefined;
          }
        },
        readProposerGrants: (agentName) => readAgentProfileGrants(workspaceRoot, agentName),
        currentConfigSha256: () => workspaceConfigSha256(workspaceRoot),
        deliverNotice: (agent, line) => ws.deliverNotice(agent, line),
      },
    });
  };

  /**
   * t-e76acc → SDD 485 D4 — the Human Inbox app: one editor tab PER PROJECT for everything waiting on a
   * human, which can now sit beside the agent terminal that is blocked on the approval it shows.
   *
   * `dashboard`, and the fact is in the domain rather than in a policy: every read below is rooted at one
   * `workspaceRoot` — the pending approval queue, that workspace's validations, both Saved Agent proposal
   * queues, and the digest they are checked against. Two attached projects have two genuinely different
   * queues, which is the exact inverse of the `runtimeOpsPanels` above (one merged snapshot, no project
   * anywhere in its signature). Two adjacent Phase D migrations, opposite cardinalities, and the
   * difference is visible in the deps' types rather than in a convention someone has to remember.
   *
   * The commit ports are handed over unchanged: they are what an approval on this surface REDEEMS, and
   * they were only ever reachable from here. Optional, so a window that cannot commit says so on the pane
   * rather than accepting a click and doing nothing.
   */
  const humanInboxPanels = new HumanInboxPanelManager(
    context.extensionUri,
    {
      approvals: {
        getWorkspaces: () => workspaces().map((ws) => ({
          wsHash: ws.wsHash,
          workspaceRoot: ws.workspaceRoot,
          folderName: ws.folderName,
        })),
        resolve: async (wsHash, id, decision) => {
          const ws = byHash(wsHash);
          if (!ws) throw new Error(`workspace ${wsHash} is not attached`);
          await extensionInvoke(ws, { action: "approval.resolve", id, decision });
          notify(`approval request ${id} ${decision}`);
          refreshAll();
          humanInboxPanels.refresh();
        },
      },
      validations: { getWorkspaces: () => workspaces().map((ws) => ws.board) },
      onValidationsChanged: () => {
        boardPanels.refresh();
        humanInboxPanels.refresh();
      },
      // t-e4f662 — the staleness threshold from the SAME loaded config the rest of the workspace's
      // project-owned settings come from. Per wsHash: two roots may legitimately answer differently.
      humanInboxStaleAfter: (wsHash: string) => byHash(wsHash)?.config?.settings?.humanInbox?.staleAfterHours,
      approveSavedAgentProposal: (input) => commitSavedAgentProposal(input),
      approveSavedAgentRemoval: (input) => commitSavedAgentRemoval(input),
      deliverNotice: async (workspaceRoot, agent, line) => {
        const target = workspaces().find((candidate) => candidate.workspaceRoot === workspaceRoot);
        if (!target) return;
        await target.deliverNotice(agent, line);
      },
      decideScheduleProposal: async (wsHash, id, decision) => {
        const ws = byHash(wsHash);
        if (!ws) throw new Error(`workspace ${wsHash} is not attached`);
        await extensionInvoke(ws, { action: decision === "approve" ? "proposal.approve" : "proposal.reject", id });
        refreshAll();
        humanInboxPanels.refresh();
      },
    },
  );
  context.subscriptions.push({ dispose: () => humanInboxPanels.dispose() });
  /**
   * Open (or reveal) the Inbox for a project — the same shape as `openPluginsTab`, and for the same
   * reason: a dashboard is opened AGAINST a project, so an ambient caller resolves one ONCE, here.
   */
  const openHumanInboxTab = (hash?: string): boolean => {
    const ws = (hash ? byHash(hash) : undefined) ?? (controlWorkspaceScope.current ? byHash(controlWorkspaceScope.current) : undefined) ?? workspaces()[0];
    if (!ws) {
      notify(vscode.l10n.t("No Tachyon workspace is attached in this window, so nothing is waiting on you here."), "warn");
      return false;
    }
    humanInboxPanels.open(ws.wsHash);
    return true;
  };

  /** Cockpit desktop (editor sysadmin; t-fe52f0 frente 1). Sidebar unchanged. */
  const clearEngineLog = async (wsHash: string): Promise<void> => {
    const ws = byHash(wsHash); if (!ws) throw new Error("no Tachyon workspace for that hash");
    await ws.client.clearEngineLog();
  };
  const openEngineJournal = (wsHash: string): void => {
    const ws = byHash(wsHash); if (!ws) throw new Error("no Tachyon workspace for that hash");
    const unit = engineSystemdUnitName(ws.workspaceRoot);
    const term = vscode.window.createTerminal({ name: `Engine log · ${ws.folderName}` });
    term.show(); term.sendText(`journalctl --user -u ${JSON.stringify(unit)} -n 200 -f`, true);
  };

  // SDD 485 D6 — Worktrees owns these ports now. Both require the dashboard's immutable project;
  // there is deliberately no first-workspace fallback, because that would let a stale/malicious row
  // address another project's checkout.
  const removeManagedWorktree = async (id: string, deleteBranch: boolean, wsHash: string, confirmLiveProcesses?: boolean): Promise<string | undefined> => {
    const ws = byHash(wsHash);
    if (!ws) throw new Error(`workspace ${wsHash} is not attached`);
    const result = jsonObject(
      await extensionInvoke(ws, {
        action: "worktree.remove-managed",
        id,
        ...(deleteBranch ? { deleteBranch: true } : {}),
        ...(confirmLiveProcesses ? { confirmLiveProcesses: true } : {}),
      }),
      "worktree.remove-managed",
    );
    return result.removed === true ? undefined : String(result.error ?? "removal refused");
  };
  // SDD 498 (t-7cb971) — the governed land door. Same immutable-project rule as its neighbours, and
  // the same shape: the engine re-measures everything and this side transports the answer.
  //
  // Unlike them it returns the whole OUTCOME rather than a refusal string, because a land has three
  // things a toast cannot carry: whether it happened, where the trunk moved from and to (the undo
  // target), and — when it did not happen — the exit to take. Narrowed field by field here so an
  // engine that answers something unexpected renders as a refusal instead of leaking a shape.
  const landManagedWorktree = async (id: string, wsHash: string): Promise<WorktreeLandResult> => {
    const ws = byHash(wsHash);
    if (!ws) throw new Error(`workspace ${wsHash} is not attached`);
    const result = jsonObject(await extensionInvoke(ws, { action: "worktree.land", id }), "worktree.land");
    const landed = jsonObject(result.landed ?? {}, "worktree.land.landed");
    const ok = result.ok === true
      && typeof landed.trunkRef === "string"
      && typeof landed.primaryPath === "string"
      && typeof landed.before === "string"
      && typeof landed.after === "string";
    return {
      id,
      ok,
      ...(ok
        ? {
          landed: {
            trunkRef: String(landed.trunkRef),
            primaryPath: String(landed.primaryPath),
            before: String(landed.before),
            after: String(landed.after),
          },
        }
        : {}),
      ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
      ...(typeof result.fix === "string" ? { fix: result.fix } : {}),
    };
  };
  // t-d29398 — the human door for a checkout an interrupted launch left quarantined. Same immutable
  // project rule as its two neighbours; the engine re-proves authority and occupancy per call.
  const releaseManagedWorktreeLock = async (id: string, wsHash: string): Promise<string | undefined> => {
    const ws = byHash(wsHash);
    if (!ws) throw new Error(`workspace ${wsHash} is not attached`);
    const result = jsonObject(
      await extensionInvoke(ws, { action: "worktree.release-lock", id }),
      "worktree.release-lock",
    );
    return result.released === true ? undefined : String(result.error ?? "release refused");
  };
  const forgetManagedWorktreeRecord = async (id: string, wsHash: string): Promise<string | undefined> => {
    const ws = byHash(wsHash);
    if (!ws) throw new Error(`workspace ${wsHash} is not attached`);
    const result = jsonObject(
      await extensionInvoke(ws, { action: "worktree.forget-record", id }),
      "worktree.forget-record",
    );
    return result.forgotten === true ? undefined : `record not found or refused: ${id}`;
  };
  // SDD 485 D7 / t-41117e — Continue picker is webview-local; this remains the authoritative host action.
  // t-5f2b5b — the Fleet app is gone, so the sidebar Agents roster is its only caller now.
  const continueFleetTask = async (fromName: string, toName: string, wsHash: string): Promise<void> => {
    const ws = byHash(wsHash);
    if (!ws) throw new Error("no Tachyon workspace for that hash");
    if (!toName || toName === fromName) throw new Error("Continue task requires a different destination agent");
    const listed = await extensionQuery(ws, { action: "agents.list" });
    type AgentRow = { name?: string; running?: boolean; kind?: string; lifetime?: "saved" | "temporary" };
    const dest = (Array.isArray(listed) ? listed : []).map((row) => row as AgentRow).find((row) => row.name === toName);
    if (!dest || typeof dest.name !== "string") throw new Error(`destination agent '${toName}' not found`);
    if (dest.kind === "terminal") throw new Error(`destination '${toName}' is a terminal agent — pick a declared runtime agent`);
    if (dest.lifetime !== "saved") throw new Error(`destination '${toName}' is a Temporary Agent (it has no .tachyon/agents/<name>/agent.yml)`);
    if (dest.running) throw new Error(`destination '${toName}' is running — stop it first`);
    const result = jsonObject(await extensionInvoke(ws, {
      action: "agent.continue-task", fromAgent: fromName, toAgent: toName, reason: "continued from the Agents roster",
    }), "agent.continue-task");
    if (result.ok !== true) throw new Error(typeof result.message === "string" ? result.message : "continue-task failed");
    const handoff = typeof result.handoffPath === "string" ? result.handoffPath : "";
    void vscode.window.showInformationMessage(handoff
      ? vscode.l10n.t("Continued {0} → {1} ({2})", fromName, toName, handoff)
      : vscode.l10n.t("Continued {0} → {1}", fromName, toName));
  };
  continueTaskFromSidebar = continueFleetTask;
  const runtimeConfigDeps: RuntimeConfigDeps = {
    buildSnapshot: (wsHash) => {
      const ws = byHash(wsHash);
        if (!ws?.config) return undefined;
        const home = devProfileHome ? { homeDir: devProfileHome } : {};
        const pendingAgents = ws.client.presentation.agents.items.filter((agent) => agent.configurationPending).map((agent) => agent.name);
        const common = {
          workspaceRoot: ws.workspaceRoot,
          agents: ws.config.agents,
          pendingAgents,
          ...home,
        };
        try {
          return {
            runtimes: [
              inspectCodexRuntimeConfig(common),
              inspectClaudeRuntimeConfig(common),
              inspectGrokRuntimeConfig({
                ...common,
                grokHome: grokConfigHome({ homeDir: common.homeDir, env: process.env, profileHome: !!common.homeDir }),
              }),
            ],
          };
        } catch (error) {
          console.error("[Tachyon] Runtime Config snapshot failed", error);
          return undefined;
        }
    },
    openSource: async (sourcePath) => {
      await vscode.window.showTextDocument(
        vscode.Uri.file(sourcePath),
        { preview: false, viewColumn: vscode.ViewColumn.Beside },
      );
    },
    saveChanges: async ({ wsHash, runtime, documentId, expectedRevision, changes }) => {
        const ws = byHash(wsHash);
        if (!ws?.config) throw new Error("The selected workspace is unavailable.");
        const home = devProfileHome ? { homeDir: devProfileHome } : {};
        let scope: "global" | "workspace";
        let revision: string;
        if (runtime === "codex") {
          scope = documentId === "codex-global" ? "global" : documentId === "codex-workspace" ? "workspace" : (() => { throw new Error("Unknown Codex Runtime Config document."); })();
          const applied = applyCodexNativeConfigChange({
            workspaceRoot: ws.workspaceRoot,
            ...home,
            scope,
            expectedRevision,
            changes: changes.map((change) => change.kind === "setting"
              ? { kind: "setting" as const, key: change.key as CodexEditableSettingKey, value: change.value as string | boolean | string[] }
                : change),
          });
          revision = applied.revision;
        } else if (runtime === "grok") {
          scope = grokDocumentScope(documentId);
          const applied = applyGrokRuntimeConfigChange({
            workspaceRoot: ws.workspaceRoot,
            grokHome: grokConfigHome({ homeDir: home.homeDir, env: process.env, profileHome: !!home.homeDir }),
            documentId,
            expectedRevision,
            changes,
          });
          revision = applied.revision;
        } else {
          scope = documentId === "claude-global-settings" ? "global" : "workspace";
          const applied = applyClaudeRuntimeConfigChange({
            workspaceRoot: ws.workspaceRoot,
            ...home,
            documentId,
            expectedRevision,
            changes,
          });
          revision = applied.revision;
        }
        if (revision) {
          await ws.extension.invoke({ action: "runtime-config.mark-pending", runtime, scope, revision });
          await ws.client.sync();
        }
    },
  };

  const makeControlModelHost = () => ({
    // t-af3eef — `needs` says which expensive slices this view actually consumes. A slice that is
    // not needed is not queried and its field is ABSENT, so a caller can tell "not collected" from
    // "none exist". Navigation used to pay for every slice regardless of the route.
    collect: async (needs: SectionCollectNeeds = COLLECT_EVERYTHING): Promise<WorkspaceBundle[]> => {
      const bundles: WorkspaceBundle[] = [];
      for (const ws of workspaces()) {
        let identity: WorkspaceBundle["control"]["identity"] = null;
        let identityError: string | undefined;
        try {
          const id = ws.client.identity;
          identity = {
            pid: id.pid,
            instanceId: id.instanceId,
            processStartIdentity: id.processStartIdentity,
            startedAt: id.startedAt,
            bundleId: id.bundleId,
            channel: id.channel,
            engineVersion: id.engineVersion,
            protocol: id.protocol ? { min: id.protocol.min, max: id.protocol.max } : undefined,
            bridge: id.bridge ? { instanceId: id.bridge.instanceId, port: id.bridge.port } : undefined,
          };
        } catch (err) {
          identityError = err instanceof Error ? err.message : String(err);
        }

        let logTail: string[] | undefined;
        let logBySource: { daemon: string[]; events?: string[]; bridge?: string[] } | undefined;
        let logHasError: boolean | undefined;
        try {
          const lh = await ws.client.engineLogHealth();
          if (lh.logTail.length > 0) logTail = lh.logTail;
          logBySource = lh.logBySource;
          if (lh.logHasError) logHasError = true;
        } catch {
          /* best-effort */
        }

        let agentRows: WorkspaceBundle["agents"] = [];
        let agentCounts: { total: number; running: number } | undefined;
        try {
          const items = ws.client.presentation.agents.items;
          agentRows = items.map((a) => ({
            name: a.name,
            kind: a.kind,
            running: !!a.running,
            lifetime: a.lifetime,
            folder: ws.folderName,
            wsHash: ws.wsHash,
          }));
          agentCounts = { total: items.length, running: items.filter((a) => a.running).length };
        } catch {
          /* projection unavailable */
        }

        let tmux: { state: string; version?: string } | undefined;
        try {
          const health = await extensionQuery(ws, { action: "tmux.health" });
          if (health && typeof health === "object") {
            const h = health as { state?: string; tmuxVersion?: string };
            tmux = { state: String(h.state ?? "unknown"), version: h.tmuxVersion };
          }
        } catch {
          tmux = { state: "unknown" };
        }

        let companion: WorkspaceBundle["companion"];
        // t-0ba30f — Integrated Browser is its own query. companion.status failure must not
        // silently swap the gate for a different source; shell config is only the offline/old-engine fallback.
        const ideBrowser = await readIdeBrowserEnabled({
          query: (input) => extensionQuery(ws, input),
          shellEnabled: ws.config?.settings?.ideBrowser?.enabled === true,
        });
        try {
          const st = jsonObject(await extensionQuery(ws, { action: "companion.status" }), "companion.status");
          const devicesRaw = Array.isArray(st.devices) ? st.devices : [];
          const devices = devicesRaw.flatMap((raw) => {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
            const d = raw as { [key: string]: unknown };
            const id = typeof d.id === "string" ? d.id : "";
            if (!id) return [];
            return [
              {
                id,
                kind: typeof d.kind === "string" ? d.kind : "browser",
                name: typeof d.name === "string" ? d.name : "Companion",
                version: typeof d.version === "string" ? d.version : "",
                pairedAt: typeof d.pairedAt === "string" ? d.pairedAt : "",
                expiresAt: typeof d.expiresAt === "string" ? d.expiresAt : undefined,
                live: d.live === true,
              },
            ];
          });
          companion = {
            tabTools: st.tabTools === true,
            allowedHosts: Array.isArray(st.allowedHosts)
              ? st.allowedHosts.filter((h): h is string => typeof h === "string")
              : [],
            paired: st.paired === true || devices.length > 0,
            baseUrl: typeof st.baseUrl === "string" ? st.baseUrl : undefined,
            engineLabel: typeof st.engineLabel === "string" ? st.engineLabel : undefined,
            devices,
          };
        } catch {
          /* engine without companion.status (older) or offline */
        }

        // spec 444 — the classified engine read is the ONE source for the Worktrees tab. Engine
        // unreachable → an EMPTY list plus a note, never unverified raw-disk rows (maintainer-
        // ratified: untrusted data is not better than no data). The raw reader is deleted.
        let worktreeRows: WorkspaceBundle["worktrees"];
        let worktreesUnavailable: string | undefined;
        try {
          if (!needs.worktrees) throw SKIP_SLICE;
          worktreeRows = [];
          const classified = await extensionQuery(ws, { action: "worktrees.classified" });
          const rows = (classified as { worktrees?: unknown[] })?.worktrees;
          if (!Array.isArray(rows)) throw new Error("engine returned no worktrees payload");
          worktreeRows = rows.map((row) => {
            const e = row as Record<string, unknown>;
            const land = landRowFrom(e.land);
            return {
              id: String(e.id ?? ""),
              kind: String(e.kind ?? ""),
              path: String(e.path ?? ""),
              branch: String(e.branch ?? ""),
              status: String(e.status ?? ""),
              slug: e.slug != null ? String(e.slug) : undefined,
              agent: e.agent != null ? String(e.agent) : undefined,
              folder: ws.folderName,
              wsHash: ws.wsHash,
              tachyonCreatedBranch: e.tachyonCreatedBranch === true,
              classification: e.classification as NonNullable<WorkspaceBundle["worktrees"]>[number]["classification"],
              // t-621613 — anything the engine did not state reads as `unknown`, which the tab
              // treats as "somebody lives here". An older engine that never sends it lands there.
              ownerPresence: e.ownerPresence === "absent" || e.ownerPresence === "present" ? e.ownerPresence : "unknown",
              // t-7cb971 — shape-checked, never re-derived. The engine owns the rule that a command is
              // offered only when every precondition passed; re-applying it here would be a second
              // copy of that rule, free to drift from the one that computed the checks. So this asks
              // only "is this the shape I can render", and a payload that is not (an older engine, a
              // truncated response) drops the whole block rather than rendering half of it.
              ...(land ? { land } : {}),
              // t-0ab150 — session-only create progress. Shape-checked: a missing or non-string
              // phase is "we do not have a create row", never a guessed one.
              ...(() => {
                const raw = e.create;
                if (!raw || typeof raw !== "object") return {};
                const phase = (raw as { phase?: unknown }).phase;
                if (typeof phase !== "string" || !phase) return {};
                const error = (raw as { error?: unknown }).error;
                return { create: { phase, ...(typeof error === "string" && error ? { error } : {}) } };
              })(),
            };
          });
        } catch (err) {
          // t-af3eef — a SKIPPED slice is not a FAILED one. Leaving both the rows and the
          // `unavailable` reason absent is the whole point: the view can then say "not collected"
          // instead of either an empty list or an error it never hit.
          if (err !== SKIP_SLICE) worktreesUnavailable = err instanceof Error ? err.message : String(err);
        }

        bundles.push({
          control: {
            folderName: ws.folderName,
            workspaceRoot: ws.workspaceRoot,
            wsHash: ws.wsHash,
            bridgeUrl: ws.bridgeUrl,
            identity,
            identityError,
            logTail,
            logBySource,
            logHasError,
            agents: agentCounts,
            authConfigured: "unknown",
            notes: [],
          },
          agents: agentRows,
          worktrees: worktreeRows,
          ...(worktreesUnavailable ? { worktreesUnavailable } : {}),
          // t-d85857 — Overview counts these, and it must count what the Approvals section shows:
          // same read, one function. The list used to be hardcoded empty here, so the counter said
          // "0 pending" with requests waiting on disk. A read failure is deliberately NOT swallowed
          // into an empty list — Control's own error card is honest, a silent zero is not.
          approvals: pendingApprovalRows(ws.workspaceRoot),
          // t-585d5c — the idle-notification window this folder wrote, read from the SAME loaded
          // config the monitor resolves against, so Settings cannot show a number the engine is not
          // using. Absent stays absent: it means "never configured", not "set to the default".
          ...(ws.config?.settings?.agentNotifications?.idleAfterMinutes === undefined
            ? {}
            : { idleAfterMinutes: ws.config.settings.agentNotifications.idleAfterMinutes }),
          // t-e76acc — Overview's unified "waiting on you" count needs the OTHER half, and it is
          // counted with the very predicate the Inbox list filters on (`validationAwaitsHuman`), so
          // the number and the rows cannot drift the way the approvals counter once did. A read
          // failure leaves the field absent rather than reporting zero: absent means "not collected".
          ...(() => {
            try {
              return { validationsAwaitingHuman: ws.board.listValidations().filter(validationAwaitsHuman).length };
            } catch {
              return {};
            }
          })(),
          tmux,
          ...(companion ? { companion } : {}),
          ...(ideBrowser ? { ideBrowser } : {}),
        });
      }
      return bundles;
    },
    openDoctor: () => {
      void vscode.commands.executeCommand("tachyon.doctor");
    },
    revealPath: (fsPath: string) => {
      void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(fsPath));
    },
    openConfigFile: async (wsHash?: string) => {
      const ws = wsHash ? byHash(wsHash) : workspaces()[0];
      if (!ws) throw new Error("no Tachyon workspace attached");
      const cfg = configPathOf(ws);
      if (!cfg) throw new Error(`no ${WORKSPACE_SETTINGS_FILE} found under ${ws.workspaceRoot}`);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(cfg));
      await vscode.window.showTextDocument(doc, { preview: false });
    },
    // t-585d5c — Control -> Settings writes the idle-notification window through the same governed
    // operation an API client would use, so there is one validated entrance and not a UI-only path.
    setIdleAfterMinutes: async (wsHash: string, minutes?: number | "never") => {
      const ws = byHash(wsHash);
      if (!ws) throw new Error("no Tachyon workspace for that hash");
      await extensionInvoke(ws, {
        action: "config.notifications.idleAfterMinutes",
        ...(minutes === undefined ? {} : { minutes }),
      });
    },
    setCompanionTabTools: async (wsHash: string, enabled: boolean) => {
      const ws = byHash(wsHash);
      if (!ws) throw new Error("no Tachyon workspace for that hash");
      await extensionInvoke(ws, { action: "config.companion.tabTools", enabled });
    },
    setIdeBrowserEnabled: async (wsHash: string, enabled: boolean) => {
      const ws = byHash(wsHash);
      if (!ws) throw new Error("no Tachyon workspace for that hash");
      await extensionInvoke(ws, { action: "config.ideBrowser.enabled", enabled });
    },
    setCompanionAllowedHosts: async (wsHash: string, hosts: string[]) => {
      const ws = byHash(wsHash);
      if (!ws) throw new Error("no Tachyon workspace for that hash");
      await extensionInvoke(ws, { action: "config.companion.allowedHosts", hosts });
    },
    unpairCompanionDevice: async (wsHash: string, deviceId?: string) => {
      const ws = byHash(wsHash);
      if (!ws) throw new Error("no Tachyon workspace for that hash");
      await extensionInvoke(ws, {
        action: "companion.unpair",
        ...(deviceId ? { deviceId } : {}),
      });
    },
    issueCompanionPairCode: async (wsHash: string) => {
      const ws = byHash(wsHash);
      if (!ws) throw new Error("no Tachyon workspace for that hash");
      const result = jsonObject(await extensionQuery(ws, { action: "companion.pair-code" }), "companion.pair-code");
      if (result.ok === false) {
        return { ok: false as const, reason: String(result.reason ?? "bridge_down") };
      }
      const code = typeof result.code === "string" ? result.code : "";
      const baseUrl = typeof result.baseUrl === "string" ? result.baseUrl : "";
      const expiresAt = typeof result.expiresAt === "string" ? result.expiresAt : "";
      if (!code || !baseUrl || !expiresAt) {
        return { ok: false as const, reason: "invalid_pair_response" };
      }
      const baseUrls = Array.isArray(result.baseUrls)
        ? result.baseUrls.filter((u): u is string => typeof u === "string" && u.length > 0)
        : [baseUrl];
      return {
        ok: true as const,
        code,
        baseUrl,
        baseUrls: baseUrls.length > 0 ? baseUrls : [baseUrl],
        expiresAt,
        ...(typeof result.protocolVersion === "number" ? { protocolVersion: result.protocolVersion } : {}),
        ...(typeof result.prefix === "string" ? { prefix: result.prefix } : {}),
        ...(typeof result.qrPayload === "string" ? { qrPayload: result.qrPayload } : {}),
        ...(typeof result.openUrl === "string" ? { openUrl: result.openUrl } : {}),
        ...(typeof result.qrDataUrl === "string" ? { qrDataUrl: result.qrDataUrl } : {}),
      };
    },
  });

  const launcherBundlePath = () => vscode.Uri.joinPath(context.extensionUri, "dist", "tool-launcher.cjs").fsPath;
  const syncWorkspaceToolLauncher = (folderPath: string): void => {
    const r = syncToolLauncher(folderPath, { launcherBundlePath: launcherBundlePath(), updateLockfile: false });
    if (r.errors.length > 0) notify(vscode.l10n.t("Tachyon tool launcher sync failed: {0}", r.errors.join("; ")), "warn");
  };

  /** t-c3b0a5 — bring a stale generated git-hook harness forward to this engine's dispatcher template.
   *  Runs per workspace on attach because that is the one point guaranteed to happen after an engine upgrade;
   *  a fix to the dispatcher otherwise waited for the user to reinstall an unrelated plugin. Fire-and-forget:
   *  a workspace with no managed hooks is a no-op, and a failure here must never block attaching. */
  const reconcileWorkspaceGitHookHarness = (folderPath: string): void => {
    void reconcileGitHookHarness(folderPath)
      .then((r) => {
        if (r.refreshed.length > 0) console.debug(`[tachyon] git-hook harness: ${r.reason}`);
        if (r.ahead.length > 0) {
          notify(
            vscode.l10n.t(
              "Tachyon git hooks were generated by a NEWER Tachyon ({0}). Leaving them as they are — reinstall the plugin to regenerate for this version.",
              r.ahead.join(", "),
            ),
            "warn",
          );
        }
      })
      .catch((error: unknown) => {
        console.debug(`[tachyon] git-hook harness reconcile skipped: ${error instanceof Error ? error.message : String(error)}`);
      });
  };

  const terminalTmux = new TmuxService();
  const terminals = new Terminals(
    (_agent, session) => { void terminalTmux.refreshClients(session); },
    (agent) => workspaces().map((ws) => agentProjection(ws, agent)).find((row) => row)?.kind ?? "agent",
    undefined,
    (agent, session) => {
      const hash = classifySession(session).wsHash;
      const ws = hash ? byHash(hash) : undefined;
      if (!ws) return;
      void extensionInvoke(ws, { action: "terminal.close", agent, session }).catch((error) => {
        console.debug(`[tachyon] terminal close intent unavailable: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
    sessionViewports,
  );
  context.subscriptions.push({ dispose: () => terminals.dispose() });

  // t-610355 — layer-2 first-party agent pane (webview + xterm). Additive; layer-1 integrated terminal stays default.
  const agentPanes = new AgentPanePanelManager(context.extensionUri, sessionViewports);
  context.subscriptions.push({ dispose: () => agentPanes.dispose() });
  const openAgentPane = async (agent: string, hash?: string): Promise<void> => {
    const ws = targetOf(hash);
    const projected = ws ? agentProjection(ws, agent) : undefined;
    if (!ws) {
      notify(vscode.l10n.t("Cannot open agent pane — workspace is not active"), "error");
      return;
    }
    if (!projected) {
      notify(vscode.l10n.t("Cannot open agent pane for '{0}' — agent is not in the live roster", agent), "error");
      return;
    }
    // t-aaad95 — `agentPane.enabled` finally has a reader; the contributed key never had one, so the
    // switch a person could flip did nothing. It FAILS TOWARD ENABLED (globalSettings.ts): a broken
    // settings document must never be able to hide a surface, because with VS Code settings gone the
    // repair path runs through Tachyon's own UI.
    if (!sharedGlobalSettings().current().agentPaneEnabled) {
      notify(vscode.l10n.t("The Tachyon agent pane is turned off in Tachyon settings — the integrated terminal is still available from the sidebar."), "info");
      return;
    }
    await agentPanes.open({
      agent,
      session: projected.session,
      title: agent,
      wsHash: ws.wsHash,
      // Layer 1 integrated terminal stays available via sidebar "Open terminal" (inspect).
      resizeSession: async (session, cols, rows) => {
        await terminalTmux.resizeWindow(session, cols, rows);
      },
      // t-edbe36 — measure foreign shell co-attach; never detach clients we did not spawn.
      listClients: async (session) => terminalTmux.listSessionClients(session),
      // Same hardened tmux delivery as prompt.inject (381 / t-2c2384) — stage without Enter /
      // submit with Enter + measured composer profile (without profile, wrap falls to the legacy
      // last-line heuristic and can report delivery for a still-staged draft).
      // Shell projection has no cmd/runtime field; declared agents resolve via config (same source
      // Studio edits). Temporary agents without a config entry degrade honestly (no profile).
      deliverText: async (session, text, submit) => {
        await deliverAgentPaneText(
          terminalTmux,
          session,
          text,
          submit,
          asAgent(ws.config?.agents?.[agent])?.cmd,
        );
      },
      // Detached pane: "is my agent gone, or only the window onto it?" — tmux answers that.
      sessionAlive: async (session) => terminalTmux.hasSession(session),
      openTemplateInject: async (agentName, choose) => injectPromptTemplateFlow(ws, agentName, choose),
      createPinFromSelection: async (text, agentName) => {
        const title = pinTitleFromSelection(text, agentName);
        if (!title) throw new Error(vscode.l10n.t("Nothing selected."));
        const created = await extensionInvoke(ws, {
          action: "pin.create",
          text: title,
          by: "human",
          done: false,
        });
        refreshAll();
        // Engine returns pin payload; tolerate shape variations.
        const row = created && typeof created === "object" ? created as { id?: unknown } : {};
        const id = typeof row.id === "string" ? row.id : "pin";
        return { id };
      },
    });
    await ws.markAgentPaneSeen(agent);
  };

  const versionValue = (context.extension.packageJSON as { version?: unknown }).version;
  const shellVersion = typeof versionValue === "string" && versionValue.trim() ? versionValue : "development";
  const devProfileHome =
    context.extensionMode === vscode.ExtensionMode.Development
    && process.env.TACHYON_DEV_HOST === "1"
    && process.env.TACHYON_DEV_HOST_PROFILE_HOME
    && path.isAbsolute(process.env.TACHYON_DEV_HOST_PROFILE_HOME)
      ? process.env.TACHYON_DEV_HOST_PROFILE_HOME : undefined;
  const tmuxSocketName =
    context.extensionMode === vscode.ExtensionMode.Production
      ? SOCKET_NAME
      : (process.env.TACHYON_TMUX_SOCKET?.trim() || SOCKET_NAME);
  if (context.extensionMode !== vscode.ExtensionMode.Production) {
    terminals.useSocket(tmuxSocketName);
  }
  const shellReleasePolicy = engineShellReleasePolicy(
    context.extensionMode === vscode.ExtensionMode.Production
      ? "production"
      : context.extensionMode === vscode.ExtensionMode.Development
        ? "development"
        : "test",
  );
  const shellBuildStamp = tachyonBuildStamp();
  const requiredPackagedBuild = shellReleasePolicy.requiredChannel === "stable"
    ? { commit: shellBuildStamp.commit ?? "", treeSha: shellBuildStamp.treeSha ?? "" }
    : undefined;
  const clientRegistry = new WorkspaceClientRegistry({
    connect: (workspaceRoot) => {
      if (shellReleasePolicy.requireMarkedDevHost) assertMarkedDevHostWorkspace(workspaceRoot);
      return connectPackagedWorkspaceClient({
        workspaceRoot,
        extensionRoot: context.extensionUri.fsPath,
        requireCleanBuild: shellReleasePolicy.requireCleanBuild,
        requiredChannel: shellReleasePolicy.requiredChannel,
        requiredBuild: requiredPackagedBuild,
        runtimeSourceExecutable: shellReleasePolicy.requiredChannel === "dev"
          ? process.env.TACHYON_DEV_HOST_ENGINE_RUNTIME
          : undefined,
        shell: { version: shellVersion, locale: vscode.env.language },
        capabilities: [ENGINE_UI_CAPABILITY, "vscode.diff", "vscode.editor", "vscode.terminal"],
        settings: daemonSettingsSnapshot(workspaceRoot),
        ...(devProfileHome ? { agentProfileHomeDir: devProfileHome } : {}),
        ...(context.extensionMode === vscode.ExtensionMode.Production ? {} : { tmuxSocket: tmuxSocketName }),
        migrationProvider: {
          storage: bridgeStateMigrationStorage,
          provide: () => collectLegacyEngineStateMigration(workspaceHash(workspaceRoot), {
            globalStorageRoot: context.globalStorageUri.fsPath,
            getState: <T>(key: string) => context.globalState.get<T>(key),
            getSecret: (key: string) => Promise.resolve(context.secrets.get(key)),
          }, bridgeStateMigrationStorage),
        },
        uiHandler: async (request) => {
          if (request.kind === "focus-primary") {
            await vscode.commands.executeCommand("tachyonSidebarPrototype.focus");
            return null;
          }
          if (request.kind === "terminal.present") {
            terminals.open(request.agent, request.session, request.viewColumn, request.title);
            return null;
          }
          if (request.kind === "terminal.close") {
            terminals.close(request.agent, request.session);
            return null;
          }
          const value = await vscode.commands.executeCommand(request.command, ...request.args);
          if (value === undefined) return null;
          if (!isJsonValue(value)) throw new Error(`editor command '${request.command}' returned a non-JSON result`);
          return value;
        },
        // Development/Test includes F5, CI and headless harnesses. With no guaranteed human to answer,
        // activation must keep moving; only an installed production shell owns this modal decision.
        confirmEngineUpgrade: context.extensionMode === vscode.ExtensionMode.Production
          ? async (snapshot) => {
            const upgradeLabel = vscode.l10n.t("Upgrade anyway");
            const message = snapshot.state === "unknown"
              ? vscode.l10n.t("Tachyon could not verify whether agents are working. Upgrading the engine may interrupt an in-flight turn.")
              : vscode.l10n.t("Upgrading the Tachyon engine will interrupt in-flight work for: {0}", snapshot.agents.join(", "));
            const answer = await showNotification(message, "warn", [upgradeLabel], { modal: true });
            return answer === upgradeLabel;
          }
          : undefined,
      });
    },
  });
  activeClientRegistry = clientRegistry;
  const syncStops = new Map<string, () => void>();

  const startClientSync = (ws: WorkspaceShellHandle): void => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let connectionWarningShown = false;
    const unsubscribe = ws.client.subscribe((result) => {
      if (result.resynced || result.engineChanged) {
        // SDD 485 B2 — the event cursor expired (or the engine changed incarnation), so "what
        // changed" is unknowable from any journal downstream of here. A hidden Control must rebuild
        // on reveal rather than replay the handful of kinds `refreshAll` happens to touch.
        taskDetailPanels.markSourceResync(); // SDD 485 C4 — same bargain for every open task document
        boardPanels.markSourceResync(); // SDD 485 C5 — and for every open Board panel
        refreshAll();
      }
      for (const event of result.events) {
        if (event.kind === "views-changed") {
          const view = viewKind(event.payload.view);
          if (view) onViewsChanged(view);
        } else if (event.kind === "activity-appended") {
          sidebarProto.refresh();
        }
      }
    });
    const poll = async (): Promise<void> => {
      try {
        await ws.client.sync(200);
        connectionWarningShown = false;
      } catch (error) {
        if (!stopped && !connectionWarningShown) {
          connectionWarningShown = true;
          notify(vscode.l10n.t("Tachyon engine connection is unavailable: {0}", error instanceof Error ? error.message : String(error)), "warn");
        }
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), 1_000);
      }
    };
    timer = setTimeout(() => void poll(), 1_000);
    syncStops.set(ws.workspaceRoot, () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
    });
  };

  const detachWorkspace = async (ws: WorkspaceShellHandle): Promise<void> => {
    syncStops.get(ws.workspaceRoot)?.();
    syncStops.delete(ws.workspaceRoot);
    await clientRegistry.detach(ws.workspaceRoot);
  };

  const addWorkspace = async (folderPath: string, _autostart: boolean, refreshOnSuccess = true): Promise<WorkspaceShellHandle> => {
    // SDD 504 — THE choke point for the sidebar's boot phases. Every door that boots a folder passes
    // here, so `starting`/`ready`/`failed` are stated once instead of at four call sites that would
    // each have to remember. The notify() below stays: a toast is transient and this is durable, and
    // the sidebar state is the half that survives long enough to be read.
    markBootStarting(folderPath);
    const client = await clientRegistry.attach(folderPath).catch((error: unknown) => {
      notify(vscode.l10n.t("Tachyon persistent engine could not start: {0}", error instanceof Error ? error.message : String(error)), "error");
      markBootFailed(folderPath, error);
      throw error;
    });
    const gitExec = createGitExec(() => resolveGitBinary({
      configuredPath: sharedGlobalSettings().current().gitPath,
      gitExtensionPath: vscode.workspace.getConfiguration("git", vscode.Uri.file(client.workspaceRoot)).get<string | string[]>("path"),
    }));
    const ws = new WorkspaceShellHandle(client, { extensionUri: context.extensionUri, gitExec });
    registry.set(folderPath, ws);
    startClientSync(ws);
    if (hasConfig(folderPath)) syncWorkspaceToolLauncher(folderPath);
    reconcileWorkspaceGitHookHarness(folderPath);
    // SDD 504 — the readiness edge, set BEFORE refreshAll so the push that follows already carries
    // it. Marking after would post one frame that still said "starting" over a fleet that is here.
    markBootReady(folderPath);
    if (refreshOnSuccess) refreshAll();
    return ws;
  };

  /**
   * SDD 504 — Retry ONE folder after a failed start.
   *
   * Not window-wide: a multi-root window where one engine was rejected must not re-attach the folder
   * that merely takes longer. An unknown hash does nothing rather than falling back to the first
   * folder — the same rule every other hash-routed sidebar op follows, and the reason `wsFor` refuses
   * a supplied-but-unmatched hash instead of acting on workspace 0.
   *
   * A folder already `starting` is ignored, so a second click (or a refresh arriving mid-attach)
   * cannot start a duplicate attach.
   */
  retryStartFromSidebar = (wsHash: string): void => {
    const found = [...bootFolders.entries()].find(([, folder]) => folder.hash === wsHash);
    if (!found) return;
    const [folderPath, folder] = found;
    if (folder.phase === "starting") return;
    // The throw is already reported by `addWorkspace` (toast + `markBootFailed`), so this catch only
    // keeps the rejection from escaping an event handler that has nowhere to return it.
    void addWorkspace(folderPath, true).catch(() => undefined);
  };

  // Boot a folder on demand — used by creation commands so a fresh folder gets a
  // Workspace the moment the user ACTS (Init / New Agent / Studio), not just by
  // having the extension installed.
  const ensureWorkspaceFor = async (folderPath: string): Promise<WorkspaceShellHandle> => {
    return registry.get(folderPath) ?? (await addWorkspace(folderPath, false));
  };

  let workspaceReviversReady = false;
  const deferredWorkspacePanelRevives: Array<() => void> = [];
  const workspacePanelReviveDeferral = {
    // SDD 485 D2 — `project` as well as `wsHash`: a section app persists the workspace under the manifest's
    // name for it, and a deferral that only knew the pre-485 spelling would silently stop deferring the
    // moment a surface migrated — which is the shape of regression nobody notices, because the panel still
    // opens, just briefly wrong.
    shouldDefer: (state: { wsHash?: unknown; project?: unknown }) => {
      const hash = typeof state.project === "string" ? state.project : typeof state.wsHash === "string" ? state.wsHash : undefined;
      return !workspaceReviversReady && hash !== undefined && !workspaces().some((ws) => ws.wsHash === hash);
    },
    onReady: (callback: () => void): void => {
      deferredWorkspacePanelRevives.push(callback);
    },
  };
  const flushDeferredWorkspacePanelRevives = (): void => {
    workspaceReviversReady = true;
    for (const callback of deferredWorkspacePanelRevives.splice(0)) callback();
  };

  const activityPanels = new ActivityPanelManager(
    context.extensionUri,
    () => workspaces().map((workspace) => workspace.activity),
  );
  context.subscriptions.push({ dispose: () => activityPanels.dispose() });
  const probesPanels = new ProbeResultPanelManager(
    context.extensionUri,
    () => workspaces().map((workspace) => workspace.probe),
  );
  context.subscriptions.push({ dispose: () => probesPanels.dispose() });

  const engineHost = makeControlModelHost();
  // SDD 500 — ONE manager where Overview's and Engine's were two, wired from the union of both dep
  // sets: the collect + doctor + engine-log doors Engine needed, and the `openSection` shortcut the
  // "waiting on you" counter posts (t-3bcd57 left it as that counter's only caller).
  const systemPanels = new SystemPanelManager(context.extensionUri, {
    collect: engineHost.collect,
    openDoctor: engineHost.openDoctor,
    openSection: (section) => {
      void vscode.commands.executeCommand("tachyon.openControl", section);
    },
    clearEngineLog,
    openEngineJournal,
  }, undefined, controlWorkspaceScope);
  context.subscriptions.push({ dispose: () => systemPanels.dispose() });
  const openSystemTab = (hash?: string): boolean => {
    const ws = (hash ? byHash(hash) : undefined) ?? (controlWorkspaceScope.current ? byHash(controlWorkspaceScope.current) : undefined) ?? workspaces()[0];
    if (!ws) { notify(vscode.l10n.t("No Tachyon workspace is attached in this window."), "warn"); return false; }
    systemPanels.open(ws.wsHash); return true;
  };

  // SDD 485 D6 — Worktrees uses the same validated model source as Control did, but the standalone
  // dashboard binds one immutable project. All destructive calls below receive that project from the
  // panel session, not from an untrusted row/message field.
  const worktreesPanels = new WorktreesPanelManager(context.extensionUri, {
    collect: engineHost.collect,
    revealPath: engineHost.revealPath,
    remove: removeManagedWorktree,
    forget: forgetManagedWorktreeRecord,
    releaseLock: releaseManagedWorktreeLock,
    land: landManagedWorktree,
  }, undefined, controlWorkspaceScope);
  context.subscriptions.push({ dispose: () => worktreesPanels.dispose() });
  const openWorktreesTab = (hash?: string): boolean => {
    const ws = (hash ? byHash(hash) : undefined)
      ?? (controlWorkspaceScope.current ? byHash(controlWorkspaceScope.current) : undefined)
      ?? workspaces()[0];
    if (!ws) {
      notify(vscode.l10n.t("No Tachyon workspace is attached in this window."), "warn");
      return false;
    }
    worktreesPanels.open(ws.wsHash);
    return true;
  };

  const keysPanels = new KeysPanelManager(context.extensionUri, { byHash }, undefined, controlWorkspaceScope);
  context.subscriptions.push({ dispose: () => keysPanels.dispose() });
  const openKeysTab = (hash?: string): boolean => {
    const ws = (hash ? byHash(hash) : undefined) ?? (controlWorkspaceScope.current ? byHash(controlWorkspaceScope.current) : undefined) ?? workspaces()[0];
    if (!ws) { notify(vscode.l10n.t("No Tachyon workspace is attached in this window."), "warn"); return false; }
    keysPanels.open(ws.wsHash); return true;
  };
  const openCompanionTab = (hash?: string): boolean => { const ws = (hash ? byHash(hash) : undefined) ?? (controlWorkspaceScope.current ? byHash(controlWorkspaceScope.current) : undefined) ?? workspaces()[0]; if (!ws) { notify(vscode.l10n.t("No Tachyon workspace is attached in this window."), "warn"); return false; } companionPanels.open(ws.wsHash); return true; };

  // t-505f13 — Onboarding: a `window` app, so it opens with NO attached workspace (that is its
  // audience). Every fact is injected: probes are the engine's own doors (doctor, detectInstalledClis,
  // the engine-runtime Node probe), and the actions forward to commands that already exist —
  // `tachyon.init` IS the bootstrap, Agent Studio/Keys/openConfig are their own surfaces' doors.
  const onboardingPanels = new OnboardingPanelManager(context.extensionUri, {
    folders: () => (vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, root: f.uri.fsPath })),
    hasConfig: (root) => hasConfig(root),
    attachedRoots: () => new Set(workspaces().map((ws) => ws.workspaceRoot)),
    secretInventory: async () => {
      const ws = workspaces()[0];
      return ws ? ws.secretInventory() : undefined;
    },
    agentCount: () => {
      const ws = workspaces()[0];
      return ws ? scanAgentRosterDirectory(ws.workspaceRoot).members.length : undefined;
    },
    checkTmux: () => doctor(),
    detectClis: () => detectInstalledClis(),
    checkNode: () => probeEngineNodeRuntime(),
    initialize: async () => { await vscode.commands.executeCommand("tachyon.init"); },
    openConfig: () => { void vscode.commands.executeCommand("tachyon.openConfig"); },
    openNewAgentStudio: () => { void vscode.commands.executeCommand("tachyon.newAgentStudio"); },
    openKeys: () => { void vscode.commands.executeCommand("tachyon.openControl", "keys"); },
  });
  context.subscriptions.push({ dispose: () => onboardingPanels.dispose() });

  // SDD 485 D8 — every read and write is rooted in the immutable dashboard project.
  const runtimeConfigPanels = new RuntimeConfigPanelManager(
    context.extensionUri,
    runtimeConfigDeps,
    undefined,
    controlWorkspaceScope,
  );
  context.subscriptions.push({ dispose: () => runtimeConfigPanels.dispose() });
  const openRuntimeConfigTab = (hash?: string): boolean => {
    const ws = (hash ? byHash(hash) : undefined)
      ?? (controlWorkspaceScope.current ? byHash(controlWorkspaceScope.current) : undefined)
      ?? workspaces()[0];
    if (!ws) {
      notify(vscode.l10n.t("No Tachyon workspace is attached in this window."), "warn");
      return false;
    }
    runtimeConfigPanels.open(ws.wsHash);
    return true;
  };

  // SDD 485 D9 — the ledger reader accepts a wsHash, so each immutable dashboard project receives
  // its own VM and its own webview-local selection/filter state.
  // SDD 485 D10 — Settings is one immutable project dashboard. Its source and mutations all use
  // that project; client-supplied wsHash fields are deliberately ignored by SettingsPanelManager.
  const settingsPanels = new SettingsPanelManager(context.extensionUri, {
    collect: engineHost.collect,
    openDoctor: engineHost.openDoctor,
    openConfigFile: engineHost.openConfigFile,
    setCompanionTabTools: engineHost.setCompanionTabTools,
    setIdeBrowserEnabled: engineHost.setIdeBrowserEnabled,
    setIdleAfterMinutes: engineHost.setIdleAfterMinutes,
    setCompanionAllowedHosts: engineHost.setCompanionAllowedHosts,
    unpairCompanionDevice: engineHost.unpairCompanionDevice,
    issueCompanionPairCode: engineHost.issueCompanionPairCode,
  }, undefined, controlWorkspaceScope);
  context.subscriptions.push({ dispose: () => settingsPanels.dispose() });
  const companionPanels = new CompanionPanelManager(context.extensionUri, {
    collect: engineHost.collect,
    setCompanionTabTools: engineHost.setCompanionTabTools,
    setCompanionAllowedHosts: engineHost.setCompanionAllowedHosts,
    unpairCompanionDevice: engineHost.unpairCompanionDevice,
    issueCompanionPairCode: engineHost.issueCompanionPairCode,
  }, undefined, controlWorkspaceScope);
  context.subscriptions.push({ dispose: () => companionPanels.dispose() });
  const openSettingsTab = (hash?: string): boolean => {
    const ws = (hash ? byHash(hash) : undefined)
      ?? (controlWorkspaceScope.current ? byHash(controlWorkspaceScope.current) : undefined)
      ?? workspaces()[0];
    if (!ws) { notify(vscode.l10n.t("No Tachyon workspace is attached in this window."), "warn"); return false; }
    settingsPanels.open(ws.wsHash);
    return true;
  };

  // SDD 485 C5 — the Board app's own restore: the panel VS Code hands back is REUSED, keyed on the project
  // it persisted, so a reload puts the Board back in its tab instead of opening a second one.
  registerTrustedPanelSerializer<SectionPanelState>(context, BOARD_VIEW_TYPE, (panel, state) => boardPanels.deserialize(panel, state));
  registerTrustedPanelSerializer<SectionPanelState>(context, REVIEW_VIEW_TYPE, (panel, state) => reviewPanels.deserialize(panel, state), { defer: workspacePanelReviveDeferral });
  registerTrustedPanelSerializer<SectionPanelState>(context, SYSTEM_VIEW_TYPE, (panel, state) => systemPanels.deserialize(panel, state), { defer: workspacePanelReviveDeferral });
  registerTrustedPanelSerializer<SectionPanelState>(context, WORKTREES_VIEW_TYPE, (panel, state) => worktreesPanels.deserialize(panel, state), { defer: workspacePanelReviveDeferral });
  registerTrustedPanelSerializer<SectionPanelState>(context, KEYS_VIEW_TYPE, (panel, state) => keysPanels.deserialize(panel, state), { defer: workspacePanelReviveDeferral });
  // t-505f13 — a `window` app like Runtime Ops: restore is not workspace-bound, so no revive deferral.
  registerTrustedPanelSerializer<SectionPanelState>(context, ONBOARDING_VIEW_TYPE, (panel, state) => onboardingPanels.deserialize(panel, state));
  registerTrustedPanelSerializer<SectionPanelState>(context, RUNTIME_CONFIG_VIEW_TYPE, (panel, state) => runtimeConfigPanels.deserialize(panel, state), { defer: workspacePanelReviveDeferral });
  registerTrustedPanelSerializer<SectionPanelState>(context, SETTINGS_VIEW_TYPE, (panel, state) => settingsPanels.deserialize(panel, state), { defer: workspacePanelReviveDeferral });
  registerTrustedPanelSerializer<SectionPanelState>(context, COMPANION_VIEW_TYPE, (panel, state) => companionPanels.deserialize(panel, state), { defer: workspacePanelReviveDeferral });
  // t-610705 (Phase C.1) — a revived pre-410 standalone Task Detail panel disposes itself and
  // redirects into Control → the task's subroute; same claimed-singleton guard as Board/tmux above
  // (open() was already unreachable — nothing to "keep working" here beyond this revive path).
  // SDD 485 C4 — the reversal of 410's retirement: this viewType has a live host again, so a restored panel
  // is REVIVED INTO the app rather than disposed and redirected into Control. `TaskDetailPanelManager`
  // accepts both this app's own persisted state and the pre-410 standalone panel's `wsHash`/`taskId` shape,
  // which is the whole of the compatibility shim and has no UI (see its `migrateLegacy`).
  registerTrustedPanelSerializer<TaskDetailPanelState>(context, TASK_DETAIL_VIEW_TYPE, (panel, state) => {
    taskDetailPanels.deserialize(panel, state);
  });
  registerTrustedPanelSerializer<ActivityPanelState | SectionPanelState>(context, ACTIVITY_VIEW_TYPE, (panel, state) => {
    activityPanels.deserialize(panel, state);
  }, { defer: workspacePanelReviveDeferral });
  registerTrustedPanelSerializer<SectionPanelState | HandoffPanelState>(context, HANDOFF_VIEW_TYPE, (panel, state) => {
    handoffPanels.deserialize(panel, state);
  }, { defer: workspacePanelReviveDeferral });
  // SDD 485 D2 — the Plugins app's own restore, and the second REUSED viewType (after C4's and D1's):
  // the panel VS Code hands back is kept, keyed on the project it persisted, so a reload puts Plugins back
  // in its tab instead of opening a second one. A pre-410 record carrying `wsHash` instead of `project` is
  // accepted too — `migrateLegacy` renames the one field, which is the whole of the shim and has no UI.
  // The revive deferral stays: it is what keeps a panel restored BEFORE its workspace is attached from
  // painting "no workspace attached" for a moment (see `workspacePanelReviveDeferral`, which now reads
  // either field name).
  registerTrustedPanelSerializer<SectionPanelState | PluginsPanelState>(context, PLUGINS_VIEW_TYPE, (panel, state) => pluginsPanels.deserialize(panel, state), { defer: workspacePanelReviveDeferral });
  registerTrustedPanelSerializer<ProbesPanelState | SectionPanelState>(context, PROBES_VIEW_TYPE, (panel, state) => {
    probesPanels.deserialize(panel, state);
  }, { defer: workspacePanelReviveDeferral });
  registerTrustedPanelSerializer<LegacyPinDetailState>(context, PIN_DETAIL_VIEW_TYPE, (panel, state) => pinDetailPanels.deserialize(panel, state));
  registerTrustedPanelSerializer<AgentPanePanelState>(context, AGENT_PANE_VIEW_TYPE, (panel, state) => agentPanes.deserialize(panel, state));
  registerTrustedPanelSerializer<TerminalStudioPanelState | SectionPanelState>(context, TERMINAL_STUDIO_SHELL_VIEW_TYPE, (panel, state) => studioPanels.terminal.deserialize(panel, state));
  registerTrustedPanelSerializer<ScheduleStudioPanelState | SectionPanelState>(context, SCHEDULE_STUDIO_SHELL_VIEW_TYPE, (panel, state) => studioPanels.schedule.deserialize(panel, state));
  registerTrustedPanelSerializer<AgentStudioPanelState | SectionPanelState>(context, AGENT_STUDIO_SHELL_VIEW_TYPE, (panel, state) => studioPanels.agent.deserialize(panel, state));
  // SDD 485 D20 — a pre-410 Pin Studio panel is still a live restore door. Reopen it in the Pins
  // document app instead of routing through Control: edit keeps its identity; new gets a provisional
  // identity and the document's existing staged-create policy (cancel closes without saving).
  registerTrustedPanelSerializer<PinStudioPanelState>(context, PIN_STUDIO_VIEW_TYPE, (panel, state) => {
    panel.dispose();
    if (!state?.wsKey) return;
    if (state.snapshot.mode === "edit" && state.snapshot.entityId) {
      pinDetailPanels.openEdit(state.wsKey, state.snapshot.entityId);
      return;
    }
    pinDetailPanels.openCreate(state.wsKey, mintPinId());
  });
  // t-610705 (Phase D, D2) — Task Studio's redirect can't reuse registerLegacyStudioRedirect's shared
  // helper as-is: its non-edit fallback calls cockpitRoutes.studioNew(studio, wsKey), which THROWS for
  // "task" (route.ts's defensive assertion — task is never id-less in practice). A persisted "new"
  // Task Studio panel state is a genuinely malformed/legacy edge case (every real "new" caller
  // pre-mints an id and never persists panel state before its first save completes), so this redirects
  // to Mission instead of constructing an invalid route.
  registerTrustedPanelSerializer<TaskStudioPanelState>(context, TASK_STUDIO_VIEW_TYPE, (panel, state) => {
    panel.dispose();
    if (!state?.wsKey) return;
    if (state.snapshot.mode === "edit" && state.snapshot.entityId) {
      taskDetailPanels.openEdit(state.wsKey, state.snapshot.entityId);
      return;
    }
    // SDD 485 C5 — the Board is an app: a malformed "new" Task Studio state lands on it directly rather
    // than asking Control for a section it no longer renders.
    openBoard(state.wsKey);
  });
  // SDD 485 D1 — the tmux app's own restore, and the cleanest revival in the whole spec: the panel VS Code
  // hands back is REUSED. This viewType is the one 410 retired, and its tombstone persisted
  // `{schemaVersion, view}` — exactly what a `window` app writes, since it has no project and no identity.
  // So a pre-410 record is not migrated, it is already valid: no dispose-and-reopen, no shim, no dead path,
  // and no `isCockpitSingletonClaimed()` guard (that guard existed because the old redirect would navigate a
  // Control panel someone else had restored; opening an app touches no Control state, and re-opening
  // reveals rather than duplicating, which makes this safe against VS Code's unspecified revive order).
  registerTrustedPanelSerializer<SectionPanelState>(context, TMUX_VIEW_TYPE, (panel, state) => tmuxPanels.deserialize(panel, state));
  // SDD 485 D3 — the Runtime Ops app's own restore. A NEW viewType, unlike C4's, D1's and D2's reuses:
  // the only legacy id, `tachyonRuntimeOpsView`, names spec 367's retired WebviewView (a bottom-panel
  // view container that was never registered), so there is no record to revive and nothing to migrate.
  // That tombstone therefore stays exactly where it is, in the dispose-only loop below, and this app's
  // own `{schemaVersion, view}` state is what a reload hands back. No revive deferral either: a `window`
  // app names no workspace, so there is nothing for `workspacePanelReviveDeferral` to wait for.
  registerTrustedPanelSerializer<SectionPanelState>(context, RUNTIME_OPS_VIEW_TYPE, (panel, state) => runtimeOpsPanels.deserialize(panel, state));
  // SDD 485 D4 — the Human Inbox app's own restore, and the simplest of the six: the viewType is NEW
  // because there is NO legacy id at all (this surface was born as a Control section after 410 and never
  // had a standalone panel), so there is no tombstone to keep in the dispose-only loop, no record to
  // migrate and no redirect to leave behind. The revive deferral DOES apply — it is a dashboard, so its
  // persisted `project` names a workspace, and without it a panel restored before its workspace attaches
  // paints "that workspace is no longer attached" for a moment.
  registerTrustedPanelSerializer<SectionPanelState>(context, HUMAN_INBOX_VIEW_TYPE, (panel, state) => humanInboxPanels.deserialize(panel, state), { defer: workspacePanelReviveDeferral });
  // SDD 485 E1 — a persisted pre-cutover Control panel has no host to revive into. Dispose the stale
  // panel VS Code handed us and open Overview, the sensible default for an unscoped legacy shell.
  registerTrustedPanelSerializer<{ schemaVersion: 1 | 2; view: string; wsHash?: unknown }>(context, "tachyonCockpit", (panel, state) => {
    panel.dispose();
    openSystemTab(typeof state?.wsHash === "string" ? state.wsHash : undefined);
  });
  // SDD 485 C1 — `tachyonSectionAppFixture` is dispose-only for the same reason `tachyonAgentFixtureStudio`
  // is: it is a dev-only proof surface that nothing here instantiates, so there is no manager to revive a
  // panel INTO. `SectionPanelManager` itself does support revival (it persists project + identity and
  // re-opens on the same key); that contract is exercised against a real `registerTrustedPanelSerializer`
  // in `test/unit/sectionPanelManager.test.ts`, and C4/C5 wire it here for the apps that ship.
  // t-5f2b5b — `tachyonFleet` joins them: the Fleet app is deleted, so a tab a human left open before the
  // deletion has no manager to revive into. Without this row VS Code hands the panel back to nobody and the
  // human gets a dead editor tab; with it the stale panel is disposed on the spot.
  // SDD 500 — `tachyonOverview` and `tachyonEngine` join them for the same reason, with one difference
  // worth naming: the Fleet app was deleted and these two were MERGED, so a redirect into System was
  // representable. It was rejected (D2). Each old tab carries the title and icon of a surface that no
  // longer exists, and reviving it as System would leave a human holding a tab that says Overview and
  // draws something else. Disposing says the honest thing; the launcher's one tile is a click away.
  // t-edfe12 — `tachyonPipelineStudio` joins them: the Fake 1 studio was deleted, so a tab left open
  // before the deletion has no manager to revive into. Dispose-only preserves spec 361 (every panel
  // still has a serializer) without shipping the in-memory test double.
  // 514 — `tachyonUserApp` joins them, for a reason of its own: between two windows the app may have
  // been reinstalled over or removed, so a revived tab could restore a screen that no longer exists.
  // And the two `tachyonPluginSurface*` ids STAY here although the capability is gone: a human may
  // have had one of those tabs open when they updated, and VS Code will try to revive it. Disposing is
  // the honest answer; removing the entry would leave a tab VS Code cannot restore and nobody claims.
  for (const viewType of ["tachyonPluginSurface", "tachyonPluginSurfaces", "tachyonAgentFixtureStudio", "tachyonSectionAppFixture", "tachyonPipelineStudio", "tachyonDesignMode", "tachyonControlInspector", "tachyonSketch", "tachyonRuntimeOpsView", "tachyonFleet", "tachyonOverview", "tachyonEngine", "tachyonUserApp"]) {
    registerDisposePanelSerializer(context, viewType);
  }

  // Picker for CREATION commands (New Agent / Studio tabs). Same rule as
  // pickWorkspace: only Tachyon-configured folders are offered, and a lone one is
  // auto-selected — when a mix of configured and unconfigured folders is open, the
  // unconfigured ones never appear. The ONE divergence is the zero-configured tail:
  // there it falls back to every open folder and boots the chosen one on demand, so
  // first-run creation is itself the opt-in (the bootstrap path Init also covers).
  //
  // t-be359b — reaching this function AT ALL now means the caller had nothing to say. The sidebar
  // door answers first: with more than one root it draws the product QuickPicker over its own fleet
  // list and passes the chosen hash, so the native list below is the Command Palette's fallback.
  const pickFolderForCreate = async (): Promise<WorkspaceShellHandle | undefined> => {
    const configured = configuredWorkspaces();
    if (configured.length === 1) return configured[0];
    if (configured.length > 1) {
      // Palette fallback only — the sidebar never gets here (it sends a hash).
      const picked = await vscode.window.showQuickPick(
        configured.map((ws) => ({ label: ws.folderName, description: ws.bridgeUrl, ws })),
        { placeHolder: vscode.l10n.t("Which folder?") },
      );
      return picked?.ws;
    }
    // Zero configured — bootstrap: offer every open folder, boot the chosen one on demand.
    const open = vscode.workspace.workspaceFolders ?? [];
    if (open.length === 0) {
      notify(vscode.l10n.t("open a folder first"), "warn");
      return undefined;
    }
    let folder = open[0];
    if (open.length > 1) {
      // t-be359b — STAYS NATIVE, and this one is not the same question as the branch above. These
      // candidates are UNCONFIGURED folders: no tachyon.yml, therefore no fleet, therefore no row in
      // any webview model of ours to pick from. This branch runs only when ZERO folders are
      // configured, which is exactly when the sidebar is showing its "Initialize Tachyon" welcome
      // instead of a fleet — so there is no candidate set and no surface. Native is the honest answer.
      const picked = await vscode.window.showQuickPick(
        open.map((f) => ({ label: f.name, description: f.uri.fsPath, f })),
        { placeHolder: vscode.l10n.t("Which folder?") },
      );
      if (!picked) return undefined;
      folder = picked.f;
    }
    return ensureWorkspaceFor(folder.uri.fsPath);
  };

  // LAZY ACTIVATION: only folders that already carry a tachyon.yml boot at startup
  // (Bridge, tmux engine, port). A folder you merely opened to look at stays inert
  // — its views show the "Initialize Tachyon" welcome instead. No surprise MCP
  // server, no tmux server, until you opt in.
  // A Tachyon-managed worktree folder (t-caddfc reveal) is ALSO a checkout of the repo and
  // so carries its own tachyon.yml — excluded here (t-2a73d6) so it stays view-only instead
  // of booting a second phantom Bridge/tmux/agent-tree of its own.
  // SDD 504 — answer "is there a Tachyon workspace here?" BEFORE the attach loop, because the answer
  // needs neither the engine nor a first sync; it is `workspaceFolders` + `hasConfig`, right here, in
  // this turn. That ordering is the whole fix: it is what lets the sidebar say "starting" instead of
  // guessing "absent" from a fleet array that is empty only because nothing has been attached yet.
  discoverBootFolders();
  // …and register the view now, still before the attach loop, so the honest transient state is
  // actually ON SCREEN during the 1.7–3.9 s the loop takes. Registering after (as this did) meant
  // `configured-and-starting` existed in the model and could never be observed in production: by the
  // time the view resolved, every folder was already ready.
  //
  // WHO ELSE CAN REACH THIS, now that the view can resolve earlier? `push()` reads `getWorkspaces()`,
  // which is simply empty until the loop runs, and every message handler resolves its target through
  // `wsFor` — an unmatched hash is already a no-op there. Everything the provider closes over is
  // constructed above; only the attach loop below has not run.
  // t-6e2952 — the Control launcher is a TAB inside this one view, not a view of its own: registering a
  // second WebviewViewProvider here is what put a stacked "CONTROL" section above the Tachyon panel.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarPrototypeProvider.viewType, sidebarProto, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  for (const folder of folders.filter((f) => shouldActivateFolder(hasConfig(f.uri.fsPath), f.uri.fsPath, currentWorktreesBase()))) {
    // SDD 504 — one folder's failure must not abort the loop. It used to: an attach rejection
    // propagated out of `activate()`, so a single bad folder in a multi-root window left the sidebar
    // provider unregistered and the remaining folders unattached. That is also why the spec's
    // "startup fails" scenario had no way to render — the failure took the whole activation with it.
    // `addWorkspace` has already recorded the failure and notified; this only keeps going.
    // t-30af3e — NODE_RUNTIME_NOT_FOUND is a host refusal, not a folder one. Swallowing it made
    // `activate()` succeed on a PATH with no Node and turned the VSIX smoke `node-missing` door
    // red. Retry cannot install Node; the probe matches the thrown EngineBundleError.
    try {
      await addWorkspace(folder.uri.fsPath, true);
    } catch (error) {
      if (isHostEngineRefusal(error)) throw error;
      continue;
    }
  }
  void checkTachyonBuildProvenance(context);
  flushDeferredWorkspacePanelRevives();
  // spec 210/263 — self-heal ONCE at activation: a prior window's worktree folders may have
  // outlived the worktrees themselves (a deploy reload finds them already cleaned up), so the
  // persisted .code-workspace can carry stale entries forward across reloads otherwise.
  void applyWorktreeFolderReveal();
  // Folders added/removed live (multi-root): create with config, then use the registry's explicit detach path.
  const folderWatcher = registerWorkspaceMembershipRefresh(vscode.workspace.onDidChangeWorkspaceFolders, {
    registry,
    detachWorkspace,
    hasConfig,
    currentWorktreesBase,
    addWorkspace,
    // SDD 504 — a folder added or removed changes the discovery answer, and this watcher is the one
    // place that learns about it. Re-discovering through the refresh it already calls keeps the two
    // in step; a separate `onDidChangeWorkspaceFolders` listener would race this one for ordering.
    // `discoverBootFolders` reconciles membership only, so folders mid-attach keep their phase.
    refreshAll: () => {
      discoverBootFolders();
      refreshAll();
    },
    reportError: (error) => {
      notify(vscode.l10n.t("Tachyon workspace membership update failed: {0}", error instanceof Error ? error.message : String(error)), "error");
    },
  });

  // spec 237 — the Tachyon sidebar is the Preact webview (the native tree was retired). Its provider is
  // registered ABOVE, before the attach loop (SDD 504). 514 — the plugin surface host that used to be
  // registered here went with the capability: a plugin no longer draws a screen.

  // t-4486eb — test-only `tachyon._*` table. Sibling bundle + runtime env, never
  // `context.extensionMode`: screenshot/integration hosts are an installed VSIX.
  if (process.env.TACHYON_TEST_SEAMS === "1") {
    const { registerInternalSeams } = createRequire(__filename)(
      path.join(__dirname, "internalSeams.js"),
    ) as typeof import("./internalSeams.js");
    registerInternalSeams(context, { byHash, workspaces, extensionQuery, extensionInvoke, refreshAll, jsonObject });
  }

  context.subscriptions.push(
    folderWatcher,
    {
      dispose: () => {
        for (const stop of syncStops.values()) stop();
        syncStops.clear();
        void clientRegistry.close();
        registry.clear();
        if (activeClientRegistry === clientRegistry) activeClientRegistry = undefined;
      },
    },
    // ---- schedules (F23) ----
    vscode.commands.registerCommand("tachyon.approveProposalItem", async (item: ProposalItem) => {
      const ws = wsOf(item);
      if (ws) await ws.sidebar.mutateSidebar({ action: "proposal.approve", id: item.proposalId });
    }),
    vscode.commands.registerCommand("tachyon.rejectProposalItem", async (item: ProposalItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      const answer = await showNotification(
        vscode.l10n.t("Reject the proposed schedule '{0}'?", item.label as string),
        "warn",
        [vscode.l10n.t("Reject")],
        { modal: true },
      );
      if (answer === vscode.l10n.t("Reject")) await ws.sidebar.mutateSidebar({ action: "proposal.reject", id: item.proposalId });
    }),
    vscode.commands.registerCommand("tachyon.toggleSchedulePauseItem", async (item: ScheduleItem) => {
      const ws = wsOf(item);
      if (ws) await ws.sidebar.mutateSidebar({ action: "schedule.toggle-pause", id: item.scheduleName });
    }),
    vscode.commands.registerCommand("tachyon.deleteScheduleItem", async (item: ScheduleItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      const answer = await showNotification(
        vscode.l10n.t("Delete schedule '{0}'?", item.scheduleName),
        "warn",
        [vscode.l10n.t("Delete")],
        { modal: true },
      );
      if (answer === vscode.l10n.t("Delete")) await ws.sidebar.mutateSidebar({ action: "schedule.delete", id: item.scheduleName });
    }),
    vscode.commands.registerCommand("tachyon.editScheduleItem", async (item: ScheduleItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      const file = path.join(ws.workspaceRoot, ".tachyon", "schedules", `${item.scheduleName}.yml`);
      if (!fs.existsSync(file)) {
        notify(vscode.l10n.t("schedule '{0}' has no declaration file in this workspace", item.scheduleName), "warn");
        return;
      }
      const doc = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(doc, { preview: false });
    }),
    // ---- views ----
    vscode.commands.registerCommand("tachyon.refreshViews", refreshAll),
    vscode.commands.registerCommand("tachyon.openApprovals", async (hash?: string) => {
      // t-b30efd — compatibility command retained for palette, notice-inbox and legacy panel callers.
      // The command carries no item id, so its honest destination is the unified Inbox queue.
      const ws = hash ? byHash(hash) : await pickWorkspace();
      openHumanInboxTab(ws?.wsHash);
    }),
    // t-e76acc — one destination for "what is waiting on me", and the target of the Review action on
    // both the approval and the human-validation notices.
    // t-1f6d02 — optional `target` deep-links Control → Inbox → exact item (validation/approval/
    // saved-agent-proposal). Omitted target opens the list. Missing items fall back to the list
    // (cockpit inbox-item handshake).
    // t-d16698 — the accepted kinds come from `decodeHumanInboxDeepLink`, which derives them from
    // HUMAN_INBOX_KINDS. They used to be three literals written out here, unconnected to the
    // inventory the EMITTER is pinned to (`INBOX_REVIEW_TARGET`'s Record<HumanInboxKind, …>): a
    // fourth kind would have compiled, rung a doorbell, and silently landed the person on the queue.
    vscode.commands.registerCommand(
      "tachyon.openHumanInbox",
      async (hash?: string, target?: unknown) => {
        // SDD 485 D4 — the destination is the Inbox APP, not a Control route. Both halves of this
        // command move together: a targeted "Review" opens (or reveals) that project's tab AND lands it
        // on the item, and an untargeted palette invocation opens the queue. `openItem` navigates a
        // revealed panel rather than making a second one, which is what `dashboard` buys and what makes
        // "the item you were just told about" reachable from a tab that was already open.
        const ws = hash ? byHash(hash) : await pickWorkspace();
        const link = decodeHumanInboxDeepLink(target);
        if (ws && link.target === "item") {
          humanInboxPanels.openItem(ws.wsHash, link.itemKind, link.itemId);
          return;
        }
        openHumanInboxTab(ws?.wsHash);
      },
    ),
    vscode.commands.registerCommand("tachyon.resolveApproval", async (arg: { id?: string; decision?: "approved" | "denied"; wsHash?: string }) => {
      const ws = targetOf(arg?.wsHash);
      if (!ws || !arg?.id || (arg.decision !== "approved" && arg.decision !== "denied")) return;
      try {
        await extensionInvoke(ws, { action: "approval.resolve", id: arg.id, decision: arg.decision });
        notify(`approval request ${arg.id} ${arg.decision}`);
        refreshAll();
        humanInboxPanels.refresh();
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), "error");
        humanInboxPanels.refresh();
      }
    }),
    // t-aaad95 — `tachyon.openSettings` (which opened VS Code's settings page filtered to this
    // extension) was removed with the last contributed key: it would now open an empty page.
    // `tachyon.openGlobalSettings` above opens the file that actually holds these settings.
    // t-7bcba6 — tachyon.persistenceSettings (Visible legacy reminders / silentHooks kill switch) removed.
    // ---- server inspector (F27) — cross-workspace socket queries; Control → tmux (t-610705 Phase B #5) ----
    // SDD 485 D1 — the tmux Server Inspector opens as its own editor tab, or reveals the one already open.
    vscode.commands.registerCommand("tachyon.inspectServer", () => { tmuxPanels.open(); }),
    // 514 — install an app from a zip the human picked. The PATH travels to the engine, not the
    // bytes: both sides share a filesystem in every supported topology, and a second transport for
    // multi-megabyte archives would be one more thing to keep correct for nothing.
    vscode.commands.registerCommand("tachyon.installApp", async () => {
      const ws = (controlWorkspaceScope.current ? byHash(controlWorkspaceScope.current) : undefined) ?? workspaces()[0];
      if (!ws) {
        notify(vscode.l10n.t("No Tachyon workspace is attached in this window, so there is nowhere to install an app."), "warn");
        return;
      }
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: vscode.l10n.t("Install app"),
        filters: { "App package": ["zip"] },
      });
      const zip = picked?.[0];
      if (!zip) return;
      try {
        const payload = jsonObject(await extensionInvoke(ws, { action: "app.install", zipPath: zip.fsPath }), "app.install");
        const id = String(payload.id ?? "");
        // A reinstall replaces the directory the open tab was serving, so the tab is closed rather
        // than left rendering bytes that no longer exist. Reopening it is one click on the tile.
        if (id) userAppPanels.close(id);
        await refreshInstalledApps();
        notify(vscode.l10n.t("Installed app '{0}'.", String(payload.title ?? id)));
      } catch (error) {
        // What failed and why, said once: a bad zip is the human's to fix, not a Tachyon fault.
        notify(error instanceof Error ? error.message : String(error), "error");
      }
    }),
    // ---- Control (desktop MVP, t-fe52f0 frente 1) — editor sysadmin; palette + launcher tiles ----
    // t-6e2952 — optional section opens/navigates the singleton Control (no second panel). The
    // sidebar header view/title button was removed; the launcher tab is the primary door.
    vscode.commands.registerCommand("tachyon.openControl", (section?: unknown) => {
      if (typeof section === "string" && section.trim()) {
        // SDD 485 C5 — the launcher tile is still ONE door for all twelve; what changed is where the Board's
        // id lands. Routed here rather than in the sidebar so the sidebar never has to learn which of the
        // twelve are apps — Phase D flips ten more ids through this same line.
        // SDD 500 — the raw id is decoded first, then resolved to the section that actually RENDERS
        // it. Two steps, because they answer two questions: `overview` and `engine` still decode (the
        // eight defaults in route.ts name `"overview"` at the call site by decision), and both land on
        // System. Composing them here rather than folding the alias into the decoder keeps a persisted
        // or deep-linked id READABLE instead of rewriting it.
        // 514 — an installed app is routed here for the same reason the Board is: the sidebar must
        // never have to learn which ids are apps. It is checked BEFORE the built-in resolution
        // because `resolveSectionDestination` only knows the compiled twelve, and an unknown id
        // there falls back to System — which is exactly how an app tile used to open the wrong screen.
        const userAppId = appIdOfSection(section);
        if (userAppId) return openUserApp(userAppId);
        const resolved = resolveSectionDestination(resolveSection(section));
        if (resolved === "mission") {
          openBoard();
          return Promise.resolve();
        }
        // SDD 485 D1 — the second id to leave Control through this line, and the shape Phase D repeats.
        if (resolved === "tmux") {
          tmuxPanels.open();
          return Promise.resolve();
        }
        // SDD 485 D2 — the third.
        if (resolved === "plugins") {
          openPluginsTab();
          return Promise.resolve();
        }
        // SDD 485 D3 — the fourth, and the second that takes no argument (a `window` app has nothing to
        // key on). This is also the line `tachyon.openControlRuntime` funnels into below.
        if (resolved === "runtime") {
          runtimeOpsPanels.open();
          return Promise.resolve();
        }
        // SDD 485 D4 — the fifth, and the second that resolves a PROJECT (a dashboard is opened against
        // one). The tile is short for the surface's product name: the id is `inbox`, the app is the
        // Human Inbox, and `openHumanInboxTab` picks the same scope Control would have rendered it for.
        if (resolved === "inbox") {
          openHumanInboxTab();
          return Promise.resolve();
        }
        if (resolved === "approvals" || resolved === "validations") {
          openHumanInboxTab();
          return Promise.resolve();
        }
        if (resolved === "worktrees") {
          openWorktreesTab();
          return Promise.resolve();
        }
        if (resolved === "keys") {
          openKeysTab();
          return Promise.resolve();
        }
        if (resolved === "design-mode") {
          const ws = (controlWorkspaceScope.current ? byHash(controlWorkspaceScope.current) : undefined) ?? workspaces()[0];
          if (!ws) {
            notify(vscode.l10n.t("No Tachyon workspace is attached in this window."), "warn");
            return Promise.resolve();
          }
          if (ws.config?.settings?.ideBrowser?.enabled !== true) {
            settingsPanels.openIdeBrowser(ws.wsHash);
            return Promise.resolve();
          }
          // Owner dogfood, 2026-08-20: armed iff the browser is open. `designModeOn` owns browser
          // creation/navigation as well as arming, and closing that browser disposes CDP → OFF.
          return vscode.commands.executeCommand("tachyon.ideBrowserBridge.designModeOn");
        }
        if (resolved === "runtime-config") {
          openRuntimeConfigTab();
          return Promise.resolve();
        }
        if (resolved === "settings") {
          openSettingsTab();
          return Promise.resolve();
        }
        if (resolved === "companion") { openCompanionTab(); return Promise.resolve(); }
        // SDD 500 — `overview` and `engine` reach this arm ALIASED, so there is no branch of their own
        // to read: `resolveSectionDestination` mapped both to `system` above, which is the whole of D1.
        if (resolved === "system") {
          openSystemTab();
          return Promise.resolve();
        }
        // t-5f2b5b — `fleet` has NO arm any more and deliberately falls through here. The app is deleted
        // (owner decision: the sidebar Agents tab is the only fleet), but the id still DECODES, because it
        // is the parent section of the agent-activity/agent-probes subroutes and of five studios. A stale
        // deep link or a persisted pre-deletion state therefore lands on System instead of a section
        // nothing renders — the same answer the retired `tachyonCockpit` tombstone gives.
        openSystemTab();
        return Promise.resolve();
      }
      openSystemTab();
      return Promise.resolve();
    }),
    // SDD 500 — `tachyon.inspectEngine` keeps its name and its palette entry and lands on System: the
    // engine detail it opened is still the whole lower half of that screen, so this is one destination
    // changing, not a command retiring.
    vscode.commands.registerCommand("tachyon.inspectEngine", () => { openSystemTab(); }),
    // SDD 485 C5 — the Board opens as its own editor tab (same as tachyon.board without the pick).
    vscode.commands.registerCommand("tachyon.openControlMission", () => { openBoard(); }),
    // SDD 485 D3 — Runtime Ops opens as its own editor tab, or reveals the one already open. The command
    // id keeps its `openControl` spelling on purpose: `tachyon.showRuntimeUsage` and
    // `apps/vscode-extension/src/runtimeOps/openRuntimeOps.ts` both route through it, and renaming it inside a cutover would
    // churn three call sites to say the same thing (the same call C5 made for the `board`
    // directory name).
    vscode.commands.registerCommand("tachyon.openControlRuntime", () => { runtimeOpsPanels.open(); }),
    // t-505f13 — Onboarding opens as its own editor tab, or reveals the one already open. The
    // sidebar's unconfigured state and the palette both route through here.
    vscode.commands.registerCommand("tachyon.openOnboarding", () => { onboardingPanels.open(); }),
    // t-75fd3c — deep-link straight to a task's detail subroute (the host-agnostic EngineHost.openTask
    // port calls this by name, same indirection focusPrimaryView() uses for tachyonSidebarPrototype.focus).
    // SDD 485 C4 — the same command name and the same (wsHash, taskId) contract the host-agnostic
    // EngineHost.openTask port calls by name; what changed is the destination: the task's OWN editor tab,
    // opened or revealed, instead of a subroute inside Control.
    vscode.commands.registerCommand("tachyon.openControlTask", (wsHash: string, taskId: string) =>
      taskDetailPanels.open(wsHash, taskId),
    ),
    vscode.commands.registerCommand("tachyon.checkRequirements", async () => {
      const r = await doctor();
      if (r.ok) {
        const probe = await probeServer();
        if (probe.state === "wedged") {
          notify(vscode.l10n.t("the tmux server is wedged — run 'Tachyon: Restart tmux Server' to ask the persistent engine to recover it."), "warn");
          return;
        }
        notify(vscode.l10n.t("Requirements OK — tmux {0} detected.", r.version));
      } else {
        void showNotification(r.message, "warn", [vscode.l10n.t("tmux install docs")])
          .then((c) => {
            if (c === vscode.l10n.t("tmux install docs")) void vscode.env.openExternal(vscode.Uri.parse("https://github.com/tmux/tmux/wiki/Installing"));
          });
      }
    }),
    // t-8354ae — fail-visible forensics: config + ledger + tmux + bridge + LKG
    vscode.commands.registerCommand("tachyon.doctor", async (hash?: string) => {
      const ws = hash ? byHash(hash) : workspaces()[0];
      if (!ws) {
        notify(vscode.l10n.t("no Tachyon workspace is active"), "warn");
        return;
      }
      const report = jsonObject(await extensionQuery(ws, { action: "doctor.report" }), "doctor.report");
      if (typeof report.text !== "string" || typeof report.hasErrors !== "boolean") {
        throw new Error("Tachyon Doctor returned an invalid report");
      }
      const channel = vscode.window.createOutputChannel("Tachyon Doctor");
      channel.clear();
      channel.append(report.text);
      channel.show(true);
      notify(
        report.hasErrors
          ? vscode.l10n.t("Tachyon Doctor found problems — see the Output panel")
          : vscode.l10n.t("Tachyon Doctor report ready — see the Output panel"),
        report.hasErrors ? "warn" : "info",
      );
    }),
    vscode.commands.registerCommand("tachyon.openConfig", async (hash?: string) => {
      const ws = hash ? byHash(hash) : workspaces()[0];
      if (!ws) {
        notify(vscode.l10n.t("no Tachyon workspace is active"), "warn");
        return;
      }
      const file = configPathOf(ws) ?? workspaceSettingsPath(ws.workspaceRoot);
      try {
        const doc = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch (err) {
        notify(vscode.l10n.t("Could not open config: {0}", err instanceof Error ? err.message : String(err)), "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.restartTmuxServer", async () => {
      const ws = workspaces()[0];
      if (!ws) {
        notify(vscode.l10n.t("no Tachyon workspace is active"), "warn");
        return;
      }
      try {
        const result = jsonObject(await extensionInvoke(ws, { action: "tmux.recover" }), "tmux.recover");
        if (result.state === "recovered") {
          notify(vscode.l10n.t("tmux server recovered — the next start boots a fresh one."));
        } else if (result.state === "no-server") {
          notify(vscode.l10n.t("no tmux server running — nothing to recover."));
        } else if (result.state === "healthy") {
          notify(vscode.l10n.t("tmux server is healthy — nothing to recover."));
        } else if (result.state === "busy") {
          notify(vscode.l10n.t("tmux recovery is already running in another Tachyon engine."), "warn");
        } else {
          notify(vscode.l10n.t("tmux recovery was refused because the server identity changed or could not be proven."), "warn");
        }
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.restartBridge", async (hash?: string) => {
      const targets = hash ? [byHash(hash)].filter((ws): ws is WorkspaceShellHandle => !!ws) : workspaces();
      if (targets.length === 0) {
        notify(vscode.l10n.t("no Tachyon workspace is active"), "warn");
        return;
      }
      const results = await Promise.allSettled(targets.map((ws) => extensionInvoke(ws, { action: "bridge.restart" })));
      const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failures.length > 0) {
        notify(vscode.l10n.t("Bridge restart failed: {0}", failures.map((f) => f.reason instanceof Error ? f.reason.message : String(f.reason)).join("; ")), "error");
        return;
      }
      refreshAll();
      notify(vscode.l10n.t("Bridge restarted for {0} workspace(s).", targets.length));
    }),
    vscode.commands.registerCommand("tachyon.stopBridge", async (hash?: string) => {
      const targets = hash ? [byHash(hash)].filter((ws): ws is WorkspaceShellHandle => !!ws) : workspaces();
      if (targets.length === 0) {
        notify(vscode.l10n.t("no Tachyon workspace is active"), "warn");
        return;
      }
      const results = await Promise.allSettled(targets.map((ws) => extensionInvoke(ws, { action: "bridge.stop" })));
      const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failures.length > 0) {
        notify(`Bridge stop failed: ${failures.map((f) => f.reason instanceof Error ? f.reason.message : String(f.reason)).join("; ")}`, "error");
        return;
      }
      refreshAll();
      notify(`Bridge stopped for ${targets.length} workspace(s).`);
    }),
    // ---- init / bootstrap (F5) ----
    vscode.commands.registerCommand("tachyon.init", async () => {
      const open = vscode.workspace.workspaceFolders ?? [];
      if (open.length === 0) {
        notify(vscode.l10n.t("open a folder first, then run Tachyon: Init"), "warn");
        return;
      }
      let folder = open[0];
      if (open.length > 1) {
        // t-be359b — STAYS NATIVE. Init runs BEFORE any folder is a Tachyon workspace: the candidates
        // are raw `workspaceFolders`, which no webview model of ours carries (the sidebar projects
        // CONFIGURED roots only, and while none exists it is showing the Initialize welcome, not a
        // fleet). No candidate set in the webview means nothing for a product picker to list.
        const picked = await vscode.window.showQuickPick(
          open.map((f) => ({ label: f.name, description: f.uri.fsPath, f })),
          { placeHolder: vscode.l10n.t("Initialize Tachyon in which folder?") },
        );
        if (!picked) return;
        folder = picked.f;
      }
      const root = folder.uri.fsPath;
      if (hasConfig(root)) {
        // Don't block the command on the user's click (it would hang headless) —
        // offer "Open it" as a fire-and-forget follow-up.
        void showNotification(vscode.l10n.t("'{0}' is already a Tachyon workspace.", folder.name), "info", [vscode.l10n.t("Open settings")])
          .then(async (choice) => {
            if (choice === vscode.l10n.t("Open settings")) {
              await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(workspaceSettingsPath(root)), { preview: false });
            }
          });
        return;
      }
      // Detect the stack from manifests present (the only I/O — generation is pure).
      const manifests = ["package.json", "composer.json", "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt", "Gemfile"];
      const files = manifests.filter((m) => fs.existsSync(path.join(root, m)));
      const readText = (n: string): string | undefined => {
        const p = path.join(root, n);
        return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined;
      };
      const detected: DetectedProject = { files, installedClis: await detectInstalledClis() };
      const pkgRaw = readText("package.json");
      if (pkgRaw) {
        try {
          detected.packageJson = JSON.parse(pkgRaw);
        } catch {
          /* malformed package.json — generate without script hints */
        }
      }
      detected.composerJson = readText("composer.json");
      detected.gemfile = readText("Gemfile");

      const starter = buildStarterFiles(detected);
      const target = workspaceSettingsPath(root);
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, starter.settingsYaml, "utf8");
        const terminalsDir = path.join(root, ".tachyon", "terminals");
        fs.mkdirSync(terminalsDir, { recursive: true });
        for (const terminal of starter.terminals) {
          const declaration = path.join(terminalsDir, `${terminal.name}.yml`);
          if (!fs.existsSync(declaration)) fs.writeFileSync(declaration, terminal.yaml, "utf8");
        }
      } catch (err) {
        notify(vscode.l10n.t("could not write {0}: {1}", WORKSPACE_SETTINGS_FILE, err instanceof Error ? err.message : String(err)), "error");
        return;
      }
      // Keep the machine-local resume ledger out of git (it carries session ids
      // + absolute cwd). Idempotent + non-fatal — pins.json stays shareable.
      try {
        const gi = path.join(root, ".gitignore");
        const next = ensureTachyonGitignore(fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : undefined);
        if (next !== null) fs.writeFileSync(gi, next, "utf8");
      } catch {
        /* .gitignore is a courtesy, never block Init on it */
      }
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target), { preview: false });
      notify(vscode.l10n.t("{0} created (terminals in .tachyon/terminals/) — review it, then ▶ an agent in the sidebar", WORKSPACE_SETTINGS_FILE));
      // Bring the folder under orchestration now (it wasn't a Workspace before).
      if (!registry.has(root)) await addWorkspace(root, true);
      refreshAll();
    }),
    // ---- pins ----
    vscode.commands.registerCommand("tachyon.addPin", async (arg?: unknown) => {
      // Invoked with preset text (programmatic), a category tree node (inline +),
      // or nothing (palette).
      const text = typeof arg === "string" ? arg : undefined;
      const node = arg && typeof arg === "object" ? (arg as { workspaceHash?: string; ws?: WorkspacePresentationTarget }) : undefined;
      const ws = (node?.workspaceHash ? byHash(node.workspaceHash) : node?.ws ? wsOf({ ws: node.ws }) : undefined) ?? (await pickWorkspace());
      if (!ws) return;
      if (text === undefined) {
        pinDetailPanels.openCreate(ws.wsHash, mintPinId());
        return;
      }
      if (text.trim().length === 0) return;
      try {
        await extensionInvoke(ws, { action: "pin.create", text, by: "human", done: false });
        refreshAll();
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.deletePinItem", async (item: PinItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      try {
        await ws.sidebar.mutateSidebar({ action: "pin.delete", id: item.pinId });
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.editPinItem", async (item: PinItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      pinDetailPanels.openEdit(ws.wsHash, item.pinId);
    }),
    // ---- agents ----
    vscode.commands.registerCommand("tachyon.spawnAgentItem", async (item: AgentItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      try {
        await invokeAgentLifecycle(ws, "agent.start", item.agentName);
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.stopAgentItem", async (item: AgentItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      try {
        const result = await invokeAgentLifecycle(ws, "agent.stop", item.agentName);
        if (result.method !== "agent.stop" || result.status !== "ok") return;
        if (result.outcome === "alive") {
          notify(vscode.l10n.t("Stop was sent to '{0}', but the process is still running. Use Kill to force it.", item.agentName), "warn");
        } else if (result.outcome === "unknown") {
          notify(vscode.l10n.t("Stop was sent to '{0}', but Tachyon could not confirm whether the process exited.", item.agentName), "warn");
        }
      } catch (err) {
        console.log(`[tachyon] stopAgentItem failed agent=${item.agentName}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.killAgentItem", async (item: AgentItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      try {
        await invokeAgentLifecycle(ws, "agent.kill", item.agentName);
      } catch (err) {
        console.log(`[tachyon] killAgentItem failed agent=${item.agentName}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    // spec 389 — one-click Restart = graceful+resume; variants are separate more-menu commands (no QuickPick).
    vscode.commands.registerCommand("tachyon.restartAgentItem", async (item: AgentItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      try {
        await invokeAgentLifecycle(ws, "agent.restart", item.agentName, RESTART_DEFAULT);
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.restartAgentNewItem", async (item: AgentItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      try {
        await invokeAgentLifecycle(ws, "agent.restart", item.agentName, RESTART_NEW);
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.restartAgentForceNewItem", async (item: AgentItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      try {
        await invokeAgentLifecycle(ws, "agent.restart", item.agentName, RESTART_FORCE_NEW);
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.openAgentTerminalItem", async (agent: string, hash?: string) => {
      const ws = targetOf(hash);
      const projected = ws ? agentProjection(ws, agent) : undefined;
      if (!ws) {
        notify(vscode.l10n.t("Cannot open terminal — workspace is not active"), "error");
        return;
      }
      if (!projected) {
        notify(vscode.l10n.t("Cannot open terminal for '{0}' — agent is not in the live roster", agent), "error");
        return;
      }
      try {
        await presentTerminal(ws, agent, projected.session);
        // t-a39c7d — human eyes on pane: done(unseen) → idle.
        await ws.markAgentPaneSeen(agent);
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), "error");
      }
    }),
    // t-610355 — open layer-2 first-party agent pane (runtime TUI in Tachyon webview). Does not replace integrated terminal.
    vscode.commands.registerCommand("tachyon.openAgentPaneItem", async (agent: string, hash?: string) => {
      try {
        await openAgentPane(agent, hash);
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.openAgentPane", async () => {
      const ws = await pickWorkspace();
      if (!ws) return;
      const agent = await pickAgent(ws, vscode.l10n.t("Open which agent's pane?"), true);
      if (!agent) return;
      try {
        await openAgentPane(agent, ws.wsHash);
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), "error");
      }
    }),
    // spec 238 / t-610705 (Phase C.2) — open the normalized activity cockpit for an agent, inside
    // Control (the terminal stays the escape hatch). Silent first-workspace fallback when hash is
    // omitted, matching the retired standalone panel's own resolution (not a picker prompt — this
    // command is mostly invoked from a Fleet row that already knows its own wsHash).
    vscode.commands.registerCommand("tachyon.openAgentActivity", async (agent: string, hash?: string) => {
      const ws = hash ? byHash(hash) : workspaces()[0];
      if (ws) activityPanels.open(ws.wsHash, agent);
    }),
    // 0.29.1 — raw transcript escape hatch, demoted from the Activity header button to a palette command.
    vscode.commands.registerCommand("tachyon.openAgentTranscript", () => activityPanels.openTranscript()),
    // spec 245 — open the read-only Project Handoff panel for a workspace root (from the sidebar header button).
    // spec 297 — resolve the target folder via the shared picker when no hash is passed (no silent folder[0]
    // in a multi-root window); an explicit hash (e.g. the sidebar handoff bar) is honored verbatim.
    vscode.commands.registerCommand("tachyon.openProjectHandoff", async (hash?: string) => {
      const ws = hash ? byHash(hash) : await pickWorkspace();
      if (ws) openHandoffTab(ws.wsHash);
    }),
    vscode.commands.registerCommand("tachyon.openPlugins", async (hash?: string) => {
      // SDD 485 D2 — Plugins opens as its own editor tab, or reveals the one already open for this
      // project. The workspace picker stays: this is the door a human takes with no project in hand, and
      // a dashboard has to be opened against one.
      const ws = hash ? byHash(hash) : await pickWorkspace();
      openPluginsTab(ws?.wsHash);
    }),
    // spec 335 — open the Board for one project. SDD 485 C5: its own editor tab, revealed if already open.
    vscode.commands.registerCommand("tachyon.board", async (hash?: string) => {
      const ws = hash ? byHash(hash) : await pickWorkspace();
      if (!ws) return;
      openBoard(ws.wsHash);
    }),
    // spec 339 — open Task Studio in new-task mode from the command palette (mirrors the board's own
    // "+ Task" button and the card context menu's "Edit in Studio", both of which route through the
    // webview's openTaskStudio action instead of a command).
    vscode.commands.registerCommand("tachyon.taskStudio.new", async (hash?: string) => {
      const ws = hash ? byHash(hash) : await pickWorkspace();
      if (ws) taskDetailPanels.openCreate(ws.wsHash, mintTaskId());
    }),
    // spec 322 — per-agent probes: the agent row's "…" action passes (hash, agent) and gets that agent's
    // probes only. The no-arg/agent-less form opens the UNFILTERED list — an internal/debug escape hatch for
    // caller-less or orphaned records (not contributed to any menu/palette; probes are per-agent in the UI).
    vscode.commands.registerCommand("tachyon.openProbes", async (hash?: string, agent?: string) => {
      const ws = hash ? byHash(hash) : await pickWorkspace();
      if (!ws) return;
      probesPanels.open(ws.wsHash, agent);
    }),
    // ---- session resume (F29 / spec 209) ----
    vscode.commands.registerCommand("tachyon.resumeAgentItem", async (item: AgentItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      try {
        await invokeAgentLifecycle(ws, "agent.resume", item.agentName);
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    // ---- session fork (spec 225) ----
    vscode.commands.registerCommand("tachyon.forkAgentItem", async (item: AgentItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      try {
        // Fail-closed plan first (resolves the live uuid; throws if not forkable yet) — then confirm.
        const plan = jsonObject(await extensionQuery(ws, { action: "agent.fork-preview", agent: item.agentName }), "agent.fork-preview");
        if (typeof plan.forkName !== "string") throw new Error("fork preview did not return a sibling name");
        const lines = [
          vscode.l10n.t("Fork '{0}' into a new sibling agent '{1}'?", item.agentName, plan.forkName),
          vscode.l10n.t("The fork carries the conversation up to now; the original keeps running, untouched."),
        ];
        if (plan.sourceWorktree && typeof plan.sourceWorktree === "object" && !Array.isArray(plan.sourceWorktree)) {
          const source = jsonObject(plan.sourceWorktree, "fork source worktree");
          if (typeof source.branch === "string") lines.push(vscode.l10n.t("It gets its own worktree, branched off '{0}' (committed work only).", source.branch));
        }
        if (plan.dirty === true) lines.push(vscode.l10n.t("⚠ Uncommitted changes in the original are NOT carried into the fork."));
        const forkLabel = vscode.l10n.t("Fork");
        const answer = await showNotification(lines.join("\n"), "warn", [forkLabel], { modal: true });
        if (answer !== forkLabel) return;
        const result = jsonObject(await extensionInvoke(ws, { action: "agent.fork", agent: item.agentName }), "agent.fork");
        if (typeof result.agent !== "string") throw new Error("fork did not return the created agent");
        const created = result.agent;
        notify(vscode.l10n.t("Forked '{0}' → '{1}'", item.agentName, created));
        refreshAll();
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "warn");
      }
    }),
    vscode.commands.registerCommand("tachyon.resumeAll", async () => {
      const targets: WorkspaceShellHandle[] = [];
      for (const ws of workspaces()) {
        const fleet = await ws.sidebar.loadSidebar();
        if ([...fleet.agents, ...fleet.terminals].some((agent) => agent.resumable)) targets.push(ws);
      }
      if (targets.length === 0) {
        notify(vscode.l10n.t("no agents to resume"));
        return;
      }
      for (const ws of targets) await extensionInvoke(ws, { action: "agent.resume-all" });
    }),
    vscode.commands.registerCommand("tachyon.runPipeline", async () => {
      const ws = await pickWorkspace();
      if (!ws) return;
      const inspected = jsonObject(await extensionQuery(ws, { action: "pipeline.inspect" }), "pipeline.inspect");
      const names = jsonArray(inspected.names, "pipeline names").filter((name): name is string => typeof name === "string");
      if (names.length === 0) {
        notify(vscode.l10n.t("no pipelines found — add one under .tachyon/pipelines/<name>.yml"), "warn");
        return;
      }
      // t-be359b — STAYS NATIVE. Palette-only command (the sidebar and tree run the pipeline they
      // were clicked on, via tachyon.runPipelineItem), and it opens with `await pickWorkspace()`.
      const name = names.length === 1 ? names[0] : await vscode.window.showQuickPick(names, { placeHolder: vscode.l10n.t("Run which pipeline?") });
      if (!name) return;
      await startPipelineWithInput(ws, name);
    }),
    vscode.commands.registerCommand("tachyon.approvePipelineNodeItem", async (item: PipelineNodeItem) => {
      const ws = wsOf(item);
      if (ws && item.runId && item.nodeId) await extensionInvoke(ws, { action: "pipeline.approve", runId: item.runId, nodeId: item.nodeId });
    }),
    vscode.commands.registerCommand("tachyon.rejectPipelineNodeItem", async (item: PipelineNodeItem) => {
      const ws = wsOf(item);
      if (ws && item.runId && item.nodeId) await extensionInvoke(ws, { action: "pipeline.reject", runId: item.runId, nodeId: item.nodeId });
    }),
    vscode.commands.registerCommand("tachyon.runPipelineItem", async (item: PipelineDefItem) => {
      const ws = wsOf(item);
      if (ws) await startPipelineWithInput(ws, item.pipelineName);
    }),
    vscode.commands.registerCommand("tachyon.editPipelineInputItem", async (item: PipelineDefItem) => {
      const ws = wsOf(item);
      if (!ws || !item.run) return;
      const inspected = jsonObject(await extensionQuery(ws, { action: "pipeline.inspect", runId: item.run.id }), "pipeline.inspect");
      if (inspected.inputExists !== true || typeof inspected.inputPath !== "string") {
        notify(vscode.l10n.t("run '{0}' has no input (this pipeline declares input: none)", item.run.id), "info");
        return;
      }
      await vscode.window.showTextDocument(vscode.Uri.file(inspected.inputPath));
      const pick = await showNotification(
        vscode.l10n.t("Edit the input for run '{0}', save, then Apply (only not-yet-started nodes use it).", item.run.id),
        "info",
        [vscode.l10n.t("Apply")],
      );
      if (pick === vscode.l10n.t("Apply")) await extensionInvoke(ws, { action: "pipeline.apply-input", runId: item.run.id });
    }),
    vscode.commands.registerCommand("tachyon.cancelPipelineItem", async (item: PipelineDefItem) => {
      const ws = wsOf(item);
      if (!ws || !item.run) return;
      const ok = await showNotification(
        vscode.l10n.t("Cancel pipeline run '{0}'?", item.pipelineName),
        "warn",
        [vscode.l10n.t("Cancel run")],
        { modal: true },
      );
      if (ok) { await extensionInvoke(ws, { action: "pipeline.cancel", runId: item.run.id }); refreshAll(); }
    }),
    vscode.commands.registerCommand("tachyon.rerunPipelineNodeItem", async (item: PipelineNodeItem) => {
      const ws = wsOf(item);
      if (!ws || !item.runId || !item.nodeId) return;
      const ok = await showNotification(
        vscode.l10n.t("Re-run from '{0}'? This discards that node and everything after it, then re-runs.", item.nodeId),
        "warn",
        [vscode.l10n.t("Re-run")],
        { modal: true },
      );
      if (ok) await extensionInvoke(ws, { action: "pipeline.rerun", runId: item.runId, nodeId: item.nodeId });
    }),
    vscode.commands.registerCommand("tachyon.dismissPipelineRunItem", async (item: PipelineDefItem) => {
      const ws = wsOf(item);
      if (!ws || !item.run) return;
      await extensionInvoke(ws, { action: "pipeline.dismiss", runId: item.run.id });
      refreshAll(); // dismiss() just finalizes+deletes the run (no engine tick) → refresh both UIs ourselves
    }),
    vscode.commands.registerCommand("tachyon.editPipelineItem", async (item: PipelineDefItem) => {
      const ws = wsOf(item);
      if (ws) {
        const inspected = jsonObject(await extensionQuery(ws, { action: "pipeline.inspect", name: item.pipelineName }), "pipeline.inspect");
        if (typeof inspected.filePath === "string") await vscode.window.showTextDocument(vscode.Uri.file(inspected.filePath));
      }
    }),
    vscode.commands.registerCommand("tachyon.deletePipelineItem", async (item: PipelineDefItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      const ok = await showNotification(
        vscode.l10n.t("Delete pipeline '{0}'? This removes its .yml definition.", item.pipelineName),
        "warn",
        [vscode.l10n.t("Delete")],
        { modal: true },
      );
      if (ok) await extensionInvoke(ws, { action: "pipeline.delete", name: item.pipelineName });
    }),
    vscode.commands.registerCommand("tachyon.agentStudio", async () => {
      const ws = await pickFolderForCreate();
      if (!ws) return;
      studioPanels.agent.openNew(ws.wsHash);
    }),
    // t-be359b — `hash` is how a caller that ALREADY asked says which folder it got. The sidebar draws
    // the product QuickPicker over its own fleet list and sends the answer; the Command Palette sends
    // nothing and falls through to pickFolderForCreate's native list, which is the right product for a
    // door with no surface of ours on screen. Same shape as `byHash(hash) ?? pickWorkspace()` elsewhere.
    vscode.commands.registerCommand("tachyon.newAgentStudio", async (hash?: string) => {
      const ws = byHash(hash) ?? (await pickFolderForCreate());
      if (!ws) return;
      studioPanels.agent.openNew(ws.wsHash);
    }),
    vscode.commands.registerCommand("tachyon.terminalStudio", async (hash?: string) => {
      const ws = byHash(hash) ?? (await pickFolderForCreate());
      if (!ws) return;
      studioPanels.terminal.openNew(ws.wsHash);
    }),
    vscode.commands.registerCommand("tachyon.editAgentStudioItem", async (item: AgentItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      const def = ws.config?.agents[item.agentName];
      if (!def) {
        notify(vscode.l10n.t("'{0}' is not a Saved Agent (a Temporary instance has no stored definition)", item.agentName), "warn");
        return;
      }
      // t-610705 (Phase D, D1a/D1b) — both branches are Control routes now.
      const dispatch = {
        agent: () => studioPanels.agent.openExisting(ws.wsHash, item.agentName),
        terminal: () => studioPanels.terminal.openExisting(ws.wsHash, item.agentName),
      } satisfies Record<"agent" | "terminal", () => void>;
      dispatch[def.kind === "terminal" ? "terminal" : "agent"]();
    }),
    vscode.commands.registerCommand("tachyon.cloneAgentItem", async (item: AgentItem, newNameArg?: string) => {
      const ws = wsOf(item);
      if (!ws) return;
      const newName =
        newNameArg ??
        (await vscode.window.showInputBox({
          prompt: vscode.l10n.t("Clone '{0}' as…", item.agentName),
          value: `${item.agentName}-2`,
          validateInput: (v) => (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(v) ? undefined : vscode.l10n.t("letters/digits/_/-, starting with a letter")),
        }));
      if (!newName) return;
      await extensionInvoke(ws, { action: "config.agent.clone", agent: item.agentName, newName });
    }),
    // t-4662e9 — `tachyon.renameAgentItem` is gone with the sidebar action that was its only caller
    // (it was hidden from the palette by `when: false`, so nothing else could reach it). The Agent
    // Form owns renaming a canonical agent. The `config.agent.rename` runtime-api operation stays:
    // it is a declared EXTENSION_COMMAND_ACTIONS entry served by extensionOperationService, reachable
    // by API clients independently of this command.
    // t-e722ce — `tachyon.removeWorktreeItem` is gone with the sidebar action that was its only
    // caller. A Saved Agent's checkout is released by Agent Studio → Forget, as one planned step of
    // the cascade; a standalone button that took the checkout and left the agent was a second human
    // surface for the same possession, and it read the ledger while the card that offered it read the
    // registry. `worktree.remove` stays as a runtime-api operation for API/Bridge clients.
    //
    // `tachyon.deleteAgentItem` below survives ONLY for the rows Agent Studio cannot address —
    // Temporary instances (no canonical profile to forget) and declared terminals (no Studio page).
    // The gate is `actionsFor` in packages/webview-ui/src/sidebar/actions.ts, which is the sole reachable caller: the
    // palette entry is `when: false`, so nothing else can invoke it.
    vscode.commands.registerCommand("tachyon.deleteAgentItem", async (item: AgentItem, forceArg?: boolean) => {
      const ws = wsOf(item);
      if (!ws) return;
      const temporary = isTemporaryItem(item.contextValue);
      const inspected = await agentInspection(ws, item.agentName);
      const hasSession = agentProjection(ws, item.agentName)?.running === true;
      const wtRec = inspected.worktree;
      if (wtRec) {
        // spec 210 — a worktree agent's confirmation IS the worktree-cleanup modal; when it succeeds,
        // continue with the unified Remove flow below (undeclare/forget + durable per-agent cleanup).
        if (forceArg) {
          await extensionInvoke(ws, { action: "worktree.remove", agent: item.agentName });
        } else {
          const outcome = await confirmAndRemoveWorktree(ws, item.agentName, wtRec, inspected.status);
          if (outcome === "blocked") return;
          if (outcome === "kept") return; // declined or failed worktree removal: destroy nothing else
        }
      } else if (!forceArg) {
        const retention = vscode.l10n.t(
          "Tachyon activity, pane transcripts, and the agent private runtime home are deleted. A harness home keeps its runtime-native caches, which are not a uniform archive.",
        );
        const effects = temporary
          ? (hasSession
            ? vscode.l10n.t("This kills its tmux session and deletes its saved state. {0}", retention)
            : vscode.l10n.t("This deletes its saved state. {0}", retention))
          : (hasSession
            ? vscode.l10n.t("This removes its .tachyon/agents entry, kills its tmux session, and deletes its saved state.")
            : vscode.l10n.t("This removes its .tachyon/agents entry and deletes its saved state."));
        const prompt = vscode.l10n.t("Remove agent '{0}'? {1}", item.agentName, effects);
        const confirmLabel = vscode.l10n.t("Remove");
        const answer = await showNotification(prompt, "warn", [confirmLabel], { modal: true });
        if (answer !== confirmLabel) return;
      }
      await extensionInvoke(ws, { action: "config.agent.delete", agent: item.agentName, removeWorktree: false });
      refreshAll();
    }),
    vscode.commands.registerCommand("tachyon.reviewWorktreeItem", async (item?: AgentItem | WorktreeRowItem) => {
      // spec 213 / C2 — review the agent's work: a quick-pick of changed files (base ↔ current).
      // SDD 501 — the SAME command, reached from the land block by the managed-registry row id. Which
      // identity arrived decides only what is resolved; the flow both reach is the one below.
      // t-ea5425 — and `select` decides only which chrome picks the file. It is read on the worktree-row
      // arm alone: that door's caller is the Worktrees WEBVIEW, which has a picker of its own to draw in.
      // A tree item has no such surface, so the agent arm keeps the native list and passes nothing.
      // t-a0d820 — the palette door (command no longer when:false) has no item; it only resolves
      // an identity and still opens the one reviewWorktreeDiff.
      if (!isReviewCommandItem(item)) return await reviewWorktreeFromPalette();
      const ws = wsOf(item);
      if (!ws) return undefined;
      if ("worktreeId" in item) {
        const review = await worktreeReview(ws, { worktreeId: item.worktreeId });
        if (!review.record || !review.comparison) {
          notify(vscode.l10n.t("Nothing to review — this checkout has no committed history to compare."), "warn");
          return undefined;
        }
        // t-f3ded3 — select is a union with PR shapes; only review shapes reach this door.
        const reviewSelect = item.select === "list" || (item.select && typeof item.select === "object" && "file" in item.select)
          ? item.select
          : undefined;
        return await reviewWorktreeDiff(
          {
            cwd: review.record.path,
            baseRef: review.comparison.base,
            headRef: review.comparison.head,
            workspaceHash: ws.wsHash,
            worktree: item.worktreeId,
          },
          review.changedFiles,
          review.record.branch,
          reviewSelect,
        );
      }
      const review = await worktreeReview(ws, { agent: item.agentName });
      if (!review.record) {
        notify(vscode.l10n.t("'{0}' has no worktree", item.agentName), "warn");
        return undefined;
      }
      await reviewWorktreeDiff(
        {
          cwd: review.record.path,
          baseRef: review.comparison?.base ?? review.record.baseRef,
          workspaceHash: ws.wsHash,
          worktree: item.agentName,
        },
        review.changedFiles,
        item.agentName,
      );
      return undefined;
    }),
    vscode.commands.registerCommand("tachyon.reviewSendNotes", async (item?: AgentItem | WorktreeRowItem) => {
      await sendReviewNotesCommand(item);
    }),
    vscode.commands.registerCommand("tachyon.reviewPipelineItem", async (item: PipelineNodeItem | PipelineDefItem) => {
      // spec 230 — "View changes": review the RUN's worktree diff (what a pipeline produced), so the
      // human sees what they're approving. Reuses the spec-213 worktree diff review.
      const ws = wsOf(item);
      if (!ws) return;
      const runId = "runId" in item ? item.runId : item.run?.id;
      if (!runId) return;
      const review = await worktreeReview(ws, { runId });
      if (!review.record) {
        notify(vscode.l10n.t("no active run worktree to review"), "warn");
        return;
      }
      await reviewWorktreeDiff(
        {
          cwd: review.record.path,
          baseRef: review.comparison?.base ?? review.record.baseRef,
          workspaceHash: ws.wsHash,
          worktree: runId,
        },
        review.changedFiles,
        runId,
      );
    }),
    vscode.commands.registerCommand("tachyon.createWorktreePrItem", async (item: AgentItem | WorktreeRowItem) => {
      // spec 223 — open a GitHub PR from the worktree's branch. Human stays at the gate: readiness is probed at CLICK (no per-refresh gh spawn), then an
      // editable title + a modal body preview confirm before `gh pr create` fires.
      // SDD 501 — reachable from the land block too, by managed-registry row id. The probe-at-click
      // property is exactly what makes that safe to put on a polled dashboard, so nothing below moves
      // earlier; `prReadinessProbedAtClick.test.ts` is the guard.
      // t-f3ded3 — `select` decides only which chrome collects the title. It is read on the worktree-row
      // arm alone: that door's caller is the Worktrees WEBVIEW, which has ConfirmForm of its own.
      //   · `"draft"` → probe at this click, compose, return the draft; open nothing (webview draws);
      //   · `{ title }` → that form already confirmed; create with the edited title, no second probe;
      //   · omitted → native InputBox + modal (sidebar tree item has no surface of its own).
      // Readiness probe and PR create stay here; only the selection chrome moved.
      const ws = wsOf(item);
      if (!ws) return undefined;
      const review = "worktreeId" in item
        ? await worktreeReview(ws, { worktreeId: item.worktreeId })
        : await worktreeReview(ws, { agent: item.agentName });
      const rec = review.record;
      // The name a refusal uses is the one the human clicked from: an agent by name, a land-block row
      // by its branch — never an internal registry id nobody recognizes.
      const subject = "worktreeId" in item ? (rec?.branch ?? item.worktreeId) : item.agentName;
      if (!rec) {
        notify(vscode.l10n.t("'{0}' has no worktree", subject), "warn");
        return undefined;
      }
      if (!fs.existsSync(rec.path)) {
        notify(vscode.l10n.t("'{0}'s worktree path no longer exists", subject), "warn");
        return undefined;
      }
      // t-f3ded3 — confirm arm: the form already collected the title at the draft click. Re-resolve
      // body/base from live state and create; do NOT probe again (guard: probe at click only).
      const prSelect = "worktreeId" in item ? item.select : undefined;
      const confirmTitle = prSelect && typeof prSelect === "object" && "title" in prSelect
        ? String(prSelect.title).trim()
        : undefined;
      if (confirmTitle !== undefined) {
        if (!confirmTitle) return undefined;
        try {
          const base = rec.baseBranch ?? null;
          const body = composePrBody({ branch: rec.branch, base: base ?? undefined });
          const result = await createWorktreePr(rec, { title: confirmTitle, body, base: base ?? undefined }, ws.git.gitExec);
          if ("error" in result) {
            notify(vscode.l10n.t("PR failed: {0}", result.error), "error");
            return undefined;
          }
          const open = await showNotification(
            result.existing ? vscode.l10n.t("A PR already exists for '{0}'.", rec.branch) : vscode.l10n.t("PR opened for '{0}'.", rec.branch),
            "info",
            [vscode.l10n.t("Open PR")],
          );
          if (open) await vscode.env.openExternal(vscode.Uri.parse(result.url));
        } catch (err) {
          notify(vscode.l10n.t("PR failed: {0}", err instanceof Error ? err.message : String(err)), "error");
        }
        return undefined;
      }
      // Draft + native arms: probe happens HERE, at the human's click — never at render, never at confirm.
      const readiness = await probePrReadiness(rec.path, true, ws.git.gitExec);
      if (!readiness.ready) {
        notify(vscode.l10n.t("Can't open a PR: {0}", readiness.reason ?? "not ready"), "warn");
        return undefined;
      }
      try {
        // Base BRANCH: ONLY the one persisted at worktree-create (a true fork off a known branch). We
        // never GUESS it from the SHA — an attached/pre-223 worktree has no known base, so we let gh
        // default and say so in the confirm (honest > a confident wrong guess). Detect dirty too
        // (uncommitted changes are NOT pushed → would silently miss the PR).
        const base = rec.baseBranch ?? null;
        const dirty = await isWorktreeDirty(rec.path, ws.git.gitExec);
        const body = composePrBody({
          branch: rec.branch,
          base: base ?? undefined,
        });
        const seededTitle = composePrTitle(rec.branch);
        if (prSelect === "draft") {
          // Hand the draft to the webview's ConfirmForm. No InputBox, no modal — the panel draws.
          return {
            subject,
            branch: rec.branch,
            title: seededTitle,
            body,
            base,
            dirty,
          };
        }
        const title = await vscode.window.showInputBox({
          title: vscode.l10n.t("Create PR for '{0}'", subject),
          prompt: vscode.l10n.t("PR title"),
          value: seededTitle,
        });
        if (!title) return undefined; // cancelled / empty
        const meta = [
          base ? vscode.l10n.t("Base branch: {0}", base) : vscode.l10n.t("Base: gh's default — confirm on the PR page"),
          dirty ? vscode.l10n.t("⚠ Uncommitted changes won't be in the PR — commit them first.") : null,
        ].filter((l): l is string => l !== null);
        const ok = await showNotification(
          vscode.l10n.t("Open a GitHub PR for branch '{0}'?", rec.branch),
          "info",
          [vscode.l10n.t("Create PR")],
          { modal: true, detail: `${meta.join("\n")}\n\n${title}\n\n${body}` },
        );
        if (!ok) return undefined;
        const result = await createWorktreePr(rec, { title, body, base: base ?? undefined }, ws.git.gitExec);
        if ("error" in result) {
          notify(vscode.l10n.t("PR failed: {0}", result.error), "error");
          return undefined;
        }
        const open = await showNotification(
          result.existing ? vscode.l10n.t("A PR already exists for '{0}'.", rec.branch) : vscode.l10n.t("PR opened for '{0}'.", rec.branch),
          "info",
          [vscode.l10n.t("Open PR")],
        );
        if (open) await vscode.env.openExternal(vscode.Uri.parse(result.url));
      } catch (err) {
        // The worktree can vanish mid-flow (after the existsSync guard) → git/gh reject; surface it.
        notify(vscode.l10n.t("PR failed: {0}", err instanceof Error ? err.message : String(err)), "error");
      }
      return undefined;
    }),
    vscode.commands.registerCommand("tachyon.injectPromptTemplate", async () => {
      // spec 381 — palette: pick template → agent → stage|submit → deliver
      const ws = await pickWorkspace();
      if (!ws) return;
      await injectPromptTemplateFlow(ws);
    }),
    vscode.commands.registerCommand("tachyon.injectPromptTemplateItem", async (item: AgentItem) => {
      // spec 381 — sidebar: agent preselected
      const ws = wsOf(item);
      if (!ws) return;
      await injectPromptTemplateFlow(ws, item.agentName);
    }),
    vscode.commands.registerCommand("tachyon.promoteAgentItem", async (item: AgentItem) => {
      // t-7b7701 — promote a Temporary terminal instance to a declared terminal at
      // `.tachyon/terminals/<name>.yml`. cmd only; never an absolute cwd (portability).
      const ws = wsOf(item);
      if (!ws) return;
      const name = item.agentName;
      await extensionInvoke(ws, { action: "config.agent.promote", agent: name });
      refreshAll();
      notify(vscode.l10n.t("'{0}' saved as a terminal declaration.", name));
    }),
    vscode.commands.registerCommand("tachyon.editAgentItem", async (item: AgentItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      const file = path.join(ws.workspaceRoot, ".tachyon", "agents", item.agentName, "agent.yml");
      if (!fs.existsSync(file)) {
        notify(vscode.l10n.t("Saved Agent '{0}' has no agent.yml", item.agentName), "warn");
        return;
      }
      const doc = await vscode.workspace.openTextDocument(file);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const pos = new vscode.Position(0, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }),
    // ---- lifecycle ----
    vscode.commands.registerCommand("tachyon.start", async () => {
      for (const ws of workspaces()) {
        await ws.client.sync();
      }
      refreshAll();
    }),
    vscode.commands.registerCommand("tachyon.stopAll", async () => {
      let total = 0;
      for (const ws of workspaces()) {
        const result = jsonObject(await extensionInvoke(ws, { action: "workspace.stop-all" }), "workspace.stop-all");
        if (typeof result.stoppedAgents === "number") total += result.stoppedAgents;
      }
      notify(total > 0 ? vscode.l10n.t("stopped {0} agent(s)", total) : vscode.l10n.t("no agents running"));
      refreshAll();
    }),
    vscode.commands.registerCommand("tachyon.restartAgent", async () => {
      const ws = await pickWorkspace();
      if (!ws) return;
      const agent = await pickAgent(ws, vscode.l10n.t("Restart which agent?"), false);
      if (!agent) return;
      try {
        // Palette: same one-click product default (graceful+resume); no mode QuickPick.
        await invokeAgentLifecycle(ws, "agent.restart", agent, RESTART_DEFAULT);
        notify(vscode.l10n.t("'{0}' restarted", agent));
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.openAgentTerminal", async () => {
      const ws = await pickWorkspace();
      if (!ws) return;
      const agent = await pickAgent(ws, vscode.l10n.t("Open which agent's terminal?"), true);
      const projected = agent ? agentProjection(ws, agent) : undefined;
      if (!agent || !projected) return;
      try {
        await presentTerminal(ws, agent, projected.session);
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), "error");
      }
    }),
    // spec 234 — tachyon.applyLayout removed (layouts feature retired).
    // spec 233 — tachyon.saveLayoutAs removed (layouts feature discontinued; was the engine's last vscode use).
    // ---- bridge ----
    vscode.commands.registerCommand("tachyon.copyBridgeToken", async () => {
      const ws = await pickWorkspace();
      if (!ws) return;
      const tokenResult = jsonObject(await extensionQuery(ws, { action: "bridge.token" }), "bridge.token");
      if (typeof tokenResult.token !== "string") {
        notify(vscode.l10n.t("Bridge auth is disabled (settings.auth: false) — no token"), "warn");
        return;
      }
      await vscode.env.clipboard.writeText(tokenResult.token);
      notify(vscode.l10n.t("Bridge token copied — export it as TACHYON_BRIDGE_TOKEN for external agents"));
    }),
    // t-5786bc — the disaster-recovery surface: repopulate a FRESH checkout's durable state
    // (Board, pins, continuity, handoff, tachyon.yml) from a stateBackup destination. Deliberately
    // self-contained: it must work with no engine running and no tachyon.yml present, because that
    // is exactly the state a destroyed workspace is in.
    vscode.commands.registerCommand("tachyon.restoreStateBackup", async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length === 0) {
        void vscode.window.showErrorMessage(vscode.l10n.t("Open the workspace folder to restore into first."));
        return;
      }
      const target =
        folders.length === 1
          ? folders[0]
          : await vscode.window.showWorkspaceFolderPick({ placeHolder: vscode.l10n.t("Workspace folder to restore into") });
      if (!target) return;

      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: vscode.l10n.t("Use backup folder"),
        title: vscode.l10n.t("Select the state backup destination folder"),
      });
      const source = picked?.[0]?.fsPath;
      if (!source) return;

      try {
        const adapter = new FilesystemBackupAdapter(source);
        const ids = await listGenerationIds(adapter);
        if (ids.length === 0) {
          void vscode.window.showErrorMessage(vscode.l10n.t("No backup generations found in {0}", source));
          return;
        }
        const latest = (await readGenerationManifest(adapter))?.id;
        const pickedGen = await vscode.window.showQuickPick(
          [...ids].reverse().map((id) => ({
            label: id,
            description: id === latest ? vscode.l10n.t("latest") : undefined,
          })),
          { placeHolder: vscode.l10n.t("Backup generation to restore (newest first)") },
        );
        if (!pickedGen) return;
        const manifest = await readGenerationManifest(adapter, pickedGen.label);
        if (!manifest) {
          void vscode.window.showErrorMessage(vscode.l10n.t("Backup generation {0} is missing its manifest", pickedGen.label));
          return;
        }
        const confirm = await vscode.window.showWarningMessage(
          vscode.l10n.t("Restore {0} file(s) from {1} into {2}?", manifest.files.length, manifest.createdAt, target.uri.fsPath),
          { modal: true },
          vscode.l10n.t("Restore"),
        );
        if (confirm === undefined) return;

        let stats;
        try {
          stats = await runRestore(target.uri.fsPath, adapter, { generationId: manifest.id });
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes("would overwrite")) throw error;
          const force = await vscode.window.showWarningMessage(
            vscode.l10n.t("{0} Overwrite them with the backup's copies?", error.message),
            { modal: true },
            vscode.l10n.t("Overwrite"),
          );
          if (force === undefined) return;
          stats = await runRestore(target.uri.fsPath, adapter, { generationId: manifest.id, force: true });
        }
        notify(vscode.l10n.t("Restored {0} file(s) from backup generation {1}. Reload the window so Tachyon picks the state up.", stats.files, stats.generationId));
      } catch (error) {
        void vscode.window.showErrorMessage(
          vscode.l10n.t("State restore failed: {0}", error instanceof Error ? error.message : String(error)),
        );
      }
    }),
    // t-f5769a — the human's door onto the reclaim plan. Always shows what it would take back and
    // what it is leaving alone, and only acts on a plan the person has seen: measured at ~5.0GB of
    // machine-local state on one machine, including worktrees that may still hold unlanded work.
    vscode.commands.registerCommand("tachyon.reclaimDisk", async (hash?: string) => {
      const ws = hash ? byHash(hash) : workspaces()[0];
      try {
        const preview = await runReclaim({
          apply: false,
          workspaceSettings: ws?.config?.settings ?? {},
          globalStorageRoot: context.globalStorageUri.fsPath,
        });
        const gb = (bytes: number): string => `${(bytes / 1_000_000_000).toFixed(2)}GB`;
        if (preview.plan.collect.length === 0 && preview.plan.quarantine.length === 0) {
          notify(vscode.l10n.t("Nothing to reclaim — Tachyon is not holding disk it no longer needs."));
          return;
        }
        const held = preview.plan.hold.filter((entry) => entry.reason.includes("review before removing"));
        const detail = [
          ...preview.lines,
          ...(held.length > 0 ? ["", vscode.l10n.t("Left alone (they hold unsaved work):"), ...held.map((entry) => `  ${entry.path} — ${entry.reason}`)] : []),
        ].join("\n");
        const confirm = await vscode.window.showWarningMessage(
          vscode.l10n.t("Reclaim {0} of disk Tachyon no longer needs?", gb(preview.plan.bytesCollectable)),
          { modal: true, detail },
          vscode.l10n.t("Reclaim"),
        );
        if (confirm === undefined) return;
        const done = await runReclaim({
          apply: true,
          workspaceSettings: ws?.config?.settings ?? {},
          globalStorageRoot: context.globalStorageUri.fsPath,
          quarantineRoot: reclaimQuarantineRoot(),
        });
        notify(done.lines.join(" · "));
      } catch (error) {
        void vscode.window.showErrorMessage(
          vscode.l10n.t("Reclaim failed: {0}", error instanceof Error ? error.message : String(error)),
        );
      }
    }),
    vscode.commands.registerCommand("tachyon.copyBridgeUrl", async (hash?: string) => {
      const ws = byHash(hash) ?? (await pickWorkspace());
      if (!ws) return;
      await vscode.env.clipboard.writeText(ws.bridgeUrl);
      notify(vscode.l10n.t("Bridge URL copied: {0}", ws.bridgeUrl));
    }),
    // SDD 414 — short-lived pair code for Tachyon Companion (browser/mobile shells).
    vscode.commands.registerCommand("tachyon.pairCompanion", async (hash?: string) => {
      const ws = byHash(hash) ?? (await pickWorkspace());
      if (!ws) return;
      const result = jsonObject(await extensionQuery(ws, { action: "companion.pair-code" }), "companion.pair-code");
      if (result.ok === false) {
        notify(
          vscode.l10n.t(
            "Companion pairing unavailable — start Tachyon / ensure the Bridge is listening (reason: {0})",
            String(result.reason ?? "unknown"),
          ),
          "warn",
        );
        return;
      }
      const code = String(result.code ?? "");
      const baseUrl = String(result.baseUrl ?? "");
      const expiresAt = String(result.expiresAt ?? "");
      const line = `code=${code} baseUrl=${baseUrl} expires=${expiresAt}`;
      await vscode.env.clipboard.writeText(line);
      notify(
        vscode.l10n.t(
          "Companion pair code {0} (expires {1}). Base URL {2} — copied to clipboard. Load the Companion extension and paste the code when pairing ships in the UI.",
          code,
          expiresAt,
          baseUrl,
        ),
      );
    }),
    vscode.commands.registerCommand("tachyon.showRuntimeUsage", async () => {
      await openRuntimeOps();
    }),
    vscode.commands.registerCommand("tachyon.refreshRuntimeOps", async () => {
      await runtimeOpsFleetView(workspaces().map((ws) => ws.runtimeOps), true);
      // Panel webview removed — Control Runtime tab rebuilds snapshot on section open / poll.
    }),
    vscode.commands.registerCommand("tachyon.connectRuntime", async () => {
      const ws = await pickWorkspace();
      if (ws) await connectRuntime(ws);
    }),
    vscode.commands.registerCommand("tachyon.scheduleStudio", async (hash?: string) => {
      const ws = byHash(hash) ?? (await pickFolderForCreate());
      if (!ws) return;
      studioPanels.schedule.openNew(ws.wsHash);
    }),
    vscode.commands.registerCommand("tachyon.editScheduleStudioItem", async (item: ScheduleItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      const def = ws.config?.schedules[item.scheduleName];
      if (!def) {
        notify(vscode.l10n.t("'{0}' is not declared in .tachyon/schedules", item.scheduleName), "warn");
        return;
      }
      studioPanels.schedule.openExisting(ws.wsHash, item.scheduleName);
    }),
  );

  // Thimo-style Integrated Browser bridge (HTTP + editor-browser CDP) → Bridge ide_browser_* tools.
  // Fixture ide-browser-dogfood: agents claude/codex/grok only (host auto-starts on opt-in;
  // browser/CDP stay lazy; no shell-as-agent).
  await registerIdeBrowserBridge(context, {
    getWorkspace: () =>
      (controlWorkspaceScope.current ? byHash(controlWorkspaceScope.current) : undefined)
      ?? workspaces()[0],
  });

  // VS Code Chat → Tachyon agents (@tachyon + LM tools). See docs/research/tachyon-chat-bridge.md.
  registerTachyonChatBridge(context, {
    resolveWorkspace: (wsHash) => {
      const ws = (wsHash ? byHash(wsHash) : undefined)
        ?? (controlWorkspaceScope.current ? byHash(controlWorkspaceScope.current) : undefined)
        ?? workspaces()[0];
      if (!ws) return undefined;
      return { folderName: ws.folderName, wsHash: ws.wsHash, workspaceRoot: ws.workspaceRoot };
    },
    listAgents: async (wsHash) => {
      const ws = (wsHash ? byHash(wsHash) : undefined)
        ?? (controlWorkspaceScope.current ? byHash(controlWorkspaceScope.current) : undefined)
        ?? workspaces()[0];
      if (!ws) return [];
      const listed = await extensionQuery(ws, { action: "agents.list" });
      return normalizeAgentRows(listed);
    },
    sendPrompt: async (agent, text, opts) => {
      const ws = (opts?.wsHash ? byHash(opts.wsHash) : undefined)
        ?? (controlWorkspaceScope.current ? byHash(controlWorkspaceScope.current) : undefined)
        ?? workspaces()[0];
      if (!ws) throw new Error("No Tachyon workspace is active.");
      const submit = opts?.submit !== false;
      await ws.activity.sendAgentInput(agent, text, submit);
    },
  });

}

export function deactivate(): void {
  // Detach only the editor leases. The persistent engine, Bridge and agents survive.
  void activeClientRegistry?.close();
  activeClientRegistry = undefined;
  registry.clear();
}
