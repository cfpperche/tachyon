import * as vscode from "vscode";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { doctor, findServerPids, probeServer, recoverWedgedServer, snapshotServerPids, socketPath, TmuxService, SESSION_PREFIX, SOCKET_NAME, type ServerProbe } from "./tmux/TmuxService.js";
import { buildDoctorReport, formatDoctorReport } from "./workspace/doctorReport.js";
import net from "node:net";
import { watchdogStep, type WatchdogState } from "./tmux/wedgeWatchdog.js";
import { isResumable } from "./resume/SessionLedger.js";
import { degradedRosterExtras } from "./config/configFailure.js";
import { subtreeCpuTicks } from "./attention/cpu.js";
import { classifySession } from "./inspector/classify.js";
import { CONFIG_FILENAMES, inferKind, loadConfigFile, type ScheduleDef } from "./config/loadConfig.js";
import { addAgent, cloneAgent, deleteAgent, agentEntryLine, deleteCommand, commandEntryLine, deleteRunbook, runbookEntryLine, scheduleEntryLine } from "./config/YamlConfigEditor.js";
import type { StudioSubmit } from "./webview/studioSubmit.js";
import { openServerInspector, SERVER_INSPECTOR_VIEW_TYPE, type ServerInspectorPanelState, type InspectorDeps } from "./webview/ServerInspector.js";
import { SidebarPrototypeProvider, PIN_PREVIEW_VIEW_TYPE, type PinPreviewPanelState } from "./webview/SidebarPrototype.js";
import { resolveModelFact } from "./sidebar/agentModel.js";
import { RuntimeOpsViewProvider } from "./webview/RuntimeOpsView.js";
import { ActivityPanelManager, ACTIVITY_VIEW_TYPE, type ActivityPanelState } from "./webview/ActivityPanel.js";
import { PluginsPanelManager, PLUGINS_VIEW_TYPE, type PluginsPanelState } from "./webview/PluginsPanel.js";
import { HandoffPanelManager, HANDOFF_VIEW_TYPE, type HandoffPanelState } from "./webview/HandoffPanel.js";
import { ApprovalPanelManager, APPROVAL_VIEW_TYPE, type ApprovalPanelState } from "./webview/ApprovalPanel.js";
import { ProbeResultPanelManager, PROBES_VIEW_TYPE, type ProbesPanelState } from "./webview/ProbeResultPanel.js";
import { PinStudioPanelManager, PIN_STUDIO_VIEW_TYPE, type PinStudioPanelState } from "./webview/PinStudioPanel.js";
import { MissionControlPanelManager, MISSION_CONTROL_VIEW_TYPE, type MissionControlPanelState } from "./webview/MissionControlPanel.js";
import { TaskDetailPanelManager, TASK_DETAIL_VIEW_TYPE, type TaskDetailPanelState } from "./webview/TaskDetailPanel.js";
import { TaskStudioPanelManager, TASK_STUDIO_VIEW_TYPE, type TaskStudioPanelState } from "./webview/TaskStudioPanel.js";
import { AgentStudioPanelManager, AGENT_STUDIO_SHELL_VIEW_TYPE, type AgentStudioPanelState } from "./webview/AgentStudioPanel.js";
import { TerminalStudioPanelManager, TERMINAL_STUDIO_SHELL_VIEW_TYPE, type TerminalStudioPanelState } from "./webview/TerminalStudioPanel.js";
import { CommandStudioPanelManager, COMMAND_STUDIO_SHELL_VIEW_TYPE, type CommandStudioPanelState } from "./webview/CommandStudioPanel.js";
import { RunbookStudioPanelManager, RUNBOOK_STUDIO_SHELL_VIEW_TYPE, type RunbookStudioPanelState } from "./webview/RunbookStudioPanel.js";
import { ScheduleStudioPanelManager, SCHEDULE_STUDIO_SHELL_VIEW_TYPE, type ScheduleStudioPanelState } from "./webview/ScheduleStudioPanel.js";
import { PipelineStudioPanelManager, PIPELINE_STUDIO_VIEW_TYPE, type PipelineStudioPanelState } from "./webview/PipelineStudioPanel.js";
import { ActivityLogManager } from "./webview/ActivityLogManager.js";
import { PluginSurfaceHost } from "./plugins/ui/host.js";
import { syncToolLauncher } from "./plugins/toolProvisionRun.js";
import { buildOffers, type RegistrationOffer } from "./registration/adapters.js";
import { executeWait, type BridgeDeps } from "./bridge/tools.js";
import { RuntimeOpsSnapshotService } from "./runtimeOps/snapshotService.js";
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
import { Workspace, type ViewKind } from "./workspace/Workspace.js";
import { PromptStore } from "./prompts/PromptStore.js";
import { injectTargets, previewBody, submitRefuseReason } from "./prompts/injectFlow.js";
import { VsCodeHost } from "./workspace/VsCodeHost.js";
import type { WorktreeRecord } from "./worktree/WorktreeManager.js";
import { createGitExec, worktreeShowFile, resolveBase } from "./worktree/WorktreeManager.js";
import { resolveGitBinary } from "./worktree/gitBinary.js";
import { emptySides, baseSidePath, diffTitle } from "./worktree/review.js";
import { probePrReadiness, composePrTitle, composePrBody, createWorktreePr, isWorktreeDirty } from "./worktree/pr.js";
import { computeWorkspaceFolderOps, shouldActivateFolder } from "./workspace/workspaceFolderOps.js";
import * as domainActions from "./workspace/domainActions.js";
import { resolveApproval, type ApprovalDecision } from "./bridge/approvalRequest.js";

/** spec 213 — URI scheme for the base side of a worktree diff (git show <ref>:<file>). */
const WT_DIFF_SCHEME = "tachyon-worktree";
import { initializeNativeNotifications, notify } from "./workspace/notify.js";
import { showNotification } from "./workspace/NotificationService.js";
import { detectInstalledClis } from "./webview/cliDetect.js";
import { buildStarterYaml, ensureTachyonGitignore, type DetectedProject } from "./init/initLogic.js";
import { registerDisposePanelSerializer, registerTrustedPanelSerializer } from "./webview/shared/panelSerializer.js";
import { openRuntimeOps } from "./runtimeOps/openRuntimeOps.js";
import { assessBuildProvenance, type BuildStamp } from "./provenance/verify.js";
import { readEmbeddedProvenanceRecord } from "./provenance/record.js";

/**
 * Thin shell over a REGISTRY of Workspaces (multi-root, F9): one Workspace per
 * folder carrying a tachyon.yml, created/disposed live as folders come and go.
 * Commands registered once, globally; each resolves its target folder from the
 * clicked item (`item.ws`), an explicit wsHash argument, or — for palette
 * commands with several folders active — a folder QuickPick.
 */

const registry = new Map<string, Workspace>(); // folder fsPath -> Workspace

declare const __TACHYON_BUILD__: BuildStamp;

