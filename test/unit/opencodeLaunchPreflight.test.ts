import { describe, expect, it } from "vitest";
import {
  OpencodeLaunchPreflight,
  parseOpencodeCredentialInventory,
  probeOpencodeCredentials,
  type OpencodeCredentialProbe,
  type OpencodeProbeResult,
} from "@tachyon/engine/runtime/adapters/opencodeLaunchPreflight.js";
import {
  parseLaunchCommand,
  RuntimeLaunchPreflightError,
  RuntimeLaunchPreflightRegistry,
} from "@tachyon/shared/runtime/launchPreflight.js";
import {
  RUNTIME_AUTH_PREFLIGHT,
  RUNTIME_AUTH_PROFILES,
  authRequiredFromPreflight,
  classifyAuthRequired,
  describeAuthRequired,
} from "@tachyon/shared/runtime/authRequired.js";

/**
 * SDD 477 / `t-0338fc` — OpenCode is the runtime that fails authentication invisibly: with no
 * credential it does not error, it answers on the fallback model `big-pickle`.
 *
 * Every fixture below is verbatim stdout from opencode 1.18.5 (2026-07-27), captured by driving the
 * real CLI against isolated private XDG homes. `\x1b[90m` is the CLI's own dimming of the detail
 * column; it is kept in the fixtures precisely because the parser has to survive it.
 */

/** An isolated, credential-free private home — the shape a mis-seeded harness materializes. */
const EMPTY_HOME = [
  "┌  Credentials \x1b[90m/tmp/tachyon/oc/data/opencode/auth.json",
  "│",
  "└  0 credentials",
  "",
].join("\n");

/** The operator's own home: three providers, two auth kinds. */
const REAL_HOME = [
  "┌  Credentials \x1b[90m~/.local/share/opencode/auth.json",
  "│",
  "●  OpenAI \x1b[90moauth",
  "│",
  "●  Cloudflare Workers AI \x1b[90mapi",
  "│",
  "●  OpenCode Go \x1b[90mapi",
  "│",
  "└  3 credentials",
  "",
].join("\n");

/** OpenCode's OTHER authentication path: a provider key found in the environment, store empty. */
const ENV_ONLY = [
  "┌  Credentials \x1b[90m/tmp/tachyon/oc/data/opencode/auth.json",
  "│",
  "└  0 credentials",
  "",
  "┌  Environment",
  "│",
  "●  OpenAI \x1b[90mOPENAI_API_KEY",
  "│",
  "└  1 environment variable",
  "",
].join("\n");

/** One stored credential plus two environment ones — the measured plural spellings differ. */
const STORE_AND_ENV = [
  "┌  Credentials \x1b[90m/tmp/tachyon/oc/data/opencode/auth.json",
  "│",
  "●  OpenCode Go \x1b[90mapi",
  "│",
  "└  1 credentials",
  "",
  "┌  Environment",
  "│",
  "●  Anthropic \x1b[90mANTHROPIC_API_KEY",
  "│",
  "●  OpenAI \x1b[90mOPENAI_API_KEY",
  "│",
  "└  2 environment variables",
  "",
].join("\n");

/** Verbatim `opencode run 'say ok'` from a credential-free home: a SUCCESSFUL turn. */
const SILENT_FALLBACK_TURN = ["> build · big-pickle", "ok", ""].join("\n");

function probeReturning(result: Partial<OpencodeProbeResult>): OpencodeCredentialProbe {
  return async () => ({ code: 0, text: "", ...result });
}

function command(cmd: string) {
  const parsed = parseLaunchCommand(cmd);
  if (!parsed) throw new Error(`fixture command did not parse: ${cmd}`);
  return parsed;
}

describe("t-0338fc — reading OpenCode's credential inventory", () => {
  it("reads an empty private home as zero, citing the store's own summary line", () => {
    expect(parseOpencodeCredentialInventory(EMPTY_HOME)).toEqual({
      credentials: 0,
      environment: 0,
      reportedLine: "0 credentials",
    });
  });

  it("reads a populated store without being confused by the provider labels", () => {
    expect(parseOpencodeCredentialInventory(REAL_HOME)).toEqual({
      credentials: 3,
      environment: 0,
      reportedLine: "3 credentials",
    });
  });

  it("counts environment-provided keys as the separate authentication path they are", () => {
    expect(parseOpencodeCredentialInventory(ENV_ONLY)).toMatchObject({ credentials: 0, environment: 1 });
    expect(parseOpencodeCredentialInventory(STORE_AND_ENV)).toMatchObject({ credentials: 1, environment: 2 });
  });

  it.each([
    ["an error instead of an inventory", "Error: something went wrong"],
    ["an empty output", ""],
    ["an environment section with no credentials summary", "┌  Environment\n│\n└  1 environment variable"],
    ["a count too long to be a real inventory", "└  1234567 credentials"],
    ["two credential summaries, which is not the measured single-inventory shape", `${EMPTY_HOME}${REAL_HOME}`],
  ])("refuses to interpret %s", (_label, text) => {
    expect(parseOpencodeCredentialInventory(text)).toBeNull();
  });
});

