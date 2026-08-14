import * as vscode from "vscode";
import { SectionPanelManager, type SectionAppConfig, type SectionPanelState, type SectionPanelTarget } from "./shared/SectionPanelManager.js";
import { webviewApp, type WebviewAppEntry } from "./webviewApps.js";
import {
  sectionFixtureModelMessage,
  sectionFixtureRefreshKind,
  type SectionFixtureModel,
} from "./section-app-fixture/protocol.js";

export const SECTION_APP_FIXTURE_VIEW_TYPE = "tachyonSectionAppFixture";

/** the one refresh kind this app knows: "the model you are showing is stale". */
type SectionFixtureRefreshKind = "model";

/**
 * SDD 485 C1–C3 — the section-app proof host: the smallest complete wiring of `SectionPanelManager`, and the
 * template C4 (task detail, a document) and C5 (the Board, a dashboard) are meant to copy.
 *
 * Dev-only, exactly like spec 350's two studio fakes: `extension.ts` never instantiates this manager and no
 * command contributes it, so nothing here reaches a user. Being dev-only buys it NO exemption from the Phase
 * A conformance contract — it is a `conform` row in `WEBVIEW_SURFACES` with its own CSS held to the same
 * scan as every shipped surface, which is the precedent Phase A set with those same two fakes.
 *
 * What this file has to say is small, and that is the point of the phase: a manifest row, a title, a
 * stylesheet list, and a `bind` that answers three questions — how to replay one invalidation, how to
 * rebuild, and what an inbound message means. Everything else (the key, the cardinality rule, the shell, the
 * gate, the persisted state, reveal-on-reopen, revive) belongs to the manager and is not restated per app.
 * Twelve of these would have been twelve copies of the parts that are missing here.
 */
export class SectionAppFixturePanelManager {
  private readonly manager: SectionPanelManager<SectionFixtureRefreshKind>;
  /** per-panel push counters — the observable a test can COUNT instead of timing. */
  private readonly revisions = new Map<string, number>();

  constructor(extensionUri: vscode.Uri, app: WebviewAppEntry = webviewApp("section-app-fixture")) {
    this.manager = new SectionPanelManager<SectionFixtureRefreshKind>(extensionUri, this.configFor(app));
  }

  /** Open (or reveal) the panel for one identity. */
  open(target: SectionPanelTarget): void {
    this.manager.open(target);
  }

  /** the fan-out door — how many panels did work. */
  refresh(): number {
    return this.manager.refresh("model");
  }

  markSourceResync(): void {
    this.manager.markSourceResync();
  }

  deserialize(panel: vscode.WebviewPanel, state: SectionPanelState): void {
    this.manager.deserialize(panel, state);
  }

  get openKeys(): string[] {
    return this.manager.openKeys;
  }

  /** how many models this panel has been posted — 0 for a panel that has never been looked at. */
  revisionOf(key: string): number {
    return this.revisions.get(key) ?? 0;
  }

  dispose(): void {
    this.manager.dispose();
  }

  private configFor(app: WebviewAppEntry): SectionAppConfig<SectionFixtureRefreshKind> {
    const cardinality = app.host === "section" ? app.cardinality : "dashboard";
    return {
      app,
      styleFiles: ["codicon.css", "tokens.css", "faces.css", "design-system.css", "quick-picker.css", "section-app-fixture.css"],
      title: (target) => (target.identity ? `Section app · ${target.identity}` : "Section app"),
      refreshKindFor: sectionFixtureRefreshKind,
      bind: (session) => {
        const push = (lastPush: SectionFixtureModel["lastPush"]): void => {
          const revision = (this.revisions.get(session.key) ?? 0) + 1;
          // Count the push only if it REACHED the webview. A hidden panel's post is dropped by the
          // session and arms a resync on reveal, so a counter incremented regardless would report work
          // that never happened — which is the exact self-deception Phase B's measurements avoided.
          if (!session.post(sectionFixtureModelMessage({
            app: app.view,
            cardinality,
            key: session.key,
            project: session.target.project ?? "",
            identity: session.target.identity ?? "",
            revision,
            lastPush,
          }))) return;
          this.revisions.set(session.key, revision);
        };
        return {
          replay: () => push("replay"),
          resync: () => push("resync"),
          dispose: () => { this.revisions.delete(session.key); },
        };
      },
    };
  }
}
