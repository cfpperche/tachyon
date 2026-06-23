import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Workspace } from "../workspace/Workspace.js";
import {
  detectRuntimes,
  loadPluginFromSource,
  previewInstall,
  applyInstall,
  previewUpdate,
  applyUpdate,
  previewRemove,
  applyRemove,
  type LoadedPlugin,
  type InstallPreview,
  type InstallProvenance,
} from "../plugins/engine.js";
import { parseLockfile, LOCKFILE_REL_PATH, type PluginLock } from "../plugins/lockfile.js";
import { buildPluginsViewModel, type PluginsViewModel, type UpdateCheck } from "../plugins/viewModel.js";
import { buildInstallConsent, buildUpdateConsent, buildRemoveConsent, deriveUpdateCheck, type ConsentVM } from "../plugins/consentViewModel.js";

/** The op the user is consenting to — held host-side between preview and confirm (the apply re-checks TOCTOU). */
type PendingOp =
  | { kind: "install"; plugin: LoadedPlugin; preview: InstallPreview; provenance?: InstallProvenance }
  | { kind: "update"; plugin: LoadedPlugin; provenance?: InstallProvenance; force: boolean; fingerprint: string }
  | { kind: "remove"; name: string; fingerprint: string };

interface InboundMsg {
  type?: string;
  spec?: string;
  name?: string;
  token?: string;
}

/** The host→webview posting surface + per-panel mutable state, handed to each message handler. */
interface PanelIO {
  post(): void;
  postConsent(vm: ConsentVM): void;
  postBusy(label: string): void;
  postResult(ok: boolean, message: string): void;
  getPending(): PendingOp | undefined;
  setPending(p: PendingOp | undefined): void;
  setChecks(c: Record<string, UpdateCheck>): void;
  isBusy(): boolean;
  setBusy(b: boolean): void;
}

/**
 * spec 250 — the editor-area Plugins View panel (one per workspace root), opened by the sidebar title
 * button `tachyon.openPlugins` (sibling of inspect-tmux). Mirrors the HandoffPanelManager (spec 245):
 * createWebviewPanel + asWebviewUri(dist/webview/plugins.js) + a single VM postMessage, re-posted on
 * an explicit refresh. The HOST gathers the model (detectRuntimes + read the committed lockfile +
 * buildPluginsViewModel — all I/O lives here); the Preact webview renders it (never imports vscode/engine).
 *
 * Step C adds the interactive surface: install-by-source, the BLOCKING consent drawer (previewInstall/
 * previewUpdate/previewRemove → the pure consentViewModel), the apply actions (applyInstall/Update/Remove,
 * each re-checking TOCTOU at the engine), and lazy update-checks. Async ops are serialized by a busy flag.
 */
