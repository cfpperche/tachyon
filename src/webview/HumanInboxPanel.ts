import * as vscode from "vscode";
import {
  SectionPanelManager,
  type SectionAppConfig,
  type SectionPanelSession,
  type SectionPanelState,
  type SectionPanelTarget,
} from "./shared/SectionPanelManager.js";
import { webviewApp, type WebviewAppEntry } from "./webviewApps.js";
import type { ControlWorkspaceScope } from "./shared/ControlWorkspaceScope.js";
import {
  POLL,
  READY,
  humanInboxErrorMessage,
  humanInboxItemMessage,
  humanInboxItemMissingMessage,
  humanInboxMessage,
  type HumanInboxAction,
} from "./human-inbox/messages.js";
import { buildHumanInboxViewModel, buildHumanInboxItemViewModel } from "./human-inbox/viewModel.js";
import { makeInboxArtifactLoader } from "@tachyon/engine/humanInbox/loadArtifact.js";
import type { HumanInboxKind, StaleAfter } from "../humanInbox/model.js";
import type { ApprovalDecision } from "@tachyon/engine/bridge/approvalRequest.js";
import type { ValidationOutcome } from "@tachyon/engine/validations/types.js";
import type { WorkspacePresentationTarget } from "../shell/WorkspacePresentation.js";
import type { WorkspaceBoardTarget } from "../shell/BoardTarget.js";
import { buildValidationsViewModel } from "./validations/viewModel.js";
import { listApprovalViewItems } from "./approval/viewModel.js";
import { readLiveSavedAgentProposalQueue } from "@tachyon/engine/agents/savedAgentProposalStore.js";
import { buildSavedAgentProposalReview } from "../agents/savedAgentProposalReview.js";
import { denySavedAgentProposal, type SavedAgentCommitResult } from "../agents/savedAgentProposalCommit.js";
import { readLiveSavedAgentRemovalProposalQueue } from "@tachyon/engine/agents/savedAgentRemovalProposalStore.js";
import { buildSavedAgentRemovalProposalReview } from "../agents/savedAgentRemovalProposalReview.js";
import {
  denySavedAgentRemovalProposal,
  type SavedAgentRemovalCommitResult,
} from "../agents/savedAgentRemovalProposalCommit.js";
import { workspaceConfigSha256 } from "@tachyon/engine/config/agentProfileGrants.js";
import { ProposalStore } from "@tachyon/engine/schedule/ProposalStore.js";

/**
 * The viewType, and it is NEW for a reason none of the five previous calls in this spec met: **there is no
 * legacy id at all.**
 *
 * D2 distilled the question into two halves — does the id still NAME this app, and does its legacy record map
 * onto this app's key with no residue? Every migration since has answered them. This one has no subject to
 * answer them about: the Human Inbox was born as a Control SECTION (t-e76acc), after SDD 410 had already
 * retired the standalone panels, so it never had a `createWebviewPanel` call and never wrote a persisted
 * record under any id. There is nothing to revive, nothing to migrate, and nothing to redirect.
 *
 * The id that LOOKS available is `tachyonApprovals`, and taking it would have been two mistakes at once. It
 * is a LIVE redirect (its trusted serializer is still registered and still carries `{wsHash}`), which is
 * exactly what stopped C5 reusing the retired Board viewType; and it names a DIFFERENT surface — Approvals,
 * which `spec.md` § Non-goals deliberately keeps as a deep-link/compatibility route rather than promoting to
 * an app. An id naming the surface this one AGGREGATES is worse than a merely stale one.
 *
 * | | id still names it | legacy record maps | call |
 * |---|---|---|---|
 * | C4 task detail | yes | `{wsHash, taskId}` → `{project, identity}` | reuse + 2-field rename |
 * | C5 Board | no — the screen is the Board | would have | new id; legacy stays a redirect |
 * | D1 tmux | yes | `{schemaVersion, view}` is ALREADY a `window` state | reuse, no shim |
 * | D2 Plugins | yes | `{wsHash}` → `{project}` | reuse + 1-field rename |
 * | D3 Runtime Ops | no — the id names a retired WebviewView that never shipped | no record exists | new id; tombstone dispose-only |
 * | D4 Human Inbox | **no id exists — born after 410, never standalone** | **nothing was ever written** | new id; no tombstone at all |
 */
