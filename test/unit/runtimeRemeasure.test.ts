/**
 * t-0ac2e9 — the decisions behind `node scripts/dogfood/run.mjs runtime-remeasure`.
 *
 * Every fixture that starts with REAL_ is output captured from codex-cli 0.146.1 on 2026-08-06.
 * The constructed fixtures below them exist to prove the guard turns red: a probe that can only
 * return `holds` measures nothing.
 */
import { describe, expect, it } from "vitest";
import {
  classifyCodexScreen,
  compareVariantSets,
  fullAutoVerdict,
  memoryVerdict,
  parseExpectedVariants,
  summarize,
  trustVerdict,
} from "../../scripts/dogfood/runtime-remeasure-analysis.js";
import { codexMemoryEffectiveState } from "../../src/runtime/adapters/codexMemory.js";
import { CODEX_APPROVAL_POLICIES, CODEX_SANDBOX_MODES } from "../../src/config/codexNativeConfigProjection.js";
import { FLAG_SUGGESTIONS } from "../../src/webview/formLogic.js";

const REAL_APPROVAL_ERROR =
  "Error: unknown variant `tachyon-remeasure-probe`, expected one of `untrusted`, `on-failure`, `on-request`, `granular`, `never`\nin `approval_policy`\n";
const REAL_SANDBOX_ERROR =
  "Error: unknown variant `tachyon-remeasure-probe`, expected one of `read-only`, `workspace-write`, `danger-full-access`\nin `sandbox_mode`\n";
/** Two variants read `expected `a` or `b``, with no "one of". Both shapes must parse. */
const REAL_TRUST_LEVEL_ERROR =
  "Error: unknown variant `bogus`, expected `trusted` or `untrusted`\nin `projects.\"/tmp/zz\".trust_level`\n";
const REAL_MEMORIES_OFF = "apps                                 stable             true\nmemories                             stable             false\n";
const REAL_MEMORIES_ON = "memories                             stable             true\n";
const REAL_TRUST_PROMPT_PANE = [
  "> You are in /tmp/scratch/trust/parent/child",
  "  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt",
  "  injection. Trusting the directory allows project-local config, hooks, and exec policies to load.",
  "› 1. Yes, continue",
  "  2. No, quit",
].join("\n");
const REAL_SIGN_IN_PANE = [
  "  Welcome to Codex, OpenAI's command-line coding agent",
  "  Sign in with ChatGPT to use Codex as part of your paid plan",
  "> 1. Sign in with ChatGPT",
].join("\n");
const REAL_READY_PANE = [
  "│ >_ OpenAI Codex (v0.146.1)                               │",
  "│ model:     gpt-5.6-sol   /model to change                │",
  "› Improve documentation in @filename",
].join("\n");

describe("parseExpectedVariants", () => {
  it("reads the list codex prints for three or more values", () => {
    expect(parseExpectedVariants(REAL_APPROVAL_ERROR)).toEqual(["untrusted", "on-failure", "on-request", "granular", "never"]);
    expect(parseExpectedVariants(REAL_SANDBOX_ERROR)).toEqual(["read-only", "workspace-write", "danger-full-access"]);
  });

  it("reads the other shape codex prints for exactly two values", () => {
    expect(parseExpectedVariants(REAL_TRUST_LEVEL_ERROR)).toEqual(["trusted", "untrusted"]);
  });

  it("returns nothing when the text holds no list", () => {
    expect(parseExpectedVariants("Error: could not run\n")).toEqual([]);
  });
});

describe("compareVariantSets", () => {
  it("holds when the CLI list matches the projection, with granular excluded by name", () => {
    const compared = compareVariantSets(
      CODEX_APPROVAL_POLICIES,
      parseExpectedVariants(REAL_APPROVAL_ERROR),
      ["granular"],
    );
    expect(compared).toEqual({ verdict: "holds", missing: [], added: [] });
  });

  it("holds for the sandbox list, which needs no exclusion", () => {
    expect(compareVariantSets(CODEX_SANDBOX_MODES, parseExpectedVariants(REAL_SANDBOX_ERROR)).verdict).toBe("holds");
  });

  it("reports a value the CLI dropped", () => {
    const compared = compareVariantSets(["untrusted", "on-failure"], ["untrusted"]);
    expect(compared.verdict).toBe("changed");
    expect(compared.missing).toEqual(["on-failure"]);
  });

  it("reports a value the CLI added that is not excluded", () => {
    const compared = compareVariantSets(["untrusted"], ["untrusted", "granular", "sudden"], ["granular"]);
    expect(compared.verdict).toBe("changed");
    expect(compared.added).toEqual(["sudden"]);
  });

  it("measures nothing when the CLI printed no list", () => {
    expect(compareVariantSets(["untrusted"], []).verdict).toBe("not-measured");
  });
});

