import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Uri } from "vscode";
import { __createdPanels, __resetVscodeMock, __setPanelVisible } from "../mocks/vscode.js";
import { StudioPanelManagerBase, type StudioSurfaceConfig } from "../../src/webview/shared/studio/StudioPanelManagerBase.js";
import type { StudioHostAdapter, StudioLoadResult } from "../../src/webview/shared/studio/adapter.js";
import { DaemonEngineHost, type DaemonHostEvent } from "../../src/workspace/DaemonEngineHost.js";

/**
 * SDD 485 B3 — the guard that counts WORK.
 *
 * It counts adapter loads, model posts and `tmux list-clients` calls; it never measures elapsed time.
 * That is a decision, not a convenience: a wall-time assertion here would be flaky on a loaded CI
 * box, a flaky test gets skipped, and a skipped test on THIS mechanism is how "hidden panels are
 * gated" quietly becomes "revealed panels are stale".
 *
 * It also drives the doors PRODUCTION drives. 0.56.159 shipped the t-b51923 coalescing with a green
 * suite and changed nothing on the live engine, because the test called the one coalesced door while
 * production reached the same effect through five others. So every case below enters through
 * `refreshAll()` / `refreshCockpitHandoff()` / the pane's own poll — the exact functions
 * `extension.ts`'s `onViewsChanged` fan-out calls — rather than through the gate object.
 *
 * SDD 485 C4/C5 — the Control block below used to drive `refreshCockpitMissionBoard`, then briefly
 * `refreshCockpitTaskDetail`. Both surfaces left Control for their own apps and took those functions with
 * them, so the exemplar door here is Handoff: still reached from `onViewsChanged("handoff")`, still exactly
 * ONE refresh kind (Validations pushes two — validations AND inbox — which doubles every suppressed count).
 * Nothing about the mechanism changed; what the migrated surfaces' own gating proves now lives in
 * `boardPanel.test.ts` and `taskDetailApp.test.ts`, driven through those apps' doors. Control itself was
 * removed in E1, while this manager-level guard remains the contract for every surviving app.
 */

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Widget { id: string; title: string }
type WidgetFields = { title: string };

const surface: StudioSurfaceConfig = { viewType: "test.widget", bundleFile: "widget.js", styleFiles: ["widget.css"] };

function countingAdapter(counters: { loads: number }): StudioHostAdapter<Widget, WidgetFields, WidgetFields> {
  return {
    entityType: "widget",
    domainMessageNames: [],
    concurrency: { kind: "none" },
    allowPatchRestore: false,
    dirty: {
      computeDirty: (entity, fields) => (entity?.title ?? "") !== fields.title,
      serializePatch: (fields, dirty) => (dirty ? fields : undefined),
      canDiscard: () => true,
    },
    titleFor: (mode, id) => (mode === "new" ? "New Widget" : `Widget — ${id}`),
    load: (id): StudioLoadResult<Widget> => {
      counters.loads += 1;
      return { status: "ok", entity: { id: id ?? "new", title: id ?? "new" } };
    },
    validate: () => ({ blocking: [], nonBlocking: [] }),
    save: () => ({ status: "ok" }),
  };
}

/** N panels open, exactly one visible — the shape SDD 485 is about to make ordinary. */
async function openPanels(count: number, counters: { loads: number }) {
  const manager = new StudioPanelManagerBase(Uri.file("/ext"), surface, countingAdapter(counters));
  for (let i = 0; i < count; i++) manager.openExisting("ws1", `w-${i}`);
  await flush();
  const panels = [...__createdPanels];
  for (const panel of panels.slice(1)) __setPanelVisible(panel, false);
  counters.loads = 0;
  for (const panel of panels) panel.webview.posted.length = 0;
  return { manager, panels, visible: panels[0]! };
}

