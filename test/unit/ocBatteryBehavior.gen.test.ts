import { describe, expect, it } from "vitest";
import { modelLabelForRuntime } from "../../src/runtime/runtimeProfile.js";

describe("container-generated delegation behavior", () => {
  it("model label fallback title-cases unknown model ids", () => {
    // Unknown ids (no alias hit) fall back to title-casing the raw id.
    expect(modelLabelForRuntime("claude", "some-fancy-new-model")).toBe("Some Fancy New Model");
    expect(modelLabelForRuntime("codex", "gpt_6_minimal")).toBe("Gpt 6 Minimal");
    // Known aliases still resolve to their curated label, not the title-cased fallback.
    expect(modelLabelForRuntime("claude", "claude-opus-4-8")).toBe("Opus 4.8");
    // Empty/whitespace falls back to the runtime default label.
    expect(modelLabelForRuntime("claude", "  ")).toBe("Claude default");
  });
});