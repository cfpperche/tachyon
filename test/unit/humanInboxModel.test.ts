import { describe, expect, it } from "vitest";
import {
  buildHumanInbox,
  filterHumanInboxItems,
  humanInboxCounts,
  humanInboxHeaderChips,
  humanInboxHeaderKindChipSum,
  validationAwaitsHuman,
  type HumanInboxItem,
  type SavedAgentProposalDecision,
} from "@tachyon/webview-ui/humanInbox/model";
import type { ApprovalViewItem } from "@tachyon/webview-ui/webview/approval/viewModel.js";
import type { ValidationViewItem } from "@tachyon/webview-ui/webview/validations/viewModel.js";
import type { SavedAgentProposalReview } from "@tachyon/webview-ui/agents/savedAgentProposalReview.js";
import type { SavedAgentRemovalProposalReview } from "@tachyon/webview-ui/agents/savedAgentRemovalProposalReview.js";
import type { ScheduleProposal } from "@tachyon/engine/schedule/ProposalStore.js";

/**
 * Human Inbox, phase 1 — the aggregate projection (t-e76acc).
 *
 * The first two tests are the ones that matter for safety, and they are about what the projection
 * REFUSES to be: it never writes, and it never lets a validation stand where an approval is expected.
 * The report rejected merging the record types precisely because that guarantee would stop being a
 * compile-time fact; these pin the shape that keeps it one.
 */
const approval = (over: Partial<ApprovalViewItem> = {}): ApprovalViewItem => ({
  id: "a-000001",
  requester: "claude-opus5-3",
  session: "sess-1",
  createdAt: "2026-07-27T10:00:00.000Z",
  payload: { reason: "reconcile base for t-1", proposedAction: "git reset --hard", risk: "high", exactPrompt: "..." },
  tampered: false,
  ...over,
});

const validation = (over: Partial<ValidationViewItem> = {}): ValidationViewItem => ({
  id: "v-000001",
  title: "check the sidebar renders",
  status: "pending",
  executor: "human",
  sourceRefs: [],
  rounds: [],
  createdAt: "2026-07-27T09:00:00.000Z",
  updatedAt: "2026-07-27T09:00:00.000Z",
  ...over,
});

const NOW = "2026-07-27T12:00:00.000Z";
const build = (approvals: ApprovalViewItem[], validations: ValidationViewItem[], now = NOW): HumanInboxItem[] =>
  buildHumanInbox({ wsHash: "ws1", folder: "demo", approvals, validations }, { now });

describe("Human Inbox — a router, not a resolver", () => {
  it("exposes no way to resolve, close or assign anything", async () => {
    // The module's whole contract. If a write ever appears here, the inbox has stopped being a
    // projection over the stores and become a second path into them — which is what the ratified
    // option B forbids.
    const module = await import("@tachyon/webview-ui/humanInbox/model.js");
    const writes = Object.keys(module).filter((name) => /resolve|close|assign|cancel|approve|deny|write|save/i.test(name));
    expect(writes).toEqual([]);
  });

  it("keeps approval and validation on separate arms — a validation cannot stand in for an approval", () => {
    const [item] = build([], [validation()]);
    expect(item.kind).toBe("validation");
    // The approval payload is reachable ONLY through the approval arm. This is the type-level
    // guarantee in runtime form: a validation row simply has no payload to redeem.
    expect(item.detail.kind).toBe("validation");
    expect((item.detail as { approval?: unknown }).approval).toBeUndefined();

    const [approvalItem] = build([approval()], []);
    expect(approvalItem.detail.kind).toBe("approval");
    expect((approvalItem.detail as { validation?: unknown }).validation).toBeUndefined();
  });

  it("says which requester identities are trustworthy, instead of flattening them", () => {
    // An approval's requester is Bridge-resolved; a validation's author is self-declared. The report
    // called this out as a real asymmetry, so the row carries it rather than implying parity.
    expect(build([approval()], [])[0].requesterTrust).toBe("bridge-resolved");
    expect(build([], [validation()])[0].requesterTrust).toBe("self-declared");
  });
});

