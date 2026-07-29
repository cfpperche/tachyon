import { describe, it, expect } from "vitest";
import {
  GatedCompletionMonitor,
  candidateKey,
  hostFallbackLine,
  isArmableAttention,
  assignedCompletionFacts,
  resolveAssignedCompletionWorktree,
  type GatedCandidateRecord,
  type GatedCompletionFacts,
} from "../../src/workspace/GatedCompletionMonitor.js";
import type { AgentAttention } from "../../src/attention/AttentionMonitor.js";
import type { ManagedEntryInfo } from "../../src/agents/AgentManager.js";

const GRACE = 45_000;

const entry = (name: string, opts: Partial<ManagedEntryInfo> = {}): ManagedEntryInfo => ({
  name,
  session: `s-${name}`,
  running: true,
  declared: false,
  dead: false,
  crashed: false,
  kind: "agent",
  delegator: "boss",
  ...opts,
});

const att = (state: AgentAttention["state"]): AgentAttention => ({
  state,
  since: 1,
  contentSince: 1,
  outputStableSince: 1,
  episodeKey: "e",
  stalled: false,
  awaitingHuman: false,
  unseen: false,
  composerOccupied: false,
  stale: false,
});

function harness(opts: {
  facts?: GatedCompletionFacts[];
  entries?: ManagedEntryInfo[];
  attention?: Record<string, AgentAttention>;
  head?: { headRef: string; dirty: boolean } | null;
  doorbell?: boolean;
  graceMs?: number;
  verifiedSince?: boolean;
}) {
  let now = 1_000_000;
  let store: Record<string, GatedCandidateRecord> = {};
  const delivered: Array<{ to: string; line: string }> = [];
  const facts = opts.facts ?? [
    {
      agent: "worker",
      delegator: "boss",
      deliveryId: "d-1",
      worktreePath: "/wt/worker",
      baseSha: "basebasebase",
      sinceIso: "2026-07-01T00:00:00.000Z",
    },
  ];
  const entries = opts.entries ?? [entry("worker"), entry("boss", { delegator: undefined })];
  const attention = { ...opts.attention };
  let doorbell = opts.doorbell ?? false;
  const monitor = new GatedCompletionMonitor(
    {
      listGatedFacts: async () => facts,
      listEntries: async () => entries,
      attentionOf: (a) => attention[a],
      headState: async () => opts.head ?? { headRef: "newnewnewnew", dirty: false },
      hasDoorbellRung: () => doorbell,
      isVerifiedSince: async () => opts.verifiedSince ?? false,
      deliverNotice: async (to, line) => {
        delivered.push({ to, line });
      },
      now: () => now,
      loadCandidates: () => ({ ...store }),
      saveCandidates: (c) => {
        store = { ...c };
      },
    },
    opts.graceMs ?? GRACE,
  );
  return {
    monitor,
    delivered,
    get store() {
      return store;
    },
    setNow: (n: number) => {
      now = n;
    },
    setDoorbell: (v: boolean) => {
      doorbell = v;
    },
    setAttention: (agent: string, a: AgentAttention) => {
      attention[agent] = a;
    },
  };
}

