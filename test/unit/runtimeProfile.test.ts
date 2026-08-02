import { describe, expect, it } from "vitest";
import { assertVerifiedTranscriptIsolation, hasVerifiedTranscriptIsolation, isolationMechanismForCommand, modelLabelForRuntime, runtimeProfile } from "../../src/runtime/runtimeProfile.js";

describe("runtime profiles (spec 358 phase 1)", () => {
  it("declares Claude isolation as measured mint", () => {
    const profile = runtimeProfile("claude");
    expect(profile?.model).toMatchObject({ defaultModel: "Claude default", source: "declared", verified: false });
    expect(modelLabelForRuntime("claude", "claude-opus-4-8")).toBe("Opus 4.8");
    expect(profile?.isolation).toMatchObject({ mechanism: "mint", source: "measured", verified: true });
    expect(profile?.profileVersion).toBe(2);
    expect(profile?.permission).toMatchObject({
      modes: ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"],
      source: "measured",
      verified: true,
      verifiedAt: "2026-07-26",
    });
    expect(profile?.canonicalLimitations).toEqual([]);
    // t-c5f29b re-measured this composer on Claude Code 2.1.220 and added the all-dim suggestion
    // rule; t-6ffa13 re-measured it again and added the history-echo rule. The verification date
    // moves with the measurement instead of staying at 2026-07-19.
    expect(profile?.composer).toMatchObject({
      tailLines: 8,
      ansiEmptyContentStyle: "all-dim",
      ansiHistoryEchoStyle: "prompt-background",
      source: "measured",
      verified: true,
      verifiedAt: "2026-07-27",
    });
    expect(profile?.gracefulStop).toMatchObject({ source: "measured", verified: true, verifiedAt: "2026-07-25" });
    expect(profile?.gracefulStop?.steps).toEqual([
      { type: "interruptActiveTurn" },
      { type: "sendKey", key: "C-c" },
      { type: "sendTextIfAliveAfterDelay", text: "/exit", delayMs: 150 },
    ]);
    expect(profile?.composer?.promptLine?.test("> hello")).toBe(true);
    expect(profile?.composer?.occupiedLine.test("> hello")).toBe(true);
    expect(profile?.composer?.occupiedLine.test("> ")).toBe(false);
    // t-3fe20f: measured against a live tachyon-b349073a-claude pane capture (raw bytes e2 9d af) — the
    // composer prompt glyph is '❯', not ASCII '>'; see codex's sibling assertion just below.
    expect(profile?.composer?.promptLine?.test("❯ hello")).toBe(true);
    expect(profile?.composer?.occupiedLine.test("❯ hello")).toBe(true);
    expect(profile?.composer?.occupiedLine.test("❯ ")).toBe(false);
    expect(hasVerifiedTranscriptIsolation(profile!.isolation)).toBe(true);
  });

  it("SDD 401/403: declares Pi private-home plus measured composer and graceful stop", () => {
    const profile = runtimeProfile("pi");
    expect(profile?.profileVersion).toBe(3);
    expect(profile?.isolation).toMatchObject({
      mechanism: "private-home",
      source: "measured",
      verified: true,
      verifiedAt: "2026-07-18",
    });
    expect(profile?.composer).toMatchObject({ tailLines: 16, source: "measured", verified: true });
    expect(profile?.composer?.frameLine?.test("────────────────────")).toBe(true);
    expect(profile?.composer?.readyLine?.test("0.0%/4.1k (auto)   measure")).toBe(true);
    expect(profile?.gracefulStop).toMatchObject({ source: "measured", verified: true });
    expect(profile?.permission).toMatchObject({ modes: ["full", "reviewer-read-only"], source: "measured", verified: true });
    expect(profile?.permission?.notes).toContain("--exclude-tools bash,edit,write");
    expect(profile?.gracefulStop?.steps).toEqual([
      { type: "sendKey", key: "Escape" },
      { type: "sendKeyIfAliveAfterDelay", key: "C-c", delayMs: 300 },
      { type: "sendKeyIfAliveAfterDelay", key: "C-d", delayMs: 150 },
      { type: "sendKeyIfAliveAfterDelay", key: "C-d", delayMs: 150 },
    ]);
    expect(hasVerifiedTranscriptIsolation(profile!.isolation)).toBe(true);
    expect(() => assertVerifiedTranscriptIsolation("pi", { name: "pi-child", parented: true })).not.toThrow();
  });

  it("declares Codex isolation as measured private-home", () => {
    const profile = runtimeProfile("codex");
    expect(profile?.profileVersion).toBe(2);
    expect(profile?.model).toMatchObject({ defaultModel: "Codex default", source: "declared", verified: false });
    expect(modelLabelForRuntime("codex", "gpt-5.1-codex")).toBe("GPT-5.1 Codex");
    expect(modelLabelForRuntime("codex", "gpt-5.6-sol")).toBe("GPT-5.6 Sol");
    expect(modelLabelForRuntime("codex", "gpt-5.6-terra")).toBe("GPT-5.6 Terra");
    expect(modelLabelForRuntime("codex", "gpt-5.6-luna")).toBe("GPT-5.6 Luna");
    expect(profile?.isolation).toMatchObject({ mechanism: "private-home", source: "measured", verified: true });
    expect(profile?.composer).toMatchObject({ tailLines: 8, source: "declared" });
    expect(profile?.composer?.promptLine?.test("❯ hello")).toBe(true);
    expect(profile?.composer?.occupiedLine.test("❯ hello")).toBe(true);
    expect(profile?.composer?.occupiedLine.test("❯ ")).toBe(false);
    expect(profile?.permission).toMatchObject({ source: "measured", verified: true, verifiedAt: "2026-08-02" });
    // t-aaa2c6 — Codex's posture is THREE doors, and the profile has to say all three or the next
    // reader derives the missing one by analogy, which is how this defect was built.
    expect(profile?.permission?.modes).toEqual([
      "approval_policy:untrusted",
      "approval_policy:on-failure",
      "approval_policy:on-request",
      "approval_policy:never",
      "sandbox_mode:read-only",
      "sandbox_mode:workspace-write",
      "sandbox_mode:danger-full-access",
      "mcp_tool_approval:auto",
      "mcp_tool_approval:prompt",
      "mcp_tool_approval:writes",
      "mcp_tool_approval:approve",
    ]);
    expect(profile?.permission?.notes).toContain("private CODEX_HOME/config.toml");
    expect(profile?.permission?.notes).toContain("default_tools_approval_mode");
    expect(hasVerifiedTranscriptIsolation(profile!.isolation)).toBe(true);
  });

  it("declares opencode isolation as measured private-home (t-e2ebe3 harness upgrade)", () => {
    const profile = runtimeProfile("opencode");
    expect(profile?.profileVersion).toBe(1);
    expect(profile?.isolation).toMatchObject({
      mechanism: "private-home",
      source: "measured",
      verified: true,
      verifiedAt: "2026-07-08",
    });
    expect(profile?.isolation.notes).toContain("t-e2ebe3");
    expect(profile?.composer).toMatchObject({ tailLines: 8, source: "assumed", verified: false });
    expect(profile?.composer?.occupiedLine.test("❯ human draft")).toBe(true);
    // private-home → verified isolation INDEPENDENT of cwd (no isolated worktree required, ungated delegation)
    expect(hasVerifiedTranscriptIsolation(profile!.isolation)).toBe(true);
    expect(hasVerifiedTranscriptIsolation(profile!.isolation, { isolatedWorktree: true })).toBe(true);
    expect(() => assertVerifiedTranscriptIsolation("opencode", { name: "helper" })).not.toThrow();
    expect(() => assertVerifiedTranscriptIsolation("opencode", { name: "helper", parented: true })).not.toThrow();
    expect(() => assertVerifiedTranscriptIsolation("opencode", { name: "helper", isolatedWorktree: true })).not.toThrow();
  });

  it("declares grok isolation and permission metadata from the measured runtime flags", () => {
    const profile = runtimeProfile("grok");
    expect(profile?.label).toBe("Grok");
    expect(profile?.model).toMatchObject({ defaultModel: "Grok default", source: "declared", verified: false });
    expect(modelLabelForRuntime("grok", "grok-4")).toBe("Grok 4");
    expect(profile?.isolation).toMatchObject({
      mechanism: "project-scoped",
      source: "measured",
      verified: true,
      verifiedAt: "2026-07-08",
    });
    expect(profile?.permission).toMatchObject({
      modes: ["default", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "plan"],
      alwaysApproveFlag: "--always-approve",
      source: "measured",
      verified: false,
    });
    // t-aafa10 — no longer a guess: measured against grok 0.2.112 in a real pane, with the byte
    // fixtures and state-by-state assertions living in grokComposerMeasured.test.ts.
    expect(profile?.composer).toMatchObject({ tailLines: 8, source: "measured", verified: true, verifiedAt: "2026-07-28" });
    expect(profile?.composer?.occupiedLine.test("❯ human draft")).toBe(true);
    // t-b103c5 — cancel-then-exit for tool-auth prompts where Ctrl+C means cancel, not exit.
    expect(profile?.gracefulStop).toMatchObject({ source: "measured", verified: true, verifiedAt: "2026-07-29" });
    expect(profile?.gracefulStop?.steps).toEqual([
      { type: "sendKey", key: "C-c" },
      { type: "sendKeyIfAliveAfterDelay", key: "C-c", delayMs: 300 },
      { type: "sendKeyIfAliveAfterDelay", key: "C-c", delayMs: 300 },
    ]);
    expect(hasVerifiedTranscriptIsolation(profile!.isolation)).toBe(false);
    expect(hasVerifiedTranscriptIsolation(profile!.isolation, { isolatedWorktree: true })).toBe(true);
  });

  it("declares hermes isolation as measured private-home (HERMES_HOME)", () => {
    const profile = runtimeProfile("hermes");
    expect(profile?.label).toBe("Hermes Agent");
    expect(profile?.isolation).toMatchObject({
      mechanism: "private-home",
      source: "measured",
      verified: true,
      verifiedAt: "2026-07-13",
    });
    expect(profile?.permission?.alwaysApproveFlag).toBe("--yolo");
    expect(hasVerifiedTranscriptIsolation(profile!.isolation)).toBe(true);
    expect(() => assertVerifiedTranscriptIsolation("hermes", { name: "h1", parented: true })).not.toThrow();
  });

  it("fails closed for known runtimes without a measured profile", () => {
    expect(isolationMechanismForCommand("gemini")).toMatchObject({ mechanism: "unknown", source: "assumed", verified: false });
    expect(() => assertVerifiedTranscriptIsolation("gemini", { name: "helper" })).toThrow(/runtime transcript isolation is not verified/);
  });

  it("fails closed for non-runtime commands", () => {
    expect(isolationMechanismForCommand("sh -c true")).toMatchObject({ mechanism: "none", source: "assumed", verified: false });
    expect(() => assertVerifiedTranscriptIsolation("sh -c true", { name: "helper" })).toThrow(/mechanism=none/);
  });
});
