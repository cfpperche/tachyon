import { describe, it, expect } from "vitest";
import { type AgentAttention } from "../../src/attention/AttentionMonitor.js";
import {
  AdhocBackstopMonitor,
  DEFAULT_ADHOC_BACKSTOP_THRESHOLD_MS,
  idleNotifyThresholdMs,
} from "../../src/workspace/AdhocBackstopMonitor.js";
import { parseConfig, MAX_IDLE_NOTIFY_MINUTES } from "../../src/config/loadConfig.js";
import type { ManagedEntryInfo } from "../../src/agents/AgentManager.js";

/**
 * `t-585d5c` — the idle-notification threshold is configurable per workspace.
 *
 * Ten fixed minutes is too slow for a release cut, so a human can set the window. Three properties
 * carry the feature and each is asserted against the thing that actually enforces it:
 *
 *  1. **An unconfigured workspace is unchanged.** The default is not a value written into config; it
 *     is the absence of one, so upgrading changes nothing for anyone who never opens the setting.
 *  2. **Off is a word, not a number.** `"never"` disables; `0` is refused and pointed at that word,
 *     because `0` reads literally as "notify immediately" — the opposite of the off it resembles.
 *  3. **A change applies mid-session.** The monitor is built once in the Workspace constructor, so a
 *     threshold captured there could only change by recreating agents. It is resolved per tick.
 */

const agent = (name: string, opts: Partial<ManagedEntryInfo> = {}): ManagedEntryInfo => ({
  name, session: `s-${name}`, running: true, declared: false, dead: false, crashed: false, kind: "agent", ...opts,
});

const att = (state: AgentAttention["state"], stableSince: number): AgentAttention => ({
  state, since: stableSince, contentSince: stableSince, outputStableSince: stableSince,
  episodeKey: "e1", stalled: false, awaitingHuman: false, unseen: false, composerOccupied: false, stale: false,
});

/** A live parent with one live idle child, and a threshold the test controls between ticks. */
function fixture(threshold: number | null | (() => number | null)) {
  let now = 1_000_000;
  const entries: ManagedEntryInfo[] = [agent("parent"), agent("child", { parent: "parent" })];
  const attention = new Map<string, AgentAttention>([["child", att("idle", now)]]);
  const delivered: string[] = [];
  const monitor = new AdhocBackstopMonitor(
    {
      listEntries: async () => entries,
      attentionOf: (name) => attention.get(name),
      now: () => now,
      deliverNotice: async (parent, line) => { delivered.push(`${parent}: ${line}`); },
    },
    threshold,
  );
  return { monitor, delivered, advance: (ms: number) => { now += ms; } };
}

describe("t-585d5c — converting the configured value into a window", () => {
  it("treats an unconfigured workspace as the shipped default", () => {
    // The default is the ABSENCE of config, not a number someone wrote. That is what makes the
    // upgrade invisible to a workspace that never touches the setting.
    expect(idleNotifyThresholdMs(undefined)).toBe(DEFAULT_ADHOC_BACKSTOP_THRESHOLD_MS);
    expect(DEFAULT_ADHOC_BACKSTOP_THRESHOLD_MS).toBe(10 * 60_000);
  });

  it("reads minutes as minutes", () => {
    expect(idleNotifyThresholdMs(2)).toBe(120_000);
    expect(idleNotifyThresholdMs(90)).toBe(90 * 60_000);
    // Fractions are legal input and must not silently floor to zero, which would mean "notify always".
    expect(idleNotifyThresholdMs(0.5)).toBe(30_000);
  });

  it("turns `never` into no window at all", () => {
    expect(idleNotifyThresholdMs("never")).toBeNull();
  });
});

