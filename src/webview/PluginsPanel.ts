import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkspaceGitPresentationTarget } from "../shell/WorkspacePresentation.js";
import { isCockpitSingletonClaimed } from "./cockpitSingleton.js";
import {
  detectRuntimes,
  loadPluginFromSource,
  resolveEffectiveUpdateSpec,
  previewInstall,
  applyInstall,
  previewUpdate,
  applyUpdate,
  previewRemove,
  applyRemove,
  repairGitHooks,
  type LoadedPlugin,
  type InstallPreview,
  type InstallProvenance,
} from "../plugins/engine.js";
import { type Runtime, type PackageManager, type ExternalToolInstall } from "../plugins/manifest.js";
import { pluginsMessage, consentMessage, busyMessage, resultMessage, type PluginsActionType } from "./plugins/messages.js";
import { gatherGitHookState } from "../plugins/gitHookState.js";
import type { GitRun } from "../plugins/fetcher.js";
import { gatherToolPlan } from "../plugins/toolPlan.js";
import { gatherDataPlan } from "../plugins/dataPlan.js";
import { buildAssistedInstall, shellQuoteForDisplay, detectExternalToolPresence, adaptLockedInstall } from "../plugins/externalTool.js";
import { rehydrateTools, rehydrateData, rehydrateExternalResolver, type ProvisionProgress } from "../plugins/toolProvisionRun.js";
import { notify, showNotification } from "../workspace/NotificationService.js";
import { parseLockfile, LOCKFILE_REL_PATH, type PluginLock, type ExternalToolReqLock } from "../plugins/lockfile.js";
import { buildPluginsViewModel, buildExternalStatuses, type PluginsViewModel, type UpdateCheck, type ExternalToolVM, type ExternalPresenceResult } from "../plugins/viewModel.js";
import { buildInstallConsent, buildUpdateConsent, buildRemoveConsent, deriveUpdateCheck, type ConsentVM } from "../plugins/consentViewModel.js";

export const PLUGINS_VIEW_TYPE = "tachyonPlugins";

export interface PluginsPanelState {
  schemaVersion: 1;
  view: typeof PLUGINS_VIEW_TYPE;
  wsHash: string;
}

/** The op the user is consenting to — held host-side between preview and confirm (the apply re-checks TOCTOU). */
type PendingOp =
  | { kind: "install"; plugin: LoadedPlugin; preview: InstallPreview; provenance?: InstallProvenance }
  | { kind: "update"; plugin: LoadedPlugin; provenance?: InstallProvenance; force: boolean; fingerprint: string }
  | { kind: "remove"; name: string; fingerprint: string };

interface InboundMsg {
  type?: PluginsActionType; // spec 280 — typed union: a typo'd `case "…"` in onMessage is now a compile error
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
  /** spec 264 — the user's git-hook acknowledgement (required for any install that registers a git-hook). */
  gitHookConfirmed?: boolean;
  /** spec 265 — the user's tool acknowledgement (required for any install that downloads + executes a tool). */
  toolConfirmed?: boolean;
  /** spec 284 — the user's data acknowledgement (required for any install that downloads + stores a data artifact). */
  dataConfirmed?: boolean;
  /** spec 349 — the user's view/UI acknowledgement (required for any install/update that registers views). */
  viewConfirmed?: boolean;
  /** spec 349 — the user's fleet-summary read acknowledgement (required when a view reads fleet summary). */
  fleetReadConfirmed?: boolean;
  /** spec 349 — per brokered view action acknowledgement, keyed by `<viewId>:<action>`. */
  actionConfirmed?: Record<string, boolean>;
  /** spec 285 — the external tool name the user asked Tachyon to assist-install (a privileged terminal action). */
  externalTool?: string;
  /** spec 287 — present ⇒ the assisted install was triggered from an INSTALLED plugin's card (resolve the
   *  requirement from this plugin's lockfile entry, not a pending consent op). */
  pluginName?: string;
}

function trueActions(input: Record<string, boolean>): Record<string, true> {
  return Object.fromEntries(Object.entries(input).filter(([, confirmed]) => confirmed).map(([key]) => [key, true as const]));
}

/** spec 287 — render a best-effort download-progress event as a busy label ("Downloading model… 42 / 148 MB").
 *  Throttling already happened at the download layer; this is pure formatting. */
function progressBusyLabel(p: ProvisionProgress): string {
  const mib = (n: number) => (n / (1 << 20)).toFixed(n >= 10 << 20 ? 0 : 1);
  const verb = p.kind === "data" ? "Downloading" : "Fetching";
  if (p.totalBytes && p.totalBytes > 0) return `${verb} ${p.name}… ${mib(p.downloadedBytes)} / ${mib(p.totalBytes)} MB`;
  return `${verb} ${p.name}… ${mib(p.downloadedBytes)} MB`;
}