describe("GatedCompletionMonitor (t-875700)", () => {
  it("isArmableAttention: idle and clean-exit yes; working/needs-input/throttled no", () => {
    expect(isArmableAttention(entry("w"), att("idle"))).toBe(true);
    expect(isArmableAttention(entry("w", { running: false, cleanExited: true }), undefined)).toBe(true);
    expect(isArmableAttention(entry("w"), att("working"))).toBe(false);
    expect(isArmableAttention(entry("w"), att("needs-input"))).toBe(false);
    expect(isArmableAttention(entry("w"), att("throttled"))).toBe(false);
  });

  it("hostFallbackLine marks host-fallback/unverified and never accept", () => {
    const line = hostFallbackLine({
      agent: "w",
      deliveryId: "d-1",
      headSha: "abcdef0123456789",
      baseSha: "fedcba9876543210",
      ageMs: 120_000,
    });
    expect(line).toContain("host-fallback/unverified");
    expect(line).toContain("d-1");
    expect(line).toContain("not an accept");
    expect(line).not.toMatch(/\bACCEPT\b/);
  });

  it("arms then sends one fallback after grace when no doorbell", async () => {
    const h = harness({ attention: { worker: att("idle") } });
    await h.monitor.tick();
    expect(Object.values(h.store)).toHaveLength(1);
    expect(Object.values(h.store)[0]?.status).toBe("armed");
    expect(h.delivered).toHaveLength(0);

    h.setNow(1_000_000 + GRACE + 1);
    await h.monitor.tick();
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0].to).toBe("boss");
    expect(h.delivered[0].line).toContain("host-fallback/unverified");
    expect(Object.values(h.store)[0]?.status).toBe("sent");

    await h.monitor.tick();
    expect(h.delivered).toHaveLength(1); // no duplicate
  });

  it("suppresses when doorbell rings before grace ends", async () => {
    const h = harness({ attention: { worker: att("idle") } });
    await h.monitor.tick();
    h.setDoorbell(true);
    h.setNow(1_000_000 + GRACE + 1);
    await h.monitor.tick();
    expect(h.delivered).toHaveLength(0);
    expect(Object.values(h.store)[0]?.status).toBe("suppressed");
  });

  it("does not arm when dirty or HEAD equals base", async () => {
    const dirty = harness({
      attention: { worker: att("idle") },
      head: { headRef: "new", dirty: true },
    });
    await dirty.monitor.tick();
    expect(Object.keys(dirty.store)).toHaveLength(0);

    const same = harness({
      attention: { worker: att("idle") },
      head: { headRef: "basebasebase", dirty: false },
    });
    await same.monitor.tick();
    expect(Object.keys(same.store)).toHaveLength(0);
  });

  it("does not arm working/needs-input", async () => {
    for (const state of ["working", "needs-input", "throttled"] as const) {
      const h = harness({ attention: { worker: att(state) } });
      await h.monitor.tick();
      expect(Object.keys(h.store)).toHaveLength(0);
    }
  });

  it("candidateKey is stable", () => {
    expect(candidateKey({ deliveryId: "d", agent: "a", headSha: "h", delegator: "p" })).toBe("d|a|h|p");
  });
});