export class PluginsPanelManager {
  private readonly panels = new Map<string, { panel: vscode.WebviewPanel; post: () => void }>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getWorkspaces: () => Workspace[],
  ) {}

  open(wsHash?: string): void {
    const ws = wsHash === undefined ? this.getWorkspaces()[0] : this.getWorkspaces().find((w) => w.wsHash === wsHash);
    if (!ws) return;
    const key = ws.wsHash;
    const existing = this.panels.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const panel = vscode.window.createWebviewPanel(
      "tachyonPlugins",
      `🧩 Plugins — ${ws.folderName}`,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, localResourceRoots: [root], retainContextWhenHidden: true },
    );
    const codiconUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, "codicon.css"));
    const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, "plugins.js"));
    panel.webview.html = html(panel.webview, codiconUri, scriptUri, ws.folderName);

    // per-panel state: the last update-checks (cleared on a refresh) + the op awaiting confirmation.
    let checks: Record<string, UpdateCheck> = {};
    let pending: PendingOp | undefined;
    let busy = false;

    const post = (): void => {
      void panel.webview.postMessage({ type: "plugins", vm: this.gather(ws, checks) });
    };
    const postConsent = (vm: ConsentVM): void => void panel.webview.postMessage({ type: "consent", vm });
    const postBusy = (label: string): void => void panel.webview.postMessage({ type: "busy", label });
    const postResult = (ok: boolean, message: string): void => void panel.webview.postMessage({ type: "result", ok, message });

    panel.webview.onDidReceiveMessage((m: InboundMsg) => {
      void this.onMessage(ws, m, {
        post,
        postConsent,
        postBusy,
        postResult,
        getPending: () => pending,
        setPending: (p) => { pending = p; },
        setChecks: (c) => { checks = c; },
        isBusy: () => busy,
        setBusy: (b) => { busy = b; },
      });
    });

    panel.onDidDispose(() => {
      this.panels.delete(key);
    });
    this.panels.set(key, { panel, post });
    post();
  }

  /** Route one inbound webview message. Network/apply ops are serialized by a `busy` flag (one at a time). */
  private async onMessage(ws: Workspace, m: InboundMsg, io: PanelIO): Promise<void> {
    switch (m.type) {
      case "ready":
      case "refresh":
        io.setChecks({});
        io.post();
        return;
      case "checkUpdates":
        await this.guard(io, () => this.checkUpdates(ws, io));
        return;
      case "install":
        if (m.spec) await this.guard(io, () => this.previewInstallOp(ws, m.spec as string, io));
        return;
      case "update":
        if (m.name) await this.guard(io, () => this.previewUpdateOp(ws, m.name as string, io, false));
        return;
      case "reinstall":
        if (m.name) await this.guard(io, () => this.previewUpdateOp(ws, m.name as string, io, true));
        return;
      case "remove":
        if (m.name) await this.guard(io, () => this.previewRemoveOp(ws, m.name as string, io));
        return;
      case "confirm":
        if (m.token) await this.guard(io, () => this.confirmOp(ws, m.token as string, io));
        return;
      case "cancel":
        io.setPending(undefined);
        return;
    }
  }

  /** Serialize the async ops — drop overlapping requests so a slow clone can't interleave with an apply. A
   *  thrown engine/fs error becomes a red result toast (never a silent rejected handler) + clears any pending. */
  private async guard(io: PanelIO, fn: () => Promise<void>): Promise<void> {
    if (io.isBusy()) return;
    io.setBusy(true);
    try {
      await fn();
    } catch (e) {
      io.setPending(undefined);
      io.postResult(false, e instanceof Error ? e.message : String(e));
    } finally {
      io.setBusy(false);
    }
  }

  /** Re-resolve every sourced installed plugin and previewUpdate it → per-plugin status (clears `unknown`). */
  private async checkUpdates(ws: Workspace, io: PanelIO): Promise<void> {
    io.postBusy("Checking for updates…");
    const present = detectRuntimes(ws.workspaceRoot);
    const lock = this.lockfile(ws);
    const next: Record<string, UpdateCheck> = {};
    for (const p of Object.values(lock?.plugins ?? {})) {
      if (!p.source) continue; // a dir install has no source to re-resolve
      try {
        const loaded = await loadPluginFromSource(p.source.spec);
        if (!loaded.plugin) {
          next[p.name] = { kind: "error", detail: loaded.errors.join("; ") };
          continue;
        }
        next[p.name] = deriveUpdateCheck(previewUpdate(loaded.plugin, ws.workspaceRoot, present));
      } catch (e) {
        next[p.name] = { kind: "error", detail: e instanceof Error ? e.message : String(e) };
      }
    }
    io.setChecks(next);
    io.post();
  }

  private async previewInstallOp(ws: Workspace, spec: string, io: PanelIO): Promise<void> {
    io.postBusy(`Resolving ${spec}…`);
    const present = detectRuntimes(ws.workspaceRoot);
    let loaded;
    try {
      loaded = await loadPluginFromSource(spec);
    } catch (e) {
      io.postResult(false, `Could not resolve '${spec}': ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!loaded.plugin) {
      io.postResult(false, `Could not load '${spec}': ${loaded.errors.join("; ")}`);
      return;
    }
    const preview = previewInstall(loaded.plugin, ws.workspaceRoot, present);
    io.setPending({ kind: "install", plugin: loaded.plugin, preview, provenance: loaded.provenance });
    io.postConsent(buildInstallConsent(preview, loaded.provenance));
  }

  private async previewUpdateOp(ws: Workspace, name: string, io: PanelIO, forceReinstall: boolean): Promise<void> {
    const lock = this.lockfile(ws);
    const entry = lock?.plugins[name];
    if (!entry?.source) {
      io.postResult(false, `'${name}' has no recorded source to re-resolve — reinstall by source instead.`);
      return;
    }
    io.postBusy(`Resolving ${entry.source.spec}…`);
    const present = detectRuntimes(ws.workspaceRoot);
    let loaded;
    try {
      loaded = await loadPluginFromSource(entry.source.spec);
    } catch (e) {
      io.postResult(false, `Could not resolve '${entry.source.spec}': ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!loaded.plugin) {
      io.postResult(false, `Could not load '${entry.source.spec}': ${loaded.errors.join("; ")}`);
      return;
    }
    const preview = previewUpdate(loaded.plugin, ws.workspaceRoot, present);
    const force = forceReinstall || preview.conflicts.length > 0 || preview.isDowngrade;
    io.setPending({ kind: "update", plugin: loaded.plugin, provenance: loaded.provenance, force, fingerprint: preview.install?.fingerprint ?? "" });
    io.postConsent(buildUpdateConsent(preview, loaded.provenance, forceReinstall));
  }

  private async previewRemoveOp(ws: Workspace, name: string, io: PanelIO): Promise<void> {
    const lock = this.lockfile(ws);
    const version = lock?.plugins[name]?.version ?? "";
    const preview = previewRemove(name, ws.workspaceRoot);
    io.setPending({ kind: "remove", name, fingerprint: preview.fingerprint });
    io.postConsent(buildRemoveConsent(name, version, preview));
  }

  /** Apply the held op (token-matched) — the engine apply re-previews + lost-update-guards before writing. */
  private async confirmOp(ws: Workspace, token: string, io: PanelIO): Promise<void> {
    const op = io.getPending();
    io.setPending(undefined);
    if (!op) return;
    const present = detectRuntimes(ws.workspaceRoot);

    // every branch binds the confirm to the consented fingerprint (the held one == the drawer token), and the
    // engine apply RE-CHECKS that fingerprint against fresh state before writing (atomic TOCTOU guard).
    if (op.kind === "install") {
      if (op.preview.fingerprint !== token) { io.postResult(false, "Consent expired — re-open the install."); return; }
      const r = applyInstall(op.plugin, op.preview, ws.workspaceRoot, present, { provenance: op.provenance });
      io.postResult(r.installed, r.installed ? `Installed ${op.plugin.manifest.name} into ${r.runtimes.join(", ")}.` : r.errors.join("; "));
    } else if (op.kind === "update") {
      if (op.fingerprint !== token) { io.postResult(false, "Consent expired — re-open the update."); return; }
      const r = applyUpdate(op.plugin, ws.workspaceRoot, present, { force: op.force, provenance: op.provenance, expectedFingerprint: token });
      io.postResult(r.updated, r.updated ? `Updated ${op.plugin.manifest.name}.` : (r.upToDate ? "Already up to date." : r.errors.join("; ")));
    } else {
      if (op.fingerprint !== token) { io.postResult(false, "Consent expired — re-open the remove."); return; }
      const r = applyRemove(op.name, ws.workspaceRoot, { expectedFingerprint: token });
      io.postResult(r.removed, r.removed ? `Removed ${op.name}${r.orphans > 0 ? ` (${r.orphans} edited group(s) left as orphans)` : ""}.` : r.errors.join("; "));
    }
    io.setChecks({}); // applied state changed → drop stale checks
    io.post();
  }

  /** Parse the committed lockfile (best-effort; undefined on absence/corruption — callers degrade gracefully). */
  private lockfile(ws: Workspace): { plugins: Record<string, PluginLock> } | undefined {
    try {
      const { lockfile } = parseLockfile(fs.readFileSync(path.join(ws.workspaceRoot, LOCKFILE_REL_PATH), "utf8"));
      return lockfile;
    } catch {
      return undefined;
    }
  }

  /** Assemble the render-ready model: present runtimes + the committed lockfile + any update-checks → VM.
   *  Update-checks are LAZY (the user runs "Check for updates"); absent ⇒ every status is `unknown`. */
  private gather(ws: Workspace, updateChecks: Record<string, UpdateCheck>): PluginsViewModel {
    const present = detectRuntimes(ws.workspaceRoot);
    let lockfileText: string | undefined;
    try {
      lockfileText = fs.readFileSync(path.join(ws.workspaceRoot, LOCKFILE_REL_PATH), "utf8");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      // ONLY a genuine absence is the cold state; a real read failure (EACCES/EISDIR/…) must surface,
      // never masquerade as "no plugins" (which would mislead the actions).
      if (err.code !== "ENOENT") {
        return buildPluginsViewModel({ present, readError: `${LOCKFILE_REL_PATH}: ${err.code ?? "read error"}: ${err.message}` });
      }
      lockfileText = undefined;
    }
    return buildPluginsViewModel({ lockfileText, present, updateChecks });
  }

  /** Re-post to an open panel for this workspace. */
  refresh(wsHash: string): void {
    this.panels.get(wsHash)?.post();
  }

  /** Re-post to every open panel (cheap). */
  refreshAll(): void {
    for (const { post } of this.panels.values()) post();
  }

  dispose(): void {
    for (const { panel } of this.panels.values()) panel.dispose();
    this.panels.clear();
  }
}

function getNonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function html(webview: vscode.Webview, codiconUri: vscode.Uri, scriptUri: vscode.Uri, folder: string): string {
  const nonce = getNonce();
  const title = folder.replace(/[<>&]/g, "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${codiconUri}">
<title>Plugins — ${title}</title>
<style>
  :root {
    --muted:     var(--vscode-descriptionForeground);
    --border:    var(--vscode-widget-border, var(--vscode-editorWidget-border, rgba(128,128,128,.22)));
    --focus:     var(--vscode-focusBorder);
    --warn:      var(--vscode-charts-yellow, var(--vscode-list-warningForeground, #cca700));
    --info:      var(--vscode-charts-blue, var(--vscode-textLink-foreground));
    --err:       var(--vscode-errorForeground, var(--vscode-list-errorForeground, #f14c4c));
    --ok:        var(--vscode-charts-green, #89d185);
    --card-bg:   var(--vscode-editorWidget-background, rgba(128,128,128,.06));
    --code-font: var(--vscode-editor-font-family, monospace);
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0 0 48px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  button { font: inherit; color: inherit; background: none; border: none; padding: 0; cursor: pointer; }
  :focus-visible { outline: 1px solid var(--focus); outline-offset: 1px; border-radius: 3px; }
  .dim { color: var(--muted); }
  .mono { font-family: var(--code-font); font-size: 12px; }
  .wrap { max-width: 920px; margin: 0 auto; padding: 0 20px; }

  .head { position: sticky; top: 0; z-index: 5; background: var(--vscode-editor-background); border-bottom: 1px solid var(--border); }
  .head-row { display: flex; align-items: center; gap: 12px; padding: 14px 0 10px; }
  .title { font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .sub { color: var(--muted); font-size: 12px; margin: -4px 0 0; }
  .ws-rt b { color: var(--vscode-foreground); font-weight: 600; }
  .actions { margin-left: auto; display: flex; gap: 6px; }
  .act-btn { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border: 1px solid var(--border); border-radius: 4px; color: var(--vscode-foreground); }
  .act-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.18)); }
  .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-radius: 4px; padding: 4px 12px; font-weight: 600; }
  .btn-primary:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
  .btn-primary:disabled { opacity: .5; cursor: default; }
  .btn-primary.danger { background: var(--err); color: #fff; }

  .addbar { display: flex; gap: 8px; padding: 8px 0 12px; }
  .addbar input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--border); border-radius: 5px; padding: 7px 11px; font-family: var(--code-font); font-size: 12px; }
  .addbar input::placeholder { color: var(--muted); }
  .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); }
  .tab { padding: 8px 14px; color: var(--muted); border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .tab.active { color: var(--vscode-foreground); border-bottom-color: var(--focus); }
  .tab .count { font-size: 11px; opacity: .7; }
  .card-actions { margin-left: auto; display: flex; gap: 6px; }

  .list { padding: 16px 0; display: flex; flex-direction: column; gap: 10px; }
  .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; }
  .card-top { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .pname { font-size: 14px; font-weight: 600; }
  .pver { color: var(--muted); font-size: 12px; }
  .badge { font-size: 11px; line-height: 1.6; padding: 1px 9px; border-radius: 10px; border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
  .badge.ok   { color: var(--ok);   border-color: color-mix(in srgb, var(--ok) 55%, transparent); }
  .badge.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 55%, transparent); }
  .badge.info { color: var(--info); border-color: color-mix(in srgb, var(--info) 55%, transparent); }
  .badge.err  { color: var(--err);  border-color: color-mix(in srgb, var(--err) 55%, transparent); }
  .pmeta { color: var(--muted); font-size: 12px; margin-top: 7px; display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; }
  .src { font-family: var(--code-font); }
  .rt { font-size: 11px; padding: 1px 8px; border-radius: 10px; border: 1px solid var(--border); white-space: nowrap; }
  .rt.has  { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 50%, transparent); }
  .rt.miss { color: var(--muted); opacity: .7; }

  .banner { margin: 16px 0; padding: 12px 14px; border-radius: 8px; border: 1px solid color-mix(in srgb, var(--err) 45%, transparent); background: color-mix(in srgb, var(--err) 8%, transparent); color: var(--err); font-size: 12.5px; }
  .empty { text-align: center; color: var(--muted); padding: 60px 20px; }
  .empty .big { font-size: 14px; color: var(--vscode-foreground); margin-bottom: 6px; }
  .degrade { padding: 56px 24px; text-align: center; color: var(--muted); }
  .warnline { margin: 8px 0; padding: 8px 12px; border-radius: 6px; border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent); background: color-mix(in srgb, var(--warn) 8%, transparent); color: var(--warn); font-size: 12.5px; }

  /* consent drawer */
  .scrim { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 20; display: flex; justify-content: center; align-items: flex-start; padding: 40px 16px; overflow-y: auto; }
  .drawer { width: 100%; max-width: 680px; background: var(--vscode-editor-background); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 12px 48px rgba(0,0,0,.4); }
  .dhead { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; }
  .dhead .ttl { font-size: 14px; font-weight: 600; } .dhead .x { margin-left: auto; color: var(--muted); font-size: 16px; padding: 2px 6px; }
  .dbody { padding: 4px 20px 8px; }
  .sec { padding: 14px 0; border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); }
  .sec:last-child { border-bottom: 0; }
  .sec h3 { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 8px; }
  .kv { display: grid; grid-template-columns: 140px 1fr; gap: 4px 12px; font-size: 12.5px; }
  .kv .k { color: var(--muted); } .kv .v { font-family: var(--code-font); font-size: 12px; overflow-wrap: anywhere; }
  .perm { background: color-mix(in srgb, var(--warn) 9%, transparent); border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent); border-radius: 6px; padding: 8px 10px; }
  .cmd { font-family: var(--code-font); font-size: 12px; background: var(--vscode-input-background); border-radius: 4px; padding: 5px 9px; margin: 4px 0; overflow-wrap: anywhere; }
  .cmd .ev { color: var(--info); }
  .diff { font-family: var(--code-font); font-size: 12px; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .diff .dl { padding: 3px 12px; white-space: pre-wrap; }
  .diff .dl.add { background: var(--vscode-diffEditor-insertedTextBackground, rgba(137,209,133,.12)); }
  .diff .dl.add::before { content: "+ "; color: var(--ok); }
  .dfoot { padding: 14px 20px; border-top: 1px solid var(--border); display: flex; align-items: center; gap: 10px; }
  .dfoot .fp { color: var(--muted); font-size: 11px; font-family: var(--code-font); margin-right: auto; }

  .busy { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 30; background: var(--card-bg); border: 1px solid var(--border); border-radius: 20px; padding: 6px 16px; font-size: 12px; display: flex; align-items: center; gap: 8px; }
  .toast { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 30; max-width: 80%; padding: 8px 16px; border-radius: 8px; font-size: 12.5px; cursor: pointer; display: flex; align-items: center; gap: 8px; border: 1px solid var(--border); background: var(--card-bg); }
  .toast.ok { border-color: color-mix(in srgb, var(--ok) 55%, transparent); color: var(--ok); }
  .toast.err { border-color: color-mix(in srgb, var(--err) 55%, transparent); color: var(--err); }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
