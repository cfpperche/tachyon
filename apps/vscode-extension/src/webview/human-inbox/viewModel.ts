import type { HumanInboxViewModel, HumanInboxItemViewModel } from "@tachyon/webview-ui/webview/human-inbox/viewModel";
export type { HumanInboxViewModel, HumanInboxItemViewModel } from "@tachyon/webview-ui/webview/human-inbox/viewModel";
/**
 * Human Inbox — the view models Control's section and detail route render (t-e76acc).
 *
 * This is the projection layer, and it deliberately holds no reads of its own: approvals arrive from
 * `listApprovalViewItems` and validations from `buildValidationsViewModel`, the SAME authoritative reads
 * the Approvals and Validations sections already use. That is the whole point of the ratified
 * contract — "the inbox is a router, not a resolver": one more surface over the same stores, never a
 * second source of truth that can disagree with them (see `humanInbox/model.ts` for the counter that
 * once did exactly that).
 */
import {
  buildHumanInbox,
  humanInboxCounts,
  type HumanInboxInput,
  type HumanInboxKind,
  type StaleAfter,
} from "@tachyon/webview-ui/humanInbox/model";
import {
  projectInboxArtifacts,
  summarizeInboxArtifacts,
  type InboxArtifactResolver,
} from "../../humanInbox/artifacts.js";
import type { ApprovalViewItem } from "../approval/viewModel.js";
import type { ValidationViewItem } from "../validations/viewModel.js";
import type { SavedAgentProposalReview } from "../../agents/savedAgentProposalReview.js";
import type { SavedAgentRemovalProposalReview } from "../../agents/savedAgentRemovalProposalReview.js";
import type { ScheduleProposal } from "@tachyon/engine/schedule/ProposalStore.js";

export function buildHumanInboxViewModel(input: {
  folder: string;
  wsHash: string;
  approvals: readonly ApprovalViewItem[];
  validations: readonly ValidationViewItem[];
  /** SDD 482 phase 4C — live Saved Agent proposals, already reviewed into their human-facing shape. */
  savedAgentProposals?: readonly SavedAgentProposalReview[];
  /** Proposal files that exist but cannot be trusted; surfaced as warned rows, never dropped. */
  untrustedSavedAgentProposals?: readonly { id: string; reason: string }[];
  /** t-afe120 — live Saved Agent removal proposals */
  savedAgentRemovals?: readonly SavedAgentRemovalProposalReview[];
  untrustedSavedAgentRemovals?: readonly { id: string; reason: string }[];
  scheduleProposals?: readonly ScheduleProposal[];
  decidedSavedAgentProposals?: HumanInboxInput["decidedSavedAgentProposals"];
  decidedSavedAgentRemovals?: HumanInboxInput["decidedSavedAgentRemovals"];
  now?: string;
  /**
   * t-e4f662 — the workspace's configured staleness threshold, or absent for the product default.
   * It arrives per CALL rather than being read here: this module is the projection layer and owns no
   * config reader, and the threshold belongs to the workspace whose rows are being projected — which
   * in a multi-root window is not "the one workspace".
   */
  staleAfterHours?: StaleAfter;
}): HumanInboxViewModel {
  const items = buildHumanInbox(
    {
      wsHash: input.wsHash,
      folder: input.folder,
      approvals: input.approvals,
      validations: input.validations,
      ...(input.savedAgentProposals ? { savedAgentProposals: input.savedAgentProposals } : {}),
      ...(input.untrustedSavedAgentProposals ? { untrustedSavedAgentProposals: input.untrustedSavedAgentProposals } : {}),
      ...(input.savedAgentRemovals ? { savedAgentRemovals: input.savedAgentRemovals } : {}),
      ...(input.untrustedSavedAgentRemovals ? { untrustedSavedAgentRemovals: input.untrustedSavedAgentRemovals } : {}),
      ...(input.scheduleProposals ? { scheduleProposals: input.scheduleProposals } : {}),
      ...(input.decidedSavedAgentProposals ? { decidedSavedAgentProposals: input.decidedSavedAgentProposals } : {}),
      ...(input.decidedSavedAgentRemovals ? { decidedSavedAgentRemovals: input.decidedSavedAgentRemovals } : {}),
    },
    {
      ...(input.now ? { now: input.now } : {}),
      ...(input.staleAfterHours === undefined ? {} : { staleAfterHours: input.staleAfterHours }),
    },
  );
  return { folder: input.folder, wsHash: input.wsHash, items, counts: humanInboxCounts(items) };
}

/**
 * Open ONE item by its (kind, id) pair.
 *
 * Keyed by kind AND id, never id alone: the two id spaces are independent stores, and matching on id
 * alone would let a validation open under an approval route (or the reverse) the day the two ever
 * collide. Returns undefined when the item is no longer in the inbox — resolved, closed, or never
 * there — and the caller renders that as its own state rather than as an empty document.
 */
export function buildHumanInboxItemViewModel(
  vm: HumanInboxViewModel,
  kind: HumanInboxKind,
  id: string,
  resolver: InboxArtifactResolver = {},
): HumanInboxItemViewModel | undefined {
  const item = vm.items.find((candidate) => candidate.kind === kind && candidate.id === id);
  if (!item) return undefined;
  const artifacts = projectInboxArtifacts(item.artifacts, resolver);
  return {
    folder: vm.folder,
    wsHash: vm.wsHash,
    item,
    artifacts,
    artifactSummary: summarizeInboxArtifacts(artifacts),
  };
}
