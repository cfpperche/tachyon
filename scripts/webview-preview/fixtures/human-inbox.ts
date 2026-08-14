import { buildHumanInbox, humanInboxCounts } from "@tachyon/webview-ui/humanInbox/model";
import type { HumanInboxItemViewModel, HumanInboxViewModel } from "@tachyon/webview-ui/webview/human-inbox/viewModel";
import type { ApprovalViewItem } from "@tachyon/webview-ui/webview/approval/viewModel";
import type { ValidationViewItem } from "@tachyon/webview-ui/webview/validations/viewModel";
import { humanInboxFixtureVm, humanInboxItemFixtureVm } from "./cockpit";
import type { Fixture } from "../routes";

/**
 * SDD 485 D4 — the Human Inbox's own preview route.
 *
 * These VMs were reachable only as `?view=cockpit&fixture=inbox` / `inbox-item` while the Inbox was an
 * embedded section. The section is gone, so the fixtures move with it — the same repointing C4, C5, D2 and
 * D3 each did, and the reason `cockpitCssParity` and `webviewPreviewRoutes` both have something to say
 * about it: a route that renders a bundle Control no longer links is a route measuring the wrong page box.
 *
 * The two states are the app's two surfaces, and the route exists to make BOTH measurable at two widths:
 * the QUEUE (what a human scans) and one OPEN ITEM (what they decide on). The derivation is unchanged —
 * `buildHumanInbox` over the harness's real approval and validation fixtures — because ordering, severity
 * and the counts are exactly what a preview must not be free to invent.
 */
export type HumanInboxPreviewState =
  | { readonly state: "list"; readonly vm: HumanInboxViewModel }
  | { readonly state: "item"; readonly vm: HumanInboxItemViewModel };

const WS_HASH = "b349073a";
const FOLDER = "tachyon";
/** fixed, so a regenerated screenshot differs only when the UI does — the shots suite's own rule. */
const NOW = "2026-07-16T18:40:00.000Z";
const hoursBefore = (h: number): string => new Date(Date.parse(NOW) - h * 60 * 60 * 1000).toISOString();

/**
 * REAL VOLUME, which is what the two-width measurement is actually for.
 *
 * The list's failure modes are all list-shaped — a row whose meta wraps into its title, a long requester
 * crowding the age, a queue tall enough that the counts scroll away — and none of them appear on the
 * four-row fixture above. 24 approvals + 14 validations is the shape of a queue that has been ignored for
 * a weekend, which is when a human most needs to be able to read it.
 */
function volumeApproval(n: number): ApprovalViewItem {
  const requester = n % 4 === 0 ? "codex-canonico-worktree-integration" : n % 3 === 0 ? "claude" : "grok-builder";
  return {
    id: `a-${String(100000 + n).slice(0, 6)}`,
    requester,
    session: `tachyon-ws-${requester}`,
    createdAt: hoursBefore(n * 3),
    payload: {
      reason: n % 5 === 0
        ? "the delivery branch has diverged from main and the integration needs an explicit decision before it prunes anything"
        : `decide request ${n}`,
      proposedAction: "prune the delivery worktree",
      risk: n % 3 === 0 ? "irreversible" : "recoverable",
      exactPrompt: "may I proceed?",
    },
    tampered: false,
    ...(n % 7 === 0 ? { warning: "requester identity could not be re-resolved" } : {}),
  };
}

function volumeValidation(n: number): ValidationViewItem {
  return {
    id: `v-${String(200000 + n).slice(0, 6)}`,
    title: n % 3 === 0
      ? `read the visual evidence for the launcher tile alignment change at both measured widths (round ${n})`
      : `read the evidence for change ${n}`,
    status: "pending",
    executor: "human",
    ...(n % 4 === 0 ? { assignee: "human" } : {}),
    sourceRefs: [],
    rounds: [],
    createdAt: hoursBefore(n * 5),
    updatedAt: hoursBefore(n * 5),
  };
}

const volumeItems = buildHumanInbox(
  {
    wsHash: WS_HASH,
    folder: FOLDER,
    approvals: Array.from({ length: 24 }, (_, i) => volumeApproval(i + 1)),
    validations: Array.from({ length: 14 }, (_, i) => volumeValidation(i + 1)),
    savedAgentProposals: [],
  },
  { now: NOW },
);

const volumeVm: HumanInboxViewModel = {
  folder: FOLDER,
  wsHash: WS_HASH,
  items: volumeItems,
  counts: humanInboxCounts(volumeItems),
};

const emptyVm: HumanInboxViewModel = {
  folder: FOLDER,
  wsHash: WS_HASH,
  items: [],
  counts: humanInboxCounts([]),
};

const historyItems = buildHumanInbox(
  {
    wsHash: WS_HASH,
    folder: FOLDER,
    approvals: [
      volumeApproval(1),
      {
        ...volumeApproval(2),
        id: "a-audit1",
        status: "resolved",
        resolution: {
          decision: "approved",
          resolvedAt: "2026-08-07T15:20:00.000Z",
          resolvedBy: "unattributed:vscode-command",
          injectedText: "fixed receipt",
          note: "Approved after reviewing the proposed cleanup.",
        },
      },
    ],
    validations: [
      {
        ...volumeValidation(1),
        id: "v-audit2",
        title: "Verify the Human Inbox history at both widths",
        status: "closed",
        updatedAt: "2026-08-06T18:00:00.000Z",
        rounds: [{
          n: 1,
          startedAt: "2026-08-06T17:30:00.000Z",
          closedAt: "2026-08-06T18:00:00.000Z",
          outcome: "failed",
          resultNote: "The narrow row lost its actor before this change.",
          closedBy: { kind: "unattributed", name: "engine-control" },
          evidenceRefs: [],
        }],
      },
    ],
  },
  { now: "2026-08-07T18:00:00.000Z" },
);

const historyVm: HumanInboxViewModel = {
  folder: FOLDER,
  wsHash: WS_HASH,
  items: historyItems,
  counts: humanInboxCounts(historyItems),
};

export const humanInboxFixtures: Record<string, Fixture<HumanInboxPreviewState>> = {
  // the mixed queue: one approval, one validation, one Saved Agent proposal — the three weights the row
  // badge exists to keep apart.
  list: { provenance: "unit-fixture-derived", vm: { state: "list", vm: humanInboxFixtureVm } },
  // where every "Review" doorbell lands: ONE item, opened, with its own way back.
  item: { provenance: "unit-fixture-derived", vm: { state: "item", vm: humanInboxItemFixtureVm } },
  volume: { provenance: "synthetic-edge", vm: { state: "list", vm: volumeVm } },
  // "Nothing is waiting on you" is a state a human sees often and a screenshot set forgets to check.
  empty: { provenance: "synthetic-edge", vm: { state: "list", vm: emptyVm } },
  history: { provenance: "unit-fixture-derived", vm: { state: "list", vm: historyVm } },
};