/** The host→webview posting surface + per-panel mutable state, handed to each message handler. */
interface PanelIO {
  post(): void;
  postConsent(vm: ConsentVM): void;
  postBusy(label: string): void;
  postResult(ok: boolean, message: string): void;
  getPending(): PendingOp | undefined;
  setPending(p: PendingOp | undefined): void;
  getChecks(): Record<string, UpdateCheck>;
  setChecks(c: Record<string, UpdateCheck>): void;
  isBusy(): boolean;
  setBusy(b: boolean): void;
}

/**
 * spec 250 → spec 410 (t-d23f93) — Plugins host service. Originally the editor-area Plugins View
 * panel manager (one WebviewPanel per workspace root); since SDD 410 Phase B, Plugins opens as
 * Control → Plugins (cockpit section) and this manager no longer creates peer panels — `open`/
 * `deserialize` only redirect legacy opens/revives (ApprovalPanelManager pattern), with the
 * per-workspace need served by Control's shell-level workspace selector (t-d16a39). What remains
 * REAL here is the host side of the Plugins product surface, driven through the Control embed:
 * the HOST gathers the model (detectRuntimes + committed lockfile + buildPluginsViewModel — all
 * I/O lives here) and routes the interactive surface (install-by-source, the BLOCKING consent
 * drawer, apply actions with TOCTOU re-checks, lazy update-checks; async ops serialized by a busy
 * flag). The Preact webview renders it (never imports vscode/engine).
 */
/** Control-monolith embed: the Plugins message surface bound into Control's webview. */
interface ControlPluginsEmbed {
  webview: vscode.Webview;
  ws: WorkspaceGitPresentationTarget;
  io: PanelIO;
  post: () => void;
}

