import { describe, it, expect } from "vitest";
import { modelFromCommand, toAgentVM, statusOf, resolveModelFact, declaredModelFromCommand, validatedObservedModelId, type AgentRaw, type ObservedModelInput } from "../../src/sidebar/agentModel";

const raw = (o: Partial<AgentRaw> & { name: string }): AgentRaw => ({ running: false, dead: false, crashed: false, ...o });

describe("agentModel.statusOf (spec 237)", () => {
  it("crashed = dead + non-zero", () => expect(statusOf(raw({ name: "a", dead: true, crashed: true }))).toBe("crashed"));
  it("clean exit = dead + not crashed → stopped", () => expect(statusOf(raw({ name: "a", dead: true }))).toBe("stopped"));
  it("not running, not dead → stopped", () => expect(statusOf(raw({ name: "a" }))).toBe("stopped"));
  it("stopping beats running attention until stop resolves", () => expect(statusOf(raw({ name: "a", running: true, stopping: true }), "needs-input")).toBe("stopping"));
  it("stop failure stays running-like but visible after graceful stop times out", () => expect(statusOf(raw({ name: "a", running: true, stopFailed: true }), "needs-input")).toBe("stop-failed"));
  it("running + needs-input → needs", () => expect(statusOf(raw({ name: "a", running: true }), "needs-input")).toBe("needs"));
  it("running + throttled → throttled (spec 306)", () => expect(statusOf(raw({ name: "a", running: true }), "throttled")).toBe("throttled"));
  it("running + idle → idle", () => expect(statusOf(raw({ name: "a", running: true }), "idle")).toBe("idle"));
  it("running + idle + unseen → done (t-a39c7d)", () => expect(statusOf(raw({ name: "a", running: true }), "idle", true)).toBe("done"));
  it("running + working/unknown → running", () => {
    expect(statusOf(raw({ name: "a", running: true }), "working")).toBe("running");
    expect(statusOf(raw({ name: "a", running: true }))).toBe("running");
  });
});

