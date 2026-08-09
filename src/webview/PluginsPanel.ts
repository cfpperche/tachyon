import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkspaceGitPresentationTarget } from "../shell/WorkspacePresentation.js";
import {
  SectionPanelManager,
  type SectionAppConfig,
  type SectionPanelState,
  type SectionPanelTarget,
} from "./shared/SectionPanelManager.js";
import { webviewApp, type WebviewAppEntry } from "./webviewApps.js";
import type { ControlWorkspaceScope } from "./shared/ControlWorkspaceScope.js";
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
  MANIFEST_REL,
  PAYLOAD_ROOT,
  type LoadedPlugin,
  type InstallPreview,
  type InstallProvenance,
} from "../plugins/engine.js";
import { loadManifest, SUPPORTED_RUNTIMES, type Runtime, type PackageManager, type ExternalToolInstall } from "../plugins/manifest.js";
import { pluginsMessage, consentMessage, busyMessage, resultMessage, POLL, READY, type PluginsActionType } from "./plugins/messages.js";
import { gatherGitHookState } from "../plugins/gitHookState.js";
import type { GitRun } from "../plugins/fetcher.js";
import { gatherToolPlan } from "../plugins/toolPlan.js";
import { gatherDataPlan } from "../plugins/dataPlan.js";
import { buildAssistedInstall, shellQuoteForDisplay, detectExternalToolPresence, adaptLockedInstall } from "../plugins/externalTool.js";
import { rehydrateTools, rehydrateData, rehydrateExternalResolver, type ProvisionProgress } from "../plugins/toolProvisionRun.js";
import { notify, showNotification } from "../workspace/NotificationService.js";
import { parseLockfile, LOCKFILE_REL_PATH, type PluginLock, type ExternalToolReqLock } from "../plugins/lockfile.js";
import { buildPluginsViewModel, buildExternalStatuses, type PluginsViewModel, type UpdateCheck, type ExternalToolVM, type ExternalPresenceResult } from "../plugins/viewModel.js";
import { buildInstallConsent, buildReinstallConsent, buildUpdateConsent, buildRemoveConsent, deriveUpdateCheck, type ConsentVM } from "../plugins/consentViewModel.js";

/**
 * The viewType, and it is the RETIRED one on purpose — the fourth call in this spec's series, and the one
 * that makes the rule readable. C4 REUSED `tachyonTaskDetail` and paid a two-field rename for it; C5 could
 * NOT reuse the retired Board viewType; D1 reused `tachyonServerInspector` for free.
 *
 * The question that decides it is not "was the tombstone a redirect" — all three were — but **does the id
 * still NAME this app, and does its legacy record map onto this app's key with no residue?** For the Board
 * the answer was no on the first half: the product screen is called the Board, its manifest row is
 * `{view: "board", viewId: "tachyonBoard"}`, and the retired Board viewType names a screen that no
 * longer exists under that name. Here both halves are yes — the app IS Plugins, its bundle directory IS
 * `plugins`, and the pre-410 panel's one scoping field (`wsHash`) is exactly the one field a `dashboard`
 * key is made of. So `migrateLegacy` renames it and the panel VS Code hands back is REUSED: a window
 * closed since before 410 gets its Plugins tab back rather than watching one close and another open, and
 * there is no second viewType left behind for a future reader to keep in sync.
 */
export const PLUGINS_VIEW_TYPE = "tachyonPlugins";

/**
 * The persisted shape the STANDALONE panel wrote before SDD 410 retired it. It is not what this app
 * persists — `SectionPanelManager` writes `project` — but the viewType is the same, so a window that has
 * been closed since before 410 can still hand us one of these. `migrateLegacy` below is the whole of the
 * compatibility shim, and it has no UI: it translates ONE field name.
 */
export interface PluginsPanelState {
  schemaVersion: 1;
  view: typeof PLUGINS_VIEW_TYPE;
  wsHash: string;
}

/** the one invalidation kind this app knows: "the plugin state you are showing may be stale". */
type PluginsRefreshKind = "plugins";

/** The op the user is consenting to — held host-side between preview and confirm (the apply re-checks TOCTOU). */
type PendingOp =
  | { kind: "install"; plugin: LoadedPlugin; preview: InstallPreview; provenance?: InstallProvenance; reinstall?: boolean }
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

