import { describe, expect, it } from "vitest";
import { AttentionMonitor, type AttentionSettings } from "../../src/attention/AttentionMonitor.js";

const SETTINGS: AttentionSettings = { enabled: true, silenceSec: 1, patterns: [] };
const CODEX_PLACEHOLDER_ESCAPED = "\x1b[1m›\x1b[0m \x1b[2mWrite tests for @filename\x1b[0m";
const CODEX_DRAFT_ESCAPED = "\x1b[1m›\x1b[0m hello draft";

async function composerOccupiedFor(cmd: string, plainContent: string, escapedContent = plainContent): Promise<boolean> {
  let now = 1_000_000;
  const monitor = new AttentionMonitor({
    runningAgents: async () => ["agent"],
    capturePane: async () => plainContent,
    capturePaneEscaped: async () => escapedContent,
    cpuTicks: async () => null,
    settingsOf: () => SETTINGS,
    cmdOf: () => cmd,
    now: () => now,
  });
  await monitor.tick();
  now += 1_500;
  await monitor.tick();
  expect(monitor.stateOf("agent")?.state).toBe("idle");
  return monitor.stateOf("agent")?.composerOccupied ?? true;
}

describe("container-generated delegation behavior", () => {
  it("codex composer placeholder is not a draft: idle codex pane accepts delivery instead of refusing as composer-occupied", async () => {
    await expect(composerOccupiedFor("codex", "› Write tests for @filename", CODEX_PLACEHOLDER_ESCAPED)).resolves.toBe(false);
    await expect(composerOccupiedFor("codex", "› hello draft", CODEX_DRAFT_ESCAPED)).resolves.toBe(true);

    await expect(composerOccupiedFor("claude", "> existing draft")).resolves.toBe(true);
    await expect(composerOccupiedFor("claude", "> ")).resolves.toBe(false);
  });
});
