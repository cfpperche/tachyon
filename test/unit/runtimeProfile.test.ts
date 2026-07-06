import { describe, expect, it } from "vitest";
import { assertVerifiedTranscriptIsolation, hasVerifiedTranscriptIsolation, isolationMechanismForCommand, modelLabelForRuntime, runtimeProfile } from "../../src/runtime/runtimeProfile.js";

describe("runtime profiles (spec 358 phase 1)", () => {
  it("declares Claude isolation as measured mint", () => {
    const profile = runtimeProfile("claude");
    expect(profile?.model).toMatchObject({ defaultModel: "Claude default", source: "declared", verified: false });
    expect(modelLabelForRuntime("claude", "claude-opus-4-8")).toBe("Opus 4.8");
    expect(profile?.isolation).toMatchObject({ mechanism: "mint", source: "measured", verified: true });
    expect(profile?.composer).toMatchObject({ tailLines: 8, source: "declared" });
    expect(profile?.composer?.promptLine.test("> hello")).toBe(true);
    expect(hasVerifiedTranscriptIsolation(profile!.isolation)).toBe(true);
  });

  it("declares Codex isolation as measured private-home", () => {
    const profile = runtimeProfile("codex");
    expect(profile?.model).toMatchObject({ defaultModel: "Codex default", source: "declared", verified: false });
    expect(modelLabelForRuntime("codex", "gpt-5.1-codex")).toBe("GPT-5.1 Codex");
    expect(profile?.isolation).toMatchObject({ mechanism: "private-home", source: "measured", verified: true });
    expect(profile?.composer).toMatchObject({ tailLines: 8, source: "declared" });
    expect(profile?.composer?.promptLine.test("❯ hello")).toBe(true);
    expect(hasVerifiedTranscriptIsolation(profile!.isolation)).toBe(true);
  });

  it("fails closed for known runtimes without a measured profile", () => {
    expect(isolationMechanismForCommand("opencode")).toMatchObject({ mechanism: "unknown", source: "assumed", verified: false });
    expect(() => assertVerifiedTranscriptIsolation("opencode", { name: "helper" })).toThrow(/runtime transcript isolation is not verified/);
  });

  it("fails closed for non-runtime commands", () => {
    expect(isolationMechanismForCommand("sh -c true")).toMatchObject({ mechanism: "none", source: "assumed", verified: false });
    expect(() => assertVerifiedTranscriptIsolation("sh -c true", { name: "helper" })).toThrow(/mechanism=none/);
  });
});
