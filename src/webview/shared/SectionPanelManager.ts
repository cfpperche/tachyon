import * as vscode from "vscode";
import { renderWebviewShell, type ShellExtensionPoint } from "./shell.js";
import { panelIcon } from "./panelIcon.js";
import { PanelWorkGate, panelVisibility } from "./panelWorkGate.js";
import type { TrustedPanelState } from "./panelSerializer.js";
import type { SectionAppCardinality, WebviewAppEntry } from "../webviewApps.js";
import type { ControlWorkspaceScope } from "./ControlWorkspaceScope.js";

/**
 * SDD 485 Phase C — ONE panel manager for every standalone section app, configured from a manifest entry
 * (`webviewApps.ts`), keyed by `viewId + project + identity`, with CARDINALITY AS A PARAMETER.
 *
 * The alternative — twelve hand-written managers — was closed in `spec.md` as RESOLVED, by both design
 * consults independently, for two reasons worth keeping in front of whoever edits this file: it would
 * recreate the triplication `StudioPanelManagerBase` was written to end, and it would move the Phase A
 * conformance contract from "inspect a manifest" to "inspect twelve heterogeneous classes". So a dashboard
 * and a document are THE SAME CODE with a different row in the manifest, and the only thing the row changes
 * is what a key is made of:
 *
 *   dashboard  key = viewId | project              one panel per section per project; re-open REVEALS
 *   document   key = viewId | project | identity   one panel per identity; two identities are two panels
 *
 * ## What was taken from `StudioPanelManagerBase`, and what was deliberately left behind
 *
 * Taken — the SHAPE, which is the best evidence of design in this repo: a declarative surface config, a Map
 * on a composite key, reveal-on-reopen instead of a second panel, creation through the shared shell, and a
 * persisted state that is the minimum `registerTrustedPanelSerializer` needs and nothing more.
 *
 * Left behind — the VOCABULARY. That base speaks entity / dirty / patch / save / cancel / CAS, because a
 * studio edits one record and the interesting question is what happens to unsaved work. A section app is
 * the other thing: the HOST pushes a model at a screen that reads it. Pasting `dirty`/`save` onto a
 * dashboard would have handed every future app a save flow it must implement and never uses, and would have
 * put the conformance contract back in front of twelve heterogeneous message protocols. What replaces it is
 * one narrow seam — `bind(session) => binding` — in which the domain says how to REPLAY one invalidation,
 * how to REBUILD everything, and what to do with an inbound message. Nothing else.
 *
 * ## Born gated, not gated later
 *
 * Phase B's `PanelWorkGate` is not a retrofit here; a panel cannot exist in this manager without one. Two
 * consequences are structural rather than advisory:
 *
 *  - the fan-out door (`refresh`) runs the domain's work through the gate, so a hidden panel journals and
 *    does nothing;
 *  - `session.post()` to a HIDDEN panel is DROPPED, and drops force a full resync on reveal
 *    (`markSourceResync`). That closes the door Phase B found the hard way — Control's own 3s client poll,
 *    which `retainContextWhenHidden: true` keeps alive behind another tab — for every app that will ever be
 *    built on this class, including the ones whose authors never read this comment. A bypass is not merely
 *    caught by a test: it cannot reach the webview, and it cannot leave the panel stale either.
 */

/** Which panel of an app. `identity` is present exactly when the app's cardinality is `document`. */
export interface SectionPanelTarget {
  /**
   * The project (workspace hash) this panel was opened AGAINST. For a document this is part of its
   * identity and is frozen at open — switching the sidebar's project selector changes what the next thing
   * opens against, never what an open document is (`spec.md`, and `route.ts:37` before it).
   */
  readonly project: string;
  /** The document's identity (a task id, an entity id). Absent for a dashboard. */
  readonly identity?: string;
}

/**
 * The minimum a revived panel needs to find its way back to the same key — and no more. `view` carries the
 * viewType because that is the field `registerTrustedPanelSerializer` checks before it hands the panel over;
 * a state that names a different view is discarded there, so this manager never has to defend against it.
 */
export interface SectionPanelState extends TrustedPanelState {
  schemaVersion: 1;
  view: string;
  project: string;
  identity?: string;
}