describe("assigned canonical agent fallback (t-5e9bf8)", () => {
  const assigned = (over: Partial<GatedCompletionFacts> = {}): GatedCompletionFacts[] => [{
    agent: "worker",
    delegator: "boss",
    deliveryId: "task:t-abc123",
    worktreePath: "/wt/worker",
    baseSha: "basebasebase",
    sinceIso: "2026-07-01T00:00:00.000Z",
    evidence: "verified-since",
    ...over,
  }];

  it("a VERIFIED head arms and, after the grace window, sends exactly one owner notice", async () => {
    const h = harness({ facts: assigned(), attention: { worker: att("idle") }, verifiedSince: true });
    await h.monitor.tick();
    expect(h.delivered).toEqual([]);
    expect(Object.values(h.store)[0]).toMatchObject({ status: "armed", deliveryId: "task:t-abc123" });

    h.setNow(1_000_000 + GRACE + 1);
    await h.monitor.tick();
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]!.to).toBe("boss");
    expect(h.delivered[0]!.line).toContain("host-fallback/unverified");
    expect(h.delivered[0]!.line).toContain("assigned agent 'worker'");
    expect(h.delivered[0]!.line).toContain("task:t-abc123");
    expect(h.delivered[0]!.line).toContain("not an accept");
    // Dedup: further ticks on the same task+HEAD never send twice.
    h.setNow(1_000_000 + GRACE * 10);
    await h.monitor.tick();
    expect(h.delivered).toHaveLength(1);
  });

  it("an UNVERIFIED head never arms — ordinary idle past the spawn base is not a delivery", async () => {
    // This is the whole reason the assigned rule is not `beyond-base`: a persistent agent's HEAD is
    // past its base essentially always, so without the verification fact this would fire on idle.
    const h = harness({ facts: assigned(), attention: { worker: att("idle") }, verifiedSince: false });
    await h.monitor.tick();
    h.setNow(1_000_000 + GRACE + 1);
    await h.monitor.tick();
    expect(h.delivered).toEqual([]);
    expect(h.store).toEqual({});
  });

  it("no verification resolver wired is not 'verified'", async () => {
    const h = harness({ facts: assigned(), attention: { worker: att("idle") }, verifiedSince: undefined });
    await h.monitor.tick();
    h.setNow(1_000_000 + GRACE + 1);
    await h.monitor.tick();
    expect(h.delivered).toEqual([]);
  });

  it("a dirty worktree never arms, however verified the commit is", async () => {
    const h = harness({
      facts: assigned(), attention: { worker: att("idle") },
      verifiedSince: true, head: { headRef: "newnewnewnew", dirty: true },
    });
    await h.monitor.tick();
    h.setNow(1_000_000 + GRACE + 1);
    await h.monitor.tick();
    expect(h.delivered).toEqual([]);
  });

  it("working / needs-input never arm", async () => {
    for (const state of ["working", "needs-input"] as const) {
      const h = harness({ facts: assigned(), attention: { worker: att(state) }, verifiedSince: true });
      await h.monitor.tick();
      h.setNow(1_000_000 + GRACE + 1);
      await h.monitor.tick();
      expect(h.delivered, `${state} must not fire`).toEqual([]);
    }
  });

  it("a manual doorbell suppresses the armed candidate instead of sending", async () => {
    const h = harness({ facts: assigned(), attention: { worker: att("idle") }, verifiedSince: true });
    await h.monitor.tick();
    expect(Object.values(h.store)[0]).toMatchObject({ status: "armed" });
    h.setDoorbell(true);
    h.setNow(1_000_000 + GRACE + 1);
    await h.monitor.tick();
    expect(h.delivered).toEqual([]);
    expect(Object.values(h.store)[0]).toMatchObject({ status: "suppressed" });
  });

  it("survives a reload: a sent candidate stays sent when the store is re-read", async () => {
    const h = harness({ facts: assigned(), attention: { worker: att("idle") }, verifiedSince: true });
    await h.monitor.tick();
    h.setNow(1_000_000 + GRACE + 1);
    await h.monitor.tick();
    expect(h.delivered).toHaveLength(1);
    const persisted = h.store;

    // A fresh monitor loading the SAME persisted candidates must not re-notify.
    const reloaded = harness({ facts: assigned(), attention: { worker: att("idle") }, verifiedSince: true });
    Object.assign(reloaded.store, persisted);
    reloaded.setNow(1_000_000 + GRACE * 20);
    await reloaded.monitor.tick();
    expect(Object.values(persisted)[0]).toMatchObject({ status: "sent" });
  });

  it("a NEW verified head after the first notice arms its own candidate", async () => {
    const h = harness({ facts: assigned(), attention: { worker: att("idle") }, verifiedSince: true });
    await h.monitor.tick();
    h.setNow(1_000_000 + GRACE + 1);
    await h.monitor.tick();
    expect(h.delivered).toHaveLength(1);
    // The key carries the head sha, so a later delivery on the same task is a distinct candidate.
    expect(Object.keys(h.store)[0]).toContain("newnewnewnew");
  });

  it("gated facts keep the beyond-base rule and their own wording", async () => {
    const h = harness({ attention: { worker: att("idle") }, verifiedSince: false });
    await h.monitor.tick();
    h.setNow(1_000_000 + GRACE + 1);
    await h.monitor.tick();
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]!.line).toContain("gated child 'worker'");
  });

  it("hostFallbackLine names the fact that armed it", () => {
    const base = { agent: "w", deliveryId: "task:t-1", headSha: "a".repeat(40), baseSha: "b".repeat(40), ageMs: 60_000 };
    expect(hostFallbackLine({ ...base, evidence: "verified-since" })).toContain("assigned agent");
    expect(hostFallbackLine({ ...base, evidence: "verified-since" })).toContain("VERIFIED");
    expect(hostFallbackLine(base)).toContain("gated child");
  });
});


