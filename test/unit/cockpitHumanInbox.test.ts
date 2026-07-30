import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { __createdPanels, __resetVscodeMock } from "../mocks/vscode.js";
import { openCockpit, type CockpitDeps, type CockpitMissionBoard } from "../../src/webview/Cockpit.js";
import { makeFakeCockpitDeps } from "../mocks/cockpitDeps.js";
import { routes as cockpitRoutes } from "../../src/cockpit/route.js";
import { buildApprovalRequest, writeApprovalRequest } from "../../src/bridge/approvalRequest.js";
import { computeSavedAgentProposalDigest, type SavedAgentProposal } from "../../src/agents/savedAgentProposal.js";
import { savedAgentProposalPath } from "../../src/agents/savedAgentProposalStore.js";
import { workspaceConfigSha256 } from "../../src/config/agentProfileGrants.js";
import type { WorkspaceMissionControlTarget } from "../../src/shell/MissionControlTarget.js";
import type { Validation } from "../../src/validations/types.js";

/**
 * Control → Human Inbox: the host wiring (t-e76acc).
 *
 * The projection is proven elsewhere; what is proven here is the thing only the host can be wrong
 * about — that ONE surface reads BOTH stores, that acting on a row lands in that kind's OWN typed
 * path, and that no path exists by which a validation reaches the approval one.
 */
const roots: string[] = [];

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  for (const p of __createdPanels) if (!p.disposed) p.dispose();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-inbox-host-"));
  roots.push(root);
  return root;
}