/** Replace only the ref portion of a validated lockfile source spec, preserving an optional monorepo subdir. */
export function sourceSpecAtCommit(spec: string, commit: string): string {
  const hash = spec.indexOf("#");
  const fragment = hash >= 0 ? spec.slice(hash) : "";
  const base = hash >= 0 ? spec.slice(0, hash) : spec;
  return `${base.slice(0, base.lastIndexOf("@") + 1)}${commit}${fragment}`;
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
 * spec 250 → spec 410 (t-d23f93) → SDD 485 D2 — the Plugins app, and the second Phase D migration.
 *
 * Originally the editor-area Plugins View panel manager (one WebviewPanel per workspace root); SDD 410
 * Phase B retired it into a Control section; this phase reverses that retirement onto the generic
 * `SectionPanelManager`, so Plugins is once again its own editor tab — and can therefore sit BESIDE the
 * agent terminal whose plugin it is about, which is the capability ceiling `spec.md` reversed the app
 * count for.
 *
 * ## Why `dashboard`, and why that is not the same question D1 asked
 *
 * A dashboard is one panel per section PER PROJECT, and a plugin install is a per-workspace fact all the
 * way down: the lockfile is `<workspaceRoot>/.tachyon/plugins-lock.json`, `detectRuntimes` reads that
 * root, and every apply below writes into it. Two attached projects genuinely have two different plugin
 * sets, so two panels showing two answers is the CORRECT outcome — the opposite of tmux (D1), whose
 * socket is one per user and whose model includes sessions owned by workspaces this window never opened.
 * That is what made tmux a `window` app and makes this one the dashboard the spec always expected.
 *
 * ## What this file owns, and what it does not
 *
 * The key (`viewId | project`), reveal-on-reopen, the shared shell, the persisted state, revive, and the
 * `PanelWorkGate` that makes a hidden panel do no work and a revealed one never stale all belong to
 * `SectionPanelManager`. What is left here is the domain, unchanged by the move: the HOST gathers the
 * model (detectRuntimes + committed lockfile + buildPluginsViewModel — all I/O lives here) and routes the
 * interactive surface (install-by-source, the BLOCKING consent drawer, apply actions with TOCTOU
 * re-checks, lazy update-checks; async ops serialized by a busy flag). The Preact webview renders it and
 * never imports vscode/engine.
 *
 * ## The session state became PER PANEL, and that was a latent singleton assumption
 *
 * `checks` / `pending` / `busy` lived in one closure because the Control embed was one session — "one at
 * a time" was its own comment, true of a singleton and false of a dashboard. They live inside `bind` now,
 * which is per panel by construction. This is C4's tombstone-cache finding arriving in the shape notes.md
 * predicted for the whole of Phase D: with two projects open, a shared `pending` would let project A's
 * consent drawer be confirmed by project B's token, and a shared `busy` would make one project's clone
 * silently swallow the other's click.
 *
 * ## Hidden work
 *
 * Two doors reach this app and both are gated by construction: the client's own 3s poll (claimed by
 * `pluginsRefreshKind`, so the gate answers it host-side whatever timer a client version runs) and every
 * `session.post`. There is no fan-out door — nothing in the extension host emits a `views-changed` for
 * plugins, inside Control or outside it; the lockfile is read on demand, not watched. `refresh()` exists
 * for a caller that does not yet exist, and `markSourceResync()` for the same reason.
 */
