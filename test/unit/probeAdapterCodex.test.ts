import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, it, expect } from "vitest";
import { createCodexAdapter } from "@tachyon/engine/probe/adapters/codex.js";
import { PRIVATE_HOME_DIRNAME, type CodexSessionEvidence } from "@tachyon/engine/probe/adapters/codexSessionEvidence.js";
import type { Invocation, RawOutcome } from "@tachyon/engine/probe/adapters/types.js";

const spec = { runtime: "codex", prompt: "review this", cwd: "/repo", timeoutMs: 1 };
const inv = { cmd: "codex", args: [], cwd: "/repo", env: { CODEX_HOME: "/scratch/codex-home" } } satisfies Invocation;

/** An adapter whose private-home lifecycle is stubbed; evidence is whatever the scenario declares. */
function adapterWith(evidence: CodexSessionEvidence) {
  return createCodexAdapter({
    versionProbe: async () => "codex-cli 0.145.0",
    collectEvidence: async () => evidence,
    prepareHome: async (scratchDir) => path.join(scratchDir, PRIVATE_HOME_DIRNAME),
    removeHome: async () => undefined,
  });
}
const adapter = adapterWith({ unavailable: "stubbed" });

function raw(opts: Partial<RawOutcome>): RawOutcome {
  return { stdout: "", stderr: "", exitCode: 0, signal: null, timedOut: false, ...opts };
}

describe("codex adapter — interpret reads the artifact, not stdout (D5)", () => {
  it("exit 0 + artifact text → ok (ignores noisy --json stdout)", async () => {
    const r = await adapter.interpret(raw({ exitCode: 0, stdout: '{"type":"event"}\n{"type":"event"}', resultArtifactText: "THE ANSWER" }), spec, inv);
    expect(r.reason).toBe("ok");
    expect(r.lastMessage).toBe("THE ANSWER");
    expect(r.native.runtime).toBe("codex");
  });

  it("exit 0 + no artifact → empty_output", async () => {
    const r = await adapter.interpret(raw({ exitCode: 0, resultArtifactText: "" }), spec, inv);
    expect(r.reason).toBe("empty_output");
  });

  it("nonzero + artifact content → model_error (codex answered then failed)", async () => {
    const r = await adapter.interpret(raw({ exitCode: 1, resultArtifactText: "partial reasoning…" }), spec, inv);
    expect(r.reason).toBe("model_error");
    expect(r.lastMessage).toBe("partial reasoning…");
  });

  it("nonzero + no artifact → process_error with stderr", async () => {
    const r = await adapter.interpret(raw({ exitCode: 1, stderr: "sandbox denied" }), spec, inv);
    expect(r.reason).toBe("process_error");
    expect(r.lastMessage).toBe("sandbox denied");
  });
});

describe("codex adapter — effective-model evidence (SDD 476)", () => {
  it("declares that it proves its model, and what kind of evidence that is", () => {
    expect(adapter.reportsEffectiveModel).toBe(true);
    // Not provider usage accounting: codex's record is what it resolved and sent.
    expect(adapter.modelEvidence).toBe("session-record");
  });

  it("attaches the correlated session id and every model the rollout recorded", async () => {
    const proving = adapterWith({ sessionId: "019fa07e-f2a7-7da1-a3b9-fe2cebc3884c", models: ["gpt-5.6-luna"] });
    const r = await proving.interpret(raw({ exitCode: 0, resultArtifactText: "ok" }), spec, inv);
    expect(r.native.sessionId).toBe("019fa07e-f2a7-7da1-a3b9-fe2cebc3884c");
    expect(r.native.reportedNativeModels).toEqual(["gpt-5.6-luna"]);
    expect(r.native.modelEvidenceUnavailable).toBeUndefined();
  });

  it("a multi-model session reports both, so the verdict layer can refuse it", async () => {
    const mixed = adapterWith({ sessionId: "s", models: ["gpt-5.6-luna", "gpt-5.6-sol"] });
    const r = await mixed.interpret(raw({ exitCode: 0, resultArtifactText: "ok" }), spec, inv);
    expect(r.native.reportedNativeModels).toEqual(["gpt-5.6-luna", "gpt-5.6-sol"]);
  });

  it("no evidence → no model invented, and the reason is recorded", async () => {
    const blind = adapterWith({ unavailable: "no session rollout was written for this run's thread id" });
    const r = await blind.interpret(raw({ exitCode: 0, resultArtifactText: "ok" }), spec, inv);
    expect(r.reason).toBe("ok"); // the ANSWER survives; only its provenance is missing
    expect(r.native.reportedNativeModels).toBeUndefined();
    expect(r.native.modelEvidenceUnavailable).toContain("no session rollout");
  });

  it("evidence is still collected for a failed run — a crash is not a reason to stop asking", async () => {
    const proving = adapterWith({ sessionId: "s", models: ["gpt-5.6-luna"] });
    const r = await proving.interpret(raw({ exitCode: 1, stderr: "boom" }), spec, inv);
    expect(r.reason).toBe("process_error");
    expect(r.native.reportedNativeModels).toEqual(["gpt-5.6-luna"]);
  });

  it("fails closed when no private home was set up — never a weaker answer", async () => {
    const r = await adapter.interpret(raw({ exitCode: 0, resultArtifactText: "ok" }), spec, { cmd: "codex", args: [], cwd: "/repo" });
    expect(r.native.reportedNativeModels).toBeUndefined();
    expect(r.native.modelEvidenceUnavailable).toContain("without a private codex home");
  });
});

