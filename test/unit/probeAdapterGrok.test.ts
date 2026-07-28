import { describe, it, expect } from "vitest";
import { createGrokAdapter, extractGrokResult } from "../../src/probe/adapters/grok.js";
import type { RawOutcome } from "../../src/probe/adapters/types.js";

const adapter = createGrokAdapter({ versionProbe: async () => "grok 0.2.111 (test)" });

function raw(stdout: string, exitCode = 0, stderr = ""): RawOutcome {
  return { stdout, stderr, exitCode, signal: null, timedOut: false };
}

const success = JSON.stringify({
  text: "THE ANSWER",
  stopReason: "EndTurn",
  sessionId: "abc",
  total_cost_usd: 0.012,
});
const empty = JSON.stringify({ text: "  ", stopReason: "EndTurn", sessionId: "abc" });
const refusal = JSON.stringify({
  text: "I can't help with that.",
  stopReason: "refusal",
  is_error: true,
  error: "I can't help with that.",
});
const modelErr = JSON.stringify({
  text: "",
  stopReason: "Error",
  error: { message: "model overloaded" },
  is_error: true,
});

describe("grok adapter — interpret maps headless JSON → taxonomy (D4)", () => {
  it("success → ok, with cost, text from result", () => {
    const r = adapter.interpret(raw(success), { runtime: "grok", prompt: "", cwd: "/x", timeoutMs: 1 });
    expect(r.reason).toBe("ok");
    expect(r.lastMessage).toBe("THE ANSWER");
    expect(r.costUsd).toBe(0.012);
    expect(r.native.stopReason).toBe("EndTurn");
    expect(r.native.sessionId).toBe("abc");
  });

  it("blank text → empty_output", () => {
    const r = adapter.interpret(raw(empty), { runtime: "grok", prompt: "", cwd: "/x", timeoutMs: 1 });
    expect(r.reason).toBe("empty_output");
  });

  it("refusal stopReason / is_error → refused", () => {
    const r = adapter.interpret(raw(refusal), { runtime: "grok", prompt: "", cwd: "/x", timeoutMs: 1 });
    expect(r.reason).toBe("refused");
    expect(r.lastMessage).toContain("can't help");
  });

  it("structured error → model_error", () => {
    const r = adapter.interpret(raw(modelErr, 1), { runtime: "grok", prompt: "", cwd: "/x", timeoutMs: 1 });
    expect(r.reason).toBe("model_error");
    expect(r.lastMessage).toContain("overloaded");
  });
});

describe("grok adapter — noise + malformed output (golden fixtures, D5)", () => {
  it("extracts the result JSON despite leading noise on stdout", () => {
    const noisy = `Logged in\nnpm notice\n${success}\n`;
    const r = adapter.interpret(raw(noisy), { runtime: "grok", prompt: "", cwd: "/x", timeoutMs: 1 });
    expect(r.reason).toBe("ok");
    expect(r.lastMessage).toBe("THE ANSWER");
  });

  it("no parseable JSON + exit 0 → parse_error", () => {
    const r = adapter.interpret(raw("not json at all", 0), { runtime: "grok", prompt: "", cwd: "/x", timeoutMs: 1 });
    expect(r.reason).toBe("parse_error");
  });

  it("no parseable JSON + nonzero exit → process_error", () => {
    const r = adapter.interpret(raw("", 1, "command failed"), { runtime: "grok", prompt: "", cwd: "/x", timeoutMs: 1 });
    expect(r.reason).toBe("process_error");
    expect(r.lastMessage).toBe("command failed");
  });

  it("extractGrokResult returns null for genuinely non-JSON output", () => {
    expect(extractGrokResult("hello world")).toBeNull();
  });
});

