import { describe, expect, it } from "vitest";
import {
  GrokLaunchPreflight,
  parseGrokModelCatalog,
  type GrokCatalogProbe,
  type GrokProbeResult,
} from "../../src/runtime/adapters/grokLaunchPreflight.js";
import { parseLaunchCommand } from "@tachyon/shared/runtime/launchPreflight.js";

/**
 * t-85c586 — Grok pins used to fail preflight for catalog reasons: the registry had claude/codex
 * adapters only, so `--model grok-4.5` landed on `runtime_preflight_unverifiable` ("runtime exposes
 * no authoritative model catalog adapter").
 *
 * Every fixture below is verbatim from grok 0.2.112 (2026-07-26). The round trip that justifies
 * calling this authoritative rather than provisional was measured both ways: `grok models` lists
 * `grok-4.5` and a `-m grok-4.5` turn succeeds, while `-m grok-4.5-build` is refused by the CLI
 * before any turn with *Invalid params: "unknown model id". Run 'grok models' to see available
 * models.*
 */

/** Verbatim logged-in `grok models` output measured live on grok 1.0.0 (2026-08-09). */
const GROK_MODELS_OUTPUT = [
  "You are logged in with grok.com.",
  "",
  "Default model: grok-4.5",
  "",
  "Available models:",
  "  * grok-4.5 (default)",
  "",
].join("\n");

/** Verbatim `grok models` output measured live on logged-out grok 1.0.0 (2026-08-09). */
const GROK_MODELS_LOGGED_OUT_OUTPUT = [
  "You are not authenticated.",
  "",
  "Default model: grok-4.5",
  "",
  "Available models:",
  "  * grok-4.5 (default)",
  "",
].join("\n");

function probeReturning(result: Partial<GrokProbeResult>): GrokCatalogProbe {
  return async () => ({ code: 0, text: "", ...result });
}

function command(cmd: string) {
  const parsed = parseLaunchCommand(cmd);
  if (!parsed) throw new Error(`fixture command did not parse: ${cmd}`);
  return parsed;
}

describe("t-85c586 — parsing the measured catalog", () => {
  it("reads the slugs and the declared default", () => {
    expect(parseGrokModelCatalog(GROK_MODELS_OUTPUT)).toEqual({ slugs: ["grok-4.5"], defaultModel: "grok-4.5" });
  });

  it("reads a multi-entry listing without inventing annotations", () => {
    const text = GROK_MODELS_OUTPUT.replace("  * grok-4.5 (default)", "  * grok-4.5 (default)\n  * grok-4-heavy\n  - grok-3");
    expect(parseGrokModelCatalog(text)?.slugs).toEqual(["grok-4.5", "grok-4-heavy", "grok-3"]);
  });

  it("returns null for output that is not a catalog — a logged-out CLI proves nothing", () => {
    expect(parseGrokModelCatalog("You are not signed in. Run 'grok login'.")).toBeNull();
    expect(parseGrokModelCatalog("")).toBeNull();
    // A header with no entries under it is not a claim that zero models exist.
    expect(parseGrokModelCatalog("Available models:\n\nSomething else entirely")).toBeNull();
  });

  it("does not mistake an unrelated bullet list for a catalog", () => {
    // The same command already prints a login banner and a `Default model:` line; a looser rule
    // would read any future bulleted section as models.
    expect(parseGrokModelCatalog("Tips:\n  * run grok login\n  * see grok --help")).toBeNull();
  });

  it("refuses a listing whose entries are outside the measured shape", () => {
    expect(parseGrokModelCatalog(`Available models:\n  * ${"x".repeat(200)}`)).toBeNull();
  });
});

