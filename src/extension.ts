import * as vscode from "vscode";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { doctor, probeServer, TmuxService, workspaceHash, SOCKET_NAME, type PaneSnapshot } from "./tmux/TmuxService.js";
import { subtreeCpuTicks } from "./attention/cpu.js";
import { classifySession } from "./inspector/classify.js";
import type { TmuxServerSnapshot } from "./inspector/model.js";
import { CONFIG_FILENAMES, inferKind, type ScheduleDef } from "./config/loadConfig.js";
import { agentEntryLine, commandEntryLine, runbookEntryLine, scheduleEntryLine } from "./config/YamlConfigEditor.js";
import type { StudioSubmit } from "./webview/studioSubmit.js";
import { SERVER_INSPECTOR_VIEW_TYPE, type ServerInspectorPanelState, type InspectorDeps } from "./webview/ServerInspector.js";
import {
  openCockpit,
  refreshCockpitMissionBoard,
  refreshCockpitApprovals,
  refreshCockpitValidations,
  refreshCockpitTaskDetail,
  refreshCockpitTaskStudioEntity,
  refreshCockpitPinStudioEntity,
  refreshCockpitProbes,
  refreshCockpitHandoff,
  refreshCockpitStudioReferenceData,
  openCockpitAgentTranscript,
  decodeCockpitPanelState,
  COCKPIT_VIEW_TYPE,
  type CockpitPanelState,
  type CockpitDeps,
} from "./webview/Cockpit.js";
import { isCockpitSingletonClaimed } from "./webview/cockpitSingleton.js";
import type { CockpitWorkspaceBundle } from "./cockpit/model.js";
import { routes as cockpitRoutes } from "./cockpit/route.js";
import type { StudioId } from "./cockpit/studioIds.js";
import type { StudioPanelState } from "./webview/shared/studio/StudioPanelManagerBase.js";
import { readGitDeliveriesFromDisk } from "./cockpit/disk.js";
import { SidebarPrototypeProvider, PIN_PREVIEW_VIEW_TYPE, type PinPreviewPanelState } from "./webview/SidebarPrototype.js";
import { ACTIVITY_VIEW_TYPE, type ActivityPanelState } from "./webview/ActivityPanel.js";
import { PluginsPanelManager, PLUGINS_VIEW_TYPE, type PluginsPanelState } from "./webview/PluginsPanel.js";
import { HANDOFF_VIEW_TYPE, type HandoffPanelState } from "./webview/HandoffPanel.js";
import { ApprovalPanelManager, APPROVAL_VIEW_TYPE, type ApprovalPanelState } from "./webview/ApprovalPanel.js";
import { PROBES_VIEW_TYPE, type ProbesPanelState } from "./webview/ProbeResultPanel.js";
import { PIN_STUDIO_VIEW_TYPE, type PinStudioPanelState } from "./webview/PinStudioPanel.js";
import { MISSION_CONTROL_VIEW_TYPE, type MissionControlPanelState } from "./webview/MissionControlPanel.js";
import { TASK_DETAIL_VIEW_TYPE, type TaskDetailPanelState } from "./webview/TaskDetailPanel.js";
import { TASK_STUDIO_VIEW_TYPE, type TaskStudioPanelState } from "./webview/TaskStudioPanel.js";
import { mintTaskId } from "./tasks/TaskStore.js";
import { AGENT_STUDIO_SHELL_VIEW_TYPE, type AgentStudioPanelState } from "./webview/AgentStudioPanel.js";
import { TERMINAL_STUDIO_SHELL_VIEW_TYPE, type TerminalStudioPanelState } from "./webview/TerminalStudioPanel.js";
import { COMMAND_STUDIO_SHELL_VIEW_TYPE, type CommandStudioPanelState } from "./webview/CommandStudioPanel.js";
import { RUNBOOK_STUDIO_SHELL_VIEW_TYPE, type RunbookStudioPanelState } from "./webview/RunbookStudioPanel.js";
import { SCHEDULE_STUDIO_SHELL_VIEW_TYPE, type ScheduleStudioPanelState } from "./webview/ScheduleStudioPanel.js";
import { PipelineStudioPanelManager, PIPELINE_STUDIO_VIEW_TYPE, type PipelineStudioPanelState } from "./webview/PipelineStudioPanel.js";
import { PluginSurfaceHost } from "./plugins/ui/host.js";
import { syncToolLauncher } from "./plugins/toolProvisionRun.js";
import { buildOffers, type RegistrationOffer } from "./registration/adapters.js";
import { runtimeOpsFleetView } from "./shell/RuntimeOpsTarget.js";
import type {
  AgentItem,
  PinItem,
  CommandItem,
  RunbookItem,
  ScheduleItem,
  ProposalItem,
  PipelineDefItem,
  PipelineNodeItem,
} from "./presentation/items.js";
import { isAdhocItem } from "./presentation/contextValue.js";
import type { WorkspacePresentationTarget } from "./shell/WorkspacePresentation.js";
import type { WorktreeRecord, WorktreeStatus } from "./worktree/WorktreeManager.js";
import { previewBody } from "./prompts/injectFlow.js";
import { createGitExec, worktreeShowFile, resolveBase } from "./worktree/WorktreeManager.js";
import { resolveGitBinary } from "./worktree/gitBinary.js";
import { emptySides, baseSidePath, diffTitle, type ChangedFile } from "./worktree/review.js";
import { probePrReadiness, composePrTitle, composePrBody, createWorktreePr, isWorktreeDirty } from "./worktree/pr.js";
import { computeWorkspaceFolderOps, shouldActivateFolder } from "./workspace/workspaceFolderOps.js";
import type { ViewKind } from "./workspace/EngineHost.js";

/** spec 213 — URI scheme for the base side of a worktree diff (git show <ref>:<file>). */
const WT_DIFF_SCHEME = "tachyon-worktree";
import { initializeVsCodeNotifications, notify } from "./workspace/notify.js";
import { showNotification } from "./workspace/NotificationService.js";
import { detectInstalledClis } from "./webview/cliDetect.js";
import { buildStarterYaml, ensureTachyonGitignore, type DetectedProject } from "./init/initLogic.js";
import { registerDisposePanelSerializer, registerTrustedPanelSerializer } from "./webview/shared/panelSerializer.js";
import { openRuntimeOps } from "./runtimeOps/openRuntimeOps.js";
import { assessBuildProvenance, type BuildStamp } from "./provenance/verify.js";
import { readEmbeddedProvenanceRecord } from "./provenance/record.js";
import { Terminals } from "./presentation/Terminals.js";
import { connectPackagedWorkspaceClient } from "./shell/WorkspaceClient.js";
import { collectLegacyEngineStateMigration } from "./engine-service/stateMigration.js";
import { ENGINE_UI_CAPABILITY } from "./engine-service/uiRequestBroker.js";
import { assertMarkedDevHostWorkspace, engineShellReleasePolicy } from "./engine-service/devHostBoundary.js";
import { WorkspaceClientRegistry } from "./shell/WorkspaceClientRegistry.js";
import { WorkspaceShellHandle } from "./shell/WorkspaceShellHandle.js";
import { DAEMON_SETTING_KEYS, type DaemonSettingsSnapshot } from "./workspace/DaemonEngineHost.js";
import { isJsonValue, type ExtensionCommandV1, type ExtensionQueryV1, type JsonValue, type TmuxPaneIdentityV1 } from "./runtime-api/extensionOperations.js";

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
  return CONFIG_FILENAMES.map((name) => path.join(ws.workspaceRoot, name)).find((file) => fs.existsSync(file));
}

async function extensionQuery(ws: WorkspaceShellHandle, input: ExtensionQueryV1): Promise<JsonValue> {
  return ws.extension.query(input);
}

async function extensionInvoke(ws: WorkspaceShellHandle, input: ExtensionCommandV1): Promise<JsonValue> {
  return ws.extension.invoke(input);
}

function legacyRetirementPreviewDocument(preview: Record<string, JsonValue>): string {
  const entries = jsonArray(preview.entries, "legacy Delivery retirement preview entries").map((value) => {
    const entry = jsonObject(value, "legacy Delivery retirement preview entry");
    if (!entry.row || typeof entry.row !== "object" || Array.isArray(entry.row)) return entry;
    const row = jsonObject(entry.row, "legacy Delivery retirement preview row");
    return {
      ...entry,
      row: {
        ...row,
        ...(typeof row.recordJson === "string"
          ? { recordJson: `[content omitted from UI; archive entry sha256 ${String(entry.sha256 ?? "unknown")}]` }
          : {}),
      },
    };
  });
  return `${JSON.stringify({ ...preview, entries }, null, 2)}\n`;
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
): Promise<void> {
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

async function liveWorktreesAcrossWorkspaces(): Promise<{ path: string; agent: string }[]> {
  const out: { path: string; agent: string }[] = [];
  for (const ws of workspaces()) {
    const payload = jsonObject(await extensionQuery(ws, { action: "worktrees.list" }), "worktrees.list");
    for (const entry of jsonArray(payload.worktrees, "worktrees.list")) {
      const row = jsonObject(entry, "worktrees.list row");
      const record = jsonObject(row.record, "worktrees.list record");
      if (typeof row.agent === "string" && typeof record.path === "string") {
        out.push({ path: record.path, agent: row.agent });
      }
    }
  }
  return out;
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
  const reveal = vscode.workspace.getConfiguration("tachyon").get<boolean>("worktrees.revealInWorkspace", true);
  if (!reveal) return;
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

/** Folder disambiguation: 0 configured → undefined+warn, 1 → it, N → QuickPick (configured only). */
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


/** spec 381 — shell selection/confirmation; the persistent engine revalidates and delivers. */
async function injectPromptTemplateFlow(ws: WorkspaceShellHandle, preselectedAgent?: string): Promise<void> {
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
    return;
  }

  const tplPick = await vscode.window.showQuickPick(
    templates.map((template) => ({
      label: template.title,
      description: template.id,
      detail: template.body.split("\n")[0]?.slice(0, 120),
      template,
    })),
    { title: vscode.l10n.t("Inject prompt template"), placeHolder: vscode.l10n.t("Choose a template") },
  );
  if (!tplPick) return;
  const template = tplPick.template;

  let agentName = preselectedAgent;
  if (!agentName) {
    if (targets.length === 0) {
      notify(vscode.l10n.t("No running AI agent available for prompt injection."), "warn");
      return;
    }
    const agentPick = await vscode.window.showQuickPick(
      targets.map((target) => ({ label: target.name, description: target.description })),
      { title: vscode.l10n.t("Send to agent"), placeHolder: vscode.l10n.t("Choose a running AI agent") },
    );
    if (!agentPick) return;
    agentName = agentPick.label;
  }

  const modePick = await vscode.window.showQuickPick(
    [
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
    ],
    {
      title: vscode.l10n.t("Delivery for '{0}' → {1}", template.title, agentName),
      placeHolder: vscode.l10n.t("Stage or submit?"),
    },
  );
  if (!modePick) return;
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
  if (ok !== actionLabel) return;

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
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), "warn");
  }
}