/**
 * The host reads staleness against the REAL clock, so these timestamps are relative on purpose: a
 * fixed "recent" date would silently become stale once wall-clock time passed it, and the assertion
 * would start failing months later for no reason anyone could connect to this change.
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
}

function depsFor(root: string, validations: Validation[]): { deps: CockpitDeps; calls: Calls } {
  const calls: Calls = { resolved: [], closed: [], assigned: [] };
  const missionBoard: CockpitMissionBoard = { getWorkspaces: () => [], openTaskStudio: () => {}, onTasksChanged: () => {} };
  const target = {
    workspaceRoot: root,
    wsHash: "ws-1",
    folderName: "tachyon",
    declaredAgentNames: () => [],
    listMissionControlAgents: async () => [],
    boardSnapshot: async () => ({}) as never,
    updateTask: async () => {},
    reorderLane: async () => {},
    listValidations: () => validations,
    closeValidation: async (id: string, input: { outcome: string; result_note: string }) => {
      calls.closed.push({ id, outcome: input.outcome, note: input.result_note });
    },
    assignValidation: async (id: string, assignee: string) => {
      calls.assigned.push({ id, assignee });
    },
  } as unknown as WorkspaceMissionControlTarget;
  const deps = makeFakeCockpitDeps(missionBoard, {
    approvals: {
      getWorkspaces: () => [{ workspaceRoot: root, wsHash: "ws-1", folderName: "tachyon" }],
      resolve: async (wsHash, id, decision) => {
        calls.resolved.push({ wsHash, id, decision });
      },
    },
    validations: { getWorkspaces: () => [target], onValidationsChanged: () => {} },
  });
  return { deps, calls };
}

type Posted = { type?: string; strings?: unknown; vm?: { items?: Array<{ id: string; kind: string }>; counts?: unknown; item?: { id: string; kind: string }; artifacts?: Array<{ name: string; available: boolean; reason?: string; src?: string }> }; kind?: string; id?: string; message?: string };
const posted = (type: string): Posted[] => __createdPanels[0].webview.posted.filter((m) => (m as Posted).type === type) as Posted[];

async function openInbox(deps: CockpitDeps): Promise<void> {
  await openCockpit(deps, { section: "inbox" });
  __createdPanels[0].webview.__receive({ type: "ready" });
  await flush();
}

describe("Control → Human Inbox section", () => {
  it("one surface lists approvals and validations together, counted once", async () => {
    const root = workspace();
    pendingApproval(root, "a-000001");
    const { deps } = depsFor(root, [validationRecord("v-1"), validationRecord("v-agent", { executor: "agent" })]);
    await openInbox(deps);

    const vm = posted("humanInbox").at(-1)?.vm;
    expect(vm?.items?.map((i) => `${i.kind}:${i.id}`)).toEqual(["approval:a-000001", "validation:v-1"]);
    expect(vm?.counts).toEqual({ total: 2, approvals: 1, savedAgentProposals: 0, validations: 1, stale: 0 });
  });

  it("says validations could not be read rather than showing an approvals-only list as complete", async () => {
    const root = workspace();
    pendingApproval(root, "a-000001");
    const { deps } = depsFor(root, []);
    // a workspace the validations dep does not know about: half the inbox is genuinely unavailable
    const blind = makeFakeCockpitDeps({ getWorkspaces: () => [], openTaskStudio: () => {}, onTasksChanged: () => {} }, {
      approvals: deps.approvals,
      validations: { getWorkspaces: () => [], onValidationsChanged: () => {} },
    });
    await openInbox(blind);

    expect(posted("humanInbox").at(-1)?.vm?.items?.length).toBe(1);
    expect(posted("humanInboxError").at(-1)?.message).toContain("Validations could not be read");
  });

  it("marks a long-waiting item stale in the surface, and still only marks it", async () => {
    const root = workspace();
    pendingApproval(root, "a-000001", LONG_AGO);
    const { deps, calls } = depsFor(root, []);
    await openInbox(deps);

    const vm = posted("humanInbox").at(-1)?.vm as { items?: Array<{ stale?: boolean }>; counts?: { stale: number } } | undefined;
    expect(vm?.items?.[0]?.stale).toBe(true);
    expect(vm?.counts?.stale).toBe(1);
    // display only: staleness never decides anything. An auto-denied approval is a security decision
    // no timer should make (report § 5).
    expect(calls.resolved).toHaveLength(0);
    expect(calls.closed).toHaveLength(0);
  });

  it("uses the workspace's CONFIGURED threshold, not the product default (t-e4f662)", async () => {
    // The bug this closes was silent: the projection always took the parameter and nothing ever
    // passed one, so every workspace got 24h no matter what its tachyon.yml said. A resolver that
    // came unwired would look exactly like a project that configured nothing — hence a host test.
    const root = workspace();
    pendingApproval(root, "a-000001", LONG_AGO); // 72h old
    const { deps } = depsFor(root, []);
    await openInbox({ ...deps, humanInboxStaleAfter: () => 96 });

    const vm = posted("humanInbox").at(-1)?.vm as { items?: Array<{ stale?: boolean }>; counts?: { stale: number } } | undefined;
    expect(vm?.items?.[0]?.stale).toBe(false);
    expect(vm?.counts?.stale).toBe(0);
  });

  it("stops marking entirely on 'never', without hiding the row (t-e4f662)", async () => {
    const root = workspace();
    pendingApproval(root, "a-000001", LONG_AGO);
    const { deps } = depsFor(root, []);
    await openInbox({ ...deps, humanInboxStaleAfter: () => "never" });

    const vm = posted("humanInbox").at(-1)?.vm as { items?: Array<{ stale?: boolean }>; counts?: { stale: number; total: number } } | undefined;
    expect(vm?.counts?.stale).toBe(0);
    expect(vm?.counts?.total).toBe(1); // silencing a mark is not hiding work
  });

  it("asks the resolver for THIS workspace, so two roots can answer differently", async () => {
    const root = workspace();
    pendingApproval(root, "a-000001", LONG_AGO);
    const { deps } = depsFor(root, []);
    const asked: string[] = [];
    await openInbox({ ...deps, humanInboxStaleAfter: (wsHash: string) => { asked.push(wsHash); return undefined; } });

    expect(asked).toContain("ws-1");
    // undefined from the resolver falls through to the product default, which still marks 72h
    expect((posted("humanInbox").at(-1)?.vm as { counts?: { stale: number } } | undefined)?.counts?.stale).toBe(1);
  });

  it("with no attached workspace it says so instead of rendering an empty inbox", async () => {
    const bare = makeFakeCockpitDeps({ getWorkspaces: () => [], openTaskStudio: () => {}, onTasksChanged: () => {} });
    await openInbox(bare);
    expect(posted("humanInbox")).toHaveLength(0);
    expect(posted("humanInboxError").at(-1)?.message).toContain("No Tachyon workspace");
  });
});

describe("Control → Human Inbox item route", () => {
  it("opens one item and previews its evidence inline", async () => {
    const root = workspace();
    fs.mkdirSync(path.join(root, "shots"), { recursive: true });
    fs.writeFileSync(path.join(root, "shots", "one.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    const { deps } = depsFor(root, [
      validationRecord("v-1", {
        source_refs: [{ type: "screenshot", ref: "shots/one.png" }],
      } as Partial<Validation>),
    ]);
    await openCockpit(deps, { route: cockpitRoutes.inboxItem("ws-1", "validation", "v-1") });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();

    const vm = posted("humanInboxItem").at(-1)?.vm;
    expect(vm?.item?.id).toBe("v-1");
    expect(vm?.artifacts?.[0]?.name).toBe("one.png");
    expect(vm?.artifacts?.[0]?.src).toMatch(/^data:image\/png;base64,/);
  });

  it("an item that is gone returns to the refreshed Inbox list", async () => {
    const root = workspace();
    const { deps } = depsFor(root, []);
    await openCockpit(deps, { route: cockpitRoutes.inboxItem("ws-1", "validation", "v-vanished") });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();

    expect(posted("humanInboxItem")).toHaveLength(0);
    expect(posted("humanInbox").at(-1)?.vm?.items).toEqual([]);
    const model = posted("model").at(-1) as { model?: { activeRoute?: unknown; section?: string } } | undefined;
    expect(model?.model?.activeRoute).toBeUndefined();
    expect(model?.model?.section).toBe("inbox");
    expect((posted("routePending").at(-1) as { routeKey?: string } | undefined)?.routeKey).toBe("section:inbox");
    // t-00f4bc / t-e5e995 — host navigates; it does not leave the client on a missing-item tombstone.
    expect(posted("humanInboxItemMissing")).toHaveLength(0);
  });

  it("keeps a missing artifact listed with its reason", async () => {
    const root = workspace();
    const { deps } = depsFor(root, [
      validationRecord("v-1", { source_refs: [{ type: "image", ref: "shots/deleted.png" }] } as Partial<Validation>),
    ]);
    await openCockpit(deps, { route: cockpitRoutes.inboxItem("ws-1", "validation", "v-1") });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();

    expect(posted("humanInboxItem").at(-1)?.vm?.artifacts?.[0]).toMatchObject({
      name: "deleted.png",
      available: false,
      reason: "file not found",
    });
  });
});

describe("Control → Human Inbox and the shell's handshake", () => {
  /**
   * t-2f6cdd landed on main while this branch was open: a panel whose FIRST route was task-detail
   * rendered nothing at all, because that route's action handler answered READY itself and returned
   * true — consuming the one handshake that posts `init` (the shell's only source of `strings`),
   * `model` and the section module. Every route kind added after it inherits the same hazard, and
   * `openHumanInbox` / the validation notice's Review action both create exactly that shape: a fresh
   * panel whose first route is the Inbox.
   *
   * So this is the class check for THIS route, not a copy of that fix's own test: a bare "ready"
   * must reach the shell, and the panel must come up with strings, a model, and its content.
   */
  it("a panel opened straight onto the inbox section still gets init, model and its list", async () => {
    const root = workspace();
    pendingApproval(root, "a-000001");
    const { deps } = depsFor(root, [validationRecord("v-1")]);
    await openInbox(deps);

    expect(posted("init").at(-1)?.strings).toBeTruthy();
    expect(posted("model")).not.toHaveLength(0);
    expect(posted("humanInbox").at(-1)?.vm?.items?.length).toBe(2);
  });

  it("a panel opened straight onto an INBOX ITEM still gets init, model and the item", async () => {
    const root = workspace();
    const { deps } = depsFor(root, [validationRecord("v-1")]);
    await openCockpit(deps, { route: cockpitRoutes.inboxItem("ws-1", "validation", "v-1") });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();

    // strings first — their absence is what rendered `<div class="ds-empty">` and nothing else
    expect(posted("init").at(-1)?.strings).toBeTruthy();
    const modelIndex = __createdPanels[0].webview.posted.findIndex((m) => (m as { type?: string }).type === "model");
    const itemIndex = __createdPanels[0].webview.posted.findIndex((m) => (m as { type?: string }).type === "humanInboxItem");
    expect(modelIndex).toBeGreaterThanOrEqual(0);
    expect(itemIndex).toBeGreaterThan(modelIndex); // the model arrives BEFORE the item the client identity-checks against it
  });
});