describe("t-85c586 — the adapter's verdicts", () => {
  it("a pinned model the catalog lists is SUPPORTED, sourced to the command", async () => {
    const adapter = new GrokLaunchPreflight(probeReturning({ text: GROK_MODELS_OUTPUT }));
    await expect(adapter.check(command("grok --model grok-4.5"), {})).resolves.toEqual({
      state: "supported",
      runtime: "grok",
      model: "grok-4.5",
      source: "grok-models",
    });
  });

  it("a pinned model the catalog omits is UNSUPPORTED, with bounded suggestions", async () => {
    const adapter = new GrokLaunchPreflight(probeReturning({
      text: GROK_MODELS_OUTPUT.replace("  * grok-4.5 (default)", "  * grok-4.5 (default)\n  * grok-4.5-fast"),
    }));
    const result = await adapter.check(command("grok -m grok-4.5-build"), {});
    expect(result).toMatchObject({ state: "unsupported", code: "runtime_model_unavailable", model: "grok-4.5-build" });
    // Measured: `grok-4.5-build` really is refused by the CLI, so this verdict matches reality.
    expect(result.state === "unsupported" && result.suggestions).toContain("grok-4.5-fast");
  });

  it("no pin needs no model-catalog probe at all", async () => {
    let probed = 0;
    const adapter = new GrokLaunchPreflight(async () => { probed++; return { code: 0, text: GROK_MODELS_OUTPUT }; });
    await expect(adapter.check(command("grok"), {})).resolves.toEqual({
      state: "supported", runtime: "grok", source: "default-model",
    });
    expect(probed).toBe(0);
  });

  it("another runtime's command is a declared mismatch, not a verdict about grok", async () => {
    const adapter = new GrokLaunchPreflight(probeReturning({ text: GROK_MODELS_OUTPUT }));
    await expect(adapter.check(command("codex --model gpt-5.6"), {})).resolves.toMatchObject({
      state: "unverifiable", code: "runtime_preflight_unverifiable",
    });
  });
});

describe("t-85c586 — nothing is invented when the catalog cannot be read", () => {
  it("t-5dcf47: a valid catalog from a logged-out CLI is UNVERIFIABLE, never supported", async () => {
    const adapter = new GrokLaunchPreflight(probeReturning({ text: GROK_MODELS_LOGGED_OUT_OUTPUT }));
    const result = await adapter.check(command("grok --model grok-4.5"), {});
    expect(result).toMatchObject({ state: "unverifiable", code: "runtime_preflight_unverifiable", runtime: "grok" });
  });

  it("t-5dcf47: an unrecognized banner fails safe even when the catalog lists the pin", async () => {
    const adapter = new GrokLaunchPreflight(probeReturning({
      text: GROK_MODELS_OUTPUT.replace("You are logged in with grok.com.", "Authentication ready."),
    }));
    const result = await adapter.check(command("grok --model grok-4.5"), {});
    expect(result).toMatchObject({ state: "unverifiable", code: "runtime_preflight_unverifiable", runtime: "grok" });
  });

  it("an unreadable catalog is unverifiable — never 'the model is missing'", async () => {
    const adapter = new GrokLaunchPreflight(probeReturning({ text: "You are not signed in. Run 'grok login'." }));
    const result = await adapter.check(command("grok --model grok-4.5"), {});
    // The distinction that matters: `unsupported` would refuse a launch that may be perfectly valid.
    expect(result).toMatchObject({ state: "unverifiable", code: "runtime_preflight_unverifiable", runtime: "grok" });
    expect(result.state === "unverifiable" && result.reason).toContain("authentication banner");
  });

  it("a timeout, an oversized listing and a nonzero exit each fail rather than guess", async () => {
    const cmd = command("grok --model grok-4.5");
    const cases: Array<[Partial<GrokProbeResult>, string]> = [
      [{ failure: "timeout", code: null }, "timed out"],
      [{ failure: "oversized", code: null }, "output limit"],
      [{ code: 1, text: "" }, "probe failed"],
    ];
    for (const [probeResult, reason] of cases) {
      const result = await new GrokLaunchPreflight(probeReturning(probeResult)).check(cmd, {});
      expect(result).toMatchObject({ state: "failed", code: "runtime_preflight_failed", runtime: "grok" });
      expect(result.state === "failed" && result.reason).toContain(reason);
    }
  });

  it("a catalog listing the pin is never overridden by the declared default", async () => {
    // Guards against a tempting shortcut: "if it isn't the default, warn". The listing is the rule.
    const adapter = new GrokLaunchPreflight(probeReturning({
      text: GROK_MODELS_OUTPUT.replace("  * grok-4.5 (default)", "  * grok-4.5 (default)\n  * grok-4-heavy"),
    }));
    await expect(adapter.check(command("grok --model grok-4-heavy"), {})).resolves.toMatchObject({
      state: "supported", model: "grok-4-heavy",
    });
  });
});
