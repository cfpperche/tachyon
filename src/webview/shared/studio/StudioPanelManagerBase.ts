import * as vscode from "vscode";
import { renderWebviewShell } from "../shell.js";
import { panelIcon } from "../panelIcon.js";
import type { StudioHostAdapter } from "./adapter.js";
import { decodeStudioMessage, envelope, STUDIO_PROTOCOL_VERSION, type StudioConcurrencyState, type StudioRestoreSnapshot } from "./protocol.js";
import { mapUnknownError, type StudioError } from "./errorTaxonomy.js";
import { decideRestore } from "./restoreDecisions.js";

/**
 * spec 350 T2 — StudioPanelManagerBase: the ONE lifecycle every studio dialect triplicated (PinStudioPanelManager,
 * TaskStudioPanelManager, AgentForm's ad-hoc singleton) — new-entity singleton per workspace + one panel per
 * entity id, reveal-on-reopen, dispose, refreshAll — now generic over an adapter instead of hand-rolled per
 * studio. SINGLE-DOCUMENT only (2026-07-04 dismemberment amendment): no tab/navigation contract.
 *
 * Restore (dueto F7): the manager tracks the latest `patch`/`dirty` state per panel so `captureSnapshot` can
 * serialize panel identity + mode + entity id + (adapter-permitting) the unsaved patch; `restoreFromSnapshot`
 * re-opens a panel from that snapshot, applying `decideRestore`'s fail-closed-on-load-failure rule. Real
 * window-reload wiring (`vscode.window.registerWebviewPanelSerializer`) is a host-integration detail outside
 * this base; Phase 1 proves the decision + re-open mechanics via a SIMULATED reload (a fresh manager instance
 * fed a captured snapshot), per plan.md's accepted proof strategy.
 */

/** the narrow reply capability handed to `onDomainMessage` — never the raw vscode panel. */
export interface StudioDomainMessageContext {
  wsKey: string;
  entityId: string | undefined;
  asWebviewUri: (fsPath: string) => string;
  post: (message: unknown) => void;
}

export interface StudioSurfaceConfig {
  viewType: string;
  /** filename under dist/webview, e.g. "pipeline-studio.js". */
  bundleFile: string;
  /** stylesheet filenames under dist/webview, IN ORDER (codicon → design-system → … → surface css). */
  styleFiles: string[];
  /** spec 350 Amendment 2 — additive, opt-in passthrough to `renderWebviewShell` (shared/shell.ts) for a
   *  surface that embeds a library needing CSP beyond the shell's base (e.g. Excalidraw's own workers/
   *  network use). Absent for Phase 1's two fakes — declarative surface config, not a hook that bypasses
   *  header/dispatch/gating/save-cancel (adapter surface budget, README.md). */
  imgBlob?: boolean;
  connectSrc?: boolean;
  workerSrc?: "blob";
  childSrc?: "blob";
  /** Additional local roots for domain-owned media resolved through `StudioLoadContext.asWebviewUri`. */
  extraLocalResourceRoots?: (wsKey: string) => vscode.Uri[];
  /** Optional editor-tab icon, resolved via media/icons/{light,dark}/<name>.svg. */
  iconName?: string;
  /** nonce'd inline globals emitted before the bundle (`window.<k> = <JSON(v)>`) — a function because it
   *  needs the panel's own `asWebviewUri` helper (e.g. an asset root path), computed once per `open()`. */
  bootstrapGlobals?: (uri: (f: string) => string) => Record<string, unknown>;
}

export interface StudioPanelState<TPatch> {
  schemaVersion: 1;
  view: string;
  wsKey: string;
  snapshot: StudioRestoreSnapshot<string, TPatch>;
}

interface PanelEntry<TEntity, TPatch, TReferenceData> {
  panel: vscode.WebviewPanel;
  wsKey: string;
  mode: "new" | "edit";
  entityId: string | undefined;
  entity: TEntity | undefined;
  referenceData: TReferenceData | undefined;
  patch: TPatch | undefined;
  dirty: boolean;
  saveInFlight: boolean;
  loadFailed: boolean;
}