describe("agentModel.toAgentVM (spec 237)", () => {
  it("maps attention label + drops idle/undefined", () => {
    expect(toAgentVM(raw({ name: "a", running: true }), { attention: "needs-input" })).toMatchObject({ status: "needs", attention: "needs input" });
    expect(toAgentVM(raw({ name: "a", running: true }), { attention: "throttled" })).toMatchObject({ status: "throttled", attention: "throttled" });
    // spec 390 — live-dot covers "working"; do not surface it as an attention badge
    expect(toAgentVM(raw({ name: "a", running: true }), { attention: "working" })).toMatchObject({ status: "running" });
    expect(toAgentVM(raw({ name: "a", running: true }), { attention: "working" }).attention).toBeUndefined();
    expect(toAgentVM(raw({ name: "a", running: true }), { attention: "idle" }).attention).toBeUndefined();
  });
  it("idle + unseen → status done + attention badge (t-a39c7d)", () => {
    expect(toAgentVM(raw({ name: "a", running: true }), { attention: "idle", unseen: true })).toMatchObject({
      status: "done",
      attention: "done",
    });
  });
  it("exit sub: clean vs crashed (with exit code)", () => {
    expect(toAgentVM(raw({ name: "a", dead: true })).sub).toBe("exited (0)");
    expect(toAgentVM(raw({ name: "a", dead: true, crashed: true, exitCode: 137 })).sub).toBe("exited (137)");
    expect(toAgentVM(raw({ name: "a", running: true })).sub).toBeUndefined();
  });
  it("stopping exposes a transient sublabel", () => {
    expect(toAgentVM(raw({ name: "a", running: true, stopping: true }))).toMatchObject({ status: "stopping", sub: "stopping..." });
  });
  it("stop failure exposes a visible sublabel", () => {
    expect(toAgentVM(raw({ name: "a", running: true, stopFailed: true }))).toMatchObject({ status: "stop-failed", sub: "stop failed" });
  });
  it("clean-exit auto-cleared rows keep exited metadata but no pane", () => {
    expect(toAgentVM(raw({ name: "a", cleanExited: true }))).toMatchObject({ status: "stopped", sub: "exited (0)", exited: true, pane: false });
  });
  it("t-35d95a: passes through the awaitingHuman latch as its own badge, independent of attention", () => {
    const vm = toAgentVM(raw({ name: "a", running: true }), { attention: "idle", awaitingHuman: { reason: "design question" } });
    expect(vm.attention).toBeUndefined(); // idle attention still drops
    expect(vm.awaitingHuman).toEqual({ reason: "design question" });
  });
  it("t-35d95a: does not expose a stale awaitingHuman latch on stopped, dead, or clean-exited rows", () => {
    expect(toAgentVM(raw({ name: "stopped" }), { awaitingHuman: { reason: "x" } }).awaitingHuman).toBeUndefined();
    expect(toAgentVM(raw({ name: "dead", dead: true }), { awaitingHuman: { reason: "x" } }).awaitingHuman).toBeUndefined();
    expect(toAgentVM(raw({ name: "clean", cleanExited: true }), { awaitingHuman: { reason: "x" } }).awaitingHuman).toBeUndefined();
  });
  it("does not expose stale attention on stopped, dead, or clean-exited rows", () => {
    expect(toAgentVM(raw({ name: "stopped" }), { attention: "working" })).toMatchObject({ status: "stopped" });
    expect(toAgentVM(raw({ name: "dead", dead: true }), { attention: "working" })).toMatchObject({ status: "stopped", sub: "exited (0)" });
    expect(toAgentVM(raw({ name: "clean", cleanExited: true }), { attention: "working" })).toMatchObject({ status: "stopped", sub: "exited (0)" });
    expect(toAgentVM(raw({ name: "stopped" }), { attention: "working" }).attention).toBeUndefined();
    expect(toAgentVM(raw({ name: "dead", dead: true }), { attention: "working" }).attention).toBeUndefined();
    expect(toAgentVM(raw({ name: "clean", cleanExited: true }), { attention: "working" }).attention).toBeUndefined();
  });
  it("passes through dismiss capability for stopped ad-hoc postmortem rows", () => {
    expect(toAgentVM(raw({ name: "a", cleanExited: true }), { canDismiss: true })).toMatchObject({ canDismiss: true });
  });
  it("passes through parent + capability badges", () => {
    const vm = toAgentVM(raw({ name: "child", running: true, parent: "orch" }), { worktree: "tachyon/x", harness: true, forked: true, forkable: true, resumable: false });
    expect(vm).toMatchObject({ name: "child", parent: "orch", worktree: "tachyon/x", harness: true, forked: true, forkable: true });
    expect(vm.resumable).toBeUndefined(); // false flags are omitted, not set
  });
  it("spec 386: maps resources sample", () => {
    const vm = toAgentVM(raw({ name: "r", running: true }), { resources: { cpuPct: 10, memMb: 99 } });
    expect(vm.resources).toEqual({ cpuPct: 10, memMb: 99 });
  });
  it("spec 384: maps live branch, path, and drift (false flags omitted)", () => {
    const aligned = toAgentVM(raw({ name: "wt", running: true }), {
      worktree: "tachyon/wt",
      liveBranch: "tachyon/wt",
      worktreePath: "/cache/wt",
    });
    expect(aligned).toMatchObject({ worktree: "tachyon/wt", liveBranch: "tachyon/wt", worktreePath: "/cache/wt" });
    expect(aligned.branchDrift).toBeUndefined();
    const drifted = toAgentVM(raw({ name: "wt2", running: true }), {
      worktree: "tachyon/wt2",
      liveBranch: "feat/x",
      branchDrift: true,
      worktreePath: "/cache/wt2",
    });
    expect(drifted).toMatchObject({ liveBranch: "feat/x", branchDrift: true, worktree: "tachyon/wt2" });
    const shared = toAgentVM(raw({ name: "shared", running: true }), {
      liveBranch: "main",
      worktreePath: "/ws",
    });
    expect(shared).toMatchObject({ liveBranch: "main", worktreePath: "/ws" });
    expect(shared.worktree).toBeUndefined();
  });
  it("spec 352 — passes through declaredOwner without replacing runtime parent", () => {
    const vm = toAgentVM(raw({ name: "reviewer", running: true, parent: "codex", declaredOwner: "claude" }));
    expect(vm).toMatchObject({ name: "reviewer", parent: "codex", declaredOwner: "claude" });
  });
  it("spec 362 — passes through gated delegation requester without replacing runtime parent", () => {
    const vm = toAgentVM(raw({ name: "reviewer", running: true, delegator: "codex", declaredOwner: "claude" }));
    expect(vm).toMatchObject({ name: "reviewer", delegator: "codex", declaredOwner: "claude" });
    expect(vm.parent).toBeUndefined();
  });
  it("spec 316: passes through persistence hook health", () => {
    const vm = toAgentVM(raw({ name: "claude", running: true }), {
      persistenceHooks: { state: "failed", reason: "syntax-error", path: "/ws/.tachyon/activity/persistence-hooks-failures.jsonl", updatedAt: "2026-07-01T00:00:00Z" },
    });
    expect(vm.persistenceHooks).toMatchObject({ state: "failed", reason: "syntax-error" });
  });
  it("t-140242: exposes the active model parsed from --model", () => {
    expect(toAgentVM(raw({ name: "claude", running: true, cmd: "claude --model opus-4.8" }), { ai: true })).toMatchObject({ model: "Opus 4.8" });
    expect(toAgentVM(raw({ name: "claude-2", running: true, cmd: "claude --model='sonnet-5'" }), { ai: true })).toMatchObject({ model: "Sonnet 5" });
  });
  it("t-140242: falls back to the runtime default model when no --model flag is present", () => {
    expect(toAgentVM(raw({ name: "claude", running: true, cmd: "claude" }), { ai: true })).toMatchObject({ model: "Claude default" });
    expect(toAgentVM(raw({ name: "codex", running: true, cmd: "codex --yolo" }), { ai: true })).toMatchObject({ model: "Codex default" });
    expect(toAgentVM(raw({ name: "grok", running: true, cmd: "grok" }), { ai: true })).toMatchObject({ model: "Grok default" });
  });
  it("t-140242: suppresses model labels for terminal rows", () => {
    expect(toAgentVM(raw({ name: "probe", running: true, cmd: "claude --model opus-4.8" }), { ai: false }).model).toBeUndefined();
  });
});

