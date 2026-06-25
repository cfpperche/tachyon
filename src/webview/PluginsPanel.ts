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
import type { Runtime } from "../plugins/manifest.js";
import { gatherGitHookState } from "../plugins/gitHookState.js";
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
  /** spec 263 — the user's runtime selection for the pending install (a `reselect` re-previews against it). */
  runtimes?: string[];
  /** spec 251 — per colliding skill destination, the user's Keep/Replace choice (keyed by destRel). */
  skillDecisions?: Record<string, "keep" | "replace">;
  /** spec 254 — per colliding MCP server, the user's Keep/Replace choice (keyed by `${runtime} ${ref}`). */
  mcpDecisions?: Record<string, "keep" | "replace">;
  /** spec 254 OQ5 — the user's MCP double-confirm acknowledgement (required for any MCP-touching install). */
  mcpConfirmed?: boolean;
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
    const dsUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, "design-system.css"));
    const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(root, "plugins.js"));
    panel.webview.html = html(panel.webview, codiconUri, dsUri, scriptUri, ws.folderName);

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
      case "reselect":
        if (Array.isArray(m.runtimes)) await this.guard(io, () => this.reselectOp(ws, m.runtimes as string[], io));
        return;
      case "confirm":
        if (m.token) await this.guard(io, () => this.confirmOp(ws, m.token as string, m.skillDecisions ?? {}, m.mcpDecisions ?? {}, m.mcpConfirmed === true, io));
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
        next[p.name] = deriveUpdateCheck(await previewUpdate(loaded.plugin, ws.workspaceRoot));
      } catch (e) {
        next[p.name] = { kind: "error", detail: e instanceof Error ? e.message : String(e) };
      }
    }
    io.setChecks(next);
    io.post();
  }

  private async previewInstallOp(ws: Workspace, spec: string, io: PanelIO): Promise<void> {
    io.postBusy(`Resolving ${spec}…`);
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
    // spec 263 — default selection = ALL declared runtimes (the install creates whatever structure each needs);
    // `present` is the detectRuntimes hint that only LABELS each row present/will-create in the drawer.
    const present = detectRuntimes(ws.workspaceRoot);
    const target = new Set(loaded.plugin.manifest.runtimes);
    const gitState = await this.gitState(ws, loaded.plugin);
    const preview = previewInstall(loaded.plugin, ws.workspaceRoot, target, gitState);
    io.setPending({ kind: "install", plugin: loaded.plugin, preview, provenance: loaded.provenance });
    io.postConsent(buildInstallConsent(preview, loaded.provenance, present));
  }

  /** spec 264 — gather the (async) git-hook state for a plugin that ships git-hooks; undefined otherwise. The
   *  sync `previewInstall` consumes it so the preview fingerprint matches what `applyInstall` recomputes. */
  private async gitState(ws: Workspace, plugin: LoadedPlugin) {
    return plugin.gitHooks.length > 0 ? await gatherGitHookState(ws.workspaceRoot, plugin.gitHooks.map((g) => g.event)) : undefined;
  }

  /** spec 263 — re-preview the pending install for a new runtime selection (host-owned recompute on each drawer
   *  toggle), re-posting consent with the fresh fingerprint. Selection is intersected with the declared runtimes. */
  private async reselectOp(ws: Workspace, runtimes: string[], io: PanelIO): Promise<void> {
    const op = io.getPending();
    if (!op || op.kind !== "install") return;
    const present = detectRuntimes(ws.workspaceRoot);
    const target = new Set(op.plugin.manifest.runtimes.filter((rt) => runtimes.includes(rt)));
    const gitState = await this.gitState(ws, op.plugin);
    const preview = previewInstall(op.plugin, ws.workspaceRoot, target, gitState);
    io.setPending({ ...op, preview });
    io.postConsent(buildInstallConsent(preview, op.provenance, present));
  }

  private async previewUpdateOp(ws: Workspace, name: string, io: PanelIO, forceReinstall: boolean): Promise<void> {
    const lock = this.lockfile(ws);
    const entry = lock?.plugins[name];
    if (!entry?.source) {
      io.postResult(false, `'${name}' has no recorded source to re-resolve — reinstall by source instead.`);
      return;
    }
    io.postBusy(`Resolving ${entry.source.spec}…`);
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
    const preview = await previewUpdate(loaded.plugin, ws.workspaceRoot);
    const force = forceReinstall || preview.conflicts.length > 0 || preview.isDowngrade;
    const present = detectRuntimes(ws.workspaceRoot); // hint only — labels the (fixed) update runtime rows
    io.setPending({ kind: "update", plugin: loaded.plugin, provenance: loaded.provenance, force, fingerprint: preview.install?.fingerprint ?? "" });
    io.postConsent(buildUpdateConsent(preview, loaded.provenance, forceReinstall, present));
  }

  private async previewRemoveOp(ws: Workspace, name: string, io: PanelIO): Promise<void> {
    const lock = this.lockfile(ws);
    const version = lock?.plugins[name]?.version ?? "";
    const preview = previewRemove(name, ws.workspaceRoot);
    io.setPending({ kind: "remove", name, fingerprint: preview.fingerprint });
    io.postConsent(buildRemoveConsent(name, version, preview));
  }

  /** Apply the held op (token-matched) — the engine apply re-previews + lost-update-guards before writing. */
  private async confirmOp(ws: Workspace, token: string, skillDecisions: Record<string, "keep" | "replace">, mcpDecisions: Record<string, "keep" | "replace">, mcpConfirmed: boolean, io: PanelIO): Promise<void> {
    const op = io.getPending();
    io.setPending(undefined);
    if (!op) return;

    // every branch binds the confirm to the consented fingerprint (the held one == the drawer token), and the
    // engine apply RE-CHECKS that fingerprint against fresh state before writing (atomic TOCTOU guard). The
    // per-collision skill Keep/Replace decisions ride along (the engine fails closed on an undecided collision).
    if (op.kind === "install") {
      if (op.preview.fingerprint !== token) { io.postResult(false, "Consent expired — re-open the install."); return; }
      // spec 263 — apply into exactly the consented selection (carried on the preview + bound into the
      // fingerprint that was just verified), NOT detectRuntimes.
      const r = await applyInstall(op.plugin, op.preview, ws.workspaceRoot, new Set(op.preview.targetRuntimes), { provenance: op.provenance, skillDecisions, mcpDecisions, mcpConfirmed });
      io.postResult(r.installed, r.installed ? `Installed ${op.plugin.manifest.name} into ${r.runtimes.join(", ")}.` : r.errors.join("; "));
    } else if (op.kind === "update") {
      if (op.fingerprint !== token) { io.postResult(false, "Consent expired — re-open the update."); return; }
      const r = await applyUpdate(op.plugin, ws.workspaceRoot, { force: op.force, provenance: op.provenance, expectedFingerprint: token, skillDecisions, mcpDecisions, mcpConfirmed });
      io.postResult(r.updated, r.updated ? `Updated ${op.plugin.manifest.name}.` : (r.upToDate ? "Already up to date." : r.errors.join("; ")));
    } else {
      if (op.fingerprint !== token) { io.postResult(false, "Consent expired — re-open the remove."); return; }
      const r = await applyRemove(op.name, ws.workspaceRoot, { expectedFingerprint: token });
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
    return buildPluginsViewModel({ lockfileText, present, intact: this.intactRuntimes(ws), updateChecks });
  }

  /** spec 263 — per installed plugin, the runtimes whose recorded materialization is still INTACT on disk: a
   *  runtime is intact iff every target it recorded (settings file / skill dir / mcp config) still exists. This
   *  is the honest "installed & present" signal for the card pills — unlike `detectRuntimes`, it is correct for
   *  a skills-only install that lands in `.agents/skills/` and never creates a `.codex/` dir. */
  private intactRuntimes(ws: Workspace): Record<string, Runtime[]> {
    const lock = this.lockfile(ws);
    const out: Record<string, Runtime[]> = {};
    for (const p of Object.values(lock?.plugins ?? {})) {
      out[p.name] = p.runtimes.filter((rt) => {
        const targets = p.targets.filter((t) => t.runtime === rt);
        return targets.length > 0 && targets.every((t) => fs.existsSync(path.join(ws.workspaceRoot, t.file)));
      });
    }
    return out;
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

function html(webview: vscode.Webview, codiconUri: vscode.Uri, dsUri: vscode.Uri, scriptUri: vscode.Uri, folder: string): string {
  const nonce = getNonce();
  const title = folder.replace(/[<>&]/g, "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${codiconUri}">
<link rel="stylesheet" href="${dsUri}">
<title>Plugins — ${title}</title>
<style>
  /* spec 252 — panel-specific deltas only; shared tokens + components live in design-system.css (.ds-*). */
  .ws-rt b { color: var(--ds-fg); font-weight: 600; }
  .addbar { display: flex; gap: var(--ds-2); padding: var(--ds-2) 0 var(--ds-3); }
  .addbar .ds-input { flex: 1; }
  .ds-tab .count { font-size: var(--ds-micro); opacity: .7; }
  .card-actions { margin-left: auto; display: flex; gap: var(--ds-1); }

  .list { padding: var(--ds-4) 0; display: flex; flex-direction: column; gap: 10px; }
  .card-top { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .pname { font-size: 14px; font-weight: 600; }
  .pver { color: var(--ds-muted); font-size: var(--ds-small); }
  .pmeta { color: var(--ds-muted); font-size: var(--ds-small); margin-top: 7px; display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; }
  .src { font-family: var(--ds-mono); }
  .rt { font-size: var(--ds-micro); padding: 1px 8px; border-radius: 10px; border: 1px solid var(--ds-border); white-space: nowrap; }
  .rt.has  { color: var(--ds-ok); border-color: color-mix(in srgb, var(--ds-ok) 50%, transparent); }
  .rt.miss { color: var(--ds-muted); opacity: .7; }

  .warnline { margin: var(--ds-2) 0; padding: var(--ds-2) var(--ds-3); border-radius: var(--ds-radius); border: 1px solid color-mix(in srgb, var(--ds-warn) 45%, transparent); background: color-mix(in srgb, var(--ds-warn) 8%, transparent); color: var(--ds-warn); font-size: 12.5px; }

  /* consent drawer */
  .scrim { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 20; display: flex; justify-content: center; align-items: flex-start; padding: 40px 16px; overflow-y: auto; }
  .drawer { width: 100%; max-width: 680px; background: var(--vscode-editor-background); border: 1px solid var(--ds-border); border-radius: 10px; box-shadow: 0 12px 48px rgba(0,0,0,.4); }
  .dhead { padding: 16px 20px; border-bottom: 1px solid var(--ds-border); display: flex; align-items: center; gap: 10px; }
  .dhead .ttl { font-size: 14px; font-weight: 600; } .dhead .x { margin-left: auto; color: var(--ds-muted); font-size: 16px; padding: 2px 6px; }
  .dbody { padding: 4px 20px 8px; }
  .sec { padding: 14px 0; border-bottom: 1px solid color-mix(in srgb, var(--ds-border) 60%, transparent); }
  .sec:last-child { border-bottom: 0; }
  .sec h3 { font-size: var(--ds-micro); font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--ds-muted); margin: 0 0 var(--ds-2); }
  .kv { display: grid; grid-template-columns: 140px 1fr; gap: 4px 12px; font-size: 12.5px; }
  .kv .k { color: var(--ds-muted); } .kv .v { font-family: var(--ds-mono); font-size: var(--ds-small); overflow-wrap: anywhere; }
  .perm { background: color-mix(in srgb, var(--ds-warn) 9%, transparent); border: 1px solid color-mix(in srgb, var(--ds-warn) 40%, transparent); border-radius: var(--ds-radius); padding: var(--ds-2) 10px; }
  .cmd { font-family: var(--ds-mono); font-size: var(--ds-small); background: var(--ds-input-bg); border-radius: 4px; padding: 5px 9px; margin: var(--ds-1) 0; overflow-wrap: anywhere; }
  .cmd .ev { color: var(--ds-info); }
  .diff { font-family: var(--ds-mono); font-size: var(--ds-small); border: 1px solid var(--ds-border); border-radius: var(--ds-radius); overflow: hidden; }
  .diff .dl { padding: 3px 12px; white-space: pre-wrap; }
  .diff .dl.add { background: var(--vscode-diffEditor-insertedTextBackground, color-mix(in srgb, var(--ds-ok) 12%, transparent)); }
  .diff .dl.add::before { content: "+ "; color: var(--ds-ok); }
  .dfoot { padding: 14px 20px; border-top: 1px solid var(--ds-border); display: flex; align-items: center; gap: 10px; }
  .dfoot .fp { color: var(--ds-muted); font-size: var(--ds-micro); font-family: var(--ds-mono); margin-right: auto; }
  /* skill collision Keep/Replace control */
  .collrow { display: flex; align-items: center; gap: 10px; margin: 6px 0; flex-wrap: wrap; }
  .collrow .ds-mono { overflow-wrap: anywhere; flex: 1; }
  .seg { display: inline-flex; border: 1px solid var(--ds-border); border-radius: 5px; overflow: hidden; }
  .seg button { padding: 3px 12px; font-size: var(--ds-small); color: var(--ds-muted); }
  .seg button.seg-on { background: var(--ds-btn-bg); color: var(--ds-btn-fg); }
  .seg button.seg-danger { background: var(--ds-err); color: #fff; }
  .ackline { display: flex; align-items: flex-start; gap: var(--ds-2); margin-top: 10px; font-size: 12.5px; color: var(--ds-warn); }
  .ackline input { margin-top: 3px; }
  /* spec 263 — per-runtime install selector */
  .rtsel { display: flex; flex-wrap: wrap; gap: var(--ds-2); }
  .rtrow { display: inline-flex; align-items: center; gap: 8px; padding: 5px 12px; border: 1px solid var(--ds-border); border-radius: var(--ds-radius); cursor: pointer; font-size: var(--ds-small); color: var(--ds-muted); }
  .rtrow.on { border-color: color-mix(in srgb, var(--ds-ok) 55%, transparent); background: color-mix(in srgb, var(--ds-ok) 8%, transparent); color: var(--ds-fg); }
  .rtrow input { margin: 0; }
  .rtrow .rtname { font-weight: 600; }

  .busy { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 30; background: var(--ds-card); border: 1px solid var(--ds-border); border-radius: 20px; padding: 6px 16px; font-size: var(--ds-small); display: flex; align-items: center; gap: var(--ds-2); }
  .toast { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 30; max-width: 80%; padding: var(--ds-2) 16px; border-radius: var(--ds-radius); font-size: 12.5px; cursor: pointer; display: flex; align-items: center; gap: var(--ds-2); border: 1px solid var(--ds-border); background: var(--ds-card); }
  .toast.ok { border-color: color-mix(in srgb, var(--ds-ok) 55%, transparent); color: var(--ds-ok); }
  .toast.err { border-color: color-mix(in srgb, var(--ds-err) 55%, transparent); color: var(--ds-err); }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