/** The capability an app's domain code is given for ONE open panel. Never the raw `vscode.WebviewPanel`. */
export interface SectionPanelSession<K extends string = string> {
  readonly target: SectionPanelTarget;
  /** the manager's own key for this panel — stable, and what `refresh` filtering and tests talk about. */
  readonly key: string;
  /** is a human looking at this panel right now (`visible`, not `active` — see panelWorkGate.ts). */
  readonly visible: boolean;
  /** Do `work` now if visible; otherwise journal `kind` and run NOTHING. Returns whether it ran. */
  run(kind: K, work: () => void): boolean;
  /**
   * Post to the webview. Returns false — and posts nothing — when the panel is hidden, which also arms a
   * full resync on the next reveal. Async work that started while visible and resolved after the tab went
   * behind another one is the common case, and it must neither reach a hidden webview nor be lost.
   */
  post(message: unknown): boolean;
  asWebviewUri(fsPath: string): string;
  setTitle(title: string): void;
  /** Close this panel (disposes the webview; the manager drops the entry through `onDidDispose`). */
  close(): void;
}

/** What an app's domain code hands back — the whole seam, four members, no lifecycle to implement. */
export interface SectionPanelBinding<K extends string = string> {
  /**
   * Redo the work one invalidation kind implies. Called for a fan-out refresh while VISIBLE, and once per
   * distinct journaled kind on reveal (the delta branch). It is the same call in both cases on purpose: a
   * catch-up path that is not the normal path is a path nobody exercises.
   */
  replay(kind: K): void;
  /** Rebuild everything. The reveal's resync branch, when the journal cannot prove what was missed. */
  resync(): void;
  /** Runs on EVERY reveal, before the journal's decision — for a source that keeps its own journal. */
  onReveal?(): void;
  /** An inbound webview message that `refreshKindFor` did not claim. */
  onMessage?(message: unknown): void;
  dispose?(): void;
}

export interface SectionAppConfig<K extends string = string> {
  /** the manifest row — where cardinality, viewId and the bundle name come from. */
  app: WebviewAppEntry;
  /** stylesheet filenames under `dist/webview`, IN ORDER (codicon → design-system → the app's own). */
  styleFiles: readonly string[];
  title(target: SectionPanelTarget): string;
  /** editor-tab icon, resolved via `media/icons/{light,dark}/<name>.svg`. */
  iconName?: string;
  /**
   * SDD 485 A2 — the shell extension points this app composes through, emitted as `data-shell-extends` and
   * checked against the manifest posture by `webviewConvention.test.ts`. Omitted ⇒ the app conforms.
   */
  extend?: readonly ShellExtensionPoint[];
  /** additive CSP passthroughs to `renderWebviewShell` (a security axis, NOT a conformance posture). */
  csp?: {
    imgBlob?: boolean;
    connectSrc?: boolean;
    workerSrc?: "blob";
    childSrc?: "blob";
    frameSrc?: "self";
  };
  /** extra local roots for domain-owned media (attachments), beyond `dist/webview`. */
  extraLocalResourceRoots?(target: SectionPanelTarget): vscode.Uri[];
  /** nonce'd inline globals emitted before the bundle; needs the panel's own `asWebviewUri`. */
  bootstrapGlobals?(target: SectionPanelTarget, uri: (file: string) => string): Record<string, unknown>;
  /**
   * Claim an inbound webview message as a refresh of `kind`, so the CLIENT's own timers are gated
   * HOST-side. Phase B's loudest finding was that a hidden Control still ran a full collect twenty times a
   * minute because its webview owned a `setInterval`; the fix was to gate where the gate lives rather than
   * to trust a client version. This is that fix, generalized: return a kind and the manager routes the
   * message through the gate instead of to `onMessage`.
   */
  refreshKindFor?(message: unknown): K | undefined;
  /** wire one open panel. Called once per panel, after the shell is mounted. */
  bind(session: SectionPanelSession<K>): SectionPanelBinding<K>;
}

interface PanelEntry<K extends string> {
  panel: vscode.WebviewPanel;
  gate: PanelWorkGate<K>;
  target: SectionPanelTarget;
  binding: SectionPanelBinding<K>;
}

/**
 * Compose the key. Exported and pure so the cardinality rule can be read and tested without a panel, a
 * webview or an extension host — the same posture `decideCatchUp` and `postureDeclarationErrors` take.
 */
