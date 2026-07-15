import { describe, expect, it } from "vitest";
import {
  buildDistillTargets,
  buildHandoffDistillCommand,
  buildHandoffDistillPrompt,
  HANDOFF_DISTILL_PROFILES,
  isHandoffDistillRuntime,
  normalizeAdditionalInstruction,
  normalizeHandoffDistillArgs,
  reconcileDistillSelection,
  resolveHandoffDistillProfile,
} from "../../src/handoff/distill.js";

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
    expect(HANDOFF_DISTILL_PROFILES.map((p) => p.id)).toEqual(["codex:default", "claude:default"]);
    expect(resolveHandoffDistillProfile("codex:default")?.command).toBe("codex");
    expect(resolveHandoffDistillProfile("claude:default")?.command).toBe("claude");
    expect(resolveHandoffDistillProfile("bash")).toBeUndefined();
    expect(HANDOFF_DISTILL_PROFILES.every((p) => p.command === p.runtime)).toBe(true);
  });

  it("lets the owner append one-line runtime arguments to the ad-hoc command", () => {
    const codex = resolveHandoffDistillProfile("codex:default");
    const claude = resolveHandoffDistillProfile("claude:default");

    expect(codex && buildHandoffDistillCommand(codex, "  --model gpt-5.6 --full-auto  ")).toBe("codex --model gpt-5.6 --full-auto");
    expect(claude && buildHandoffDistillCommand(claude, "--model sonnet")).toBe("claude --model sonnet");
  });

  it("drops multi-line ad-hoc args instead of turning them into a shell script", () => {
    expect(normalizeHandoffDistillArgs(123)).toBe("");
    expect(normalizeHandoffDistillArgs("--model sonnet\nrm -rf nope")).toBe("");
    expect(normalizeHandoffDistillArgs("--model sonnet")).toBe("--model sonnet");
  });
});

describe("buildDistillTargets (t-1ba76d)", () => {
  it("includes declared stopped/resumable agents and orders running first", () => {
    const rows = [
      { name: "zeta", kind: "agent", running: false, declared: true },
      { name: "alpha", kind: "agent", running: true, declared: true },
      { name: "beta", kind: "agent", running: false, declared: true },
      { name: "dev", kind: "terminal", running: true, declared: true },
      { name: "worker", kind: "agent", running: false, declared: false },
      { name: "live-adhoc", kind: "agent", running: true, declared: false },
    ];
    const targets = buildDistillTargets(rows, ["beta"]);
    expect(targets.map((t) => t.name)).toEqual(["alpha", "live-adhoc", "beta", "zeta"]);
    expect(targets.find((t) => t.name === "alpha")).toMatchObject({ state: "running", description: "running · declared" });
    expect(targets.find((t) => t.name === "beta")).toMatchObject({ state: "resumable", description: "resumable · declared" });
    expect(targets.find((t) => t.name === "zeta")).toMatchObject({ state: "stopped", description: "stopped · declared" });
    expect(targets.find((t) => t.name === "live-adhoc")).toMatchObject({ state: "running", description: "running · ad-hoc" });
    expect(targets.some((t) => t.name === "worker" || t.name === "dev")).toBe(false);
  });

  it("omits dead/stopping panes from the running tier", () => {
    const targets = buildDistillTargets(
      [
        { name: "a", kind: "agent", running: true, dead: true, declared: true },
        { name: "b", kind: "agent", running: true, stopping: true, declared: true },
        { name: "c", kind: "agent", running: true, declared: true },
      ],
      ["a"],
    );
    expect(targets.map((t) => ({ name: t.name, state: t.state }))).toEqual([
      { name: "c", state: "running" },
      { name: "a", state: "resumable" },
      { name: "b", state: "stopped" },
    ]);
  });
});

describe("reconcileDistillSelection (t-4eb7c0)", () => {
  const targets = [{ name: "codex" }, { name: "grok" }];

  it("forces adhoc when no running targets", () => {
    expect(reconcileDistillSelection([], { mode: "existing", agent: "codex" })).toEqual({ mode: "adhoc", agent: "" });
  });

  it("keeps a still-valid existing agent after refresh", () => {
    expect(reconcileDistillSelection(targets, { mode: "existing", agent: "grok" })).toEqual({ mode: "existing", agent: "grok" });
  });

  it("repicks the first target when the previous existing agent left the list", () => {
    expect(reconcileDistillSelection(targets, { mode: "existing", agent: "claude" })).toEqual({ mode: "existing", agent: "codex" });
  });

  it("promotes stale empty open (adhoc + no agent) to existing when targets arrive", () => {
    expect(reconcileDistillSelection(targets, { mode: "adhoc", agent: "" })).toEqual({ mode: "existing", agent: "codex" });
  });

  it("does not steal a deliberate adhoc choice when targets already exist", () => {
    // agent still holds the prior existing name after the user switched Target → Ad-hoc
    expect(reconcileDistillSelection(targets, { mode: "adhoc", agent: "codex" })).toEqual({ mode: "adhoc", agent: "codex" });
  });
});