describe("Human Inbox — what is waiting, and in what order", () => {
  it("counts only validations that still await a HUMAN", () => {
    expect(validationAwaitsHuman({ status: "pending", executor: "human" })).toBe(true);
    expect(validationAwaitsHuman({ status: "running", executor: "human" })).toBe(true);
    // done, or never a human's job in the first place
    expect(validationAwaitsHuman({ status: "closed", executor: "human" })).toBe(false);
    expect(validationAwaitsHuman({ status: "pending", executor: "agent" })).toBe(false);
  });

  it("orders by kind severity, then oldest first", () => {
    const items = build(
      [approval({ id: "a-new", createdAt: "2026-07-27T11:00:00.000Z" }), approval({ id: "a-old", createdAt: "2026-07-27T08:00:00.000Z" })],
      [validation({ id: "v-old", createdAt: "2026-07-26T08:00:00.000Z" })],
    );
    // approvals first (they block an agent), oldest within the kind, validations after
    expect(items.map((i) => i.id)).toEqual(["a-old", "a-new", "v-old"]);
  });

  it("derives the count from the rows — never a shell-side constant", () => {
    const items = build([approval()], [validation(), validation({ id: "v-2", status: "closed" })]);
    expect(humanInboxCounts(items)).toEqual({ total: 2, approvals: 1, savedAgentProposals: 0, savedAgentRemovals: 0, scheduleProposals: 0, validations: 1, stale: 0 });
  });

  it("marks staleness without acting on it", () => {
    const items = build([approval({ createdAt: "2026-07-20T10:00:00.000Z" })], [validation()]);
    expect(items[0].stale).toBe(true);
    expect(items[1].stale).toBe(false);
    // nothing was resolved, closed or removed by being stale
    expect(items).toHaveLength(2);
    expect(humanInboxCounts(items).stale).toBe(1);
  });

  it("keeps a tampered approval in the list, with its warning", () => {
    // Tampering is a reason to LOOK at a row, never a reason to drop it from the count.
    const [item] = build([approval({ tampered: true, warning: "payloadHash mismatch" })], []);
    expect(item.warning).toBe("payloadHash mismatch");
    expect(humanInboxCounts([item]).approvals).toBe(1);
  });

  it("projects resolved history without changing the waiting count or laundering actor provenance", () => {
    const items = build(
      [
        approval(),
        approval({
          id: "a-resolved",
          status: "resolved",
          resolution: {
            decision: "approved",
            resolvedAt: "2026-07-27T11:00:00.000Z",
            resolvedBy: "unattributed:vscode-command",
            injectedText: "fixed receipt",
          },
        }),
      ],
      [
        validation({
          id: "v-closed",
          status: "closed",
          updatedAt: "2026-07-27T11:30:00.000Z",
          rounds: [{
            n: 1,
            closedAt: "2026-07-27T11:30:00.000Z",
            outcome: "failed",
            closedBy: { kind: "unattributed", name: "engine-control" },
            evidenceRefs: [],
          }],
        }),
      ],
    );

    expect(items.map(({ id, state, outcome, resolvedBy }) => ({ id, state, outcome, resolvedBy }))).toEqual([
      { id: "a-000001", state: "waiting", outcome: undefined, resolvedBy: undefined },
      { id: "v-closed", state: "resolved", outcome: "failed", resolvedBy: "unattributed:engine-control" },
      { id: "a-resolved", state: "resolved", outcome: "approved", resolvedBy: "unattributed:vscode-command" },
    ]);
    expect(humanInboxCounts(items)).toEqual({
      total: 1,
      approvals: 1,
      savedAgentProposals: 0,
      savedAgentRemovals: 0,
      scheduleProposals: 0,
      validations: 0,
      stale: 0,
    });
  });
});

describe("Human Inbox — the artifacts a detail route will preview", () => {
  it("collects a validation's source refs and every round's evidence, in that order", () => {
    const [item] = build([], [
      validation({
        sourceRefs: [{ type: "task", ref: "t-e76acc" }],
        rounds: [
          { n: 1, evidenceRefs: [{ type: "image", ref: ".tachyon/evidence/one.png" }] },
          { n: 2, evidenceRefs: [{ type: "image", ref: ".tachyon/evidence/two.png" }, { type: "url", ref: "https://example.test/p" }] },
        ],
      }),
    ]);
    expect(item.artifacts.map((a) => a.ref)).toEqual([
      "t-e76acc",
      ".tachyon/evidence/one.png",
      ".tachyon/evidence/two.png",
      "https://example.test/p",
    ]);
  });

  it("reports no artifacts as an empty list — absence of evidence is not evidence", () => {
    // The detail route must render this as "nothing attached", never as a validated state; keeping it
    // an empty array (not undefined) is what stops a renderer from having to guess.
    const [item] = build([], [validation()]);
    expect(item.artifacts).toEqual([]);
    // an approval carries none by construction: its payload is verbatim text, not attachments
    expect(build([approval()], [])[0].artifacts).toEqual([]);
  });
});

