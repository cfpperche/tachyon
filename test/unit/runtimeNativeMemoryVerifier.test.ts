import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSandboxed,
  promoteEvidence,
  synthesizeMarker,
  verifyNativeMemory,
  type InspectionRequest,
  type InspectionResult,
  type VerificationEffects,
} from "../../src/runtime/nativeMemoryVerifier.js";
import { MEMORY_EVIDENCE_AXES, nativeMemoryCapability } from "../../src/runtime/nativeMemory.js";

/**
 * t-56daa1 — the behavioral verifier, which is the only thing allowed to mint `verified`.
 *
 * Every branch is exercised through injected effects, so the suite proves what the verifier does
 * WITHOUT installing a runtime, spending a token, or going near a real memory store — the same three
 * constraints the verifier itself enforces.
 *
 * The two refusals matter most, and both come from measured failures rather than caution: it never
 * calls a model on its own, and it discards a run whose effective model is missing or different from
 * the one requested (probe-42744006 was requested as Opus 5, executed Haiku 4.5, and its output had
 * to be thrown away).
 */
const MARKER = synthesizeMarker("test");
const MODEL = "claude-opus-5";

interface FakeOptions {
  /** prompt text per (enabled, lifecycle) — defaults to "the marker appears iff memory is enabled" */
  promptFor?: (request: InspectionRequest) => string;
  effectiveModel?: string | undefined;
  bound?: InspectionResult["injectedBound"];
  turnModel?: string | undefined;
  storeChangesAfterTurn?: boolean;
  withModelTurn?: boolean;
  onMkdtemp?: (dir: string) => void;
}

function fakeEffects(options: FakeOptions = {}): { effects: VerificationEffects; removed: string[]; planted: string[] } {
  const removed: string[] = [];
  const planted: string[] = [];
  let store = "initial-store-contents";
  const effects: VerificationEffects = {
    mkdtemp: (prefix) => {
      const dir = path.join("/tmp", `${prefix}fixed`);
      options.onMkdtemp?.(dir);
      return dir;
    },
    rm: (dir) => removed.push(dir),
    plantMarker: (storePath, marker) => planted.push(`${storePath}:${marker}`),
    readStore: () => store,
    inspect: (request) => ({
      promptText: options.promptFor
        ? options.promptFor(request)
        : request.memoryEnabled
          ? `system prompt … ${MARKER} … end`
          : "system prompt … end",
      ...(options.bound ? { injectedBound: options.bound } : {}),
      ...("effectiveModel" in options ? { effectiveModel: options.effectiveModel } : { effectiveModel: MODEL }),
    }),
    ...(options.withModelTurn === false
      ? {}
      : {
        runModelTurn: (request) => {
          if (options.storeChangesAfterTurn) store = `${store} +${MARKER}`;
          return {
            promptText: request.prompt,
            effectiveModel: "turnModel" in options ? options.turnModel : request.requestedModel,
            storeAfter: store,
          };
        },
      }),
  };
  return { effects, removed, planted };
}

const request = (over: Record<string, unknown> = {}) => ({
  adapter: "claude",
  runtimeVersion: "2.1.220",
  requestedModel: MODEL,
  lifecycle: [] as never[],
  marker: MARKER,
  ...over,
});

describe("it never spends money on its own", () => {
  it("stops at needs-authorization when a model turn is required and none was granted", () => {
    // Everything up to mutation is answerable by inspection; mutation is not, and the verifier says
    // so instead of quietly billing whoever ran it.
    const { effects, removed } = fakeEffects();
    const outcome = verifyNativeMemory(request(), effects);
    expect(outcome.status).toBe("needs-authorization");
    if (outcome.status !== "needs-authorization") throw new Error("unreachable");
    expect(outcome.reason).toContain("needs one authorized model call");
    // …and it still cleaned up: an unanswered question leaves no sandbox behind.
    expect(outcome.cleanedUp).toBe(true);
    expect(removed).toHaveLength(1);
  });

  it("does not reach the turn effect at all without authorization", () => {
    let called = false;
    const { effects } = fakeEffects();
    const outcome = verifyNativeMemory(request(), { ...effects, runModelTurn: (r) => { called = true; return { promptText: "", effectiveModel: r.requestedModel, storeAfter: "" }; } });
    expect(outcome.status).toBe("needs-authorization");
    expect(called, "the turn effect must be unreachable without authorization").toBe(false);
  });

  it("reports needs-authorization when authorized but no turn effect is wired", () => {
    const { effects } = fakeEffects({ withModelTurn: false });
    const outcome = verifyNativeMemory(
      request({ authorization: { grantedBy: "human", reason: "one-off verification" } }),
      effects,
    );
    expect(outcome.status).toBe("needs-authorization");
    if (outcome.status !== "needs-authorization") throw new Error("unreachable");
    expect(outcome.reason).toContain("no model-turn effect was wired");
  });
});

