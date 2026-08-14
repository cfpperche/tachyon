import type * as vscode from "vscode";
import {
  SectionPanelManager,
  type SectionAppConfig,
  type SectionPanelState,
  type SectionPanelTarget,
} from "../SectionPanelManager.js";
import type { WebviewAppEntry } from "../../webviewApps.js";
import type { ControlWorkspaceScope } from "../ControlWorkspaceScope.js";
import type { WorkspaceStudioTarget } from "../../../shell/WorkspacePresentation.js";
import type { StudioHostAdapter } from "@tachyon/engine/webview/shared/studio/adapter.js";
import type { StudioPanelState } from "./StudioPanelManagerBase.js";
import { decodeStudioMessage, envelope } from "@tachyon/webview-ui/webview/shared/studio/protocol";
import { mapUnknownError } from "./errorTaxonomy";
import { acceptsWhileVanished, isTombstone } from "@tachyon/webview-ui/webview/shared/studio/tombstone";
import { READY } from "@tachyon/webview-ui/webview/shared/ready";
import {
  SingleModeStudioEditPolicy,
  type SingleModeStudioDraft,
} from "./singleModeEditPolicy.js";

type Adapter = StudioHostAdapter<unknown, unknown, unknown, unknown>;
type RefreshKind = "entity" | "referenceData";

export interface SingleModeStudioConfig {
  app: WebviewAppEntry;
  styleFiles: readonly string[];
  iconName: string;
  getWorkspaces: () => WorkspaceStudioTarget[];
  makeAdapter: (workspace: WorkspaceStudioTarget) => Adapter;
  onChanged: () => void;
  handleDomainMessage?: (
    workspace: WorkspaceStudioTarget,
    context: { entityId: string | undefined; post(message: unknown): void },
    message: { type: string },
  ) => void;
}

/** D13's ONE-mode studio host. `identity` is the saved id, or the explicit provisional key `new`. */
export class SingleModeStudioPanelManager {
  private readonly manager: SectionPanelManager<RefreshKind>;
  private readonly drafts = new Map<string, SingleModeStudioDraft<unknown>>();

  constructor(
    extensionUri: vscode.Uri,
    private readonly config: SingleModeStudioConfig,
    scope?: ControlWorkspaceScope,
  ) {
    this.manager = new SectionPanelManager(
      extensionUri,
      this.sectionConfig(),
      scope,
    );
  }

  openNew(project: string): void {
    this.manager.open({ project, identity: "new" });
  }
  openExisting(project: string, entityId: string): void {
    this.manager.open({ project, identity: entityId });
  }
  deserialize(
    panel: vscode.WebviewPanel,
    state: SectionPanelState | StudioPanelState<unknown>,
  ): void {
    const legacy = state as Partial<StudioPanelState<unknown>>;
    if (typeof (state as Partial<SectionPanelState>).project === "string")
      this.manager.deserialize(panel, state as SectionPanelState);
    else
      this.manager.deserialize(panel, {
        schemaVersion: 1,
        view: this.config.app.viewId,
        project: legacy.wsKey,
        identity: legacy.snapshot?.entityId ?? "new",
      });
  }
  refresh(): number {
    return this.manager.refresh("entity");
  }
  refreshReferenceData(): number {
    return this.manager.refresh("referenceData");
  }
  get openKeys(): string[] {
    return this.manager.openKeys;
  }
  dispose(): void {
    this.manager.dispose();
  }