export const HUMAN_INBOX_VIEW_TYPE = "tachyonHumanInbox";

/** the one invalidation kind this app knows: "the queue you are showing may be stale". */
type HumanInboxRefreshKind = "inbox";

/** t-e4f662 — one workspace's configured staleness threshold, from that workspace's own config. */
export type HumanInboxStaleAfter = (wsHash: string) => StaleAfter | undefined;

/**
 * What the extension host supplies. Moved here from `Cockpit.ts`'s `CockpitApprovals` / `CockpitValidations`
 * pair, narrowed to what this surface actually reads — the domain is unchanged by this migration, which is
 * the whole claim of a Phase D cutover.
 */
export interface HumanInboxDeps {
  approvals: {
    getWorkspaces: () => WorkspacePresentationTarget[];
    resolve: (wsHash: string, id: string, decision: ApprovalDecision) => Promise<void>;
  };
  validations: {
    getWorkspaces: () => WorkspaceBoardTarget[];
  };
  /**
   * Closing or assigning a validation from HERE must invalidate the same things it invalidates from the
   * Validations tab — the Board's counts, and Control's own Validations section. Control called this after
   * both of its inbox validation branches, and dropping it in the cutover is exactly the kind of quiet
   * behaviour change a Phase D migration must not make.
   */
  onValidationsChanged?: () => void;
  /** t-e4f662 — absent means the product default everywhere. */
  humanInboxStaleAfter?: HumanInboxStaleAfter;
  /** SDD 482 phase 4C — absent means this window cannot commit, and the pane says so rather than no-oping. */
  approveSavedAgentProposal?: (input: {
    workspaceRoot: string;
    proposalId: string;
    approvedDigest: string;
  }) => Promise<SavedAgentCommitResult>;
  /** t-afe120 — same digest binding, opposite durable effect. */
  approveSavedAgentRemoval?: (input: {
    workspaceRoot: string;
    proposalId: string;
    approvedDigest: string;
  }) => Promise<SavedAgentRemovalCommitResult>;
  decideScheduleProposal?: (wsHash: string, id: string, decision: "approve" | "deny") => Promise<void>;
}

/** The two workspace targets one panel reads, resolved together so an approvals-only workspace is visible. */
interface InboxSources {
  approvalWs: WorkspacePresentationTarget;
  validationWs: WorkspaceBoardTarget | undefined;
}

