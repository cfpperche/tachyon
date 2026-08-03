import { describe, expect, it } from "vitest";
import {
  decideCatchUp,
  PanelWorkGate,
  DEFAULT_CATCH_UP_WINDOW,
  type VisibilitySource,
} from "../../src/webview/shared/panelWorkGate.js";

/**
 * SDD 485 B1/B2 — the gate that makes a hidden panel do no work, and the catch-up that makes that
 * safe rather than merely cheap.
 *
 * The order of the two halves is the whole design. t-b51923 coalesced a 40 ev/s storm one layer up
 * and its ONE real risk was never the storm: it was swallowing the last invalidation and leaving a
 * view stale forever. Suppression that loses the trailing edge trades slowness for wrong data, which
 * is the worse defect. So these tests spend most of their weight on the reveal, not the hide — and
 * every one of them counts WORK, never wall time (a wall-time test here would be flaky, and a flaky
 * test gets silenced, which is how a gate like this rots into a permanent staleness bug).
 */

function fakeSource(visible = true): VisibilitySource & { set(v: boolean): void } {
  const listeners: Array<() => void> = [];
  let current = visible;
  return {
    get visible() { return current; },
    onDidChangeVisible: (listener) => {
      listeners.push(listener);
      return { dispose: () => { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1); } };
    },
    set(v: boolean) { current = v; for (const l of [...listeners]) l(); },
  };
}

interface Recorder {
  gate: PanelWorkGate<string>;
  source: ReturnType<typeof fakeSource>;
  work: string[];
  replayed: string[];
  resyncs: number;
}

function harness(windowSize?: number): Recorder {
  const source = fakeSource(true);
  const work: string[] = [];
  const replayed: string[] = [];
  const rec = { work, replayed, resyncs: 0 } as Omit<Recorder, "gate" | "source">;
  const gate = new PanelWorkGate<string>(source, {
    replay: (kind) => { replayed.push(kind); },
    resync: () => { rec.resyncs += 1; },
    ...(windowSize !== undefined ? { windowSize } : {}),
  });
  return {
    gate,
    source,
    work,
    replayed,
    get resyncs() { return rec.resyncs; },
  } as Recorder;
}

describe("decideCatchUp — the whole policy, with no panel in sight", () => {
  it("does nothing when nothing was suppressed", () => {
    expect(decideCatchUp({ entries: [], dropped: 0, sourceResync: false })).toEqual({ mode: "none" });
  });

  it("replays a delta of DISTINCT kinds, oldest first, when the window covered everything", () => {
    // The same coalescing the producer already applies: an invalidation says "this view is stale",
    // never what changed, so three identical ones hold exactly the information of one.
    const decision = decideCatchUp({ entries: ["mission", "tasks", "mission"], dropped: 0, sourceResync: false });

    expect(decision).toEqual({ mode: "delta", kinds: ["mission", "tasks"], suppressed: 3 });
  });

  it("resyncs when the window overflowed — a dropped entry is a delta that cannot be proven", () => {
    const decision = decideCatchUp({ entries: ["mission"], dropped: 4, sourceResync: false });

    expect(decision).toEqual({ mode: "resync", reason: "window-overflow", suppressed: 5 });
  });

  it("resyncs when the UPSTREAM cursor expired, however small the journal looks", () => {
    // WorkspaceClient answers a lost cursor with a full snapshot; a panel that replayed its two
    // journaled kinds instead would be quietly asserting it knows what the engine just admitted it does not.
    const decision = decideCatchUp({ entries: ["mission"], dropped: 0, sourceResync: true });

    expect(decision).toEqual({ mode: "resync", reason: "source-resync", suppressed: 1 });
  });

  it("resyncs on an upstream resync even with an EMPTY journal", () => {
    expect(decideCatchUp({ entries: [], dropped: 0, sourceResync: true })).toEqual({
      mode: "resync", reason: "source-resync", suppressed: 0,
    });
  });
});