  private sectionConfig(): SectionAppConfig<RefreshKind> {
    const workspaceFor = (target: SectionPanelTarget) =>
      this.config.getWorkspaces().find((row) => row.wsHash === target.project);
    return {
      app: this.config.app,
      styleFiles: this.config.styleFiles,
      iconName: this.config.iconName,
      title: (target) => {
        const workspace = workspaceFor(target);
        const entityId = target.identity === "new" ? undefined : target.identity;
        return workspace
          ? this.config.makeAdapter(workspace).titleFor(entityId === undefined ? "new" : "edit", entityId, undefined)
          : `${this.config.app.view.replace(/-studio-shell$/, "")} — ${target.identity ?? ""}`;
      },
      refreshKindFor: (raw) =>
        (raw as { type?: unknown } | undefined)?.type === READY
          ? "entity"
          : undefined,
      bind: (session) => {
        const project = session.target.project ?? "";
        const identity = session.target.identity ?? "";
        const entityId = identity === "new" ? undefined : identity;
        const workspace = workspaceFor(session.target);
        const adapter = workspace
          ? this.config.makeAdapter(workspace)
          : undefined;
        const policy = new SingleModeStudioEditPolicy<unknown>(
          "edit",
          this.drafts.get(session.key),
        );
        let entity: unknown;
        let referenceData: unknown;
        let saveInFlight = false;
        /**
         * t-b643ac — the last title a SUCCESSFUL load produced, and whether this panel's entity has
         * since been proven gone. `lastGoodTitle` is how much of spec 335's "render the last known
         * good projection" the shared layer can honestly carry (see StudioTombstone.tsx); it stays
         * `undefined` for a panel revived onto an entity that was already removed, which is exactly
         * `emptyTombstoneVm`'s "no last-known state at all" case.
         *
         * `discardedDraft` is remembered rather than recomputed because a remounted webview replays
         * `ready`, and the second telling must not claim the human's work was still there to lose.
         */
        let lastGoodTitle: string | undefined;
        let vanished = false;
        let discardedDraft = false;

        const postError = (error: unknown) => {
          const mapped = mapUnknownError("transport", error);
          session.post(
            envelope({
              type: "error",
              code: mapped.code,
              message: mapped.message,
              source: mapped.source,
              blocking: mapped.blocking,
            }),
          );
        };
        /**
         * t-b643ac — the entity is gone. This is a DOCUMENT STATE, so it is posted as `tombstone`,
         * not as an `error`: an error leaves the client believing the document still has a subject
         * and its form still mounted from the previous load, which is the reported defect.
         *
         * Three things happen here, and the order matters. The draft is severed from the identity
         * (decision 3 — `entityVanished` latches, so a `patch` already in flight cannot re-dirty it)
         * AND evicted from the manager's retained-draft map, because that map is keyed by identity
         * and a later entity created under the same name would otherwise inherit a dead one's edits.
         * Then `vanished` latches, which is what makes Save impossible at the host (decision 4).
         */
        const postTombstone = () => {
          if (!adapter) return;
          if (!vanished) {
            discardedDraft = policy.entityVanished();
            this.drafts.delete(session.key);
            vanished = true;
          }
          session.post(
            envelope({
              type: "tombstone",
              entityType: adapter.entityType,
              ...(entityId !== undefined ? { entityId } : {}),
              ...(lastGoodTitle !== undefined ? { title: lastGoodTitle } : {}),
              discardedDraft,
            }),
          );
        };
        const load = async (referenceOnly = false) => {
          if (!adapter) {
            postError(new Error(`workspace ${project} is not attached`));
            return;
          }
          const result = await adapter.load(entityId, {
            asWebviewUri: (path) => session.asWebviewUri(path),
          });
          if (isTombstone({ status: result.status, entityId })) {
            postTombstone();
            return;
          }
          if (result.status !== "ok") {
            postError(
              new Error(
                result.status === "not-found" ? "not found" : result.error,
              ),
            );
            return;
          }
          entity = result.entity;
          referenceData = result.referenceData;
          if (referenceOnly) {
            session.post(
              envelope({
                type: "referenceData",
                ...(referenceData !== undefined ? { referenceData } : {}),
              }),
            );
            return;
          }
          const concurrency =
            adapter.concurrency.kind === "cas"
              ? {
                  kind: "cas" as const,
                  expected: adapter.revisionOf?.(result.entity) ?? "",
                }
              : { kind: "none" as const };
          lastGoodTitle = adapter.titleFor(
            entityId === undefined ? "new" : "edit",
            entityId,
            result.entity,
          );
          session.setTitle(lastGoodTitle);
          session.post(
            envelope({
              type: "load",
              entity,
              ...(referenceData !== undefined ? { referenceData } : {}),
              concurrency,
              saveInFlight,
            }),
          );
          if (policy.draft.dirty && policy.draft.patch !== undefined) {
            session.post(
              envelope({
                type: "restore",
                snapshot: {
                  schemaVersion: 1,
                  entityType: adapter.entityType,
                  mode: "edit",
                  patch: policy.draft.patch,
                },
              }),
            );
          }
        };
        const onMessage = async (raw: unknown) => {
          const decoded = decodeStudioMessage<{
            type: string;
            patch?: unknown;
            dirty?: boolean;
          }>(raw, adapter?.domainMessageNames ?? []);
          if (!decoded.ok || !decoded.message || !adapter || !workspace) return;
          const message = decoded.message;
          /**
           * t-b643ac, decision 4 — Save is IMPOSSIBLE on a vanished entity, not merely disabled.
           *
           * The client rendering `StudioTombstone` instead of `StudioFrame` removes the button from
           * the DOM; this removes the door. It has to be here as well as there, because the button is
           * not the only way a `save` arrives — a message posted before the tombstone landed, or any
           * adapter domain action (Forget/Rename/Export/Clone on an agent that is already gone), reaches
           * this handler with no button involved. `ready` and `cancel` stay open: a remounted webview
           * must be re-told it is a tombstone, and closing the tab is the only action left.
           */
          if (vanished && !acceptsWhileVanished(message.type)) return;
          if (message.type === "ready") {
            if (vanished) { postTombstone(); return; }
            await load();
            return;
          }
          if (message.type === "patch") {
            policy.receivePatch(message.patch);
            return;
          }
          if (message.type === "dirty") {
            policy.receiveDirty(message.dirty ?? false);
            return;
          }
          if (message.type === "cancel") {
            policy.clearDraft();
            await adapter.onCancel?.(entityId);
            session.close();
            return;
          }
          if (
            message.type === "save" &&
            policy.draft.patch !== undefined &&
            !saveInFlight
          ) {
            saveInFlight = true;
            session.post({ type: "studioSaveBegin" });
            try {
              const result = await adapter.save(entityId, policy.draft.patch);
              if (result.status === "ok") {
                policy.clearDraft();
                this.config.onChanged();
                session.post(envelope({ type: "save", status: "ok" }));
                session.close();
              } else postError(new Error(result.error.message));
            } catch (error) {
              postError(error);
            } finally {
              saveInFlight = false;
              session.post({ type: "studioSaveEnd" });
            }
            return;
          }
          this.config.handleDomainMessage?.(
            workspace,
            { entityId, post: (value) => session.post(value) },
            message,
          );
        };
        return {
          replay: (kind) => {
            void load(kind === "referenceData");
          },
          resync: () => {
            void load();
          },
          onMessage: (message) => {
            void onMessage(message);
          },
          dispose: () => {
            const draft = policy.close();
            if (draft) this.drafts.set(session.key, draft);
            else this.drafts.delete(session.key);
          },
        };
      },
    };
  }
}
