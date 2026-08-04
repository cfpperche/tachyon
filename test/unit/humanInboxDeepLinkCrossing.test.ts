import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { Uri } from "vscode";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { HumanInboxPanelManager, type HumanInboxDeps } from "../../src/webview/HumanInboxPanel.js";
import { readyMessage } from "../../src/webview/human-inbox/messages.js";
import { routeHumanInboxItem } from "../../src/engine-service/engineService.js";
import { HUMAN_INBOX_KINDS, type HumanInboxKind } from "../../src/humanInbox/model.js";
import { decodeHumanInboxDeepLink } from "../../src/humanInbox/deepLink.js";
import { DURABLE_NOTICE_COMMANDS } from "../../src/workspace/noticeInbox.js";
import { buildApprovalRequest, writeApprovalRequest } from "../../src/bridge/approvalRequest.js";
import { computeSavedAgentProposalDigest, type SavedAgentProposal } from "../../src/agents/savedAgentProposal.js";
import { savedAgentProposalPath } from "../../src/agents/savedAgentProposalStore.js";
import { computeSavedAgentRemovalProposalDigest } from "../../src/agents/savedAgentRemovalProposal.js";
import { savedAgentRemovalProposalPath } from "../../src/agents/savedAgentRemovalProposalStore.js";
import { workspaceConfigSha256 } from "../../src/config/agentProfileGrants.js";
import type { WorkspaceMissionControlTarget } from "../../src/shell/MissionControlTarget.js";
import type { Validation } from "../../src/validations/types.js";

/**
 * t-d16698 — the Review of a Saved Agent proposal must OPEN the proposal.
 *
 * The defect that produced this file was not a wrong destination; it was a test that could not tell.
 * `humanInboxDoorbell.test.ts` proves `routeSavedAgentProposal` EMITS `["tachyon.openHumanInbox",
 * wsHash, {kind, id}]` — and stops there. It passes green whether or not anything on the other side
 * of that call accepts the shape, which is why it stayed green through a Review that opened nothing.
 * A doorbell test that never reaches the door is t-b4a799 applied to tests: two halves of one product
 * effect, coverage over only one.
 *
 * So this file crosses. It takes the args the REAL emitter produced, feeds them to the REAL receiver
 * (`decodeHumanInboxDeepLink`, which is what `tachyon.openHumanInbox` runs), drives the REAL host with a
 * REAL item on disk, and asserts the ITEM surface came back — not the queue.
 *
 * SDD 485 D4 — the host on the far side of that crossing is the Human Inbox APP now, not Control. The
 * crossing itself is unchanged and is the whole point of the file: what a doorbell rings, a human must
 * land on. Two things about the destination did change and are asserted below rather than assumed —
 * `openItem` opens (or REVEALS) the project's panel and navigates it to the item, and a target it cannot
 * name opens the queue on that same panel instead of a route nothing can render.
 *
 * The one seam a unit test cannot execute is `vscode.commands.registerCommand` itself, so the source
 * scan below pins the two facts that would make the crossing a fiction: that extension.ts registers
 * exactly the command string the emitter sends, and that its body decides with this decoder rather
 * than with kind literals of its own.
 *
 * MEASURED, and recorded here so it is not re-measured: the ROOT CAUSE of the reported symptom
 * ("Review dismisses the notice and nothing opens") was neither the emitter nor the receiver. It was
 * the shell deadlocking against its own UI-request broker — fixed in 3d0dcbf1 (t-5ca73a), released in
 * 0.56.133. The last measurement on this task ran 0.56.132 and therefore predates it. What this file
 * closes is the reason that took hours to find: nothing asserted the effect.
 */