describe("Human Inbox — history filters", () => {
  it("keeps a decided Saved Agent proposal as a history row with its outcome", () => {
    const decided: SavedAgentProposalDecision = {
      id: "sp-dec001",
      agentName: "importer",
      proposer: "claude",
      outcome: "approved",
      resolvedAt: "2026-07-27T11:00:00.000Z",
      resolvedBy: "human",
    };
    const items = buildHumanInbox({
      wsHash: "ws1",
      folder: "demo",
      approvals: [],
      validations: [],
      decidedSavedAgentProposals: [decided],
      decidedSavedAgentRemovals: [{
        id: "sr-dec001",
        agentName: "grok-x",
        proposer: "claude",
        outcome: "denied",
        resolvedAt: "2026-07-27T11:10:00.000Z",
        resolvedBy: "human",
      }],
    }, { now: NOW });
    expect(items.map(({ id, kind, state, outcome }) => ({ id, kind, state, outcome }))).toEqual([
      { id: "sr-dec001", kind: "saved-agent-removal", state: "resolved", outcome: "denied" },
      { id: "sp-dec001", kind: "saved-agent-proposal", state: "resolved", outcome: "approved" },
    ]);
    expect(humanInboxCounts(items).total).toBe(0);
  });
});

describe("t-00aa76 — header chips cannot contradict the waiting total", () => {
  const createReview = (id: string): SavedAgentProposalReview => ({
    id,
    proposer: "claude",
    proposerTrust: "bridge-resolved",
    digest: "d".repeat(64),
    createdAt: "2026-07-27T10:00:00.000Z",
    expiresAt: "2026-07-28T10:00:00.000Z",
    expired: false,
    agentName: "importer",
    worktreeEnabled: true,
    runtime: { adapter: "claude" },
    ownership: "proposer",
    requestedGrants: [],
    permissionAuthorizations: [],
    rationale: "nightly import",
    environmentNames: [],
    requestedOwnership: [],
    requestedSkills: [],
    requestedMcpServers: [],
    requestedHooks: [],
    hasUngrantedCapabilityRequests: false,
    dangerous: [],
    affected: [],
    baseConfigSha256: "a".repeat(64),
    baseDiverged: false,
  });
  const removalReview = (id: string): SavedAgentRemovalProposalReview => ({
    id,
    proposer: "claude",
    proposerTrust: "bridge-resolved",
    digest: "e".repeat(64),
    createdAt: "2026-07-27T10:00:00.000Z",
    expiresAt: "2026-07-28T10:00:00.000Z",
    expired: false,
    agentName: "grok-x",
    agentId: "id-1",
    profileRevision: "rev-1",
    rationale: "retire",
    dangerous: [],
    affected: [],
    baseConfigSha256: "a".repeat(64),
    baseDiverged: false,
  });
  const schedule = (id: string): ScheduleProposal => ({
    id,
    name: "nightly",
    by: "claude",
    createdAt: "2026-07-27T10:00:00.000Z",
    expiresAt: "2026-07-28T10:00:00.000Z",
    schedule: { every: "1h", run: "test" },
  });

  it("kind chips the header renders sum to the waiting total", () => {
    // One of each waiting kind. The header function is what App.tsx renders — summing those
    // chips (not the counts object) is the measurement. Do not pin a literal total.
    const items = buildHumanInbox({
      wsHash: "ws1",
      folder: "demo",
      approvals: [approval()],
      validations: [validation()],
      savedAgentProposals: [createReview("sp-000001")],
      savedAgentRemovals: [removalReview("sr-000001")],
      scheduleProposals: [schedule("sc-000001")],
    }, { now: NOW });
    const counts = humanInboxCounts(items);
    const chips = humanInboxHeaderChips(counts);
    expect(humanInboxHeaderKindChipSum(chips)).toBe(counts.total);
  });
});

describe("Human Inbox — history filters (continued)", () => {
  const history = () => build(
    [
      approval(),
      approval({
        id: "a-approved",
        status: "resolved",
        resolution: {
          decision: "approved",
          resolvedAt: "2026-07-27T11:00:00.000Z",
          resolvedBy: "unattributed:companion-http",
          injectedText: "fixed receipt",
        },
      }),
    ],
    [validation({
      id: "v-failed",
      title: "visual regression",
      status: "closed",
      rounds: [{ n: 1, outcome: "failed", closedAt: "2026-07-20T11:00:00.000Z", evidenceRefs: [] }],
    })],
  );

  it("defaults to waiting and combines kind, result, period and search without flattening outcomes", () => {
    expect(filterHumanInboxItems(history(), { state: "waiting", kind: "all", outcome: "all", period: "all", query: "" }, NOW).map((i) => i.id)).toEqual(["a-000001"]);
    expect(filterHumanInboxItems(history(), { state: "resolved", kind: "approval", outcome: "approved", period: "day", query: "reconcile" }, NOW).map((i) => i.id)).toEqual(["a-approved"]);
    expect(filterHumanInboxItems(history(), { state: "resolved", kind: "validation", outcome: "failed", period: "day", query: "" }, NOW)).toEqual([]);
  });
});