describe("codex adapter — invocation + capability (D5)", () => {
  it("buildInvocation pins flags: exec, --output-last-message <file>, --json, clean config, --sandbox, model, prompt last", async () => {
    const built = await adapter.buildInvocation({ ...spec, model: "gpt-5.6-luna", sandbox: "read-only" }, "/scratch");
    expect(built.cmd).toBe("codex");
    expect(built.args[0]).toBe("exec");
    expect(built.args).toEqual(expect.arrayContaining([
      "--output-last-message", built.resultArtifact!, "--json", "--ignore-user-config", "--ignore-rules",
      "--sandbox", "read-only", "--model", "gpt-5.6-luna",
    ]));
    expect(built.args[built.args.length - 1]).toBe("review this"); // prompt is the trailing positional
    expect(built.resultArtifact).toContain("/scratch");
  });

  it("--ephemeral is gone, and isolation comes from a private CODEX_HOME instead (SDD 476)", async () => {
    const built = await adapter.buildInvocation({ ...spec, model: "gpt-5.6-luna" }, "/scratch");
    expect(built.args).not.toContain("--ephemeral");
    expect(built.env?.CODEX_HOME).toBe(path.join("/scratch", PRIVATE_HOME_DIRNAME));
  });

  it("runs outside a git repository — the CLI refuses without this (t-7cc65e)", async () => {
    // Measured on codex-cli 0.145.0: without the flag, a non-repo cwd produces
    // "Not inside a trusted directory and --skip-git-repo-check was not specified", exit 1, no JSON
    // and no artifact — while Claude and Grok answer the same question fine. It does NOT widen the
    // probe: with this flag and --sandbox read-only, a write request still came back refused and no
    // file was created.
    const built = await adapter.buildInvocation(spec, "/scratch");
    expect(built.args).toContain("--skip-git-repo-check");
    expect(built.args).toEqual(expect.arrayContaining(["--sandbox", "read-only"]));
  });

  it("narrows the probe surface: no plugins, remote plugins, apps or skill search", async () => {
    const built = await adapter.buildInvocation(spec, "/scratch");
    for (const feature of ["plugins", "remote_plugin", "apps", "skill_search"]) {
      expect(built.args).toEqual(expect.arrayContaining(["--disable", feature]));
    }
  });

  it("workspace-write maps to the write sandbox", async () => {
    const built = await adapter.buildInvocation({ ...spec, sandbox: "workspace-write" }, "/scratch");
    expect(built.args).toEqual(expect.arrayContaining(["--sandbox", "workspace-write"]));
  });

  it("detectCapability reports available with version, or unavailable", async () => {
    expect(await adapter.detectCapability()).toEqual({ available: true, binaryVersion: "codex-cli 0.145.0" });
    const missing = createCodexAdapter({ versionProbe: async () => null });
    expect((await missing.detectCapability()).available).toBe(false);
  });
});

describe("codex adapter — the private home is real, and it is torn down", () => {
  const temporary: string[] = [];
  afterAll(() => {
    for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates the home on disk and removes it on cleanup, leaving the run's artifacts", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-codex-adapter-"));
    temporary.push(scratch);
    const real = createCodexAdapter({ versionProbe: async () => "codex-cli 0.145.0", collectEvidence: async () => ({ unavailable: "n/a" }) });
    const built = await real.buildInvocation(spec, scratch);
    const home = built.env!.CODEX_HOME!;
    expect(fs.existsSync(home)).toBe(true);
    fs.writeFileSync(path.join(scratch, "codex-last-message.txt"), "the answer");
    fs.mkdirSync(path.join(home, "sessions"), { recursive: true });

    await real.cleanup!(built);
    expect(fs.existsSync(home)).toBe(false);
    expect(fs.readFileSync(path.join(scratch, "codex-last-message.txt"), "utf8")).toBe("the answer");
  });

  it("cleanup on an invocation with no private home is a no-op, not a throw", async () => {
    const real = createCodexAdapter({ versionProbe: async () => null });
    await expect(real.cleanup!({ cmd: "codex", args: [], cwd: "/repo" })).resolves.toBeUndefined();
  });
});
