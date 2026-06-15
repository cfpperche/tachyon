import { describe, it, expect } from "vitest";
import { watchdogStep, type WatchdogState, type ProbeState } from "../../src/tmux/wedgeWatchdog.js";

/** Drive a sequence of probe results through the reducer; return the actions emitted. */
function runSeq(seq: ProbeState[]): { actions: string[]; final: WatchdogState } {
  let state: WatchdogState = "idle";
  const actions: string[] = [];
  for (const p of seq) {
    const step = watchdogStep(state, p);
    state = step.next;
    actions.push(step.action);
  }
  return { actions, final: state };
}

describe("wedgeWatchdog reducer (spec 217)", () => {
  it("two consecutive wedged ticks recover exactly once (arm → confirm)", () => {
    const { actions, final } = runSeq(["wedged", "wedged"]);
    expect(actions).toEqual(["none", "recover"]);
    expect(final).toBe("latched");
  });

  it("a single wedged tick that clears does NOT recover (transient hiccup)", () => {
    const { actions, final } = runSeq(["wedged", "healthy"]);
    expect(actions).toEqual(["none", "none"]);
    expect(final).toBe("idle");
  });

  it("does not re-recover while latched; waits for a clear probe", () => {
    const { actions } = runSeq(["wedged", "wedged", "wedged", "wedged"]);
    expect(actions).toEqual(["none", "recover", "none", "none"]);
  });

  it("re-arms and recovers again after a healthy/no-server reset", () => {
    const { actions, final } = runSeq(["wedged", "wedged", "healthy", "wedged", "wedged"]);
    expect(actions).toEqual(["none", "recover", "none", "none", "recover"]);
    expect(final).toBe("latched");
  });

  it("no-server and healthy keep it idle and silent", () => {
    const { actions, final } = runSeq(["no-server", "healthy", "no-server"]);
    expect(actions).toEqual(["none", "none", "none"]);
    expect(final).toBe("idle");
  });

  it("no-server between two wedges resets the arm (no recover)", () => {
    const { actions } = runSeq(["wedged", "no-server", "wedged"]);
    expect(actions).toEqual(["none", "none", "none"]);
  });

  // spec 217 codex round-1 MAJOR: a probe ERROR ("unknown") must not count toward the two-tick
  // confirmation — it breaks a pending arm but never recovers, guarding the auto-SIGKILL.
  it("a probe error between two wedges breaks the arm (no recover)", () => {
    const { actions, final } = runSeq(["wedged", "unknown", "wedged"]);
    expect(actions).toEqual(["none", "none", "none"]);
    expect(final).toBe("armed"); // the second wedged re-arms, but never reached confirm
  });

  it("unknown de-arms but preserves a latch (no un-latch → no re-recover churn)", () => {
    // reach latched, then an error tick must keep it latched (not re-arm/re-recover)
    const { actions, final } = runSeq(["wedged", "wedged", "unknown", "wedged"]);
    expect(actions).toEqual(["none", "recover", "none", "none"]);
    expect(final).toBe("latched");
  });

  it("unknown from idle stays idle and silent", () => {
    expect(runSeq(["unknown", "unknown"])).toEqual({ actions: ["none", "none"], final: "idle" });
  });
});
