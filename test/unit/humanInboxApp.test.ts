import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Uri } from "vscode";
import { __createdPanels, __registeredWebviewPanelSerializers, __resetVscodeMock, __setPanelVisible } from "../mocks/vscode.js";
import {
  HUMAN_INBOX_VIEW_TYPE,
  HumanInboxPanelManager,
  humanInboxRefreshKind,
  type HumanInboxDeps,
} from "../../src/webview/HumanInboxPanel.js";
import { registerTrustedPanelSerializer } from "../../src/webview/shared/panelSerializer.js";
import { sectionPanelKey, type SectionPanelState } from "../../src/webview/shared/SectionPanelManager.js";
import {
  closeInboxItemAction,
  openInboxItemAction,
  pollInboxAction,
  readyMessage,
  refreshInboxAction,
} from "../../src/webview/human-inbox/messages.js";
import { buildApprovalRequest, writeApprovalRequest } from "../../src/bridge/approvalRequest.js";
import { computeSavedAgentProposalDigest, type SavedAgentProposal } from "../../src/agents/savedAgentProposal.js";
import { savedAgentProposalPath } from "../../src/agents/savedAgentProposalStore.js";
import { workspaceConfigSha256 } from "../../src/config/agentProfileGrants.js";
import type { WorkspaceMissionControlTarget } from "../../src/shell/MissionControlTarget.js";
import type { Validation } from "../../src/validations/types.js";

/**
 * SDD 485 D4 — the Human Inbox as a standalone `dashboard` app.
 *
 * Retargeted from `cockpitHumanInbox.test.ts` rather than deleted: every claim that file made about the
 * HOST is still a claim about a host, and the host moved. What each case drives changed (a panel manager
 * instead of Control's router) and what it asserts about NAVIGATION changed shape (a per-panel subroute
 * instead of a committed route), but the properties are the same ones — one surface reads BOTH stores,
 * acting on a row lands in that kind's OWN typed path, and no path exists by which a validation reaches
 * the approval one.
 *
 * Three claims are NEW, and they are the ones the cardinality creates:
 *
 *  - two projects get a panel each, told apart BY CONTENT rather than by counting (D2's lesson: counting
 *    panels passes just as well against a shared model);
 *  - the OPEN ITEM is per-panel state. A shared slot would let project B's tab jump to project A's item,
 *    which on a surface that resolves approvals is the worst failure in this phase so far;
 *  - the deep link navigates a REVEALED panel, because a dashboard reveals rather than duplicating and
 *    "Review" must still land on the item it was ringing about.
 *
 * Every case drives the WIRE — the message a real client posts — rather than the manager's internals
 * (0.56.159's lesson): `ready` and `pollInbox` reach this app through the GATE rather than through
 * `onMessage`, which is exactly the difference an internals-level test cannot see.
 */

const extensionUri = Uri.file("/ext");
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const roots: string[] = [];

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  for (const p of __createdPanels) if (!p.disposed) p.dispose();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-inbox-app-"));
  roots.push(root);
  return root;
}

/**
 * The host reads staleness against the REAL clock, so these timestamps are relative on purpose: a fixed
 * "recent" date would silently become stale once wall-clock time passed it, and the assertion would start
 * failing months later for no reason anyone could connect to this change.
 */
const RECENT = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const LONG_AGO = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();

function pendingApproval(root: string, id: string, createdAt: string = RECENT): void {
  writeApprovalRequest(
    root,
    buildApprovalRequest({
      id,
      requester: "codex-canonico",
      session: "tachyon-ws-codex",
      reason: `please decide ${id}`,
      proposedAction: "prune the delivery",
      risk: "irreversible",
      exactPrompt: "may I proceed?",
      createdAt,
    }),
  );
}

function validationRecord(id: string, over: Partial<Validation> = {}): Validation {
  return {
    id,
    title: `read the evidence for ${id}`,
    status: "open",
    executor: "human",
    rounds: [],
    createdAt: RECENT,
    updatedAt: RECENT,
    ...over,
  } as Validation;
}