describe("grok adapter — invocation + capability (D5)", () => {
  it("buildInvocation pins flags: -p, --output-format json, no-memory, permission-mode, model", () => {
    const inv = adapter.buildInvocation(
      {
        runtime: "grok",
        prompt: "review this",
        model: "grok-4",
        cwd: "/repo",
        timeoutMs: 1,
        sandbox: "read-only",
      },
      "/scratch",
    );
    expect(inv.cmd).toBe("grok");
    expect(inv.args).toEqual(
      expect.arrayContaining([
        "-p",
        "review this",
        "--output-format",
        "json",
        "--no-memory",
        "--no-subagents",
        "--tools",
        "",
        "--permission-mode",
        "plan",
        "--model",
        "grok-4",
      ]),
    );
    expect(inv.cwd).toBe("/repo");
    // t-0e88f3 — the flag above is no longer sufficient on its own. `--no-memory` was MEASURED to
    // lose to an ambient GROK_MEMORY=1 in exactly this headless mode, so the probe pins the env var
    // too; ProbeRunner spreads it over process.env, which is where a hostile value would arrive.
    expect(inv.env).toEqual({ GROK_MEMORY: "0" });
  });

  it("workspace-write maps to acceptEdits permission-mode", () => {
    const inv = adapter.buildInvocation(
      { runtime: "grok", prompt: "x", cwd: "/repo", timeoutMs: 1, sandbox: "workspace-write" },
      "/scratch",
    );
    expect(inv.args).toEqual(expect.arrayContaining(["--permission-mode", "acceptEdits"]));
  });

  it("adds a native JSON schema for adversarial-review probes", () => {
    const inv = adapter.buildInvocation(
      { runtime: "grok", prompt: "review this", cwd: "/repo", timeoutMs: 1, archetype: "adversarial-review" },
      "/scratch",
    );
    const schemaArg = inv.args[inv.args.indexOf("--json-schema") + 1];
    expect(schemaArg).toBeTruthy();
    const schema = JSON.parse(schemaArg!) as { required?: string[]; properties?: Record<string, unknown> };
    expect(schema.required).toContain("findings");
    expect(schema.properties).toHaveProperty("findings");
  });

  it("adds a native JSON schema for factual-verify probes", () => {
    const inv = adapter.buildInvocation(
      { runtime: "grok", prompt: "verify this", cwd: "/repo", timeoutMs: 1, archetype: "factual-verify" },
      "/scratch",
    );
    const schemaArg = inv.args[inv.args.indexOf("--json-schema") + 1];
    expect(schemaArg).toBeTruthy();
    const schema = JSON.parse(schemaArg!) as { required?: string[]; properties?: Record<string, unknown> };
    expect(schema.required).toContain("claims");
  });

  it("does not add a JSON schema for freeform probes", () => {
    const inv = adapter.buildInvocation(
      { runtime: "grok", prompt: "answer freely", cwd: "/repo", timeoutMs: 1, archetype: "freeform" },
      "/scratch",
    );
    expect(inv.args).not.toContain("--json-schema");
  });

  it("detectCapability reports available with version, or unavailable", async () => {
    expect(await adapter.detectCapability()).toEqual({ available: true, binaryVersion: "grok 0.2.111 (test)" });
    const missing = createGrokAdapter({ versionProbe: async () => null });
    expect((await missing.detectCapability()).available).toBe(false);
  });
});

describe("SDD 474 — grok effective-model provenance", () => {
  /** The payload measured from `grok 0.2.112 -p … --output-format json`. */
  const measured = JSON.stringify({
    text: "ok",
    stopReason: "EndTurn",
    sessionId: "019fa002-72d6-7d80-b656-455df3429ac3",
    total_cost_usd: 0.0080068,
    modelUsage: {
      "grok-4.5-build": { inputTokens: 2240, outputTokens: 31, modelCalls: 1, costUSD: 0.0080068 },
    },
  });

  it("declares that this runtime can prove its effective model", () => {
    expect(adapter.reportsEffectiveModel).toBe(true);
  });

  it("reports the modelUsage key as the effective identifier", () => {
    const r = adapter.interpret(raw(measured), { runtime: "grok", prompt: "", cwd: "/x", timeoutMs: 1 });
    expect(r.reason).toBe("ok");
    expect(r.native.reportedNativeModels).toEqual(["grok-4.5-build"]);
  });

  it("reports every distinct identifier when more than one model ran", () => {
    const twoModels = JSON.stringify({
      text: "ok", stopReason: "EndTurn", sessionId: "s",
      modelUsage: { "grok-4.5-build": { modelCalls: 1 }, "grok-4-fast": { modelCalls: 2 } },
    });
    const r = adapter.interpret(raw(twoModels), { runtime: "grok", prompt: "", cwd: "/x", timeoutMs: 1 });
    // Sorted + de-duplicated; the service treats a mixed run as a mismatch, not a pass.
    expect(r.native.reportedNativeModels).toEqual(["grok-4-fast", "grok-4.5-build"]);
  });

  it("reports nothing rather than inferring when modelUsage is absent or unusable", () => {
    // absent → the probe service records `unproven`; it must never fall back to the requested model.
    const none = adapter.interpret(raw(success), { runtime: "grok", prompt: "", cwd: "/x", timeoutMs: 1 });
    expect(none.native.reportedNativeModels).toBeUndefined();

    for (const bad of [{ modelUsage: {} }, { modelUsage: [] }, { modelUsage: "grok-4.5" }, { modelUsage: null }]) {
      const payload = JSON.stringify({ text: "ok", stopReason: "EndTurn", sessionId: "s", ...bad });
      const r = adapter.interpret(raw(payload), { runtime: "grok", prompt: "", cwd: "/x", timeoutMs: 1 });
      expect(r.reason).toBe("ok");
      expect(r.native.reportedNativeModels).toBeUndefined();
    }
  });

  it("does not derive a canonical family by trimming the identifier", () => {
    const r = adapter.interpret(raw(measured), { runtime: "grok", prompt: "", cwd: "/x", timeoutMs: 1 });
    // Grok has no canonicalModel field; synthesising `grok-4.5` from `grok-4.5-build` would be
    // inference, which SDD 473 forbids.
    expect(r.native.reportedModels).toBeUndefined();
  });
});
