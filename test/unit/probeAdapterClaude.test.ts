import { describe, it, expect } from "vitest";
import { createClaudeAdapter, extractClaudeResult } from "../../src/probe/adapters/claude.js";
import type { RawOutcome } from "../../src/probe/adapters/types.js";

const adapter = createClaudeAdapter({ versionProbe: async () => "1.2.3 (test)" });

function raw(stdout: string, exitCode = 0, stderr = ""): RawOutcome {
  return { stdout, stderr, exitCode, signal: null, timedOut: false };
}

const success = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "THE ANSWER", total_cost_usd: 0.012 });
const budget = JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, result: "", errors: ["Reached maximum budget ($0.50)"], total_cost_usd: 0.52 });
const refusal = JSON.stringify({ type: "result", subtype: "error_refusal", is_error: true, result: "I can't help with that." });
const empty = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "  ", total_cost_usd: 0.001 });

describe("claude adapter — interpret maps native subtype → taxonomy (D4)", () => {
  it("success → ok, with cost, text from result", () => {
    const r = adapter.interpret(raw(success), { runtime: "claude", prompt: "", cwd: "/x", timeoutMs: 1 });
    expect(r.reason).toBe("ok");
    expect(r.lastMessage).toBe("THE ANSWER");
    expect(r.costUsd).toBe(0.012);
    expect(r.native.subtype).toBe("success"); // claude-shaped field quarantined under native
  });

  it("budget exhaustion → budget (a result, not a crash), error text lifted", () => {
    const r = adapter.interpret(raw(budget, 1), { runtime: "claude", prompt: "", cwd: "/x", timeoutMs: 1 });
    expect(r.reason).toBe("budget");
    expect(r.lastMessage).toContain("Reached maximum budget");
    expect(r.costUsd).toBe(0.52);
  });

  it("refusal subtype → refused", () => {
    const r = adapter.interpret(raw(refusal), { runtime: "claude", prompt: "", cwd: "/x", timeoutMs: 1 });
    expect(r.reason).toBe("refused");
    expect(r.lastMessage).toBe("I can't help with that.");
  });

  it("blank result → empty_output", () => {
    const r = adapter.interpret(raw(empty), { runtime: "claude", prompt: "", cwd: "/x", timeoutMs: 1 });
    expect(r.reason).toBe("empty_output");
  });
});

describe("claude adapter — noise + malformed output (golden fixtures, D5)", () => {
  it("extracts the result JSON despite leading login/update noise on stdout", () => {
    const noisy = `Logged in as user@example.com\nnpm notice new version available\n${success}\n`;
    const r = adapter.interpret(raw(noisy), { runtime: "claude", prompt: "", cwd: "/x", timeoutMs: 1 });
    expect(r.reason).toBe("ok");
    expect(r.lastMessage).toBe("THE ANSWER");
  });

  it("no parseable JSON + exit 0 → parse_error", () => {
    const r = adapter.interpret(raw("not json at all", 0), { runtime: "claude", prompt: "", cwd: "/x", timeoutMs: 1 });
    expect(r.reason).toBe("parse_error");
  });

  it("no parseable JSON + nonzero exit → process_error", () => {
    const r = adapter.interpret(raw("", 1, "command failed"), { runtime: "claude", prompt: "", cwd: "/x", timeoutMs: 1 });
    expect(r.reason).toBe("process_error");
    expect(r.lastMessage).toBe("command failed");
  });

  it("extractClaudeResult returns null for genuinely non-JSON output", () => {
    expect(extractClaudeResult("hello world")).toBeNull();
  });
});

describe("claude adapter — invocation + capability (D5)", () => {
  it("buildInvocation pins flags: -p, --output-format json, budget, model, no tools, permission-mode", () => {
    const inv = adapter.buildInvocation({ runtime: "claude", prompt: "review this", model: "claude-opus-4-8", cwd: "/repo", timeoutMs: 1, budgetUsd: 2, sandbox: "read-only" }, "/scratch");
    expect(inv.cmd).toBe("claude");
    expect(inv.args).toEqual(expect.arrayContaining(["-p", "review this", "--output-format", "json", "--safe-mode", "--no-session-persistence", "--tools", "", "--max-budget-usd", "2", "--model", "claude-opus-4-8", "--permission-mode", "plan"]));
    expect(inv.cwd).toBe("/repo");
  });

  it("detectCapability reports available with version, or unavailable", async () => {
    expect(await adapter.detectCapability()).toEqual({ available: true, binaryVersion: "1.2.3 (test)" });
    const missing = createClaudeAdapter({ versionProbe: async () => null });
    expect((await missing.detectCapability()).available).toBe(false);
  });
});
