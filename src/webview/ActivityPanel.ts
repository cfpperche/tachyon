import * as fs from "node:fs";
import * as vscode from "vscode";
import { startActivityFeed, type ActivityFeed } from "./activity/activityFeed.js";
import { withActivityShareKeys, resolveActivityShare, internalSharePrompt } from "../activity/activityShare.js";
import type { ActivityViewModel } from "../activity/activityView.js";
import type { WorkspaceActivityTarget } from "../shell/ActivityTarget.js";
import {
  SectionPanelManager,
  type SectionAppConfig,
  type SectionPanelSession,
  type SectionPanelState,
  type SectionPanelTarget,
} from "./shared/SectionPanelManager.js";
import { webviewApp, type WebviewAppEntry } from "./webviewApps.js";
import {
  ACTIVITY,
  COPY_SHARE_TEXT,
  IMAGE_DATA,
  READY,
  SHARE_EXTERNAL,
  SHARE_TO_AGENT,
  activityMessage,
  imageDataMessage,
  shareAgentTargetsMessage,
  type ActivityWebviewMessage,
  type ExternalShareChannel,
} from "./activity/messages.js";
import { notify, showNotification } from "../workspace/NotificationService.js";
import { sharedGlobalSettings } from "../config/globalSettings.js";

export const ACTIVITY_VIEW_TYPE = "tachyonActivity";

/** The pre-410 persisted shape. The viewType still names this app and both fields map exactly to its key. */
export interface ActivityPanelState {
  schemaVersion: 1;
  view: typeof ACTIVITY_VIEW_TYPE;
  wsHash: string;
  agent: string;
}

type ActivityRefreshKind = "activity";

interface ActivityPanelBinding {
  session: SectionPanelSession<ActivityRefreshKind>;
  agent: string;
  feed: ActivityFeed;
  latest?: ActivityViewModel;
  transcriptPath?: string;
  knownPaths: Set<string>;
  alive: boolean;
}

/** SDD 485 D17 — one standalone Activity document per immutable (workspace, agent) pair. */
export class ActivityPanelManager {
  private readonly manager: SectionPanelManager<ActivityRefreshKind>;
  private readonly bindings = new Map<string, ActivityPanelBinding>();

  constructor(
    extensionUri: vscode.Uri,
    private readonly getWorkspaces: () => WorkspaceActivityTarget[],
    app: WebviewAppEntry = webviewApp("activity"),
  ) {
    this.manager = new SectionPanelManager(extensionUri, this.configFor(app));
  }

  open(project: string, agent: string): void {
    this.manager.open({ project, identity: agent });
  }

  deserialize(panel: vscode.WebviewPanel, state: SectionPanelState | ActivityPanelState): void {
    this.manager.deserialize(panel, migrateLegacy(state));
  }

  get openKeys(): string[] {
    return this.manager.openKeys;
  }

  /**
   * The palette's "Open Raw Transcript", which must name ONE agent out of however many Activity tabs
   * are open.
   *
   * This picks by FOCUS, not by visibility, and the difference is the whole point: two Activity panels
   * in two editor groups are both `visible` at once, so the `visible` filter this replaced returned
   * whichever was opened FIRST and would have opened the wrong agent's transcript. What it superseded
   * (`openCockpitAgentTranscript`) never had to choose — Control was a singleton — and it deliberately
   * refused to guess when the current route was not an activity route. Becoming multi-instance is what
   * introduced the ambiguity, so the refusal has to be re-earned rather than inherited.
   *
   * Falling back to a lone visible panel is not a guess: with exactly one open there is only one answer,
   * and focus commonly sits in the palette's caller rather than on the panel. With several and none
   * focused, it says so instead of picking.
   */
  openTranscript(): void {
    const open = [...this.bindings.values()];
    const visible = open.filter((candidate) => candidate.session.visible);
    const binding = open.find((candidate) => candidate.session.focused)
      ?? (visible.length === 1 ? visible[0] : undefined);
    if (!binding) {
      notify(visible.length > 1
        ? vscode.l10n.t("Several Activity views are open — click the one you want, then run “Open Raw Transcript”.")
        : "Open an agent's Activity view first, then run “Open Raw Transcript”.");
      return;
    }
    if (binding.transcriptPath && fs.existsSync(binding.transcriptPath)) {
      void vscode.window.showTextDocument(vscode.Uri.file(binding.transcriptPath), {
        preview: true,
        viewColumn: vscode.ViewColumn.Beside,
      });
    } else {
      notify("Source transcript is no longer on disk — the rendered activity is preserved in Tachyon's durable log.");
    }
  }

