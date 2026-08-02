import path from "node:path";
import * as vscode from "vscode";
import { sharedGlobalSettings } from "../config/globalSettings.js";
import { panelIcon } from "./shared/panelIcon.js";
import { isAgentRow, type FleetVM, type AgentVM, type PinPreviewAttachmentVM, type PinPreviewVM } from "../sidebar/types.js";
import { fleetMessage } from "./sidebar/messages.js";
import { READY } from "./shared/ready.js";
import { isCockpitSectionId } from "../cockpit/resolveSection.js";
import { renderWebviewShell } from "./shared/shell.js";
import { pinPreviewMessage } from "./pin-preview/messages.js";
import type { ActionId } from "../sidebar/actions.js";
import { agentContextValue } from "../presentation/contextValue.js";
import { notify } from "../workspace/notify.js";
import { showNotification } from "../workspace/NotificationService.js";
import type { TiptapJSON } from "../richDoc/types.js";
import type { WorkspaceSidebarTarget, SidebarShellCommandContext } from "../shell/SidebarTarget.js";
import {
  mergeCardTemplateConfigs,
  parseCardTemplate,
  DEFAULT_CARD_TEMPLATE,
  type CardTemplateConfig,
} from "../sidebar/cardTemplate.js";

/**
 * SDD 479 phase 5 — the personal card-template override's key; t-aaad95 moved its home from VS Code
 * settings to `sidebar.cardTemplate` in the global Tachyon settings file.
 *
 * The project's template lives in `tachyon.yml` and travels with the repo; this one belongs to one
 * person on one machine, which is why it is read HERE (the shell) rather than in the engine's
 * projection: it is the same class of state as `sortPrefs` and `collapsedKeys` above, and it must not
 * become something an agent-authored checkout can carry.
 */
const PERSONAL_CARD_TEMPLATE_KEY = "sidebar.cardTemplate";

export const PIN_PREVIEW_VIEW_TYPE = "tachyonPinPreview";

export interface PinPreviewPanelState {
  schemaVersion: 1;
  view: typeof PIN_PREVIEW_VIEW_TYPE;
  wsHash: string;
  pinId: string;
}

/** Messages the webview posts to the host. */
type SidebarMsg = {
  type?: "ready" | "action" | "section" | "global" | "pipeline" | "setSort" | "setCollapsed";
  id?: string;
  agent?: string;
  op?: string;
  done?: boolean;
  label?: string;
  actionId?: string;
  name?: string;
  nodeId?: string;
  hash?: string;
  section?: string; // setSort: "agents" | "terminals"
  sectionId?: string; // global openControl: the Control section a launcher tile targets (t-6e2952)
  mode?: string; // setSort: a SortMode
  keys?: unknown; // setCollapsed: full collapsed key list
};

/** spec 242 — persisted sidebar sort prefs (global per user, per section). */
type SortPrefs = { agents?: string; terminals?: string };
const SORT_PREFS_KEY = "tachyon.sidebar.sort";
const COLLAPSED_KEYS_KEY = "tachyon.sidebar.collapsed";

/** Maps a webview action id → the existing VS Code command (which takes a duck-typed {ws, agentName,
 *  contextValue} item — the handlers only read those fields). `inspect` is special (it takes (agent, hash),
 *  not an item). */
const ACTION_CMD: Record<Exclude<ActionId, "inspect" | "openPane" | "activity" | "probes">, string> = {
  stop: "tachyon.stopAgentItem",
  kill: "tachyon.killAgentItem",
  restart: "tachyon.restartAgentItem",
  restartNew: "tachyon.restartAgentNewItem",
  restartForceNew: "tachyon.restartAgentForceNewItem",
  spawn: "tachyon.spawnAgentItem",
  resume: "tachyon.resumeAgentItem",
  fork: "tachyon.forkAgentItem",
  verify: "tachyon.verifyAgentItem",
  reanchor: "tachyon.reanchorAgentItem",
  reinjectContinuity: "tachyon.reinjectContinuityItem",
  injectPrompt: "tachyon.injectPromptTemplateItem",
  promote: "tachyon.promoteAgentItem",
  reviewWorktree: "tachyon.reviewWorktreeItem",
  createPr: "tachyon.createWorktreePrItem",
  edit: "tachyon.editAgentStudioItem",
  editYaml: "tachyon.editAgentItem",
  clone: "tachyon.cloneAgentItem",
  remove: "tachyon.deleteAgentItem",
};

