import { describe, expect, it } from "vitest";
import { buildHumanInboxViewModel, buildHumanInboxItemViewModel } from "../../src/webview/human-inbox/viewModel.js";
import type { ApprovalViewItem } from "../../src/webview/approval/viewModel.js";
import type { ValidationViewItem } from "../../src/webview/validations/viewModel.js";

/**
 * Human Inbox — the aggregated view models Control renders (t-e76acc).
 *
 * The list is covered by `humanInboxModel.test.ts` at the projection level; what is proven HERE is
 * the surface contract on top of it: one count for both kinds, and an item opened by (kind, id) —
 * never by id alone, which is what keeps two independent id spaces from ever resolving into each
 * other's store.
 */
const approval = (id: string, over: Partial<ApprovalViewItem> = {}): ApprovalViewItem => ({
  id,
  requester: "codex-canonico",
  session: "tachyon-ws-codex",
  createdAt: "2026-07-27T10:00:00.000Z",
  payload: { reason: "needs a human", proposedAction: "prune", risk: "irreversible", exactPrompt: "may I?" },
  tampered: false,
  ...over,
});

const validation = (id: string, over: Partial<ValidationViewItem> = {}): ValidationViewItem => ({
  id,
  title: "dogfood the inbox",
  status: "pending",
  executor: "human",
  sourceRefs: [],
  rounds: [],
  createdAt: "2026-07-27T09:00:00.000Z",
  updatedAt: "2026-07-27T09:00:00.000Z",
  ...over,
});

const build = (approvals: ApprovalViewItem[], validations: ValidationViewItem[]) =>
  buildHumanInboxViewModel({
    folder: "tachyon",
    wsHash: "ws-1",
    approvals,
    validations,
    now: "2026-07-27T12:00:00.000Z",
  });

describe("Human Inbox view model — one list, one count", () => {
  it("counts both kinds together and each kind on its own, from the rows themselves", () => {
    const vm = build([approval("a-1"), approval("a-2")], [validation("v-1"), validation("v-2", { executor: "agent" })]);
    // the agent-executor validation is not a human's decision and never enters the inbox
    expect(vm.items.map((i) => i.id)).toEqual(["a-1", "a-2", "v-1"]);
    expect(vm.counts).toEqual({ total: 3, approvals: 2, validations: 1, stale: 0 });
  });

  it("carries the workspace identity onto the view model the route is keyed by", () => {
    const vm = build([approval("a-1")], []);
    expect(vm.wsHash).toBe("ws-1");
    expect(vm.folder).toBe("tachyon");
  });

  it("an empty inbox is a zeroed count, not an absent one", () => {
    expect(build([], []).counts).toEqual({ total: 0, approvals: 0, validations: 0, stale: 0 });
  });
});

describe("Human Inbox item view model — opened by kind AND id", () => {
  it("opens the approval arm, with the payload reachable only through it", () => {
    const vm = build([approval("a-1")], []);
    const item = buildHumanInboxItemViewModel(vm, "approval", "a-1");
    expect(item?.item.detail.kind).toBe("approval");
    // the discriminated union is what keeps "a validation is not an authorization" a compile-time
    // fact; at runtime that shows up as: the approval payload exists on this arm and nowhere else.
    if (item?.item.detail.kind !== "approval") throw new Error("expected the approval arm");
    expect(item.item.detail.approval.payload.reason).toBe("needs a human");
  });

  it("refuses to open a validation id through the approval kind, even when the ids collide", () => {
    // The two stores have independent id spaces. A lookup by id alone would resolve this — which is
    // exactly the confusion the route's (kind, id) key exists to make impossible.
    const vm = build([approval("x-1")], [validation("x-1")]);
    const asApproval = buildHumanInboxItemViewModel(vm, "approval", "x-1");
    const asValidation = buildHumanInboxItemViewModel(vm, "validation", "x-1");
    expect(asApproval?.item.detail.kind).toBe("approval");
    expect(asValidation?.item.detail.kind).toBe("validation");
  });

  it("returns undefined for an item that is no longer waiting", () => {
    // resolved/closed elsewhere while the human was reading — the caller renders that as its own
    // state, never as an empty document.
    expect(buildHumanInboxItemViewModel(build([], []), "approval", "a-gone")).toBeUndefined();
  });

  it("projects a validation's source refs and every round's evidence, in the order the work happened", () => {
    const vm = build(
      [],
      [
        validation("v-1", {
          sourceRefs: [{ type: "task", ref: "t-e76acc" }],
          rounds: [
            { n: 1, evidenceRefs: [{ type: "image", ref: "shots/one.png" }] },
            { n: 2, evidenceRefs: [{ type: "prototype", ref: "protos/p.html" }] },
          ],
        }),
      ],
    );
    const item = buildHumanInboxItemViewModel(vm, "validation", "v-1", {
      workspaceRoot: "/ws",
      load: (_p, kind) => (kind === "image" ? { image: "data:image/png;base64,AA" } : { prototype: "<p>hi</p>" }),
    });
    expect(item?.artifacts.map((a) => [a.kind, a.name])).toEqual([
      ["reference", "t-e76acc"],
      ["image", "one.png"],
      ["prototype", "p.html"],
    ]);
    expect(item?.artifactSummary).toEqual({ total: 3, previewable: 2, unavailable: 0 });
  });

  it("an item with nothing attached carries an empty list and a zeroed summary", () => {
    const vm = build([approval("a-1")], []);
    const item = buildHumanInboxItemViewModel(vm, "approval", "a-1");
    expect(item?.artifacts).toEqual([]);
    // nothing here can be read as "evidence checked" — absence is absence
    expect(item?.artifactSummary).toEqual({ total: 0, previewable: 0, unavailable: 0 });
  });

  it("keeps an unreadable artifact listed, with its reason", () => {
    const vm = build([], [validation("v-1", { sourceRefs: [{ type: "screenshot", ref: "shots/gone.png" }] })]);
    const item = buildHumanInboxItemViewModel(vm, "validation", "v-1", {
      workspaceRoot: "/ws",
      load: () => ({ unavailable: "file not found" }),
    });
    expect(item?.artifacts[0]).toMatchObject({ name: "gone.png", available: false, reason: "file not found" });
    expect(item?.artifactSummary).toEqual({ total: 1, previewable: 0, unavailable: 1 });
  });
});
