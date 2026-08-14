import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CodexLaunchPreflight,
  probeCodexCatalog,
  type CodexProbeResult,
} from "../../src/runtime/adapters/codexLaunchPreflight.js";
import { ClaudeLaunchPreflight } from "../../src/runtime/adapters/claudeLaunchPreflight.js";
import { CODEX_CATALOG_MAX_BYTES } from "../../src/runtime/adapters/codexCatalogStream.js";
import {
  boundedCloseMatches,
  hasExplicitModelSelection,
  isExplicitCodexModelCommand,
  parseLaunchCommand,
  RuntimeLaunchPreflightRegistry,
} from "@tachyon/shared/runtime/launchPreflight.js";

const catalogSlugs = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const output = (slugs: readonly string[] = catalogSlugs, extra: Partial<CodexProbeResult> = {}): CodexProbeResult => ({ code: 0, slugs, ...extra });

describe("runtime launch preflight", () => {
  it("reports an explicit unverifiable result when no runtime adapter exists", async () => {
    // Exercises the EMPTY-registry path. `grok` is just the example command here — production wires
    // a real grok adapter since t-85c586 (see grokLaunchPreflight.test.ts).
    const registry = new RuntimeLaunchPreflightRegistry({});
    await expect(registry.check(parseLaunchCommand("grok --model grok-4.5")!, {})).resolves.toEqual({
      state: "unverifiable",
      code: "runtime_preflight_unverifiable",
      runtime: "grok",
      reason: "runtime exposes no authoritative model catalog adapter",
    });
    expect(hasExplicitModelSelection("grok --model grok-4.5 && echo unsafe")).toBe(true);
  });

  it.each(["sonnet", "claude-sonnet-5"])("routes Claude model %s to honest startup validation", async (model) => {
    const registry = new RuntimeLaunchPreflightRegistry({ claude: new ClaudeLaunchPreflight() });
    await expect(registry.check(parseLaunchCommand(`claude --model ${model}`)!, {})).resolves.toEqual({
      state: "provisional",
      runtime: "claude",
      model,
      source: "runtime-startup-readiness",
    });
  });

  it("keeps bare Claude supported by its default and rejects adapter mismatch honestly", async () => {
    const adapter = new ClaudeLaunchPreflight();
    await expect(adapter.check(parseLaunchCommand("claude")!, {})).resolves.toEqual({
      state: "supported",
      runtime: "claude",
      source: "default-model",
    });
    await expect(adapter.check(parseLaunchCommand("grok --model x")!, {})).resolves.toMatchObject({
      state: "unverifiable",
      code: "runtime_preflight_unverifiable",
    });
  });

  it("accepts the exact advertised Sol slug and rejects the absent generic slug", async () => {
    const adapter = new CodexLaunchPreflight(async () => output());
    await expect(adapter.check(parseLaunchCommand("codex --model gpt-5.6-sol")!, {})).resolves.toMatchObject({ state: "supported", model: "gpt-5.6-sol" });
    await expect(adapter.check(parseLaunchCommand("codex --model gpt-5.6")!, {})).resolves.toEqual({
      state: "unsupported", code: "runtime_model_unavailable", runtime: "codex", model: "gpt-5.6",
      suggestions: ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"],
    });
  });

  it.each([
    ["malformed", { code: null, slugs: [], failure: "malformed" as const }],
    ["timeout", { code: null, slugs: [], failure: "timeout" as const }],
    ["oversized", { code: null, slugs: [], failure: "oversized" as const }],
    ["non-zero", { code: 2, slugs: [] }],
  ])("fails closed with a redacted reason for a %s catalog", async (_label, probe) => {
    const result = await new CodexLaunchPreflight(async () => probe).check(parseLaunchCommand("codex -m gpt-5.6")!, {});
    expect(result).toMatchObject({ state: "failed", code: "runtime_preflight_failed" });
    expect(result).not.toHaveProperty("stdout");
  });

  it("degrades ambiguous shell composition without executing or guessing", () => {
    expect(parseLaunchCommand("codex --model gpt-5.6 && touch /tmp/nope")).toBeUndefined();
    expect(parseLaunchCommand("codex --model $(steal-token)")).toBeUndefined();
  });

  it.each([
    "codex | tee out", "codex && sh", "codex; sh", "codex > out", "codex\nsh", "codex `whoami`", "codex \"$(whoami)\"",
    "codex # --sandbox read-only", "! codex", "codex ( sh )",
  ])("rejects structural shell composition: %s", (command) => {
    expect(parseLaunchCommand(command)).toBeUndefined();
  });

  it("exposes exact runtime source position and static-word proof through wrappers", () => {
    const command = "env MODE=review npx --yes /opt/bin/codex -- prompt";
    const parsed = parseLaunchCommand(command)!;
    expect(parsed).toMatchObject({ binary: "/opt/bin/codex", argv: ["--", "prompt"], allWordsLiteral: true });
    expect(command.slice(0, parsed.runtimeTokenEnd)).toBe("env MODE=review npx --yes /opt/bin/codex");
  });

  it("keeps single-quoted control-looking text literal but marks parameter/glob expansion dynamic", () => {
    expect(parseLaunchCommand("codex 'literal | && ; > $(not-run)'")).toMatchObject({ allWordsLiteral: true });
    expect(parseLaunchCommand("codex $MODE")).toMatchObject({ allWordsLiteral: false });
    expect(parseLaunchCommand("codex \"$MODE\"")).toMatchObject({ allWordsLiteral: false });
    expect(parseLaunchCommand("codex *.md")).toMatchObject({ allWordsLiteral: false });
  });

  it.each([
    ["npx codex --model gpt-5.6", "npx", ["codex"]],
    ["pnpx codex -m gpt-5.6", "pnpx", ["codex"]],
    ["env -u TOKEN codex --model=gpt-5.6", "env", ["-u", "TOKEN", "codex"]],
  ])("resolves Codex through %s without changing its probe invocation", (command, probeBinary, probeArgv) => {
    expect(parseLaunchCommand(command)).toMatchObject({ binary: "codex", model: "gpt-5.6", probeBinary, probeArgv });
  });

  it.each([
    "env --argv0 reviewer codex -- prompt",
    "env -a reviewer -f vars.env codex -- prompt",
    "env --file=vars.env --chdir /tmp --unset=TOKEN MODE=review codex -- prompt",
    "npx -p @openai/codex codex -- prompt",
    "npx --package @openai/codex codex -- prompt",
    "npx --package=@openai/codex --workspace repo codex -- prompt",
    "npx -- codex -- prompt",
    "pnpx --allow-build native-addon --package @openai/codex --reporter=append-only codex -- prompt",
    "pnpx --allow-build=native-addon codex -- prompt",
    "bunx --bun --no-install -p @openai/codex codex -- prompt",
    "env MODE=review npx --yes --package=@openai/codex codex -- prompt",
  ])("proves the runtime boundary through the explicit wrapper grammar: %s", (command) => {
    const parsed = parseLaunchCommand(command)!;
    expect(parsed).toMatchObject({ binary: "codex", argv: ["--", "prompt"] });
    expect(command.slice(0, parsed.runtimeTokenEnd)).toMatch(/codex$/);
  });

  it.each([
    "env -S 'codex --'", "env --split-string=codex codex", "env --unknown codex", "env -a", "env -a -i codex", "env --file= codex",
    "npx -c 'codex --'", "npx --call=codex", "npx --unknown codex", "npx -p", "npx -p --yes codex", "npx --package= codex",
    "pnpx -c codex", "pnpx --shell-mode codex", "pnpx --unknown codex", "pnpx --package",
    "pnpx --allow-build", "pnpx --allow-build --package pkg codex", "pnpx --allow-build= codex",
    "bunx --unknown codex", "bunx -p", "bunx --package= codex",
    "npx --yes pnpx codex",
  ])("fails closed on unknown, shell-mode, missing, or ambiguous wrapper grammar: %s", (command) => {
    expect(parseLaunchCommand(command)).toBeUndefined();
  });

  it.each([
    "env env codex --",
    "env MODE=review env codex --",
    "env -i --argv0 reviewer /usr/bin/env codex --",
    "env env npx codex --",
  ])("refuses a second env layer before package or runtime resolution: %s", (command) => {
    expect(parseLaunchCommand(command)).toBeUndefined();
  });

  it.each([
    ["codex --", undefined],
    ["env MODE=review codex --", undefined],
    ["npx codex --", "npx"],
    ["env MODE=review pnpx codex --", "pnpx"],
    ["bunx opencode --", "bunx"],
  ])("exposes package-launcher traversal only when crossed: %s", (command, packageLauncher) => {
    expect(parseLaunchCommand(command)?.packageLauncher).toBe(packageLauncher);
  });

  it("probes through the launcher that will execute Codex", async () => {
    const adapter = new CodexLaunchPreflight(async (binary, args, env, options) => {
      expect(binary).toBe("npx");
      expect(args).toEqual(["codex"]);
      expect(env.CODEX_HOME).toBe("/private/codex");
      expect(options?.cwd).toBe("/worktree");
      return output();
    });
    await expect(adapter.check(
      parseLaunchCommand("npx codex --model gpt-5.6-sol")!,
      { CODEX_HOME: "/private/codex" },
      "/worktree",
    )).resolves.toMatchObject({ state: "supported" });
  });

  it("streams a subprocess catalog larger than the retired 256 KiB buffer", async () => {
    const script = `process.stdout.write(JSON.stringify({metadata:"x".repeat(300*1024),models:[{slug:"gpt-5.6-terra",visibility:"list"}]}))`;
    await expect(probeCodexCatalog(process.execPath, ["-e", script], process.env)).resolves.toEqual({
      code: 0,
      slugs: ["gpt-5.6-terra"],
    });
  });

  it("terminates a malformed or timed-out probe instead of waiting for its process", async () => {
    const malformed = await probeCodexCatalog(process.execPath, ["-e", `process.stdout.write("!");setInterval(()=>{},1000)`], process.env, { timeoutMs: 1_000 });
    expect(malformed).toEqual({ code: null, slugs: [], failure: "malformed" });

    const started = Date.now();
    const timedOut = await probeCodexCatalog(process.execPath, ["-e", `setInterval(()=>{},1000)`], process.env, { timeoutMs: 50 });
    expect(timedOut).toEqual({ code: null, slugs: [], failure: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("terminates a subprocess that crosses the total catalog byte bound", async () => {
    const script = `process.stdout.write(" ".repeat(${CODEX_CATALOG_MAX_BYTES + 1}));setInterval(()=>{},1000)`;
    await expect(probeCodexCatalog(process.execPath, ["-e", script], process.env)).resolves.toEqual({
      code: null,
      slugs: [],
      failure: "oversized",
    });
  });

  it("terminates the detached probe process group on a streaming rejection", async () => {
    if (process.platform !== "linux") return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-catalog-probe-"));
    const pidFile = path.join(root, "descendant.pid");
    let descendantPid: number | undefined;
    const isLive = (pid: number): boolean => {
      try {
        return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2] !== "Z";
      } catch (error) {
        // t-9d76b1 — ESRCH belongs here with ENOENT, and only one of them was listed. This poll exists
        // to watch a process disappear, so it races that disappearance BY CONSTRUCTION: `open` can
        // succeed and the `read` then fail with ESRCH once the pid is reaped between the two. Rethrowing
        // turned "the descendant died, exactly as asserted" into a failed run — twice inside one
        // `verify:full` on a loaded host, in the test whose whole claim is that the process is gone.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ESRCH") return false;
        throw error;
      }
    };
    try {
      const script = [
        `const {spawn}=require("node:child_process")`,
        `const fs=require("node:fs")`,
        `const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"})`,
        `fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid))`,
        `process.stdout.write("!")`,
        `setInterval(()=>{},1000)`,
      ].join(";");
      await expect(probeCodexCatalog(process.execPath, ["-e", script], process.env, { timeoutMs: 1_000 })).resolves.toEqual({
        code: null,
        slugs: [],
        failure: "malformed",
      });
      descendantPid = Number(fs.readFileSync(pidFile, "utf8"));
      let live = isLive(descendantPid);
      for (let attempt = 0; live && attempt < 100; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        live = isLive(descendantPid);
      }
      expect(live).toBe(false);
    } finally {
      if (descendantPid && isLive(descendantPid)) process.kill(descendantPid, "SIGKILL");
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when an explicit model occurs after shell composition", () => {
    expect(isExplicitCodexModelCommand("echo first && npx codex --model gpt-5.6")).toBe(true);
  });

  it("bounds and deterministically orders suggestion-only slugs", () => {
    expect(boundedCloseMatches("gpt-5.6", ["gpt-5.6-z", "gpt-5.6-a", "gpt-5.6-b", "gpt-5.6-c"])).toEqual(["gpt-5.6-a", "gpt-5.6-b", "gpt-5.6-c"]);
  });
});
