import { describe, it, expect } from "vitest";
import { createCodexAdapter } from "../../src/probe/adapters/codex.js";
import type { RawOutcome } from "../../src/probe/adapters/types.js";

const adapter = createCodexAdapter({ versionProbe: async () => "codex 0.142.0" });
const spec = { runtime: "codex", prompt: "review this", cwd: "/repo", timeoutMs: 1 };

function raw(opts: Partial<RawOutcome>): RawOutcome {
  return { stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false, ...opts };
}

describe("codex adapter — interpret reads the artifact, not stdout (D5)", () => {
  it("exit 0 + artifact text → ok (ignores noisy --json stdout)", () => {
    const r = adapter.interpret(raw({ exitCode: 0, stdout: '{"type":"event"}\n{"type":"event"}', resultArtifactText: "THE ANSWER" }), spec);
    expect(r.reason).toBe("ok");
    expect(r.lastMessage).toBe("THE ANSWER");
    expect(r.native.runtime).toBe("codex");
  });

  it("exit 0 + no artifact → empty_output", () => {
    const r = adapter.interpret(raw({ exitCode: 0, resultArtifactText: "" }), spec);
    expect(r.reason).toBe("empty_output");
  });

  it("nonzero + artifact content → model_error (codex answered then failed)", () => {
    const r = adapter.interpret(raw({ exitCode: 1, resultArtifactText: "partial reasoning…" }), spec);
    expect(r.reason).toBe("model_error");
    expect(r.lastMessage).toBe("partial reasoning…");
  });

  it("nonzero + no artifact → process_error with stderr", () => {
    const r = adapter.interpret(raw({ exitCode: 1, stderr: "sandbox denied" }), spec);
    expect(r.reason).toBe("process_error");
    expect(r.lastMessage).toBe("sandbox denied");
  });
});

describe("codex adapter — invocation + capability (D5)", () => {
  it("buildInvocation pins flags: exec, --output-last-message <file>, --json, ephemeral clean config, --sandbox, model, prompt last", () => {
    const inv = adapter.buildInvocation({ ...spec, model: "gpt-5-codex", sandbox: "read-only" }, "/scratch");
    expect(inv.cmd).toBe("codex");
    expect(inv.args[0]).toBe("exec");
    expect(inv.args).toEqual(expect.arrayContaining(["--output-last-message", inv.resultArtifact!, "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only", "--model", "gpt-5-codex"]));
    expect(inv.args[inv.args.length - 1]).toBe("review this"); // prompt is the trailing positional
    expect(inv.resultArtifact).toContain("/scratch");
  });

  it("workspace-write maps to the write sandbox", () => {
    const inv = adapter.buildInvocation({ ...spec, sandbox: "workspace-write" }, "/scratch");
    expect(inv.args).toEqual(expect.arrayContaining(["--sandbox", "workspace-write"]));
  });

  it("detectCapability reports available with version, or unavailable", async () => {
    expect(await adapter.detectCapability()).toEqual({ available: true, binaryVersion: "codex 0.142.0" });
    const missing = createCodexAdapter({ versionProbe: async () => null });
    expect((await missing.detectCapability()).available).toBe(false);
  });
});