describe("t-585d5c — what the monitor does with it", () => {
  it("notifies at the configured window, not the default one", async () => {
    const f = fixture(idleNotifyThresholdMs(2));
    f.advance(90_000); // 1m30s — past nothing yet
    await f.monitor.tick();
    expect(f.delivered, "notified before the configured 2 minutes").toEqual([]);

    f.advance(60_000); // now 2m30s idle
    await f.monitor.tick();
    expect(f.delivered).toHaveLength(1);
    expect(f.delivered[0]).toContain("child");
    // The default would still be 7+ minutes away, so this could only have come from the config.
    expect(150_000).toBeLessThan(DEFAULT_ADHOC_BACKSTOP_THRESHOLD_MS);
  });

  it("never notifies when the setting is `never`, however long the silence", async () => {
    const f = fixture(idleNotifyThresholdMs("never"));
    f.advance(24 * 60 * 60_000); // a full day
    await f.monitor.tick();
    expect(f.delivered).toEqual([]);
  });

  it("does not spend an agent's nudge while switched off", async () => {
    // The subtle half of "off": if a disabled pass still marked the episode as nudged, turning the
    // setting back on would stay silent for work that had never actually been reported.
    let configured: number | "never" = "never";
    const f = fixture(() => idleNotifyThresholdMs(configured));
    f.advance(30 * 60_000);
    await f.monitor.tick();
    expect(f.delivered).toEqual([]);

    configured = 5;
    await f.monitor.tick();
    expect(f.delivered, "the nudge was consumed by a pass that never ran").toHaveLength(1);
  });

  it("applies a change made DURING a session, with no restart and no new monitor", async () => {
    // The property the feature rests on. The monitor is constructed once in the Workspace
    // constructor; a threshold captured there could only change by rebuilding the workspace, which
    // means recreating agents — exactly what this must not require.
    let configured: number | "never" = 60;
    const f = fixture(() => idleNotifyThresholdMs(configured));

    f.advance(5 * 60_000);
    await f.monitor.tick();
    expect(f.delivered, "60-minute window fired after 5 minutes").toEqual([]);

    configured = 3; // the human edits tachyon.yml mid-session
    await f.monitor.tick();
    expect(f.delivered, "the edit did not reach the next tick").toHaveLength(1);
  });
});

describe("t-585d5c — the config surface, fail-closed", () => {
  const load = (yaml: string) => parseConfig(`agents:\n  a:\n    cmd: claude\n${yaml}`);

  it("accepts a positive number of minutes and `never`", () => {
    expect(load("settings:\n  agentNotifications:\n    idleAfterMinutes: 3\n").config?.settings.agentNotifications)
      .toEqual({ idleAfterMinutes: 3 });
    expect(load("settings:\n  agentNotifications:\n    idleAfterMinutes: never\n").config?.settings.agentNotifications)
      .toEqual({ idleAfterMinutes: "never" });
  });

  it("leaves it absent when nothing is written, so the default keeps its meaning", () => {
    expect(load("").config?.settings.agentNotifications).toBeUndefined();
  });

  it("refuses zero, negatives and NaN — naming the spelling that does mean off", () => {
    for (const bad of ["0", "-5", "not-a-number"]) {
      const result = load(`settings:\n  agentNotifications:\n    idleAfterMinutes: ${bad}\n`);
      expect(result.errors.join("\n"), `accepted ${bad}`).toContain("must be a positive number of minutes");
      expect(result.errors.join("\n")).toContain("never");
    }
  });

  it("refuses an absurd window rather than clamping it", () => {
    // A clamp would leave the file asking for one thing while the product does another, with nothing
    // on screen to say which won. `6000` for `60` is the typo this catches.
    const result = load(`settings:\n  agentNotifications:\n    idleAfterMinutes: ${MAX_IDLE_NOTIFY_MINUTES + 1}\n`);
    expect(result.errors.join("\n")).toContain(`${MAX_IDLE_NOTIFY_MINUTES}-minute maximum`);
    expect(result.errors.join("\n")).toContain("never");
  });

  it("refuses an unknown key by name", () => {
    const result = load("settings:\n  agentNotifications:\n    idleAfterMinuts: 5\n");
    expect(result.errors.join("\n")).toContain("unknown key 'idleAfterMinuts'");
    expect(result.errors.join("\n")).toContain("allowed: idleAfterMinutes");
  });

  it("refuses a non-mapping block", () => {
    expect(load("settings:\n  agentNotifications: 5\n").errors.join("\n"))
      .toContain("settings.agentNotifications: must be a mapping");
  });
});