describe("it discards a run it cannot attribute", () => {
  it("fails when no effective model is reported", () => {
    const { effects } = fakeEffects({ effectiveModel: undefined });
    const outcome = verifyNativeMemory(request(), effects);
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.reason).toContain("has verified nothing");
  });

  it("fails when a DIFFERENT model answered — the discarded-probe lesson", () => {
    const { effects } = fakeEffects({ effectiveModel: "claude-haiku-4-5" });
    const outcome = verifyNativeMemory(request(), effects);
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.reason).toContain("claude-haiku-4-5 answered");
    expect(outcome.reason).toContain("probe-42744006");
  });

  it("fails when the AUTHORIZED turn is answered by a different model", () => {
    // Provenance is checked again at the turn: the inspection path and the billable path can resolve
    // models differently, and only one of them was authorized.
    const { effects } = fakeEffects({ turnModel: "claude-haiku-4-5" });
    const outcome = verifyNativeMemory(
      request({ authorization: { grantedBy: "human", reason: "verify mutation" } }),
      effects,
    );
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.reason).toContain("authorized turn requested");
  });
});

describe("it observes the axes rather than asserting them", () => {
  it("fails when a disabled runtime still injects the marker", () => {
    // The finding the research predicted: a disable control that stops nothing. Authoring the setting
    // succeeded; the behavior did not change.
    const { effects } = fakeEffects({ promptFor: () => `system … ${MARKER} …` });
    const outcome = verifyNativeMemory(request(), effects);
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.reason).toContain("disable did not stop injection");
    expect(outcome.observations.find((o) => o.axis === "disable")?.evidence).toBe("declared");
  });

  it("fails when an enabled runtime injects nothing — enable is not observable that way", () => {
    const { effects } = fakeEffects({ promptFor: () => "system … end" });
    const outcome = verifyNativeMemory(request(), effects);
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.reason).toContain("no observable injection");
  });

  it("leaves injection short of verified when the runtime declares no bound", () => {
    // "It injects" is weaker than "it injects at most N", and runtime-managed depends on the bound.
    const { effects } = fakeEffects();
    const outcome = verifyNativeMemory(
      request({ authorization: { grantedBy: "human", reason: "verify" } }),
      effects,
    );
    expect(outcome.status).toBe("verified");
    if (outcome.status !== "verified") throw new Error("unreachable");
    expect(outcome.observations.find((o) => o.axis === "injection")?.evidence).toBe("declared");
  });

  it("verifies injection when the bound is reported, and records it", () => {
    const { effects } = fakeEffects({ bound: { kind: "lines", value: 200 } });
    const outcome = verifyNativeMemory(
      request({ authorization: { grantedBy: "human", reason: "verify" } }),
      effects,
    );
    expect(outcome.status).toBe("verified");
    if (outcome.status !== "verified") throw new Error("unreachable");
    const injection = outcome.observations.find((o) => o.axis === "injection")!;
    expect(injection.evidence).toBe("verified");
    expect(injection.note).toContain("200 lines");
  });

  it("says which way the mutation went, rather than only that it looked", () => {
    const quiet = verifyNativeMemory(
      request({ authorization: { grantedBy: "human", reason: "verify" } }),
      fakeEffects().effects,
    );
    if (quiet.status !== "verified") throw new Error("unreachable");
    expect(quiet.observations.find((o) => o.axis === "mutation")?.note).toContain("no background write observed");

    const writes = verifyNativeMemory(
      request({ authorization: { grantedBy: "human", reason: "verify" } }),
      fakeEffects({ storeChangesAfterTurn: true }).effects,
    );
    if (writes.status !== "verified") throw new Error("unreachable");
    expect(writes.observations.find((o) => o.axis === "mutation")?.note).toContain("writes memory unprompted");
  });

  it("records only the lifecycle operations it actually exercised", () => {
    const { effects } = fakeEffects({
      // fork loses the store; restart keeps it.
      promptFor: (r) => (r.memoryEnabled && r.lifecycle !== "fork" ? `… ${MARKER} …` : "…"),
    });
    const outcome = verifyNativeMemory(
      request({ lifecycle: ["restart", "fork"], authorization: { grantedBy: "human", reason: "verify" } }),
      effects,
    );
    if (outcome.status !== "verified") throw new Error("unreachable");
    expect(outcome.lifecycle.restart).toContain("survived");
    expect(outcome.lifecycle.fork).toContain("did not survive");
    // An operation nobody ran stays absent instead of defaulting to something plausible.
    expect(outcome.lifecycle.resume).toBeUndefined();
  });
});

