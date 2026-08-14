import { describe, it, expect } from "vitest";
import { MAX_WORKING_STALL_MS, type AgentAttention } from "@tachyon/shared/attention/AttentionMonitor.js";
import {
  TemporaryBackstopMonitor,
  ACKNOWLEDGED_ESCALATION_MULTIPLES,
  acknowledgedCheckInMs,
} from "@tachyon/shared/workspace/TemporaryBackstopMonitor.js";
import type { ManagedEntryInfo } from "@tachyon/engine/agents/AgentManager.js";

const agent = (name: string, opts: Partial<ManagedEntryInfo> = {}): ManagedEntryInfo => ({
  name,
  session: `s-${name}`,
  running: true,
  lifetime: "temporary", resumePolicy: "collected",
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
  const monitor = new TemporaryBackstopMonitor(
    {
      listAgents: async () => [...entries.values()].filter((entry) => entry.kind === "agent"),
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

describe("TemporaryBackstopMonitor", () => {
  it("t-8168a7: the production idle poke names never-started separately from finished", async () => {
    const f = fixture();
    f.entries.set("child", agent("child", { parent: "parent", hasStartedTurn: false }));
    f.attention.set("child", att("idle", 1_000_000, "never-started"));
    f.setNow(1_000_000 + 10 * 60_000 + 1);

    await f.monitor.tick();
    expect(f.delivered[0].line).toContain("has not started a turn after 10m idle");

    f.monitor.reset("child");
    f.entries.set("child", agent("child", { parent: "parent", hasStartedTurn: true }));
    f.attention.set("child", att("idle", 1_000_000, "finished"));
    await f.monitor.tick();
    expect(f.delivered[1].line).toContain("has been idle for 10m after finishing a turn");
  });

  it("t-8168a7 review: unknown post-reload history keeps the honest generic idle poke", async () => {
    const f = fixture();
    f.entries.set("child", agent("child", { parent: "parent", hasStartedTurn: undefined }));
    f.attention.set("child", att("idle", 1_000_000, "reload-unknown"));
    f.setNow(1_000_000 + 10 * 60_000 + 1);

    await f.monitor.tick();

    expect(f.delivered[0].line).toContain("has been idle for 10m with no new output");
    expect(f.delivered[0].line).not.toContain("has not started");
    expect(f.delivered[0].line).not.toContain("after finishing");
  });

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

  /**
   * t-0bebf6 — the fifth exit.
   *
   * Observed with seven delegated children: six pokes in an hour for children the coordinator had
   * already inspected and deliberately decided to leave running. The line named four exits — inspect,
   * dismiss, resume, re-delegate — and none of them means "I know". With nothing to answer, the
   * coordinator started reading the line as expected noise, which is how a legitimate alert dies.
   *
   * These guards are behavioural on both halves, because either half alone is a worse product: a
   * silence that never lifts is blindness, and a notice that returns in the SAME words teaches the
   * reader to skip it again.
   */
  it("t-0bebf6: an acknowledged idle child is not asked about again in the same state", async () => {
    const f = fixture();
    f.attention.set("child", att("idle", 1_000_000, "parked"));
    f.setNow(1_000_000 + 11 * 60_000);
    await f.monitor.tick();

    expect(f.delivered).toHaveLength(1);
    expect(f.delivered[0].line, "the poke never offered the fifth exit").toContain("acknowledge_agent('child')");

    const receipt = f.monitor.acknowledge("child");
    expect(receipt).toMatchObject({ agent: "child", reason: "idle", idleMs: 11 * 60_000 });
    expect(receipt?.nextCheckInMs, "the deferral did not say when it lapses").toBe(40 * 60_000);

    // Half an hour of further passes over the same parked child, exactly the shape that produced six
    // identical lines: the coordinator has answered, so there is nothing left to ask.
    for (const minutes of [12, 15, 20, 35]) {
      f.setNow(1_000_000 + minutes * 60_000);
      await f.monitor.tick();
    }
    expect(f.delivered, "the acknowledged child was asked about again").toHaveLength(1);
  });

  it("t-0bebf6: a child that produces output after the acknowledgement is reported again, not repeated", async () => {
    const f = fixture();
    f.attention.set("child", att("idle", 1_000_000, "e1"));
    f.setNow(1_000_000 + 11 * 60_000);
    await f.monitor.tick();
    f.monitor.acknowledge("child");

    // It emitted something, then went quiet again past the threshold — a real move, so it is a live
    // question again. Before t-0bebf6 this arrived as the FIRST line, word for word.
    f.attention.set("child", att("idle", 1_700_000, "e2"));
    f.setNow(1_700_000 + 11 * 60_000);
    await f.monitor.tick();

    expect(f.delivered).toHaveLength(2);
    expect(f.delivered[1].line, "the second notice repeated the first verbatim").not.toBe(f.delivered[0].line);
    expect(f.delivered[1].line).toContain("acknowledged idle at 11m");
    expect(f.delivered[1].line).toContain("has produced new output since");
    // The acknowledgement covered the old state, so the child is an open question and the exit is re-offered.
    expect(f.delivered[1].line).toContain("acknowledge_agent('child')");
  });

  it("t-0bebf6: an acknowledged child that stays idle far longer surfaces once, naming the ladder", async () => {
    const f = fixture();
    f.attention.set("child", att("idle", 1_000_000, "parked"));
    f.setNow(1_000_000 + 11 * 60_000);
    await f.monitor.tick();
    f.monitor.acknowledge("child");

    // 4× the window later: staying idle four times longer than what was acknowledged IS a change.
    f.setNow(1_000_000 + 41 * 60_000);
    await f.monitor.tick();
    expect(f.delivered, "an acknowledgement became permanent silence").toHaveLength(2);
    expect(f.delivered[1].line).toContain("acknowledged idle at 11m");
    expect(f.delivered[1].line).toContain("still idle and now silent for 41m");
    expect(f.delivered[1].line, "the backoff is not legible from the line").toContain("next check-in at 2h40m");

    // And the rung moved: the next hour is quiet again, without a second acknowledgement.
    f.setNow(1_000_000 + 100 * 60_000);
    await f.monitor.tick();
    expect(f.delivered).toHaveLength(2);
  });

  it("t-0bebf6: an acknowledged idle child that flips to a working stall is reported, naming the flip", async () => {
    const f = fixture();
    f.attention.set("child", att("idle", 1_000_000, "same"));
    f.setNow(1_000_000 + 11 * 60_000);
    await f.monitor.tick();
    f.monitor.acknowledge("child");

    f.attention.set("child", att("working", 1_000_000, "same"));
    f.setNow(1_000_000 + MAX_WORKING_STALL_MS + 1);
    await f.monitor.tick();

    expect(f.delivered).toHaveLength(2);
    expect(f.delivered[1].line).toContain("acknowledged idle at 11m");
    expect(f.delivered[1].line).toContain("now listed as working with no output");
    expect(f.delivered[1].line).toContain("acknowledge_agent('child')");
  });

  it("t-0bebf6: acknowledging a child nobody was asked about is a no-op, never a pre-emptive mute", async () => {
    const f = fixture();
    f.attention.set("child", att("idle", 1_000_000, "e1"));
    expect(f.monitor.acknowledge("child")).toBeNull();

    f.setNow(1_000_000 + 11 * 60_000);
    await f.monitor.tick();
    expect(f.delivered, "a mute was taken before the first question").toHaveLength(1);
  });

  it("t-0bebf6: an acknowledgement does not outlive the child it was about", async () => {
    const f = fixture();
    f.attention.set("child", att("idle", 1_000_000, "same"));
    f.setNow(1_000_000 + 11 * 60_000);
    await f.monitor.tick();
    f.monitor.acknowledge("child");

    // Re-delegate/restart: the same name, a different run. The decision was about the old one.
    f.monitor.reset("child");
    await f.monitor.tick();

    expect(f.delivered).toHaveLength(2);
    expect(f.delivered[1].line).toContain("has been idle for 11m with no new output");
  });

  it("t-0bebf6: the escalation ladder is declared once and never reaches permanent silence", () => {
    const threshold = 10 * 60_000;
    expect(ACKNOWLEDGED_ESCALATION_MULTIPLES).toEqual([4, 16, 64]);
    expect(acknowledgedCheckInMs(threshold, 0)).toBe(40 * 60_000);
    expect(acknowledgedCheckInMs(threshold, 1)).toBe(160 * 60_000);
    expect(acknowledgedCheckInMs(threshold, 2)).toBe(640 * 60_000);
    // Past the last rung the spacing REPEATS. Every step is finite and strictly increasing, so an
    // acknowledged child idle overnight still comes back — the deferral never becomes a mute.
    for (let step = 1; step < 40; step++) {
      expect(acknowledgedCheckInMs(threshold, step)).toBeGreaterThan(acknowledgedCheckInMs(threshold, step - 1));
      expect(Number.isFinite(acknowledgedCheckInMs(threshold, step))).toBe(true);
    }
    // The ladder is shaped by the CONFIGURED window, not by ten hard-coded minutes.
    expect(acknowledgedCheckInMs(2 * 60_000, 0)).toBe(8 * 60_000);
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