export function sectionPanelKey(viewId: string, cardinality: SectionAppCardinality, target: SectionPanelTarget): string {
  if (cardinality === "document") {
    if (target.identity === undefined || target.identity === "") {
      throw new Error(`${viewId}: a "document" app opens against an identity — one panel per identity is the whole point of the cardinality`);
    }
    return `${viewId}|${target.project}|${target.identity}`;
  }
  if (target.identity !== undefined) {
    throw new Error(`${viewId}: a "dashboard" app has no identity (got "${target.identity}") — one panel per section per project; declare cardinality "document" if it needs one`);
  }
  return `${viewId}|${target.project}`;
}

export class SectionPanelManager<K extends string = string> {
  private readonly panels = new Map<string, PanelEntry<K>>();
  private readonly cardinality: SectionAppCardinality;
  private disposed = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly config: SectionAppConfig<K>,
    private readonly workspaceScope?: ControlWorkspaceScope,
  ) {
    if (config.app.host !== "section") {
      // Control's singleton is in the app manifest because it shares the BUILD, not because this class
      // drives it. Constructing one over that row would silently pick a cardinality nobody declared.
      throw new Error(`${config.app.viewId}: SectionPanelManager drives host "section" apps only (this row declares host "${config.app.host}")`);
    }
    this.cardinality = config.app.cardinality;
  }

  /** the keys of every open panel, in open order — instrumentation and tests. */
  get openKeys(): string[] {
    return [...this.panels.keys()];
  }

  keyFor(target: SectionPanelTarget): string {
    return sectionPanelKey(this.config.app.viewId, this.cardinality, target);
  }

  /** Open the panel for `target`, or REVEAL it if this key is already open. */
  open(target: SectionPanelTarget): void {
    this.mount(target, undefined);
  }

  /** Resolve ambient scope once, at open. Existing targets never observe later changes. */
  openInCurrentScope(identity?: string): boolean {
    const project = this.workspaceScope?.current;
    if (!project) return false;
    this.open(identity === undefined ? { project } : { project, identity });
    return true;
  }

  /**
   * Revive a panel VS Code restored across a window reload. The state is the one `panelStateFor` wrote;
   * `registerTrustedPanelSerializer` has already refused anything that is not a well-formed state for this
   * viewType, so the only thing left to defend is a state whose shape drifted between versions.
   */
  deserialize(panel: vscode.WebviewPanel, state: SectionPanelState): void {
    if (typeof state.project !== "string" || (state.identity !== undefined && typeof state.identity !== "string")) {
      panel.dispose();
      return;
    }
    const target: SectionPanelTarget = state.identity !== undefined ? { project: state.project, identity: state.identity } : { project: state.project };
    try {
      this.mount(target, panel);
    } catch {
      // A state whose identity no longer matches the app's cardinality (a manifest edit between reloads)
      // is a stale panel, not a crash: drop it the same way the serializer drops an unreadable one.
      panel.dispose();
    }
  }

  /** The state a revived panel needs — the minimum, and the field names `deserialize` reads back. */
  panelStateFor(target: SectionPanelTarget): SectionPanelState {
    return {
      schemaVersion: 1,
      view: this.config.app.viewId,
      project: target.project,
      ...(target.identity !== undefined ? { identity: target.identity } : {}),
    };
  }

  /**
   * The fan-out door: an invalidation arrived from outside. Every open panel decides for itself — visible
   * ones do the work now, hidden ones journal it and do NOTHING until someone looks at them again.
   * Returns how many panels actually did work, so a caller (or a test) can COUNT work instead of timing it.
   */
  refresh(kind: K, match?: (target: SectionPanelTarget) => boolean): number {
    let ran = 0;
    for (const entry of this.panels.values()) {
      if (match && !match(entry.target)) continue;
      if (entry.gate.run(kind, () => entry.binding.replay(kind))) ran += 1;
    }
    return ran;
  }

  /** The upstream event cursor expired: every hidden panel must rebuild rather than replay on reveal. */
  markSourceResync(): void {
    for (const entry of this.panels.values()) entry.gate.markSourceResync();
  }

  close(target: SectionPanelTarget): void {
    this.panels.get(this.keyFor(target))?.panel.dispose();
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of [...this.panels.values()]) entry.panel.dispose();
    this.panels.clear();
  }

  private mount(target: SectionPanelTarget, revivedPanel: vscode.WebviewPanel | undefined): void {
    if (this.disposed) {
      revivedPanel?.dispose();
      return;
    }
    const key = this.keyFor(target);
    const existing = this.panels.get(key);
    if (existing) {
      // Reveal-on-reopen — the dashboard half of the cardinality, and the reason a document's key carries
      // its identity: two identities never collide here, one dashboard never duplicates.
      existing.panel.reveal(vscode.ViewColumn.Active);
      revivedPanel?.dispose();
      return;
    }

    const { config } = this;
    const root = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    const title = config.title(target);
    const localResourceRoots = [root, ...(config.extraLocalResourceRoots?.(target) ?? [])];
    const panel = revivedPanel ?? vscode.window.createWebviewPanel(
      config.app.viewId,
      title,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, localResourceRoots, retainContextWhenHidden: true, enableFindWidget: true },
    );
    panel.title = title;
    panel.webview.options = { enableScripts: true, localResourceRoots };
    if (config.iconName) panel.iconPath = panelIcon(this.extensionUri, config.iconName);

    const uri = (file: string): string => panel.webview.asWebviewUri(vscode.Uri.joinPath(root, file)).toString();
    panel.webview.html = renderWebviewShell({
      cspSource: panel.webview.cspSource,
      title,
      styles: config.styleFiles.map(uri),
      bundle: uri(`${config.app.view}.js`),
      // Every app in this manifest is an entry of the ONE splitting invocation, so every app's bundle is an
      // ES module that imports its chunks. A classic <script> would fail on the first `import`.
      module: true,
      mode: "live",
      surface: config.app.viewId,
      ...(config.extend?.length ? { extend: config.extend } : {}),
      ...(config.csp?.imgBlob ? { imgBlob: true } : {}),
      ...(config.csp?.connectSrc ? { connectSrc: true } : {}),
      ...(config.csp?.workerSrc ? { workerSrc: config.csp.workerSrc } : {}),
      ...(config.csp?.childSrc ? { childSrc: config.csp.childSrc } : {}),
      ...(config.csp?.frameSrc ? { frameSrc: config.csp.frameSrc } : {}),
      ...(config.bootstrapGlobals ? { bootstrapGlobals: config.bootstrapGlobals(target, uri) } : {}),
      persistedState: this.panelStateFor(target),
    });

    // The entry is built before `bind` runs so the session can close over it: the gate must exist before
    // the domain can be handed anything that touches the webview, or the first push escapes ungated.
    const entry = {
      panel,
      target,
      gate: undefined as unknown as PanelWorkGate<K>,
      binding: undefined as unknown as SectionPanelBinding<K>,
    } as PanelEntry<K>;

    entry.gate = new PanelWorkGate<K>(panelVisibility(panel), {
      replay: (kind) => entry.binding.replay(kind),
      resync: () => entry.binding.resync(),
      onReveal: () => entry.binding.onReveal?.(),
    });

    const session: SectionPanelSession<K> = {
      target,
      key,
      get visible() { return entry.gate.visible; },
      run: (kind, work) => entry.gate.run(kind, work),
      post: (message) => {
        if (!entry.gate.visible) {
          // Not a lost message: a post nobody can see is work, and the panel that missed it rebuilds from
          // scratch on reveal rather than coming back with a hole in it.
          entry.gate.markSourceResync();
          return false;
        }
        void panel.webview.postMessage(message);
        return true;
      },
      asWebviewUri: (fsPath) => panel.webview.asWebviewUri(vscode.Uri.file(fsPath)).toString(),
      setTitle: (next) => { panel.title = next; },
      close: () => panel.dispose(),
    };

    entry.binding = config.bind(session);
    this.panels.set(key, entry);

    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const kind = config.refreshKindFor?.(raw);
      if (kind !== undefined) {
        entry.gate.run(kind, () => entry.binding.replay(kind));
        return;
      }
      entry.binding.onMessage?.(raw);
    });
    panel.onDidDispose(() => {
      entry.gate.dispose();
      entry.binding.dispose?.();
      if (this.panels.get(key) === entry) this.panels.delete(key);
    });
  }
}