function pendingSavedAgentProposal(root: string, id = "sp-000001"): SavedAgentProposal {
  const base = { configSha256: workspaceConfigSha256(root) };
  const spec = { name: "grok-builder", runtimeAdapter: "grok" as const, rationale: "bounded implementation work" };
  const proposal: SavedAgentProposal = {
    id,
    proposer: "codex-canonico",
    proposerKind: "agent",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    digest: computeSavedAgentProposalDigest({ proposer: "codex-canonico", spec, base }),
    base,
    spec,
  };
  const file = savedAgentProposalPath(root, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(proposal)}\n`);
  return proposal;
}

interface Calls {
  resolved: Array<{ wsHash: string; id: string; decision: string }>;
  closed: Array<{ id: string; outcome: string; note: string }>;
  assigned: Array<{ id: string; assignee: string }>;
  validationsChanged: number;
  /** every read of the queue, so a hidden panel's work can be COUNTED rather than timed. */
  reads: string[];
}

interface Project {
  wsHash: string;
  root: string;
  folderName: string;
  validations: Validation[];
}

interface Harness {
  manager: HumanInboxPanelManager;
  calls: Calls;
  deps: HumanInboxDeps;
}

function validationTarget(project: Project, calls: Calls): WorkspaceMissionControlTarget {
  return {
    workspaceRoot: project.root,
    wsHash: project.wsHash,
    folderName: project.folderName,
    declaredAgentNames: () => [],
    listMissionControlAgents: async () => [],
    boardSnapshot: async () => ({}) as never,
    updateTask: async () => {},
    reorderLane: async () => {},
    listValidations: () => {
      calls.reads.push(project.wsHash);
      return project.validations;
    },
    closeValidation: async (id: string, input: { outcome: string; result_note: string }) => {
      calls.closed.push({ id, outcome: input.outcome, note: input.result_note });
    },
    assignValidation: async (id: string, assignee: string) => {
      calls.assigned.push({ id, assignee });
    },
  } as unknown as WorkspaceMissionControlTarget;
}

function harness(projects: Project[], over: Partial<HumanInboxDeps> = {}): Harness {
  const calls: Calls = { resolved: [], closed: [], assigned: [], validationsChanged: 0, reads: [] };
  const deps: HumanInboxDeps = {
    approvals: {
      getWorkspaces: () => projects.map((p) => ({ workspaceRoot: p.root, wsHash: p.wsHash, folderName: p.folderName })),
      resolve: async (wsHash, id, decision) => {
        calls.resolved.push({ wsHash, id, decision });
      },
    },
    validations: { getWorkspaces: () => projects.map((p) => validationTarget(p, calls)) },
    onValidationsChanged: () => { calls.validationsChanged += 1; },
    ...over,
  };
  return { manager: new HumanInboxPanelManager(extensionUri, deps), calls, deps };
}

function project(wsHash = "ws-1", folderName = "tachyon", validations: Validation[] = []): Project {
  return { wsHash, root: workspace(), folderName, validations };
}

type Posted = {
  type?: string;
  vm?: {
    items?: Array<{ id: string; kind: string; stale?: boolean }>;
    counts?: { total: number; stale: number };
    folder?: string;
    item?: { id: string; kind: string };
    artifacts?: Array<{ name: string; available: boolean; reason?: string; src?: string }>;
  };
  kind?: string;
  id?: string;
  message?: string;
};

const posted = (panel: typeof __createdPanels[number], type: string): Posted[] =>
  panel.webview.posted.filter((m) => (m as Posted).type === type) as Posted[];

/** Open one project's panel and complete the shell handshake, exactly as a real client does. */
async function open(h: Harness, wsHash = "ws-1"): Promise<typeof __createdPanels[number]> {
  h.manager.open(wsHash);
  const panel = __createdPanels[__createdPanels.length - 1];
  panel.webview.__receive(readyMessage());
  await flush();
  await flush();
  return panel;
}

describe("SDD 485 D4 — the Human Inbox app's cardinality is `dashboard`, one panel per project", () => {
  it("gives two PROJECTS a panel each, told apart by CONTENT and not by counting", async () => {
    // D2's lesson, and the reason this is not an assertion about `openKeys.length`: counting panels
    // passes just as readily against a shared model. One project has an approval waiting and the other
    // has a validation, so the two panels must post visibly different queues.
    const a = project("ws-a", "alpha");
    const b = project("ws-b", "beta", [validationRecord("v-beta")]);
    pendingApproval(a.root, "a-alpha");
    const h = harness([a, b]);

    const panelA = await open(h, "ws-a");
    const panelB = await open(h, "ws-b");

    expect(h.manager.openKeys).toEqual([`${HUMAN_INBOX_VIEW_TYPE}|ws-a`, `${HUMAN_INBOX_VIEW_TYPE}|ws-b`]);
    expect(posted(panelA, "humanInbox").at(-1)?.vm?.items?.map((i) => `${i.kind}:${i.id}`)).toEqual(["approval:a-alpha"]);
    expect(posted(panelB, "humanInbox").at(-1)?.vm?.items?.map((i) => `${i.kind}:${i.id}`)).toEqual(["validation:v-beta"]);
    expect(posted(panelA, "humanInbox").at(-1)?.vm?.folder).toBe("alpha");
    expect(posted(panelB, "humanInbox").at(-1)?.vm?.folder).toBe("beta");
  });

  it("REVEALS the panel already open for a project rather than making a second", async () => {
    const a = project("ws-a");
    const h = harness([a]);
    await open(h, "ws-a");
    expect(__createdPanels).toHaveLength(1);

    h.manager.open("ws-a");
    expect(__createdPanels).toHaveLength(1);
    expect(__createdPanels[0].revealCount).toBeGreaterThan(0);
  });

  it("the key REFUSES an identity — this is a dashboard, and the item detail is a subroute inside it", () => {
    // The symmetric proof D1 established. `inbox-item` carries identity (wsHash + kind + id), so a
    // `document` app was representable; declaring `dashboard` is the statement that it is NOT one, and a
    // key that quietly accepted an identity would let the next caller open a second panel per item.
    expect(() => sectionPanelKey(HUMAN_INBOX_VIEW_TYPE, "dashboard", { project: "ws-a", identity: "a-1" }))
      .toThrow(/has no identity/);
    expect(() => sectionPanelKey(HUMAN_INBOX_VIEW_TYPE, "dashboard", {})).toThrow(/opens against a project/);
    expect(sectionPanelKey(HUMAN_INBOX_VIEW_TYPE, "dashboard", { project: "ws-a" })).toBe(`${HUMAN_INBOX_VIEW_TYPE}|ws-a`);
  });

  it("a project that is no longer attached says so, and never borrows another project's queue", async () => {
    // STRICT lookup, the property C5 established for the Board and D2 kept for Plugins. On a surface that
    // RESOLVES APPROVALS this is containment rather than tidiness: a consent token from project A must
    // never be redeemable against project B's root.
    const a = project("ws-a", "alpha");
    const b = project("ws-b", "beta", [validationRecord("v-beta")]);
    pendingApproval(b.root, "a-beta");
    const attached = [a, b];
    const h = harness(attached);
    const panel = await open(h, "ws-a");
    expect(posted(panel, "humanInboxError")).toHaveLength(0);

    attached.splice(0, 1); // project A detaches under the open panel
    panel.webview.__receive(pollInboxAction());
    await flush();

    expect(posted(panel, "humanInboxError").at(-1)?.message).toContain("no longer attached");
    // it did NOT fall through to the only remaining workspace
    expect(posted(panel, "humanInbox").at(-1)?.vm?.items?.map((i) => i.id) ?? []).not.toContain("a-beta");
  });
});

describe("SDD 485 D4 — the Human Inbox app lists both stores, counted once", () => {
  it("one surface lists approvals and validations together, counted once", async () => {
    const p = project("ws-1", "tachyon", [validationRecord("v-1"), validationRecord("v-agent", { executor: "agent" })]);
    pendingApproval(p.root, "a-000001");
    const h = harness([p]);
    const panel = await open(h);

    const vm = posted(panel, "humanInbox").at(-1)?.vm;
    expect(vm?.items?.map((i) => `${i.kind}:${i.id}`)).toEqual(["approval:a-000001", "validation:v-1"]);
    expect(vm?.counts).toEqual({ total: 2, approvals: 1, savedAgentProposals: 0, savedAgentRemovals: 0, scheduleProposals: 0, validations: 1, stale: 0 });
  });

  it("says validations could not be read rather than showing an approvals-only list as complete", async () => {
    const p = project("ws-1");
    pendingApproval(p.root, "a-000001");
    const h = harness([p], { validations: { getWorkspaces: () => [] } });
    const panel = await open(h);

    expect(posted(panel, "humanInbox").at(-1)?.vm?.items?.length).toBe(1);
    expect(posted(panel, "humanInboxError").at(-1)?.message).toContain("Validations could not be read");
  });

  it("marks a long-waiting item stale, and still only MARKS it", async () => {
    const p = project("ws-1");
    pendingApproval(p.root, "a-000001", LONG_AGO);
    const h = harness([p]);
    const panel = await open(h);

    const vm = posted(panel, "humanInbox").at(-1)?.vm;
    expect(vm?.items?.[0]?.stale).toBe(true);
    expect(vm?.counts?.stale).toBe(1);
    // display only: staleness never decides anything. An auto-denied approval is a security decision no
    // timer should make (report § 5).
    expect(h.calls.resolved).toHaveLength(0);
    expect(h.calls.closed).toHaveLength(0);
  });

  it("uses the workspace's CONFIGURED threshold, not the product default (t-e4f662)", async () => {
    const p = project("ws-1");
    pendingApproval(p.root, "a-000001", LONG_AGO); // 72h old
    const h = harness([p], { humanInboxStaleAfter: () => 96 });
    const panel = await open(h);

    const vm = posted(panel, "humanInbox").at(-1)?.vm;
    expect(vm?.items?.[0]?.stale).toBe(false);
    expect(vm?.counts?.stale).toBe(0);
  });

  it("stops marking entirely on 'never', without hiding the row (t-e4f662)", async () => {
    const p = project("ws-1");
    pendingApproval(p.root, "a-000001", LONG_AGO);
    const h = harness([p], { humanInboxStaleAfter: () => "never" });
    const panel = await open(h);

    const vm = posted(panel, "humanInbox").at(-1)?.vm;
    expect(vm?.counts?.stale).toBe(0);
    expect(vm?.counts?.total).toBe(1); // silencing a mark is not hiding work
  });

  it("asks the resolver for THIS PANEL's workspace, so two roots can answer differently", async () => {
    // Under `dashboard` this is stronger than it was inside Control: the wsHash the resolver is asked
    // about is the panel's own KEY, not whatever the shell scope happened to be resolving to.
    const a = project("ws-a", "alpha");
    const b = project("ws-b", "beta");
    pendingApproval(a.root, "a-alpha", LONG_AGO);
    pendingApproval(b.root, "a-beta", LONG_AGO);
    const asked: string[] = [];
    const h = harness([a, b], {
      humanInboxStaleAfter: (wsHash: string) => { asked.push(wsHash); return wsHash === "ws-a" ? "never" : undefined; },
    });
    const panelA = await open(h, "ws-a");
    const panelB = await open(h, "ws-b");

    expect(asked).toContain("ws-a");
    expect(asked).toContain("ws-b");
    expect(posted(panelA, "humanInbox").at(-1)?.vm?.counts?.stale).toBe(0);
    // undefined from the resolver falls through to the product default, which still marks 72h
    expect(posted(panelB, "humanInbox").at(-1)?.vm?.counts?.stale).toBe(1);
  });
});

describe("SDD 485 D4 — the item detail is a SUBROUTE of this app, and it is per panel", () => {
  it("opens one item and previews its evidence inline", async () => {
    const p = project("ws-1", "tachyon", [
      validationRecord("v-1", { source_refs: [{ type: "screenshot", ref: "shots/one.png" }] } as Partial<Validation>),
    ]);
    fs.mkdirSync(path.join(p.root, "shots"), { recursive: true });
    fs.writeFileSync(path.join(p.root, "shots", "one.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    const h = harness([p]);
    const panel = await open(h);

    panel.webview.__receive(openInboxItemAction("validation", "v-1"));
    await flush();

    const vm = posted(panel, "humanInboxItem").at(-1)?.vm;
    expect(vm?.item?.id).toBe("v-1");
    expect(vm?.artifacts?.[0]?.name).toBe("one.png");
    expect(vm?.artifacts?.[0]?.src).toMatch(/^data:image\/png;base64,/);
  });

  it("keeps a missing artifact listed with its reason", async () => {
    const p = project("ws-1", "tachyon", [
      validationRecord("v-1", { source_refs: [{ type: "image", ref: "shots/deleted.png" }] } as Partial<Validation>),
    ]);
    const h = harness([p]);
    const panel = await open(h);

    panel.webview.__receive(openInboxItemAction("validation", "v-1"));
    await flush();

    expect(posted(panel, "humanInboxItem").at(-1)?.vm?.artifacts?.[0]).toMatchObject({
      name: "deleted.png",
      available: false,
      reason: "file not found",
    });
  });

  it("THE OPEN ITEM IS PER PANEL — project A's item never appears on project B's tab", async () => {
    // The failure a module-scoped slot would produce, and the reason this migration's state went inside
    // `bind`. C4 predicted this shape for the whole of Phase D; here it is inherent to the design rather
    // than inherited, because "the detail stays inside" IS state between messages. On a surface that
    // resolves approvals, showing project A's decision under project B's tab is the worst version of it.
    const a = project("ws-a", "alpha", [validationRecord("v-alpha")]);
    const b = project("ws-b", "beta", [validationRecord("v-beta")]);
    const h = harness([a, b]);
    const panelA = await open(h, "ws-a");
    const panelB = await open(h, "ws-b");

    panelA.webview.__receive(openInboxItemAction("validation", "v-alpha"));
    await flush();

    expect(posted(panelA, "humanInboxItem").at(-1)?.vm?.item?.id).toBe("v-alpha");
    // B was never navigated, and a poll on B must still answer with B's LIST
    expect(posted(panelB, "humanInboxItem")).toHaveLength(0);
    panelB.webview.__receive(pollInboxAction());
    await flush();
    expect(posted(panelB, "humanInboxItem")).toHaveLength(0);
    expect(posted(panelB, "humanInbox").at(-1)?.vm?.items?.map((i) => i.id)).toEqual(["v-beta"]);
  });

  it("a poll while an item is open re-reads the ITEM, not the list — the panel stays where the human is", async () => {
    const p = project("ws-1", "tachyon", [validationRecord("v-1")]);
    const h = harness([p]);
    const panel = await open(h);
    panel.webview.__receive(openInboxItemAction("validation", "v-1"));
    await flush();
    const listsBefore = posted(panel, "humanInbox").length;

    panel.webview.__receive(pollInboxAction());
    await flush();

    expect(posted(panel, "humanInboxItem").length).toBeGreaterThan(1);
    expect(posted(panel, "humanInbox")).toHaveLength(listsBefore);
  });

  it("BACK returns to the list — the affordance Control's breadcrumb used to own", async () => {
    // `cockpit/App.tsx` rendered the `← Inbox` breadcrumb for this route, so the way back was the EMBED
    // HOST's chrome. Standing alone there is no host to render it, and an item route with no exit is a
    // dead end — so the app carries its own button and the host still owns the subroute.
    const p = project("ws-1", "tachyon", [validationRecord("v-1")]);
    const h = harness([p]);
    const panel = await open(h);
    panel.webview.__receive(openInboxItemAction("validation", "v-1"));
    await flush();
    expect(posted(panel, "humanInboxItem")).toHaveLength(1);

    panel.webview.__receive(closeInboxItemAction());
    await flush();

    expect(posted(panel, "humanInbox").at(-1)?.vm?.items?.map((i) => i.id)).toEqual(["v-1"]);
  });

  it("an item that is gone returns to the refreshed list, naming what vanished (t-d16698)", async () => {
    const p = project("ws-1", "tachyon", [validationRecord("v-1")]);
    const h = harness([p]);
    const panel = await open(h);
    panel.webview.__receive(openInboxItemAction("validation", "v-vanished"));
    await flush();

    expect(posted(panel, "humanInboxItem")).toHaveLength(0);
    expect(posted(panel, "humanInbox").at(-1)?.vm?.items?.map((i) => i.id)).toEqual(["v-1"]);
    // naming the item is what lets a person tell "already resolved" from "the deep link is broken"
    expect(posted(panel, "humanInboxError").at(-1)?.message).toContain("v-vanished");
    // and the panel is BACK on the list, so the next poll does not re-attempt the dead identity
    panel.webview.__receive(pollInboxAction());
    await flush();
    expect(posted(panel, "humanInboxItem")).toHaveLength(0);
  });
});

describe("SDD 485 D4 — the deep link lands on the item, on a revealed panel as well as a fresh one", () => {
  it("opens the project's panel AND shows the item", async () => {
    const p = project("ws-1", "tachyon", [validationRecord("v-1")]);
    const h = harness([p]);
    h.manager.openItem("ws-1", "validation", "v-1");
    const panel = __createdPanels[0];
    panel.webview.__receive(readyMessage());
    await flush();

    expect(posted(panel, "humanInboxItem").at(-1)?.vm?.item?.id).toBe("v-1");
  });

  it("NAVIGATES a panel that is already open rather than leaving it on the queue", async () => {
    // The case a `document` app would have answered with a second tab and a dashboard must answer by
    // navigating: "Review" rang about ONE item, and a human whose Inbox tab was already open must land on
    // it rather than being shown the queue they were already looking at.
    const p = project("ws-1", "tachyon", [validationRecord("v-1"), validationRecord("v-2")]);
    const h = harness([p]);
    const panel = await open(h);
    expect(posted(panel, "humanInboxItem")).toHaveLength(0);

    h.manager.openItem("ws-1", "validation", "v-2");
    await flush();

    expect(__createdPanels).toHaveLength(1);
    expect(posted(panel, "humanInboxItem").at(-1)?.vm?.item?.id).toBe("v-2");
  });
});

describe("SDD 485 D4 — actions route to each kind's own path", () => {
  it("an approval decision goes through approvals.resolve, with THIS PANEL's workspace", async () => {
    const a = project("ws-a", "alpha");
    const b = project("ws-b", "beta");
    pendingApproval(a.root, "a-000001");
    pendingApproval(b.root, "a-000001");
    const h = harness([a, b]);
    const panelB = await open(h, "ws-b");
    panelB.webview.__receive(openInboxItemAction("approval", "a-000001"));
    await flush();

    panelB.webview.__receive({ type: "resolveInboxApproval", id: "a-000001", decision: "approved" });
    await flush();

    // the panel's own key decides the workspace — not a shell scope, and not the first attached root
    expect(h.calls.resolved).toEqual([{ wsHash: "ws-b", id: "a-000001", decision: "approved" }]);
    expect(h.calls.closed).toHaveLength(0);
    // terminal decision → back to the queue, never a tombstone (t-00f4bc / t-e5e995)
    expect(posted(panelB, "humanInbox").at(-1)).toBeTruthy();
    expect(posted(panelB, "humanInboxItemMissing")).toHaveLength(0);
  });

  it("an approval failure stays on its item with an actionable error", async () => {
    const p = project("ws-1");
    pendingApproval(p.root, "a-000001");
    const h = harness([p], {
      approvals: {
        getWorkspaces: () => [{ workspaceRoot: p.root, wsHash: "ws-1", folderName: "tachyon" }],
        resolve: async () => { throw new Error("approval store is unavailable"); },
      },
    });
    const panel = await open(h);
    panel.webview.__receive(openInboxItemAction("approval", "a-000001"));
    await flush();
    const itemsBefore = posted(panel, "humanInboxItem").length;

    panel.webview.__receive({ type: "resolveInboxApproval", id: "a-000001", decision: "denied" });
    await flush();

    expect(posted(panel, "humanInboxError").at(-1)?.message).toContain("approval store is unavailable");
    // still on the item: a failed decision must leave the human where they can retry it
    panel.webview.__receive(pollInboxAction());
    await flush();
    expect(posted(panel, "humanInboxItem").length).toBeGreaterThan(itemsBefore);
  });

  it.each(["approve", "deny"] as const)("a Saved Agent proposal %s returns to the refreshed queue", async (decision) => {
    const p = project("ws-1");
    const proposal = pendingSavedAgentProposal(p.root);
    const approveCalls: string[] = [];
    const h = harness([p], {
      approveSavedAgentProposal: async ({ proposalId }) => {
        approveCalls.push(proposalId);
        return {
          ok: true,
          receipt: {
            digest: proposal.digest,
            proposalId,
            proposer: proposal.proposer,
            approvedBy: "human",
            agentName: "grok-builder",
            approvedAt: new Date().toISOString(),
            outcome: "committed",
            operation: "create",
          },
        };
      },
    });
    const panel = await open(h);
    panel.webview.__receive(openInboxItemAction("saved-agent-proposal", proposal.id));
    await flush();

    panel.webview.__receive({
      type: "decideSavedAgentProposal",
      id: proposal.id,
      digest: proposal.digest,
      decision,
      ...(decision === "deny" ? { reason: "not needed" } : {}),
    });
    await flush();

    expect(approveCalls).toEqual(decision === "approve" ? [proposal.id] : []);
    // back on the QUEUE, which is the claim: a terminal decision navigates rather than leaving the human
    // on an item whose identity it just spent. (What the queue then CONTAINS is the store's business —
    // this harness's commit port is a spy and does not delete the proposal file.)
    expect(posted(panel, "humanInbox").length).toBeGreaterThan(0);
    expect(posted(panel, "humanInboxItemMissing")).toHaveLength(0);
  });

  it("commits a Saved Agent proposal against the workspace THIS PANEL is keyed to", async () => {
    // Inside Control this workspace came from the item ROUTE. It comes from the panel's key now, which is
    // a stronger form of the same guarantee: there is no ambient scope left that could disagree with it.
    const a = project("ws-a", "alpha");
    const b = project("ws-b", "beta");
    const proposal = pendingSavedAgentProposal(b.root);
    const committedRoots: string[] = [];
    const h = harness([a, b], {
      approveSavedAgentProposal: async ({ workspaceRoot }) => {
        committedRoots.push(workspaceRoot);
        return {
          ok: true,
          receipt: {
            digest: proposal.digest,
            proposalId: proposal.id,
            proposer: proposal.proposer,
            approvedBy: "human",
            agentName: proposal.spec.name,
            approvedAt: new Date().toISOString(),
            outcome: "committed",
            operation: "create",
          },
        };
      },
    });
    const panelB = await open(h, "ws-b");
    panelB.webview.__receive(openInboxItemAction("saved-agent-proposal", proposal.id));
    await flush();

    panelB.webview.__receive({ type: "decideSavedAgentProposal", id: proposal.id, digest: proposal.digest, decision: "approve" });
    await flush();

    expect(committedRoots).toEqual([b.root]);
  });

  it("a refused Saved Agent commit stays on the item with its refusal", async () => {
    const p = project("ws-1");
    const proposal = pendingSavedAgentProposal(p.root);
    const h = harness([p], {
      approveSavedAgentProposal: async () => ({ ok: false, code: "base_diverged", reason: "workspace config changed" }),
    });
    const panel = await open(h);
    panel.webview.__receive(openInboxItemAction("saved-agent-proposal", proposal.id));
    await flush();
    const listsBefore = posted(panel, "humanInbox").length;

    panel.webview.__receive({ type: "decideSavedAgentProposal", id: proposal.id, digest: proposal.digest, decision: "approve" });
    await flush();

    expect(posted(panel, "humanInboxError").at(-1)?.message).toContain("workspace config changed");
    expect(posted(panel, "humanInbox")).toHaveLength(listsBefore); // did NOT navigate away
  });

  it("a host that cannot commit says so rather than accepting the click and doing nothing", async () => {
    const p = project("ws-1");
    const proposal = pendingSavedAgentProposal(p.root);
    const h = harness([p]); // no approveSavedAgentProposal port wired
    const panel = await open(h);
    panel.webview.__receive(openInboxItemAction("saved-agent-proposal", proposal.id));
    await flush();

    panel.webview.__receive({ type: "decideSavedAgentProposal", id: proposal.id, digest: proposal.digest, decision: "approve" });
    await flush();

    expect(posted(panel, "humanInboxError").at(-1)?.message).toContain("cannot commit");
  });

  it("closing and assigning a validation go through the validation store, never the approval path", async () => {
    const p = project("ws-1", "tachyon", [validationRecord("v-1")]);
    pendingApproval(p.root, "a-000001");
    const h = harness([p]);
    const panel = await open(h);

    panel.webview.__receive({ type: "closeInboxValidation", id: "v-1", outcome: "passed", note: "looks right" });
    await flush();
    panel.webview.__receive({
      type: "assignInboxValidation",
      id: "v-1",
      assignee: "human",
      expect: { assignee: null, updatedAt: RECENT },
    });
    await flush();

    expect(h.calls.closed).toEqual([{ id: "v-1", outcome: "passed", note: "looks right" }]);
    expect(h.calls.assigned).toEqual([{ id: "v-1", assignee: "human" }]);
    // the load-bearing assertion of this whole surface: nothing a validation row can send reaches the
    // capability path. There is no wire shape for it, so there is nothing to guard at runtime.
    expect(h.calls.resolved).toHaveLength(0);
    // and both still invalidate what they always invalidated (the Board's counts, Control's Validations)
    expect(h.calls.validationsChanged).toBe(2);
  });

  it("closing a validation returns to the queue, while assigning keeps the human on the item", async () => {
    const p = project("ws-1", "tachyon", [validationRecord("v-1")]);
    const h = harness([p]);
    const panel = await open(h);
    panel.webview.__receive(openInboxItemAction("validation", "v-1"));
    await flush();
    const listsBefore = posted(panel, "humanInbox").length;

    panel.webview.__receive({
      type: "assignInboxValidation",
      id: "v-1",
      assignee: "human",
      expect: { assignee: null, updatedAt: RECENT },
    });
    await flush();
    expect(posted(panel, "humanInbox")).toHaveLength(listsBefore); // still on the item
    expect(posted(panel, "humanInboxItem").length).toBeGreaterThan(1);

    panel.webview.__receive({ type: "closeInboxValidation", id: "v-1", outcome: "passed", note: "done" });
    await flush();
    expect(posted(panel, "humanInbox").length).toBeGreaterThan(listsBefore);
    // t-00f4bc — a terminal decision navigates; it never renders the "no longer waiting" tombstone
    expect(posted(panel, "humanInboxItemMissing")).toHaveLength(0);
  });

  it("t-00f4bc — the host never posts the missing-item tombstone on a completion path", () => {
    // Static contract, moved with the surface: `HumanInboxPanel.ts` must not reintroduce the tombstone
    // message on the success path. The client still understands the wire type for legacy reloads; the
    // host must not emit it when the product itself completed the item (that was the dogfood bug).
    const host = fs.readFileSync(path.resolve(__dirname, "../../src/webview/HumanInboxPanel.ts"), "utf8");
    expect(host).toMatch(/open = undefined;/);
    expect(host).not.toMatch(/session\.post\(humanInboxItemMissingMessage/);
  });
});

describe("SDD 485 D4 — hidden panels do no work, and the poll is gated host-side", () => {
  it("claims READY and the poll for the gate, and leaves the human's Refresh to onMessage", () => {
    expect(humanInboxRefreshKind(readyMessage())).toBe("inbox");
    expect(humanInboxRefreshKind(pollInboxAction())).toBe("inbox");
    // `refreshInbox` is the human pressing the button. Measured, not assumed: it does the same pure
    // re-read the poll does, so sharing the word would have been SAFE here (unlike Plugins, whose
    // `refresh` drops every update check). It is kept separate so a later side effect on the human
    // action cannot silently acquire a caller that runs twenty times a minute.
    expect(humanInboxRefreshKind(refreshInboxAction())).toBeUndefined();
    expect(humanInboxRefreshKind({ type: "openInboxItem" })).toBeUndefined();
  });

  it("twenty polls behind another tab do NO reads, and the reveal catches up once", async () => {
    const p = project("ws-1", "tachyon", [validationRecord("v-1")]);
    const h = harness([p]);
    const panel = await open(h);
    const readsWhileVisible = h.calls.reads.length;
    expect(readsWhileVisible).toBeGreaterThan(0); // the door is LIVE while visible — not a dead door

    __setPanelVisible(panel, false);
    for (let i = 0; i < 20; i += 1) panel.webview.__receive(pollInboxAction());
    await flush();
    expect(h.calls.reads).toHaveLength(readsWhileVisible);

    __setPanelVisible(panel, true);
    await flush();
    expect(h.calls.reads.length).toBeGreaterThan(readsWhileVisible);
  });

  it("the human's Refresh re-reads the queue", async () => {
    const p = project("ws-1", "tachyon", [validationRecord("v-1")]);
    const h = harness([p]);
    const panel = await open(h);
    const before = h.calls.reads.length;

    panel.webview.__receive(refreshInboxAction());
    await flush();

    expect(h.calls.reads.length).toBeGreaterThan(before);
  });

  it("the fan-out door refreshes every open panel — this is the first Phase D surface that has one", async () => {
    // tmux, Plugins and Runtime Ops are all polled rather than watched, and each recorded that its
    // `refresh()` had no caller yet. This one has two: `refreshCockpitApprovals` and
    // `refreshCockpitValidations` both invalidated the Inbox, because it is a projection over both stores.
    const a = project("ws-a", "alpha");
    const b = project("ws-b", "beta");
    const h = harness([a, b]);
    await open(h, "ws-a");
    await open(h, "ws-b");
    const before = h.calls.reads.length;

    expect(h.manager.refresh()).toBe(2);
    await flush();
    expect(h.calls.reads.length).toBe(before + 2);
  });
});

describe("SDD 485 D4 — restore, and the viewType that had no legacy id to reuse", () => {
  it("revives a panel VS Code hands back, on the same key", async () => {
    const p = project("ws-1", "tachyon", [validationRecord("v-1")]);
    const h = harness([p]);
    h.manager.open("ws-1");
    const persisted = JSON.parse(/__tachyonPersistedState=(\{.*?\});/.exec(__createdPanels[0].webview.html)![1]) as SectionPanelState;
    // the project IS the key, so it is what the record carries — and there is no legacy spelling to
    // migrate, because nothing ever wrote a record under this viewType.
    expect(persisted).toEqual({ schemaVersion: 1, view: HUMAN_INBOX_VIEW_TYPE, project: "ws-1" });
    __createdPanels[0].dispose();

    const context = { subscriptions: [] } as unknown as import("vscode").ExtensionContext;
    const revivedHarness = harness([p]);
    registerTrustedPanelSerializer<SectionPanelState>(context, HUMAN_INBOX_VIEW_TYPE, (panel, state) => revivedHarness.manager.deserialize(panel, state));
    const registration = __registeredWebviewPanelSerializers.find((r) => r.viewType === HUMAN_INBOX_VIEW_TYPE);
    expect(registration, "no serializer registered for the Human Inbox viewType").toBeTruthy();

    const panel = makeRevivablePanel();
    await registration!.serializer.deserializeWebviewPanel(panel as never, persisted);
    panel.webview.__receive(readyMessage());
    await flush();
    await flush();

    expect(revivedHarness.manager.openKeys).toEqual([`${HUMAN_INBOX_VIEW_TYPE}|ws-1`]);
    expect(panel.disposed).toBe(false);
    expect(__createdPanels.filter((q) => !q.disposed), "revival created a second panel").toHaveLength(0);
    expect(panel.webview.posted.filter((m) => (m as { type?: string }).type === "humanInbox")).toHaveLength(1);
  });

  it("the viewType is NEW because no legacy id names this surface", () => {
    // The sixth call in this spec's series, and the first with no subject: the Human Inbox was born as a
    // Control section (t-e76acc) AFTER 410 retired the standalone panels, so it never had a
    // `createWebviewPanel` call and never wrote a record under any id. `tachyonApprovals` is a LIVE
    // redirect naming a DIFFERENT surface that spec.md keeps as a compatibility route.
    expect(HUMAN_INBOX_VIEW_TYPE).toBe("tachyonHumanInbox");
    const host = fs.readFileSync(path.resolve(__dirname, "../../src/webview/HumanInboxPanel.ts"), "utf8");
    // No shim, because there is no legacy record: C4's and D2's reuses each cost a `migrateLegacy`, and
    // this one has nothing to migrate FROM.
    expect(host).not.toContain("migrateLegacy");
    // and it never adopts the one id that looks available — `tachyonApprovals` is a live redirect naming
    // a different surface. Quoted, so the reasoning in this file's comments does not satisfy the check.
    expect(host).not.toContain('"tachyonApprovals"');
  });
});

/** A panel VS Code hands back on reload — not one this manager created, which is the whole point. */
function makeRevivablePanel() {
  const disposeHandlers: Array<() => void> = [];
  const receivers: Array<(msg: unknown) => void> = [];
  const panel = {
    title: "",
    iconPath: undefined,
    disposed: false,
    visible: true,
    active: true,
    revealCount: 0,
    onDidChangeViewState: (_cb: () => void) => ({ dispose() {} }),
    webview: {
      html: "",
      options: {},
      cspSource: "vscode-webview:",
      posted: [] as unknown[],
      asWebviewUri: (uri: unknown) => uri,
      postMessage: async (msg: unknown) => { panel.webview.posted.push(msg); return true; },
      onDidReceiveMessage: (cb: (msg: unknown) => void) => { receivers.push(cb); return { dispose() {} }; },
      __receive: (msg: unknown) => { for (const cb of receivers) cb(msg); },
    },
    reveal: () => { panel.revealCount += 1; },
    dispose: () => { panel.disposed = true; for (const cb of disposeHandlers) cb(); },
    onDidDispose: (cb: () => void) => { disposeHandlers.push(cb); return { dispose() {} }; },
  };
  return panel;
}
