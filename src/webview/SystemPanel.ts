import * as vscode from "vscode";
import {
  buildSectionsModel,
  collectNeedsFor,
  formatSectionsDiagnostics,
  type WorkspaceBundle,
} from "../sections/model.js";
import { cockpitStrings } from "./controlStrings.js";
import {
  SectionPanelManager,
  type SectionAppConfig,
  type SectionPanelSession,
  type SectionPanelState,
} from "./shared/SectionPanelManager.js";
import type { ControlWorkspaceScope } from "./shared/ControlWorkspaceScope.js";
import { webviewApp, type WebviewAppEntry } from "./webviewApps.js";
import { POLL, READY, systemErrorMessage, systemModelMessage } from "./system/messages.js";

/**
 * SDD 500 D2 — a NEW viewType, and both ids it replaces are RETIRED rather than reused.
 *
 * `tachyonOverview` and `tachyonEngine` each named half of this screen. Reusing either would leave a
 * name in the manifest that lies about what it opens, and would hand a human back a tab whose title and
 * icon no longer match its content. A new id orphans both old tabs, which is the honest outcome: the
 * surface each of them showed does not exist any more. Both stay registered in `extension.ts`'s
 * dispose-only serializer loop, so a tab left open across a reload is disposed rather than handed to
 * nobody — the same answer `tachyonFleet` got when its app was deleted (t-5f2b5b).
 */
export const SYSTEM_VIEW_TYPE = "tachyonSystem";

type SystemRefreshKind = "system";

export interface SystemDeps {
  collect: (needs?: ReturnType<typeof collectNeedsFor>) => Promise<WorkspaceBundle[]>;
  openDoctor(): void;
  /** the "waiting on you" counter's shortcut into the Inbox — the only `openSection` caller left. */
  openSection(section: string, project: string): void;
  clearEngineLog(wsHash: string): Promise<void>;
  openEngineJournal(wsHash: string): void;
}

/**
 * System is a `dashboard`: one panel per project, exactly as both halves were. `buildSectionsModel`
 * validates and filters the bundles by the panel's immutable project before producing
 * `m.control.workspaces`, so that plural is the old aggregate model's shape and never a cross-project
 * data source — which is also why this screen draws one card and needs no collapse rule.
 */
export class SystemPanelManager {
  private readonly manager: SectionPanelManager<SystemRefreshKind>;

  constructor(
    extensionUri: vscode.Uri,
    private readonly deps: SystemDeps,
    app: WebviewAppEntry = webviewApp("system"),
    scope?: ControlWorkspaceScope,
  ) {
    this.manager = new SectionPanelManager(extensionUri, this.configFor(app), scope);
  }

  open(project: string) {
    this.manager.open({ project });
  }

  openInCurrentScope() {
    return this.manager.openInCurrentScope();
  }

  refresh() {
    return this.manager.refresh("system");
  }

  get openKeys(): string[] {
    return this.manager.openKeys;
  }

  deserialize(panel: vscode.WebviewPanel, state: SectionPanelState) {
    this.manager.deserialize(panel, state);
  }

  dispose() {
    this.manager.dispose();
  }

  private configFor(app: WebviewAppEntry): SectionAppConfig<SystemRefreshKind> {
    return {
      app,
      // `engine-workspace.css` holds the workspace/log contract this screen inherited from Engine and
      // is LINKED rather than copied (Control's Worktrees app links it too); `system.css` is the
      // summary strip above it, which is all Overview's sheet turned out to be.
      styleFiles: ["codicon.css", "design-system.css", "engine-workspace.css", "system.css"],
      title: () => vscode.l10n.t("System"),
      // One strings table, not two. Engine used to hand-build its own inline copy of fields
      // `cockpitStrings()` already declared; that was a second declaration of one fact and it is gone
      // with the merge.
      bootstrapGlobals: () => ({ __TACHYON_STRINGS__: cockpitStrings() }),
      refreshKindFor: systemRefreshKind,
      bind: (session) => {
        const send = () => void this.send(session);
        return { replay: send, resync: send, onMessage: (raw) => void this.action(session, raw) };
      },
    };
  }

  private async send(session: SectionPanelSession<SystemRefreshKind>) {
    try {
      const bundles = await this.deps.collect(collectNeedsFor("system"));
      session.post(
        systemModelMessage(
          buildSectionsModel(bundles, { section: "system", wsHash: session.target.project }),
        ),
      );
    } catch (e) {
      session.post(systemErrorMessage(e instanceof Error ? e.message : String(e)));
    }
  }

  private async action(session: SectionPanelSession<SystemRefreshKind>, raw: unknown) {
    const m = raw as Record<string, unknown>;
    const project = session.target.project;
    if (!project) throw new Error("System dashboard has no project");
    if (m.type === "openDoctor") this.deps.openDoctor();
    else if (m.type === "openSection" && typeof m.section === "string") this.deps.openSection(m.section, project);
    else if (m.type === "copyText" && typeof m.text === "string") await vscode.env.clipboard.writeText(m.text);
    else if (m.type === "engineLogJournal" && typeof m.wsHash === "string") this.deps.openEngineJournal(m.wsHash);
    else if (m.type === "engineLogClear" && typeof m.wsHash === "string") {
      await this.deps.clearEngineLog(m.wsHash);
      await this.send(session);
    } else if (m.type === "copyDiagnostics") {
      // Deliberately the UNSCOPED collect, as Overview's was: a diagnostics dump is explicitly a full
      // picture of the world, and `formatSectionsDiagnostics` is the one surviving reader of
      // `model.overview` outside this app.
      const bundles = await this.deps.collect();
      await vscode.env.clipboard.writeText(
        formatSectionsDiagnostics(buildSectionsModel(bundles, { section: "system", wsHash: project })),
      );
    }
  }
}

export function systemRefreshKind(message: unknown): SystemRefreshKind | undefined {
  if (!message || typeof message !== "object") return undefined;
  const type = (message as { type?: unknown }).type;
  return type === READY || type === POLL ? "system" : undefined;
}
