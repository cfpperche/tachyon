import { describe, expect, it } from "vitest";
import {
  buildHandoffDistillPrompt,
  isHandoffDistillRuntime,
  normalizeAdditionalInstruction,
  runtimeCommand,
} from "../../src/webview/handoff/distill.js";

describe("handoff distill prompt (spec 328)", () => {
  it("requires read-first, human approval, CAS, and pending-note watermark", () => {
    const prompt = buildHandoffDistillPrompt();
    expect(prompt).toContain("get_project_handoff");
    expect(prompt).toContain("Do not call `set_project_handoff` immediately");
    expect(prompt).toContain("explicit approval");
    expect(prompt).toContain("expected_revision");
    expect(prompt).toContain("distilled_through");
    expect(prompt).toContain("pending_through");
    expect(prompt).toContain("revision mismatch");
    expect(prompt).toContain("Do not create a second pending-note queue");
  });

  it("preserves a bounded owner instruction block", () => {
    const prompt = buildHandoffDistillPrompt({ additionalInstruction: "  focus on decisions only\r\nskip chatter  " });
    expect(prompt).toContain("Additional owner instruction:");
    expect(prompt).toContain("focus on decisions only\nskip chatter");
  });

  it("normalizes and caps additional instructions", () => {
    expect(normalizeAdditionalInstruction(123)).toBe("");
    const capped = normalizeAdditionalInstruction(` ${"x".repeat(2500)} `);
    expect(capped.length).toBe(2000);
    expect(capped).toMatch(/^x+$/);
  });

  it("keeps the ad-hoc runtime allowlist explicit", () => {
    expect(isHandoffDistillRuntime("codex")).toBe(true);
    expect(isHandoffDistillRuntime("claude")).toBe(true);
    expect(isHandoffDistillRuntime("bash")).toBe(false);
    expect(runtimeCommand("codex")).toBe("codex");
  });
});