describe("assignedCompletionFacts selection (t-5e9bf8)", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    name: "worker", kind: "agent" as const, declaredOwner: "boss", ...over,
  });
  const task = (over: Record<string, unknown> = {}) => ({
    id: "t-abc123", status: "active", assignee: "worker", updatedAt: "2026-07-01T00:00:00.000Z", ...over,
  });
  const select = (over: Record<string, unknown> = {}) => assignedCompletionFacts({
    entries: [row()],
    declared: new Set(["worker"]),
    tasks: [task()],
    locate: () => ({ worktreePath: "/wt/worker", baseSha: "base" }),
    ...over,
  });

  it("emits one verified-since fact for a declared agent with an owner and an active task", () => {
    expect(select()).toEqual([{
      agent: "worker",
      delegator: "boss",
      deliveryId: "task:t-abc123",
      worktreePath: "/wt/worker",
      baseSha: "base",
      sinceIso: "2026-07-01T00:00:00.000Z",
      evidence: "verified-since",
    }]);
  });

  it("falls back to the spawn parent when no owner is declared in config", () => {
    const facts = select({ entries: [row({ declaredOwner: undefined, parent: "boss" })] });
    expect(facts).toHaveLength(1);
    expect(facts[0]!.delegator).toBe("boss");
  });

  it("does not emit without an owner, and never names the agent as its own coordinator", () => {
    expect(select({ entries: [row({ declaredOwner: undefined, parent: undefined })] })).toEqual([]);
    expect(select({ entries: [row({ declaredOwner: "worker" })] })).toEqual([]);
  });

  it("does not emit for an ad-hoc agent, a terminal, or a gated row", () => {
    expect(select({ declared: new Set<string>() }), "ad-hoc").toEqual([]);
    expect(select({ entries: [row({ kind: "terminal" })] }), "terminal").toEqual([]);
    // The delegation arm already owns gated rows; both sources emitting would double-notify.
    expect(select({ entries: [row({ delegator: "boss" })] }), "gated").toEqual([]);
  });

  it("does not emit without an ACTIVE task assigned to that agent", () => {
    expect(select({ tasks: [] }), "no task").toEqual([]);
    expect(select({ tasks: [task({ status: "triaged" })] }), "not active").toEqual([]);
    expect(select({ tasks: [task({ assignee: "someone-else" })] }), "another assignee").toEqual([]);
    expect(select({ tasks: [task({ assignee: undefined })] }), "unassigned").toEqual([]);
  });

  it("does not emit when the agent has no locatable worktree", () => {
    expect(select({ locate: () => undefined })).toEqual([]);
    expect(select({ locate: () => ({ baseSha: "base" }) })).toEqual([]);
  });
});

describe("assigned completion worktree resolution (t-357879)", () => {
  const change = (over: Record<string, unknown> = {}) => ({
    id: "mw-change-delivery",
    kind: "change" as const,
    path: "/wt/change/task",
    branch: "tachyon/change/task",
    baseRef: "task-base",
    tachyonCreatedBranch: true,
    taskId: "t-abc123",
    createdBy: "worker",
    slug: "task",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "active" as const,
    ...over,
  });
  const input = (managed: ReturnType<typeof change>[]) => ({
    agent: "worker",
    taskId: "t-abc123",
    managed,
    persistent: { worktreePath: "/wt/worker", baseSha: "spawn-base" },
  });

  it("prefers the exact active task+creator registry binding over the persistent checkout", () => {
    expect(resolveAssignedCompletionWorktree(input([change()]))).toEqual({
      worktreePath: "/wt/change/task",
      baseSha: "task-base",
    });
  });

  it("ignores another task, another creator, and abandoned change worktrees", () => {
    for (const unrelated of [
      change({ taskId: "t-other" }),
      change({ createdBy: "other-agent" }),
      change({ status: "abandoned" }),
    ]) {
      expect(resolveAssignedCompletionWorktree(input([unrelated]))).toEqual({
        worktreePath: "/wt/worker",
        baseSha: "spawn-base",
      });
    }
  });

  it("fails closed instead of guessing between duplicate exact bindings", () => {
    expect(resolveAssignedCompletionWorktree(input([
      change(),
      change({ id: "mw-change-second", path: "/wt/change/second", slug: "second" }),
    ]))).toBeUndefined();
  });

  it("preserves persistent-worktree delivery when no matching change row exists", () => {
    expect(resolveAssignedCompletionWorktree(input([]))).toEqual({
      worktreePath: "/wt/worker",
      baseSha: "spawn-base",
    });
  });
});
