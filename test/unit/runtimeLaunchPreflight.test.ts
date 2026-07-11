import { describe, expect, it } from "vitest";
import { CodexLaunchPreflight, type CodexProbeResult } from "../../src/runtime/adapters/codexLaunchPreflight.js";
import { boundedCloseMatches, isExplicitCodexModelCommand, parseLaunchCommand } from "../../src/runtime/launchPreflight.js";

const output = (value: unknown, extra: Partial<CodexProbeResult> = {}): CodexProbeResult => ({ code: 0, stdout: Buffer.from(JSON.stringify(value)), ...extra });
const catalog = { models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].map((slug) => ({ slug, visibility: "list", base_instructions: "must never escape" })) };

describe("runtime launch preflight", () => {
  it("accepts the exact advertised Sol slug and rejects the absent generic slug", async () => {
    const adapter = new CodexLaunchPreflight(async () => output(catalog));
    await expect(adapter.check(parseLaunchCommand("codex --model gpt-5.6-sol")!, {})).resolves.toMatchObject({ state: "supported", model: "gpt-5.6-sol" });
    await expect(adapter.check(parseLaunchCommand("codex --model gpt-5.6")!, {})).resolves.toEqual({
      state: "unsupported", code: "runtime_model_unavailable", runtime: "codex", model: "gpt-5.6",
      suggestions: ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"],
    });
  });

  it.each([
    ["malformed", { code: 0, stdout: Buffer.from("secret-not-json") }],
    ["timeout", { code: null, stdout: Buffer.alloc(0), timedOut: true }],
    ["oversized", { code: null, stdout: Buffer.alloc(0), oversized: true }],
    ["non-zero", { code: 2, stdout: Buffer.from("provider secret") }],
  ])("fails closed with a redacted reason for a %s catalog", async (_label, probe) => {
    const result = await new CodexLaunchPreflight(async () => probe).check(parseLaunchCommand("codex -m gpt-5.6")!, {});
    expect(result).toMatchObject({ state: "failed", code: "runtime_preflight_failed" });
    expect(JSON.stringify(result)).not.toMatch(/secret|provider/);
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
    ["codex --", undefined],
    ["env MODE=review codex --", undefined],
    ["npx codex --", "npx"],
    ["env MODE=review pnpx codex --", "pnpx"],
    ["bunx opencode --", "bunx"],
  ])("exposes package-launcher traversal only when crossed: %s", (command, packageLauncher) => {
    expect(parseLaunchCommand(command)?.packageLauncher).toBe(packageLauncher);
  });

  it("probes through the launcher that will execute Codex", async () => {
    const adapter = new CodexLaunchPreflight(async (binary, args) => {
      expect(binary).toBe("npx");
      expect(args).toEqual(["codex"]);
      return output(catalog);
    });
    await expect(adapter.check(parseLaunchCommand("npx codex --model gpt-5.6-sol")!, {})).resolves.toMatchObject({ state: "supported" });
  });

  it("fails closed when an explicit model occurs after shell composition", () => {
    expect(isExplicitCodexModelCommand("echo first && npx codex --model gpt-5.6")).toBe(true);
  });

  it("bounds and deterministically orders suggestion-only slugs", () => {
    expect(boundedCloseMatches("gpt-5.6", ["gpt-5.6-z", "gpt-5.6-a", "gpt-5.6-b", "gpt-5.6-c"])).toEqual(["gpt-5.6-a", "gpt-5.6-b", "gpt-5.6-c"]);
  });
});
