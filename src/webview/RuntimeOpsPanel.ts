import * as vscode from "vscode";
import {
  SectionPanelManager,
  type SectionAppConfig,
  type SectionPanelSession,
  type SectionPanelState,
} from "./shared/SectionPanelManager.js";
import { webviewApp, type WebviewAppEntry } from "./webviewApps.js";
import {
  POLL,
  READY,
  isRuntimeOpsInspectSessionAction,
  isRuntimeOpsSetProviderObservationAction,
  runtimeOpsSessionInspectionMessage,
  runtimeOpsSnapshotMessage,
  runtimeOpsSnapshotUnavailableMessage,
} from "./runtime-ops/messages.js";
import type { RuntimeOpsProviderV2, RuntimeOpsSnapshot } from "../runtimeOps/types.js";
import type { InspectedSession } from "@tachyon/engine/runtimeOps/sessionInspection.js";

/**
 * The viewType, and it is a NEW one — the opposite call from D1's and D2's, for a reason neither of those
 * two could show.
 *
 * The rule the series distilled is two-part: **does the id still NAME this app, and does its legacy record
 * map onto this app's key with no residue?** The available legacy id is `tachyonRuntimeOpsView`, and it
 * fails the FIRST half in a way no previous migration met: that id names spec 367 Phase 1's
 * `RuntimeOpsView.ts`, which was a **WebviewView** — a bottom-panel view container, a different surface
 * KIND from an editor tab — and it was retired (t-ed3067) as code that was never registered at all. There
 * is no `registerWebviewViewProvider` call in this repo's history for it, so nothing in production ever
 * wrote a record under that id; `extension.ts` keeps it only in the dispose-only loop beside the other dev
 * and dead viewTypes, as defensive code for a state that cannot exist.
 *
 * So the second half is not "would the legacy record map" but "there is no legacy record, and the id would
 * name the wrong kind of surface forever". Reusing it would buy exactly zero restore fidelity — the thing
 * reuse is FOR — and would leave `tachyonRuntimeOpsView` naming an editor tab that is not a view. Hence
 * `tachyonRuntimeOps`, and the tombstone stays exactly where it is, untouched. It needs no redirect
 * either, which is the last difference from C5's Board: that tombstone was a LIVE redirect carrying its
 * own persisted `{wsHash}`, and this one has never had a panel to redirect.
 *
 * | | id still names it | legacy record maps | call |
 * |---|---|---|---|
 * | C4 task detail | yes | `{wsHash, taskId}` → `{project, identity}` | reuse + 2-field rename |
 * | C5 Board | no — the screen is the Board | would have | new id; legacy stays a redirect |
 * | D1 tmux | yes | `{schemaVersion, view}` is ALREADY a `window` state | reuse, no shim |
 * | D2 Plugins | yes | `{wsHash}` → `{project}` | reuse + 1-field rename |
 * | D3 Runtime Ops | **no — the id names a retired WebviewView that never shipped** | **no record exists** | new id; tombstone stays dispose-only |
 */
export const RUNTIME_OPS_VIEW_TYPE = "tachyonRuntimeOps";

/** the one invalidation kind this app knows: "the runtime inventory you are showing may be stale". */
type RuntimeOpsRefreshKind = "runtime-ops";

/**
 * What the extension host supplies. Moved here verbatim from `Cockpit.ts`'s `CockpitRuntimeOps` — the
 * domain is unchanged by this migration, which is the whole claim of a Phase D cutover.
 */
export interface RuntimeOpsDeps {
  buildSnapshot: () => RuntimeOpsSnapshot | Promise<RuntimeOpsSnapshot>;
  configureProviderObservation?: (provider: RuntimeOpsProviderV2, enabled: boolean) => void | Promise<void>;
  /**
   * t-283149 — what Tachyon handed one agent's runtime. Optional: an engine that predates the
   * `agent.session-inspection` action refuses it by name, and the panel says so on that row rather
   * than the whole surface failing.
   */
  inspectAgentSession?: (workspaceKey: string, agent: string) => Promise<InspectedSession>;
}