/**
 * spec 237 — the Tachyon sidebar webview (Preact). The host glue: serves the shell HTML (CSP + the VS Code
 * theme CSS + codicon font), loads the bundled Preact app (`dist/webview/sidebar.js`), and pushes the LIVE
 * fleet model to it via postMessage (gathered from the workspace managers across all sections). All UI lives
 * in the bundle. This is THE Tachyon sidebar — the native tree was retired in spec 237.
 */
export class SidebarPrototypeProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "tachyonSidebarPrototype";
  private view?: vscode.WebviewView;
  private lastFleets: FleetVM[] = [];
  private pushGeneration = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getWorkspaces: () => WorkspaceSidebarTarget[],
    private readonly memento?: vscode.Memento, // spec 242 — persists the sort prefs (context.globalState)
    /** t-38c2a1 — extension package version shown in the sidebar header. */
    private readonly appVersion?: string,
  ) {}

  private sortCache?: SortPrefs; // synchronous mirror so overlapping setSort writes don't lose a section (codex)
  private sortPrefs(): SortPrefs {
    return (this.sortCache ??= this.memento?.get<SortPrefs>(SORT_PREFS_KEY) ?? {});
  }
  private collapsedCache?: string[];
  private collapsedKeys(): string[] {
    return (this.collapsedCache ??= this.memento?.get<string[]>(COLLAPSED_KEYS_KEY) ?? []);
  }

  /**
   * SDD 479 phase 5 — layer the personal override onto ONE folder's project template.
   *
   * Per folder, not once for the window: multi-root means two folders can legitimately carry
   * different project templates, and the personal document's unmentioned regions inherit whichever
   * one this row's folder actually has. Parsing per folder is what makes "personal wins" mean
   * "personal wins over THIS project", instead of over whichever root happened to be first.
   *
   * Fail-closed and named: an invalid personal override falls back to the project's template (and so
   * to the default beneath it) and returns the diagnostic, so the fallback can explain itself instead
   * of reading as the feature not working. `parseCardTemplate` is the SAME validator `tachyon.yml`
   * uses — a second one that could disagree with it is the failure this phase exists to avoid.
   */
  private cardTemplateFor(fleet: FleetVM): { config?: CardTemplateConfig; refusal?: string[] } {
    const store = sharedGlobalSettings();
    // t-aaad95 — TWO refusals can now reach this banner, and both have to.
    //
    // The store refuses a bad DOCUMENT whole (fail-closed, last-known-good), which is what a hand
    // edit trips; `parseCardTemplate` below refuses a template that is well-formed on its own but
    // invalid against THIS folder's project base. Reporting only the second would leave a person who
    // broke the file staring at cards that silently ignore their template.
    const documentRefusal = store.refusal();
    if (documentRefusal) {
      const projectOnly = mergeCardTemplateConfigs(fleet.cardTemplate, undefined);
      return { ...(projectOnly ? { config: projectOnly } : {}), refusal: documentRefusal.errors };
    }
    // t-aaad95 — the store already normalized "nothing configured": `null` and `{}`, which is what a
    // person leaves behind after clearing the key, both parse to `undefined` there. Repeating that
    // rule here would be a second place it could drift from the loader's.
    const written = store.current().sidebarCardTemplate;
    const project = fleet.cardTemplate;
    const projectOnly = mergeCardTemplateConfigs(project, undefined);
    if (written === undefined) return projectOnly ? { config: projectOnly } : {};
    const parsed = parseCardTemplate(written, PERSONAL_CARD_TEMPLATE_KEY, project?.base ?? DEFAULT_CARD_TEMPLATE);
    if (!parsed.config) {
      return { ...(projectOnly ? { config: projectOnly } : {}), refusal: parsed.errors };
    }
    return { config: mergeCardTemplateConfigs(project, parsed.config) ?? projectOnly ?? undefined };
  }

  /** The fleets as the webview sees them: the engine's projection plus this person's own layer. */
  private withPersonalCardTemplate(fleets: FleetVM[]): FleetVM[] {
    return fleets.map((fleet) => {
      const { config, refusal } = this.cardTemplateFor(fleet);
      return {
        ...fleet,
        ...(config ? { cardTemplate: config } : {}),
        ...(refusal?.length
          ? { personalCardTemplateRefusal: { file: `${sharedGlobalSettings().file} · ${PERSONAL_CARD_TEMPLATE_KEY}`, errors: refusal } }
          : {}),
      };
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    view.webview.options = { enableScripts: true, localResourceRoots: [root] };
    // t-38c2a1 — version in native view title. t-6e2952 — Control is now the second TAB of this same
    // view (the launcher grid), so the view/title openControl button is gone and no second view exists.
    this.applyNativeTitle(view);
    const uri = (f: string): string => view.webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString();
    view.webview.onDidReceiveMessage((m: SidebarMsg) => void this.handleMessage(m));
    // spec 280 — the sidebar VIEW keeps its bespoke CSP via the shell: img `blob:` + script-src nonce-only (no cspSource).
    view.webview.html = renderWebviewShell({
      cspSource: view.webview.cspSource,
      title: "Tachyon",
      styles: [uri("codicon.css"), uri("design-system.css"), uri("sidebar.css")],
      bundle: uri("sidebar.js"),
      mode: "live",
      imgBlob: true,
      scriptCspSource: false,
    });
    void this.push();
    // SDD 479 phase 5 — editing the personal override must repaint the cards, or the person is
    // editing a template they cannot see take effect until something unrelated triggers a refresh.
    // t-aaad95 — the override moved from a VS Code settings key to the global Tachyon file, so this
    // watches that FILE instead of a configuration event. `create` matters as much as `change`: a
    // temp+rename write (and a first-ever edit) arrives as a create, not a change.
    const settingsFile = sharedGlobalSettings().file;
    const settingsWatch = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(settingsFile)), path.basename(settingsFile)),
    );
    settingsWatch.onDidChange(() => void this.push());
    settingsWatch.onDidCreate(() => void this.push());
    settingsWatch.onDidDelete(() => void this.push());
    view.onDidDispose(() => {
      settingsWatch.dispose();
      if (this.view === view) {
        this.pushGeneration += 1;
        this.view = undefined;
      }
    });
  }

  /** Native header: container already says Tachyon — view title is only the version (avoids "TACHYON: TACHYON …"). */
  private applyNativeTitle(view: vscode.WebviewView): void {
    view.title = this.appVersion ? `v${this.appVersion}` : "";
    view.description = undefined;
  }

  /** Resolve the workspace an action targets — its folder hash (multi-root), or the first when unspecified. */
  private wsFor(hash?: string): WorkspaceSidebarTarget | undefined {
    const wss = this.getWorkspaces();
    // Only default to the first workspace when NO hash was sent. A supplied-but-unmatched hash (stale
    // message after a folder was removed, or a bad value) must resolve to nothing — never act on ws 0.
    return hash === undefined ? wss[0] : wss.find((w) => w.wsHash === hash);
  }

  /** Re-gather + push the live fleets (one per workspace root) to the webview (wired into refreshAll). */
  refresh(): void {
    void this.push();
  }

  private async push(): Promise<void> {
    const view = this.view;
    if (!view) return;
    const generation = ++this.pushGeneration;
    let fleets: FleetVM[];
    try {
      fleets = await Promise.all(this.getWorkspaces().map((ws) => ws.loadSidebar()));
    } catch (error) {
      if (this.view === view && generation === this.pushGeneration) {
        notify(vscode.l10n.t("Could not refresh Sidebar: {0}", error instanceof Error ? error.message : String(error)), "error");
      }
      return;
    }
    if (this.view !== view || generation !== this.pushGeneration) return;
    this.lastFleets = fleets;
    this.applyNativeTitle(view);
    const openAttention = fleets.reduce(
      (total, fleet) => total + (fleet.notices ?? []).filter((notice) => !notice.read).length,
      0,
    );
    view.badge = openAttention > 0
      ? { value: openAttention, tooltip: `${openAttention} open Tachyon attention item${openAttention === 1 ? "" : "s"}` }
      : undefined;
    // spec 242 — prefs travel WITH the fleet so the first render is already in the saved order (D8 no flicker).
    // spec 278 — built via the shared envelope so a `fleet`-shape drift breaks the build, not the preview harness.
    // SDD 479 phase 5 — the personal layer is applied on the way OUT, not stored: `lastFleets` stays
    // the engine's own projection, so a settings change re-derives from it without a re-fetch, and
    // nothing persists a template that belongs to one person on one machine.
    void view.webview.postMessage(
      fleetMessage(this.withPersonalCardTemplate(this.lastFleets), this.sortPrefs(), this.collapsedKeys(), this.appVersion),
    );
  }

  private async handleMessage(m: SidebarMsg): Promise<void> {
    if (m?.type === "ready") return void this.push();
    if (m?.type === "setSort" && (m.section === "agents" || m.section === "terminals") && (m.mode === "name-asc" || m.mode === "name-desc")) {
      // spec 242 (D9) — update the in-memory cache SYNCHRONOUSLY (before the await) so a second overlapping
      // setSort reads the new object, then persist + republish (the validated mode never writes garbage).
      this.sortCache = { ...this.sortPrefs(), [m.section]: m.mode };
      await this.memento?.update(SORT_PREFS_KEY, this.sortCache);
      return void this.push();
    }
    if (m?.type === "setCollapsed" && Array.isArray(m.keys)) {
      this.collapsedCache = [...new Set(m.keys.filter((key): key is string => typeof key === "string"))];
      await this.memento?.update(COLLAPSED_KEYS_KEY, this.collapsedCache);
      return void this.push();
    }
    if (m?.type === "action" && m.id && m.agent) return this.runAction(m.id as ActionId, m.agent, m.hash);
    if (m?.type === "global") {
      // The "new …" studios pick the target folder themselves (pickFolderForCreate) → no ws/hash needed.
      const STUDIO: Record<string, string> = {
        "studio:agents": "tachyon.newAgentStudio", "studio:terminals": "tachyon.terminalStudio",
        "studio:commands": "tachyon.commandStudio", "studio:runbooks": "tachyon.runbookStudio",
        "studio:schedules": "tachyon.scheduleStudio",
      };
      if (m.op && STUDIO[m.op]) return void vscode.commands.executeCommand(STUDIO[m.op]);
      if (m.op === "copyBridge") return void vscode.commands.executeCommand("tachyon.copyBridgeUrl", m.hash);
      if (m.op === "init") return void vscode.commands.executeCommand("tachyon.init");
      // t-6e2952 — the Control tab's tiles send the section they want. Never trust the webview's string:
      // an unknown id drops to a plain open (overview) instead of reaching the command as-is. The command
      // routes through openCockpit, so an already-open Control NAVIGATES rather than opening a second one.
      if (m.op === "openControl") {
        return void (isCockpitSectionId(m.sectionId)
          ? vscode.commands.executeCommand("tachyon.openControl", m.sectionId)
          : vscode.commands.executeCommand("tachyon.openControl"));
      }
      if (m.op === "openHandoff") return void vscode.commands.executeCommand("tachyon.openProjectHandoff", m.hash); // spec 245
      if (m.op === "openConfig") return void vscode.commands.executeCommand("tachyon.openConfig", m.hash); // t-8354ae
      // t-aaad95 — the personal override's home is now a FILE, and opening it is also the documented
      // recovery path when Control itself cannot open. `tachyon.openGlobalSettings` creates the
      // document if it does not exist yet, so this never lands on a missing file.
      if (m.op === "openPersonalCardTemplate") {
        return void vscode.commands.executeCommand("tachyon.openGlobalSettings");
      }
      if (m.op === "doctor") return void vscode.commands.executeCommand("tachyon.doctor", m.hash); // t-8354ae
      const ws = this.wsFor(m.hash);
      if (ws && m.op === "addPin") void vscode.commands.executeCommand(
        "tachyon.addPin",
        ...ws.shellCommandArgs({ kind: "workspace" }),
      );
      return;
    }
    if (m?.type === "section" && m.op && m.id) {
      return this.runSection(m.op, m.id, { done: m.done, actionId: m.actionId }, m.hash);
    }
    if (m?.type === "pipeline" && m.op && m.name) return this.runPipeline(m.op, m.name, m.nodeId, m.hash);
  }

  /** Route a section-row action to its existing VS Code command (duck-typed item) or store mutation. */
  private async runSection(
    op: string,
    id: string,
    extra?: { done?: boolean; actionId?: string },
    wsHash?: string,
  ): Promise<void> {
    const ws = this.wsFor(wsHash);
    if (!ws) return;
    const done = extra?.done;
    const exec = (cmd: string, context: SidebarShellCommandContext) => {
      void vscode.commands.executeCommand(cmd, ...ws.shellCommandArgs(context));
    };
    switch (op) {
      case "command:run": return exec("tachyon.runCommandItem", { kind: "command", commandName: id });
      case "command:open": return void vscode.commands.executeCommand("tachyon.openCommandTerminalItem", id, ws.wsHash);
      case "command:edit": return exec("tachyon.editCommandStudioItem", { kind: "command", commandName: id });
      case "command:editYaml": return exec("tachyon.editCommandItem", { kind: "command", commandName: id });
      case "command:delete": return exec("tachyon.deleteCommandItem", { kind: "command", commandName: id });
      case "runbook:run": return exec("tachyon.runRunbookItem", { kind: "runbook", runbookName: id });
      case "runbook:edit": return exec("tachyon.editRunbookStudioItem", { kind: "runbook", runbookName: id });
      case "runbook:editYaml": return exec("tachyon.editRunbookItem", { kind: "runbook", runbookName: id });
      case "runbook:delete": return exec("tachyon.deleteRunbookItem", { kind: "runbook", runbookName: id });
      case "runbook:step": { const hash = id.indexOf("#"); return void vscode.commands.executeCommand("tachyon.openRunbookStepItem", id.slice(0, hash), Number(id.slice(hash + 1)), ws.wsHash); }
      case "pin:toggle": return this.mutateSidebar(ws, { action: "pin.toggle", id, done: !!done });
      case "notice:markRead": return this.mutateSidebar(ws, { action: "notice.markRead", id });
      case "notice:markAllRead": return this.mutateSidebar(ws, { action: "notice.markAllRead", id: "all" });
      case "notice:invoke": {
        if (!extra?.actionId) return;
        return this.mutateSidebar(ws, { action: "notice.invoke", id, actionId: extra.actionId });
      }
      case "pin:preview": return void this.previewPin(ws, id);
      case "pin:copy": {
        // Never trust the label echoed by the webview. The first projection may still be in flight after
        // activation, so read the authoritative engine projection for this gesture as well.
        try {
          const title = (await ws.loadSidebar()).pins.find((pin) => pin.id === id)?.text ?? id;
          await vscode.env.clipboard.writeText(`ID: ${id}\nTitle: ${title}`);
          notify(vscode.l10n.t("Pin copied: {0}", id));
        } catch (error) {
          notify(vscode.l10n.t("Could not copy pin: {0}", error instanceof Error ? error.message : String(error)), "error");
        }
        return;
      }
      case "pin:copyId": {
        await vscode.env.clipboard.writeText(id);
        notify(vscode.l10n.t("Pin ID copied: {0}", id));
        return;
      }
      case "pin:edit": return exec("tachyon.editPinItem", { kind: "pin", pinId: id });
      case "pin:delete": return this.mutateSidebar(ws, { action: "pin.delete", id });
      case "schedule:pause": return this.mutateSidebar(ws, { action: "schedule.toggle-pause", id });
      case "schedule:edit": return exec("tachyon.editScheduleStudioItem", { kind: "schedule", scheduleName: id });
      case "schedule:editYaml": return exec("tachyon.editScheduleItem", { kind: "schedule", scheduleName: id });
      case "schedule:delete": {
        const answer = await showNotification(
          vscode.l10n.t("Delete schedule '{0}' from tachyon.yml?", id),
          "warn",
          [vscode.l10n.t("Delete")],
          { modal: true },
        );
        if (answer === vscode.l10n.t("Delete")) await this.mutateSidebar(ws, { action: "schedule.delete", id });
        return;
      }
      case "proposal:approve": return this.mutateSidebar(ws, { action: "proposal.approve", id });
      case "proposal:reject": {
        let proposalName: string;
        try {
          proposalName = (await ws.loadSidebar()).proposals.find((proposal) => proposal.id === id)?.name ?? id;
        } catch (error) {
          notify(vscode.l10n.t("Could not load proposal: {0}", error instanceof Error ? error.message : String(error)), "error");
          return;
        }
        const answer = await showNotification(
          vscode.l10n.t("Reject the proposed schedule '{0}'?", proposalName),
          "warn",
          [vscode.l10n.t("Reject")],
          { modal: true },
        );
        if (answer === vscode.l10n.t("Reject")) await this.mutateSidebar(ws, { action: "proposal.reject", id });
        return;
      }
    }
  }

  private async mutateSidebar(
    ws: WorkspaceSidebarTarget,
    input: Parameters<WorkspaceSidebarTarget["mutateSidebar"]>[0],
  ): Promise<void> {
    try {
      await ws.mutateSidebar(input);
      this.refresh();
    } catch (error) {
      notify(vscode.l10n.t("Could not update sidebar state: {0}", error instanceof Error ? error.message : String(error)), "error");
    }
  }

  deserializePinPreview(panel: vscode.WebviewPanel, state: PinPreviewPanelState): void {
    const ws = this.wsFor(state.wsHash);
    if (!ws) { panel.dispose(); return; }
    void this.previewPin(ws, state.pinId, panel);
  }

  private async previewPin(ws: WorkspaceSidebarTarget, id: string, revivedPanel?: vscode.WebviewPanel): Promise<void> {
    let panel: vscode.WebviewPanel | undefined;
    try {
      const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
      const blobRoot = vscode.Uri.file(ws.pinAttachmentBlobRoot());
      // spec 279 — scripts ON to load the preact bundle. SAFE because the bundle renders all pin content as
      // TEXT (preact escapes by default), never innerHTML, under a strict nonce'd CSP (the shell). Images load
      // only from host-resolved asWebviewUri blobs in blobRoot.
      panel = revivedPanel ?? vscode.window.createWebviewPanel(
        PIN_PREVIEW_VIEW_TYPE,
        `Pin Preview — ${id}`,
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        // t-b5e6e5 — the native VS Code find widget (Ctrl+F), piggybacking on Mission Control's validation.
        { enableScripts: true, localResourceRoots: [root, blobRoot], enableFindWidget: true },
      );
      const activePanel = panel;
      activePanel.title = `Pin Preview — ${id}`;
      activePanel.webview.options = { enableScripts: true, localResourceRoots: [root, blobRoot] };
      activePanel.iconPath = panelIcon(this.extensionUri, "eye"); // spec 282 — contextual editor-tab icon
      const detail = await ws.loadPinPreview(id, {
        asWebviewUri: (filePath) => activePanel.webview.asWebviewUri(vscode.Uri.file(filePath)).toString(),
      });
      const preview: PinPreviewVM = {
        id,
        title: detail.title,
        ...(detail.by ? { by: detail.by } : {}),
        done: detail.done,
        tags: detail.tags,
        body: pinDocPreview(detail.doc) || detail.title,
        // t-321e9d — the raw doc travels alongside the flattened `body` fallback; pin-preview's App resolves
        // it through the SAME `toEditorDoc` pipeline the Studio/editor uses (webview URIs via `attachments`)
        // instead of rendering the flattened "[Image]"/"[Sketch]" text placeholders.
        doc: detail.doc,
        attachments: detail.attachments.map((att): PinPreviewAttachmentVM => {
          if (att.kind === "image") {
            return {
              id: att.id,
              kind: "image",
              name: att.name,
              available: att.available,
              ...(att.available && att.uri ? { uri: att.uri } : {}),
              detail: `${att.mediaType.replace(/^image\//, "").toUpperCase()} · ${Math.round(att.size / 1024)} KB`,
            };
          }
          return {
            id: att.id,
            kind: "excalidraw",
            name: att.name,
            available: att.previewAvailable,
            ...(att.previewAvailable && att.previewUri ? { previewUri: att.previewUri } : {}),
            detail: `Sketch · ${att.elementCount} element${att.elementCount === 1 ? "" : "s"} · ${Math.round(att.previewSize / 1024)} KB preview`,
          };
        }),
      };
      const uri = (f: string): string => activePanel.webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString();
      activePanel.webview.html = renderWebviewShell({
        cspSource: activePanel.webview.cspSource,
        title: `Pin Preview — ${id}`,
        styles: [uri("codicon.css"), uri("design-system.css"), uri("pin-preview.css")],
        bundle: uri("pin-preview.js"),
        mode: "static",
        imgBlob: true,
        persistedState: { schemaVersion: 1, view: PIN_PREVIEW_VIEW_TYPE, wsHash: ws.wsHash, pinId: id } satisfies PinPreviewPanelState,
      });
      // preact-static: post the VM once the bundle signals ready.
      activePanel.webview.onDidReceiveMessage((m: { type?: string } | undefined) => {
        if (m?.type === READY) void activePanel.webview.postMessage(pinPreviewMessage(preview));
      });
    } catch (err) {
      panel?.dispose();
      notify(vscode.l10n.t("Could not preview pin: {0}", err instanceof Error ? err.message : String(err)), "error");
    }
  }

  /** Route a pipeline shell gesture using the engine-authored active-node identity from the latest fleet. */
  private runPipeline(op: string, name: string, nodeId?: string, wsHash?: string): void {
    const ws = this.wsFor(wsHash);
    if (!ws) return;
    const exec = (cmd: string, context: SidebarShellCommandContext) => {
      void vscode.commands.executeCommand(cmd, ...ws.shellCommandArgs(context));
    };
    const definition = { kind: "pipeline", pipelineName: name } as const;
    const node = { kind: "pipeline", pipelineName: name, ...(nodeId ? { nodeId } : {}) } as const;
    switch (op) {
      case "run": return exec("tachyon.runPipelineItem", definition);
      case "cancel": return exec("tachyon.cancelPipelineItem", definition);
      case "dismiss": return exec("tachyon.dismissPipelineRunItem", definition);
      case "review": return exec("tachyon.reviewPipelineItem", definition);
      case "editInput": return exec("tachyon.editPipelineInputItem", definition);
      case "edit": return exec("tachyon.editPipelineItem", definition);
      case "delete": return exec("tachyon.deletePipelineItem", definition);
      case "node:approve": return exec("tachyon.approvePipelineNodeItem", node);
      case "node:reject": return exec("tachyon.rejectPipelineNodeItem", node);
      case "node:rerun": return exec("tachyon.rerunPipelineNodeItem", node);
      case "node:review": return exec("tachyon.reviewPipelineItem", node);
      case "node:inspect": {
        const agentName = this.lastFleets.find((fleet) => fleet.folder?.hash === ws.wsHash)?.pipelines
          .find((pipeline) => pipeline.name === name)?.nodes.find((entry) => entry.id === nodeId)?.agentName;
        if (agentName) void vscode.commands.executeCommand("tachyon.openAgentTerminalItem", agentName, ws.wsHash);
        return;
      }
    }
  }

  /** Run an agent action by invoking the existing VS Code command with a duck-typed {ws, agentName,
   *  contextValue} item — the same shape the tree passes; the tree never has to exist for this to work. */
  private runAction(id: ActionId, agent: string, wsHash?: string): void {
    const ws = this.wsFor(wsHash);
    if (!ws) {
      console.log(`[tachyon] sidebar action ignored: workspace not found for hash=${wsHash ?? "<default>"}`);
      notify(vscode.l10n.t("Sidebar action ignored — workspace is no longer active"), "warn");
      return;
    }
    if (id === "inspect") { void vscode.commands.executeCommand("tachyon.openAgentTerminalItem", agent, ws.wsHash); return; }
    // t-610355 — layer-2 first-party pane (next to integrated terminal open on the row)
    if (id === "openPane") { void vscode.commands.executeCommand("tachyon.openAgentPaneItem", agent, ws.wsHash); return; }
    if (id === "activity") { void vscode.commands.executeCommand("tachyon.openAgentActivity", agent, ws.wsHash); return; } // spec 238
    if (id === "probes") { void vscode.commands.executeCommand("tachyon.openProbes", ws.wsHash, agent); return; } // spec 322 — this agent's probes only
    const fleet = this.lastFleets.find((f) => f.folder?.hash === ws.wsHash);
    const vm = fleet?.agents.find((x) => x.name === agent) ?? fleet?.terminals.find((x) => x.name === agent);
    void vscode.commands.executeCommand(
      ACTION_CMD[id],
      ...ws.shellCommandArgs({ kind: "agent", agentName: agent, contextValue: vm ? ctxOf(vm) : "agent-running" }),
    ).then(undefined, (err) => {
      console.log(`[tachyon] sidebar command failed id=${id} agent=${agent}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      notify(`${err instanceof Error ? err.message : String(err)}`, "error");
    });
  }

}

/** Reconstruct the contextValue the command handlers expect, from the agent VM's capability flags. */
function ctxOf(a: AgentVM): string {
  const state = a.status === "crashed" ? "crashed" : a.status === "stopped" ? "stopped" : "running";
  return agentContextValue({ state, ai: isAgentRow(a), temporary: !!a.adhoc, worktree: !!a.worktree, verifiable: !!a.verifiable, forkable: !!a.forkable, harness: !!a.harness });
}

export function pinDocPreview(doc: TiptapJSON | null): string {
  if (!doc) return "";
  const blocks: string[] = [];
  collectPinDocText(doc, blocks);
  return blocks.map((line) => line.trim()).filter(Boolean).join("\n\n");
}

function collectPinDocText(node: TiptapJSON, blocks: string[]): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "listItem") {
    const text = inlinePinDocText(node).trim();
    if (text) blocks.push(`- ${text}`);
    return "";
  }
  const children = (node.content ?? []).map((child) => collectPinDocText(child, blocks)).join("");
  switch (node.type) {
    case "doc":
      return children;
    case "paragraph":
    case "heading":
    case "blockquote":
    case "codeBlock":
      if (children.trim()) blocks.push(children);
      return "";
    case "bulletList":
    case "orderedList":
      return children;
    case "tachyonSketch":
      blocks.push("[Sketch]");
      return "";
    case "image":
      blocks.push("[Image]");
      return "";
    case "hardBreak":
      return "\n";
    default:
      return children;
  }
}

function inlinePinDocText(node: TiptapJSON): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  return (node.content ?? []).map(inlinePinDocText).join("");
}
