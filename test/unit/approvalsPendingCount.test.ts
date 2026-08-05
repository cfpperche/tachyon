import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  APPROVALS_REL_DIR,
  buildApprovalRequest,
  writeApprovalRequest,
  type ApprovalRequest,
} from "../../src/bridge/approvalRequest.js";
import { buildApprovalViewModel, pendingApprovalRows } from "../../src/webview/approval/viewModel.js";
import { buildCockpitModel, type CockpitWorkspaceBundle } from "../../src/cockpit/model.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-approvals-count-"));
  roots.push(root);
  return root;
}

function request(id: string, requester: string): ApprovalRequest {
  return buildApprovalRequest({
    id,
    requester,
    session: `tachyon-ws-${requester}`,
    reason: "needs a human",
    proposedAction: "do the risky thing",
    risk: "could not be undone",
    exactPrompt: "may I proceed?",
    createdAt: "2026-07-27T00:00:00.000Z",
  });
}

function bundle(approvals: CockpitWorkspaceBundle["approvals"]): CockpitWorkspaceBundle {
  return {
    control: { folderName: "tachyon", workspaceRoot: "/w", wsHash: "abc", bridgeUrl: "" },
    agents: [],
    worktrees: [],
    approvals,
  };
}

describe("Overview's pending-approval counter (t-d85857)", () => {
  it("counts what the Approvals section shows, from the same read", () => {
    const root = workspace();
    writeApprovalRequest(root, request("a-000001", "ada"));
    writeApprovalRequest(root, request("a-000002", "bea"));
    // t-86e59a — this `injectedText` is PRE-CHANGE ON PURPOSE, and it is not being superseded.
    //
    // The bytes here are DATA, not an assertion: what this test asserts is a count, and the record is
    // its input. They are also historically accurate — a request resolved before t-86e59a holds exactly
    // this line, because `injectedText` is written once at decision time and never rewritten. Updating
    // them would rewrite history and would throw away the only place in the suite proving today's reader
    // still parses what yesterday wrote. Read a `human ... approved` line here as a date stamp.
    writeApprovalRequest(root, {
      ...request("a-000003", "cid"),
      status: "resolved",
      resolution: { decision: "approved", resolvedAt: "2026-07-27T01:00:00.000Z", injectedText: "[tachyon] human approved your approval request a-000003 — you may proceed accordingly" },
    });
    writeApprovalRequest(root, {
      ...request("a-000004", "dot"),
      status: "cancelled",
      cancellation: { cancelledAt: "2026-07-27T01:00:00.000Z", cancelledBy: "dot", reason: "obsolete" },
    });
    // A record whose payloadHash no longer matches still awaits a human — tampering is a reason to
    // look at it, not to drop it from the count.
    const tampered = request("a-000005", "eve");
    writeApprovalRequest(root, tampered);
    fs.writeFileSync(
      path.join(root, APPROVALS_REL_DIR, "a-000005.json"),
      JSON.stringify({ ...tampered, payload: { ...tampered.payload, proposedAction: "do something else entirely" } }, null, 2),
      "utf8",
    );
    // Not an approval record — must not be read at all.
    fs.writeFileSync(path.join(root, APPROVALS_REL_DIR, "notes.json"), "{}", "utf8");

    const rows = pendingApprovalRows(root);
    expect(rows).toEqual([
      { id: "a-000001", status: "pending" },
      { id: "a-000002", status: "pending" },
      { id: "a-000005", status: "pending" },
    ]);
    // The property the fix exists for: the counter and the section cannot disagree.
    expect(rows.map((row) => row.id)).toEqual(
      buildApprovalViewModel({ workspaceRoot: root, folder: "tachyon", wsHash: "abc" }).approvals.map((item) => item.id),
    );

    const model = buildCockpitModel([bundle(rows)], { section: "overview" });
    expect(model.overview.approvalsPending).toBe(3);
  });

  it("reports zero only when nothing is pending", () => {
    const empty = workspace();
    expect(pendingApprovalRows(empty)).toEqual([]);
    expect(buildCockpitModel([bundle(pendingApprovalRows(empty))], { section: "overview" }).overview.approvalsPending).toBe(0);

    const resolvedOnly = workspace();
    // Pre-change bytes, kept deliberately — same reasoning as the record in the first case above.
    writeApprovalRequest(resolvedOnly, {
      ...request("a-000006", "ada"),
      status: "resolved",
      resolution: { decision: "denied", resolvedAt: "2026-07-27T02:00:00.000Z", injectedText: "[tachyon] human denied your approval request a-000006 — you may proceed accordingly" },
    });
    expect(pendingApprovalRows(resolvedOnly)).toEqual([]);
  });

  it("keeps the shell's Control bundle on that shared read", () => {
    // The defect was not in the counter but in its input: the shell bundled a hardcoded empty list,
    // so Overview said "0 pending" while requests sat on disk. `extension.ts` needs a live VS Code
    // host to run, so this pins the wiring at the one place it can be pinned headlessly.
    // Cockpit.ts's own `approvals: []` is deliberately NOT covered: that is the synthetic bundle
    // built when collection FAILS, where an empty list is the honest answer.
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "extension.ts"), "utf8");
    expect(source).toContain("approvals: pendingApprovalRows(ws.workspaceRoot)");
    expect(source).not.toMatch(/approvals:\s*\[\]/);
  });
});
