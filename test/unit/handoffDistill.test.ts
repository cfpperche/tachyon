import { describe, expect, it } from "vitest";
import {
  buildHandoffDistillPrompt,
  buildHandoffDistillProfiles,
  HANDOFF_DISTILL_PROFILES,
  handoffDistillProfilesFromCodexCatalog,
  isHandoffDistillRuntime,
  normalizeAdditionalInstruction,
  resolveHandoffDistillProfile,
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
  });

  it("resolves ad-hoc profiles to host-owned commands", () => {
    expect(resolveHandoffDistillProfile("codex:default")?.command).toBe("codex");
    expect(resolveHandoffDistillProfile("claude:sonnet")?.command).toBe("claude --model sonnet");
    expect(resolveHandoffDistillProfile("bash")).toBeUndefined();
    expect(HANDOFF_DISTILL_PROFILES.every((p) => p.command.startsWith(`${p.runtime} `) || p.command === p.runtime)).toBe(true);
  });

  it("builds Codex ad-hoc profiles from the runtime model catalog", () => {
    const profiles = handoffDistillProfilesFromCodexCatalog({
      models: [
        { slug: "gpt-5.6", display_name: "GPT-5.6", visibility: "list", supported_in_api: true },
        { slug: "hidden-model", display_name: "Hidden", visibility: "hidden", supported_in_api: true },
        { slug: "not-api", display_name: "No API", visibility: "list", supported_in_api: false },
        { slug: "bad model", display_name: "Bad", visibility: "list", supported_in_api: true },
      ],
    });

    expect(profiles).toEqual([
      {
        id: "codex:model:gpt-5.6",
        runtime: "codex",
        label: "Codex — GPT-5.6",
        command: "codex --model gpt-5.6",
        note: "Discovered from `codex debug models` for this installed Codex runtime.",
      },
    ]);
  });

  it("prepends discovered Codex models and keeps CLI default as fallback", () => {
    const profiles = buildHandoffDistillProfiles({ codexCatalog: { models: [{ slug: "gpt-next", visibility: "list", supported_in_api: true }] } });
    expect(profiles[0]?.id).toBe("codex:model:gpt-next");
    expect(profiles.some((p) => p.id === "codex:default")).toBe(true);
    expect(resolveHandoffDistillProfile("codex:model:gpt-next", profiles)?.command).toBe("codex --model gpt-next");
  });
});