describe("PanelWorkGate — hidden means no WORK", () => {
  it("runs the work while visible", () => {
    const h = harness();

    expect(h.gate.run("mission", () => h.work.push("mission"))).toBe(true);
    expect(h.work).toEqual(["mission"]);
  });

  it("runs NOTHING while hidden — the callback is never invoked, not merely its result discarded", () => {
    const h = harness();
    h.source.set(false);

    const ran = h.gate.run("mission", () => h.work.push("mission"));

    expect(ran).toBe(false);
    expect(h.work).toEqual([]);
    expect(h.gate.pending).toBe(1);
  });

  it("keeps working while merely UNFOCUSED — visible side by side is being looked at", () => {
    // The spec this serves exists so two apps can be live at once; gating on `active` would make the
    // unfocused half of a split stop updating, which is the capability being bought.
    const h = harness();
    h.source.set(true); // a view-state event that does not change visibility

    expect(h.gate.run("mission", () => h.work.push("mission"))).toBe(true);
    expect(h.work).toEqual(["mission"]);
  });
});

describe("PanelWorkGate — the reveal is the safety property", () => {
  it("replays the suppressed kinds as a delta", () => {
    const h = harness();
    h.source.set(false);
    h.gate.run("mission", () => h.work.push("mission"));
    h.gate.run("handoff", () => h.work.push("handoff"));
    h.gate.run("mission", () => h.work.push("mission"));

    h.source.set(true);

    expect(h.replayed).toEqual(["mission", "handoff"]);
    expect(h.resyncs).toBe(0);
  });

  it("falls back to a full resync when the window overflows", () => {
    const h = harness(4);
    h.source.set(false);
    for (let i = 0; i < 5; i++) h.gate.run(`kind-${i}`, () => h.work.push("x"));

    h.source.set(true);

    expect(h.resyncs).toBe(1);
    expect(h.replayed).toEqual([]);
    expect(h.work).toEqual([]); // still zero work done WHILE hidden
  });

  it("falls back to a full resync when the upstream cursor expired while hidden", () => {
    const h = harness();
    h.source.set(false);
    h.gate.run("mission", () => h.work.push("mission"));
    h.gate.markSourceResync();

    h.source.set(true);

    expect(h.resyncs).toBe(1);
    expect(h.replayed).toEqual([]);
  });

  it("does nothing on a reveal that missed nothing", () => {
    const h = harness();
    h.source.set(false);
    h.source.set(true);

    expect(h.replayed).toEqual([]);
    expect(h.resyncs).toBe(0);
  });

  it("catches up ONCE — a second reveal does not replay a journal already spent", () => {
    const h = harness();
    h.source.set(false);
    h.gate.run("mission", () => h.work.push("mission"));
    h.source.set(true);
    h.source.set(false);
    h.source.set(true);

    expect(h.replayed).toEqual(["mission"]);
  });

  it("runs onReveal on EVERY reveal, including one the journal calls 'none'", () => {
    // Control's activity feed grows without emitting a single invalidation; hanging its catch-up off
    // the journal's decision would leave it stale for exactly the case it exists to cover.
    const source = fakeSource(true);
    let reveals = 0;
    const gate = new PanelWorkGate<string>(source, { replay: () => {}, resync: () => {}, onReveal: () => { reveals += 1; } });

    source.set(false);
    source.set(true);
    source.set(false);
    gate.run("mission", () => {});
    source.set(true);

    expect(reveals).toBe(2);
  });

  it("stops gating and stops replaying once disposed — a dead panel never gets a delta", () => {
    const h = harness();
    h.source.set(false);
    h.gate.run("mission", () => h.work.push("mission"));
    h.gate.dispose();

    h.source.set(true);

    expect(h.replayed).toEqual([]);
    expect(h.resyncs).toBe(0);
    expect(h.gate.run("mission", () => h.work.push("mission"))).toBe(false);
  });

  it("sizes its default window to hold the measured production event rate for tens of seconds", () => {
    // ~2.4 views-changed/s after t-b51923. The number is a policy, so it is pinned where a reader
    // can find it rather than left as a magic literal in the class.
    expect(DEFAULT_CATCH_UP_WINDOW).toBe(64);
    expect(DEFAULT_CATCH_UP_WINDOW / 2.4).toBeGreaterThan(20);
  });
});