describe("agentModel.modelFromCommand (t-140242)", () => {
  it("parses split, equals, and quoted --model values", () => {
    expect(modelFromCommand("claude --model opus")).toBe("Opus");
    expect(modelFromCommand("codex --model=gpt-5.1-codex")).toBe("GPT-5.1 Codex");
    expect(modelFromCommand("env FOO=1 claude --model \"Opus 4.8\"")).toBe("Opus 4.8");
  });
  it("uses runtime defaults only for known runtimes", () => {
    expect(modelFromCommand("claude --permission-mode plan")).toBe("Claude default");
    expect(modelFromCommand("grok")).toBe("Grok default");
    expect(modelFromCommand("npm run dev")).toBeUndefined();
    expect(modelFromCommand(undefined)).toBeUndefined();
  });
  it("t-14649d: parses Grok model flags", () => {
    expect(modelFromCommand("grok --model grok-4")).toBe("Grok 4");
    expect(modelFromCommand("grok -m grok-4-fast")).toBe("Grok 4 Fast");
  });
  it("t-140a24: parses Codex -c model=<id> fleet overrides (Terra/Luna/Sol)", () => {
    expect(modelFromCommand("codex -c model=gpt-5.6-terra -c model_reasoning_effort=medium")).toBe("GPT-5.6 Terra");
    expect(modelFromCommand("codex -c model=gpt-5.6-luna -c model_reasoning_effort=low")).toBe("GPT-5.6 Luna");
    expect(modelFromCommand("codex -c model=gpt-5.6-sol -c model_reasoning_effort=xhigh")).toBe("GPT-5.6 Sol");
    expect(modelFromCommand("codex -c model='gpt-5.6-terra'")).toBe("GPT-5.6 Terra");
    expect(modelFromCommand("codex -c \"model=gpt-5.6-luna\"")).toBe("GPT-5.6 Luna");
  });
  it("t-140a24: -c model= does not steal non-model overrides or bare default", () => {
    expect(modelFromCommand("codex -c model_reasoning_effort=medium")).toBe("Codex default");
    expect(modelFromCommand("codex --yolo")).toBe("Codex default");
    // non-model -c then model later still works
    expect(modelFromCommand("codex -c model_reasoning_effort=low -c model=gpt-5.6-luna")).toBe("GPT-5.6 Luna");
  });
  it("t-140a24: --model still wins when it appears before -c model=", () => {
    expect(modelFromCommand("codex --model gpt-5.1-codex -c model=gpt-5.6-terra")).toBe("GPT-5.1 Codex");
  });
  it("t-140a24: toAgentVM surfaces Terra/Luna for declared fleet cmds", () => {
    expect(
      toAgentVM(raw({ name: "codex-executor", running: true, cmd: "codex -c model=gpt-5.6-terra -c model_reasoning_effort=medium" }), { ai: true }),
    ).toMatchObject({ model: "GPT-5.6 Terra" });
    expect(
      toAgentVM(raw({ name: "codex-mechanical", running: true, cmd: "codex -c model=gpt-5.6-luna -c model_reasoning_effort=low" }), { ai: true }),
    ).toMatchObject({ model: "GPT-5.6 Luna" });
  });
});

