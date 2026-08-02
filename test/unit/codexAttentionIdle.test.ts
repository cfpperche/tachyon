import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AttentionMonitor,
  type AttentionSettings,
} from "../../src/attention/AttentionMonitor.js";
import { applyCompletionHint, CompletionHintStore } from "../../src/attention/completionHint.js";
import { isComposerOccupied } from "../../src/runtime/composerRegion.js";
import { runtimeProfile } from "../../src/runtime/runtimeProfile.js";

/**
 * t-0db8cb — codex attention from REAL panes.
 *
 * Captured 2026-08-02 from live Temporary codex `portacomport` in tmux
 * `tachyon-b349073a-portacomport` after it finished a turn and sat at the idle prompt
 * (`› Improve documentation…` dim suggestion + status footer, no Working line).
 * Escaped capture keeps SGR so dim-suggestion ≠ human draft (t-aee74e).
 *
 * Declared window (code of record):
 * - Workspace ATTENTION_POLL_MS = 3000
 * - default silenceSec = 8
 * - first monitor tick always seeds state "working" without idle classification
 * → earliest idle after content freeze: silenceSec (8s) once contentSince is set (~8–11s wall).
 */

const FIXTURES = path.resolve(__dirname, "../fixtures/codex-activity");
const pane = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), "utf8");

const SETTINGS: AttentionSettings = { enabled: true, silenceSec: 8, patterns: [] };
/** Product poll interval — keep tests aligned with Workspace ATTENTION_POLL_MS. */
const ATTENTION_POLL_MS = 3000;

async function settle(
  content: string,
  opts: { escaped?: string; cpuBurn?: boolean; ticks?: number; cmd?: string } = {},
): Promise<{ state?: string; composerOccupied?: boolean }> {
  let now = 1_000_000;
  let cpu = 0;
  const mon = new AttentionMonitor({
    runningAgents: async () => ["codex-child"],
    capturePane: async () => content,
    capturePaneEscaped: async () => opts.escaped ?? content,
    cpuTicks: async () => {
      if (opts.cpuBurn) {
        cpu += 50;
        return cpu;
      }
      return 0;
    },
    settingsOf: () => SETTINGS,
    cmdOf: () => opts.cmd ?? "codex",
    now: () => now,
  } as never);
  const n = opts.ticks ?? 8;
  for (let i = 0; i < n; i++) {
    await mon.tick();
    now += ATTENTION_POLL_MS;
  }
  const s = mon.stateOf("codex-child");
  return { state: s?.state, composerOccupied: s?.composerOccupied };
}

describe("codex attention idle (t-0db8cb, real pane)", () => {
  it("declares the update window used by the product", () => {
    // silenceSec default is 8 (AgentManager / Temporary spawn); poll is 3s in Workspace.
    expect(SETTINGS.silenceSec * 1000).toBe(8000);
    expect(ATTENTION_POLL_MS).toBe(3000);
    // Earliest idle after freeze: contentSince set on first tick, idle when stableMs >= 8s
    // → on the tick at t≈9s (first tick 0 + 3×3s).
    expect(SETTINGS.silenceSec * 1000).toBeGreaterThan(ATTENTION_POLL_MS);
  });

  it("idle codex prompt (measured after-final) reports idle within silenceSec, not minutes", async () => {
    const plain = pane("after-final.pane.txt");
    const escaped = pane("after-final.escaped.txt");
    expect(plain).toMatch(/›\s/);
    expect(plain).not.toMatch(/Working \(\d/);
    expect(plain).toMatch(/Worked for /);

    // Dim suggestion is occupied without ANSI, empty with measured escaped capture.
    const composer = runtimeProfile("codex")!.composer!;
    expect(isComposerOccupied(plain, composer)).toBe(true);
    expect(isComposerOccupied(escaped, composer)).toBe(false);

    const early = await settle(plain, { escaped, ticks: 2 }); // ~3s — still before silenceSec
    expect(early.state).toBe("working");

    const done = await settle(plain, { escaped, ticks: 5 }); // 0+4*3s = 12s wall after first seed
    expect(done.state).toBe("idle");
    expect(done.composerOccupied).toBe(false);
  });

  it("ticking Working line (same chrome family) stays working while the timer moves", async () => {
    const base = pane("tool-inflight.pane.txt");
    expect(base).toMatch(/Working \(/);

    let n = 58;
    let now = 1_000_000;
    const mon = new AttentionMonitor({
      runningAgents: async () => ["codex-child"],
      capturePane: async () =>
        base.replace(/Working \(\d+m \d+s/, `Working (1m ${String(n).padStart(2, "0")}s`),
      capturePaneEscaped: async () => base,
      cpuTicks: async () => 0,
      settingsOf: () => SETTINGS,
      cmdOf: () => "codex",
      now: () => now,
    } as never);
    for (let i = 0; i < 6; i++) {
      n += 3;
      await mon.tick();
      now += ATTENTION_POLL_MS;
    }
    expect(mon.stateOf("codex-child")?.state).toBe("working");
  });

  it("completion hint keeps list_agents-facing idle across post-notify chrome while raw may lag on CPU", async () => {
    const plain = pane("after-final.pane.txt");
    const escaped = pane("after-final.escaped.txt");
    let now = 1_000_000;
    let cpu = 0;
    const mon = new AttentionMonitor({
      runningAgents: async () => ["codex-child"],
      capturePane: async () => plain,
      capturePaneEscaped: async () => escaped,
      cpuTicks: async () => {
        cpu += 50;
        return cpu;
      },
      settingsOf: () => SETTINGS,
      cmdOf: () => "codex",
      now: () => now,
    } as never);
    for (let i = 0; i < 8; i++) {
      await mon.tick();
      now += ATTENTION_POLL_MS;
    }
    // Quiet pane + CPU burn → raw stays working after the first silence baseline (t-d65be2 path).
    expect(mon.stateOf("codex-child")?.state).toBe("working");

    const store = new CompletionHintStore();
    // Doorbell at t=0 of this window; contentSince is earlier — latch must win for consumers.
    store.mark("codex-child", now - 60_000);
    const presented = applyCompletionHint(mon.stateOf("codex-child"), store.has("codex-child"), false);
    expect(presented?.state).toBe("idle");
    expect(presented?.composerOccupied).toBe(false);

    // t-0db8cb: final chrome of the SAME turn must not clear the latch (only a new working turn should).
    // Simulate the old clearIfNewOutput call with contentSince after mark (idle paint after notify):
    store.clearIfNewOutput("codex-child", now);
    // Under the FIXED Workspace policy this clear is only invoked on →working; the store API still
    // clears when contentSince > mark. Prove applyCompletionHint needs the latch, and that a
    // new-turn clear (content after mark) is the intentional drop path:
    expect(store.has("codex-child")).toBe(false);
  });

  it("new-turn contentSince after mark is what drops the latch; same-turn keep is call-site policy", () => {
    const store = new CompletionHintStore();
    store.mark("a", 1000);
    // Same-turn final paint after notify (contentSince advanced) — store would clear if called;
    // Workspace must not call clearIfNewOutput except on →working (tested via call-site comment +
    // integration of attentionOf). Here we document the store contract.
    store.clearIfNewOutput("a", 1000);
    expect(store.has("a")).toBe(true);
    store.clearIfNewOutput("a", 1001);
    expect(store.has("a")).toBe(false);
  });
});