describe("classifyCodexScreen", () => {
  it("names each real screen", () => {
    expect(classifyCodexScreen(REAL_TRUST_PROMPT_PANE)).toBe("trust-prompt");
    expect(classifyCodexScreen(REAL_SIGN_IN_PANE)).toBe("sign-in");
    expect(classifyCodexScreen(REAL_READY_PANE)).toBe("ready");
  });

  it("returns unknown for a screen it cannot name", () => {
    expect(classifyCodexScreen("some other output")).toBe("unknown");
  });
});

describe("trustVerdict", () => {
  it("holds on what 0.146.1 did: the child asks, and argv cannot grant trust", () => {
    expect(trustVerdict({ exact: "ready", child: "trust-prompt", argv: "trust-prompt" }).verdict).toBe("holds");
  });

  it("measures nothing when the control run hits the sign-in screen", () => {
    // The trap: with no credential no dialog appears, and that reads like inherited trust.
    const decided = trustVerdict({ exact: "sign-in", child: "sign-in", argv: "sign-in" });
    expect(decided.verdict).toBe("not-measured");
    expect(decided.reason).toContain("sign-in");
  });

  it("reports drift when a child of a trusted directory stops asking", () => {
    const decided = trustVerdict({ exact: "ready", child: "ready", argv: "trust-prompt" });
    expect(decided.verdict).toBe("changed");
    expect(decided.reason).toContain("prefix");
  });

  it("reports drift when argv starts granting trust", () => {
    const decided = trustVerdict({ exact: "ready", child: "trust-prompt", argv: "ready" });
    expect(decided.verdict).toBe("changed");
    expect(decided.reason).toContain("argv");
  });

  it("measures nothing when a case shows an unknown screen", () => {
    expect(trustVerdict({ exact: "ready", child: "unknown", argv: "trust-prompt" }).verdict).toBe("not-measured");
  });
});

describe("fullAutoVerdict", () => {
  it("holds while the CLI refuses the flag and the chip list omits it", () => {
    // The product record, read from the source the chips are built from.
    const offered = (FLAG_SUGGESTIONS.codex ?? []).includes("--full-auto");
    expect(offered).toBe(false);
    expect(fullAutoVerdict(true, offered).verdict).toBe("holds");
  });

  it("reports drift when the chip list offers a flag the CLI refuses", () => {
    expect(fullAutoVerdict(true, true).verdict).toBe("changed");
  });

  it("reports drift when the CLI accepts the flag again", () => {
    expect(fullAutoVerdict(false, false).verdict).toBe("changed");
  });
});

describe("memoryVerdict", () => {
  it("reads the real rows through the product's own parser", () => {
    expect(codexMemoryEffectiveState(REAL_MEMORIES_OFF)).toBe("disabled");
    expect(codexMemoryEffectiveState(REAL_MEMORIES_ON)).toBe("enabled");
  });

  it("holds on what 0.146.1 did: off by default, and both controls turn it on", () => {
    expect(memoryVerdict({ byDefault: "disabled", enableFlag: "enabled", configFile: "enabled" }).verdict).toBe("holds");
  });

  it("reports drift when memory is on by default", () => {
    const decided = memoryVerdict({ byDefault: "enabled", enableFlag: "enabled", configFile: "enabled" });
    expect(decided.verdict).toBe("changed");
    expect(decided.reason).toContain("ON by default");
  });

  it("reports drift when a control path stops working", () => {
    expect(memoryVerdict({ byDefault: "disabled", enableFlag: "disabled", configFile: "enabled" }).verdict).toBe("changed");
  });

  it("measures nothing when the feature row is gone", () => {
    expect(memoryVerdict({ byDefault: "unknown", enableFlag: "unknown", configFile: "unknown" }).verdict).toBe("not-measured");
  });
});

describe("summarize", () => {
  it("counts each verdict", () => {
    const totals = summarize([
      { id: "a", title: "a", anchor: "a", recordedVersion: "v", recorded: "r", observed: "o", verdict: "holds" },
      { id: "b", title: "b", anchor: "b", recordedVersion: "v", recorded: "r", observed: "o", verdict: "changed" },
      { id: "c", title: "c", anchor: "c", recordedVersion: "v", recorded: "r", observed: "o", verdict: "not-measured" },
    ]);
    expect(totals).toEqual({ holds: 1, changed: 1, "not-measured": 1 });
  });

  it("keeps the requested four-dimension report explicit", () => {
    const row = (id: string, verdict: "holds" | "not-measured") => ({
      id,
      title: id,
      anchor: id,
      recordedVersion: "v",
      recorded: "r",
      observed: "o",
      verdict,
    });
    expect(summarize([
      row("config", "holds"),
      row("full-auto", "holds"),
      row("trust", "holds"),
      row("memory", "not-measured"),
    ])).toEqual({ holds: 3, changed: 0, "not-measured": 1 });
  });
});