describe("SDD 485 B3 — with N panels open and one visible, a views-changed is work for the visible one only", () => {
  beforeEach(() => __resetVscodeMock());

  it("does one adapter load and one post, not eight", async () => {
    const counters = { loads: 0 };
    const { manager, panels, visible } = await openPanels(8, counters);

    manager.refreshAll(); // the door `onViewsChanged` reaches
    await flush();

    expect(counters.loads).toBe(1);
    expect(visible.webview.posted).toHaveLength(1);
    expect(panels.slice(1).flatMap((p) => p.webview.posted)).toEqual([]);
  });

  it("costs one unit per event instead of N — measured at the post-t-b51923 production rate", async () => {
    // t-b51923 left the engine emitting ~2.4 `views-changed`/s with two agents running. This is that
    // minute, on the consumer side, with the panel count SDD 485 is heading for.
    const EVENTS_PER_MINUTE = 144; // 2.4/s × 60s
    const PANELS = 8;

    const gated = { loads: 0 };
    const g = await openPanels(PANELS, gated);
    for (let i = 0; i < EVENTS_PER_MINUTE; i++) g.manager.refreshAll();
    await flush();

    __resetVscodeMock();

    const ungated = { loads: 0 };
    const u = await openPanels(PANELS, ungated);
    for (const panel of u.panels) __setPanelVisible(panel, true); // every panel visible ≡ pre-gate behaviour
    ungated.loads = 0;
    for (let i = 0; i < EVENTS_PER_MINUTE; i++) u.manager.refreshAll();
    await flush();

    expect(ungated.loads).toBe(EVENTS_PER_MINUTE * PANELS); // 1152 refreshes/min — the before
    expect(gated.loads).toBe(EVENTS_PER_MINUTE); //              144 refreshes/min — the after
  });

  it("reveals a hidden panel by DELTA when the window covered the burst", async () => {
    const counters = { loads: 0 };
    const { manager, panels } = await openPanels(2, counters);
    const hidden = panels[1]!;

    manager.refreshAll();
    manager.refreshReferenceData();
    manager.refreshAll();
    await flush();
    expect(hidden.webview.posted).toEqual([]); // nothing at all while hidden

    __setPanelVisible(hidden, true);
    await flush();

    // Two distinct kinds journaled, three invalidations: the repeat collapses, neither kind is lost.
    expect(hidden.webview.posted.map((m) => (m as { type?: string }).type)).toEqual(["load", "referenceData"]);
  });

  it("reveals by FULL RESYNC when the window overflowed — the branch a delta cannot cover", async () => {
    const counters = { loads: 0 };
    const { manager, panels } = await openPanels(2, counters);
    const hidden = panels[1]!;

    // 65 invalidations against a 64-entry window: the oldest is evicted, so the journal can no
    // longer prove what was missed and the panel must stop claiming it can.
    for (let i = 0; i < 65; i++) manager.refreshReferenceData();
    await flush();
    expect(hidden.webview.posted).toEqual([]);

    __setPanelVisible(hidden, true);
    await flush();

    // One full load — NOT 65 replays, and not the referenceData-only push a delta would have chosen.
    expect(hidden.webview.posted.map((m) => (m as { type?: string }).type)).toEqual(["load"]);
  });

  it("never leaves a revealed panel stale — every suppressed kind is answered on reveal", async () => {
    const counters = { loads: 0 };
    const { manager, panels } = await openPanels(2, counters);
    const hidden = panels[1]!;

    for (let i = 0; i < 200; i++) {
      manager.refreshAll();
      manager.refreshReferenceData();
    }
    await flush();
    expect(hidden.webview.posted).toEqual([]);

    __setPanelVisible(hidden, true);
    await flush();

    // The trailing edge, in the only form that matters: something arrives, and it is a fresh read.
    expect(hidden.webview.posted.length).toBeGreaterThan(0);
    expect(hidden.webview.posted.map((m) => (m as { type?: string }).type)).toContain("load");
  });
});

