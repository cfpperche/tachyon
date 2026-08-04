import { describe, expect, it } from "vitest";
import { waitStable, waitUntil } from "../helpers/settle.js";

/**
 * t-eee876 — the helpers are shared test infrastructure now, and their VALUE is the failure message.
 * A wait that times out silently, or reports only "expected true to be false", reproduces the defect
 * they exist to remove: a real failure read as a wrong number.
 */
describe("waitUntil — 'I expect this to become true'", () => {
  it("returns as soon as the condition holds, without waiting out the bound", async () => {
    let ticks = 0;
    const value = await waitUntil(() => ++ticks, (n) => n >= 3, { intervalMs: 1, timeoutMs: 5_000 });
    expect(value).toBe(3);
  });

  it("names the caller's subject AND the last value it saw when the bound is reached", async () => {
    // The last observed value is the whole point: "expected 96 to be 94" hid that the number was
    // still climbing. A timeout that reports the trajectory's end tells the reader which it was.
    await expect(
      waitUntil(() => 41, (n) => n === 42, { intervalMs: 1, timeoutMs: 20, label: "the answer" }),
    ).rejects.toThrow(/the answer: never held within 20ms; last observed 41/);
  });
});

describe("waitStable — 'I expect this to have stopped'", () => {
  it("does not accept a value that is still moving, then accepts it once it settles", async () => {
    let n = 0;
    // Grows three times and then holds — a fixed sleep landing mid-growth is exactly the tmux case.
    const settled = await waitStable(() => (n < 3 ? ++n : n), { intervalMs: 1, reads: 3, timeoutMs: 5_000 });
    expect(settled).toBe(3);
  });

  it("fails loudly, with the last value, when the source never stops changing", async () => {
    let n = 0;
    await expect(
      waitStable(() => ++n, { intervalMs: 1, reads: 3, timeoutMs: 20, label: "runaway counter" }),
    ).rejects.toThrow(/runaway counter: never settled within 20ms/);
  });

  it("treats one unchanged read as insufficient — stopping is observed, not assumed", async () => {
    // A source that repeats a value once and then moves again would satisfy a naive two-read check.
    const series = [5, 5, 9, 9, 9, 9];
    let i = 0;
    const settled = await waitStable(() => series[Math.min(i++, series.length - 1)]!, {
      intervalMs: 1, reads: 3, timeoutMs: 5_000,
    });
    expect(settled, "accepted a pause as a stop").toBe(9);
  });
});