function workspaces(): Workspace[] {
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
      for (const ws of workspaces()) {
        ws.handoffStore.appendNote({ agent: "tachyon", kind: "gotcha", summary: warning.message, evidence: warning.kind === "dist-mismatch" ? [warning.file] : [] });
      }
    }
  } catch (err) {
    console.debug(`[tachyon] build provenance check skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface WorkspaceMembershipRefreshDeps {
  registry: Map<string, { dispose(): void | Promise<void> }>;
  hasConfig: (folderPath: string) => boolean;
  currentWorktreesBase: () => string;
  addWorkspace: (folderPath: string, autostart: boolean, refreshOnSuccess?: boolean) => Promise<{ dispose(): void | Promise<void> }>;
  refreshAll: () => void;
  reportError: (error: unknown) => void;
}

/** Registers the live multi-root membership path after activation has built its refresh fan-out. */
export function registerWorkspaceMembershipRefresh(
  onDidChangeWorkspaceFolders: (listener: (event: vscode.WorkspaceFoldersChangeEvent) => void) => vscode.Disposable,
  deps: WorkspaceMembershipRefreshDeps,
): vscode.Disposable {
  return onDidChangeWorkspaceFolders((event) => {
    void refreshWorkspaceMembership(event, deps).catch((error) => reportWorkspaceMembershipError(deps, error));
  });
}

function reportWorkspaceMembershipError(deps: WorkspaceMembershipRefreshDeps, error: unknown): void {
  try {
    deps.reportError(error);
  } catch {
    // A detached workspace event must not turn notification failures into unhandled rejections.
  }
}

async function refreshWorkspaceMembership(event: vscode.WorkspaceFoldersChangeEvent, deps: WorkspaceMembershipRefreshDeps): Promise<void> {
  try {
    for (const removed of event.removed) {
      try {
        const ws = deps.registry.get(removed.uri.fsPath);
        if (ws) {
          deps.registry.delete(removed.uri.fsPath);
          await ws.dispose(); // tmux sessions survive — reattach when the folder returns
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

function liveWorktreesAcrossWorkspaces(): { path: string; agent: string }[] {
  const out: { path: string; agent: string }[] = [];
  for (const ws of workspaces()) {
    for (const [name, rec] of ws.ledger.all()) {
      if (rec.worktree) out.push({ path: rec.worktree.path, agent: name });
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

function applyWorktreeFolderReveal(): void {
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
  const ops = computeWorkspaceFolderOps(currentFolders, liveWorktreesAcrossWorkspaces(), currentWorktreesBase());
  if (ops.add.length === 0 && ops.remove.length === 0) return;
  // Remove highest index first so earlier indices in the same batch stay valid, then append adds.
  for (const idx of [...ops.remove].sort((a, b) => b - a)) vscode.workspace.updateWorkspaceFolders(idx, 1);
  if (ops.add.length > 0) {
    const start = (vscode.workspace.workspaceFolders ?? []).length;
    vscode.workspace.updateWorkspaceFolders(start, 0, ...ops.add.map((f) => ({ uri: vscode.Uri.file(f.path), name: f.name })));
  }
}

function byHash(hash?: string): Workspace | undefined {
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
function configuredWorkspaces(): Workspace[] {
  return workspaces().filter((ws) => hasConfig(ws.workspaceRoot));
}

/** Folder disambiguation: 0 configured → undefined+warn, 1 → it, N → QuickPick (configured only). */
async function pickWorkspace(): Promise<Workspace | undefined> {
  const all = configuredWorkspaces();
  if (all.length === 0) {
    notify(vscode.l10n.t("no Tachyon workspace is active"), "warn");
    return undefined;
  }
  if (all.length === 1) return all[0];
  const picked = await vscode.window.showQuickPick(
    all.map((ws) => ({ label: ws.folderName, description: ws.bridgeUrl() ?? "", ws })),
    { placeHolder: vscode.l10n.t("Which folder?") },
  );
  return picked?.ws;
}

/** Resolves the target for arg-style commands: explicit hash beats the single default. */
function targetOf(hash?: string): Workspace | undefined {
  const ws = byHash(hash);
  if (!ws) notify(vscode.l10n.t("no Tachyon workspace is active"), "warn");
  return ws;
}

/**
 * Tree items carry their Workspace; integration tests and external automation
 * pass plain objects — those resolve to the single active workspace.
 */
function wsOf<T extends { ws?: Workspace }>(item: T): Workspace | undefined {
  const ws = item.ws ?? byHash(undefined);
  if (!ws) notify(vscode.l10n.t("no Tachyon workspace is active"), "warn");
  return ws;
}


/** spec 381 — shared inject flow for palette + sidebar. `preselectedAgent` skips the agent QuickPick. */
async function injectPromptTemplateFlow(ws: Workspace, preselectedAgent?: string): Promise<void> {
  const store = new PromptStore(ws.workspaceRoot);
  const lib = store.list();
  if (lib.templates.length === 0) {
    const skipHint = lib.skipped.length > 0
      ? vscode.l10n.t(" ({0} file(s) skipped)", lib.skipped.length)
      : "";
    notify(
      vscode.l10n.t("No prompt templates in {0}/ — add <id>.md files there.{1}", store.relDir, skipHint),
      "warn",
    );
    return;
  }

  const tplPick = await vscode.window.showQuickPick(
    lib.templates.map((t) => ({
      label: t.title,
      description: t.id,
      detail: t.body.split("\n")[0]?.slice(0, 120),
      template: t,
    })),
    { title: vscode.l10n.t("Inject prompt template"), placeHolder: vscode.l10n.t("Choose a template") },
  );
  if (!tplPick) return;
  const template = tplPick.template;

  let agentName = preselectedAgent;
  if (!agentName) {
    const listed = await ws.manager.list();
    const targets = injectTargets(listed);
    if (targets.length === 0) {
      notify(vscode.l10n.t("No running AI agent available for prompt injection."), "warn");
      return;
    }
    const agentPick = await vscode.window.showQuickPick(
      targets.map((t) => ({ label: t.name, description: t.description })),
      { title: vscode.l10n.t("Send to agent"), placeHolder: vscode.l10n.t("Choose a running AI agent") },
    );
    if (!agentPick) return;
    agentName = agentPick.label;
  }

  const still = (await ws.manager.list()).find((a) => a.name === agentName);
  if (!still || still.kind !== "agent" || !still.running || still.dead || still.stopping) {
    notify(vscode.l10n.t("Agent '{0}' is no longer available.", agentName), "warn");
    return;
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

  const preview = previewBody(template.body);
  const actionLabel = submit ? vscode.l10n.t("Submit") : vscode.l10n.t("Stage");
  const ok = await showNotification(
    submit
      ? vscode.l10n.t("Submit prompt template into '{0}'?", agentName)
      : vscode.l10n.t("Stage prompt template into '{0}'?", agentName),
    "info",
    [actionLabel],
    { modal: true, detail: preview },
  );
  if (ok !== actionLabel) return;

  // Re-check liveness after confirm
  const live = (await ws.manager.list()).find((a) => a.name === agentName);
  if (!live || live.kind !== "agent" || !live.running || live.dead || live.stopping) {
    notify(vscode.l10n.t("Agent '{0}' is no longer available.", agentName), "warn");
    return;
  }

  const session = ws.manager.session(agentName);
  if (!(await ws.tmux.hasSession(session))) {
    notify(vscode.l10n.t("Agent '{0}' is not running.", agentName), "warn");
    return;
  }

  if (submit) {
    const att = ws.attentionOf(agentName);
    const refuse = submitRefuseReason(att?.state, att?.composerOccupied);
    if (refuse) {
      const why =
        refuse === "composer-occupied"
          ? vscode.l10n.t("composer has a draft")
          : vscode.l10n.t("busy ({0})", refuse);
      notify(
        vscode.l10n.t("Submit refused — '{0}' is {1}. Use Stage, or wait for idle.", agentName, why),
        "warn",
      );
      return;
    }
    if (typeof ws.tmux.sendSubmittedLine === "function") {
      await ws.tmux.sendSubmittedLine(session, template.body);
    } else {
      await ws.tmux.sendKeys(session, template.body, true);
    }
    notify(vscode.l10n.t("Prompt template '{0}' submitted to '{1}'.", template.title, agentName));
  } else {
    await ws.tmux.sendKeys(session, template.body, false);
    notify(vscode.l10n.t("Prompt template '{0}' staged into '{1}' (not submitted).", template.title, agentName));
  }
}


/** spec 213 / 230 — quick-pick the changed files of a worktree (base ↔ current), each opening VS Code's
 *  native diff. Shared by the agent worktree review and the pipeline run "View changes". */
async function reviewWorktreeDiff(ws: Workspace, rec: WorktreeRecord, label: string): Promise<void> {
  const changes = await ws.worktrees.changedFiles(rec.path, rec.baseRef);
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
async function startPipelineWithInput(ws: Workspace, name: string): Promise<void> {
  if (!ws.pipelineNeedsInput(name)) {
    await ws.startPipeline(name);
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
  const runId = await ws.startPipeline(name, text);
  if (runId) {
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
async function confirmAndRemoveWorktree(
  ws: Workspace,
  name: string,
  rec: WorktreeRecord,
): Promise<"removed" | "kept" | "blocked"> {
  const live = await ws.manager.liveDescendants(name);
  if (live.length > 0) {
    notify(vscode.l10n.t("Stop '{0}'s sub-agents first ({1}) — they share its worktree.", name, live.join(", ")), "warn");
    return "blocked";
  }
  const st = await ws.worktrees.status(rec.path, rec.baseRef);
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
  // Never remove a worktree out from under the agent's own running process — stop it first,
  // and if the stop genuinely fails (session still present), abort rather than yank the cwd
  // (review fixes: removal used to run before the kill, and a failed kill was swallowed).
  if ((await ws.manager.agentStates()).has(name)) {
    try {
      await ws.manager.kill(name);
    } catch {
      /* may already be gone — re-check below */
    }
    if ((await ws.manager.agentStates()).has(name)) {
      notify(vscode.l10n.t("Could not stop '{0}' — its worktree was left intact.", name), "error");
      return "kept";
    }
  }
  const res = await ws.worktrees.remove(rec, true); // safe-deletes a merged Tachyon branch; keeps anything unmerged/human
  if (!res.removed) {
    notify(vscode.l10n.t("Worktree removal failed: {0}", res.error ?? ""), "error");
    return "kept";
  }
  ws.ledger.clearWorktree(name);
  if (res.branchDeleted) {
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
    const ok = await ws.worktrees.deleteBranch(rec.branch);
    notify(ok ? vscode.l10n.t("Branch '{0}' deleted.", rec.branch) : vscode.l10n.t("Could not delete '{0}' (unmerged? checked out?).", rec.branch), ok ? "info" : "warn");
  }
  return "removed";
}

function hasConfig(folderPath: string): boolean {
  return CONFIG_FILENAMES.some((name) => fs.existsSync(path.join(folderPath, name)));
}

async function pickAgent(ws: Workspace, placeholder: string, runningOnly: boolean): Promise<string | undefined> {
  const agents = await ws.manager.list();
  const candidates = runningOnly ? agents.filter((a) => a.running) : agents;
  if (candidates.length === 0) {
    notify(runningOnly ? vscode.l10n.t("no agents running") : vscode.l10n.t("no agents declared or running"), "warn");
    return undefined;
  }
  return vscode.window.showQuickPick(
    candidates.map((a) => a.name),
    { placeHolder: placeholder },
  );
}

async function connectRuntime(ws: Workspace): Promise<void> {
  const url = ws.bridge.url;
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

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initializeNativeNotifications();
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

  // A WEDGED server (zombie: holds the socket, fails every command) would turn
  // activation into an error storm with no obvious way out — offer the one-click
  // recovery up front. Healthy/cleanly-down probes return in one tmux call.
  const offerServerRecovery = async (pids: number[]): Promise<boolean> => {
    const recover = vscode.l10n.t("Recover");
    const pick = await showNotification(
      vscode.l10n.t("the tmux server on Tachyon's dedicated socket looks wedged — it holds the socket but fails every command. Recover now? (kills the stuck server; its sessions are already lost)"),
      "warn",
      [recover],
    );
    if (pick !== recover) return false;
    await recoverWedgedServer({ pids });
    notify(vscode.l10n.t("tmux server recovered — the next start boots a fresh one."));
    return true;
  };
  const startupProbe = await probeServer();
  if (startupProbe.state === "wedged") await offerServerRecovery(startupProbe.pids);

  // spec 217 — background wedge watchdog. probeServer otherwise runs only at activation + two
  // manual commands, so a server that wedges mid-session (field incident 2026-06-14) is invisible
  // until reload. Poll on a low-frequency timer and AUTO-recover a TWO-tick-confirmed wedge (D-B:
  // a wedge already lost every session, so SIGKILLing the zombie loses nothing; the two-tick
  // confirm guards a transient WSL hiccup). ONE global watchdog — the dedicated socket is
  // process-global, not per-workspace.
  // SELF-RESCHEDULING (not setInterval) so ticks never overlap: probeServer uses execFile with no
  // timeout and the wedge IS a stuck-process class, so a slow probe under setInterval could complete
  // out of order and reorder observations (e.g. wedged→healthy→wedged arriving healthy→wedged→wedged),
  // faking the "two consecutive wedged" invariant and auto-SIGKILLing a healthy server (codex r2 MAJOR).
  // The next probe starts only after the current one (and any recovery) fully settles.
  let watchdog: WatchdogState = "idle";
  let watchdogDisposed = false;
  let watchdogTimer: ReturnType<typeof setTimeout>;
  const WATCHDOG_MS = 30_000;
  const tickWatchdog = async (): Promise<void> => {
    if (watchdogDisposed) return;
    try {
      let probe: ServerProbe;
      try {
        probe = await probeServer();
      } catch {
        // A probe error is not a wedge confirmation — feed "unknown" so it breaks a pending arm
        // (recovery needs two genuinely consecutive wedged ticks) without un-latching.
        watchdog = watchdogStep(watchdog, "unknown").next;
        return;
      }
      if (watchdogDisposed) return; // ignore a completion that landed after disposal
      const { next, action } = watchdogStep(watchdog, probe.state);
      watchdog = next;
      if (action === "recover" && probe.state === "wedged") {
        const snap = await snapshotServerPids(probe.pids);
        console.warn(`[tachyon] wedged tmux server auto-recovered. Server snapshot before SIGKILL:\n${snap}`);
        await recoverWedgedServer({ pids: probe.pids });
        notify(
          vscode.l10n.t("the tmux server was wedged — auto-recovered. Restart your agents to continue."),
          "warn",
        );
      }
    } finally {
      if (!watchdogDisposed) watchdogTimer = setTimeout(() => void tickWatchdog(), WATCHDOG_MS);
    }
  };
  watchdogTimer = setTimeout(() => void tickWatchdog(), WATCHDOG_MS);
  context.subscriptions.push({
    dispose: () => {
      watchdogDisposed = true;
      clearTimeout(watchdogTimer);
    },
  });

  // spec 237 — the Preact webview sidebar is THE Tachyon view (the native tree was retired). refreshAll
  // pushes the live fleet to it on every state change; it's registered below.
  const runtimeOpsSnapshots = new RuntimeOpsSnapshotService(workspaces);
  // spec 378 — the sidebar's model row gathers the same view-independent observed-model accessor the
  // RuntimeOps snapshot uses, so a row shows the live transcript model even when RuntimeOps is never opened.
  const sidebarProto = new SidebarPrototypeProvider(context.extensionUri, workspaces, context.globalState, (ws, agentName) =>
    runtimeOpsSnapshots.observedModelFor(ws.workspaceRoot, ws.wsHash, agentName),
  );
  const runtimeOps = new RuntimeOpsViewProvider(context.extensionUri, () => runtimeOpsSnapshots.snapshot());
  // spec 238 — the editor-area Runtime Activity View (normalized cockpit; reads the durable per-agent log).
  const activityPanels = new ActivityPanelManager(context.extensionUri, workspaces);
  context.subscriptions.push({ dispose: () => activityPanels.dispose() });
  // spec 245 — the editor-area Project Handoff panel (read-only doc + pending notes + staleness; one per root).
  const handoffPanels = new HandoffPanelManager(context.extensionUri, workspaces);
  context.subscriptions.push({ dispose: () => handoffPanels.dispose() });
  // spec 349 — first-party host for untrusted plugin UI surfaces. It reads committed plugin lockfiles and
  // revokes open channels when an installed view target disappears.
  const pluginSurfaces = new PluginSurfaceHost(context.extensionUri, workspaces);
  context.subscriptions.push({ dispose: () => pluginSurfaces.dispose() });
  // spec 250 — the editor-area Plugins View (browse/install/update/remove; one per root), opened by the
  // sidebar title button. Step B = read-only render of the installed list from the committed lockfile.
  const pluginsPanels = new PluginsPanelManager(context.extensionUri, workspaces, () => pluginSurfaces.refreshAll());
  context.subscriptions.push({ dispose: () => pluginsPanels.dispose() });
  // spec 257 — the editor-area Probes inspector (read-only list of captured probe runs, one per root).
  const probePanels = new ProbeResultPanelManager(context.extensionUri, workspaces);
  context.subscriptions.push({ dispose: () => probePanels.dispose() });
  // spec 335 — Mission Control (the Task board) + its per-task Detail tab. Declared with `let` so each manager
  // can close over the other before both exist (openTask ↔ onTasksChanged), assigned in dependency order below.
  let missionControlPanels: MissionControlPanelManager;
  let taskDetailPanels: TaskDetailPanelManager;
  // dogfood round 1 (#1) — the ONE fan-out path for any task mutation: an MCP tool call (onViewsChanged("tasks")
  // below) and an engine-side panel mutation (board drag/edit, detail edit) must reach the same three targets,
  // so a board-side edit is never invisible to an open Detail tab (and vice versa).
  const onTasksChanged = () => {
    missionControlPanels.refreshAll();
    taskDetailPanels.refreshAll();
    taskStudioPanels.refreshAll();
    sidebarProto.refresh();
  };
  // spec 339 — Task Studio: constructed first (no forward declaration needed) so the board/detail panels
  // can inject an `openTaskStudio` callback into their own constructors below.
  const taskStudioPanels = new TaskStudioPanelManager(context.extensionUri, workspaces, onTasksChanged);
  context.subscriptions.push({ dispose: () => taskStudioPanels.dispose() });
  taskDetailPanels = new TaskDetailPanelManager(context.extensionUri, workspaces, (ws, id) => taskStudioPanels.openExisting(ws, id), onTasksChanged);
  context.subscriptions.push({ dispose: () => taskDetailPanels.dispose() });
  missionControlPanels = new MissionControlPanelManager(
    context.extensionUri,
    workspaces,
    (ws, id) => taskDetailPanels.open(ws, id),
    (ws, id) => { if (id) taskStudioPanels.openExisting(ws, id); else taskStudioPanels.openNew(ws); },
    onTasksChanged,
  );
  context.subscriptions.push({ dispose: () => missionControlPanels.dispose() });
  // spec 239 inc 3b — always-on durable-log writers (one per resumable agent), so the agent's full activity
  // history is captured across /clear, /resume, compaction and fresh starts even with no Activity panel open.
  // spec 378 — a model-bearing record landing in an agent's durable log must advance the shared projection and
  // refresh the sidebar even when RuntimeOps is never opened (RuntimeOpsView.refresh() no-ops while hidden).
  // The projection cursor is advanced here (observedModelFor), independent of runtimeOps.refresh() below.
  const modelFactSignatures = new Map<string, string>();
  const activityLog = new ActivityLogManager(workspaces, 2000, 3000, (wsHash, agentName) => {
    runtimeOps.refresh();
    const ws = workspaces().find((w) => w.wsHash === wsHash);
    if (!ws) return;
    const observed = runtimeOpsSnapshots.observedModelFor(ws.workspaceRoot, wsHash, agentName);
    const fact = resolveModelFact(ws.manager.defOf(agentName)?.cmd, observed);
    const signature = fact ? `${fact.label} ${fact.source} ${fact.stale} ${fact.divergence}` : "";
    const key = `${wsHash}::${agentName}`;
    if (modelFactSignatures.get(key) === signature) return; // unchanged (label, source, stale, divergence) tuple — no refresh
    modelFactSignatures.set(key, signature);
    sidebarProto.refresh();
  });
  activityLog.start();
  context.subscriptions.push({ dispose: () => activityLog.dispose() });
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  const runtimeUsageStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
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

  const updateStatusBar = () => {
    const all = workspaces();
    if (all.length === 0) {
      statusBar.hide();
      runtimeUsageStatusBar.hide();
      return;
    }
    const ports = all.map((ws) => ws.bridgeUrl()?.split(":")[2]?.replace("/mcp", "")).filter(Boolean);
    statusBar.text = all.length === 1 ? `$(zap) Tachyon :${ports[0] ?? "—"}` : `$(zap) Tachyon ×${all.length}`;
    statusBar.tooltip = all.map((ws) => `${ws.folderName} — ${ws.bridgeUrl() ?? vscode.l10n.t("not running")}`).join("\n");
    statusBar.command = "tachyon.copyBridgeUrl";
    statusBar.show();
    runtimeUsageStatusBar.text = "$(pulse) Runtime";
    runtimeUsageStatusBar.tooltip = "Open Runtime Ops";
    runtimeUsageStatusBar.command = "tachyon.showRuntimeUsage";
    runtimeUsageStatusBar.show();
  };

  // Any engine/Bridge-driven state change re-pushes the whole fleet to the webview.
  const onViewsChanged = (view: ViewKind) => {
    if (view === "agents") runtimeOps.refresh();
    if (view === "handoff") handoffPanels.refreshAll(); // spec 245 — re-post to any open Project Handoff panel
    if (view === "probes") probePanels.refreshAll(); // spec 257 — re-render any open Probes inspector
    if (view === "tasks") onTasksChanged(); // spec 335 — same fan-out path engine-side mutations use directly
    if (view === "pins") approvalPanels.refreshAll();
    if (view === "commands") runbookStudioPanels.refreshReferenceData();
    if (view === "commands" || view === "agents") scheduleStudioPanels.refreshReferenceData();
    if (view === "agents") applyWorktreeFolderReveal(); // spec 210/263 — onSpawned/onStopping/onKilled fire this
    sidebarProto.refresh();
  };
  const refreshAll = () => {
    applyWorktreeFolderReveal(); // spec 210/263 — the worktree-remove commands only re-render through here
    sidebarProto.refresh();
    runtimeOps.refresh();
    pluginSurfaces.refreshAll();
    runbookStudioPanels.refreshReferenceData();
    scheduleStudioPanels.refreshReferenceData();
    approvalPanels.refreshAll();
    updateStatusBar();
  };
  const pinStudioPanels = new PinStudioPanelManager(context.extensionUri, workspaces, refreshAll);
  context.subscriptions.push({ dispose: () => pinStudioPanels.dispose() });
  const agentStudioPanels = new AgentStudioPanelManager(context.extensionUri, workspaces, refreshAll);
  context.subscriptions.push({ dispose: () => agentStudioPanels.dispose() });
  const terminalStudioPanels = new TerminalStudioPanelManager(context.extensionUri, workspaces, refreshAll);
  context.subscriptions.push({ dispose: () => terminalStudioPanels.dispose() });
  const commandStudioPanels = new CommandStudioPanelManager(context.extensionUri, workspaces, refreshAll);
  context.subscriptions.push({ dispose: () => commandStudioPanels.dispose() });
  const runbookStudioPanels = new RunbookStudioPanelManager(context.extensionUri, workspaces, refreshAll);
  context.subscriptions.push({ dispose: () => runbookStudioPanels.dispose() });
  const scheduleStudioPanels = new ScheduleStudioPanelManager(context.extensionUri, workspaces, refreshAll);
  context.subscriptions.push({ dispose: () => scheduleStudioPanels.dispose() });
  const pipelineStudioPanels = new PipelineStudioPanelManager(context.extensionUri, refreshAll);
  context.subscriptions.push({ dispose: () => pipelineStudioPanels.dispose() });
  const approvalPanels = new ApprovalPanelManager(context.extensionUri, workspaces);
  context.subscriptions.push({ dispose: () => approvalPanels.dispose() });

  const makeServerInspectorDeps = (): InspectorDeps => {
    const svc = new TmuxService();
    const folderByHash = () => new Map(workspaces().map((ws) => [ws.wsHash, ws.folderName]));
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
        void svc.refreshClients(session);
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
    const reap = async (label: string, targets: string[]) => {
      if (targets.length === 0) return 0;
      const ok = await showNotification(
        vscode.l10n.t("Kill {0} {1} session(s)? This cannot be undone.", targets.length, label),
        "warn",
        [vscode.l10n.t("Kill")],
        { modal: true },
      );
      if (!ok) return 0;
      for (const s of targets) {
        try {
          await svc.killSession(s);
        } catch {
          /* already gone */
        }
      }
      return targets.length;
    };
    return {
      extensionUri: context.extensionUri,
      snapshot: () => svc.serverSnapshot(SESSION_PREFIX),
      serverHealth: async () => {
        const checkedAt = Date.now();
        const [probe, requirement] = await Promise.all([probeServer(), doctor()]);
        const pids = probe.state === "wedged" ? probe.pids : probe.state === "healthy" ? await findServerPids(SOCKET_NAME).catch(() => []) : [];
        return {
          socketName: SOCKET_NAME,
          socketPath: socketPath(SOCKET_NAME),
          state: probe.state,
          tmuxVersion: requirement.ok ? requirement.version : undefined,
          pids,
          diagnostics: await snapshotServerPids(pids),
          checkedAt,
        };
      },
      folderByHash,
      cpuBusy,
      capture: (session) => svc.capturePane(session, 200),
      open: openSession,
      kill: (session) => svc.killSession(session),
      reapDead: async () => {
        const snap = await svc.serverSnapshot(SESSION_PREFIX);
        return reap(vscode.l10n.t("dead"), snap.filter((r) => r.dead).map((r) => r.session));
      },
      reapOrphans: async () => {
        const snap = await svc.serverSnapshot(SESSION_PREFIX);
        const open = folderByHash();
        const targets = snap
          .filter((r) => {
            const h = classifySession(r.session).wsHash;
            return h !== undefined && !open.has(h);
          })
          .map((r) => r.session);
        return reap(vscode.l10n.t("orphaned"), targets);
      },
    };
  };

  const launcherBundlePath = () => vscode.Uri.joinPath(context.extensionUri, "dist", "tool-launcher.cjs").fsPath;
  const syncWorkspaceToolLauncher = (folderPath: string): void => {
    const r = syncToolLauncher(folderPath, { launcherBundlePath: launcherBundlePath(), updateLockfile: false });
    if (r.errors.length > 0) notify(vscode.l10n.t("Tachyon tool launcher sync failed: {0}", r.errors.join("; ")), "warn");
  };

  const addWorkspace = async (folderPath: string, autostart: boolean, refreshOnSuccess = true): Promise<Workspace> => {
    const ws = await Workspace.create(folderPath, {
      onViewsChanged,
      host: new VsCodeHost(context, onViewsChanged),
      onApprovalRequested: (workspace, request) => {
        const open = "Review";
        void showNotification(`Approval request ${request.id} from '${request.requester}'`, "info", [open]).then((picked) => {
          if (picked === open) approvalPanels.open(workspace);
        });
        approvalPanels.refreshAll();
      },
    });
    registry.set(folderPath, ws);
    if (hasConfig(folderPath)) syncWorkspaceToolLauncher(folderPath);
    if (autostart && hasConfig(folderPath)) {
      await ws.start();
    }
    if (refreshOnSuccess) refreshAll();
    return ws;
  };

  // Boot a folder on demand — used by creation commands so a fresh folder gets a
  // Workspace the moment the user ACTS (Init / New Agent / Studio), not just by
  // having the extension installed.
  const ensureWorkspaceFor = async (folderPath: string): Promise<Workspace> => {
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

  registerTrustedPanelSerializer<MissionControlPanelState>(context, MISSION_CONTROL_VIEW_TYPE, (panel, state) => missionControlPanels.deserialize(panel, state));
  registerTrustedPanelSerializer<TaskDetailPanelState>(context, TASK_DETAIL_VIEW_TYPE, (panel, state) => taskDetailPanels.deserialize(panel, state));
  registerTrustedPanelSerializer<ActivityPanelState>(context, ACTIVITY_VIEW_TYPE, (panel, state) => activityPanels.deserialize(panel, state));
  registerTrustedPanelSerializer<HandoffPanelState>(context, HANDOFF_VIEW_TYPE, (panel, state) => handoffPanels.deserialize(panel, state), { defer: workspacePanelReviveDeferral });
  registerTrustedPanelSerializer<ApprovalPanelState>(context, APPROVAL_VIEW_TYPE, (panel, state) => approvalPanels.deserialize(panel, state), { defer: workspacePanelReviveDeferral });
  registerTrustedPanelSerializer<PluginsPanelState>(context, PLUGINS_VIEW_TYPE, (panel, state) => pluginsPanels.deserialize(panel, state), { defer: workspacePanelReviveDeferral });
  registerTrustedPanelSerializer<ProbesPanelState>(context, PROBES_VIEW_TYPE, (panel, state) => probePanels.deserialize(panel, state), { defer: workspacePanelReviveDeferral });
  registerTrustedPanelSerializer<PinPreviewPanelState>(context, PIN_PREVIEW_VIEW_TYPE, (panel, state) => sidebarProto.deserializePinPreview(panel, state));
  registerTrustedPanelSerializer<PinStudioPanelState>(context, PIN_STUDIO_VIEW_TYPE, (panel, state) => pinStudioPanels.deserialize(panel, state));
  registerTrustedPanelSerializer<TaskStudioPanelState>(context, TASK_STUDIO_VIEW_TYPE, (panel, state) => taskStudioPanels.deserialize(panel, state));
  registerTrustedPanelSerializer<AgentStudioPanelState>(context, AGENT_STUDIO_SHELL_VIEW_TYPE, (panel, state) => agentStudioPanels.deserialize(panel, state));
  registerTrustedPanelSerializer<TerminalStudioPanelState>(context, TERMINAL_STUDIO_SHELL_VIEW_TYPE, (panel, state) => terminalStudioPanels.deserialize(panel, state));
  registerTrustedPanelSerializer<CommandStudioPanelState>(context, COMMAND_STUDIO_SHELL_VIEW_TYPE, (panel, state) => commandStudioPanels.deserialize(panel, state));
  registerTrustedPanelSerializer<RunbookStudioPanelState>(context, RUNBOOK_STUDIO_SHELL_VIEW_TYPE, (panel, state) => runbookStudioPanels.deserialize(panel, state));
  registerTrustedPanelSerializer<ScheduleStudioPanelState>(context, SCHEDULE_STUDIO_SHELL_VIEW_TYPE, (panel, state) => scheduleStudioPanels.deserialize(panel, state));
  registerTrustedPanelSerializer<PipelineStudioPanelState>(context, PIPELINE_STUDIO_VIEW_TYPE, (panel, state) => pipelineStudioPanels.deserialize(panel, state));
  registerTrustedPanelSerializer<ServerInspectorPanelState>(context, SERVER_INSPECTOR_VIEW_TYPE, (panel) => openServerInspector(makeServerInspectorDeps(), panel));
  for (const viewType of ["tachyonPluginSurface", "tachyonPluginSurfaces", "tachyonAgentFixtureStudio", "tachyonSketch"]) {
    registerDisposePanelSerializer(context, viewType);
  }

  // Picker for CREATION commands (New Agent / Studio tabs). Same rule as
  // pickWorkspace: only Tachyon-configured folders are offered, and a lone one is
  // auto-selected — when a mix of configured and unconfigured folders is open, the
  // unconfigured ones never appear. The ONE divergence is the zero-configured tail:
  // there it falls back to every open folder and boots the chosen one on demand, so
  // first-run creation is itself the opt-in (the bootstrap path Init also covers).
  const pickFolderForCreate = async (): Promise<Workspace | undefined> => {
    const configured = configuredWorkspaces();
    if (configured.length === 1) return configured[0];
    if (configured.length > 1) {
      const picked = await vscode.window.showQuickPick(
        configured.map((ws) => ({ label: ws.folderName, description: ws.bridgeUrl() ?? "", ws })),
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
  applyWorktreeFolderReveal();
  // Folders added/removed live (multi-root): create with config, dispose on removal.
  const folderWatcher = registerWorkspaceMembershipRefresh(vscode.workspace.onDidChangeWorkspaceFolders, {
    registry,
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
    vscode.window.registerWebviewViewProvider(RuntimeOpsViewProvider.viewType, runtimeOps),
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
    statusBar,
    runtimeUsageStatusBar,
    folderWatcher,
    {
      dispose: () => {
        for (const ws of workspaces()) void ws.dispose();
        registry.clear();
      },
    },
    // ---- internal seams (integration tests; default to the single workspace) ----
    vscode.commands.registerCommand("tachyon._agents", (hash?: string) => byHash(hash)?.manager.list() ?? []),
    vscode.commands.registerCommand("tachyon._seedPipelineRun", (name: string, hash?: string) => byHash(hash)?.seedPipelineRun(name) ?? null),
    vscode.commands.registerCommand(
      "tachyon._spawn",
      (name: string, opts?: { cmd?: string; cwd?: string; instructions?: string; parent?: string }, hash?: string) =>
        byHash(hash)?.manager.spawn(name, opts),
    ),
    vscode.commands.registerCommand("tachyon._wait", (name: string, until: "idle" | "needs-input" | "dead", timeoutSec: number, hash?: string) => {
      const ws = byHash(hash);
      if (!ws) return { met: false, state: "gone" };
      return executeWait(
        { manager: ws.manager, attentionOf: (a) => ws.monitor.stateOf(a)?.state, waiters: ws.waiters } as Pick<BridgeDeps, "manager" | "attentionOf" | "waiters">,
        name,
        until,
        timeoutSec,
      );
    }),
    vscode.commands.registerCommand("tachyon._attention", (hash?: string) => {
      const out: Record<string, { state: string; matchedLine?: string }> = {};
      for (const [agent, att] of byHash(hash)?.monitor.states() ?? new Map()) {
        out[agent] = { state: att.state, matchedLine: att.matchedLine };
      }
      return out;
    }),
    vscode.commands.registerCommand("tachyon._pins", (hash?: string) => byHash(hash)?.pinStore.list() ?? []),
    vscode.commands.registerCommand("tachyon._pin", (text: string, by?: string, done?: boolean, hash?: string) => {
      const ws = byHash(hash);
      if (!ws) return;
      const pin = ws.pinStore.create(text, by ?? "claude");
      if (done) ws.pinStore.setDone(pin.id, true);
      refreshAll();
    }),
    vscode.commands.registerCommand("tachyon._upsertAgent", (submit: StudioSubmit, hash?: string) => byHash(hash)?.studioSubmit(submit)),
    vscode.commands.registerCommand("tachyon._runCommand", (name: string, hash?: string) => byHash(hash)?.commandRunner.run(name)),
    vscode.commands.registerCommand("tachyon._commands", (hash?: string) => byHash(hash)?.commandRunner.list() ?? []),
    vscode.commands.registerCommand("tachyon._commandTick", (hash?: string) => byHash(hash)?.commandRunner.tick()),
    vscode.commands.registerCommand("tachyon._runRunbook", (name: string, hash?: string) => byHash(hash)?.runbookRunner.run(name)),
    vscode.commands.registerCommand("tachyon._runbooks", (hash?: string) => byHash(hash)?.runbookRunner.list() ?? []),
    vscode.commands.registerCommand("tachyon._schedules", (hash?: string) => byHash(hash)?.scheduler.list() ?? []),
    vscode.commands.registerCommand("tachyon._proposals", (hash?: string) => byHash(hash)?.proposals.list() ?? []),
    vscode.commands.registerCommand("tachyon._propose", (name: string, schedule: ScheduleDef, reason?: string, hash?: string) => {
      byHash(hash)?.proposals.create(name, schedule, "agent", reason);
      refreshAll();
    }),
    vscode.commands.registerCommand("tachyon._approveProposal", (id: string, hash?: string) => byHash(hash)?.approveProposal(id)),
    vscode.commands.registerCommand("tachyon._rejectProposal", (id: string, hash?: string) => byHash(hash)?.rejectProposal(id)),
    // ---- schedules (F23) ----
    vscode.commands.registerCommand("tachyon.approveProposalItem", (item: ProposalItem) => {
      const ws = wsOf(item);
      if (ws) domainActions.approveProposal(ws, item.proposalId, { onChanged: () => refreshAll() });
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
      if (answer === vscode.l10n.t("Reject")) domainActions.rejectProposal(ws, item.proposalId, { onChanged: () => refreshAll() });
    }),
    vscode.commands.registerCommand("tachyon.toggleSchedulePauseItem", (item: ScheduleItem) => {
      const ws = wsOf(item);
      if (ws) domainActions.toggleSchedulePause(ws, item.scheduleName, { onChanged: () => refreshAll() });
    }),
    vscode.commands.registerCommand("tachyon._togglePause", (name: string, hash?: string) => byHash(hash)?.toggleSchedulePause(name)),
    vscode.commands.registerCommand("tachyon.deleteScheduleItem", async (item: ScheduleItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      const answer = await showNotification(
        vscode.l10n.t("Delete schedule '{0}' from tachyon.yml?", item.scheduleName),
        "warn",
        [vscode.l10n.t("Delete")],
        { modal: true },
      );
      if (answer === vscode.l10n.t("Delete")) domainActions.deleteSchedule(ws, item.scheduleName, { onChanged: () => refreshAll() });
    }),
    vscode.commands.registerCommand("tachyon.editScheduleItem", async (item: ScheduleItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      const file = ws.configPath();
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
    vscode.commands.registerCommand("tachyon._workspaces", () => workspaces().map((ws) => ({ folder: ws.folderName, root: ws.workspaceRoot, hash: ws.wsHash, bridge: ws.bridgeUrl() }))),
    /**
     * t-8354ae / EDH palliative — read-only health probe for headless dogfood.
     * Reloads config from disk, returns failure surface + degraded roster extras + LKG-spawn check.
     * Not a user-facing command (underscore); not contributed in package.json.
     */
    vscode.commands.registerCommand("tachyon._configHealth", async (hash?: string) => {
      const ws = hash ? byHash(hash) : workspaces()[0];
      if (!ws) return { ok: false as const, error: "no-workspace" };
      const reloadOk = ws.reloadConfig();
      const failure = ws.configFailure ?? null;
      const lkg = typeof ws.readConfigLkg === "function" ? ws.readConfigLkg() : null;
      const ledgerPairs = [...ws.ledger.all()];
      const live = await ws.manager.list();
      const extras = degradedRosterExtras({
        existingNames: new Set(live.map((a) => a.name)),
        ledger: ledgerPairs,
        lkg,
      });
      const rosterNames = [...new Set([...live.map((a) => a.name), ...extras.map((e) => e.name)])].sort();
      let lkgSpawn: { name: string; refused: boolean; message?: string } | undefined;
      if (failure && lkg?.agents.length) {
        // Prefer a name that is only recoverable via LKG/ledger render, not a live def.
        const candidate =
          extras.find((e) => e.source === "lkg")?.name
          ?? lkg.agents.find((a) => !ws.config?.agents[a.name] && !ws.manager.defOf(a.name))?.name
          ?? lkg.agents[0]?.name;
        if (candidate) {
          try {
            await ws.manager.spawn(candidate);
            lkgSpawn = { name: candidate, refused: false };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            lkgSpawn = {
              name: candidate,
              refused: /render-only|config is invalid|cannot spawn|unknown agent/i.test(message),
              message,
            };
          }
        }
      }
      return {
        ok: true as const,
        reloadOk,
        configFailure: failure
          ? { file: failure.file, path: failure.path, errors: failure.errors, at: failure.at }
          : null,
        lkg: lkg
          ? { savedAt: lkg.savedAt, sourceFile: lkg.sourceFile, agents: lkg.agents.map((a) => a.name) }
          : null,
        ledger: ledgerPairs.map(([name, rec]) => ({
          name,
          declared: rec.declared,
          resumable: isResumable(rec),
        })),
        live: live.map((a) => ({ name: a.name, running: a.running, declared: a.declared, kind: a.kind })),
        extras: extras.map((e) => ({ name: e.name, source: e.source, declared: e.declared, resumable: e.resumable })),
        rosterNames,
        lkgSpawn,
        // Sidebar must not be empty-only while failure + known agents exist
        emptyRosterOnly: !!failure && rosterNames.length === 0,
      };
    }),
    // ---- views ----
    vscode.commands.registerCommand("tachyon.refreshViews", refreshAll),
    vscode.commands.registerCommand("tachyon.openApprovals", async (hash?: string) => {
      const ws = hash ? byHash(hash) : await pickWorkspace();
      if (ws) approvalPanels.open(ws);
    }),
    vscode.commands.registerCommand("tachyon.resolveApproval", async (arg: { id?: string; decision?: ApprovalDecision; wsHash?: string }) => {
      const ws = targetOf(arg?.wsHash);
      if (!ws || !arg?.id || (arg.decision !== "approved" && arg.decision !== "denied")) return;
      try {
        const result = await resolveApproval({
          workspaceRoot: ws.workspaceRoot,
          id: arg.id,
          decision: arg.decision,
          resolvedBy: "vscode",
          currentSessionOwner: async (session) => (await ws.manager.list()).find((entry) => entry.session === session && entry.running)?.name,
          inject: async (session, text) => {
            await ws.tmux.sendSubmittedLine(session, text);
            return { receipt: `tmux:${session}` };
          },
          completePin: (pinId) => ws.pinStore.setDone(pinId, true),
        });
        notify(`approval request ${result.request.id} ${arg.decision}`);
        refreshAll();
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), "error");
        approvalPanels.refreshAll();
      }
    }),
    // ---- onboarding (F24) ----
    vscode.commands.registerCommand("tachyon.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "@ext:cfpperche.tachyon"),
    ),
    // t-7bcba6 — tachyon.persistenceSettings (Visible legacy reminders / silentHooks kill switch) removed.
    // ---- server inspector (F27) — cross-workspace, standalone socket queries ----
    vscode.commands.registerCommand("tachyon.inspectServer", () => openServerInspector(makeServerInspectorDeps())),
    vscode.commands.registerCommand("tachyon.getStarted", () =>
      vscode.commands.executeCommand("workbench.action.openWalkthrough", "cfpperche.tachyon#tachyon.welcome", false),
    ),
    vscode.commands.registerCommand("tachyon.checkRequirements", async () => {
      const r = await doctor();
      if (r.ok) {
        const probe = await probeServer();
        if (probe.state === "wedged") {
          void offerServerRecovery(probe.pids);
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
      const configPath = ws.configPath();
      const fileExists = !!configPath && fs.existsSync(configPath);
      // Prefer the durable failure recorded by reloadConfig; re-probe so the report is fresh.
      let configValid = !ws.configFailure && !!ws.config;
      let configFailure = ws.configFailure ?? null;
      if (configPath && fileExists) {
        const { errors } = loadConfigFile(configPath);
        if (errors.length > 0) {
          configValid = false;
          configFailure = {
            path: configPath,
            file: path.basename(configPath),
            errors: [...errors],
            at: new Date().toISOString(),
          };
        } else {
          configValid = true;
          configFailure = null;
        }
      }
      const states = await ws.manager.agentStates();
      const liveSessions = new Set([...states].filter(([, s]) => !s.dead).map(([n]) => n));
      const knownSessions = new Set(states.keys());
      const transcriptPresence = new Map<string, boolean>();
      for (const [name, rec] of ws.ledger.all()) {
        if (!isResumable(rec)) continue;
        try {
          transcriptPresence.set(name, await ws.manager.resumeReadiness(name, rec));
        } catch {
          transcriptPresence.set(name, false);
        }
      }
      let reachable: boolean | undefined;
      if (ws.bridge.port) {
        reachable = await new Promise<boolean>((resolve) => {
          const sock = net.connect({ host: "127.0.0.1", port: ws.bridge.port! }, () => {
            sock.end();
            resolve(true);
          });
          sock.setTimeout(800);
          sock.on("error", () => resolve(false));
          sock.on("timeout", () => {
            sock.destroy();
            resolve(false);
          });
        });
      }
      const report = buildDoctorReport({
        workspaceRoot: ws.workspaceRoot,
        configPath,
        configFailure,
        configFileExists: fileExists,
        configValid,
        lkg: ws.readConfigLkg(),
        ledger: [...ws.ledger.all()],
        liveSessions,
        knownSessions,
        bridge: {
          port: ws.bridge.port,
          url: ws.bridge.url,
          reachable,
          authConfigured: ws.authEnabled,
          failure: ws.bridgeStartFailureInfo(),
        },
        transcriptPresence,
        mechanismOnlyDelivery: ws.config?.settings.delivery?.mode === "canonical" && ws.config?.settings.delivery?.handoffSafety === "mechanism-only",
      });
      const text = formatDoctorReport(report);
      const channel = vscode.window.createOutputChannel("Tachyon Doctor");
      channel.clear();
      channel.append(text);
      channel.show(true);
      const hasErr = report.findings.some((f) => f.severity === "error");
      notify(
        hasErr
          ? vscode.l10n.t("Tachyon Doctor found problems — see the Output panel")
          : vscode.l10n.t("Tachyon Doctor report ready — see the Output panel"),
        hasErr ? "warn" : "info",
      );
    }),
    vscode.commands.registerCommand("tachyon.openConfig", async (hash?: string) => {
      const ws = hash ? byHash(hash) : workspaces()[0];
      if (!ws) {
        notify(vscode.l10n.t("no Tachyon workspace is active"), "warn");
        return;
      }
      const file = ws.configPath() ?? path.join(ws.workspaceRoot, "tachyon.yml");
      try {
        const doc = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch (err) {
        notify(vscode.l10n.t("Could not open config: {0}", err instanceof Error ? err.message : String(err)), "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.restartTmuxServer", async () => {
      const probe = await probeServer();
      if (probe.state === "wedged") {
        await offerServerRecovery(probe.pids);
        return;
      }
      if (probe.state === "no-server") {
        notify(vscode.l10n.t("no tmux server running — nothing to recover."));
        return;
      }
      notify(vscode.l10n.t("tmux server is healthy — nothing to recover."));
    }),
    vscode.commands.registerCommand("tachyon.restartBridge", async (hash?: string) => {
      const targets = hash ? [byHash(hash)].filter((ws): ws is Workspace => !!ws) : workspaces();
      if (targets.length === 0) {
        notify(vscode.l10n.t("no Tachyon workspace is active"), "warn");
        return;
      }
      const results = await Promise.allSettled(targets.map((ws) => ws.restartBridge()));
      const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failures.length > 0) {
        notify(vscode.l10n.t("Bridge restart failed: {0}", failures.map((f) => f.reason instanceof Error ? f.reason.message : String(f.reason)).join("; ")), "error");
        return;
      }
      refreshAll();
      notify(vscode.l10n.t("Bridge restarted for {0} workspace(s).", targets.length));
    }),
    vscode.commands.registerCommand("tachyon.stopBridge", async (hash?: string) => {
      const targets = hash ? [byHash(hash)].filter((ws): ws is Workspace => !!ws) : workspaces();
      if (targets.length === 0) {
        notify(vscode.l10n.t("no Tachyon workspace is active"), "warn");
        return;
      }
      const results = await Promise.allSettled(targets.map((ws) => ws.stopBridge()));
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
      const node = arg && typeof arg === "object" ? (arg as { ws?: Workspace }) : undefined;
      const ws = node?.ws ?? (await pickWorkspace());
      if (!ws) return;
      if (text === undefined) {
        pinStudioPanels.openNew(ws);
        return;
      }
      if (text.trim().length === 0) return;
      try {
        ws.pinStore.create(text, "human");
        refreshAll();
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.deletePinItem", (item: PinItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      try {
        domainActions.deletePin(ws, item.pinId, { onChanged: () => refreshAll() });
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.editPinItem", async (item: PinItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      pinStudioPanels.openExisting(ws, item.pinId);
    }),
    // ---- agents ----
    vscode.commands.registerCommand("tachyon.spawnAgentItem", async (item: AgentItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      try {
        activityLog.noteLifecycle(ws.wsHash, item.agentName, "started"); // spec 239 — note BEFORE the action, arm AFTER
        await ws.manager.spawn(item.agentName);
        activityLog.armLifecycle(ws.wsHash, item.agentName);
      } catch (err) {
        activityLog.clearLifecycle(ws.wsHash, item.agentName);
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.stopAgentItem", async (item: AgentItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      try {
        await ws.manager.stopGracefully(item.agentName);
        ws.terminals.close(item.agentName);
      } catch (err) {
        console.log(`[tachyon] stopAgentItem failed agent=${item.agentName}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.killAgentItem", async (item: AgentItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      try {
        await ws.manager.kill(item.agentName);
      } catch (err) {
        console.log(`[tachyon] killAgentItem failed agent=${item.agentName}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.restartAgentItem", async (item: AgentItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      try {
        ws.lifecycle.resetBackoff(item.agentName); // human took over — clear crash-loop history
        await ws.checkpointBeforeTeardown(item.agentName); // spec 241 OQ6 — bounded last-chance checkpoint (idle + stale only)
        activityLog.noteLifecycle(ws.wsHash, item.agentName, "restarted"); // spec 239 — note BEFORE the action, arm AFTER
        await ws.manager.restart(item.agentName);
        activityLog.armLifecycle(ws.wsHash, item.agentName);
      } catch (err) {
        activityLog.clearLifecycle(ws.wsHash, item.agentName);
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.openAgentTerminalItem", (agent: string, hash?: string) => {
      const ws = targetOf(hash);
      if (ws) ws.terminals.open(agent, ws.manager.session(agent));
    }),
    // spec 238 — open the normalized activity cockpit for an agent (the terminal stays the escape hatch).
    vscode.commands.registerCommand("tachyon.openAgentActivity", (agent: string, hash?: string) => activityPanels.open(agent, hash)),
    // 0.29.1 — raw transcript escape hatch, demoted from the Activity header button to a palette command.
    vscode.commands.registerCommand("tachyon.openAgentTranscript", () => activityPanels.openTranscriptForActive()),
    // spec 245 — open the read-only Project Handoff panel for a workspace root (from the sidebar header button).
    // spec 297 — resolve the target folder via the shared picker when no hash is passed (no silent folder[0]
    // in a multi-root window); an explicit hash (e.g. the sidebar handoff bar) is honored verbatim.
    vscode.commands.registerCommand("tachyon.openProjectHandoff", async (hash?: string) => {
      const ws = hash ? byHash(hash) : await pickWorkspace();
      if (ws) handoffPanels.open(ws.wsHash);
    }),
    vscode.commands.registerCommand("tachyon.openPlugins", async (hash?: string) => {
      const ws = hash ? byHash(hash) : await pickWorkspace();
      if (ws) pluginsPanels.open(ws.wsHash);
    }),
    vscode.commands.registerCommand("tachyon.openPluginSurface", (arg?: { pluginId?: string; viewId?: string; wsHash?: string } | string) => pluginSurfaces.openSurface(arg)),
    // spec 335 — open the Mission Control board (the Task queue) for a workspace root, from the sidebar
    // header button or the command palette.
    vscode.commands.registerCommand("tachyon.missionControl", async (hash?: string) => {
      const ws = hash ? byHash(hash) : await pickWorkspace();
      if (ws) missionControlPanels.open(ws.wsHash);
    }),
    // spec 339 — open Task Studio in new-task mode from the command palette (mirrors the board's own
    // "+ Task" button and the card context menu's "Edit in Studio", both of which route through the
    // webview's openTaskStudio action instead of a command).
    vscode.commands.registerCommand("tachyon.taskStudio.new", async (hash?: string) => {
      const ws = hash ? byHash(hash) : await pickWorkspace();
      if (ws) taskStudioPanels.openNew(ws);
    }),
    // spec 322 — per-agent probes: the agent row's "…" action passes (hash, agent) and gets that agent's
    // probes only. The no-arg/agent-less form opens the UNFILTERED list — an internal/debug escape hatch for
    // caller-less or orphaned records (not contributed to any menu/palette; probes are per-agent in the UI).
    vscode.commands.registerCommand("tachyon.openProbes", async (hash?: string, agent?: string) => {
      const ws = hash ? byHash(hash) : await pickWorkspace();
      if (ws) probePanels.open(ws.wsHash, agent);
    }),
    // ---- session resume (F29 / spec 209) ----
    vscode.commands.registerCommand("tachyon.resumeAgentItem", async (item: AgentItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      try {
        ws.lifecycle.resetBackoff(item.agentName);
        activityLog.noteLifecycle(ws.wsHash, item.agentName, "resumed"); // spec 239 — note BEFORE the action, arm AFTER
        await ws.resumeAgent(item.agentName);
        activityLog.armLifecycle(ws.wsHash, item.agentName);
      } catch (err) {
        activityLog.clearLifecycle(ws.wsHash, item.agentName);
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    // ---- session fork (spec 225) ----
    vscode.commands.registerCommand("tachyon.forkAgentItem", async (item: AgentItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      let forkName: string | undefined;
      try {
        // Fail-closed plan first (resolves the live uuid; throws if not forkable yet) — then confirm.
        const plan = await ws.manager.planFork(item.agentName);
        const lines = [
          vscode.l10n.t("Fork '{0}' into a new sibling agent '{1}'?", item.agentName, plan.forkName),
          vscode.l10n.t("The fork carries the conversation up to now; the original keeps running, untouched."),
        ];
        if (plan.sourceWorktree) lines.push(vscode.l10n.t("It gets its own worktree, branched off '{0}' (committed work only).", plan.sourceWorktree.branch));
        if (plan.dirty) lines.push(vscode.l10n.t("⚠ Uncommitted changes in the original are NOT carried into the fork."));
        const forkLabel = vscode.l10n.t("Fork");
        const answer = await showNotification(lines.join("\n"), "warn", [forkLabel], { modal: true });
        if (answer !== forkLabel) return;
        // spec 239 — note BEFORE commitFork (before the fork's ledger row exists), so the buffered note is in
        // place before reconcile could create the fork's writer. Buffered notes are born ready.
        forkName = plan.forkName;
        activityLog.noteLifecycle(ws.wsHash, forkName, "forked");
        const created = await ws.manager.commitFork(plan);
        ws.snapshotContinuityForFork(item.agentName, created); // spec 241 D8 — paused snapshot of the parent brief
        notify(vscode.l10n.t("Forked '{0}' → '{1}'", item.agentName, created));
        refreshAll();
      } catch (err) {
        if (forkName) activityLog.clearLifecycle(ws.wsHash, forkName); // fork failed — drop the buffered note
        notify(`${err instanceof Error ? err.message : String(err)}`, "warn");
      }
    }),
    vscode.commands.registerCommand("tachyon.resumeAll", async () => {
      const targets = workspaces().filter((ws) => ws.resumableAgents().length > 0);
      if (targets.length === 0) {
        notify(vscode.l10n.t("no agents to resume"));
        return;
      }
      for (const ws of targets) await ws.resumeAllOffered();
    }),
    vscode.commands.registerCommand("tachyon.runPipeline", async () => {
      const ws = await pickWorkspace();
      if (!ws) return;
      ws.reloadConfig();
      const names = ws.listPipelines();
      if (names.length === 0) {
        notify(vscode.l10n.t("no pipelines found — add one under .tachyon/pipelines/<name>.yml"), "warn");
        return;
      }
      const name = names.length === 1 ? names[0] : await vscode.window.showQuickPick(names, { placeHolder: vscode.l10n.t("Run which pipeline?") });
      if (!name) return;
      await startPipelineWithInput(ws, name);
    }),
    vscode.commands.registerCommand("tachyon.approvePipelineNodeItem", (item: PipelineNodeItem) => {
      const ws = wsOf(item);
      if (ws && item.runId && item.nodeId) ws.pipelines.approve(item.runId, item.nodeId);
    }),
    vscode.commands.registerCommand("tachyon.rejectPipelineNodeItem", (item: PipelineNodeItem) => {
      const ws = wsOf(item);
      if (ws && item.runId && item.nodeId) ws.pipelines.reject(item.runId, item.nodeId);
    }),
    vscode.commands.registerCommand("tachyon.runPipelineItem", async (item: PipelineDefItem) => {
      const ws = wsOf(item);
      if (ws) await startPipelineWithInput(ws, item.pipelineName);
    }),
    vscode.commands.registerCommand("tachyon.editPipelineInputItem", async (item: PipelineDefItem) => {
      const ws = wsOf(item);
      if (!ws || !item.run) return;
      if (!fs.existsSync(ws.runInputFilePath(item.run.id))) {
        notify(vscode.l10n.t("run '{0}' has no input (this pipeline declares input: none)", item.run.id), "info");
        return;
      }
      await vscode.window.showTextDocument(vscode.Uri.file(ws.runInputFilePath(item.run.id)));
      const pick = await showNotification(
        vscode.l10n.t("Edit the input for run '{0}', save, then Apply (only not-yet-started nodes use it).", item.run.id),
        "info",
        [vscode.l10n.t("Apply")],
      );
      if (pick === vscode.l10n.t("Apply")) ws.applyRunInput(item.run.id);
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
      if (ok) { ws.pipelines.cancel(item.run.id); refreshAll(); } // cancel finalizes+removes the run with no tick → refresh like dismiss
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
      if (ok) await ws.pipelines.rerunFrom(item.runId, item.nodeId);
    }),
    vscode.commands.registerCommand("tachyon.dismissPipelineRunItem", async (item: PipelineDefItem) => {
      const ws = wsOf(item);
      if (!ws || !item.run) return;
      ws.pipelines.dismiss(item.run.id);
      refreshAll(); // dismiss() just finalizes+deletes the run (no engine tick) → refresh both UIs ourselves
    }),
    vscode.commands.registerCommand("tachyon.editPipelineItem", async (item: PipelineDefItem) => {
      const ws = wsOf(item);
      if (ws) await vscode.window.showTextDocument(vscode.Uri.file(ws.pipelineFilePath(item.pipelineName)));
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
      if (ok) ws.deletePipelineFile(item.pipelineName);
    }),
    vscode.commands.registerCommand("tachyon.agentStudio", async () => {
      const ws = await pickFolderForCreate();
      if (!ws) return;
      ws.reloadConfig();
      agentStudioPanels.openNew(ws);
    }),
    vscode.commands.registerCommand("tachyon.newAgentStudio", async () => {
      const ws = await pickFolderForCreate();
      if (!ws) return;
      ws.reloadConfig();
      agentStudioPanels.openNew(ws);
    }),
    vscode.commands.registerCommand("tachyon.terminalStudio", async () => {
      const ws = await pickFolderForCreate();
      if (!ws) return;
      ws.reloadConfig();
      terminalStudioPanels.openNew(ws);
    }),
    vscode.commands.registerCommand("tachyon.runbookStudio", async () => {
      const ws = await pickFolderForCreate();
      if (!ws) return;
      ws.reloadConfig();
      runbookStudioPanels.openNew(ws);
    }),
    vscode.commands.registerCommand("tachyon.editAgentStudioItem", async (item: AgentItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      ws.reloadConfig();
      const def = ws.config?.agents[item.agentName];
      if (!def) {
        notify(vscode.l10n.t("'{0}' is not declared in tachyon.yml (ad-hoc agents have no stored definition)", item.agentName), "warn");
        return;
      }
      const dispatch = {
        agent: () => agentStudioPanels.openExisting(ws, item.agentName),
        terminal: () => terminalStudioPanels.openExisting(ws, item.agentName),
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
      if (ws.mutateConfig((text) => addAgent(text, agentName, agentCmd, finalKind), () => refreshAll())) {
        notify(vscode.l10n.t("'{0}' added — ▶ in the sidebar starts it", agentName));
      }
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
      ws.mutateConfig((text) => cloneAgent(text ?? "", item.agentName, newName), () => refreshAll());
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
        // Works on running agents too: the tmux session is renamed in place and
        // every name-keyed subsystem follows (Workspace.renameAgent).
        await ws.renameAgent(item.agentName, newName);
        refreshAll();
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.deleteAgentItem", async (item: AgentItem, forceArg?: boolean) => {
      const ws = wsOf(item);
      if (!ws) return;
      const adhoc = isAdhocItem(item.contextValue);
      const states = await ws.manager.agentStates();
      const hasSession = states.has(item.agentName);
      let sessionKilled = false;
      const wtRec = ws.ledger.get(item.agentName)?.worktree;
      if (wtRec) {
        // spec 210 — a worktree agent's confirmation IS the worktree-cleanup modal; when it succeeds,
        // continue with the unified Remove flow below (undeclare/forget + durable per-agent cleanup).
        if (forceArg) {
          if ((await ws.manager.liveDescendants(item.agentName)).length === 0) {
            if (hasSession) {
              try {
                await ws.manager.kill(item.agentName); // stop before removing the cwd it runs in
              } catch {
                /* may already be gone — re-check */
              }
              sessionKilled = !(await ws.manager.agentStates()).has(item.agentName);
            }
            // only remove if the session is genuinely gone (don't yank a still-running cwd)
            if (!(await ws.manager.agentStates()).has(item.agentName)) {
              const r = await ws.worktrees.remove(wtRec, true);
              if (r.removed) ws.ledger.clearWorktree(item.agentName);
            }
          }
        } else {
          const outcome = await confirmAndRemoveWorktree(ws, item.agentName, wtRec);
          if (outcome === "blocked") return;
          if (outcome === "kept") return; // declined or failed worktree removal: destroy nothing else
          sessionKilled = true; // confirmAndRemoveWorktree stopped the session before removing the worktree
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
      if (hasSession && !sessionKilled) {
        try {
          await ws.manager.kill(item.agentName);
        } catch (err) {
          notify(`${err instanceof Error ? err.message : String(err)}`, "error");
        }
        if ((await ws.manager.agentStates()).has(item.agentName)) {
          notify(vscode.l10n.t("Could not stop '{0}' — it was not removed.", item.agentName), "error");
          return;
        }
      }
      if (adhoc) {
        // Ad-hoc agents aren't in tachyon.yml — forget the def, lineage and persisted per-agent state so a
        // sessionless/finished one stops rehydrating. If it was running, kill() already revoked/killed; the
        // dismiss path is idempotent and owns the durable cleanup.
        ws.manager.dismissAdhoc(item.agentName);
        refreshAll();
      } else {
        // Remove a DECLARED agent: remove it from tachyon.yml AND forget its durable footprint — else the
        // ledger row/log/session-owner rows private harness home can keep the instance visible or resumable.
        // Drop them only AFTER the YAML delete succeeds, so a failed edit can't leave state inconsistent.
        ws.mutateConfig((text) => deleteAgent(text ?? "", item.agentName), () => { ws.forgetAgent(item.agentName); refreshAll(); });
      }
    }),
    vscode.commands.registerCommand("tachyon.removeWorktreeItem", async (item: AgentItem) => {
      // spec 210 — standalone "Remove worktree" (Decision 3): clean up the worktree while
      // keeping the agent entry. Same descendant guard + ownership-aware confirmation.
      const ws = wsOf(item);
      if (!ws) return;
      const rec = ws.ledger.get(item.agentName)?.worktree;
      if (!rec) {
        notify(vscode.l10n.t("'{0}' has no worktree", item.agentName), "warn");
        return;
      }
      await confirmAndRemoveWorktree(ws, item.agentName, rec);
      refreshAll();
    }),
    vscode.commands.registerCommand("tachyon.reviewWorktreeItem", async (item: AgentItem) => {
      // spec 213 / C2 — review the agent's work: a quick-pick of changed files (base ↔ current).
      const ws = wsOf(item);
      if (!ws) return;
      const rec = ws.ledger.get(item.agentName)?.worktree;
      if (!rec) {
        notify(vscode.l10n.t("'{0}' has no worktree", item.agentName), "warn");
        return;
      }
      await reviewWorktreeDiff(ws, rec, item.agentName);
    }),
    vscode.commands.registerCommand("tachyon.reviewPipelineItem", async (item: PipelineNodeItem | PipelineDefItem) => {
      // spec 230 — "View changes": review the RUN's worktree diff (what a pipeline produced), so the
      // human sees what they're approving. Reuses the spec-213 worktree diff review.
      const ws = wsOf(item);
      if (!ws) return;
      const runId = "runId" in item ? item.runId : item.run?.id;
      if (!runId) return;
      const rec = ws.pipelineRunWorktree(runId);
      if (!rec) {
        notify(vscode.l10n.t("no active run worktree to review"), "warn");
        return;
      }
      await reviewWorktreeDiff(ws, rec, runId);
    }),
    vscode.commands.registerCommand("tachyon.verifyAgentItem", async (item: AgentItem) => {
      // spec 214 / C3 — run the agent's declared verify-gate in its worktree, update the badge.
      // Advisory: a failure surfaces but never blocks. Errors (no worktree/verify) are notified.
      const ws = wsOf(item);
      if (!ws) return;
      try {
        await ws.runVerify(item.agentName);
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
      const rec = ws.ledger.get(item.agentName)?.worktree;
      if (!rec) {
        notify(vscode.l10n.t("'{0}' has no worktree", item.agentName), "warn");
        return;
      }
      if (!fs.existsSync(rec.path)) {
        notify(vscode.l10n.t("'{0}'s worktree path no longer exists", item.agentName), "warn");
        return;
      }
      const readiness = await probePrReadiness(rec.path, true, ws.gitExec);
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
        const [dirty, verifyInfo] = await Promise.all([isWorktreeDirty(rec.path, ws.gitExec), ws.verifyInfo(item.agentName)]);
        const body = composePrBody({
          branch: rec.branch,
          base: base ?? undefined,
          verify: verifyInfo ? { badge: verifyInfo.badge, command: verifyInfo.command } : undefined,
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
        const result = await createWorktreePr(rec, { title, body, base: base ?? undefined }, ws.gitExec);
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
        await ws.reanchor(item.agentName);
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
        await ws.injectContinuity(item.agentName, "manual", { origin: "ui" });
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
      const rec = ws.ledger.get(name);
      const def = rec?.def;
      if (!def) {
        notify(vscode.l10n.t("'{0}' has no stored definition to save.", name), "warn");
        return;
      }
      if (ws.config?.agents[name] !== undefined) {
        notify(vscode.l10n.t("'{0}' is already declared in tachyon.yml.", name), "warn");
        return;
      }
      const ok = ws.mutateConfig((text) => addAgent(text ?? "", name, def.cmd, def.kind, def.instructions), () => refreshAll());
      if (!ok) return;
      // Transition the ledger: an adapter-backed agent keeps its row (flip to
      // declared, still resumable); a def-only row is removed (now it's in the yml).
      if (rec && isResumable(rec)) ws.ledger.record(name, { ...rec, declared: true });
      else ws.ledger.remove(name);
      ws.manager.forgetAdhoc(name); // config is now authoritative — drop the ad-hoc shadow
      refreshAll();
      notify(vscode.l10n.t("'{0}' saved to tachyon.yml.", name));
    }),
    vscode.commands.registerCommand("tachyon.editAgentItem", async (item: AgentItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      const file = ws.configPath();
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
    // ---- lifecycle ----
    vscode.commands.registerCommand("tachyon.start", async () => {
      for (const ws of workspaces()) {
        await ws.start();
      }
      refreshAll();
    }),
    vscode.commands.registerCommand("tachyon.stopAll", async () => {
      let total = 0;
      for (const ws of workspaces()) {
        const killed = await ws.manager.killAll();
        await ws.commandRunner.killAll();
        await ws.runbookRunner.killAll();
        total += killed.length;
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
        activityLog.noteLifecycle(ws.wsHash, agent, "restarted"); // spec 239 — note BEFORE the action, arm AFTER
        await ws.manager.restart(agent);
        activityLog.armLifecycle(ws.wsHash, agent);
        notify(vscode.l10n.t("'{0}' restarted", agent));
      } catch (err) {
        activityLog.clearLifecycle(ws.wsHash, agent);
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.openAgentTerminal", async () => {
      const ws = await pickWorkspace();
      if (!ws) return;
      const agent = await pickAgent(ws, vscode.l10n.t("Open which agent's terminal?"), true);
      if (agent) ws.terminals.open(agent, ws.manager.session(agent));
    }),
    // spec 234 — tachyon.applyLayout removed (layouts feature retired).
    // spec 233 — tachyon.saveLayoutAs removed (layouts feature discontinued; was the engine's last vscode use).
    // ---- bridge ----
    vscode.commands.registerCommand("tachyon.copyBridgeToken", async () => {
      const ws = await pickWorkspace();
      if (!ws) return;
      if (!ws.externalToken) {
        notify(vscode.l10n.t("Bridge auth is disabled (settings.auth: false) — no token"), "warn");
        return;
      }
      await vscode.env.clipboard.writeText(ws.externalToken);
      notify(vscode.l10n.t("Bridge token copied — export it as TACHYON_BRIDGE_TOKEN for external agents"));
    }),
    vscode.commands.registerCommand("tachyon.copyBridgeUrl", async (hash?: string) => {
      const ws = byHash(hash) ?? (await pickWorkspace());
      if (!ws) return;
      if (!ws.bridge.url) {
        notify(vscode.l10n.t("Bridge is not running"), "error");
        return;
      }
      await vscode.env.clipboard.writeText(ws.bridge.url);
      notify(vscode.l10n.t("Bridge URL copied: {0}", ws.bridge.url));
    }),
    vscode.commands.registerCommand("tachyon.showRuntimeUsage", async () => {
      await openRuntimeOps();
    }),
    vscode.commands.registerCommand("tachyon.refreshRuntimeOps", () => {
      runtimeOpsSnapshots.invalidateDetection();
      runtimeOps.refresh();
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
        await ws.commandRunner.run(item.commandName);
        refreshAll();
        ws.openCommandPane(item.commandName);
      } catch (err) {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }),
    vscode.commands.registerCommand("tachyon.openCommandTerminalItem", (name: string, hash?: string) => {
      targetOf(hash)?.openCommandPane(name);
    }),
    vscode.commands.registerCommand("tachyon.runRunbookItem", (item: RunbookItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      // fire-and-forget: progress is observable in the tree; onFinished toasts
      void ws.runbookRunner.run(item.runbookName).catch((err) => {
        notify(`${err instanceof Error ? err.message : String(err)}`, "error");
      });
      setTimeout(() => refreshAll(), 50); // pick up "running" promptly
    }),
    vscode.commands.registerCommand("tachyon.openRunbookStepItem", (runbook: string, index: number, hash?: string) => {
      targetOf(hash)?.openRunbookStepPane(runbook, index);
    }),
    vscode.commands.registerCommand("tachyon.editCommandItem", async (item: CommandItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      const file = ws.configPath();
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
      ws.mutateConfig((text) => deleteCommand(text ?? "", item.commandName), () => refreshAll());
    }),
    vscode.commands.registerCommand("tachyon.editCommandStudioItem", async (item: CommandItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      ws.reloadConfig();
      const def = ws.config?.commands[item.commandName];
      if (!def) {
        notify(vscode.l10n.t("'{0}' is not declared in tachyon.yml", item.commandName), "warn");
        return;
      }
      commandStudioPanels.openExisting(ws, item.commandName);
    }),
    vscode.commands.registerCommand("tachyon.commandStudio", async () => {
      const ws = await pickFolderForCreate();
      if (!ws) return;
      ws.reloadConfig();
      commandStudioPanels.openNew(ws);
    }),
    vscode.commands.registerCommand("tachyon.scheduleStudio", async () => {
      const ws = await pickFolderForCreate();
      if (!ws) return;
      ws.reloadConfig();
      scheduleStudioPanels.openNew(ws);
    }),
    vscode.commands.registerCommand("tachyon.editScheduleStudioItem", async (item: ScheduleItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      ws.reloadConfig();
      const def = ws.config?.schedules[item.scheduleName];
      if (!def) {
        notify(vscode.l10n.t("'{0}' is not declared in tachyon.yml", item.scheduleName), "warn");
        return;
      }
      scheduleStudioPanels.openExisting(ws, item.scheduleName);
    }),
    vscode.commands.registerCommand("tachyon.editRunbookStudioItem", async (item: RunbookItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      ws.reloadConfig();
      const def = ws.config?.runbooks[item.runbookName];
      if (!def) {
        notify(vscode.l10n.t("'{0}' is not declared in tachyon.yml", item.runbookName), "warn");
        return;
      }
      runbookStudioPanels.openExisting(ws, item.runbookName);
    }),
    vscode.commands.registerCommand("tachyon.editRunbookItem", async (item: RunbookItem) => {
      const ws = wsOf(item);
      if (!ws) return;
      const file = ws.configPath();
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
      if (ws.runbookRunner.isRunning(item.runbookName)) {
        notify(vscode.l10n.t("runbook '{0}' is running — wait for it to finish before deleting", item.runbookName), "warn");
        return;
      }
      if (!forceArg) {
        const answer = await showNotification(
          vscode.l10n.t("Delete runbook '{0}' from tachyon.yml?", item.runbookName),
          "warn",
          [vscode.l10n.t("Delete")],
          { modal: true },
        );
        if (answer !== vscode.l10n.t("Delete")) return;
      }
      ws.mutateConfig((text) => deleteRunbook(text ?? "", item.runbookName), () => refreshAll());
    }),
  );

  updateStatusBar();
}

export function deactivate(): void {
  // tmux sessions intentionally survive — Tachyon re-attaches on next activation.
  for (const ws of registry.values()) void ws.dispose();
  registry.clear();
}