/**
 * SDD 485 B4 — the before/after, measured the way t-b51923 measured: count the events, count the
 * work, change one thing between the two runs.
 *
 * What is NOT claimed here: this is a harness, not two live agents on a running engine. No engine
 * daemon is reachable from a change worktree and opening an editor window is out of bounds for this
 * task, so the LIVE half of t-b51923's method could not be repeated — see `notes.md`. What IS real
 * is both ends of the pipe: the producer is the actual `DaemonEngineHost` with its actual coalescing
 * window, and the consumer is the actual panel manager with its actual fan-out door. The synthetic
 * part is only the arrival pattern in between (t-b51923 measured ~15 invalidations/s per running
 * agent, so 30/s stands in for its two agents).
 *
 * The producer number is expected to be IDENTICAL in both runs. That is the point: this phase changes
 * the consumer, and a fix that moved the emit rate would mean it had reached into t-b51923's work.
 */
describe("SDD 485 B4 — before/after, producer unchanged and consumer gated", () => {
  const roots: string[] = [];
  const hosts: DaemonEngineHost[] = [];

  beforeEach(() => __resetVscodeMock());
  afterEach(() => {
    for (const host of hosts.splice(0)) host.dispose();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
    vi.useRealTimers();
  });

  const SECONDS = 60;
  const INVALIDATIONS_PER_SECOND = 30; // t-b51923's measured storm: ~15/s per running agent, two agents
  const PANELS = 8;

  /** One minute of the measured storm through the REAL host, counting what leaves it. */
  function runProducer(): number {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hidden-panel-rate-"));
    roots.push(root);
    const mediaRoot = path.join(root, "bundle");
    fs.mkdirSync(mediaRoot);
    const events: DaemonHostEvent[] = [];
    const host = new DaemonEngineHost({
      storageRoot: path.join(root, "state"),
      mediaRoot,
      appVersion: "0.57.0",
      settings: { global: {}, workspace: {}, workspaceFolder: {} },
      emit: (event) => events.push(event),
    });
    hosts.push(host);
    const step = Math.floor(1000 / INVALIDATIONS_PER_SECOND);
    for (let i = 0; i < SECONDS * INVALIDATIONS_PER_SECOND; i++) {
      host.onViewsChanged("agents");
      vi.advanceTimersByTime(step);
    }
    vi.advanceTimersByTime(1000); // let the last trailing edge land
    return events.filter((e) => e.kind === "views-changed").length;
  }

  it("holds the journal rate flat while cutting consumer work by the panel count", async () => {
    vi.useFakeTimers();
    const emitted = runProducer();
    vi.useRealTimers();

    // Every emitted event is one `onViewsChanged` fan-out, which is one `refreshAll()` per manager.
    const gated = { loads: 0 };
    const g = await openPanels(PANELS, gated);
    for (let i = 0; i < emitted; i++) g.manager.refreshAll();
    await flush();

    __resetVscodeMock();

    const ungated = { loads: 0 };
    const u = await openPanels(PANELS, ungated);
    for (const panel of u.panels) __setPanelVisible(panel, true); // pre-gate: every panel works, always
    ungated.loads = 0;
    for (let i = 0; i < emitted; i++) u.manager.refreshAll();
    await flush();

    const rate = (n: number) => Number((n / SECONDS).toFixed(2));

    // Producer: t-b51923's fix, untouched. 1800 invalidations/min in, a small multiple of the
    // coalescing window out — the same number before and after this phase, because it is the same code.
    expect(emitted).toBeGreaterThan(0);
    expect(rate(emitted)).toBeLessThan(5);

    // Consumer: one refresh per event instead of one per event PER OPEN PANEL.
    expect(ungated.loads).toBe(emitted * PANELS);
    expect(gated.loads).toBe(emitted);
    expect(gated.loads * PANELS).toBe(ungated.loads);

    // The numbers recorded in notes.md come from this run; keep them honest by printing them.
    // eslint-disable-next-line no-console
    console.log(
      `[SDD 485 B4] journal ${rate(emitted)} ev/s (unchanged) · refresh work ${rate(ungated.loads)}/s before → ${rate(gated.loads)}/s after, ${PANELS} panels, 1 visible`,
    );
  });
});
