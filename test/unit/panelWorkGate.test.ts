import { readFileSync } from "node:fs";
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The doors, checked from the SOURCE — not from the behaviour of the doors that exist today.
//
// Every behavioural test above proves that the four doors Phase B found are gated. None of them
// would notice a FIFTH one added later, and Phase C/D exist to add ten apps' worth of refresh paths.
// That gap has a precedent worth not repeating: 0.56.159 shipped a coalescing fix with green unit
// tests and changed nothing in production, because the tests called the one coalesced door while
// production used five others. Green tests proved the door worked; nothing proved it was the only
// door. This is that missing proof, and it is deliberately static — the same posture Phase A took
// for the design system: the mechanism is a test, not a habit.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("SDD 485 B1 — no push door bypasses the gate (static, so a NEW door cannot sneak in)", () => {
  const cockpit = readFileSync("src/webview/Cockpit.ts", "utf8");

  it("routes every Control push through pushControlRefresh or the gate's own resync branch", () => {
    // The two sanctioned homes for a `pushX?.()` call: inside the `pushControlRefresh` switch (the
    // gated path), and the gate's `resync:` option (the reveal's rebuild, which runs BECAUSE the
    // panel just became visible). Anywhere else is an ungated door.
    //
    // Sanctioned sites are matched by OFFSET, never by line text. The first cut of this test compared
    // `switchBody.includes(line.trim())` and was blind: an injected `pushMissionBoard?.();` anywhere in
    // the file is a substring of the switch's own `case "mission": pushMissionBoard?.(); return;`, so
    // every bypass "passed". A guard that cannot fail is worse than no guard — this one is proven to
    // go red by the fail-before recorded in notes.md.
    const found = /function pushControlRefresh\([\s\S]*?\n}/.exec(cockpit);
    expect(found, "pushControlRefresh not found — did it move or get renamed?").not.toBeNull();
    const sanctioned: Array<[number, number]> = [[found!.index, found!.index + found![0].length]];
    for (const m of cockpit.matchAll(/\bresync:\s*\(\)\s*=>.*$/gm)) sanctioned.push([m.index!, m.index! + m[0].length]);

    const lineAt = (offset: number): number => cockpit.slice(0, offset).split("\n").length;
    const ungated: string[] = [];
    for (const m of cockpit.matchAll(/\b(push[A-Z][A-Za-z]*)\?\.\(/g)) {
      if (sanctioned.some(([from, to]) => m.index! >= from && m.index! < to)) continue;
      ungated.push(`Cockpit.ts:${lineAt(m.index!)}: ${m[1]}?.() is called outside pushControlRefresh — a hidden panel would still do this work. Add a ControlRefreshKind and go through refreshControl().`);
    }
    expect(ungated, ungated.join("\n")).toEqual([]);
  });

  // SDD 485 C1 — the same guard, pointed at the class every future app's doors will be built on. Control is
  // one surface with a known set of pushes; `SectionPanelManager` is the shape ten more will arrive in, so a
  // door added there is a door added to all of them at once.
  const manager = readFileSync("src/webview/shared/SectionPanelManager.ts", "utf8");

  it("SectionPanelManager reaches the domain ONLY through the gate", () => {
    // The three sanctioned sites are the gate's own option callbacks (the reveal's catch-up, which runs
    // BECAUSE the panel just became visible) and anything wrapped in `gate.run`. `onMessage`/`dispose` are
    // not work the gate owns: one is an inbound message the config chose not to claim as a refresh, the
    // other is teardown. Matched against an allowlist of exact call lines, never by substring containment —
    // Phase B's own guard was blind exactly there (notes.md, "its first cut was blind").
    const sanctionedLines = new Set([
      "replay: (kind) => entry.binding.replay(kind),",
      "resync: () => entry.binding.resync(),",
      "onReveal: () => entry.binding.onReveal?.(),",
      "entry.binding.onMessage?.(raw);",
      "entry.binding.dispose?.();",
      "entry.binding = config.bind(session);",
    ]);
    const lines = manager.split("\n");
    const ungated: string[] = [];
    lines.forEach((line, i) => {
      if (!/\bentry\.binding\b/.test(line)) return;
      const trimmed = line.trim();
      if (sanctionedLines.has(trimmed) || trimmed.includes("gate.run(")) return;
      ungated.push(`SectionPanelManager.ts:${i + 1}: ${trimmed} — reaches the app's domain outside the gate. Wrap it in gate.run(kind, …) or make it a gate option.`);
    });
    expect(ungated, ungated.join("\n")).toEqual([]);
  });

  it("SectionPanelManager has exactly ONE post site, and it asks whether anyone is looking", () => {
    // A post is the only way work reaches a webview, so the gate is structural rather than advisory: a
    // second post site, or one that stopped consulting visibility, would let a hidden panel be written to
    // by every app built on this class at once.
    const posts = [...manager.matchAll(/webview\.postMessage\(/g)];
    expect(posts.map((m) => manager.slice(0, m.index!).split("\n").length), "more than one postMessage site in SectionPanelManager.ts").toHaveLength(1);
    const before = manager.slice(Math.max(0, posts[0].index! - 400), posts[0].index!);
    expect(before, "the post site no longer checks panel visibility — a hidden panel would be written to").toContain("entry.gate.visible");
    expect(before, "a dropped post must arm a rebuild on reveal, or the panel comes back with a hole in it").toContain("markSourceResync()");
  });

  it("keeps every ControlRefreshKind reachable — a kind with no case is a silently dead door", () => {
    const union = /type ControlRefreshKind =([\s\S]*?);/.exec(cockpit)?.[1] ?? "";
    expect(union, "ControlRefreshKind not found").not.toBe("");
    const kinds = [...union.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
    expect(kinds.length).toBeGreaterThan(0);
    const switchBody = /function pushControlRefresh\([\s\S]*?\n}/.exec(cockpit)?.[0] ?? "";
    const missing = kinds.filter((k) => !switchBody.includes(`case "${k}":`));
    expect(missing, `ControlRefreshKind values with no case in pushControlRefresh: ${missing.join(", ")}`).toEqual([]);
  });
});