/**
 * t-e76acc → SDD 485 D4 — the Human Inbox as a standalone app, and the FOURTH Phase D migration: one editor
 * tab for everything waiting on a human, which can now sit beside the agent terminal that is blocked on the
 * approval it shows — the capability ceiling `spec.md` reversed the app count for.
 *
 * ## Why `dashboard`, and why the ten-second check agreed with the brief this time
 *
 * D3 established the method and had to overturn its own brief with it: "it is a Control section" says nothing
 * about cardinality, and the question is whether the surface's DATA SOURCE accepts a project. Here it does,
 * unanimously, and entirely before this migration rather than arranged by it — `Cockpit.ts`'s `inboxSources`
 * took an optional `wsHash` and resolved ONE approval workspace from it, and every read underneath is rooted
 * at that single `workspaceRoot`:
 *
 *  - `listApprovalViewItems(workspaceRoot)` — pending and resolved approvals come from that workspace's directory;
 *  - the validations half is `deps.validations.getWorkspaces().find(w => w.wsHash === approvalWs.wsHash)` —
 *    a per-workspace target, and an absent one is REPORTED rather than borrowed from a neighbour;
 *  - both Saved Agent queues (`readLiveSavedAgentProposalQueue` / `…RemovalProposalQueue`) read that root, and
 *    the digest they are checked against is `workspaceConfigSha256(workspaceRoot)` — the authority a proposal
 *    creates is scoped to the project whose config it would rewrite;
 *  - `makeInboxArtifactLoader(workspaceRoot)` is a CONTAINMENT root, not a convenience: it decides which paths
 *    an item's evidence may resolve against;
 *  - `humanInboxStaleAfter(wsHash)` is per workspace by its own signature.
 *
 * Two attached projects therefore have two genuinely different queues, and two panels showing two answers is
 * CORRECT rather than duplicated. This is D2's Plugins case, not D3's Runtime Ops one.
 *
 * The workspace lookup is STRICT, exactly as the Board's and Plugins' are (C5, D2): `workspaceFor` matches an
 * exact `wsHash`. Control resolved through a fallback chain (preferred → shell scope → first attached) because
 * ONE panel had to answer for whatever scope the human last chose; a dashboard's project IS half its key, so a
 * loose resolution would let two panels land on one workspace under different keys, or let a panel silently
 * retarget when the selector moves. On a surface that RESOLVES APPROVALS, borrowing another project's queue
 * would not be a cosmetic error — a consent token from project A must never be redeemable against project B.
 *
 * ## The item detail stays INSIDE, and the open item is per-panel state
 *
 * `inbox-item` carries identity (wsHash + kind + id), so a `document` app was representable. It is deliberately
 * not what this migration does: the queue is a thing a human works DOWN, item by item (`route.ts:258` says so
 * in as many words), and "two inbox items side by side" is a product decision nobody asked for.
 *
 * The cost of that choice is named and paid here rather than discovered later. The subroute — which item this
 * panel currently has open — is STATE BETWEEN MESSAGES, which Control kept in its module-scoped `currentRoute`
 * because it was a singleton. It lives inside `bind` now, per panel by construction. C4 predicted this shape
 * for the whole of Phase D and D2 found three instances of it in Plugins; this is the first migration where
 * the state is inherent to the design rather than an inherited assumption, and the failure a shared slot would
 * produce is the worst of the series so far: with two projects open, project B's panel jumping to project A's
 * item would put an approval decision on screen under the wrong workspace's tab.
 *
 * ## Hidden work
 *
 * Three doors reach this app and all three are gated by construction: the client's own 3s poll (claimed by
 * `humanInboxRefreshKind`, so the gate answers it host-side whatever timer a client version runs — Phase B's
 * loudest finding), the fan-out `refresh()` (which this surface really does have: `refreshCockpitApprovals`
 * and `refreshCockpitValidations` both invalidated the inbox, because it is a projection over both stores),
 * and every `session.post`.
 */
export class HumanInboxPanelManager {
  private readonly manager: SectionPanelManager<HumanInboxRefreshKind>;
  /**
   * The per-panel controllers, keyed by the manager's own panel key. This is how a deep link reaches an
   * ALREADY-OPEN panel: `SectionPanelManager.open` reveals rather than re-binding (that is the dashboard
   * cardinality working), so the caller needs a way to say "and show this item" to whichever panel it got.
   *
   * Keyed by panel key rather than held in a slot — the same rule this class states for the subroute itself.
   * A single controller would work perfectly with one project attached and silently retarget the wrong panel
   * with two, which is the precise shape of defect notes.md has recorded three times.
   */
  private readonly controllers = new Map<string, { showItem(kind: HumanInboxKind, id: string): void }>();

  constructor(
    extensionUri: vscode.Uri,
    private readonly deps: HumanInboxDeps,
    app: WebviewAppEntry = webviewApp("human-inbox"),
    workspaceScope?: ControlWorkspaceScope,
  ) {
    this.manager = new SectionPanelManager<HumanInboxRefreshKind>(extensionUri, this.configFor(app), workspaceScope);
  }

  /** Open the Inbox for one project, or REVEAL the panel already open for it. */
  open(project: string): void {
    this.manager.open({ project });
  }

  openInCurrentScope(): boolean {
    return this.manager.openInCurrentScope();
  }

  /**
   * The deep link's destination: open (or reveal) this project's panel AND land it on one item — the
   * `tachyon.openHumanInbox` "Review" doorbell, whose whole point is that a person told about an item lands
   * on THAT item rather than on the queue.
   *
   * A revealed panel is navigated rather than left where it was, which is the same answer Control gave: the
   * deep link committed the `inbox-item` route on the single panel. What changed is only which panel.
   */
  openItem(project: string, kind: HumanInboxKind, id: string): void {
    this.manager.open({ project });
    this.controllers.get(this.manager.keyFor({ project }))?.showItem(kind, id);
  }