/**
 * spec 367 → SDD 410 (t-d23f93) → SDD 485 D3 — Runtime Ops as a standalone app, and the THIRD Phase D
 * migration: one editor tab that can sit beside the agent terminal whose throttling it explains, which is
 * the capability ceiling `spec.md` reversed the app count for.
 *
 * ## Why `window`, and why the brief that commissioned this said `dashboard`
 *
 * The task was written for `dashboard` (one panel per project) and the evidence said otherwise, unanimously
 * and entirely BEFORE this migration rather than arranged by it:
 *
 *  - `buildSnapshot()` takes **no project**, and never has. `extension.ts` implements it as
 *    `runtimeOpsFleetView(workspaces().map((ws) => ws.runtimeOps))` — a MERGE across every attached
 *    workspace. There is no parameter anywhere in the chain for a project to enter through;
 *  - `configureProviderObservation` fans out to EVERY workspace, because the preference it writes is the
 *    account's, not a project's;
 *  - the screen says so in its own words: *"Provider capacity — Account-wide quota. These limits are not
 *    attributed to a runtime, workspace, or agent."* (`runtime-ops/App.tsx`), and `runtimeOps/types.ts`
 *    records the same fact one layer down;
 *  - each runtime row prints `runtime.workspaces.map((w) => w.label).join(", ")` — the model is
 *    cross-workspace by construction, the way `buildInspectorModel`'s foreign groups are for tmux;
 *  - `Cockpit.ts`'s `sendRuntime` ignored `controlWorkspaceScope` entirely, so moving the project selector
 *    changes nothing on this screen TODAY. A dashboard whose panel is keyed on a project the surface does
 *    not read is a key that lies, which is precisely what D1's `window` member exists to refuse;
 *  - and `inspectAgentSession(workspaceKey, agent)` resolves its workspace from the ROW, not the panel. A
 *    panel keyed to project A must act on project B's agents, because the merged model shows them.
 *
 * Under `dashboard`, two attached projects would open two byte-identical panels over one merged model —
 * the exact outcome D1 introduced this member to make impossible. The neighbouring launcher tile is the
 * clean contrast and the reason this is worth stating rather than assuming: **Runtime CONFIG is
 * `dashboard`** (`buildSnapshot(wsHash)` takes a workspace and reads that root's files), and Runtime OPS
 * is not. Two adjacent tiles, opposite cardinalities, and the difference is visible in a type signature
 * rather than in a policy someone has to remember.
 *
 * ## What this file owns, and what it does not
 *
 * The key, reveal-on-reopen, the shared shell, the persisted state, revive, and the `PanelWorkGate` that
 * makes a hidden panel do no work and a revealed one never stale all belong to `SectionPanelManager`. What
 * is left here is the domain, unchanged by the move: build the snapshot, and route the two actions the
 * screen has — the same two, doing the same things, `Cockpit.ts` did while Runtime Ops was a section.
 *
 * ## Session state between messages: there is none, and that was CHECKED rather than assumed
 *
 * C4 predicted that every "we are a singleton, so one slot is enough" in Control is a defect waiting for
 * its section to be migrated, and D2 found three of them in Plugins (`checks`/`pending`/`busy` in one
 * closure). Runtime Ops has zero: the host's whole surface was `sendRuntime` (build fresh, post) plus two
 * stateless action handlers, and the only caches in the neighbourhood — `runtimeConfigKnownPaths`,
 * `lastKnownTaskDetail` — belong to other sections. The per-row `sessionInspections` map is CLIENT state
 * and was already per webview. Nothing here is held between messages, so nothing needed moving inside
 * `bind` — but `bind` is where any future slot must go, and being a `window` app does not exempt it: one
 * panel today is not a promise about tomorrow, and a module-scoped slot would silently become shared the
 * day a second panel exists.
 *
 * ## Hidden work
 *
 * Two doors reach this app and both are gated by construction: the client's own 3s poll (claimed by
 * `runtimeOpsRefreshKind`, so the gate answers it host-side whatever timer a client version runs — Phase
 * B's loudest finding) and every `session.post`. There is no fan-out door, and that is a fact rather than
 * an omission: nothing in the extension host emits a `views-changed` for runtime ops, inside Control or
 * outside it — the snapshot is polled, not watched, and that was true as a Control section too. `refresh()`
 * exists for a caller that does not yet exist, and `markSourceResync()` for the same reason.
 */
export class RuntimeOpsPanelManager {
  private readonly manager: SectionPanelManager<RuntimeOpsRefreshKind>;

  constructor(
    extensionUri: vscode.Uri,
    private readonly deps: RuntimeOpsDeps,
    app: WebviewAppEntry = webviewApp("runtime-ops"),
  ) {
    this.manager = new SectionPanelManager<RuntimeOpsRefreshKind>(extensionUri, this.configFor(app));
  }

  /** Open the Runtime Ops tab, or REVEAL the one already open. There is only ever one. */
  open(): void {
    this.manager.open({});
  }

  /** the fan-out door, for a caller that has one. Returns how many panels did work — 0 or 1. */
  refresh(): number {
    return this.manager.refresh("runtime-ops");
  }

  /** the upstream event cursor expired: a hidden panel rebuilds instead of replaying on reveal. */
  markSourceResync(): void {
    this.manager.markSourceResync();
  }

  deserialize(panel: vscode.WebviewPanel, state: SectionPanelState): void {
    this.manager.deserialize(panel, state);
  }

  get openKeys(): string[] {
    return this.manager.openKeys;
  }

  dispose(): void {
    this.manager.dispose();
  }