describe("t-0338fc — the launch gate", () => {
  it("refuses a credential-free launch, naming the runtime and the safe action", async () => {
    const adapter = new OpencodeLaunchPreflight(probeReturning({ text: EMPTY_HOME }));
    const result = await adapter.check(command("opencode"), {});
    expect(result).toEqual({
      state: "unauthenticated",
      code: "runtime_auth_unavailable",
      runtime: "opencode",
      humanAction: RUNTIME_AUTH_PREFLIGHT.opencode!.humanAction,
      reportedLine: "0 credentials",
      source: "opencode-providers-list",
    });
    const error = new RuntimeLaunchPreflightError(result as Extract<typeof result, { state: "unauthenticated" }>);
    expect(error.code).toBe("runtime_auth_unavailable");
    expect(error.message).toContain("the opencode runtime holds no readable credential");
    expect(error.message).toContain("opencode providers login");
    // The refusal carries a COUNT, never anything from the credential file.
    expect(error.message).not.toMatch(/sk-|Bearer\s+\S{8,}|eyJ[A-Za-z0-9_-]{10,}/);
  });

  it("lets a credentialed launch through, and does not pretend to have checked the model", async () => {
    for (const text of [REAL_HOME, ENV_ONLY, STORE_AND_ENV]) {
      const adapter = new OpencodeLaunchPreflight(probeReturning({ text }));
      // Unverifiable, not supported: a readable credential says nothing about a model pin, so an
      // explicit `-m` keeps failing closed exactly where it did before this adapter existed.
      await expect(adapter.check(command("opencode --model zhipuai/glm-4.6"), {})).resolves.toEqual({
        state: "unverifiable",
        code: "runtime_preflight_unverifiable",
        runtime: "opencode",
        reason: "runtime exposes no authoritative model catalog adapter",
      });
    }
  });

  it.each([
    ["timeout", { failure: "timeout" as const }, "credential store probe timed out"],
    ["oversized", { failure: "oversized" as const }, "credential store probe exceeded output limit"],
    ["a non-zero exit", { code: 1, text: EMPTY_HOME }, "credential store probe failed"],
    ["an unreadable inventory", { text: "totally unexpected output" }, "opencode providers list reported no readable credential inventory"],
  ])("fails closed on %s rather than guessing the launch is fine", async (_label, probe, reason) => {
    // Fail-closed is deliberate here and nowhere else: the measured read is local and works from a
    // cold home with the network black-holed, so a failure means a broken environment — and the cost
    // of guessing "probably fine" is a healthy-looking agent answering on a model nobody chose.
    const adapter = new OpencodeLaunchPreflight(probeReturning(probe));
    await expect(adapter.check(command("opencode"), {})).resolves.toEqual({
      state: "failed",
      code: "runtime_preflight_failed",
      runtime: "opencode",
      reason,
    });
  });

  it("passes the launch env and cwd to the probe, and appends only the measured subcommand", async () => {
    const seen: Array<{ binary: string; args: readonly string[]; env: Record<string, string | undefined>; cwd?: string }> = [];
    const adapter = new OpencodeLaunchPreflight(async (binary, args, env, options) => {
      seen.push({ binary, args, env: { ...env }, ...(options?.cwd ? { cwd: options.cwd } : {}) });
      return { code: 0, text: REAL_HOME };
    });
    await adapter.check(command("npx opencode --agent build"), { XDG_DATA_HOME: "/private/data" }, "/ws");
    // The probe receives the launcher-aware executable boundary, NOT the agent's own arguments: the
    // private home is what decides the answer, and `--agent build` would only change what runs.
    expect(seen).toEqual([{
      binary: "npx",
      args: ["opencode"],
      env: { XDG_DATA_HOME: "/private/data" },
      cwd: "/ws",
    }]);
  });

  it("appends the measured subcommand when the real probe runs the executable", async () => {
    const result = await probeOpencodeCredentials(
      process.execPath,
      ["-e", "console.log(process.argv.slice(1).join(' '))"],
      { ...process.env },
    );
    expect(result.code).toBe(0);
    expect(result.text.trim()).toBe("providers list");
  });

  it("declines a command that is not opencode", async () => {
    const adapter = new OpencodeLaunchPreflight(probeReturning({ text: EMPTY_HOME }));
    await expect(adapter.check(command("grok --model x"), {})).resolves.toEqual({
      state: "unverifiable",
      code: "runtime_preflight_unverifiable",
      reason: "runtime adapter mismatch",
    });
  });

  it("is reached through the runtime-neutral registry, not by naming opencode at the call site", async () => {
    const registry = new RuntimeLaunchPreflightRegistry({ opencode: new OpencodeLaunchPreflight(probeReturning({ text: EMPTY_HOME })) });
    await expect(registry.check(command("/usr/local/bin/opencode"), {})).resolves.toMatchObject({
      state: "unauthenticated",
      code: "runtime_auth_unavailable",
    });
  });
});

describe("t-0338fc — the gap that stays declared", () => {
  it("still declares no transcript matcher, because the silent turn is a SUCCESSFUL one", () => {
    // This is the measured hazard restated as a test: the credential-free turn looks like work.
    expect(RUNTIME_AUTH_PROFILES.opencode).toBeUndefined();
    expect(classifyAuthRequired("opencode", SILENT_FALLBACK_TURN)).toBeUndefined();
  });

  it("routes the preflight signal into the same human sentence a transcript signal produces", () => {
    const evidence = authRequiredFromPreflight("opencode", "0 credentials");
    expect(evidence).toEqual({
      runtime: "opencode",
      matchedLine: "0 credentials",
      humanAction: RUNTIME_AUTH_PREFLIGHT.opencode!.humanAction,
    });
    const sentence = describeAuthRequired("oc-agent", evidence!);
    expect(sentence).toContain("agent 'oc-agent'");
    expect(sentence).toContain("opencode");
    expect(sentence).toContain("opencode providers login");
    expect(sentence).toContain("will not retry or restart it automatically");
  });

  it("never invents a preflight signal for a runtime that declares none", () => {
    for (const runtime of ["claude", "codex", "grok", "pi", "hermes", "gemini", "qwen"]) {
      expect(authRequiredFromPreflight(runtime, "0 credentials")).toBeUndefined();
    }
    expect(authRequiredFromPreflight(undefined, "0 credentials")).toBeUndefined();
  });
});