export class PluginsPanelManager {
  private readonly manager: SectionPanelManager<PluginsRefreshKind>;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getWorkspaces: () => WorkspaceGitPresentationTarget[],
    private readonly onPluginsChanged: () => void = () => undefined,
    app: WebviewAppEntry = webviewApp("plugins"),
    workspaceScope?: ControlWorkspaceScope,
  ) {
    this.manager = new SectionPanelManager<PluginsRefreshKind>(extensionUri, this.configFor(app), workspaceScope);
  }

  /** Open Plugins for one project, or REVEAL the panel already open for it. */
  open(project: string): void {
    this.manager.open({ project });
  }

  openInCurrentScope(): boolean {
    return this.manager.openInCurrentScope();
  }

  /** The fan-out door, for a caller that has one. Returns how many panels actually did work. */
  refresh(): number {
    return this.manager.refresh("plugins");
  }

  /** the upstream event cursor expired: every hidden panel rebuilds instead of replaying on reveal. */
  markSourceResync(): void {
    this.manager.markSourceResync();
  }

  /**
   * Revive a panel VS Code restored across a window reload. Accepts BOTH this app's own persisted state
   * and the pre-410 standalone panel's `{wsHash}` — same viewType, so both can arrive here, and a legacy
   * record deserves the project it named rather than a disposed tab.
   */
  deserialize(panel: vscode.WebviewPanel, state: SectionPanelState | PluginsPanelState): void {
    this.manager.deserialize(panel, migrateLegacy(state));
  }

  get openKeys(): string[] {
    return this.manager.openKeys;
  }

  private workspaceFor(target: SectionPanelTarget): WorkspaceGitPresentationTarget | undefined {
    // STRICT, exactly as the Board's is (C5): the project IS half this panel's key, so resolving it
    // loosely would let two panels land on one workspace under different keys, or let a panel silently
    // retarget when the sidebar's project selector moves. A project that is no longer attached says so;
    // it never borrows another project's plugins — which for a surface that INSTALLS things would not be
    // a cosmetic error.
    return this.getWorkspaces().find((w) => w.wsHash === target.project);
  }

  private configFor(app: WebviewAppEntry): SectionAppConfig<PluginsRefreshKind> {
    return {
      app,
      // The exact sheets, in the same order, Control linked while Plugins was its active section
      // (`pluginsIsActive ? …` pair, after the three shell-wide ones) — minus `vscode-theme.css`, which
      // Control links for every section and this surface never used a rule from.
      //
      // No `page-frame.css`, and that is a measured claim rather than an omission: `plugins.css` gives
      // `#root` no height and styles no page frame, so this surface page-scrolls like the task detail and
      // the inspector rather than filling its tab in bounded regions. Linking the frame here would fail
      // `webviewConvention.test.ts`'s mirror rule (a sheet linked without being anchored to), and
      // `overflow: hidden` is the wrong frame for a document that scrolls.
      //
      // What DID have to move is the page PAD: `.ck-plugins-root`'s `--ds-page-pad-*` rule lived in
      // `cockpit.css`, so this app would have rendered flush to the tab edge. It is `plugins.css`'s own
      // rule now — the same class of trap as t-32c872, one property over, and the one the Phase A
      // consumption check cannot see because it reads `#root` height chains and not padding.
      styleFiles: ["codicon.css", "design-system.css", "plugins.tailwind.css", "plugins.css"],
      title: () => vscode.l10n.t("Plugins"),
      refreshKindFor: pluginsRefreshKind,
      bind: (session) => {
        // PER PANEL, not per manager — see this class's doc comment. Two projects are two panels, two
        // consent drawers and two busy guards, and nothing about one may reach the other.
        let checks: Record<string, UpdateCheck> = {};
        let pending: PendingOp | undefined;
        let busy = false;
        const post = (): void => {
          const ws = this.workspaceFor(session.target);
          if (!ws) {
            session.post(resultMessage(false, `No Tachyon workspace attached for this Plugins panel (${session.target.project}).`));
            return;
          }
          session.post(pluginsMessage(this.gather(ws, checks)));
        };
        const io: PanelIO = {
          post,
          postConsent: (vm) => { session.post(consentMessage(vm)); },
          postBusy: (label) => { session.post(busyMessage(label)); },
          postResult: (ok, message) => { session.post(resultMessage(ok, message)); },
          getPending: () => pending,
          setPending: (p) => { pending = p; },
          getChecks: () => checks,
          setChecks: (c) => { checks = c; },
          isBusy: () => busy,
          setBusy: (b) => { busy = b; },
        };
        return {
          // `replay` and `resync` do the same work, and that is a property of the surface rather than an
          // oversight: the model is a full read of one workspace's lockfile and runtimes, so there is
          // nothing a delta could carry that a rebuild does not. What the gate's distinction still
          // decides is how MANY of these run after a burst — one, either way. (Same shape as the Board's
          // and the inspector's, and for the same reason.)
          replay: () => { post(); },
          resync: () => { post(); },
          onMessage: (raw) => {
            const ws = this.workspaceFor(session.target);
            if (!ws) {
              session.post(resultMessage(false, `No Tachyon workspace attached for this Plugins panel (${session.target.project}).`));
              return;
            }
            void this.onMessage(ws, raw as InboundMsg, io);
          },
        };
      },
    };
  }

  /** Route one inbound webview message. Network/apply ops are serialized by a `busy` flag (one at a time). */
  private async onMessage(ws: WorkspaceGitPresentationTarget, m: InboundMsg, io: PanelIO): Promise<void> {
    // `ready` and `poll` never arrive here — `pluginsRefreshKind` claims them for the gate — so
    // everything below is an action on a panel someone is looking at.
    switch (m.type) {
      case "refresh":
        // The human pressing Refresh, and it means MORE than a re-gather: it drops every update check
        // found so far, so the cards go back to `unknown` and the next "Check for updates" re-resolves
        // from scratch. The 3s poll deliberately does NOT arrive here — see `POLL` in plugins/messages.ts.
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
        if (m.name) await this.guard(io, () => this.previewReinstallOp(ws, m.name as string, io));
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
      // t-4e5f11 — pass payload hash so same-version content drift is visible on the card.
      return deriveUpdateCheck(await previewUpdate(loaded.plugin, ws.workspaceRoot, this.gitRun(ws), {
        payloadHash: loaded.provenance?.integrity.payload,
      }));
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

  /** Reinstall is a fresh, consent-gated install over the current materialization, not an update. It deliberately
   * selects every runtime declared by the pinned payload, repairing runtime-set gaps left by older installs.
   *
   * Supply-chain decision: fetch the lockfile's resolved commit, rather than re-resolving its human-readable ref.
   * A tag can move; reinstall means re-materialize the exact bytes already approved, while Update remains the
   * explicit door for resolving newer bytes. We restore the original source spec in provenance so the next Update
   * still tracks the same ref; the drawer separately displays the concrete resolved commit.
   *
   * Availability decision: this goes straight through applyInstall. It never removes the existing plugin first;
   * applyInstall stages and verifies the payload before promotion and activates settings last, so a resolve,
   * preflight, provision, or consent failure leaves the existing Claude/Codex enforcement in place.
   */
  private async previewReinstallOp(ws: WorkspaceGitPresentationTarget, name: string, io: PanelIO): Promise<void> {
    const entry = this.lockfile(ws)?.plugins[name];
    if (!entry?.source) { io.postResult(false, `'${name}' has no recorded source to reinstall.`); return; }
    const pinnedSpec = sourceSpecAtCommit(entry.source.spec, entry.source.resolvedCommit);
    io.postBusy(`Resolving ${entry.source.resolvedCommit.slice(0, 12)}…`);
    let loaded;
    try {
      loaded = await loadPluginFromSource(pinnedSpec, this.gitRun(ws));
    } catch (e) {
      io.postResult(false, `Could not resolve '${entry.source.spec}' at ${entry.source.resolvedCommit.slice(0, 12)}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!loaded.plugin || !loaded.provenance) {
      io.postResult(false, `Could not load '${entry.source.spec}' at ${entry.source.resolvedCommit.slice(0, 12)}: ${loaded.errors.join("; ")}`);
      return;
    }
    // Keep the update-facing spec/ref, but retain the freshly verified integrity and exact commit.
    const provenance: InstallProvenance = { ...loaded.provenance, source: entry.source };
    const present = detectRuntimes(ws.workspaceRoot);
    const target = new Set(loaded.plugin.manifest.runtimes);
    const gitState = await this.gitState(ws, loaded.plugin);
    const toolPlan = await this.toolPlan(loaded.plugin);
    const dataPlan = Object.keys(loaded.plugin.manifest.data).length > 0 ? await gatherDataPlan(loaded.plugin) : undefined;
    const preview = previewInstall(loaded.plugin, ws.workspaceRoot, target, gitState, toolPlan, dataPlan);
    io.setPending({ kind: "install", plugin: loaded.plugin, preview, provenance, reinstall: true });
    io.postConsent(buildReinstallConsent(preview, provenance, present));
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
    io.postConsent(op.reinstall ? buildReinstallConsent(preview, op.provenance, present) : buildInstallConsent(preview, op.provenance, present));
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
    // t-4e5f11 — pass payload hash so same-version content change builds a plan instead of "already up to date".
    const preview = await previewUpdate(loaded.plugin, ws.workspaceRoot, this.gitRun(ws), {
      payloadHash: loaded.provenance?.integrity.payload,
    });
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
      const verb = op.reinstall ? "Reinstalled" : "Installed";
      io.postResult(r.installed, r.installed ? `${verb} ${op.plugin.manifest.name}${into}.` : r.errors.join("; "));
      // spec 270 — a configurable plugin: take the human straight to its config right after a successful install.
      if (r.installed) await this.openConfigFile(ws, op.plugin.manifest.name);
    } else if (op.kind === "update") {
      if (op.fingerprint !== token) { io.postResult(false, "Consent expired — re-open the update."); return; }
      // spec 270 — capture whether config existed BEFORE the update (the apply rewrites the lockfile below).
      const hadConfigBefore = !!this.lockfile(ws)?.plugins[op.plugin.manifest.name]?.config;
      const r = await applyUpdate(op.plugin, ws.workspaceRoot, { force: op.force, provenance: op.provenance, expectedFingerprint: token, skillDecisions, mcpDecisions, mcpConfirmed, gitHookConfirmed, toolConfirmed, launcherBundlePath: this.launcherBundlePath(), dataConfirmed, dataResolverBundlePath: this.dataResolverBundlePath(), externalResolverBundlePath: this.externalResolverBundlePath(), viewConfirmed, fleetReadConfirmed, actionConfirmed: trueActions(actionConfirmed), onProgress: (p) => io.postBusy(progressBusyLabel(p)), git: this.gitRun(ws) });
      // t-4e5f11 — toast true about version AND the world: Reapplied@vX when content changed under same version.
      const okMsg = r.contentChangedSameVersion
        ? `Reapplied ${op.plugin.manifest.name}@${op.plugin.manifest.version}.`
        : `Updated ${op.plugin.manifest.name}.`;
      const failMsg = r.upToDate
        ? "Already up to date."
        : (r.errors.length > 0 ? r.errors.join("; ") : "No change applied.");
      io.postResult(r.updated, r.updated ? okMsg : failMsg);
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
    return buildPluginsViewModel({ lockfileText, present, intact: this.intactRuntimes(ws), updateChecks, externalStatuses: this.externalStatuses(ws), declared: this.declaredRuntimes(ws) });
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

  /** t-fb216a — per installed plugin, the runtimes its INSTALLED payload manifest declares support for. Read from
   *  `.tachyon/plugins/<name>/tachyon-plugin.json`: the exact bytes this install materialized, which is also what
   *  Reinstall re-materializes (it fetches the lockfile's recorded commit), so the card's notice and the gesture it
   *  points at read the same manifest. Local, spawn-free, no network — which is why the coverage gap surfaces at
   *  REST rather than only after the user runs "Check for updates".
   *
   *  A plugin is OMITTED (not defaulted) when its manifest is absent, unreadable, or invalid: the view-model then
   *  computes no gap for it. Absence of evidence must not become a claim that a runtime is uncovered. */
  private declaredRuntimes(ws: WorkspaceGitPresentationTarget): Record<string, Runtime[]> {
    const lock = this.lockfile(ws);
    const supported = new Set<string>(SUPPORTED_RUNTIMES);
    const out: Record<string, Runtime[]> = {};
    for (const p of Object.values(lock?.plugins ?? {})) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(ws.workspaceRoot, PAYLOAD_ROOT, p.name, MANIFEST_REL), "utf8");
      } catch {
        continue; // no payload manifest ⇒ no evidence ⇒ no gap claimed for this plugin
      }
      const { manifest } = loadManifest(text);
      if (!manifest) continue; // invalid manifest — same rule: stay silent rather than guess
      out[p.name] = manifest.runtimes.filter((rt) => supported.has(rt));
    }
    return out;
  }

  dispose(): void {
    this.manager.dispose();
  }
}

/**
 * The ONE place that decides whether an inbound message is the client asking for work: the shell's SHARED
 * `ready` handshake and the app's own 3s `poll`. A string compare the HOST does — never a promise the
 * client keeps — which is what makes the gate hold whatever timer a client version happens to run.
 * Exported so the rule is testable without a panel.
 *
 * `refresh` is deliberately NOT here: it is a human pressing a button on a panel someone is looking at,
 * and it carries a side effect (dropping the update checks) that a periodic re-gather must not have.
 */
export function pluginsRefreshKind(message: unknown): PluginsRefreshKind | undefined {
  if (!message || typeof message !== "object") return undefined;
  const type = (message as { type?: unknown }).type;
  return type === READY || type === POLL ? "plugins" : undefined;
}

/**
 * The pre-410 standalone panel's state, translated into this app's. ONE field renamed — a compatibility
 * shim with NO UI, which is the one kind `spec.md` allows to survive a cutover. Anything already in the
 * new shape passes through untouched, and a record with neither field migrates to an EMPTY project, which
 * `sectionPanelKey` refuses — so the panel is disposed, the same outcome the serializer already gives an
 * unreadable state.
 */
function migrateLegacy(state: SectionPanelState | PluginsPanelState): SectionPanelState {
  if (typeof (state as Partial<SectionPanelState>).project === "string") return state as SectionPanelState;
  const legacy = state as Partial<PluginsPanelState>;
  return {
    schemaVersion: 1,
    view: PLUGINS_VIEW_TYPE,
    project: typeof legacy.wsHash === "string" ? legacy.wsHash : "",
  };
}
