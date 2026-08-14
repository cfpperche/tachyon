import { describe, expect, it } from "vitest";
import { SurfacePreservation } from "@tachyon/engine/workspace/surfacePreservation.js";

/**
 * t-b88106 — the reported defect: restarting an agent that was working headless opened its terminal
 * as an editor tab, interrupting the human and changing UI state nobody asked to change.
 *
 * The invariant under test is one sentence: a relaunch never changes whether an agent is visible.
 * Headless stays headless; open is restored in place. Only an explicit start reveals.
 */

const HEADLESS = () => false;
const OPEN = () => true;

describe("surface preservation — a relaunch continues an agent, it does not decide its visibility", () => {
  it("a headless agent restarted in place stays headless", () => {
    const surfaces = new SurfacePreservation();
    // respawn-in-place: nothing was closed, so the live answer is consulted and it is "not open".
    expect(surfaces.shouldOpen("worker", "preserve", HEADLESS)).toBe(false);
  });

  it("a headless agent restarted via the kill+new fallback stays headless", () => {
    const surfaces = new SurfacePreservation();
    surfaces.noteBeforeRelaunchClose("worker", false);
    expect(surfaces.shouldOpen("worker", "preserve", HEADLESS)).toBe(false);
  });

  it("a visible agent restarted via the kill+new fallback gets its surface back", () => {
    const surfaces = new SurfacePreservation();
    // The tab is closed as part of the restart, so `isOpenNow` would say false — the latch is the
    // only thing that remembers the agent WAS visible. Without it, restart would silently demote
    // every visible agent to headless.
    surfaces.noteBeforeRelaunchClose("worker", true);
    expect(surfaces.shouldOpen("worker", "preserve", HEADLESS)).toBe(true);
  });

  it("a visible agent restarted in place is restored from the live surface, with no latch", () => {
    const surfaces = new SurfacePreservation();
    expect(surfaces.shouldOpen("worker", "preserve", OPEN)).toBe(true);
  });
});

describe("surface preservation — explicit intents ignore the agent's current state", () => {
  it("an explicit start reveals even though nothing is open yet", () => {
    const surfaces = new SurfacePreservation();
    expect(surfaces.shouldOpen("worker", "reveal", HEADLESS)).toBe(true);
  });

  it("a Bridge-spawned child stays silent even if a surface happens to exist (F3)", () => {
    const surfaces = new SurfacePreservation();
    expect(surfaces.shouldOpen("child", "silent", OPEN)).toBe(false);
  });

  it("silent never consults the presentation at all", () => {
    const surfaces = new SurfacePreservation();
    let asked = 0;
    surfaces.shouldOpen("child", "silent", () => { asked++; return true; });
    surfaces.shouldOpen("child", "reveal", () => { asked++; return true; });
    expect(asked).toBe(0);
  });
});

describe("surface preservation — the latch is consumed, never accumulated", () => {
  it("one relaunch's record does not steer the next launch", () => {
    const surfaces = new SurfacePreservation();
    surfaces.noteBeforeRelaunchClose("worker", true);
    expect(surfaces.shouldOpen("worker", "preserve", HEADLESS)).toBe(true);
    // Second relaunch, nothing closed this time: the stale "was visible" must be gone.
    expect(surfaces.shouldOpen("worker", "preserve", HEADLESS)).toBe(false);
    expect(surfaces.pending().size).toBe(0);
  });

  it("a launch that never happens leaves nothing behind once any launch resolves", () => {
    const surfaces = new SurfacePreservation();
    surfaces.noteBeforeRelaunchClose("worker", true);
    // A restart that failed before reporting a new process, then a later explicit start: the start
    // decides for itself, and the stale latch is dropped rather than surviving to a third launch.
    expect(surfaces.shouldOpen("worker", "reveal", HEADLESS)).toBe(true);
    expect(surfaces.pending().size).toBe(0);
    expect(surfaces.shouldOpen("worker", "preserve", HEADLESS)).toBe(false);
  });

  it("killing an agent drops its pending restore", () => {
    const surfaces = new SurfacePreservation();
    surfaces.noteBeforeRelaunchClose("worker", true);
    surfaces.forget("worker");
    expect(surfaces.pending().size).toBe(0);
    // A later fresh start of the same NAME must not inherit the dead agent's visibility.
    expect(surfaces.shouldOpen("worker", "preserve", HEADLESS)).toBe(false);
  });

  it("latches are per agent — one restart never speaks for another", () => {
    const surfaces = new SurfacePreservation();
    surfaces.noteBeforeRelaunchClose("visible", true);
    surfaces.noteBeforeRelaunchClose("headless", false);
    expect(surfaces.shouldOpen("headless", "preserve", HEADLESS)).toBe(false);
    expect(surfaces.shouldOpen("visible", "preserve", HEADLESS)).toBe(true);
  });
});
