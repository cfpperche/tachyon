import { describe, expect, it } from "vitest";
import { AttentionMonitor, PATTERN_STABLE_MS, type AttentionSettings } from "../../src/attention/AttentionMonitor.js";
import { classifyAttentionTail } from "../../src/attention/patterns.js";

const SETTINGS: AttentionSettings = { enabled: true, silenceSec: 8, patterns: [] };

// Captured from real opencode CLI probes on 2026-07-07, using isolated HOME/XDG dirs.
// Probe A:
//   opencode run --pure --model openai/gpt-4.1-mini "say hi"
// Output format (ANSI stripped):
const OPENCODE_UNKNOWN_ERROR = [
  "Error: {",
  '  "name": "UnknownError",',
  '  "data": {',
  '    "message": "Unexpected server error. Check server logs for details.",',
  '    "ref": "err_7b6cbec9"',
  "  }",
  "}",
].join("\n");

// Probe B:
//   OPENAI_API_KEY=not-a-real-key opencode run --pure --format json --model openai/gpt-4.1-mini "say hi"
// This documents the JSON event shape that opencode uses for provider API errors.
const OPENCODE_JSON_API_500 = '{"type":"error","timestamp":1783461054270,"sessionID":"ses_0c16fff34ffenGlq5Bk6my9jUi","error":{"name":"APIError","data":{"message":"Internal server error","statusCode":500,"isRetryable":true,"metadata":{"url":"https://api.openai.com/v1/responses"}}}}';

describe("container-generated delegation behavior", () => {
  it("opencode runtime errors surface as an attention state", async () => {
    let now = 1_000_000;
    const monitor = new AttentionMonitor({
      runningAgents: async () => ["opencode"],
      capturePane: async () => OPENCODE_UNKNOWN_ERROR,
      cpuTicks: async () => 100,
      settingsOf: () => SETTINGS,
      cmdOf: () => "opencode",
      now: () => now,
    });

    expect(classifyAttentionTail(OPENCODE_UNKNOWN_ERROR)).toMatchObject({
      kind: "stall",
      line: '"message": "Unexpected server error. Check server logs for details.",',
    });
    expect(classifyAttentionTail(OPENCODE_JSON_API_500)).toMatchObject({ kind: "error", line: OPENCODE_JSON_API_500 });

    await monitor.tick();
    now += PATTERN_STABLE_MS + 100;
    await monitor.tick();

    expect(monitor.stateOf("opencode")).toMatchObject({
      state: "needs-input",
      matchedLine: '"message": "Unexpected server error. Check server logs for details.",',
    });
  });
});