  dispose(): void {
    this.manager.dispose();
    this.bindings.clear();
  }

  private workspaceFor(target: SectionPanelTarget): WorkspaceActivityTarget | undefined {
    return this.getWorkspaces().find((workspace) => workspace.wsHash === target.project);
  }

  private configFor(app: WebviewAppEntry): SectionAppConfig<ActivityRefreshKind> {
    return {
      app,
      // activity.css owns every Activity root rule. cockpit.css has zero Activity/transcript-root
      // consumers, so there is nothing to move or share; the standalone app stops linking it.
      styleFiles: [
        "codicon.css",
        "tokens.css", "faces.css", "design-system.css", "quick-picker.css",
        "highlight.css",
        "katex.min.css",
        "mermaid-block.css",
        "activity.css",
      ],
      title: (target) => vscode.l10n.t("Activity — {0}", target.identity ?? ""),
      bodyClass: () => {
        const theme = sharedGlobalSettings().current().activityCodeTheme;
        return theme === "dark" ? "tac-theme-dark" : theme === "light" ? "tac-theme-light" : undefined;
      },
      iconName: "pulse",
      // Activity's transcript header is intentionally sticky and theme-aware, so it extends the
      // shared PageChrome instead of pretending to be a default chrome consumer.
      extend: ["page-chrome"],
      csp: { imgBlob: true },
      bootstrapGlobals: (_target, uri) => ({
        __mermaidSrc: uri("mermaid.js"),
        __katexSrc: uri("katex.js"),
        __katexCssUri: uri("katex.min.css"),
        __codeThemeForced: sharedGlobalSettings().current().activityCodeTheme,
      }),
      refreshKindFor: (message) => (isReady(message) ? "activity" : undefined),
      bind: (session) => this.bind(session),
    };
  }

  private bind(session: SectionPanelSession<ActivityRefreshKind>) {
    const agent = session.target.identity!;
    const workspace = this.workspaceFor(session.target);
    let feed = emptyFeed();
    const binding: ActivityPanelBinding = { session, agent, feed, knownPaths: new Set(), alive: true };
    feed = workspace
      ? startActivityFeed(workspace, agent, {
        isCurrent: () => binding.alive,
        paused: () => !session.visible,
        post: (vm, prepended) => {
          if (!binding?.alive) return;
          const shareVm = withActivityShareKeys(agent, vm);
          binding.latest = shareVm;
          binding.transcriptPath = shareVm.sourcePath;
          binding.knownPaths = new Set([...shareVm.summary.filesChanged, ...shareVm.summary.filesReferenced]);
          session.post(activityMessage(session.target.project!, agent, shareVm, prepended));
        },
        postImage: (id, dataUri) => {
          if (binding?.alive) session.post(imageDataMessage(session.target.project!, agent, id, dataUri));
        },
      })
      : emptyFeed();
    binding.feed = feed;
    this.bindings.set(session.key, binding);

    return {
      replay: () => { feed.catchUp(); },
      resync: () => { feed.catchUp(); },
      onReveal: () => { feed.catchUp(); },
      onMessage: (raw: unknown) => { void this.handleAction(binding, raw as Partial<ActivityWebviewMessage>); },
      dispose: () => {
        binding.alive = false;
        feed.stop();
        this.bindings.delete(session.key);
      },
    };
  }

  private resolveShare(binding: ActivityPanelBinding, sequence: unknown, key: unknown) {
    const resolved = resolveActivityShare(binding.agent, binding.latest, sequence, key);
    if (!resolved.ok) {
      notify("That Activity item is no longer available. Refresh the Activity view and try again.", "warn");
      return undefined;
    }
    return resolved.payload;
  }