  /** The fan-out door. Returns how many panels actually did work. */
  refresh(): number {
    return this.manager.refresh("inbox");
  }

  /** the upstream event cursor expired: every hidden panel rebuilds instead of replaying on reveal. */
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
    this.controllers.clear();
  }

  /**
   * STRICT, by exact `wsHash` — see this class's doc comment. A project that is no longer attached says so on
   * its own panel and never borrows another project's queue.
   */
  private sourcesFor(target: SectionPanelTarget): InboxSources | undefined {
    const approvalWs = this.deps.approvals.getWorkspaces().find((w) => w.wsHash === target.project);
    if (!approvalWs) return undefined;
    const validationWs = this.deps.validations.getWorkspaces().find((w) => w.wsHash === approvalWs.wsHash);
    return { approvalWs, validationWs };
  }

  /**
   * Ported from `Cockpit.ts`'s `buildInboxVm` unchanged. It reads BOTH stores through the SAME functions the
   * Approvals and Validations surfaces use, which is what keeps the aggregate from being able to disagree
   * with the surfaces it aggregates — the property t-e76acc was built around, and one a cutover is exactly
   * where you would lose it.
   */
  private buildVm(sources: InboxSources) {
    const { approvalWs, validationWs } = sources;
    const queue = readLiveSavedAgentProposalQueue(approvalWs.workspaceRoot, Date.now());
    const removals = readLiveSavedAgentRemovalProposalQueue(approvalWs.workspaceRoot, Date.now());
    const configSha = workspaceConfigSha256(approvalWs.workspaceRoot);
    const nowMs = Date.now();
    const configured = this.deps.humanInboxStaleAfter?.(approvalWs.wsHash);
    return buildHumanInboxViewModel({
      folder: approvalWs.folderName,
      wsHash: approvalWs.wsHash,
      approvals: listApprovalViewItems(approvalWs.workspaceRoot),
      validations: validationWs
        ? buildValidationsViewModel({
          folder: approvalWs.folderName,
          wsHash: approvalWs.wsHash,
          validations: validationWs.listValidations(),
        }).validations
        : [],
      savedAgentProposals: queue.proposals.map((proposal) =>
        buildSavedAgentProposalReview({ proposal, currentConfigSha256: configSha, nowMs })),
      untrustedSavedAgentProposals: queue.unreadable,
      savedAgentRemovals: removals.proposals.map((proposal) =>
        buildSavedAgentRemovalProposalReview({ proposal, currentConfigSha256: configSha, nowMs })),
      untrustedSavedAgentRemovals: removals.unreadable,
      scheduleProposals: new ProposalStore(approvalWs.workspaceRoot).list(),
      ...(configured === undefined ? {} : { staleAfterHours: configured }),
    });
  }

  private configFor(app: WebviewAppEntry): SectionAppConfig<HumanInboxRefreshKind> {
    return {
      app,
      // The exact sheet Control linked while the Inbox was its active section, minus `vscode-theme.css`,
      // which Control links for every section and this surface never used a rule from.
      //
      // No `page-frame.css`, and that is a measured claim rather than an omission: `human-inbox.css` gives
      // `#root` no height and styles no page frame, so this surface page-scrolls — which for THIS screen is
      // not merely the default but the point, since its detail route renders evidence a human did not choose
      // the dimensions of (a 3000px screenshot, a wide prototype). Linking the frame would fail
      // `webviewConvention.test.ts`'s mirror rule and `overflow: hidden` would put that evidence out of reach.
      //
      // And unlike D2 and D3, NO page-pad residue had to move or be deleted: `.hi-root`'s `--ds-page-pad-*`
      // rule was always in this surface's own sheet, and `cockpit.css` never styled `.hi-root` at all — its
      // embed neutralization is `.ck-embed-host > main`, which does not reach a `div`-rooted surface. That is
      // the third answer this grep has given in three migrations, and `embedPagePad.test.ts` holds it.
      styleFiles: ["codicon.css", "tokens.css", "faces.css", "design-system.css", "quick-picker.css", "human-inbox.css"],
      title: () => vscode.l10n.t("Human Inbox"),
      // No `iconName`: t-6c59f6 landed while this was in flight and made the editor-tab icon DERIVED from
      // the launcher tile that opens the app (`WEBVIEW_APPS`' `section` → `controlSectionIcon`). Declaring
      // one here would be the fourth hand-written opinion about a glyph the tile already names, which is
      // the divergence that fix exists to end.
      // The detail route renders an item's evidence inline: a host-loaded image (pin preview's contract) and
      // a sandboxed `srcdoc` prototype (task detail's). Both were Control's CSP passthroughs for this
      // section and they move with the surface — an app that cannot render the evidence is an app that
      // cannot answer the question the human opened it to answer.
      csp: { imgBlob: true, childSrc: "blob", frameSrc: "self" },
      extraLocalResourceRoots: (target) => {
        const ws = this.deps.approvals.getWorkspaces().find((w) => w.wsHash === target.project);
        return ws ? [vscode.Uri.file(ws.workspaceRoot)] : [];
      },
      refreshKindFor: humanInboxRefreshKind,
      bind: (session) => {
        /**
         * THE SUBROUTE, and it is per panel by construction — see this class's doc comment. `undefined` is
         * the list; a value is the item this panel has open. Control held the equivalent in its
         * module-scoped `currentRoute`, which was true of a singleton and would be a cross-project leak here.
         */
        let open: { kind: HumanInboxKind; id: string } | undefined;

        const send = (): void => {
          const sources = this.sourcesFor(session.target);
          if (!sources) {
            session.post(humanInboxErrorMessage(
              vscode.l10n.t("That workspace is no longer attached."),
            ));
            return;
          }
          let vm;
          try {
            vm = this.buildVm(sources);
          } catch (err) {
            session.post(humanInboxErrorMessage(err instanceof Error ? err.message : String(err)));
            return;
          }
          if (!open) {
            session.post(humanInboxMessage(vm));
            // A workspace with approvals but no validations target still renders its approvals and SAYS the
            // other half could not be read: an empty half of an inbox must never be indistinguishable from a
            // quiet one (t-e76acc). Carried over verbatim.
            if (!sources.validationWs) {
              session.post(humanInboxErrorMessage(
                vscode.l10n.t("Validations could not be read for this workspace — approvals only."),
              ));
            }
            return;
          }
          const item = buildHumanInboxItemViewModel(vm, open.kind, open.id, {
            workspaceRoot: sources.approvalWs.workspaceRoot,
            load: makeInboxArtifactLoader(sources.approvalWs.workspaceRoot),
          });
          if (!item) {
            // The host has authoritatively re-read the queue and confirmed this pending resource is gone
            // (another window resolved it). Do not strand the panel on an identity that no longer exists:
            // the list is both the recovery path and the truthful current state, and NAMING the item is what
            // lets a person tell "already resolved" from "the deep link is broken" (t-d16698).
            const missing = open;
            open = undefined;
            session.post(humanInboxMessage(vm));
            session.post(humanInboxErrorMessage(
              `${missing.kind} ${missing.id} is no longer pending — showing the current queue instead.`,
            ));
            return;
          }
          session.post(humanInboxItemMessage(item));
        };

        /** Navigate this panel to an item and paint it — the deep link's landing, and a row click's. */
        const showItem = (kind: HumanInboxKind, id: string): void => {
          open = { kind, id };
          send();
        };
        this.controllers.set(session.key, { showItem });

        return {
          // `replay` and `resync` do the same work, and that is a property of the surface rather than an
          // oversight: the model is a full re-read of one workspace's two stores, so there is nothing a
          // delta could carry that a rebuild does not. What the gate's distinction still decides is how MANY
          // of these run after a burst — one, either way. (Same shape as the Board's, the inspector's,
          // Plugins' and Runtime Ops', and for the same reason.)
          replay: () => { send(); },
          resync: () => { send(); },
          onMessage: (raw) => { void this.handleAction(session, raw, { send, showItem, close: () => { open = undefined; send(); } }); },
          dispose: () => { this.controllers.delete(session.key); },
        };
      },
    };
  }

  /**
   * The surface's human actions. `ready` and the 3s `poll` never arrive here — `humanInboxRefreshKind` claims
   * them for the gate — so everything below is an action on a panel someone is looking at.
   *
   * Every branch dispatches into the SAME typed path that row's own section already uses, with that path's
   * own authority checks. There is deliberately no shared "resolve this row" branch the two kinds pass
   * through: the ratified rule is that a validation can never be redeemed as an authorization, and the way to
   * keep a rule like that is to leave no code path that could express it. Ported from `Cockpit.ts` unchanged.
   *
   * What did NOT come with it is Control's `navEpoch` guard. It protected against posting one route's data
   * under another route's screen; here the subroute is this panel's own `open` slot and a post is built from
   * it at send time. What is left is C4's documented non-guard: two refreshes racing on one panel can post in
   * either order, and the loser is a stale-by-milliseconds projection of the same queue.
   */
  private async handleAction(
    session: SectionPanelSession<HumanInboxRefreshKind>,
    raw: unknown,
    io: { send(): void; showItem(kind: HumanInboxKind, id: string): void; close(): void },
  ): Promise<void> {
    const m = raw as Partial<HumanInboxAction> & Record<string, unknown>;
    if (!m?.type) return;
    const sources = this.sourcesFor(session.target);

    if (m.type === "refreshInbox") {
      // The human pressing Refresh. It means exactly a re-read — no side effect, which is why sharing the
      // word with the poll would have been safe and why separating them costs only a constant.
      io.send();
      return;
    }
    if (m.type === "closeInboxItem") {
      io.close();
      return;
    }
    if (m.type === "openInboxItem" && typeof m.id === "string" && isInboxKind(m.kind)) {
      io.showItem(m.kind, m.id);
      return;
    }
    if (!sources) {
      session.post(humanInboxErrorMessage(vscode.l10n.t("That workspace is no longer attached.")));
      return;
    }
    const workspaceRoot = sources.approvalWs.workspaceRoot;

    if (m.type === "resolveInboxApproval" && typeof m.id === "string" && (m.decision === "approved" || m.decision === "denied")) {
      // The approval capability path, unchanged and unshared: the same call the Approvals section makes,
      // against THIS PANEL's workspace — which under `dashboard` is the panel's key rather than an ambient
      // scope, and is the containment property this cardinality buys.
      try {
        await this.deps.approvals.resolve(sources.approvalWs.wsHash, m.id, m.decision as ApprovalDecision);
        // t-e5e995 / t-00f4bc — a terminal decision removes the item from the pending projection, so its
        // detail route ceases to identify an actionable resource. Return to the list rather than leaving a
        // "no longer waiting" tombstone on a normal Approve.
        io.close();
      } catch (err) {
        session.post(humanInboxErrorMessage(err instanceof Error ? err.message : String(err)));
      }
      return;
    }
    if (m.type === "decideSavedAgentProposal" && typeof m.id === "string" && typeof m.digest === "string") {
      try {
        if (m.decision === "deny") {
          denySavedAgentProposal({
            workspaceRoot,
            proposalId: m.id,
            deniedBy: "human",
            reason: typeof m.reason === "string" && m.reason.trim() ? m.reason.trim() : "no reason given",
            nowMs: Date.now(),
          });
        } else if (m.decision === "approve") {
          const result = await this.deps.approveSavedAgentProposal?.({ workspaceRoot, proposalId: m.id, approvedDigest: m.digest });
          // A host without the port wired must SAY so rather than silently doing nothing — the shape of
          // failure that teaches a human their approval is decorative.
          if (!result) {
            session.post(humanInboxErrorMessage(vscode.l10n.t("This window cannot commit Saved Agent proposals.")));
            return;
          }
          if (!result.ok) {
            session.post(humanInboxErrorMessage(`${result.code}: ${result.reason}`));
            return;
          }
        } else {
          return;
        }
        io.close();
      } catch (err) {
        session.post(humanInboxErrorMessage(err instanceof Error ? err.message : String(err)));
      }
      return;
    }
    if (m.type === "decideSavedAgentRemoval" && typeof m.id === "string" && typeof m.digest === "string") {
      try {
        if (m.decision === "deny") {
          denySavedAgentRemovalProposal({
            workspaceRoot,
            proposalId: m.id,
            deniedBy: "human",
            reason: typeof m.reason === "string" && m.reason.trim() ? m.reason.trim() : "no reason given",
            nowMs: Date.now(),
          });
        } else if (m.decision === "approve") {
          const result = await this.deps.approveSavedAgentRemoval?.({ workspaceRoot, proposalId: m.id, approvedDigest: m.digest });
          if (!result) {
            session.post(humanInboxErrorMessage(vscode.l10n.t("This window cannot commit Saved Agent removals.")));
            return;
          }
          if (!result.ok) {
            session.post(humanInboxErrorMessage(`${result.code}: ${result.reason}`));
            return;
          }
        } else {
          return;
        }
        io.close();
      } catch (err) {
        session.post(humanInboxErrorMessage(err instanceof Error ? err.message : String(err)));
      }
      return;
    }
    if (m.type === "decideScheduleProposal" && typeof m.id === "string" && (m.decision === "approve" || m.decision === "deny")) {
      try {
        if (!this.deps.decideScheduleProposal) throw new Error(vscode.l10n.t("This window cannot decide schedule proposals."));
        await this.deps.decideScheduleProposal(sources.approvalWs.wsHash, m.id, m.decision);
        io.close();
      } catch (err) {
        session.post(humanInboxErrorMessage(err instanceof Error ? err.message : String(err)));
      }
      return;
    }
    if (m.type === "closeInboxValidation" || m.type === "assignInboxValidation") {
      // The validation path, and it can never authorize anything: it reaches this workspace's own validation
      // target, which is the only object that owns these operations.
      if (!sources.validationWs) {
        session.post(humanInboxErrorMessage(
          vscode.l10n.t("Validations could not be read for this workspace — approvals only."),
        ));
        return;
      }
      try {
        if (m.type === "closeInboxValidation" && typeof m.id === "string" && typeof m.note === "string" && m.outcome) {
          await sources.validationWs.closeValidation(m.id, { outcome: m.outcome as ValidationOutcome, result_note: m.note });
          this.deps.onValidationsChanged?.();
          // A CLOSE is terminal: the item leaves the pending projection, so its subroute stops identifying
          // an actionable resource and the queue is both the recovery path and the truthful state.
          io.close();
        } else if (m.type === "assignInboxValidation" && typeof m.id === "string" && typeof m.assignee === "string" && m.expect) {
          await sources.validationWs.assignValidation(m.id, m.assignee, m.expect as { assignee: string | null; updatedAt: string });
          this.deps.onValidationsChanged?.();
          // An ASSIGN is not terminal — the item is still waiting, and the human stays on it. Re-read
          // instead of navigating, which is exactly what Control did.
          io.send();
        }
      } catch (err) {
        session.post(humanInboxErrorMessage(err instanceof Error ? err.message : String(err)));
      }
    }
  }
}

function isInboxKind(value: unknown): value is HumanInboxKind {
  return value === "approval" || value === "validation" || value === "saved-agent-proposal" || value === "saved-agent-removal" || value === "schedule-proposal";
}

/**
 * The ONE place that decides whether an inbound message is the client asking for work: the shell's SHARED
 * `ready` handshake and this app's own 3s `poll`. A string compare the HOST does — never a promise the client
 * keeps — which is what makes the gate hold whatever timer a client version happens to run. Exported so the
 * rule is testable without a panel.
 *
 * `refreshInbox` is deliberately NOT here, and the reason is the inverse of D2's: it is a human pressing the
 * Refresh button, and — measured rather than assumed — it carries NO side effect, so sharing the word would
 * have been safe. It stays separate for one constant, so that a future side effect on the human action cannot
 * silently acquire a caller that runs twenty times a minute.
 */
export function humanInboxRefreshKind(message: unknown): HumanInboxRefreshKind | undefined {
  if (!message || typeof message !== "object") return undefined;
  const type = (message as { type?: unknown }).type;
  return type === READY || type === POLL ? "inbox" : undefined;
}

export { humanInboxItemMissingMessage };
