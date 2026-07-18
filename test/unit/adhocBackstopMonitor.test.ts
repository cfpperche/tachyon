import { describe, it, expect } from "vitest";
import { MAX_WORKING_STALL_MS, type AgentAttention } from "../../src/attention/AttentionMonitor.js";
import { AdhocBackstopMonitor } from "../../src/workspace/AdhocBackstopMonitor.js";
import type { ManagedEntryInfo } from "../../src/agents/AgentManager.js";

const agent = (name: string, opts: Partial<ManagedEntryInfo> = {}): ManagedEntryInfo => ({
  name,
  session: `s-${name}`,
  running: true,
  declared: false,
  dead: false,
  crashed: false,
  kind: "agent",
  ...opts,
});

const att = (state: AgentAttention["state"], stableSince: number, episodeKey = "e1"): AgentAttention => ({
  state,
  since: stableSince,
  contentSince: stableSince,
  outputStableSince: stableSince,
  episodeKey,
  stalled: false,
  awaitingHuman: false,
  unseen: false,
  composerOccupied: false,
  stale: false,
});

function fixture(opts: { completionHinted?: (name: string) => boolean } = {}) {
  let now = 1_000_000;
  const entries = new Map<string, ManagedEntryInfo>([
    ["parent", agent("parent")],
    ["child", agent("child", { parent: "parent" })],
  ]);
  const attention = new Map<string, AgentAttention>();
  const delivered: Array<{ parent: string; line: string }> = [];
  const monitor = new AdhocBackstopMonitor(
    {
      listEntries: async () => [...entries.values()],
      attentionOf: (name) => attention.get(name),
      now: () => now,
      deliverNotice: async (parent, line) => {
        delivered.push({ parent, line });
      },
      completionHinted: opts.completionHinted,
    },
    10 * 60_000,
  );
  return { monitor, entries, attention, delivered, setNow: (n: number) => { now = n; } };
}

describe("AdhocBackstopMonitor", () => {
  it("pokes once for a live child agent with a live parent after idle output is stable past threshold", async () => {
    const f = fixture();
    f.attention.set("child", att("idle", 1_000_000, "idle-1"));
    f.setNow(1_000_000 + 10 * 60_000 + 1);

    await f.monitor.tick();
    await f.monitor.tick();

    expect(f.delivered).toHaveLength(1);
    expect(f.delivered[0]).toMatchObject({ parent: "parent" });
    expect(f.delivered[0].line).toContain("child 'child' has been idle for 10m");
  });

  it("resets dedupe when output episode changes", async () => {
    const f = fixture();
    f.attention.set("child", att("idle", 1_000_000, "e1"));
    f.setNow(1_000_000 + 11 * 60_000);
    await f.monitor.tick();

    f.attention.set("child", att("idle", 1_001_000, "e2"));
    f.setNow(1_001_000 + 11 * 60_000);
    await f.monitor.tick();

    expect(f.delivered).toHaveLength(2);
  });

  it("does not poke terminals, root agents, dead children, dead parents, needs-input, or throttled children", async () => {
    const f = fixture();
    f.entries.set("terminal", agent("terminal", { kind: "terminal", parent: "parent" }));
    f.entries.set("root", agent("root"));
    f.entries.set("dead-child", agent("dead-child", { parent: "parent", running: false }));
    f.entries.set("dead-parent", agent("dead-parent", { running: false }));
    f.entries.set("orphaned", agent("orphaned", { parent: "dead-parent" }));
    f.entries.set("needs", agent("needs", { parent: "parent" }));
    f.entries.set("limited", agent("limited", { parent: "parent" }));
    for (const name of ["terminal", "root", "dead-child", "orphaned"]) f.attention.set(name, att("idle", 1_000_000, name));
    f.attention.set("needs", att("needs-input", 1_000_000, "needs"));
    f.attention.set("limited", att("throttled", 1_000_000, "limited"));
    f.entries.delete("child");
    f.setNow(1_000_000 + 30 * 60_000);

    await f.monitor.tick();

    expect(f.delivered).toEqual([]);
  });

  it("does not poke a working child before the t-d65be2 working stall cap", async () => {
    const f = fixture();
    f.attention.set("child", att("working", 1_000_000, "busy"));
    f.setNow(1_000_000 + 10 * 60_000 + 1);
    await f.monitor.tick();
    expect(f.delivered).toEqual([]);

    f.setNow(1_000_000 + MAX_WORKING_STALL_MS + 1);
    await f.monitor.tick();
    expect(f.delivered).toHaveLength(1);
    expect(f.delivered[0].line).toContain("still listed as working");
  });

  it("explicit reset allows a same-episode nudge after spawn/restart/kill boundaries", async () => {
    const f = fixture();
    f.attention.set("child", att("idle", 1_000_000, "same"));
    f.setNow(1_000_000 + 11 * 60_000);
    await f.monitor.tick();
    f.monitor.reset("child");
    await f.monitor.tick();

    expect(f.delivered).toHaveLength(2);
  });

  it("t-9552f3: after completion hint, does not emit working-stall backstop", async () => {
    const f = fixture({ completionHinted: (name) => name === "child" });
    f.attention.set("child", att("working", 1_000_000, "post-notify"));
    f.setNow(1_000_000 + MAX_WORKING_STALL_MS + 1);
    await f.monitor.tick();
    // Remapped to idle path — may still idle-nudge after 10m, never "still listed as working"
    expect(f.delivered.every((d) => !d.line.includes("still listed as working"))).toBe(true);
  });

  it("t-9552f3: completion-hinted working still allows idle-style nudge after threshold", async () => {
    const f = fixture({ completionHinted: (name) => name === "child" });
    f.attention.set("child", att("working", 1_000_000, "post-notify"));
    f.setNow(1_000_000 + 10 * 60_000 + 1);
    await f.monitor.tick();
    expect(f.delivered).toHaveLength(1);
    expect(f.delivered[0].line).toContain("has been idle for");
    expect(f.delivered[0].line).not.toContain("still listed as working");
  });
});
