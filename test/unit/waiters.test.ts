import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Waiters } from "../../src/bridge/Waiters.js";

describe("Waiters", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves when the awaited attention state arrives", async () => {
    const w = new Waiters();
    const p = w.wait("child", "idle", 60_000);
    w.notifyAttention("child", "working"); // not the condition
    w.notifyAttention("other", "idle"); // wrong agent
    expect(w.pendingCount()).toBe(1);
    w.notifyAttention("child", "idle");
    await expect(p).resolves.toMatchObject({ met: true, state: "idle" });
    expect(w.pendingCount()).toBe(0);
  });

  it("terminal events resolve any waiter; met only for until=dead", async () => {
    const w = new Waiters();
    const waitingIdle = w.wait("child", "idle", 60_000);
    const waitingDead = w.wait("child", "dead", 60_000);
    w.notifyDead("child", 7);
    await expect(waitingIdle).resolves.toMatchObject({ met: false, state: "dead", exitCode: 7 });
    await expect(waitingDead).resolves.toMatchObject({ met: true, state: "dead", exitCode: 7 });
  });

  it("gone (killed session) resolves like a terminal event", async () => {
    const w = new Waiters();
    const p = w.wait("child", "needs-input", 60_000);
    w.notifyGone("child");
    await expect(p).resolves.toMatchObject({ met: false, state: "gone" });
  });

  it("timeout resolves met:false with state timeout; dispose flushes everything", async () => {
    const w = new Waiters();
    const p = w.wait("child", "idle", 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(p).resolves.toMatchObject({ met: false, state: "timeout" });

    const hanging = w.wait("x", "idle", 60_000);
    w.dispose();
    await expect(hanging).resolves.toMatchObject({ met: false });
  });

  it("multiple waiters on the same agent settle independently by condition", async () => {
    const w = new Waiters();
    const idle = w.wait("a", "idle", 60_000);
    const needs = w.wait("a", "needs-input", 60_000);
    w.notifyAttention("a", "idle");
    await expect(idle).resolves.toMatchObject({ met: true, state: "idle" });
    expect(w.pendingCount()).toBe(1); // needs-input still pending
    w.notifyAttention("a", "needs-input");
    await expect(needs).resolves.toMatchObject({ met: true, state: "needs-input" });
  });
});