const roots: string[] = [];
beforeEach(() => __resetVscodeMock());
afterEach(() => {
  for (const p of __createdPanels) if (!p.disposed) p.dispose();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const RECENT = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const WS_HASH = "b349073a";

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-deeplink-crossing-"));
  roots.push(root);
  return root;
}

/** The ids this file deep-links to, one per declared kind. */
const ITEM_ID: Record<HumanInboxKind, string> = {
  approval: "a-000001",
  "saved-agent-proposal": "sp-45042f",
  "saved-agent-removal": "sr-45042f",
  validation: "v-1",
};

/** Every kind, live on disk, so a deep-link that resolves has something real to resolve TO. */
function liveWorkspace(): { manager: HumanInboxPanelManager; root: string } {
  const root = workspace();
  writeApprovalRequest(
    root,
    buildApprovalRequest({
      id: ITEM_ID.approval,
      requester: "codex-canonico",
      session: "tachyon-ws-codex",
      reason: "please decide",
      proposedAction: "prune the delivery",
      risk: "irreversible",
      exactPrompt: "may I proceed?",
      createdAt: RECENT,
    }),
  );
  const spec = { name: "grok-builder", runtimeAdapter: "grok" as const, rationale: "bounded implementation work" };
  const base = { configSha256: workspaceConfigSha256(root) };
  const proposal: SavedAgentProposal = {
    id: ITEM_ID["saved-agent-proposal"],
    proposer: "claude",
    proposerKind: "agent",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    digest: computeSavedAgentProposalDigest({ proposer: "claude", spec, base }),
    base,
    spec,
  };
  const file = savedAgentProposalPath(root, proposal.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(proposal)}\n`);

  const removalSpec = { name: "grok-builder", rationale: "no longer needed after dogfood" };
  const removalBase = {
    configSha256: workspaceConfigSha256(root),
    profileRevision: "a".repeat(64),
    agentId: "11111111-1111-4111-8111-111111111111",
  };
  const removal = {
    id: ITEM_ID["saved-agent-removal"],
    proposer: "claude",
    proposerKind: "agent" as const,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    digest: computeSavedAgentRemovalProposalDigest({ proposer: "claude", spec: removalSpec, base: removalBase }),
    base: removalBase,
    spec: removalSpec,
  };
  const removalFile = savedAgentRemovalProposalPath(root, removal.id);
  fs.mkdirSync(path.dirname(removalFile), { recursive: true });
  fs.writeFileSync(removalFile, `${JSON.stringify(removal)}\n`);

  const validation: Validation = {
    id: ITEM_ID.validation,
    title: "read the evidence",
    status: "pending",
    executor: "human",
    author: "claude",
    rounds: [],
    createdAt: RECENT,
    updatedAt: RECENT,
  };
  const target = {
    workspaceRoot: root,
    wsHash: WS_HASH,
    folderName: "tachyon",
    listValidations: () => [validation],
    closeValidation: async () => {},
    assignValidation: async () => {},
  } as unknown as WorkspaceMissionControlTarget;

  const deps: HumanInboxDeps = {
    approvals: {
      getWorkspaces: () => [{ workspaceRoot: root, wsHash: WS_HASH, folderName: "tachyon" }],
      resolve: async () => {},
    },
    validations: { getWorkspaces: () => [target] },
  };
  return { manager: new HumanInboxPanelManager(Uri.file("/ext"), deps), root };
}

/** What the notice's Review button actually hands the editor, from the shipped emitter. */
function emittedReviewCall(kind: HumanInboxKind): [string, ...unknown[]] {
  const calls: Array<[string, ...unknown[]]> = [];
  const notices: Array<{ actions: Array<{ label: string; run: () => Promise<void> }> }> = [];
  routeHumanInboxItem(
    {
      t: (template: string, ...args: unknown[]) => template.replace(/\{(\d+)\}/g, (_m, i: string) => String(args[Number(i)] ?? "")),
      notify: (_message: string, _level?: string, actions?: Array<{ label: string; run: () => Promise<void> }>) => {
        notices.push({ actions: actions ?? [] });
      },
      executeCommand: async (command: string, ...args: unknown[]) => {
        calls.push([command, ...args]);
      },
    } as never,
    WS_HASH,
    { kind, id: ITEM_ID[kind], message: `${kind} needs you` },
  );
  void notices[0]!.actions[0]!.run();
  return calls[0]!;
}

/**
 * The receiver, run exactly as `tachyon.openHumanInbox` runs it. The two lines below ARE the
 * registered body's decision (see the source-scan block at the bottom, which pins that).
 */
async function openWhatReviewAsksFor(manager: HumanInboxPanelManager, args: unknown[]): Promise<void> {
  const link = decodeHumanInboxDeepLink(args[1]);
  if (link.target === "item") manager.openItem(WS_HASH, link.itemKind, link.itemId);
  else manager.open(WS_HASH);
  livePanel().webview.__receive(readyMessage());
  await flush();
  await flush();
}

/** One panel per project, so the panel under test is always the most recently created one. */
const livePanel = () => __createdPanels.at(-1)!;

const posted = (type: string): Array<Record<string, unknown>> =>
  livePanel().webview.posted.filter((m) => (m as { type?: string }).type === type) as Array<Record<string, unknown>>;

describe("t-d16698 — Review crosses into Control and the ITEM is what opens", () => {
  it("a Saved Agent proposal's Review opens THAT proposal, not the queue", async () => {
    const { manager } = liveWorkspace();
    const [command, ...args] = emittedReviewCall("saved-agent-proposal");
    expect(command).toBe("tachyon.openHumanInbox");

    await openWhatReviewAsksFor(manager, args);

    // The assertion the old doorbell test could not make: the EFFECT, not the call.
    const item = posted("humanInboxItem").at(-1) as { vm?: { item?: { id?: string; kind?: string } } } | undefined;
    expect(item?.vm?.item?.id, "Review did not open the proposal").toBe(ITEM_ID["saved-agent-proposal"]);
    expect(item?.vm?.item?.kind).toBe("saved-agent-proposal");
    // Landing on the list is the failure mode this whole task chased; name it.
    expect(posted("humanInbox"), "Review fell back to the queue").toHaveLength(0);
  });

  it("every kind's Review lands on its own Inbox item", async () => {
    // Derived from the inventory, not from a list written here: approval is the load-bearing bell
    // because it blocks an agent, and a fourth kind is covered the day it is declared.
    for (const kind of HUMAN_INBOX_KINDS) {
      const { manager } = liveWorkspace();
      const [command, ...args] = emittedReviewCall(kind);
      expect(command, `${kind}: Review bypassed the Inbox`).toBe("tachyon.openHumanInbox");
      await openWhatReviewAsksFor(manager, args);
      const item = posted("humanInboxItem").at(-1) as { vm?: { item?: { id?: string; kind?: string } } } | undefined;
      expect(item?.vm?.item?.kind, `${kind}: Review did not open the item`).toBe(kind);
      expect(item?.vm?.item?.id, `${kind}: Review opened the wrong item`).toBe(ITEM_ID[kind]);
      // Each kind gets a COLD panel, the shape the notification actually creates on a first ring —
      // reusing a revealed panel would let one kind's success carry the next one's. (The REVEALED case
      // is the more common one in practice and is asserted on its own, below.)
      livePanel().dispose();
      await flush();
    }
  });

  it("an unknown target opens the queue rather than a route it cannot name", async () => {
    const { manager } = liveWorkspace();
    await openWhatReviewAsksFor(manager, [WS_HASH, { kind: "not-a-kind", id: "x-1" }]);
    expect(posted("humanInbox").at(-1)).toBeTruthy();
    expect(posted("humanInboxItem")).toHaveLength(0);
  });

  it("SDD 485 D4 — a Review that arrives while the tab is ALREADY OPEN still lands on the item", async () => {
    // The case the migration creates, and the one a human hits most: the Inbox is a `dashboard`, so a
    // second open REVEALS rather than duplicating. Revealing and leaving the human on the queue they were
    // already looking at would be a silent regression of exactly the effect this whole file exists to
    // assert — the doorbell rang about ONE item.
    const { manager } = liveWorkspace();
    manager.open(WS_HASH);
    livePanel().webview.__receive(readyMessage());
    await flush();
    expect(posted("humanInboxItem")).toHaveLength(0);

    const [, ...args] = emittedReviewCall("saved-agent-proposal");
    await openWhatReviewAsksFor(manager, args);

    expect(__createdPanels.filter((p) => !p.disposed), "Review opened a SECOND panel").toHaveLength(1);
    const item = posted("humanInboxItem").at(-1) as { vm?: { item?: { id?: string } } } | undefined;
    expect(item?.vm?.item?.id, "Review revealed the tab but left it on the queue").toBe(ITEM_ID["saved-agent-proposal"]);
  });
});

describe("t-d16698 — the receiver is pinned to the kind inventory, not to literals", () => {
  it("accepts every declared kind, so a doorbell can never ring for a kind with no door", () => {
    for (const kind of HUMAN_INBOX_KINDS) {
      expect(decodeHumanInboxDeepLink({ kind, id: "id-1" }), `${kind} has no door`).toEqual({
        target: "item",
        itemKind: kind,
        itemId: "id-1",
      });
    }
  });

  it("degrades to the list for anything it cannot name, including junk from a restored route", () => {
    for (const junk of [undefined, null, "sp-1", 7, [], { kind: "approval" }, { kind: "approval", id: "   " }, { id: "a-1" }]) {
      expect(decodeHumanInboxDeepLink(junk)).toEqual({ target: "list" });
    }
  });
});

/**
 * The seam a unit test cannot execute: `registerCommand` itself. Scanned rather than mocked, the
 * same convention `studioCutoverRouting.test.ts` uses for extension.ts command bodies.
 */
describe("t-d16698 — the command the doorbell names is the command the shell registers", () => {
  const source = readFileSync("src/extension.ts", "utf8");
  /** Tolerates both registration layouts in this file: one-liner and argument-per-line. */
  const registrationOf = (command: string): number =>
    source.search(new RegExp(`registerCommand\\(\\s*"${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  const body = (() => {
    const start = registrationOf("tachyon.openHumanInbox");
    expect(start, "tachyon.openHumanInbox registration missing").toBeGreaterThanOrEqual(0);
    const next = source.indexOf("vscode.commands.registerCommand", start + 1);
    return source.slice(start, next === -1 ? undefined : next);
  })();

  it("registers exactly the command string every Inbox doorbell emits", () => {
    for (const kind of HUMAN_INBOX_KINDS) {
      const command = emittedReviewCall(kind)[0];
      expect(registrationOf(command), `${kind}'s Review names a command nothing registers: ${command}`)
        .toBeGreaterThanOrEqual(0);
    }
  });

  it("decides with the derived decoder, never with kind literals of its own", () => {
    expect(body).toContain("decodeHumanInboxDeepLink(target)");
    // The regression this forbids by name: a hand-written accept-list that can fall behind
    // HUMAN_INBOX_KINDS while the emitter's Record<HumanInboxKind, …> keeps compiling.
    for (const kind of HUMAN_INBOX_KINDS) {
      expect(body, `the handler hard-codes "${kind}"`).not.toContain(`"${kind}"`);
    }
  });

  it("stays on the durable-notice allowlist, so the doorbell survives a restart", () => {
    for (const kind of HUMAN_INBOX_KINDS) {
      expect(DURABLE_NOTICE_COMMANDS, `${kind}'s Review dies on reload`).toContain(emittedReviewCall(kind)[0]);
    }
  });

  it("keeps openApprovals as a compatibility command that opens the Inbox list", () => {
    const start = registrationOf("tachyon.openApprovals");
    expect(start, "tachyon.openApprovals registration missing").toBeGreaterThanOrEqual(0);
    const next = source.indexOf("vscode.commands.registerCommand", start + 1);
    const approvalBody = source.slice(start, next === -1 ? undefined : next);
    expect(approvalBody).toContain("openHumanInboxTab");
    expect(approvalBody).not.toContain("openCockpit");
  });
});