describe("it never touches real memory, and always cleans up", () => {
  it("refuses any path outside its sandbox", () => {
    expect(() => assertSandboxed("/tmp/sandbox", "/home/someone/.claude")).toThrow(/never read or mutate real memory/);
    expect(() => assertSandboxed("/tmp/sandbox", "/tmp/sandbox-evil/store")).toThrow(/outside its sandbox/);
    expect(() => assertSandboxed("/tmp/sandbox", "/tmp/sandbox/home/memory")).not.toThrow();
  });

  it("plants the marker only inside the sandbox store", () => {
    const { effects, planted } = fakeEffects();
    verifyNativeMemory(request(), effects);
    expect(planted).toHaveLength(1);
    expect(planted[0].startsWith("/tmp/tachyon-memory-claude-fixed/home/memory:")).toBe(true);
  });

  it("removes the sandbox even when a step throws", () => {
    const { effects, removed } = fakeEffects();
    const outcome = verifyNativeMemory(request(), {
      ...effects,
      inspect: () => { throw new Error("runtime not installed"); },
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.cleanedUp).toBe(true);
    expect(removed).toEqual(["/tmp/tachyon-memory-claude-fixed"]);
  });

  it("reports cleanup as an outcome rather than assuming it", () => {
    const { effects } = fakeEffects();
    const outcome = verifyNativeMemory(
      request({ authorization: { grantedBy: "human", reason: "verify" } }),
      effects,
    );
    expect(outcome.cleanedUp).toBe(true);
  });
});

describe("promotion is the only path from observed to verified", () => {
  it("upgrades exactly the axes a successful run observed", () => {
    const before = Object.fromEntries(MEMORY_EVIDENCE_AXES.map((axis) => [axis, "declared" as const])) as Record<
      (typeof MEMORY_EVIDENCE_AXES)[number],
      "declared"
    >;
    const outcome = verifyNativeMemory(
      request({ authorization: { grantedBy: "human", reason: "verify" }, }),
      fakeEffects({ bound: { kind: "lines", value: 200 } }).effects,
    );
    const after = promoteEvidence(before, outcome);
    expect(after.disable).toBe("verified");
    expect(after.enable).toBe("verified");
    expect(after.injection).toBe("verified");
    expect(after.mutation).toBe("verified");
    expect(after.isolation).toBe("verified");
  });

  it("promotes nothing from a failed or unauthorized run", () => {
    const before = Object.fromEntries(MEMORY_EVIDENCE_AXES.map((axis) => [axis, "declared" as const])) as Record<
      (typeof MEMORY_EVIDENCE_AXES)[number],
      "declared"
    >;
    for (const outcome of [
      verifyNativeMemory(request(), fakeEffects().effects), // needs-authorization
      verifyNativeMemory(request(), fakeEffects({ effectiveModel: undefined }).effects), // failed
    ]) {
      expect(promoteEvidence(before, outcome)).toEqual(before);
    }
  });

  it("leaves an axis the run did not observe exactly where it was", () => {
    // The registry's `inventory` for Claude is `declared`; a run that only observed disable/enable
    // must not make the rest look measured.
    const claude = nativeMemoryCapability("claude")!;
    const partial = verifyNativeMemory(request(), fakeEffects().effects);
    expect(promoteEvidence(claude.evidence, partial)).toEqual(claude.evidence);
  });
});