export class StudioPanelManagerBase<TEntity, TFields, TPatch, TReferenceData = unknown> {
  private readonly panels = new Map<string, PanelEntry<TEntity, TPatch, TReferenceData>>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly surface: StudioSurfaceConfig,
    private readonly adapter: StudioHostAdapter<TEntity, TFields, TPatch, TReferenceData>,
    /** best-effort fan-out hook (mirrors PinStudioPanelManager's `refreshAll` ctor arg) — called after a
     *  successful save/delete so sibling views (e.g. a board) can refresh. */
    private readonly onChanged: () => void = () => {},
    /** invoked for a decoded message whose type isn't one of the eight core names — the adapter's registered
     *  domain messages. Kept as a callback rather than forcing subclassing (adapter surface budget: this is
     *  the ONE declared domain-action extension point, never a bypass of dirty/save/error flow); `ctx.post`
     *  is the ONLY way it can talk back to the webview, deliberately narrower than the raw vscode panel. */
    private readonly onDomainMessage?: (ctx: StudioDomainMessageContext, message: { type: string }) => void,
  ) {}

  openNew(wsKey: string): void {
    this.open(wsKey, "new", undefined);
  }

  openExisting(wsKey: string, entityId: string): void {
    this.open(wsKey, "edit", entityId);
  }

  /** Captures a restorable snapshot for one panel — `undefined` if the key isn't open (nothing to capture). */
  captureSnapshot(wsKey: string, entityId?: string): StudioRestoreSnapshot<string, TPatch> | undefined {
    const entry = this.panels.get(this.key(wsKey, entityId));
    if (!entry) return undefined;
    const snapshot: StudioRestoreSnapshot<string, TPatch> = { schemaVersion: 1, entityType: this.adapter.entityType, mode: entry.mode };
    if (entry.entityId !== undefined) snapshot.entityId = entry.entityId;
    if (this.adapter.allowPatchRestore && entry.dirty && entry.patch !== undefined) snapshot.patch = entry.patch;
    return snapshot;
  }

  /** Re-opens a panel from a captured snapshot (a real reload's `registerWebviewPanelSerializer`, or the
   *  simulated reload a test drives directly) and posts the `restore` message once load settles. */
  restoreFromSnapshot(wsKey: string, snapshot: StudioRestoreSnapshot<string, TPatch>): void {
    this.open(wsKey, snapshot.mode, snapshot.entityId, snapshot);
  }

  deserializePanel(panel: vscode.WebviewPanel, state: StudioPanelState<TPatch>): void {
    if (state.view !== this.surface.viewType) { panel.dispose(); return; }
    this.open(state.wsKey, state.snapshot.mode, state.snapshot.entityId, state.snapshot, panel);
  }

  refreshAll(): void {
    for (const entry of this.panels.values()) void this.loadAndPost(entry, null);
  }

  dispose(): void {
    for (const { panel } of this.panels.values()) panel.dispose();
    this.panels.clear();
  }

  private key(wsKey: string, entityId: string | undefined): string {
    return `${this.adapter.entityType}:${wsKey}:${entityId ?? "new"}`;
  }

  private open(
    wsKey: string,
    mode: "new" | "edit",
    entityId: string | undefined,
    restoreSnapshot?: StudioRestoreSnapshot<string, TPatch> | null,
    revivedPanel?: vscode.WebviewPanel,
  ): void {
    const key = this.key(wsKey, entityId);
    const existing = this.panels.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const title = this.adapter.titleFor(mode, entityId, undefined);
    const localResourceRoots = [root, ...(this.surface.extraLocalResourceRoots?.(wsKey) ?? [])];
    const panel = revivedPanel ?? vscode.window.createWebviewPanel(
      this.surface.viewType,
      title,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, localResourceRoots, retainContextWhenHidden: true },
    );
    panel.title = title;
    panel.webview.options = { enableScripts: true, localResourceRoots };
    if (this.surface.iconName) panel.iconPath = panelIcon(this.extensionUri, this.surface.iconName);
    const uri = (f: string): string => panel.webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString();
    panel.webview.html = renderWebviewShell({
      cspSource: panel.webview.cspSource,
      title,
      styles: this.surface.styleFiles.map(uri),
      bundle: uri(this.surface.bundleFile),
      mode: "live",
      ...(this.surface.imgBlob ? { imgBlob: true } : {}),
      ...(this.surface.connectSrc ? { connectSrc: true } : {}),
      ...(this.surface.workerSrc ? { workerSrc: this.surface.workerSrc } : {}),
      ...(this.surface.childSrc ? { childSrc: this.surface.childSrc } : {}),
      ...(this.surface.bootstrapGlobals ? { bootstrapGlobals: this.surface.bootstrapGlobals(uri) } : {}),
      persistedState: {
        schemaVersion: 1,
        view: this.surface.viewType,
        wsKey,
        snapshot: {
          schemaVersion: 1,
          entityType: this.adapter.entityType,
          mode,
          ...(entityId !== undefined ? { entityId } : {}),
        },
      } satisfies StudioPanelState<TPatch>,
    });

    const entry: PanelEntry<TEntity, TPatch, TReferenceData> = {
      panel,
      wsKey,
      mode,
      entityId,
      entity: undefined,
      referenceData: undefined,
      patch: undefined,
      dirty: false,
      saveInFlight: false,
      loadFailed: false,
    };
    this.panels.set(key, entry);
    panel.webview.onDidReceiveMessage((raw: unknown) => void this.handleMessage(entry, raw));
    panel.onDidDispose(() => { this.panels.delete(key); });
    void this.loadAndPost(entry, restoreSnapshot ?? null);
  }

  private async handleMessage(entry: PanelEntry<TEntity, TPatch, TReferenceData>, raw: unknown): Promise<void> {
    const decoded = decodeStudioMessage<{ type: string; patch?: TPatch; dirty?: boolean }>(raw, this.adapter.domainMessageNames);
    if (!decoded.ok || !decoded.message) {
      this.postError(entry, mapUnknownError("transport", new Error(`studio protocol: ${decoded.reason ?? "undecodable message"}`)));
      return;
    }
    const msg = decoded.message;
    switch (msg.type) {
      case "ready":
        await this.loadAndPost(entry, null);
        return;
      case "patch":
        entry.patch = msg.patch;
        return;
      case "dirty":
        entry.dirty = msg.dirty ?? false;
        return;
      case "save":
        if (msg.patch !== undefined) entry.patch = msg.patch;
        await this.save(entry);
        return;
      case "cancel":
        await this.adapter.onCancel?.(entry.entityId);
        entry.panel.dispose();
        return;
      default:
        this.onDomainMessage?.(
          {
            wsKey: entry.wsKey,
            entityId: entry.entityId,
            asWebviewUri: (fsPath: string) => entry.panel.webview.asWebviewUri(vscode.Uri.file(fsPath)).toString(),
            post: (m) => void entry.panel.webview.postMessage(m),
          },
          msg,
        );
        return;
    }
  }

  private async loadAndPost(entry: PanelEntry<TEntity, TPatch, TReferenceData>, restoreSnapshot: StudioRestoreSnapshot<string, TPatch> | null): Promise<void> {
    const result = await this.adapter.load(entry.entityId, {
      asWebviewUri: (fsPath: string) => entry.panel.webview.asWebviewUri(vscode.Uri.file(fsPath)).toString(),
    });
    if (result.status !== "ok") {
      entry.loadFailed = true;
      const message = result.status === "not-found" ? "not found" : result.error;
      this.postError(entry, mapUnknownError("persistence", new Error(message), `persistence/${result.status}`));
      if (restoreSnapshot !== null) this.postRestore(entry, restoreSnapshot, true);
      return;
    }
    entry.loadFailed = false;
    entry.entity = result.entity;
    entry.referenceData = result.referenceData;
    const concurrency = this.concurrencyStateFor(result.entity);
    entry.panel.title = this.adapter.titleFor(entry.mode, entry.entityId, result.entity);
    void entry.panel.webview.postMessage(envelope({
      type: "load",
      entity: result.entity,
      ...(result.referenceData !== undefined ? { referenceData: result.referenceData } : {}),
      concurrency,
      saveInFlight: entry.saveInFlight,
    }));
    if (restoreSnapshot !== null) this.postRestore(entry, restoreSnapshot, false);
  }

  private postRestore(entry: PanelEntry<TEntity, TPatch, TReferenceData>, snapshot: StudioRestoreSnapshot<string, TPatch> | null, currentLoadFailed: boolean): void {
    const action = decideRestore({ allowPatchRestore: this.adapter.allowPatchRestore, snapshot, currentLoadFailed });
    const outgoing = action === "restore-patch" ? snapshot : action === "restore-clean" ? { ...snapshot!, patch: undefined } : null;
    if (outgoing?.patch !== undefined) {
      entry.patch = outgoing.patch;
      entry.dirty = true;
    }
    void entry.panel.webview.postMessage(envelope({ type: "restore", snapshot: outgoing }));
  }

  private concurrencyStateFor(entity: TEntity): StudioConcurrencyState {
    if (this.adapter.concurrency.kind === "none") return { kind: "none" };
    return { kind: "cas", expected: this.adapter.revisionOf?.(entity) ?? "" };
  }

  private async save(entry: PanelEntry<TEntity, TPatch, TReferenceData>): Promise<void> {
    if (entry.patch === undefined || entry.saveInFlight) return;
    entry.saveInFlight = true;
    try {
      const result = await this.adapter.save(entry.entityId, entry.patch);
      if (result.status === "ok") {
        entry.dirty = false;
        entry.patch = undefined;
        this.onChanged();
        entry.panel.dispose();
        return;
      }
      const error: StudioError =
        result.status === "conflict"
          ? { code: result.error.code, message: result.error.message, source: "transport", blocking: true }
          : { code: result.error.code, message: result.error.message, source: result.error.source, blocking: true };
      this.postError(entry, error);
    } catch (err) {
      this.postError(entry, mapUnknownError("transport", err));
    } finally {
      entry.saveInFlight = false;
    }
  }

  private postError(entry: PanelEntry<TEntity, TPatch, TReferenceData>, error: StudioError): void {
    void entry.panel.webview.postMessage(envelope({ type: "error", code: error.code, message: error.message, source: error.source, blocking: error.blocking }));
  }
}

/** re-exported for callers that only need to stamp the protocol version onto a bespoke ad-hoc test message. */
export { STUDIO_PROTOCOL_VERSION };