export class PluginsPanelManager {
  /** The Control embed (plugins section). One at a time. */
  private embed: ControlPluginsEmbed | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getWorkspaces: () => WorkspaceGitPresentationTarget[],
    private readonly onPluginsChanged: () => void = () => undefined,
  ) {}

  /** spec 410 (t-d23f93) — legacy open path: redirect into Control's Plugins section. */
  open(wsHash?: string): void {
    void vscode.commands.executeCommand("tachyon.openPlugins", wsHash);
  }

  /**
   * A revived pre-410 standalone panel is disposed and re-opened as Control → Plugins — UNLESS
   * Control's own revival/open already claimed the singleton this session (t-610705 Phase C.0):
   * VS Code doesn't guarantee revive order across view types, and a redirect after the real
   * Cockpit already restored would clobber whatever route the user is already looking at.
   * `open()` above is unguarded — it is a live, user-initiated jump and must always navigate.
   */
  deserialize(panel: vscode.WebviewPanel, state: PluginsPanelState): void {
    panel.dispose();
    if (isCockpitSingletonClaimed()) return;
    void vscode.commands.executeCommand("tachyon.openPlugins", state.wsHash);
  }

  /** Route one inbound webview message. Network/apply ops are serialized by a `busy` flag (one at a time). */
  private async onMessage(ws: WorkspaceGitPresentationTarget, m: InboundMsg, io: PanelIO): Promise<void> {
    switch (m.type) {
      case "ready":
      case "refresh":
        io.setChecks({});
        io.post();
        return;
      case "checkUpdates":
        await this.guard(io, () => this.checkUpdates(ws, io));
        return;
      case "checkPluginUpdate":
        if (m.name) await this.guard(io, () => this.checkPluginUpdate(ws, m.name as string, io));
        return;
      case "install":
        if (m.spec) await this.guard(io, () => this.previewInstallOp(ws, m.spec as string, io));
        return;
      case "installExternal":
        // spec 287 — `pluginName` present ⇒ the installed-card path (resolve from the lockfile); else the drawer path.
        if (m.externalTool && m.pluginName) await this.guard(io, () => this.installExternalFromCardOp(ws, m.pluginName as string, m.externalTool as string, io));
        else if (m.externalTool) await this.guard(io, () => this.installExternalOp(ws, m.externalTool as string, io));
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
      case "openConfig":
        // spec 270 — quick, read-only-ish; not behind the apply busy-guard.
        if (m.name) await this.openConfigFile(ws, m.name);
        return;
      case "openDocs":
        if (m.name) await this.openDocs(ws, m.name);
        return;
      case "reselect":
        if (Array.isArray(m.runtimes)) await this.guard(io, () => this.reselectOp(ws, m.runtimes as string[], io));
        return;
      case "confirm":
        if (m.token) await this.guard(io, () => this.confirmOp(ws, m.token as string, m.skillDecisions ?? {}, m.mcpDecisions ?? {}, m.mcpConfirmed === true, m.gitHookConfirmed === true, m.toolConfirmed === true, m.dataConfirmed === true, m.viewConfirmed === true, m.fleetReadConfirmed === true, m.actionConfirmed ?? {}, io));
        return;
      case "rehydrate":
        await this.guard(io, () => this.rehydrateOp(ws, io));
        return;
      case "repair":
        await this.guard(io, () => this.repairOp(ws, io));
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

  private async checkOnePluginUpdate(ws: WorkspaceGitPresentationTarget, p: PluginLock): Promise<UpdateCheck> {
    if (!p.source) return { kind: "error", detail: "plugin has no recorded source" };
    try {
      // spec 266 — for a semver-tag pin, evaluate against the repo's highest semver tag (else the exact pin).
      const spec = await resolveEffectiveUpdateSpec(p.source.spec, this.gitRun(ws));
      const loaded = await loadPluginFromSource(spec, this.gitRun(ws));
      if (!loaded.plugin) return { kind: "error", detail: loaded.errors.join("; ") };
      return deriveUpdateCheck(await previewUpdate(loaded.plugin, ws.workspaceRoot, this.gitRun(ws)));
    } catch (e) {
      return { kind: "error", detail: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Re-resolve every sourced installed plugin and previewUpdate it → per-plugin status (clears `unknown`). */
  private async checkUpdates(ws: WorkspaceGitPresentationTarget, io: PanelIO): Promise<void> {
    io.postBusy("Checking for updates…");
    const lock = this.lockfile(ws);
    const next: Record<string, UpdateCheck> = {};
    for (const p of Object.values(lock?.plugins ?? {})) {
      if (!p.source) continue; // a dir install has no source to re-resolve
      next[p.name] = await this.checkOnePluginUpdate(ws, p);
    }
    io.setChecks(next);
    io.post();
  }

  /** Re-resolve one sourced installed plugin and merge its status without clearing unrelated update checks. */
  private async checkPluginUpdate(ws: WorkspaceGitPresentationTarget, name: string, io: PanelIO): Promise<void> {
    const p = this.lockfile(ws)?.plugins[name];
    if (!p) { io.postResult(false, `Plugin '${name}' is not installed.`); return; }
    if (!p.source) { io.postResult(false, `'${name}' has no recorded source to check.`); return; }
    io.postBusy(`Checking ${name} for updates…`);
    io.setChecks({ ...io.getChecks(), [name]: await this.checkOnePluginUpdate(ws, p) });
    io.post();
  }

  private async previewInstallOp(ws: WorkspaceGitPresentationTarget, spec: string, io: PanelIO): Promise<void> {
    io.postBusy(`Resolving ${spec}…`);
    let loaded;
    try {
      loaded = await loadPluginFromSource(spec, this.gitRun(ws));
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
    const toolPlan = await this.toolPlan(loaded.plugin);
    const dataPlan = Object.keys(loaded.plugin.manifest.data).length > 0 ? await gatherDataPlan(loaded.plugin) : undefined;
    const preview = previewInstall(loaded.plugin, ws.workspaceRoot, target, gitState, toolPlan, dataPlan);
    io.setPending({ kind: "install", plugin: loaded.plugin, preview, provenance: loaded.provenance });
    io.postConsent(buildInstallConsent(preview, loaded.provenance, present));
  }

  /**
   * spec 285 — the ASSISTED INSTALL of an external tool: a privileged, consent-gated terminal action. Builds the
   * host-PM install argv (validated), shows a strong modal ack (runs the system package manager, possibly as root;
   * not pinned/checksummed; never auto-uninstalled; the exact argv), then runs it in a VISIBLE terminal via
   * `shellPath`/`shellArgs` — spawned ARGV-DIRECTLY (no shell), where the OS's own `sudo`/polkit prompts for the
   * password. Tachyon NEVER captures the credential; it just opens the terminal.
   */
  /** in-flight assisted installs (keyed by `${wsHash}:${tool}`) — block a duplicate privileged terminal (codex HIGH). */
  private readonly externalInstalling = new Set<string>();

  /** the DRAWER assisted install — resolves the requirement from the pending install op's manifest. */
  private async installExternalOp(ws: WorkspaceGitPresentationTarget, toolName: string, io: PanelIO): Promise<void> {
    const op = io.getPending();
    if (!op || op.kind !== "install") { io.postResult(false, "Re-open the install to assist-install a tool."); return; }
    const decl = op.plugin.manifest.externalTools[toolName];
    if (!decl) { io.postResult(false, `No external tool '${toolName}' declared.`); return; }
    await this.runAssistedInstall(ws, toolName, decl.install, decl.manual, io);
  }

  /** spec 287 (D4) — the INSTALLED-CARD assisted install: resolve the requirement from the LOCKFILE (not a pending
   *  consent op), adapt its `Record<pm, string[]>` install map into the `{ argv }` shape, then run the SAME
   *  consent-gated machinery. Security is equivalent — buildAssistedInstall re-validates + re-normalizes the argv. */
  private async installExternalFromCardOp(ws: WorkspaceGitPresentationTarget, pluginName: string, toolName: string, io: PanelIO): Promise<void> {
    const lock = this.lockfile(ws);
    const plugin = lock?.plugins[pluginName];
    if (!plugin) { io.postResult(false, `Plugin '${pluginName}' is not installed.`); return; }
    const req = (plugin.externalTools ?? []).find((e) => e.name === toolName);
    if (!req) { io.postResult(false, `Plugin '${pluginName}' declares no external tool '${toolName}'.`); return; }
    // adapt the lockfile's `Record<pm, string[]>` to the `{ argv }` shape buildAssistedInstall expects (a pure,
    // unit-tested helper); buildAssistedInstall then re-validates + re-normalizes to trusted realpaths.
    await this.runAssistedInstall(ws, toolName, adaptLockedInstall(req.install), req.manual, io);
  }

  /** spec 285/287 — the shared privileged assisted-install: build the NORMALIZED argv (trusted realpaths), show the
   *  strong modal ack, run it argv-directly in a VISIBLE terminal (the OS owns the password prompt), guard against a
   *  duplicate in-flight install, and re-detect (re-post) when the terminal closes. Tachyon never sees the credential. */
  private async runAssistedInstall(ws: WorkspaceGitPresentationTarget, toolName: string, install: Partial<Record<PackageManager, ExternalToolInstall>>, manual: string, io: PanelIO): Promise<void> {
    const key = `${ws.wsHash}:${toolName}`;
    if (this.externalInstalling.has(key)) { notify(`An install of ${toolName} is already in progress — finish it in the terminal.`); return; }
    // buildAssistedInstall NORMALIZES the argv to trusted absolute realpaths (sudo + the package manager); a
    // declared/recorded path can never be the executed binary (codex BLOCKER).
    const ai = buildAssistedInstall(install);
    if (!ai.ok) { notify(`Cannot assist-install ${toolName}: ${ai.reason}. Manual: ${manual}`, "warn"); return; }
    const cmd = shellQuoteForDisplay(ai.argv);
    const ok = await showNotification(
      `Install ${toolName} via ${ai.pm}?`,
      "warn",
      ["Run in terminal"],
      { modal: true, detail: `Tachyon will run this in a terminal (your system package manager, possibly as root — your OS will prompt for your password, which Tachyon never sees). It is NOT a pinned/checksummed artifact and will NOT be auto-uninstalled.\n\n${cmd}` },
    );
    if (ok !== "Run in terminal") return;
    this.externalInstalling.add(key);
    // spawn the NORMALIZED argv directly (no shell): shellPath + shellArgs. The OS's sudo prompts in the terminal.
    const term = vscode.window.createTerminal({ name: `Install ${toolName}`, shellPath: ai.argv[0], shellArgs: ai.argv.slice(1), cwd: ws.workspaceRoot });
    // clear the in-flight lock + refresh the view (re-detect) when the install terminal closes — BOTH the installed
    // cards (io.post → gather) AND, if the assisted install was launched from the still-open install consent drawer,
    // the drawer itself (spec 287 follow-up: a freshly-installed tool must flip missing→present in the drawer too,
    // not only on the card — otherwise the drawer shows a stale "missing" and the user re-clicks fruitlessly).
    const sub = vscode.window.onDidCloseTerminal((t) => {
      if (t !== term) return;
      this.externalInstalling.delete(key);
      sub.dispose();
      io.post();
      void this.refreshInstallDrawer(ws, io);
    });
    term.show(true);
  }

  /** spec 287 follow-up — if an install consent drawer is still open (a pending install op), re-run previewInstall so
   *  its external-tool statuses re-detect (a tool just assist-installed flips missing→present) and re-post the consent.
   *  Mirrors `reselectOp` (re-preview + setPending + postConsent) so the held fingerprint stays consistent. No-op when
   *  the assisted install came from an installed card (no pending op) — that path is covered by io.post()/gather. */
  private async refreshInstallDrawer(ws: WorkspaceGitPresentationTarget, io: PanelIO): Promise<void> {
    const op = io.getPending();
    if (!op || op.kind !== "install") return;
    const present = detectRuntimes(ws.workspaceRoot);
    const target = new Set(op.preview.targetRuntimes);
    const gitState = await this.gitState(ws, op.plugin);
    const toolPlan = await this.toolPlan(op.plugin);
    const dataPlan = Object.keys(op.plugin.manifest.data).length > 0 ? await gatherDataPlan(op.plugin) : undefined;
    const preview = previewInstall(op.plugin, ws.workspaceRoot, target, gitState, toolPlan, dataPlan);
    io.setPending({ ...op, preview });
    io.postConsent(buildInstallConsent(preview, op.provenance, present));
  }

  /** spec 264 — gather the (async) git-hook state for a plugin that ships git-hooks; undefined otherwise. The
   *  sync `previewInstall` consumes it so the preview fingerprint matches what `applyInstall` recomputes. */
  private async gitState(ws: WorkspaceGitPresentationTarget, plugin: LoadedPlugin) {
    return plugin.gitHooks.length > 0 ? await gatherGitHookState(ws.workspaceRoot, plugin.gitHooks.map((g) => g.event), this.gitRun(ws)) : undefined;
  }

  /** spec 265 — gather the (async) tool plan for a plugin that declares tools; undefined otherwise. Injected into
   *  the sync `previewInstall` so the consent fingerprint matches what `applyInstall` re-derives. */
  private async toolPlan(plugin: LoadedPlugin) {
    return Object.keys(plugin.manifest.tools).length > 0 ? await gatherToolPlan(plugin) : undefined;
  }

  /** spec 265 — the extension-bundled launcher validator copied into a workspace on a tool install. */
  private launcherBundlePath(): string {
    return vscode.Uri.joinPath(this.extensionUri, "dist", "tool-launcher.cjs").fsPath;
  }

  /** spec 284 — the extension-bundled data-resolver copied into a workspace on a data install. */
  private dataResolverBundlePath(): string {
    return vscode.Uri.joinPath(this.extensionUri, "dist", "data-resolver.cjs").fsPath;
  }

  /** spec 285 — the extension-bundled external-tool resolver copied into a workspace when a plugin declares external tools. */
  private externalResolverBundlePath(): string {
    return vscode.Uri.joinPath(this.extensionUri, "dist", "external-resolver.cjs").fsPath;
  }

  /** spec 263 — re-preview the pending install for a new runtime selection (host-owned recompute on each drawer
   *  toggle), re-posting consent with the fresh fingerprint. Selection is intersected with the declared runtimes. */
  private async reselectOp(ws: WorkspaceGitPresentationTarget, runtimes: string[], io: PanelIO): Promise<void> {
    const op = io.getPending();
    if (!op || op.kind !== "install") return;
    const present = detectRuntimes(ws.workspaceRoot);
    const target = new Set(op.plugin.manifest.runtimes.filter((rt) => runtimes.includes(rt)));
    const gitState = await this.gitState(ws, op.plugin);
    const toolPlan = await this.toolPlan(op.plugin);
    const dataPlan = Object.keys(op.plugin.manifest.data).length > 0 ? await gatherDataPlan(op.plugin) : undefined;
    const preview = previewInstall(op.plugin, ws.workspaceRoot, target, gitState, toolPlan, dataPlan);
    io.setPending({ ...op, preview });
    io.postConsent(buildInstallConsent(preview, op.provenance, present));
  }

  private async previewUpdateOp(ws: WorkspaceGitPresentationTarget, name: string, io: PanelIO, forceReinstall: boolean): Promise<void> {
    const lock = this.lockfile(ws);
    const entry = lock?.plugins[name];
    if (!entry?.source) {
      io.postResult(false, `'${name}' has no recorded source to re-resolve — reinstall by source instead.`);
      return;
    }
    // spec 266 — for a genuine update, resolve the effective spec (bump a semver-tag pin to a higher repo tag)
    // BEFORE loading, so the held provenance + consent drawer carry the bumped tag and the confirm re-pins the
    // lockfile to it. A forced REINSTALL repairs drift at the CURRENT pin, so it must NOT bump (no silent upgrade).
    const effectiveSpec = forceReinstall ? entry.source.spec : await resolveEffectiveUpdateSpec(entry.source.spec, this.gitRun(ws));
    io.postBusy(`Resolving ${effectiveSpec}…`);
    let loaded;
    try {
      loaded = await loadPluginFromSource(effectiveSpec, this.gitRun(ws));
    } catch (e) {
      io.postResult(false, `Could not resolve '${effectiveSpec}': ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!loaded.plugin) {
      io.postResult(false, `Could not load '${entry.source.spec}': ${loaded.errors.join("; ")}`);
      return;
    }
    const preview = await previewUpdate(loaded.plugin, ws.workspaceRoot, this.gitRun(ws));
    const force = forceReinstall || preview.conflicts.length > 0 || preview.isDowngrade;
    const present = detectRuntimes(ws.workspaceRoot); // hint only — labels the (fixed) update runtime rows
    io.setPending({ kind: "update", plugin: loaded.plugin, provenance: loaded.provenance, force, fingerprint: preview.install?.fingerprint ?? "" });
    io.postConsent(buildUpdateConsent(preview, loaded.provenance, forceReinstall, present));
  }

  private async previewRemoveOp(ws: WorkspaceGitPresentationTarget, name: string, io: PanelIO): Promise<void> {
    const lock = this.lockfile(ws);
    const version = lock?.plugins[name]?.version ?? "";
    const preview = previewRemove(name, ws.workspaceRoot);
    io.setPending({ kind: "remove", name, fingerprint: preview.fingerprint });
    io.postConsent(buildRemoveConsent(name, version, preview));
  }

  /** Apply the held op (token-matched) — the engine apply re-previews + lost-update-guards before writing. */
  private async confirmOp(ws: WorkspaceGitPresentationTarget, token: string, skillDecisions: Record<string, "keep" | "replace">, mcpDecisions: Record<string, "keep" | "replace">, mcpConfirmed: boolean, gitHookConfirmed: boolean, toolConfirmed: boolean, dataConfirmed: boolean, viewConfirmed: boolean, fleetReadConfirmed: boolean, actionConfirmed: Record<string, boolean>, io: PanelIO): Promise<void> {
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
      const r = await applyInstall(op.plugin, op.preview, ws.workspaceRoot, new Set(op.preview.targetRuntimes), { provenance: op.provenance, skillDecisions, mcpDecisions, mcpConfirmed, gitHookConfirmed, toolConfirmed, launcherBundlePath: this.launcherBundlePath(), dataConfirmed, dataResolverBundlePath: this.dataResolverBundlePath(), externalResolverBundlePath: this.externalResolverBundlePath(), viewConfirmed, fleetReadConfirmed, actionConfirmed: trueActions(actionConfirmed), onProgress: (p) => io.postBusy(progressBusyLabel(p)), git: this.gitRun(ws) });
      const into = r.runtimes.length > 0 ? ` into ${r.runtimes.join(", ")}` : "";
      io.postResult(r.installed, r.installed ? `Installed ${op.plugin.manifest.name}${into}.` : r.errors.join("; "));
      // spec 270 — a configurable plugin: take the human straight to its config right after a successful install.
      if (r.installed) await this.openConfigFile(ws, op.plugin.manifest.name);
    } else if (op.kind === "update") {
      if (op.fingerprint !== token) { io.postResult(false, "Consent expired — re-open the update."); return; }
      // spec 270 — capture whether config existed BEFORE the update (the apply rewrites the lockfile below).
      const hadConfigBefore = !!this.lockfile(ws)?.plugins[op.plugin.manifest.name]?.config;
      const r = await applyUpdate(op.plugin, ws.workspaceRoot, { force: op.force, provenance: op.provenance, expectedFingerprint: token, skillDecisions, mcpDecisions, mcpConfirmed, gitHookConfirmed, toolConfirmed, launcherBundlePath: this.launcherBundlePath(), dataConfirmed, dataResolverBundlePath: this.dataResolverBundlePath(), externalResolverBundlePath: this.externalResolverBundlePath(), viewConfirmed, fleetReadConfirmed, actionConfirmed: trueActions(actionConfirmed), onProgress: (p) => io.postBusy(progressBusyLabel(p)), git: this.gitRun(ws) });
      io.postResult(r.updated, r.updated ? `Updated ${op.plugin.manifest.name}.` : (r.upToDate ? "Already up to date." : r.errors.join("; ")));
      // spec 270 — only when an update INTRODUCES config (absent before, present now) do we open it, treating that
      // first appearance like a fresh install. A plain update of an already-configurable plugin must NOT re-open
      // (noise + a false "did the update touch my config?" signal — the update preserves the human's edits).
      if (r.updated && !hadConfigBefore && op.plugin.manifest.config) await this.openConfigFile(ws, op.plugin.manifest.name);
    } else {
      if (op.fingerprint !== token) { io.postResult(false, "Consent expired — re-open the remove."); return; }
      const r = await applyRemove(op.name, ws.workspaceRoot, { expectedFingerprint: token, git: this.gitRun(ws) });
      io.postResult(r.removed, r.removed ? `Removed ${op.name}${r.orphans > 0 ? ` (${r.orphans} edited group(s) left as orphans)` : ""}.` : r.errors.join("; "));
    }
    io.setChecks({}); // applied state changed → drop stale checks
    this.onPluginsChanged();
    io.post();
  }

  /** spec 265 — re-provision the workspace's tools from the committed lockfile (clone/CI where `.tachyon/bin`
   *  is gitignored). Explicit + user-triggered; re-resolves Node + re-materializes the launcher; never a silent fetch. */
  private async rehydrateOp(ws: WorkspaceGitPresentationTarget, io: PanelIO): Promise<void> {
    io.postBusy("Rehydrating tools…");
    const onProgress = (p: ProvisionProgress) => io.postBusy(progressBusyLabel(p));
    const r = await rehydrateTools(ws.workspaceRoot, { launcherBundlePath: this.launcherBundlePath(), onProgress });
    const rd = await rehydrateData(ws.workspaceRoot, { resolverBundlePath: this.dataResolverBundlePath(), onProgress }); // spec 284 — re-fetch DATA blobs + re-materialize the _tachyon-data shim
    const re = rehydrateExternalResolver(ws.workspaceRoot, { resolverBundlePath: this.externalResolverBundlePath() }); // spec 285 — restore the _tachyon-external shim on a clone
    const errs = [...r.errors, ...rd.errors, ...re.errors];
    io.postResult(errs.length === 0, errs.length === 0 ? `Rehydrated ${r.rehydrated} tool(s)${rd.rehydrated > 0 ? ` + ${rd.rehydrated} data artifact(s)` : ""}${re.materialized ? " + external resolver" : ""}.` : errs.join("; "));
    io.setChecks({});
    io.post();
  }

  private gitRun(ws: WorkspaceGitPresentationTarget): GitRun {
    return (args, cwd) => ws.gitExec(args, cwd ?? ws.workspaceRoot);
  }

  /** spec 264 — re-claim core.hooksPath after a clone whose managed git-hook state is intact but hooksPath
   *  drifted. Explicit + consent-gated by the user clicking Repair; never auto-claimed. */
  private async repairOp(ws: WorkspaceGitPresentationTarget, io: PanelIO): Promise<void> {
    const r = await repairGitHooks(ws.workspaceRoot, this.gitRun(ws));
    io.postResult(r.repaired, r.repaired ? `Re-activated git-hooks (${r.reason}).` : `Nothing to repair: ${r.reason}.`);
    io.setChecks({});
    io.post();
  }

  /** spec 270 — open a plugin's human-owned config file in an editor (the Config button + post-install nav).
   *  Returns whether a config file was opened (absent config → false, no-op). */
  private async openConfigFile(ws: WorkspaceGitPresentationTarget, name: string): Promise<boolean> {
    const cfg = this.lockfile(ws)?.plugins[name]?.config;
    if (!cfg) return false;
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(ws.workspaceRoot, cfg.file)), { preview: false });
      return true;
    } catch {
      return false;
    }
  }

  /** spec 270 — open a plugin's docs URL externally. https-guarded AT CLICK (defense in depth over manifest parse). */
  private async openDocs(ws: WorkspaceGitPresentationTarget, name: string): Promise<void> {
    const url = this.lockfile(ws)?.plugins[name]?.docsUrl;
    if (typeof url === "string" && /^https:\/\//.test(url)) await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  /** Parse the committed lockfile (best-effort; undefined on absence/corruption — callers degrade gracefully). */
  private lockfile(ws: WorkspaceGitPresentationTarget): { plugins: Record<string, PluginLock> } | undefined {
    try {
      const { lockfile } = parseLockfile(fs.readFileSync(path.join(ws.workspaceRoot, LOCKFILE_REL_PATH), "utf8"));
      return lockfile;
    } catch {
      return undefined;
    }
  }

  /** Assemble the render-ready model: present runtimes + the committed lockfile + any update-checks → VM.
   *  Update-checks are LAZY (the user runs "Check for updates"); absent ⇒ every status is `unknown`. */
  private gather(ws: WorkspaceGitPresentationTarget, updateChecks: Record<string, UpdateCheck>): PluginsViewModel {
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
    return buildPluginsViewModel({ lockfileText, present, intact: this.intactRuntimes(ws), updateChecks, externalStatuses: this.externalStatuses(ws) });
  }

  /** spec 287 (D3) — per installed plugin, its declared external (system) tools with present/missing + whether an
   *  assisted install is offered. SPAWN-FREE: `detectExternalToolPresence` resolves on the clean PATH in JS (no
   *  `command -v` subprocess, no detect probe), and each unique tool is resolved at most once per gather (the
   *  storm guard). Recomputed every gather, so install/remove/refresh/terminal-close naturally re-detect (D5). */
  private externalStatuses(ws: WorkspaceGitPresentationTarget): Record<string, ExternalToolVM[]> {
    const lock = this.lockfile(ws);
    if (!lock) return {};
    // dedupe per UNIQUE candidate SET within this gather (many plugins can declare ffmpeg) — the storm guard. Keyed by
    // name + the candidate names (spec 289: presence depends on the candidate set, not just the name). The pure mapping
    // lives in `buildExternalStatuses` (unit-tested); this thin glue supplies the spawn-free presence oracle (D7).
    const presenceCache = new Map<string, ExternalPresenceResult>();
    const resolve = (req: ExternalToolReqLock): ExternalPresenceResult => {
      const key = `${req.name}\0${(req.names ?? []).join("\0")}`;
      const hit = presenceCache.get(key);
      if (hit !== undefined) return hit;
      const det = detectExternalToolPresence(req.name, req.names ? { names: req.names } : {});
      const r: ExternalPresenceResult = det.present ? { present: true, path: det.path } : { present: false };
      presenceCache.set(key, r);
      return r;
    };
    return buildExternalStatuses(Object.values(lock.plugins), resolve);
  }

  /** spec 263 — per installed plugin, the runtimes whose recorded materialization is still INTACT on disk: a
   *  runtime is intact iff every target it recorded (settings file / skill dir / mcp config) still exists. This
   *  is the honest "installed & present" signal for the card pills — unlike `detectRuntimes`, it is correct for
   *  a skills-only install that lands in `.agents/skills/` and never creates a `.codex/` dir. */
  private intactRuntimes(ws: WorkspaceGitPresentationTarget): Record<string, Runtime[]> {
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

  /** Re-post to the Control embed (cheap; no-op when Plugins isn't the active section). */
  refreshAll(): void {
    this.embed?.post();
  }

  /**
   * Control monolith: drive Plugins UI into an existing webview (no separate panel).
   * Posts the same plugins/consent/busy/result envelope the standalone panel uses.
   *
   * IDEMPOTENT for the same webview + workspace (t-0fc9ee): the shell's 3s poll routes through
   * here on every tick, and the session state below (checks/pending/busy) is closure-owned — a
   * blind rebind wiped a just-found update check, orphaned a pending consent drawer (confirmOp
   * finds no pending and silently returns), and forgot the busy guard. Data refresh must never
   * recreate the session; a NEW session is created only on first entry, a real workspace switch,
   * or a replaced webview (leaving the section unbinds — see unbindControlEmbed).
   */
  bindControlEmbed(webview: vscode.Webview, wsHash?: string): void {
    const ws = wsHash === undefined ? this.getWorkspaces()[0] : this.getWorkspaces().find((w) => w.wsHash === wsHash);
    if (!ws) return;
    if (this.embed && this.embed.webview === webview && this.embed.ws.wsHash === ws.wsHash) {
      this.embed.post();
      return;
    }
    let checks: Record<string, UpdateCheck> = {};
    let pending: PendingOp | undefined;
    let busy = false;
    const post = (): void => {
      void webview.postMessage(pluginsMessage(this.gather(ws, checks)));
    };
    const io: PanelIO = {
      post,
      postConsent: (vm) => void webview.postMessage(consentMessage(vm)),
      postBusy: (label) => void webview.postMessage(busyMessage(label)),
      postResult: (ok, message) => void webview.postMessage(resultMessage(ok, message)),
      getPending: () => pending,
      setPending: (p) => { pending = p; },
      getChecks: () => checks,
      setChecks: (c) => { checks = c; },
      isBusy: () => busy,
      setBusy: (b) => { busy = b; },
    };
    this.embed = { webview, ws, io, post };
    post();
  }

  unbindControlEmbed(): void {
    this.embed = undefined;
  }

  /** Forward one inbound message to the Control embed session (if bound). */
  handleControlEmbedMessage(m: InboundMsg): boolean {
    const emb = this.embed;
    if (!emb) return false;
    void this.onMessage(emb.ws, m, emb.io);
    return true;
  }

  refreshControlEmbed(): void {
    this.embed?.post();
  }

  dispose(): void {
    this.embed = undefined;
  }
}