  private async handleAction(binding: ActivityPanelBinding, message: Partial<ActivityWebviewMessage>): Promise<void> {
    const { session, agent, feed } = binding;
    if (!message?.type || !binding.alive) return;
    if (message.type === "openFile" && typeof message.path === "string" && binding.knownPaths.has(message.path)) {
      void vscode.window.showTextDocument(vscode.Uri.file(message.path), { preview: true, viewColumn: vscode.ViewColumn.Beside });
      return;
    }
    if (message.type === "terminal") {
      void vscode.commands.executeCommand("tachyon.openAgentTerminalItem", agent, session.target.project);
      return;
    }
    if (message.type === "loadOlder") { feed.loadOlder(); return; }
    if (message.type === COPY_SHARE_TEXT) {
      const payload = this.resolveShare(binding, message.sequence, message.key);
      if (payload) { await vscode.env.clipboard.writeText(payload.text); notify("Activity share text copied."); }
      return;
    }
    if (message.type === SHARE_EXTERNAL) {
      const channel = message.channel === "email" || message.channel === "whatsapp" ? message.channel : undefined;
      if (!channel) { notify("Share channel missing — pick Email or WhatsApp in the Activity picker.", "warn"); return; }
      await this.shareExternal(binding, message.sequence, message.key, channel);
      return;
    }
    if (message.type === SHARE_TO_AGENT) {
      if (typeof message.toAgent === "string" && message.toAgent) {
        await this.shareToAgent(binding, message.sequence, message.key, message.toAgent);
      } else {
        await this.prepareShareTargets(binding, message.sequence, message.key);
      }
    }
  }

  private async targets(binding: ActivityPanelBinding) {
    const workspace = this.workspaceFor(binding.session.target);
    if (!workspace) return [];
    const context = await workspace.activityContext(binding.agent);
    return context.targets.items.map((target) => ({
      name: target.name,
      description: target.lifetime === "saved" ? "Saved Agent" : "Temporary Agent",
    }));
  }

  private async prepareShareTargets(binding: ActivityPanelBinding, sequence: unknown, key: unknown): Promise<void> {
    if (typeof sequence !== "number" || typeof key !== "string" || !key || !this.resolveShare(binding, sequence, key)) return;
    const targets = await this.targets(binding);
    if (!binding.alive) return;
    if (!targets.length) { notify("No other running Tachyon agent is available for this Activity share."); return; }
    binding.session.post(shareAgentTargetsMessage(sequence, key, targets));
  }

  private async shareExternal(
    binding: ActivityPanelBinding,
    sequence: unknown,
    key: unknown,
    channel: ExternalShareChannel,
  ): Promise<void> {
    const payload = this.resolveShare(binding, sequence, key);
    if (!payload) return;
    const label = channel === "email" ? "Email" : "WhatsApp";
    const preview = payload.text.length > 1400 ? `${payload.text.slice(0, 1400).trimEnd()}\n\n[preview truncated]` : payload.text;
    const ok = await showNotification(`Share this Activity item via ${label}?`, "info", ["Open"], { modal: true, detail: preview });
    if (ok !== "Open" || !binding.alive) return;
    const uri = channel === "email"
      ? `mailto:?subject=${encodeURIComponent(`Tachyon Activity from ${binding.agent}`)}&body=${encodeURIComponent(payload.urlText)}`
      : `https://wa.me/?text=${encodeURIComponent(payload.urlText)}`;
    await vscode.env.openExternal(vscode.Uri.parse(uri));
  }

  private async shareToAgent(binding: ActivityPanelBinding, sequence: unknown, key: unknown, toAgent: string): Promise<void> {
    const payload = this.resolveShare(binding, sequence, key);
    const workspace = this.workspaceFor(binding.session.target);
    if (!payload || !workspace) return;
    if (!(await this.targets(binding)).some((target) => target.name === toAgent)) {
      notify(`Agent '${toAgent}' is no longer available.`, "warn");
      return;
    }
    const prompt = internalSharePrompt(payload);
    const preview = prompt.length > 1400 ? `${prompt.slice(0, 1400).trimEnd()}\n\n[preview truncated]` : prompt;
    const ok = await showNotification(`Paste Activity context into '${toAgent}'?`, "info", ["Paste"], { modal: true, detail: preview });
    if (ok !== "Paste" || !binding.alive) return;
    await workspace.sendAgentInput(toAgent, prompt, false);
    notify(`Activity context pasted into '${toAgent}' (not submitted).`);
  }
}

function migrateLegacy(state: SectionPanelState | ActivityPanelState): SectionPanelState {
  if (!("wsHash" in state)) return state;
  return { schemaVersion: 1, view: ACTIVITY_VIEW_TYPE, project: state.wsHash, identity: state.agent };
}

function isReady(message: unknown): boolean {
  return !!message && typeof message === "object" && (message as { type?: unknown }).type === READY;
}

function emptyFeed(): ActivityFeed {
  return { stop() {}, loadOlder() {}, replayImages() {}, catchUp() {} };
}

export { ACTIVITY, IMAGE_DATA };
