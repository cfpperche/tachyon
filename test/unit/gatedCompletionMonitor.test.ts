import { describe, it, expect } from "vitest";
import {
  GatedCompletionMonitor,
  candidateKey,
  hostFallbackLine,
  isArmableAttention,
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