describe("agentModel.declaredModelFromCommand (spec 378)", () => {
  it("reports explicit:true + the raw id for --model/-m/-c model=", () => {
    expect(declaredModelFromCommand("claude --model opus")).toEqual({ id: "opus", explicit: true });
    expect(declaredModelFromCommand("codex -c model=gpt-5.6-terra")).toEqual({ id: "gpt-5.6-terra", explicit: true });
  });
  it("reports explicit:false for a bare runtime (profile default)", () => {
    expect(declaredModelFromCommand("codex --yolo")).toEqual({ explicit: false });
    expect(declaredModelFromCommand(undefined)).toEqual({ explicit: false });
  });
});

describe("agentModel.validatedObservedModelId (spec 378 — charset/length gate)", () => {
  it("accepts ids within the allowlisted charset and length", () => {
    expect(validatedObservedModelId("gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(validatedObservedModelId("anthropic/claude-sonnet-5")).toBe("anthropic/claude-sonnet-5");
    expect(validatedObservedModelId("  grok-4.5  ")).toBe("grok-4.5"); // trims
  });
  it("rejects empty/undefined and oversized ids", () => {
    expect(validatedObservedModelId(undefined)).toBeUndefined();
    expect(validatedObservedModelId("")).toBeUndefined();
    expect(validatedObservedModelId("x".repeat(65))).toBeUndefined();
  });
  it("rejects a control-character/injection-shaped id (not a validated transcript-owned id)", () => {
    expect(validatedObservedModelId("<script>alert(1)</script>")).toBeUndefined();
    expect(validatedObservedModelId("gpt-5\n; rm -rf")).toBeUndefined();
  });
});

describe("agentModel.resolveModelFact (spec 378 — precedence/divergence/label policy)", () => {
  const observed = (id: string, extra: Partial<ObservedModelInput> = {}): ObservedModelInput => ({ id, stale: false, ...extra });

  it("pre-first-turn honesty: no observation yet → declared label, source declared/profile, never a fake observed", () => {
    expect(resolveModelFact("claude --model opus")).toMatchObject({ label: "Opus", source: "declared", stale: false, divergence: false });
    expect(resolveModelFact("codex")).toMatchObject({ label: "Codex default", source: "profile", stale: false, divergence: false });
  });

  it("an observation present → observed wins over declared/profile", () => {
    const fact = resolveModelFact("codex", observed("gpt-5.6-sol"));
    expect(fact).toMatchObject({ label: "GPT-5.6 Sol", source: "observed", stale: false, divergence: true });
  });

  it("divergence is true only when normalized observed != normalized declared", () => {
    const same = resolveModelFact("claude --model opus", observed("opus"));
    expect(same?.divergence).toBe(false);
    const different = resolveModelFact("claude --model opus", observed("sonnet-5"));
    expect(different?.divergence).toBe(true);
  });

  it("bare codex declared (\"Codex default\") vs an observed gpt-5.6-sol is the motivating divergence case", () => {
    const fact = resolveModelFact("codex", observed("gpt-5.6-sol"));
    expect(fact?.label).toBe("GPT-5.6 Sol");
    expect(fact?.divergence).toBe(true);
  });

  it("an observed id missing from the alias table renders as a validated raw/title-cased id, never 'Unavailable'", () => {
    const fact = resolveModelFact("codex", observed("this-model-definitely-does-not-exist-xyz123"));
    expect(fact?.label).toBe("This Model Definitely Does Not Exist Xyz123");
    expect(fact?.source).toBe("observed");
  });

  it("an invalid (unvalidated) observed id falls back to declared/profile instead of throwing or rendering garbage", () => {
    const fact = resolveModelFact("codex", observed("<script>bad</script>"));
    expect(fact).toMatchObject({ label: "Codex default", source: "profile" });
  });

  it("carries observedAt and stale through", () => {
    const fact = resolveModelFact("codex", observed("gpt-5.6-sol", { observedAt: "2026-07-13T00:00:00Z", stale: true }));
    expect(fact).toMatchObject({ observedAt: "2026-07-13T00:00:00Z", stale: true });
  });

  it("an unrecognized/non-AI command yields no fact at all", () => {
    expect(resolveModelFact("npm run dev")).toBeUndefined();
    expect(resolveModelFact(undefined)).toBeUndefined();
  });
});

describe("agentModel.toAgentVM — model provenance siblings (spec 378)", () => {
  it("surfaces modelSource/modelObservedAt on an observed row, and omits modelStale/modelDivergence when false", () => {
    const vm = toAgentVM(raw({ name: "codex", running: true, cmd: "codex" }), {
      ai: true,
      model: { id: "gpt-5.6-sol", observedAt: "2026-07-13T00:00:00Z", stale: false },
    });
    expect(vm).toMatchObject({ model: "GPT-5.6 Sol", modelSource: "observed", modelObservedAt: "2026-07-13T00:00:00Z", modelDivergence: true });
    expect(vm.modelStale).toBeUndefined();
  });

  it("surfaces modelStale:true only when the observation is stale", () => {
    const vm = toAgentVM(raw({ name: "codex", running: true, cmd: "codex -c model=gpt-5.6-sol" }), {
      ai: true,
      model: { id: "gpt-5.6-sol", stale: true },
    });
    expect(vm).toMatchObject({ modelSource: "observed", modelStale: true });
    expect(vm.modelDivergence).toBeUndefined(); // declared and observed agree — no divergence badge
  });

  it("no observation yet → modelSource is declared/profile, no modelObservedAt/modelStale/modelDivergence", () => {
    const vm = toAgentVM(raw({ name: "codex", running: true, cmd: "codex" }), { ai: true });
    expect(vm).toMatchObject({ model: "Codex default", modelSource: "profile" });
    expect(vm.modelObservedAt).toBeUndefined();
    expect(vm.modelStale).toBeUndefined();
    expect(vm.modelDivergence).toBeUndefined();
  });

  it("terminal rows (ai:false) suppress the observed model input entirely", () => {
    const vm = toAgentVM(raw({ name: "probe", running: true, cmd: "codex" }), { ai: false, model: { id: "gpt-5.6-sol", stale: false } });
    expect(vm.model).toBeUndefined();
    expect(vm.modelSource).toBeUndefined();
  });
});
