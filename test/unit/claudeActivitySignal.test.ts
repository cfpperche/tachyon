import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AttentionMonitor, type AttentionSettings } from "../../src/attention/AttentionMonitor.js";
import { runtimeProfile } from "../../src/runtime/runtimeProfile.js";

/**
 * t-30ff0d — the sidebar said idle while a canonical Claude agent was mid-turn.
 *
 * Reproduced live on Claude Code 2.1.220: with a background shell running, the pane is
 * BYTE-IDENTICAL for seconds and the process blocks on I/O instead of burning CPU. Those are exactly
 * the two things `AttentionMonitor` reads to decide idle, so it decided idle — and a human looking at
 * the fleet concluded, correctly from what was shown, that nothing was running.
 *
 * These are the real panes from that session, one per side of the transition. The in-flight one fails
 * against the pre-fix monitor (it goes idle once the content settles); the after-final one is the
 * control that keeps the fix from simply pinning Claude to "working" forever.
 */

const FIXTURES = path.resolve(__dirname, "../fixtures/claude-activity");
const pane = (name: string): string =>
  fs.readFileSync(path.join(FIXTURES, `${name}.pane.txt`), "utf8");

const SETTINGS: AttentionSettings = { enabled: true, silenceSec: 1, patterns: [] };

/** Drive the real monitor over a pane that never changes, exactly like a frozen live one. */
async function settle(content: string, ticks = 6): Promise<string | undefined> {
  let now = 1_000_000;
  const monitor = new AttentionMonitor({
    runningAgents: async () => ["claude-builder"],
    capturePane: async () => content,
    capturePaneEscaped: async () => content,
    // Blocked on I/O, not computing — the CPU heuristic cannot rescue this and must not be asked to.
    cpuTicks: async () => 0,
    settingsOf: () => SETTINGS,
    cmdOf: () => "claude",
    now: () => now,
  } as never);
  for (let i = 0; i < ticks; i++) { await monitor.tick(); now += 2_000; }
  return monitor.stateOf("claude-builder")?.state;
}

describe("Claude activity signal (t-30ff0d)", () => {
  it("stays working while a background shell is still running, on a frozen pane", async () => {
    // FAILS before the fix: no content change + quiet CPU settles straight to "idle".
    expect(await settle(pane("tool-inflight"))).toBe("working");
  });

  it("returns to idle once the work finishes and the composer is free", async () => {
    // The control that matters: the fix must not simply hold Claude at "working". This pane is the
    // same session moments later, and it still CONTAINS `1 shell still running` in scrolled-up
    // transcript — which is why the signal is bounded to the bottom of the pane.
    expect(await settle(pane("after-final"))).toBe("idle");
  });

  it("returns to idle after an explicit recap even when a residual shell remains counted (t-ca4a3c)", async () => {
    // Measured from claude-reviewer: the response and recap are complete, the composer is stable,
    // and only a harness monitor remains in Claude's mode-line shell count. Before this fix the
    // t-30ff0d activity signal outweighed the newer handback forever.
    expect(await settle(pane("recap-residual-shell"))).toBe("idle");
  });

  it("reads the signal only from the pane bottom, never from transcript history", () => {
    const activity = runtimeProfile("claude")!.activity!;
    const after = pane("after-final").split("\n");
    const stale = after.filter((line) => /shell still running/.test(line));
    expect(stale.length).toBeGreaterThan(0); // history really does still say it
    const bottom = after.filter((l) => l.trim().length > 0).slice(-activity.tailLines);
    expect(bottom.some((line) => activity.runningLine.test(line))).toBe(false);
  });

  it("keeps the working→idle edge that done/unseen depends on (t-9552f3)", async () => {
    // The bug made this edge fire mid-turn, marking an agent done while it was still working.
    // Assert the edge still happens on the real end of the turn, not that it never happens.
    let now = 1_000_000;
    let content = pane("tool-inflight");
    const monitor = new AttentionMonitor({
      runningAgents: async () => ["claude-builder"],
      capturePane: async () => content,
      capturePaneEscaped: async () => content,
      cpuTicks: async () => 0,
      settingsOf: () => SETTINGS,
      cmdOf: () => "claude",
      now: () => now,
    } as never);
    for (let i = 0; i < 6; i++) { await monitor.tick(); now += 2_000; }
    expect(monitor.stateOf("claude-builder")?.state).toBe("working");
    expect(monitor.stateOf("claude-builder")?.unseen).toBe(false);
    content = pane("after-final");
    for (let i = 0; i < 6; i++) { await monitor.tick(); now += 2_000; }
    expect(monitor.stateOf("claude-builder")?.state).toBe("idle");
    expect(monitor.stateOf("claude-builder")?.unseen).toBe(true);
  });

  it("declares the signal as measured evidence, not a guess", () => {
    const activity = runtimeProfile("claude")!.activity!;
    expect(activity.source).toBe("measured");
    expect(activity.verified).toBe(true);
    expect(activity.verifiedAt).toBe("2026-07-29");
  });
});