/** spec 213 / 230 — quick-pick the changed files of a worktree (base ↔ current), each opening VS Code's
 *  native diff. Shared by the agent worktree review and the pipeline run "View changes". */
async function reviewWorktreeDiff(rec: WorktreeRecord, changes: ChangedFile[], label: string): Promise<void> {
  if (changes.length === 0) {
    notify(vscode.l10n.t("Nothing to review — '{0}' has no changes yet.", label), "info");
    return;
  }
  const glyph: Record<string, string> = { A: "$(diff-added)", M: "$(diff-modified)", D: "$(diff-removed)", R: "$(diff-renamed)", C: "$(diff-renamed)" };
  const pick = await vscode.window.showQuickPick(
    changes.map((c) => ({ label: `${glyph[c.status] ?? ""} ${c.from && c.from !== c.path ? `${c.from} → ${c.path}` : c.path}`, file: c })),
    {
      title: vscode.l10n.t("Review '{0}' — {1} changed file(s)", label, changes.length),
      placeHolder: vscode.l10n.t("Open a file's diff (base ↔ worktree)"),
    },
  );
  if (!pick) return;
  const f = pick.file;
  const { baseEmpty, currentEmpty } = emptySides(f.status);
  const emptyUri = vscode.Uri.from({ scheme: WT_DIFF_SCHEME, path: "/empty", query: "empty=1" });
  const base = baseEmpty
    ? emptyUri
    : vscode.Uri.from({ scheme: WT_DIFF_SCHEME, path: `/${baseSidePath(f)}`, query: `cwd=${encodeURIComponent(rec.path)}&ref=${encodeURIComponent(rec.baseRef)}` });
  const current = currentEmpty ? emptyUri : vscode.Uri.file(path.join(rec.path, f.path));
  await vscode.commands.executeCommand("vscode.diff", base, current, diffTitle(f, rec.baseRef));
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

async function worktreeReview(
  ws: WorkspaceShellHandle,
  input: { agent: string } | { runId: string },
): Promise<{ record: WorktreeRecord | null; status: WorktreeStatus | null; changedFiles: ChangedFile[]; verify?: JsonValue }> {
  const payload = jsonObject(await extensionQuery(ws, { action: "worktree.review", ...input }), "worktree.review");
  return {
    record: payload.record === null ? null : worktreeRecordFrom(payload.record),
    status: payload.status === null ? null : worktreeStatusFrom(payload.status),
    changedFiles: changedFilesFrom(payload.changedFiles),
    ...(payload.verify !== undefined ? { verify: payload.verify } : {}),
  };
}

async function agentInspection(ws: WorkspaceShellHandle, agent: string): Promise<{
  descendants: string[];
  record: Record<string, JsonValue> | null;
  worktree: WorktreeRecord | null;
  status: WorktreeStatus | null;
  declared: boolean;
}> {
  const payload = jsonObject(await extensionQuery(ws, { action: "agent.inspect", agent }), "agent.inspect");
  const descendants = jsonArray(payload.descendants, "agent descendants").map((entry) => {
    if (typeof entry !== "string") throw new Error("agent descendant name is invalid");
    return entry;
  });
  const record = payload.record === null ? null : jsonObject(payload.record, "agent record");
  const worktree = record?.worktree === undefined ? null : worktreeRecordFrom(record.worktree);
  const status = payload.worktreeStatus === null ? null : worktreeStatusFrom(payload.worktreeStatus);
  if (typeof payload.declared !== "boolean") throw new Error("agent inspection declaration is invalid");
  return { descendants, record, worktree, status, declared: payload.declared };
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
  return CONFIG_FILENAMES.some((name) => fs.existsSync(path.join(folderPath, name)));
}

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

async function migrateAgentProfileFlow(): Promise<void> {
  const ws = await pickWorkspace();
  if (!ws) return;
  const agents = ws.client.presentation.agents;
  if (agents.truncated) throw new Error("agent list is truncated");
  const stopped = agents.items.filter((agent) => agent.kind === "agent" && !agent.running);
  if (stopped.length === 0) {
    notify(vscode.l10n.t("No stopped agent is available for profile migration."), "warn");
    return;
  }
  const agent = await vscode.window.showQuickPick(stopped.map((row) => row.name), {
    placeHolder: vscode.l10n.t("Migrate which stopped agent to agent.yml?"),
  });
  if (!agent) return;

  let nonSecretEnv: string[] = [];
  let preview = jsonObject(await extensionQuery(ws, {
    action: "agent-profile.migration-preview",
    agent,
    nonSecretEnv,
  }), "agent-profile.migration-preview");
  const unclassified = Array.isArray(preview.unclassifiedEnv)
    ? preview.unclassifiedEnv.filter((value): value is string => typeof value === "string")
    : [];
  if (unclassified.length > 0) {
    const confirmValues = vscode.l10n.t("Treat as non-secret values");
    const answer = await showNotification(
      vscode.l10n.t("'{0}' has environment value(s): {1}. Confirm they are non-secret before storing them in agent.yml.", agent, unclassified.join(", ")),
      "warn",
      [confirmValues],
      { modal: true },
    );
    if (answer !== confirmValues) return;
    nonSecretEnv = unclassified;
    preview = jsonObject(await extensionQuery(ws, {
      action: "agent-profile.migration-preview",
      agent,
      nonSecretEnv,
    }), "agent-profile.migration-preview");
  }
  if (preview.ok !== true) {
    const blockers = Array.isArray(preview.blockers)
      ? preview.blockers.filter((value): value is string => typeof value === "string")
      : [];
    notify(vscode.l10n.t("Profile migration blocked for '{0}': {1}", agent, blockers.join("; ") || vscode.l10n.t("unknown blocker")), "error");
    return;
  }
  const migrate = vscode.l10n.t("Migrate profile");
  const confirmed = await showNotification(
    vscode.l10n.t("Migrate stopped agent '{0}' to {1}? A recoverable journal will be kept for rollback.", agent, String(preview.profilePath ?? "agent.yml")),
    "warn",
    [migrate],
    { modal: true },
  );
  if (confirmed !== migrate) return;
  const result = jsonObject(await extensionInvoke(ws, { action: "agent-profile.migrate", agent, nonSecretEnv }), "agent-profile.migrate");
  await ws.client.sync();
  notify(vscode.l10n.t("Agent '{0}' migrated to agent.yml (transaction {1}).", agent, String(result.txid ?? "")));
}

async function rollbackAgentProfileFlow(): Promise<void> {
  const ws = await pickWorkspace();
  if (!ws) return;
  const rows = jsonArray(await extensionQuery(ws, { action: "agent-profile.rollbackable" }), "agent-profile.rollbackable")
    .map((value) => jsonObject(value, "rollbackable migration"))
    .filter((row) => typeof row.txid === "string" && typeof row.agentName === "string");
  if (rows.length === 0) {
    notify(vscode.l10n.t("No safely rollbackable agent profile migration was found."), "warn");
    return;
  }
  const picked = await vscode.window.showQuickPick(rows.map((row) => ({
    label: String(row.agentName),
    description: String(row.createdAt ?? ""),
    detail: String(row.txid),
    txid: String(row.txid),
  })), { placeHolder: vscode.l10n.t("Roll back which agent profile migration?") });
  if (!picked) return;
  const rollback = vscode.l10n.t("Roll back profile");
  const confirmed = await showNotification(
    vscode.l10n.t("Restore the legacy tachyon.yml stanza for stopped agent '{0}'? Later edits will make rollback refuse safely.", picked.label),
    "warn",
    [rollback],
    { modal: true },
  );
  if (confirmed !== rollback) return;
  await extensionInvoke(ws, { action: "agent-profile.rollback", txid: picked.txid });
  await ws.client.sync();
  notify(vscode.l10n.t("Agent '{0}' profile migration rolled back.", picked.label));
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

function proposalSchedule(schedule: ScheduleDef): Extract<ExtensionCommandV1, { action: "proposal.create" }>["schedule"] {
  const catchUp = schedule.catchUp === undefined ? {} : { catchUp: schedule.catchUp };
  if (schedule.every && schedule.run) return { every: schedule.every, run: schedule.run, ...catchUp };
  if (schedule.at && schedule.run) return { at: schedule.at, run: schedule.run, ...catchUp };
  if (schedule.every && schedule.spawn) return { every: schedule.every, spawn: schedule.spawn, ...(schedule.instructions ? { instructions: schedule.instructions } : {}), ...catchUp };
  if (schedule.at && schedule.spawn) return { at: schedule.at, spawn: schedule.spawn, ...(schedule.instructions ? { instructions: schedule.instructions } : {}), ...catchUp };
  throw new Error("schedule proposal is incomplete");
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initializeVsCodeNotifications();
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

  // spec 237 — the Preact webview sidebar is THE Tachyon view (the native tree was retired). refreshAll
  // pushes the live fleet to it on every state change; it's registered below.
  const sidebarProto = new SidebarPrototypeProvider(
    context.extensionUri,
    () => workspaces().map((ws) => ws.sidebar),
    context.globalState,
    (context.extension.packageJSON as { version?: string }).version,
  );
  // Runtime Ops lives in Control → Runtime only (bottom-panel webview contribution removed).
  // t-610705 (SDD 410 Phase C.2) — the standalone Activity panel was retired: it's a Control
  // subroute now (fleet/agent/<name>/activity; src/webview/activity/App.tsx stays, lazy-imported by
  // cockpit/App.tsx; the watcher moved to src/cockpit/activityFeed.ts).
  // t-610705 (SDD 410 Phase C.3) — the standalone Project Handoff panel was retired: it's a Control
  // section now (src/webview/handoff/App.tsx stays, lazy-imported by cockpit/App.tsx).
  // spec 349 — first-party host for untrusted plugin UI surfaces. It reads committed plugin lockfiles and
  // revokes open channels when an installed view target disappears.
  const pluginSurfaces = new PluginSurfaceHost(
    context.extensionUri,
    () => workspaces().map((ws) => ws.plugin),
  );
  context.subscriptions.push({ dispose: () => pluginSurfaces.dispose() });
  // spec 250 — the editor-area Plugins View (browse/install/update/remove; one per root), opened by the
  // sidebar title button. Step B = read-only render of the installed list from the committed lockfile.
  const pluginsPanels = new PluginsPanelManager(context.extensionUri, () => workspaces().map((ws) => ws.git), () => pluginSurfaces.refreshAll());
  context.subscriptions.push({ dispose: () => pluginsPanels.dispose() });
  // t-610705 (SDD 410 Phase C.2) — the standalone Probes inspector was retired: it's a Control
  // subroute now (fleet/agent/<name>/probes; src/webview/probes/App.tsx stays, lazy-imported by
  // cockpit/App.tsx).
  // spec 335 — the Task board + Task Detail are both Control subroutes now (Board since t-610705
  // Phase B #6; Task Detail since Phase C.1 — standalone TaskDetailPanelManager retired).
  // dogfood round 1 (#1) — the ONE fan-out path for any task mutation: an MCP tool call (onViewsChanged("tasks")
  // below) and an engine-side panel mutation (board drag/edit, detail edit) must reach the same three targets,
  // so a board-side edit is never invisible to an open Detail tab (and vice versa).
  const onTasksChanged = () => {
    refreshCockpitMissionBoard(); // Control → Mission is THE board since t-610705 (standalone panel retired)
    refreshCockpitTaskDetail(); // Control → task-detail subroute (t-610705 Phase C.1, same reasoning)
    refreshCockpitTaskStudioEntity(); // Control → task studio-edit route (t-610705 Phase D, D2, same reasoning)
    sidebarProto.refresh();
  };
  let lastBridgeLagNoticeAt = 0;
  let bridgeLagExpectedAt = Date.now() + 5_000;
  const bridgeLagTimer = setInterval(() => {
    const now = Date.now();
    const lag = now - bridgeLagExpectedAt;
    bridgeLagExpectedAt = now + 5_000;
    if (lag > 5_000 && now - lastBridgeLagNoticeAt > 60_000) {
      lastBridgeLagNoticeAt = now;
      notify(vscode.l10n.t("Tachyon host event loop lagged by {0}ms; Bridge recovery remains available from the command palette.", Math.round(lag)), "warn");
    }
  }, 5_000);
  context.subscriptions.push({ dispose: () => clearInterval(bridgeLagTimer) });

  // Any engine/Bridge-driven state change re-pushes the whole fleet to the webview.
  const onViewsChanged = (view: ViewKind) => {
    if (view === "handoff") refreshCockpitHandoff(); // t-610705 (Phase C.3) — Control → Handoff section
    if (view === "probes") refreshCockpitProbes(); // t-610705 (Phase C.2) — Control → Probes subroute
    if (view === "tasks") onTasksChanged(); // spec 335 — same fan-out path engine-side mutations use directly
    if (view === "pins") approvalPanels.refreshAll();
    // t-610705 (Phase D, D1a) — Runbook/Schedule's refreshReferenceData() retired with their panel
    // managers; the Control-route equivalent doesn't need a per-studio "which kind changed" gate
    // (refreshStudioReferenceData is a no-op off a studio route, and best-effort otherwise — see its
    // own doc comment in studioHost.ts).
    if (view === "commands" || view === "agents") refreshCockpitStudioReferenceData();
    if (view === "agents") void applyWorktreeFolderReveal(); // spec 210/263 — onSpawned/onStopping/onKilled fire this
    sidebarProto.refresh();
  };
  const refreshAll = () => {
    void applyWorktreeFolderReveal(); // spec 210/263 — the worktree-remove commands only re-render through here
    sidebarProto.refresh();
    pluginSurfaces.refreshAll();
    refreshCockpitStudioReferenceData(); // t-610705 (Phase D, D1a) — was runbook/scheduleStudioPanels.refreshReferenceData()
    refreshCockpitPinStudioEntity(); // t-610705 (Phase D, D3) — was pinStudioPanels.refreshAll() (retired panel)
    approvalPanels.refreshAll();
  };
  const pipelineStudioPanels = new PipelineStudioPanelManager(context.extensionUri, refreshAll);
  context.subscriptions.push({ dispose: () => pipelineStudioPanels.dispose() });
  const approvalPanels = new ApprovalPanelManager(context.extensionUri, workspaces);
  context.subscriptions.push({ dispose: () => approvalPanels.dispose() });

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
        for (const [s, term] of termBySession) if (term === t) termBySession.delete(s);
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

  /** Cockpit desktop (editor sysadmin; t-fe52f0 frente 1). Sidebar unchanged. */
  const makeCockpitDeps = (): CockpitDeps => ({
    extensionUri: context.extensionUri,
    collect: async (): Promise<CockpitWorkspaceBundle[]> => {
      const bundles: CockpitWorkspaceBundle[] = [];
      for (const ws of workspaces()) {
        let identity: CockpitWorkspaceBundle["control"]["identity"] = null;
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

        let agentRows: CockpitWorkspaceBundle["agents"] = [];
        let agentCounts: { total: number; running: number } | undefined;
        try {
          const items = ws.client.presentation.agents.items;
          agentRows = items.map((a) => ({
            name: a.name,
            kind: a.kind,
            running: !!a.running,
            declared: a.declared,
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

        let companion: CockpitWorkspaceBundle["companion"];
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
        let worktreeRows: CockpitWorkspaceBundle["worktrees"] = [];
        let worktreesUnavailable: string | undefined;
        try {
          const classified = await extensionQuery(ws, { action: "worktrees.classified" });
          const rows = (classified as { worktrees?: unknown[] })?.worktrees;
          if (!Array.isArray(rows)) throw new Error("engine returned no worktrees payload");
          worktreeRows = rows.map((row) => {
            const e = row as Record<string, unknown>;
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
              classification: e.classification as CockpitWorkspaceBundle["worktrees"][number]["classification"],
            };
          });
        } catch (err) {
          worktreesUnavailable = err instanceof Error ? err.message : String(err);
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
          deliveries: readGitDeliveriesFromDisk(ws.workspaceRoot, { folder: ws.folderName, wsHash: ws.wsHash }),
          approvals: [], // pending list is owned by Approvals panel; deep-link for resolve
          tmux,
          ...(companion ? { companion } : {}),
        });
      }
      return bundles;
    },
    missionBoard: {
      getWorkspaces: () => workspaces().map((ws) => ws.missionControl),
      // t-610705 (Phase D, D2) — Task Studio is a Control studio-edit route now, not a standalone
      // panel: navigate the (already-open, since this fires from inside a live Cockpit message
      // handler) singleton in place, same idiom every other "open a studio route" command/action
      // uses elsewhere in this file. "new" mints an id up front (route.ts's decodeRoute rejects
      // studio-new + "task" outright — same pre-minting TaskStudioAdapter.save() already does for a
      // caller that skips this path entirely) rather than reaching for a "studio-new" route that
      // doesn't exist for "task".
      openTaskStudio: (target, id) => {
        const ws = wsOf({ ws: target });
        if (!ws) return;
        void openCockpit(makeCockpitDeps(), { route: cockpitRoutes.studioEdit("task", ws.wsHash, id ?? mintTaskId()) });
      },
      onTasksChanged,
    },
    // t-610705 (Phase C.1) — Task Detail is a Control subroute now (WorkspaceTaskDetailTarget
    // already carries loadTaskDetail/updateTask/reviewPrototype/attachment resolution).
    taskDetail: {
      getWorkspaces: () => workspaces().map((ws) => ws.taskDetail),
    },
    // t-610705 (Phase C.2) — Activity/Probes are Control subroutes now (WorkspaceActivityTarget /
    // WorkspaceProbePresentationTarget already carry everything the host needs — no separate
    // wrapper interface, same reasoning as taskDetail above).
    activity: {
      getWorkspaces: () => workspaces().map((ws) => ws.activity),
    },
    probes: {
      getWorkspaces: () => workspaces().map((ws) => ws.probe),
    },
    // t-610705 (Phase C.3) — Handoff folds into a Control section (WorkspaceHandoffTarget already
    // carries everything the host needs).
    handoff: {
      getWorkspaces: () => workspaces().map((ws) => ws.handoff),
    },
    // t-610705 (Phase D, D0) — StudioPanelManagerBase-based studios migrated onto a Control route
    // (studios-routes-design.md). WorkspaceShellHandle already implements WorkspaceStudioTarget
    // directly (no per-studio accessor needed, unlike taskDetail/activity/handoff above) — command/
    // terminal/runbook/schedule/agent studios all read the SAME shape; onChanged mirrors every
    // retired studio panel manager's refreshAll fan-out.
    studios: {
      getWorkspaces: () => workspaces(),
      onChanged: refreshAll,
    },
    approvals: {
      getWorkspaces: () =>
        workspaces().map((ws) => ({
          workspaceRoot: ws.workspaceRoot,
          wsHash: ws.wsHash,
          folderName: ws.folderName,
        })),
      resolve: async (wsHash, id, decision) => {
        const ws = byHash(wsHash);
        if (!ws) throw new Error(`workspace ${wsHash} is not attached`);
        await extensionInvoke(ws, { action: "approval.resolve", id, decision });
        notify(`approval request ${id} ${decision}`);
        refreshAll();
        refreshCockpitApprovals();
      },
    },
    validations: {
      getWorkspaces: () => workspaces().map((ws) => ws.missionControl),
      onValidationsChanged: () => {
        refreshCockpitValidations();
        refreshCockpitMissionBoard();
      },
    },
    runtimeOps: {
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
    },
    inspector: (() => {
      const insp = makeServerInspectorDeps();
      return {
        snapshot: insp.snapshot,
        folderByHash: insp.folderByHash,
        cpuBusy: insp.cpuBusy,
        serverHealth: insp.serverHealth,
        capture: insp.capture,
        open: insp.open,
        kill: insp.kill,
        reapDead: insp.reapDead,
        reapOrphans: insp.reapOrphans,
      };
    })(),
    plugins: pluginsPanels,
    openSettings: () => {
      void vscode.commands.executeCommand("tachyon.openSettings");
    },
    openDoctor: () => {
      void vscode.commands.executeCommand("tachyon.doctor");
    },
    fleetStart: async (name, wsHash) => {
      await vscode.commands.executeCommand("tachyon.spawnAgentItem", { agentName: name, workspaceHash: wsHash });
    },
    fleetStop: async (name, wsHash) => {
      await vscode.commands.executeCommand("tachyon.stopAgentItem", { agentName: name, workspaceHash: wsHash });
    },
    // SDD 443 — webview QuickPicker already chose toName; host revalidates against live list.
    fleetContinueTask: async (fromName, toName, wsHash) => {
      const ws = wsHash ? byHash(wsHash) : workspaces()[0];
      if (!ws) throw new Error("no Tachyon workspace for that hash");
      if (!toName || toName === fromName) {
        throw new Error("Continue task requires a different destination agent");
      }
      const listed = await extensionQuery(ws, { action: "agents.list" });
      const rows = Array.isArray(listed) ? listed : [];
      type AgentRow = { name?: string; running?: boolean; kind?: string; declared?: boolean };
      const dest = rows
        .map((r) => r as AgentRow)
        .find((r) => r.name === toName);
      if (!dest || typeof dest.name !== "string") {
        throw new Error(`destination agent '${toName}' not found`);
      }
      if (dest.kind === "terminal") {
        throw new Error(`destination '${toName}' is a terminal agent — pick a declared runtime agent`);
      }
      if (dest.declared === false) {
        throw new Error(`destination '${toName}' is ad-hoc (not declared in tachyon.yml)`);
      }
      if (dest.running) {
        throw new Error(`destination '${toName}' is running — stop it first`);
      }
      const result = jsonObject(
        await extensionInvoke(ws, {
          action: "agent.continue-task",
          fromAgent: fromName,
          toAgent: toName,
          reason: "continued from Control Fleet",
        }),
        "agent.continue-task",
      );
      if (result.ok !== true) {
        throw new Error(typeof result.message === "string" ? result.message : "continue-task failed");
      }
      const handoff = typeof result.handoffPath === "string" ? result.handoffPath : "";
      void vscode.window.showInformationMessage(
        handoff
          ? vscode.l10n.t("Continued {0} → {1} ({2})", fromName, toName, handoff)
          : vscode.l10n.t("Continued {0} → {1}", fromName, toName),
      );
    },
    fleetTerminal: async (name, wsHash) => {
      await vscode.commands.executeCommand("tachyon.openAgentTerminalItem", name, wsHash);
    },
    revealPath: (fsPath) => {
      void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(fsPath));
    },
    // spec 444 — Worktrees hygiene. Return value = human-readable refusal (undefined = success);
    // the engine's ManagedWorktreeService re-validates fail-closed on every call.
    worktreeRemove: async (id, deleteBranch, wsHash) => {
      const ws = wsHash ? byHash(wsHash) : workspaces()[0];
      if (!ws) throw new Error("no Tachyon workspace attached");
      const result = jsonObject(
        await extensionInvoke(ws, { action: "worktree.remove-managed", id, ...(deleteBranch ? { deleteBranch: true } : {}) }),
        "worktree.remove-managed",
      );
      if (result.removed === true) return undefined;
      return String(result.error ?? "removal refused");
    },
    worktreeForgetRecord: async (id, wsHash) => {
      const ws = wsHash ? byHash(wsHash) : workspaces()[0];
      if (!ws) throw new Error("no Tachyon workspace attached");
      const result = jsonObject(
        await extensionInvoke(ws, { action: "worktree.forget-record", id }),
        "worktree.forget-record",
      );
      if (result.forgotten === true) return undefined;
      return `record not found or refused: ${id}`;
    },
    openConfigFile: async (wsHash) => {
      const ws = wsHash ? byHash(wsHash) : workspaces()[0];
      if (!ws) throw new Error("no Tachyon workspace attached");
      const cfg = CONFIG_FILENAMES.map((name) => path.join(ws.workspaceRoot, name)).find((file) => fs.existsSync(file));
      if (!cfg) throw new Error(`no tachyon config found under ${ws.workspaceRoot}`);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(cfg));
      await vscode.window.showTextDocument(doc, { preview: false });
    },
    clearEngineLog: async (wsHash) => {
      const ws = byHash(wsHash);
      if (!ws) throw new Error("no Tachyon workspace for that hash");
      await ws.client.clearEngineLog();
    },
    openEngineJournal: (wsHash) => {
      const ws = byHash(wsHash);
      if (!ws) throw new Error("no Tachyon workspace for that hash");
      const unit = `tachyon-engine-${ws.wsHash}.service`;
      const term = vscode.window.createTerminal({ name: `Engine log · ${ws.folderName}` });
      term.show();
      // follow journal for this workspace engine unit
      term.sendText(`journalctl --user -u ${JSON.stringify(unit)} -n 200 -f`, true);
    },
    setCompanionTabTools: async (wsHash, enabled) => {
      const ws = byHash(wsHash);
      if (!ws) throw new Error("no Tachyon workspace for that hash");
      await extensionInvoke(ws, { action: "config.companion.tabTools", enabled });
    },
    setCompanionAllowedHosts: async (wsHash, hosts) => {
      const ws = byHash(wsHash);
      if (!ws) throw new Error("no Tachyon workspace for that hash");
      await extensionInvoke(ws, { action: "config.companion.allowedHosts", hosts });
    },
    unpairCompanionDevice: async (wsHash, deviceId) => {
      const ws = byHash(wsHash);
      if (!ws) throw new Error("no Tachyon workspace for that hash");
      await extensionInvoke(ws, {
        action: "companion.unpair",
        ...(deviceId ? { deviceId } : {}),
      });
    },
    issueCompanionPairCode: async (wsHash) => {
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
  );
  context.subscriptions.push({ dispose: () => terminals.dispose() });

  const versionValue = (context.extension.packageJSON as { version?: unknown }).version;
  const shellVersion = typeof versionValue === "string" && versionValue.trim() ? versionValue : "development";
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
        migrationProvider: () => collectLegacyEngineStateMigration(workspaceHash(workspaceRoot), {
          globalStorageRoot: context.globalStorageUri.fsPath,
          getState: <T>(key: string) => context.globalState.get<T>(key),
          getSecret: (key: string) => Promise.resolve(context.secrets.get(key)),
        }),
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
      if (result.resynced || result.engineChanged) refreshAll();
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
    const client = await clientRegistry.attach(folderPath).catch((error: unknown) => {
      notify(vscode.l10n.t("Tachyon persistent engine could not start: {0}", error instanceof Error ? error.message : String(error)), "error");
      throw error;
    });
    const gitExec = createGitExec(() => resolveGitBinary({
      configuredPath: vscode.workspace.getConfiguration("tachyon", vscode.Uri.file(client.workspaceRoot)).get<string>("gitPath"),
      gitExtensionPath: vscode.workspace.getConfiguration("git", vscode.Uri.file(client.workspaceRoot)).get<string | string[]>("path"),
    }));
    const ws = new WorkspaceShellHandle(client, { extensionUri: context.extensionUri, gitExec });
    registry.set(folderPath, ws);
    startClientSync(ws);
    if (hasConfig(folderPath)) syncWorkspaceToolLauncher(folderPath);
    if (refreshOnSuccess) refreshAll();
    return ws;
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
    shouldDefer: (state: { wsHash?: unknown }) =>
      !workspaceReviversReady
      && typeof state.wsHash === "string"
      && !workspaces().some((ws) => ws.wsHash === state.wsHash),
    onReady: (callback: () => void): void => {
      deferredWorkspacePanelRevives.push(callback);
    },
  };
  const flushDeferredWorkspacePanelRevives = (): void => {
    workspaceReviversReady = true;
    for (const callback of deferredWorkspacePanelRevives.splice(0)) callback();
  };

  // t-610705 (Phase B #6) — a revived pre-410 standalone Board panel disposes itself and redirects
  // into Control → Mission scoped to its persisted workspace, same as tachyon.missionControl.
  // (Phase C.0) — unless Control's OWN revival/open already claimed the singleton this session:
  // VS Code doesn't guarantee revive order, and a shim redirect after the real Cockpit already
  // restored (possibly onto a different route the user is looking at) must not clobber it.
  registerTrustedPanelSerializer<MissionControlPanelState>(context, MISSION_CONTROL_VIEW_TYPE, (panel, state) => {
    panel.dispose();
    if (isCockpitSingletonClaimed()) return;
    void openCockpit(makeCockpitDeps(), { section: "mission", wsHash: state?.wsHash });
  });
  // t-610705 (Phase C.1) — a revived pre-410 standalone Task Detail panel disposes itself and
  // redirects into Control → the task's subroute; same claimed-singleton guard as Board/tmux above
  // (open() was already unreachable — nothing to "keep working" here beyond this revive path).
  registerTrustedPanelSerializer<TaskDetailPanelState>(context, TASK_DETAIL_VIEW_TYPE, (panel, state) => {
    panel.dispose();
    if (isCockpitSingletonClaimed()) return;
    if (!state?.wsHash || !state?.taskId) return;
    void openCockpit(makeCockpitDeps(), { route: cockpitRoutes.taskDetail(state.wsHash, state.taskId) });
  });
  registerTrustedPanelSerializer<ActivityPanelState>(context, ACTIVITY_VIEW_TYPE, (panel, state) => {
    panel.dispose();
    if (isCockpitSingletonClaimed()) return;
    if (!state?.wsHash || !state?.agent) return;
    void openCockpit(makeCockpitDeps(), { route: cockpitRoutes.agentActivity(state.wsHash, state.agent) });
  });
  registerTrustedPanelSerializer<HandoffPanelState>(context, HANDOFF_VIEW_TYPE, (panel, state) => {
    panel.dispose();
    if (isCockpitSingletonClaimed()) return;
    if (!state?.wsHash) return;
    void openCockpit(makeCockpitDeps(), { section: "handoff", wsHash: state.wsHash });
  });
  registerTrustedPanelSerializer<ApprovalPanelState>(context, APPROVAL_VIEW_TYPE, (panel, state) => approvalPanels.deserialize(panel, state), { defer: workspacePanelReviveDeferral });
  registerTrustedPanelSerializer<PluginsPanelState>(context, PLUGINS_VIEW_TYPE, (panel, state) => pluginsPanels.deserialize(panel, state), { defer: workspacePanelReviveDeferral });
  registerTrustedPanelSerializer<ProbesPanelState>(context, PROBES_VIEW_TYPE, (panel, state) => {
    panel.dispose();
    if (isCockpitSingletonClaimed()) return;
    if (!state?.wsHash) return;
    const route = state.caller ? cockpitRoutes.agentProbes(state.wsHash, state.caller) : cockpitRoutes.workspaceProbes(state.wsHash);
    void openCockpit(makeCockpitDeps(), { route });
  });
  registerTrustedPanelSerializer<PinPreviewPanelState>(context, PIN_PREVIEW_VIEW_TYPE, (panel, state) => sidebarProto.deserializePinPreview(panel, state));
  // t-610705 (SDD 410 Phase D, D0/D1a/D1b) — a revived pre-410 standalone studio panel disposes itself
  // and redirects into Control → the mapped studio route, same claimed-singleton guard as every
  // other retired-panel serializer above. KNOWN GAP (documented, not silently dropped): unlike the
  // full studios-routes-design.md's exactly-once ack-based legacy handoff (round-1 F7 / round-2 F6 —
  // custody transfers only after Control durably accepts the seed), THIS redirect does not attempt
  // to carry `state.snapshot.patch` forward — a dirty pre-410 draft open across a reload is simply
  // not restored. Scopes down to the in-SESSION draft cache only (studioHost.ts's cacheDraft/
  // takeDraftFor); the reload-survival mechanism is deferred to when a studio genuinely needs it
  // (flagged for the D0 code review probe). One shared helper (D1a) — command/terminal/runbook/
  // schedule all redirect identically, only the viewType/StudioId differ.
  const registerLegacyStudioRedirect = <TState extends StudioPanelState<unknown>>(viewType: string, studio: StudioId) => {
    registerTrustedPanelSerializer<TState>(context, viewType, (panel, state) => {
      panel.dispose();
      if (isCockpitSingletonClaimed()) return;
      if (!state?.wsKey) return;
      const route = state.snapshot.mode === "edit" && state.snapshot.entityId
        ? cockpitRoutes.studioEdit(studio, state.wsKey, state.snapshot.entityId)
        : cockpitRoutes.studioNew(studio, state.wsKey);
      void openCockpit(makeCockpitDeps(), { route });
    });
  };
  registerLegacyStudioRedirect<CommandStudioPanelState>(COMMAND_STUDIO_SHELL_VIEW_TYPE, "command");
  registerLegacyStudioRedirect<TerminalStudioPanelState>(TERMINAL_STUDIO_SHELL_VIEW_TYPE, "terminal");
  registerLegacyStudioRedirect<RunbookStudioPanelState>(RUNBOOK_STUDIO_SHELL_VIEW_TYPE, "runbook");
  registerLegacyStudioRedirect<ScheduleStudioPanelState>(SCHEDULE_STUDIO_SHELL_VIEW_TYPE, "schedule");
  registerLegacyStudioRedirect<AgentStudioPanelState>(AGENT_STUDIO_SHELL_VIEW_TYPE, "agent");
  // t-610705 (Phase D, D3) — unlike Task, Pin's studioNew never throws (pin IS reachable id-less —
  // a brand-new pin has no id until its first save) — the shared helper works as-is.
  registerLegacyStudioRedirect<PinStudioPanelState>(PIN_STUDIO_VIEW_TYPE, "pin");
  // t-610705 (Phase D, D2) — Task Studio's redirect can't reuse registerLegacyStudioRedirect's shared
  // helper as-is: its non-edit fallback calls cockpitRoutes.studioNew(studio, wsKey), which THROWS for
  // "task" (route.ts's defensive assertion — task is never id-less in practice). A persisted "new"
  // Task Studio panel state is a genuinely malformed/legacy edge case (every real "new" caller
  // pre-mints an id and never persists panel state before its first save completes), so this redirects
  // to Mission instead of constructing an invalid route.
  registerTrustedPanelSerializer<TaskStudioPanelState>(context, TASK_STUDIO_VIEW_TYPE, (panel, state) => {
    panel.dispose();
    if (isCockpitSingletonClaimed()) return;
    if (!state?.wsKey) return;
    if (state.snapshot.mode === "edit" && state.snapshot.entityId) {
      void openCockpit(makeCockpitDeps(), { route: cockpitRoutes.studioEdit("task", state.wsKey, state.snapshot.entityId) });
      return;
    }
    void openCockpit(makeCockpitDeps(), { section: "mission", wsHash: state.wsKey });
  });
  registerTrustedPanelSerializer<PipelineStudioPanelState>(context, PIPELINE_STUDIO_VIEW_TYPE, (panel, state) => pipelineStudioPanels.deserialize(panel, state));
  // t-610705 (SDD 410 Phase B #5) — a revived pre-410 standalone panel disposes itself and
  // redirects into Control → tmux via tachyon.inspectServer, same as the live open path below.
  // (Phase C.0) — same claimed-singleton guard as the Board shim above.
  registerTrustedPanelSerializer<ServerInspectorPanelState>(context, SERVER_INSPECTOR_VIEW_TYPE, (panel) => {
    panel.dispose();
    if (isCockpitSingletonClaimed()) return;
    void vscode.commands.executeCommand("tachyon.inspectServer");
  });
  // t-610705 (Phase C.0) — decodePanelState is the ONE place a v1 disk record (bare section) or a
  // v2 record (a real CockpitRoute) gets trusted; a malformed/unrecognized route falls back to
  // overview rather than reviving into whatever the raw payload happened to contain.
  registerTrustedPanelSerializer<CockpitPanelState>(context, COCKPIT_VIEW_TYPE, (panel, state) => {
    const { route, wsHash } = decodeCockpitPanelState(state);
    return openCockpit(makeCockpitDeps(), { revivedPanel: panel, route, wsHash });
  });
  for (const viewType of ["tachyonPluginSurface", "tachyonPluginSurfaces", "tachyonAgentFixtureStudio", "tachyonControlInspector", "tachyonSketch", "tachyonRuntimeOpsView"]) {
    registerDisposePanelSerializer(context, viewType);
  }

  // Picker for CREATION commands (New Agent / Studio tabs). Same rule as
  // pickWorkspace: only Tachyon-configured folders are offered, and a lone one is
  // auto-selected — when a mix of configured and unconfigured folders is open, the
  // unconfigured ones never appear. The ONE divergence is the zero-configured tail:
  // there it falls back to every open folder and boots the chosen one on demand, so
  // first-run creation is itself the opt-in (the bootstrap path Init also covers).
  const pickFolderForCreate = async (): Promise<WorkspaceShellHandle | undefined> => {
    const configured = configuredWorkspaces();
    if (configured.length === 1) return configured[0];
    if (configured.length > 1) {
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
  for (const folder of folders.filter((f) => shouldActivateFolder(hasConfig(f.uri.fsPath), f.uri.fsPath, currentWorktreesBase()))) {
    await addWorkspace(folder.uri.fsPath, true);
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
    refreshAll,
    reportError: (error) => {
      notify(vscode.l10n.t("Tachyon workspace membership update failed: {0}", error instanceof Error ? error.message : String(error)), "error");
    },
  });

  // spec 237 — the Tachyon sidebar is the Preact webview (the native tree was retired).
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarPrototypeProvider.viewType, sidebarProto, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(PluginSurfaceHost.viewType, pluginSurfaces, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // spec 213 / C2 — serves the BASE side of a worktree diff (git show <ref>:<file>); the
  // current side is the on-disk file. `empty=1` yields "" (added base / deleted current).
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(WT_DIFF_SCHEME, {
      async provideTextDocumentContent(uri) {
        const q = new URLSearchParams(uri.query);
        if (q.get("empty")) return "";
        const cwd = q.get("cwd");
        const ref = q.get("ref");
        const git = createGitExec(() => resolveGitBinary({
          configuredPath: vscode.workspace.getConfiguration("tachyon").get<string>("gitPath"),
          gitExtensionPath: vscode.workspace.getConfiguration("git").get<string | string[]>("path"),
        }));
        return cwd && ref ? worktreeShowFile(cwd, ref, uri.path.replace(/^\//, ""), git) : "";
      },
    }),
  );

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
    // ---- internal seams (integration tests; default to the single workspace) ----
    vscode.commands.registerCommand("tachyon._agents", (hash?: string) => {
      const ws = byHash(hash);
      return ws ? extensionQuery(ws, { action: "agents.list" }) : [];
    }),
    vscode.commands.registerCommand("tachyon._seedPipelineRun", async (name: string, hash?: string) => {
      const ws = byHash(hash);
      if (!ws) return null;
      const result = jsonObject(await extensionInvoke(ws, { action: "pipeline.seed", name }), "pipeline.seed");
      return typeof result.runId === "string" ? result.runId : null;
    }),
    vscode.commands.registerCommand(
      "tachyon._spawn",
      (name: string, opts?: { cmd?: string; cwd?: string; instructions?: string; parent?: string }, hash?: string) => {
        const ws = byHash(hash);
        return ws ? extensionInvoke(ws, { action: "agent.spawn", agent: name, options: opts }) : undefined;
      },
    ),
    vscode.commands.registerCommand("tachyon._wait", (name: string, until: "idle" | "needs-input" | "dead", timeoutSec: number, hash?: string) => {
      const ws = byHash(hash);
      if (!ws) return { met: false, state: "gone" };
      return extensionQuery(ws, { action: "agent.wait", agent: name, until, timeoutSec });
    }),
    vscode.commands.registerCommand("tachyon._attention", (hash?: string) => {
      const ws = byHash(hash);
      return ws ? extensionQuery(ws, { action: "attention.list" }) : {};
    }),
    vscode.commands.registerCommand("tachyon._pins", (hash?: string) => {
      const ws = byHash(hash);
      return ws ? extensionQuery(ws, { action: "pins.list" }) : [];
    }),
    vscode.commands.registerCommand("tachyon._pin", async (text: string, by?: string, done?: boolean, hash?: string) => {
      const ws = byHash(hash);
      if (!ws) return;
      await extensionInvoke(ws, { action: "pin.create", text, by: by ?? "claude", done: done ?? false });
      refreshAll();
    }),
    vscode.commands.registerCommand("tachyon._upsertAgent", (submit: StudioSubmit, hash?: string) => byHash(hash)?.studioSubmit(submit)),
    vscode.commands.registerCommand("tachyon._runCommand", (name: string, hash?: string) => {
      const ws = byHash(hash);
      return ws ? extensionInvoke(ws, { action: "command.run", name }) : undefined;
    }),
    vscode.commands.registerCommand("tachyon._commands", (hash?: string) => {
      const ws = byHash(hash);
      return ws ? extensionQuery(ws, { action: "commands.list" }) : [];
    }),
    vscode.commands.registerCommand("tachyon._commandTick", (hash?: string) => {
      const ws = byHash(hash);
      return ws ? extensionInvoke(ws, { action: "command.tick" }) : undefined;
    }),
    vscode.commands.registerCommand("tachyon._runRunbook", (name: string, hash?: string) => {
      const ws = byHash(hash);
      return ws ? extensionInvoke(ws, { action: "runbook.run", name }) : undefined;
    }),
    vscode.commands.registerCommand("tachyon._runbooks", (hash?: string) => {
      const ws = byHash(hash);
      return ws ? extensionQuery(ws, { action: "runbooks.list" }) : [];
    }),
    vscode.commands.registerCommand("tachyon._schedules", (hash?: string) => {
      const ws = byHash(hash);
      return ws ? extensionQuery(ws, { action: "schedules.list" }) : [];
    }),
    vscode.commands.registerCommand("tachyon._proposals", (hash?: string) => {
      const ws = byHash(hash);
      return ws ? extensionQuery(ws, { action: "proposals.list" }) : [];
    }),
    vscode.commands.registerCommand("tachyon._propose", async (name: string, schedule: ScheduleDef, reason?: string, hash?: string) => {
      const ws = byHash(hash);
      if (!ws) return;
      await extensionInvoke(ws, { action: "proposal.create", name, schedule: proposalSchedule(schedule), by: "agent", ...(reason ? { reason } : {}) });
      refreshAll();
    }),
    vscode.commands.registerCommand("tachyon._approveProposal", (id: string, hash?: string) => {
      const ws = byHash(hash);
      return ws ? extensionInvoke(ws, { action: "proposal.approve", id }) : undefined;
    }),
    vscode.commands.registerCommand("tachyon._rejectProposal", (id: string, hash?: string) => {
      const ws = byHash(hash);
      return ws ? extensionInvoke(ws, { action: "proposal.reject", id }) : undefined;
    }),
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
    vscode.commands.registerCommand("tachyon._togglePause", (name: string, hash?: string) => byHash(hash)?.sidebar.mutateSidebar({ action: "schedule.toggle-pause", id: name })),
    vscode.commands.registerCommand("tachyon.deleteScheduleItem", async (item: ScheduleItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      const answer = await showNotification(
        vscode.l10n.t("Delete schedule '{0}' from tachyon.yml?", item.scheduleName),
        "warn",
        [vscode.l10n.t("Delete")],
        { modal: true },
      );
      if (answer === vscode.l10n.t("Delete")) await ws.sidebar.mutateSidebar({ action: "schedule.delete", id: item.scheduleName });
    }),
    vscode.commands.registerCommand("tachyon.editScheduleItem", async (item: ScheduleItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      const file = configPathOf(ws);
      if (!file) {
        notify(vscode.l10n.t("no tachyon.yml in this workspace"), "warn");
        return;
      }
      const doc = await vscode.workspace.openTextDocument(file);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const line = scheduleEntryLine(doc.getText(), item.scheduleName);
      if (line !== undefined) {
        const pos = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    }),
    vscode.commands.registerCommand("tachyon._workspaces", () => workspaces().map((ws) => ({ folder: ws.folderName, root: ws.workspaceRoot, hash: ws.wsHash, bridge: ws.bridgeUrl }))),
    /**
     * t-8354ae / EDH palliative — read-only health probe for headless dogfood.
     * Reloads config from disk, returns failure surface + degraded roster extras + LKG-spawn check.
     * Not a user-facing command (underscore); not contributed in package.json.
     */
    vscode.commands.registerCommand("tachyon._configHealth", async (hash?: string) => {
      const ws = hash ? byHash(hash) : workspaces()[0];
      if (!ws) return { ok: false as const, error: "no-workspace" };
      return extensionInvoke(ws, { action: "config.health" });
    }),
    // ---- views ----
    vscode.commands.registerCommand("tachyon.refreshViews", refreshAll),
    vscode.commands.registerCommand("tachyon.openApprovals", async (hash?: string) => {
      // spec 410 — Approvals live in Control (cockpit section); do not open a second peer panel.
      const ws = hash ? byHash(hash) : await pickWorkspace();
      await openCockpit(makeCockpitDeps(), {
        section: "approvals",
        ...(ws ? { approvalWsHash: ws.wsHash } : {}),
      });
    }),
    vscode.commands.registerCommand("tachyon.resolveApproval", async (arg: { id?: string; decision?: "approved" | "denied"; wsHash?: string }) => {
      const ws = targetOf(arg?.wsHash);
      if (!ws || !arg?.id || (arg.decision !== "approved" && arg.decision !== "denied")) return;
      try {
        await extensionInvoke(ws, { action: "approval.resolve", id: arg.id, decision: arg.decision });
        notify(`approval request ${arg.id} ${arg.decision}`);
        refreshAll();
        refreshCockpitApprovals();
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), "error");
        approvalPanels.refreshAll();
        refreshCockpitApprovals();
      }
    }),
    // ---- onboarding (F24) ----
    vscode.commands.registerCommand("tachyon.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "@ext:cfpperche.tachyon"),
    ),
    // t-7bcba6 — tachyon.persistenceSettings (Visible legacy reminders / silentHooks kill switch) removed.
    // ---- server inspector (F27) — cross-workspace socket queries; Control → tmux (t-610705 Phase B #5) ----
    vscode.commands.registerCommand("tachyon.inspectServer", () => openCockpit(makeCockpitDeps(), { section: "tmux" })),
    // ---- Control (desktop MVP, t-fe52f0 frente 1) — editor sysadmin; sidebar header button + palette ----
    vscode.commands.registerCommand("tachyon.openControl", () => openCockpit(makeCockpitDeps())),
    // legacy aliases (palette hidden for openCockpit)
    vscode.commands.registerCommand("tachyon.openCockpit", () => openCockpit(makeCockpitDeps())),
    vscode.commands.registerCommand("tachyon.inspectEngine", () => openCockpit(makeCockpitDeps(), { section: "engine" })),
    // convenience: Control → Mission tab (same as tachyon.missionControl without pick when single-root)
    vscode.commands.registerCommand("tachyon.openControlMission", () => openCockpit(makeCockpitDeps(), { section: "mission" })),
    vscode.commands.registerCommand("tachyon.openControlRuntime", () => openCockpit(makeCockpitDeps(), { section: "runtime" })),
    // t-75fd3c — deep-link straight to a task's detail subroute (the host-agnostic EngineHost.openTask
    // port calls this by name, same indirection focusPrimaryView() uses for tachyonSidebarPrototype.focus).
    vscode.commands.registerCommand("tachyon.openControlTask", (wsHash: string, taskId: string) =>
      openCockpit(makeCockpitDeps(), { route: cockpitRoutes.taskDetail(wsHash, taskId) }),
    ),
    vscode.commands.registerCommand("tachyon.getStarted", () =>
      vscode.commands.executeCommand("workbench.action.openWalkthrough", "cfpperche.tachyon#tachyon.welcome", false),
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
    vscode.commands.registerCommand("tachyon.retireLegacyDeliveryState", async (hash?: string) => {
      const ws = hash ? byHash(hash) : await pickWorkspace();
      if (!ws) return;
      try {
        const preview = jsonObject(
          await extensionQuery(ws, { action: "legacy-delivery.retirement-preview" }),
          "legacy Delivery retirement preview",
        );
        const entries = jsonArray(preview.entries, "legacy Delivery retirement preview entries");
        const counts = jsonObject(preview.counts, "legacy Delivery retirement preview counts");
        const snapshotDigest = preview.snapshotDigest;
        const archiveId = preview.archiveId;
        if (typeof snapshotDigest !== "string" || !/^[a-f0-9]{64}$/.test(snapshotDigest)
          || typeof archiveId !== "string" || archiveId.length === 0 || archiveId.length > 128) {
          throw new Error("persistent engine returned an invalid legacy Delivery retirement preview");
        }
        if (entries.length === 0) {
          notify("No legacy Delivery metadata needs retirement.", "info");
          return;
        }

        const document = await vscode.workspace.openTextDocument({
          language: "json",
          content: legacyRetirementPreviewDocument(preview),
        });
        await vscode.window.showTextDocument(document, { preview: false });

        const confirmLabel = "Archive and retire metadata";
        const choice = await showNotification(
          `Retire ${entries.length} legacy metadata item(s) from '${ws.folderName}'?`,
          "warn",
          [confirmLabel],
          {
            modal: true,
            detail: "This archives and removes only legacy Tachyon metadata. It does not delete branches, commits, worktrees, indexes, or working files. Review the opened JSON preview before confirming."
              + ` Canonical Deliveries preserved: ${String(counts.canonicalDeliveries ?? "unknown")}; linked GitDeliveries preserved: ${String(counts.linkedGitDeliveries ?? "unknown")}.`,
          },
        );
        if (choice !== confirmLabel) return;

        const receipt = jsonObject(await extensionInvoke(ws, {
          action: "legacy-delivery.retirement-apply",
          snapshotDigest,
          archiveId,
        }), "legacy Delivery retirement receipt");
        if (typeof receipt.archivePath !== "string") {
          throw new Error("persistent engine returned an invalid legacy Delivery retirement receipt");
        }
        notify(`Legacy Delivery metadata retired. Archive: ${receipt.archivePath}`, "info");
        refreshAll();
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.openConfig", async (hash?: string) => {
      const ws = hash ? byHash(hash) : workspaces()[0];
      if (!ws) {
        notify(vscode.l10n.t("no Tachyon workspace is active"), "warn");
        return;
      }
      const file = configPathOf(ws) ?? path.join(ws.workspaceRoot, "tachyon.yml");
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
        void showNotification(vscode.l10n.t("'{0}' already has a tachyon.yml.", folder.name), "info", [vscode.l10n.t("Open it")])
          .then(async (choice) => {
            if (choice === vscode.l10n.t("Open it")) {
              const existing = CONFIG_FILENAMES.map((n) => path.join(root, n)).find((p) => fs.existsSync(p))!;
              await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(existing), { preview: false });
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

      const target = path.join(root, "tachyon.yml");
      try {
        fs.writeFileSync(target, buildStarterYaml(detected), "utf8");
      } catch (err) {
        notify(vscode.l10n.t("could not write tachyon.yml: {0}", err instanceof Error ? err.message : String(err)), "error");
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
      notify(vscode.l10n.t("tachyon.yml created — review it, then ▶ an agent in the sidebar (or reload to autostart)"));
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
        void openCockpit(makeCockpitDeps(), { route: cockpitRoutes.studioNew("pin", ws.wsHash) });
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
      void openCockpit(makeCockpitDeps(), { route: cockpitRoutes.studioEdit("pin", ws.wsHash, item.pinId) });
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
        await invokeAgentLifecycle(ws, "agent.stop", item.agentName);
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
    // spec 238 / t-610705 (Phase C.2) — open the normalized activity cockpit for an agent, inside
    // Control (the terminal stays the escape hatch). Silent first-workspace fallback when hash is
    // omitted, matching the retired standalone panel's own resolution (not a picker prompt — this
    // command is mostly invoked from a Fleet row that already knows its own wsHash).
    vscode.commands.registerCommand("tachyon.openAgentActivity", async (agent: string, hash?: string) => {
      const ws = hash ? byHash(hash) : workspaces()[0];
      if (ws) await openCockpit(makeCockpitDeps(), { route: cockpitRoutes.agentActivity(ws.wsHash, agent) });
    }),
    // 0.29.1 — raw transcript escape hatch, demoted from the Activity header button to a palette command.
    vscode.commands.registerCommand("tachyon.openAgentTranscript", () => openCockpitAgentTranscript()),
    // spec 245 — open the read-only Project Handoff panel for a workspace root (from the sidebar header button).
    // spec 297 — resolve the target folder via the shared picker when no hash is passed (no silent folder[0]
    // in a multi-root window); an explicit hash (e.g. the sidebar handoff bar) is honored verbatim.
    vscode.commands.registerCommand("tachyon.openProjectHandoff", async (hash?: string) => {
      // t-610705 (Phase C.3) — Handoff lives in Control (cockpit section); no second peer panel.
      const ws = hash ? byHash(hash) : await pickWorkspace();
      await openCockpit(makeCockpitDeps(), { section: "handoff", ...(ws ? { wsHash: ws.wsHash } : {}) });
    }),
    vscode.commands.registerCommand("tachyon.openPlugins", async (hash?: string) => {
      // spec 410 (t-d23f93) — Plugins live in Control (cockpit section); no second peer panel.
      const ws = hash ? byHash(hash) : await pickWorkspace();
      await openCockpit(makeCockpitDeps(), {
        section: "plugins",
        ...(ws ? { wsHash: ws.wsHash } : {}),
      });
    }),
    vscode.commands.registerCommand("tachyon.openPluginSurface", (arg?: { pluginId?: string; viewId?: string; wsHash?: string } | string) => pluginSurfaces.openSurface(arg)),
    // spec 335 + Control monolith POC — open the Mission board *inside* Control (same board UX; new access path).
    vscode.commands.registerCommand("tachyon.missionControl", async (hash?: string) => {
      const ws = hash ? byHash(hash) : await pickWorkspace();
      if (!ws) return;
      await openCockpit(makeCockpitDeps(), { section: "mission", missionWsHash: ws.wsHash });
    }),
    // spec 339 — open Task Studio in new-task mode from the command palette (mirrors the board's own
    // "+ Task" button and the card context menu's "Edit in Studio", both of which route through the
    // webview's openTaskStudio action instead of a command).
    vscode.commands.registerCommand("tachyon.taskStudio.new", async (hash?: string) => {
      const ws = hash ? byHash(hash) : await pickWorkspace();
      if (ws) await openCockpit(makeCockpitDeps(), { route: cockpitRoutes.studioEdit("task", ws.wsHash, mintTaskId()) });
    }),
    // spec 322 — per-agent probes: the agent row's "…" action passes (hash, agent) and gets that agent's
    // probes only. The no-arg/agent-less form opens the UNFILTERED list — an internal/debug escape hatch for
    // caller-less or orphaned records (not contributed to any menu/palette; probes are per-agent in the UI).
    vscode.commands.registerCommand("tachyon.openProbes", async (hash?: string, agent?: string) => {
      const ws = hash ? byHash(hash) : await pickWorkspace();
      if (!ws) return;
      const route = agent ? cockpitRoutes.agentProbes(ws.wsHash, agent) : cockpitRoutes.workspaceProbes(ws.wsHash);
      await openCockpit(makeCockpitDeps(), { route });
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
      void openCockpit(makeCockpitDeps(), { route: cockpitRoutes.studioNew("agent", ws.wsHash) });
    }),
    vscode.commands.registerCommand("tachyon.newAgentStudio", async () => {
      const ws = await pickFolderForCreate();
      if (!ws) return;
      void openCockpit(makeCockpitDeps(), { route: cockpitRoutes.studioNew("agent", ws.wsHash) });
    }),
    vscode.commands.registerCommand("tachyon.terminalStudio", async () => {
      const ws = await pickFolderForCreate();
      if (!ws) return;
      void openCockpit(makeCockpitDeps(), { route: cockpitRoutes.studioNew("terminal", ws.wsHash) });
    }),
    vscode.commands.registerCommand("tachyon.runbookStudio", async () => {
      const ws = await pickFolderForCreate();
      if (!ws) return;
      void openCockpit(makeCockpitDeps(), { route: cockpitRoutes.studioNew("runbook", ws.wsHash) });
    }),
    vscode.commands.registerCommand("tachyon.editAgentStudioItem", async (item: AgentItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      const def = ws.config?.agents[item.agentName];
      if (!def) {
        notify(vscode.l10n.t("'{0}' is not declared in tachyon.yml (ad-hoc agents have no stored definition)", item.agentName), "warn");
        return;
      }
      // t-610705 (Phase D, D1a/D1b) — both branches are Control routes now.
      const dispatch = {
        agent: () => { void openCockpit(makeCockpitDeps(), { route: cockpitRoutes.studioEdit("agent", ws.wsHash, item.agentName) }); },
        terminal: () => { void openCockpit(makeCockpitDeps(), { route: cockpitRoutes.studioEdit("terminal", ws.wsHash, item.agentName) }); },
      } satisfies Record<"agent" | "terminal", () => void>;
      dispatch[def.kind === "terminal" ? "terminal" : "agent"]();
    }),
    vscode.commands.registerCommand("tachyon.newAgent", async (name?: string, cmd?: string, kindArg?: "agent" | "terminal") => {
      const ws = await pickFolderForCreate();
      if (!ws) return;
      const agentName =
        name ??
        (await vscode.window.showInputBox({
          prompt: vscode.l10n.t("Agent name (a free label — e.g. frontend, reviewer, dev)"),
          validateInput: (v) => (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(v) ? undefined : vscode.l10n.t("letters/digits/_/-, starting with a letter")),
        }));
      if (!agentName) return;
      const agentCmd =
        cmd ??
        (await vscode.window.showInputBox({
          prompt: vscode.l10n.t("Command for '{0}' (what actually runs)", agentName),
          placeHolder: vscode.l10n.t("e.g. claude · codex · agy · npm run dev"),
        }));
      if (!agentCmd) return;
      let kind = kindArg;
      if (!kind && name === undefined) {
        // Interactive flow: confirm the inferred kind (drives grouping + attention defaults).
        const inferred = inferKind(agentCmd);
        const picked = await vscode.window.showQuickPick(
          [
            { label: vscode.l10n.t("Agent"), description: vscode.l10n.t("AI CLI — attention detection on"), value: "agent" },
            { label: vscode.l10n.t("Terminal"), description: vscode.l10n.t("server / shell / build — attention off"), value: "terminal" },
          ].sort((a) => (a.value === inferred ? -1 : 1)),
          { placeHolder: vscode.l10n.t("Kind of '{0}' (detected: {1})", agentName, inferred) },
        );
        if (!picked) return;
        kind = picked.value as "agent" | "terminal";
      }
      const finalKind = kind && kind !== inferKind(agentCmd) ? kind : undefined; // write only when it differs from inference
      await extensionInvoke(ws, { action: "config.agent.add", agent: agentName, cmd: agentCmd, ...(finalKind ? { kind: finalKind } : {}) });
      notify(vscode.l10n.t("'{0}' added — ▶ in the sidebar starts it", agentName));
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
    vscode.commands.registerCommand("tachyon.renameAgentItem", async (item: AgentItem, newNameArg?: string) => {
      const ws = wsOf(item);
      if (!ws) return;
      const newName =
        newNameArg ??
        (await vscode.window.showInputBox({
          prompt: vscode.l10n.t("Rename '{0}' to…", item.agentName),
          value: item.agentName,
          validateInput: (v) => (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(v) ? undefined : vscode.l10n.t("letters/digits/_/-, starting with a letter")),
        }));
      if (!newName || newName === item.agentName) return;
      try {
        await extensionInvoke(ws, { action: "config.agent.rename", agent: item.agentName, newName });
        refreshAll();
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.deleteAgentItem", async (item: AgentItem, forceArg?: boolean) => {
      const ws = wsOf(item);
      if (!ws) return;
      const adhoc = isAdhocItem(item.contextValue);
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
        const effects = adhoc
          ? (hasSession
            ? vscode.l10n.t("This kills its tmux session and deletes its saved state.")
            : vscode.l10n.t("This deletes its saved state."))
          : (hasSession
            ? vscode.l10n.t("This removes it from tachyon.yml, kills its tmux session, and deletes its saved state.")
            : vscode.l10n.t("This removes it from tachyon.yml and deletes its saved state."));
        const prompt = vscode.l10n.t("Remove agent '{0}'? {1}", item.agentName, effects);
        const confirmLabel = vscode.l10n.t("Remove");
        const answer = await showNotification(prompt, "warn", [confirmLabel], { modal: true });
        if (answer !== confirmLabel) return;
      }
      await extensionInvoke(ws, { action: "config.agent.delete", agent: item.agentName, removeWorktree: false });
      refreshAll();
    }),
    vscode.commands.registerCommand("tachyon.removeWorktreeItem", async (item: AgentItem) => {
      // spec 210 — standalone "Remove worktree" (Decision 3): clean up the worktree while
      // keeping the agent entry. Same descendant guard + ownership-aware confirmation.
      const ws = wsOf(item);
      if (!ws) return;
      const inspected = await agentInspection(ws, item.agentName);
      const rec = inspected.worktree;
      if (!rec) {
        notify(vscode.l10n.t("'{0}' has no worktree", item.agentName), "warn");
        return;
      }
      await confirmAndRemoveWorktree(ws, item.agentName, rec, inspected.status);
      refreshAll();
    }),
    vscode.commands.registerCommand("tachyon.reviewWorktreeItem", async (item: AgentItem) => {
      // spec 213 / C2 — review the agent's work: a quick-pick of changed files (base ↔ current).
      const ws = wsOf(item);
      if (!ws) return;
      const review = await worktreeReview(ws, { agent: item.agentName });
      if (!review.record) {
        notify(vscode.l10n.t("'{0}' has no worktree", item.agentName), "warn");
        return;
      }
      await reviewWorktreeDiff(review.record, review.changedFiles, item.agentName);
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
      await reviewWorktreeDiff(review.record, review.changedFiles, runId);
    }),
    vscode.commands.registerCommand("tachyon.verifyAgentItem", async (item: AgentItem) => {
      // spec 214 / C3 — run the agent's declared verify-gate in its worktree, update the badge.
      // Advisory: a failure surfaces but never blocks. Errors (no worktree/verify) are notified.
      const ws = wsOf(item);
      if (!ws) return;
      try {
        await extensionInvoke(ws, { action: "agent.verify", agent: item.agentName });
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), "warn");
      }
      refreshAll();
    }),
    vscode.commands.registerCommand("tachyon.createWorktreePrItem", async (item: AgentItem) => {
      // spec 223 — open a GitHub PR from the worktree's branch, carrying the verify verdict into the
      // body. Human stays at the gate: readiness is probed at CLICK (no per-refresh gh spawn), then an
      // editable title + a modal body preview confirm before `gh pr create` fires.
      const ws = wsOf(item);
      if (!ws) return;
      const review = await worktreeReview(ws, { agent: item.agentName });
      const rec = review.record;
      if (!rec) {
        notify(vscode.l10n.t("'{0}' has no worktree", item.agentName), "warn");
        return;
      }
      if (!fs.existsSync(rec.path)) {
        notify(vscode.l10n.t("'{0}'s worktree path no longer exists", item.agentName), "warn");
        return;
      }
      const readiness = await probePrReadiness(rec.path, true, ws.git.gitExec);
      if (!readiness.ready) {
        notify(vscode.l10n.t("Can't open a PR: {0}", readiness.reason ?? "not ready"), "warn");
        return;
      }
      try {
        // Base BRANCH: ONLY the one persisted at worktree-create (a true fork off a known branch). We
        // never GUESS it from the SHA — an attached/pre-223 worktree has no known base, so we let gh
        // default and say so in the confirm (honest > a confident wrong guess). Detect dirty too
        // (uncommitted changes are NOT pushed → would silently miss the PR).
        const base = rec.baseBranch ?? null;
        const verifyInfo = review.verify && typeof review.verify === "object" && !Array.isArray(review.verify)
          ? jsonObject(review.verify, "worktree verify")
          : undefined;
        const dirty = await isWorktreeDirty(rec.path, ws.git.gitExec);
        const body = composePrBody({
          branch: rec.branch,
          base: base ?? undefined,
          verify: verifyInfo && (verifyInfo.badge === "verified" || verifyInfo.badge === "failing" || verifyInfo.badge === "stale") && typeof verifyInfo.command === "string"
            ? { badge: verifyInfo.badge, command: verifyInfo.command }
            : undefined,
        });
        const title = await vscode.window.showInputBox({
          title: vscode.l10n.t("Create PR for '{0}'", item.agentName),
          prompt: vscode.l10n.t("PR title — the body carries the verify verdict"),
          value: composePrTitle(rec.branch),
        });
        if (!title) return; // cancelled / empty
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
        if (!ok) return;
        const result = await createWorktreePr(rec, { title, body, base: base ?? undefined }, ws.git.gitExec);
        if ("error" in result) {
          notify(vscode.l10n.t("PR failed: {0}", result.error), "error");
          return;
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
    }),
    vscode.commands.registerCommand("tachyon.reanchorAgentItem", async (item: AgentItem) => {
      // spec 216 — re-anchor the agent to its role: rewrite .tachyon/roles/<agent>.md + type a
      // reminder into the pane. Manual path (always on); the auto path is settings.anchor.auto.
      const ws = wsOf(item);
      if (!ws) return;
      try {
        await extensionInvoke(ws, { action: "agent.reanchor", agent: item.agentName });
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), "warn");
      }
    }),
    vscode.commands.registerCommand("tachyon.reinjectContinuityItem", async (item: AgentItem) => {
      // spec 241 — manually re-inject the agent's continuity brief (type the rebuild-context pointer into the
      // pane). Always-on manual path; the auto path fires on a detected discontinuity at idle.
      const ws = wsOf(item);
      if (!ws) return;
      try {
        await extensionInvoke(ws, { action: "agent.inject-continuity", agent: item.agentName });
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), "warn");
      }
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
      // Spec 211: promote an ad-hoc (MCP-spawned) agent to a declared one in
      // tachyon.yml. cmd + kind + instructions; never an absolute cwd (portability).
      const ws = wsOf(item);
      if (!ws) return;
      const name = item.agentName;
      await extensionInvoke(ws, { action: "config.agent.promote", agent: name });
      refreshAll();
      notify(vscode.l10n.t("'{0}' saved to tachyon.yml.", name));
    }),
    vscode.commands.registerCommand("tachyon.editAgentItem", async (item: AgentItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      const file = configPathOf(ws);
      if (!file) {
        notify(vscode.l10n.t("no tachyon.yml in this workspace"), "warn");
        return;
      }
      const doc = await vscode.workspace.openTextDocument(file);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const line = agentEntryLine(doc.getText(), item.agentName);
      if (line !== undefined) {
        const pos = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    }),
    vscode.commands.registerCommand("tachyon.migrateAgentProfile", async () => {
      try { await migrateAgentProfileFlow(); }
      catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
    }),
    vscode.commands.registerCommand("tachyon.rollbackAgentProfile", async () => {
      try { await rollbackAgentProfileFlow(); }
      catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
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
    // ---- commands & runbooks ----
    vscode.commands.registerCommand("tachyon.runCommandItem", async (item: CommandItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      try {
        await extensionInvoke(ws, { action: "command.run", name: item.commandName });
        refreshAll();
        await presentTerminal(
          ws,
          `cmd:${item.commandName}`,
          `tachyon-cmd-${ws.wsHash}-${item.commandName}`,
          `$ ${item.commandName}`,
        );
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.openCommandTerminalItem", async (name: string, hash?: string) => {
      const ws = targetOf(hash);
      if (!ws) return;
      try {
        await presentTerminal(ws, `cmd:${name}`, `tachyon-cmd-${ws.wsHash}-${name}`, `$ ${name}`);
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.runRunbookItem", (item: RunbookItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      void extensionInvoke(ws, { action: "runbook.run", name: item.runbookName }).catch((err) => {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      });
      setTimeout(() => refreshAll(), 50); // pick up "running" promptly
    }),
    vscode.commands.registerCommand("tachyon.openRunbookStepItem", async (runbook: string, index: number, hash?: string) => {
      const ws = targetOf(hash);
      if (!ws) return;
      try {
        await presentTerminal(
          ws,
          `rb:${runbook}:${index}`,
          `tachyon-rb-${ws.wsHash}-${runbook}-${index}`,
          `$ ${runbook}#${index + 1}`,
        );
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.editCommandItem", async (item: CommandItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      const file = configPathOf(ws);
      if (!file) {
        notify(vscode.l10n.t("no tachyon.yml in this workspace"), "warn");
        return;
      }
      const doc = await vscode.workspace.openTextDocument(file);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const line = commandEntryLine(doc.getText(), item.commandName);
      if (line !== undefined) {
        const pos = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    }),
    vscode.commands.registerCommand("tachyon.deleteCommandItem", async (item: CommandItem, forceArg?: boolean) => {
      const ws = wsOf(item);
      if (!ws) return;
      if (!forceArg) {
        const answer = await showNotification(
          vscode.l10n.t("Delete command '{0}' from tachyon.yml?", item.commandName),
          "warn",
          [vscode.l10n.t("Delete")],
          { modal: true },
        );
        if (answer !== vscode.l10n.t("Delete")) return;
      }
      await extensionInvoke(ws, { action: "config.command.delete", name: item.commandName });
    }),
    vscode.commands.registerCommand("tachyon.editCommandStudioItem", async (item: CommandItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      const def = ws.config?.commands[item.commandName];
      if (!def) {
        notify(vscode.l10n.t("'{0}' is not declared in tachyon.yml", item.commandName), "warn");
        return;
      }
      void openCockpit(makeCockpitDeps(), { route: cockpitRoutes.studioEdit("command", ws.wsHash, item.commandName) });
    }),
    vscode.commands.registerCommand("tachyon.commandStudio", async () => {
      const ws = await pickFolderForCreate();
      if (!ws) return;
      void openCockpit(makeCockpitDeps(), { route: cockpitRoutes.studioNew("command", ws.wsHash) });
    }),
    vscode.commands.registerCommand("tachyon.scheduleStudio", async () => {
      const ws = await pickFolderForCreate();
      if (!ws) return;
      void openCockpit(makeCockpitDeps(), { route: cockpitRoutes.studioNew("schedule", ws.wsHash) });
    }),
    vscode.commands.registerCommand("tachyon.editScheduleStudioItem", async (item: ScheduleItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      const def = ws.config?.schedules[item.scheduleName];
      if (!def) {
        notify(vscode.l10n.t("'{0}' is not declared in tachyon.yml", item.scheduleName), "warn");
        return;
      }
      void openCockpit(makeCockpitDeps(), { route: cockpitRoutes.studioEdit("schedule", ws.wsHash, item.scheduleName) });
    }),
    vscode.commands.registerCommand("tachyon.editRunbookStudioItem", async (item: RunbookItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      const def = ws.config?.runbooks[item.runbookName];
      if (!def) {
        notify(vscode.l10n.t("'{0}' is not declared in tachyon.yml", item.runbookName), "warn");
        return;
      }
      void openCockpit(makeCockpitDeps(), { route: cockpitRoutes.studioEdit("runbook", ws.wsHash, item.runbookName) });
    }),
    vscode.commands.registerCommand("tachyon.editRunbookItem", async (item: RunbookItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      const file = configPathOf(ws);
      if (!file) {
        notify(vscode.l10n.t("no tachyon.yml in this workspace"), "warn");
        return;
      }
      const doc = await vscode.workspace.openTextDocument(file);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const line = runbookEntryLine(doc.getText(), item.runbookName);
      if (line !== undefined) {
        const pos = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    }),
    vscode.commands.registerCommand("tachyon.deleteRunbookItem", async (item: RunbookItem, forceArg?: boolean) => {
      const ws = wsOf(item);
      if (!ws) return;
      if (!forceArg) {
        const answer = await showNotification(
          vscode.l10n.t("Delete runbook '{0}' from tachyon.yml?", item.runbookName),
          "warn",
          [vscode.l10n.t("Delete")],
          { modal: true },
        );
        if (answer !== vscode.l10n.t("Delete")) return;
      }
      try {
        await extensionInvoke(ws, { action: "config.runbook.delete", name: item.runbookName });
      } catch (error) {
        notify(error instanceof Error ? error.message : String(error), "warn");
      }
    }),
  );

}

export function deactivate(): void {
  // Detach only the editor leases. The persistent engine, Bridge and agents survive.
  void activeClientRegistry?.close();
  activeClientRegistry = undefined;
  registry.clear();
}
