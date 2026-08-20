import * as vscode from "vscode";
import { redactSecrets } from "@tachyon/engine/utils/redactSecrets.js";
import type { DoctorResult } from "@tachyon/engine/tmux/TmuxService.js";
import { buildEnvironmentCheck, type NodeCheckResult } from "@tachyon/engine/onboarding/environmentCheck.js";
import { SectionPanelManager, type SectionAppConfig, type SectionPanelSession, type SectionPanelState } from "./shared/SectionPanelManager.js";
import { webviewApp, type WebviewAppEntry } from "./webviewApps.js";
import { errorMessage, isOnboardingModel, modelMessage, READY, type OnboardingAction, type OnboardingModel } from "@tachyon/webview-ui/webview/onboarding/messages";

export const ONBOARDING_VIEW_TYPE = "tachyonOnboarding";
type RefreshKind = "onboarding";

/**
 * t-505f13 — the Onboarding host. Every fact the screen shows is injected here as a dep, so the
 * panel is a thin composer: it runs the probes, projects them through the engine's pure
 * `buildEnvironmentCheck`, and forwards the app's five actions to the doors that already exist —
 * bootstrap is `tachyon.init` itself, not a second implementation of it.
 *
 * CARDINALITY: `window`. The app must open when NO Tachyon workspace is attached (that is its whole
 * reason to exist), so it cannot key on a project the way keys/plugins dashboards do. Its subject
 * is this machine's environment plus this window's open folders — one panel, no project, no identity.
 */
export interface OnboardingDeps {
  folders(): Array<{ name: string; root: string }>;
  hasConfig(root: string): boolean;
  /** Roots with a booted Tachyon workspace in this window. */
  attachedRoots(): Set<string>;
  /** The attached workspace's credential inventory, or resolves undefined when none is attached. */
  secretInventory?(): Promise<
    | {
        stored: Array<{ provider: string; id: string }>;
        required: Array<{ agent: string; name: string; provider: string; id: string; purpose: string; present: boolean }>;
      }
    | undefined
  >;
  /** Agent entries of the attached workspace, or undefined when none is attached. */
  agentCount(): number | undefined;
  checkTmux(): Promise<DoctorResult>;
  detectClis(): Promise<string[]>;
  checkNode(): Promise<NodeCheckResult>;
  initialize(): Promise<void>;
  openConfig(): void;
  /**
   * Open the agent-creation surface. Named for the DOOR (`tachyon.newAgentStudio`), not the retired
   * five-tab AgentForm opener that `studioCutoverRouting.test.ts` keeps out of extension.ts — the
   * dep's name must not collide with that retired symbol or the guard fires on a text scan.
   */
  openNewAgentStudio(): void;
  openKeys(): void;
}

export class OnboardingPanelManager {
  private readonly manager: SectionPanelManager<RefreshKind>;
  constructor(extensionUri: vscode.Uri, private readonly deps: OnboardingDeps, app: WebviewAppEntry = webviewApp("onboarding")) {
    this.manager = new SectionPanelManager(extensionUri, this.configFor(app));
  }
  /** Open the Onboarding tab, or REVEAL the one already open. There is only ever one. */
  open(): void { this.manager.open({}); }
  refresh(): void { this.manager.refresh("onboarding"); }
  deserialize(panel: vscode.WebviewPanel, state: SectionPanelState): void { this.manager.deserialize(panel, state); }
  dispose(): void { this.manager.dispose(); }
  private configFor(app: WebviewAppEntry): SectionAppConfig<RefreshKind> {
    return {
      app,
      styleFiles: ["codicon.css", "tokens.css", "faces.css", "design-system.css", "quick-picker.css", "onboarding.css"],
      title: () => vscode.l10n.t("Onboarding"),
      // No launcher tile opens this app (the sidebar's Set-up button and the palette do), so the tab
      // icon is declared here — the one shape `sectionAppIconName` allows for a tile-less app.
      iconName: "checklist",
      refreshKindFor: (message) => message && typeof message === "object" && (message as { type?: unknown }).type === READY ? "onboarding" : undefined,
      bind: (session) => ({ replay: () => void this.send(session), resync: () => void this.send(session), onMessage: (raw) => void this.action(session, raw) }),
    };
  }
  private async send(session: SectionPanelSession<RefreshKind>): Promise<void> {
    try {
      // Every probe on every send: this screen's "Re-check" IS a re-probe, and a reveal re-running
      // the checks answers "did you install it yet?" without a second button.
      const [tmux, node, clis] = await Promise.all([this.deps.checkTmux(), this.deps.checkNode(), this.deps.detectClis()]);
      const inventory = await this.deps.secretInventory?.();
      const credentials = inventory
        ? {
            storedCount: inventory.stored.length,
            missing: inventory.required
              .filter((r) => !r.present)
              .map(({ agent, name, provider, id }) => ({ agent, name, provider, id })),
          }
        : undefined;
      const environment = buildEnvironmentCheck({ tmux, node, clis, credentials });
      const attached = this.deps.attachedRoots();
      const folders = this.deps.folders().map((f) => ({ name: f.name, root: f.root, configured: this.deps.hasConfig(f.root), attached: attached.has(f.root) }));
      const agentCount = this.deps.agentCount();
      const model: OnboardingModel = {
        folders,
        environment: { items: environment.items, ready: environment.ready, checkedAt: new Date().toISOString() },
        ...(agentCount !== undefined ? { agentCount } : {}),
      };
      if (!isOnboardingModel(model)) {
        session.post(errorMessage("The onboarding projection did not match the safe schema."));
        return;
      }
      session.post(modelMessage(model));
    } catch (error) { session.post(errorMessage(safeError(error))); }
  }
  private async action(session: SectionPanelSession<RefreshKind>, raw: unknown): Promise<void> {
    const action = raw as Partial<OnboardingAction>;
    if (typeof action.type !== "string") return;
    try {
      if (action.type === "recheck") return await this.send(session);
      // The SAME door the palette offers: bootstrap is `tachyon.init`, never a copy of it. The
      // model refresh that follows is what turns the screen's step 2 to done.
      if (action.type === "initialize") { await this.deps.initialize(); return await this.send(session); }
      if (action.type === "openConfig") return this.deps.openConfig();
      if (action.type === "openAgentStudio") return this.deps.openNewAgentStudio();
      if (action.type === "openKeys") return this.deps.openKeys();
      // t-505f13 round 4 — the finished screen's exit. ALWAYS the user's click: nothing in this
      // panel ever closes itself, so the tab cannot vanish under someone who is still reading.
      if (action.type === "close") return this.manager.close(session.target);
    } catch (error) { session.post(errorMessage(safeError(error))); }
  }
}
function safeError(error: unknown): string { return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2000); }
