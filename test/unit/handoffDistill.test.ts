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
  type DistillListRow,
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
  it("includes Saved stopped/resumable agents and orders running first", () => {
    const rows: DistillListRow[] = [
      { name: "zeta", kind: "agent", running: false, lifetime: "saved", resumePolicy: "restartable" },
      { name: "alpha", kind: "agent", running: true, lifetime: "saved", resumePolicy: "restartable" },
      { name: "beta", kind: "agent", running: false, lifetime: "saved", resumePolicy: "restartable" },
      { name: "dev", kind: "terminal", running: true, lifetime: "saved", resumePolicy: "restartable" },
      { name: "worker", kind: "agent", running: false, lifetime: "temporary", resumePolicy: "collected" },
      { name: "live-adhoc", kind: "agent", running: true, lifetime: "temporary", resumePolicy: "collected" },
    ];
    const targets = buildDistillTargets(rows, ["beta"]);
    expect(targets.map((t) => t.name)).toEqual(["alpha", "live-adhoc", "beta", "zeta"]);
    expect(targets.find((t) => t.name === "alpha")).toMatchObject({ state: "running", description: "running · saved" });
    expect(targets.find((t) => t.name === "beta")).toMatchObject({ state: "resumable", description: "resumable · saved" });
    expect(targets.find((t) => t.name === "zeta")).toMatchObject({ state: "stopped", description: "stopped · saved" });
    expect(targets.find((t) => t.name === "live-adhoc")).toMatchObject({ state: "running", description: "running · temporary" });
    expect(targets.some((t) => t.name === "worker" || t.name === "dev")).toBe(false);
  });

  /**
   * t-04052d, from adversarial review — A STOPPED FORK IS A HANDOFF TARGET, and the two axes are why.
   *
   * The rule is "is this agent's definition still there to receive work?". Written on `lifetime` alone
   * it read "a Temporary must be running", which refused a fork: `temporary` because no durable
   * Profile backs it, but `restartable` because it owns its own resume block and its definition
   * reloads — the property SDD 482 phase 2 was obliged to preserve. Refusing it is `lifetime`
   * absorbing resume capability, the exact collapse the split exists to prevent.
   *
   * The second case is the NEGATIVE CONTROL and it is what makes the first one safe. The tempting fix
   * is "list a stopped Temporary when it is in `resumable`" — but `resumableAgentNames` is every row
   * carrying a resume block, and `spawnCore` writes one for EVERY adapter-backed start, ad-hoc
   * included. That fix would list `plain-adhoc` below and erase the refusal entirely. `resumePolicy`
   * is the fact that separates the two, which is what it was created for.
   */
  it("lists a stopped RESTARTABLE temporary (a fork) but still refuses a collected one", () => {
    const rows: DistillListRow[] = [
      { name: "claude-fork-1", kind: "agent", running: false, lifetime: "temporary", resumePolicy: "restartable" },
      { name: "plain-adhoc", kind: "agent", running: false, lifetime: "temporary", resumePolicy: "collected" },
    ];
    // BOTH carry a resume block, so both are "resumable" — that set cannot tell them apart.
    const targets = buildDistillTargets(rows, ["claude-fork-1", "plain-adhoc"]);

    expect(targets.map((t) => t.name)).toEqual(["claude-fork-1"]);
    expect(targets[0]).toMatchObject({
      state: "resumable",
      lifetime: "temporary",
      resumePolicy: "restartable",
      description: "resumable · temporary",
    });
  });

  it("omits dead/stopping panes from the running tier", () => {
    const targets = buildDistillTargets(
      [
        { name: "a", kind: "agent", running: true, dead: true, lifetime: "saved", resumePolicy: "restartable" },
        { name: "b", kind: "agent", running: true, stopping: true, lifetime: "saved", resumePolicy: "restartable" },
        { name: "c", kind: "agent", running: true, lifetime: "saved", resumePolicy: "restartable" },
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