describe("Control → Human Inbox actions route to each kind's own path", () => {
  it("an approval decision goes through approvals.resolve, with the route's workspace", async () => {
    const root = workspace();
    pendingApproval(root, "a-000001");
    const { deps, calls } = depsFor(root, []);
    await openCockpit(deps, { route: cockpitRoutes.inboxItem("ws-1", "approval", "a-000001") });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();

    __createdPanels[0].webview.__receive({ type: "resolveInboxApproval", id: "a-000001", decision: "approved" });
    await flush();

    expect(calls.resolved).toEqual([{ wsHash: "ws-1", id: "a-000001", decision: "approved" }]);
    expect(calls.closed).toHaveLength(0);
    expect((posted("model").at(-1) as { model?: { section?: string } } | undefined)?.model?.section).toBe("inbox");
    expect((posted("routePending").at(-1) as { routeKey?: string } | undefined)?.routeKey).toBe("section:inbox");
    // t-00f4bc — normal completion must not render the "no longer waiting" tombstone wire.
    expect(posted("humanInboxItemMissing")).toHaveLength(0);
  });

  it("an approval failure stays on its detail route and posts an actionable error", async () => {
    const root = workspace();
    pendingApproval(root, "a-000001");
    const { deps } = depsFor(root, []);
    deps.approvals.resolve = async () => { throw new Error("approval store is unavailable"); };
    await openCockpit(deps, { route: cockpitRoutes.inboxItem("ws-1", "approval", "a-000001") });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();

    __createdPanels[0].webview.__receive({ type: "resolveInboxApproval", id: "a-000001", decision: "denied" });
    await flush();

    expect(posted("humanInboxError").at(-1)?.message).toContain("approval store is unavailable");
    expect((posted("model").at(-1) as { model?: { activeRoute?: unknown } } | undefined)?.model?.activeRoute)
      .toEqual(cockpitRoutes.inboxItem("ws-1", "approval", "a-000001"));
  });

  it.each(["approve", "deny"] as const)("a Saved Agent proposal %s returns to the refreshed Inbox", async (decision) => {
    const root = workspace();
    const proposal = pendingSavedAgentProposal(root);
    const { deps } = depsFor(root, []);
    const approveCalls: string[] = [];
    const withProposalCommit: CockpitDeps = {
      ...deps,
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
    };
    await openCockpit(withProposalCommit, {
      route: cockpitRoutes.inboxItem("ws-1", "saved-agent-proposal", proposal.id),
    });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();

    __createdPanels[0].webview.__receive({
      type: "decideSavedAgentProposal",
      id: proposal.id,
      digest: proposal.digest,
      decision,
      ...(decision === "deny" ? { reason: "not needed" } : {}),
    });
    await flush();

    expect(approveCalls).toEqual(decision === "approve" ? [proposal.id] : []);
    expect((posted("model").at(-1) as { model?: { section?: string } } | undefined)?.model?.section).toBe("inbox");
    expect((posted("routePending").at(-1) as { routeKey?: string } | undefined)?.routeKey).toBe("section:inbox");
  });

  it("commits a Saved Agent proposal against the workspace named by its detail route", async () => {
    const firstRoot = workspace();
    const proposalRoot = workspace();
    const proposal = pendingSavedAgentProposal(proposalRoot);
    const { deps } = depsFor(firstRoot, []);
    const committedRoots: string[] = [];
    await openCockpit({
      ...deps,
      approvals: {
        ...deps.approvals,
        getWorkspaces: () => [
          { workspaceRoot: firstRoot, wsHash: "ws-1", folderName: "first" },
          { workspaceRoot: proposalRoot, wsHash: "ws-2", folderName: "second" },
        ],
      },
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
    }, { route: cockpitRoutes.inboxItem("ws-2", "saved-agent-proposal", proposal.id) });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();

    __createdPanels[0].webview.__receive({
      type: "decideSavedAgentProposal",
      id: proposal.id,
      digest: proposal.digest,
      decision: "approve",
    });
    await flush();

    expect(committedRoots).toEqual([proposalRoot]);
  });

  it("a refused Saved Agent proposal commit stays on the detail route with its refusal", async () => {
    const root = workspace();
    const proposal = pendingSavedAgentProposal(root);
    const { deps } = depsFor(root, []);
    await openCockpit({
      ...deps,
      approveSavedAgentProposal: async () => ({
        ok: false,
        code: "base_diverged",
        reason: "workspace config changed",
      }),
    }, { route: cockpitRoutes.inboxItem("ws-1", "saved-agent-proposal", proposal.id) });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();
    const pendingBeforeDecision = posted("routePending").length;

    __createdPanels[0].webview.__receive({
      type: "decideSavedAgentProposal",
      id: proposal.id,
      digest: proposal.digest,
      decision: "approve",
    });
    await flush();

    expect(posted("humanInboxError").at(-1)?.message).toContain("workspace config changed");
    expect((posted("model").at(-1) as { model?: { activeRoute?: unknown } } | undefined)?.model?.activeRoute)
      .toEqual(cockpitRoutes.inboxItem("ws-1", "saved-agent-proposal", proposal.id));
    expect(posted("routePending")).toHaveLength(pendingBeforeDecision);
  });

  it("closing and assigning a validation go through the validation store, never the approval path", async () => {
    const root = workspace();
    pendingApproval(root, "a-000001");
    const { deps, calls } = depsFor(root, [validationRecord("v-1")]);
    await openInbox(deps);

    __createdPanels[0].webview.__receive({ type: "closeInboxValidation", id: "v-1", outcome: "passed", note: "looks right" });
    __createdPanels[0].webview.__receive({
      type: "assignInboxValidation",
      id: "v-1",
      assignee: "human",
      expect: { assignee: null, updatedAt: RECENT },
    });
    await flush();

    expect(calls.closed).toEqual([{ id: "v-1", outcome: "passed", note: "looks right" }]);
    expect(calls.assigned).toEqual([{ id: "v-1", assignee: "human" }]);
    // the load-bearing assertion of this whole surface: nothing a validation row can send reaches
    // the capability path. There is no wire shape for it, so there is nothing to guard at runtime.
    expect(calls.resolved).toHaveLength(0);
  });

  it("closing a validation returns to Inbox, while assigning keeps the detail route", async () => {
    const root = workspace();
    const { deps } = depsFor(root, [validationRecord("v-1")]);
    await openCockpit(deps, { route: cockpitRoutes.inboxItem("ws-1", "validation", "v-1") });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();

    __createdPanels[0].webview.__receive({
      type: "assignInboxValidation",
      id: "v-1",
      assignee: "human",
      expect: { assignee: null, updatedAt: RECENT },
    });
    await flush();
    expect((posted("model").at(-1) as { model?: { activeRoute?: unknown } } | undefined)?.model?.activeRoute)
      .toEqual(cockpitRoutes.inboxItem("ws-1", "validation", "v-1"));

    __createdPanels[0].webview.__receive({ type: "closeInboxValidation", id: "v-1", outcome: "passed", note: "done" });
    await flush();
    expect((posted("model").at(-1) as { model?: { section?: string } } | undefined)?.model?.section).toBe("inbox");
    expect((posted("routePending").at(-1) as { routeKey?: string } | undefined)?.routeKey).toBe("section:inbox");
    // t-00f4bc — Validation close is a terminal decision; same navigation contract as Approval resolve.
    expect(posted("humanInboxItemMissing")).toHaveLength(0);
  });

  it("t-00f4bc — host never posts the missing-item tombstone after a terminal decision", async () => {
    // Static contract: Cockpit must not reintroduce humanInboxItemMissingMessage on the success path.
    // The client may still understand the wire type for legacy reloads; the host must not emit it when
    // the product itself completed the item (that was the dogfood bug: tombstone instead of list).
    const host = fs.readFileSync(path.resolve(__dirname, "../../src/webview/Cockpit.ts"), "utf8");
    expect(host).toContain("returnToInbox");
    expect(host).not.toContain("humanInboxItemMissingMessage");
  });

  it("opening a row navigates to the item route rather than resolving anything", async () => {
    const root = workspace();
    pendingApproval(root, "a-000001");
    const { deps, calls } = depsFor(root, []);
    await openInbox(deps);

    __createdPanels[0].webview.__receive({ type: "openInboxItem", kind: "approval", id: "a-000001" });
    await flush();

    const model = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "model").at(-1) as
      | { model?: { activeRoute?: { kind: string; itemKind: string; itemId: string }; section?: string } }
      | undefined;
    expect(model?.model?.activeRoute).toMatchObject({ kind: "inbox-item", itemKind: "approval", itemId: "a-000001" });
    // the nav tab underneath stays the Inbox — the human is working a counted queue down
    expect(model?.model?.section).toBe("inbox");
    expect(calls.resolved).toHaveLength(0);
  });
});
