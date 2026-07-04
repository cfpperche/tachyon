import * as vscode from "vscode";
import { renderWebviewShell } from "../shell.js";
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
  post: (message: unknown) => void;
}

export interface StudioSurfaceConfig {
  viewType: string;
  /** filename under dist/webview, e.g. "pipeline-studio.js". */
  bundleFile: string;
  /** stylesheet filenames under dist/webview, IN ORDER (codicon → design-system → … → surface css). */
  styleFiles: string[];
}

interface PanelEntry<TEntity, TPatch> {
  panel: vscode.WebviewPanel;
  wsKey: string;
  mode: "new" | "edit";
  entityId: string | undefined;
  entity: TEntity | undefined;
  patch: TPatch | undefined;
  dirty: boolean;
  saveInFlight: boolean;
  loadFailed: boolean;
}

export class StudioPanelManagerBase<TEntity, TFields, TPatch> {
  private readonly panels = new Map<string, PanelEntry<TEntity, TPatch>>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly surface: StudioSurfaceConfig,
    private readonly adapter: StudioHostAdapter<TEntity, TFields, TPatch>,
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

  private open(wsKey: string, mode: "new" | "edit", entityId: string | undefined, restoreSnapshot?: StudioRestoreSnapshot<string, TPatch> | null): void {
    const key = this.key(wsKey, entityId);
    const existing = this.panels.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const title = this.adapter.titleFor(mode, entityId, undefined);
    const panel = vscode.window.createWebviewPanel(
      this.surface.viewType,
      title,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, localResourceRoots: [root], retainContextWhenHidden: true },
    );
    const uri = (f: string): string => panel.webview.asWebviewUri(vscode.Uri.joinPath(root, f)).toString();
    panel.webview.html = renderWebviewShell({
      cspSource: panel.webview.cspSource,
      title,
      styles: this.surface.styleFiles.map(uri),
      bundle: uri(this.surface.bundleFile),
      mode: "live",
    });

    const entry: PanelEntry<TEntity, TPatch> = {
      panel,
      wsKey,
      mode,
      entityId,
      entity: undefined,
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

  private async handleMessage(entry: PanelEntry<TEntity, TPatch>, raw: unknown): Promise<void> {
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
        await this.save(entry);
        return;
      case "cancel":
        entry.panel.dispose();
        return;
      default:
        this.onDomainMessage?.(
          { wsKey: entry.wsKey, entityId: entry.entityId, post: (m) => void entry.panel.webview.postMessage(m) },
          msg,
        );
        return;
    }
  }

  private async loadAndPost(entry: PanelEntry<TEntity, TPatch>, restoreSnapshot: StudioRestoreSnapshot<string, TPatch> | null): Promise<void> {
    const result = await this.adapter.load(entry.entityId);
    if (result.status !== "ok") {
      entry.loadFailed = true;
      const message = result.status === "not-found" ? "not found" : result.error;
      this.postError(entry, mapUnknownError("persistence", new Error(message), `persistence/${result.status}`));
      if (restoreSnapshot !== null) this.postRestore(entry, restoreSnapshot, true);
      return;
    }
    entry.loadFailed = false;
    entry.entity = result.entity;
    const concurrency = this.concurrencyStateFor(result.entity);
    entry.panel.title = this.adapter.titleFor(entry.mode, entry.entityId, result.entity);
    void entry.panel.webview.postMessage(envelope({ type: "load", entity: result.entity, concurrency, saveInFlight: entry.saveInFlight }));
    if (restoreSnapshot !== null) this.postRestore(entry, restoreSnapshot, false);
  }

  private postRestore(entry: PanelEntry<TEntity, TPatch>, snapshot: StudioRestoreSnapshot<string, TPatch> | null, currentLoadFailed: boolean): void {
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

  private async save(entry: PanelEntry<TEntity, TPatch>): Promise<void> {
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

  private postError(entry: PanelEntry<TEntity, TPatch>, error: StudioError): void {
    void entry.panel.webview.postMessage(envelope({ type: "error", code: error.code, message: error.message, blocking: error.blocking }));
  }
}

/** re-exported for callers that only need to stamp the protocol version onto a bespoke ad-hoc test message. */
export { STUDIO_PROTOCOL_VERSION };
