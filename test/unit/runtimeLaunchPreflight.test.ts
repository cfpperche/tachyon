import { describe, expect, it } from "vitest";
import { CodexLaunchPreflight, type CodexProbeResult } from "../../src/runtime/adapters/codexLaunchPreflight.js";
import { boundedCloseMatches, parseLaunchCommand } from "../../src/runtime/launchPreflight.js";

const output = (value: unknown, extra: Partial<CodexProbeResult> = {}): CodexProbeResult => ({ code: 0, stdout: Buffer.from(JSON.stringify(value)), ...extra });
const catalog = { models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].map((slug) => ({ slug, visibility: "list", base_instructions: "must never escape" })) };

describe("runtime launch preflight", () => {
  it("accepts the exact advertised Sol slug and rejects the absent generic slug", async () => {
    const adapter = new CodexLaunchPreflight(async () => output(catalog));
    await expect(adapter.check(parseLaunchCommand("codex --model gpt-5.6-sol")!, {})).resolves.toMatchObject({ state: "supported", model: "gpt-5.6-sol" });
    await expect(adapter.check(parseLaunchCommand("codex --model gpt-5.6")!, {})).resolves.toEqual({
      state: "unsupported", code: "runtime_model_unavailable", runtime: "codex", model: "gpt-5.6",
      suggestions: ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"],
    });
  });

  it.each([
    ["malformed", { code: 0, stdout: Buffer.from("secret-not-json") }],
    ["timeout", { code: null, stdout: Buffer.alloc(0), timedOut: true }],
    ["oversized", { code: null, stdout: Buffer.alloc(0), oversized: true }],
    ["non-zero", { code: 2, stdout: Buffer.from("provider secret") }],
  ])("fails closed with a redacted reason for a %s catalog", async (_label, probe) => {
    const result = await new CodexLaunchPreflight(async () => probe).check(parseLaunchCommand("codex -m gpt-5.6")!, {});
    expect(result).toMatchObject({ state: "failed", code: "runtime_preflight_failed" });
    expect(JSON.stringify(result)).not.toMatch(/secret|provider/);
  });

  it("degrades ambiguous shell composition without executing or guessing", () => {
    expect(parseLaunchCommand("codex --model gpt-5.6 && touch /tmp/nope")).toBeUndefined();
    expect(parseLaunchCommand("codex --model $(steal-token)")).toBeUndefined();
  });

  it("bounds and deterministically orders suggestion-only slugs", () => {
    expect(boundedCloseMatches("gpt-5.6", ["gpt-5.6-z", "gpt-5.6-a", "gpt-5.6-b", "gpt-5.6-c"])).toEqual(["gpt-5.6-a", "gpt-5.6-b", "gpt-5.6-c"]);
  });
});