  private configFor(app: WebviewAppEntry): SectionAppConfig<RuntimeOpsRefreshKind> {
    return {
      app,
      // The exact sheet Control linked while Runtime Ops was its active section (`runtimeIsActive ? …`,
      // after the three shell-wide ones), minus `vscode-theme.css`, which Control links for every section
      // and this surface never used a rule from.
      //
      // No `page-frame.css`, and that is a measured claim rather than an omission: `runtime-ops.css` gives
      // `#root` no height and styles no page frame, so this surface page-scrolls like the task detail, the
      // inspector and Plugins rather than filling its tab in bounded regions. Linking the frame here would
      // fail `webviewConvention.test.ts`'s mirror rule (a sheet linked without being anchored to), and
      // `overflow: hidden` is the wrong frame for a document that scrolls.
      //
      // And unlike D2, no page PAD had to move: `.runtime-ops`'s `--ds-page-pad-*` rule already lived in
      // this surface's own sheet. What `cockpit.css` provided was only embed-context NEUTRALIZATION
      // (`.ck-embed-host > .runtime-ops`), which is dead once the surface leaves Control — so the residue
      // here was a rule to DELETE rather than one to move, in both sheets. `embedPagePad.test.ts` holds
      // both halves.
      styleFiles: ["codicon.css", "tokens.css", "faces.css", "design-system.css", "quick-picker.css", "runtime-ops.css"],
      title: () => vscode.l10n.t("Runtime Ops"),
      refreshKindFor: runtimeOpsRefreshKind,
      bind: (session) => {
        const send = async (): Promise<void> => {
          try {
            const snapshot = await this.deps.buildSnapshot();
            session.post(runtimeOpsSnapshotMessage(snapshot));
          } catch {
            // A snapshot that cannot be built is an UNAVAILABLE inventory, not a blank screen — carried
            // over from Control verbatim, and the App renders it as its own error state rather than an
            // empty table claiming there are no runtimes.
            session.post(runtimeOpsSnapshotUnavailableMessage());
          }
        };
        return {
          // `replay` and `resync` do the same work, and that is a property of the surface rather than an
          // oversight: the model is a full merge across every attached workspace, so there is nothing a
          // delta could carry that a rebuild does not. What the gate's distinction still decides is how
          // MANY of these run after a burst — one, either way. (Same shape as the Board's, the
          // inspector's and Plugins', and for the same reason.)
          replay: () => { void send(); },
          resync: () => { void send(); },
          onMessage: (raw) => { void this.handleAction(session, raw, send); },
        };
      },
    };
  }

  /**
   * The surface's two human actions. `ready` and the 3s `poll` never arrive here —
   * `runtimeOpsRefreshKind` claims them for the gate — so everything below is an action on a panel
   * someone is looking at.
   *
   * Ported from `Cockpit.ts` unchanged, including the two behaviours worth naming because a cutover is
   * exactly where they get quietly dropped: a failed `configureProviderObservation` is SWALLOWED (the next
   * snapshot is the source of truth, and a toast for a preference that will re-read in three seconds is
   * noise), and a failed inspection posts an ERROR keyed to its `agentKey` rather than nothing, so the
   * row that asked says why instead of spinning forever.
   *
   * What did NOT come with it is Control's `navEpoch` guard. It protected against posting one route's data
   * under another route's screen, and this panel has no route to change — what is left is C4's documented
   * non-guard: two refreshes racing on one panel can post in either order, and the loser is a
   * stale-by-milliseconds projection of the same fleet, resolved by the next poll three seconds later.
   */
  private async handleAction(
    session: SectionPanelSession<RuntimeOpsRefreshKind>,
    raw: unknown,
    send: () => Promise<void>,
  ): Promise<void> {
    if (isRuntimeOpsSetProviderObservationAction(raw)) {
      try {
        await this.deps.configureProviderObservation?.(raw.provider, raw.enabled);
      } catch {
        /* next snapshot wins */
      }
      await send();
      return;
    }
    if (isRuntimeOpsInspectSessionAction(raw)) {
      // t-283149 — the reply is addressed to an agentKey, so a row that is gone simply has nowhere to
      // land; the client drops it. That is why there is no in-flight guard here.
      const agentKey = `${raw.workspaceKey}:${raw.agent}`;
      try {
        const inspect = this.deps.inspectAgentSession;
        if (!inspect) throw new Error(vscode.l10n.t("This engine does not expose session inspection."));
        session.post(runtimeOpsSessionInspectionMessage(agentKey, { inspection: await inspect(raw.workspaceKey, raw.agent) }));
      } catch (error) {
        session.post(
          runtimeOpsSessionInspectionMessage(agentKey, { error: error instanceof Error ? error.message : String(error) }),
        );
      }
    }
  }
}

/**
 * The ONE place that decides whether an inbound message is the client asking for work: the shell's SHARED
 * `ready` handshake and this app's own 3s `poll`. A string compare the HOST does — never a promise the
 * client keeps — which is what makes the gate hold whatever timer a client version happens to run.
 * Exported so the rule is testable without a panel.
 *
 * `refresh` is deliberately NOT here, and deliberately not anywhere: this surface has no refresh message,
 * so the word stays free for a human-pressed button that does not yet exist. D2 had to separate the two
 * after finding `refresh` carried a side effect; here the separation is kept before there is anything to
 * separate, which costs one constant.
 */
export function runtimeOpsRefreshKind(message: unknown): RuntimeOpsRefreshKind | undefined {
  if (!message || typeof message !== "object") return undefined;
  const type = (message as { type?: unknown }).type;
  return type === READY || type === POLL ? "runtime-ops" : undefined;
}
