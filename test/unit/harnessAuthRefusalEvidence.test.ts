import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HarnessManager, HarnessUnavailableError } from "../../src/harness/HarnessManager.js";
import { adapterForRuntime } from "../../src/resume/adapters.js";
import { authRequiredOf } from "../../src/runtime/authRequired.js";
import type { HarnessDef } from "../../src/config/loadConfig.js";

/**
 * t-2656d7 (SDD 495, first slice) — a harness credential refusal carries its own recovery.
 *
 * `HarnessUnavailableError` used to be a string and nothing else, which is why every caller
 * downstream could do no better than `notify(err.message, "error")` — the action-less call that lands
 * in the status bar, clipped and on a timer. The class now carries typed `AuthRequiredEvidence` when
 * (and only when) the refusal is "this runtime is not authenticated", so a caller can tell that
 * condition apart from the dozen other reasons a harness fails to materialize.
 *
 * These cases cover the throw sites per runtime rather than one representative, because the brief's
 * standing rule is that the branch is the same for every runtime: fixing it by name leaves the next
 * one broken. The runtimes with no measured login command are here for exactly that reason — they
 * must still produce evidence, they just get no button.
 */

const claude = adapterForRuntime("claude")!;
const codex = adapterForRuntime("codex")!;
const grok = adapterForRuntime("grok")!;
const opencode = adapterForRuntime("opencode")!;

const DEF: HarnessDef = { inherit: "none", mcp: { probe: { command: "true" } } };

describe("t-2656d7 — credential refusals name the runtime and the recovery", () => {
  let base: string;
  let ws: string;
  /** Deliberately empty: every runtime's real credential home has nothing in it. */
  let emptyHome: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-auth-refusal-"));
    ws = path.join(base, "ws");
    emptyHome = path.join(base, "empty-home");
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(emptyHome, { recursive: true });
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  /** Every real-home argument pointed at the same empty directory, so each runtime fails closed. */
  function manager(): HarnessManager {
    return new HarnessManager(
      ws,
      emptyHome, // realHome (claude)
      {}, // procEnv — no ambient redirect may leak in
      path.join(emptyHome, ".claude.json"),
      emptyHome, // realCodexHome
      undefined, // warn
      emptyHome, // realOpencodeDataHome
      emptyHome, // realGrokHome
      emptyHome, // realHermesHome
    );
  }

  it.each([
    ["claude", claude],
    ["codex", codex],
    ["grok", grok],
    ["opencode", opencode],
  ] as const)("%s: the refusal is typed, not merely worded", (runtime, adapter) => {
    let thrown: unknown;
    try {
      manager().materialize("worker", DEF, adapter);
    } catch (error) {
      thrown = error;
    }

    expect(thrown, `${runtime} must fail closed with no credential present`).toBeInstanceOf(HarnessUnavailableError);
    const evidence = authRequiredOf(thrown);
    expect(evidence, `${runtime} refusal must carry auth evidence`).toBeDefined();
    expect(evidence!.runtime).toBe(runtime);
    // The instruction a human acts on, read from the measured declaration rather than composed here.
    expect(evidence!.humanAction.length).toBeGreaterThan(0);
  });

  it("the grok bridge-mcp door refuses the same way, with the same evidence", () => {
    let thrown: unknown;
    try {
      manager().materializeBridgeMcpGrok("solo", { url: "http://127.0.0.1:9/mcp", headers: {} });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HarnessUnavailableError);
    expect(authRequiredOf(thrown)?.runtime).toBe("grok");
  });

  it("a NON-credential harness failure carries no evidence — it is Tachyon's problem, not a login", () => {
    // A referenced secret missing from the env is a configuration fault with no human login to run.
    // Reporting it as auth-required would offer a button that cannot possibly help.
    fs.writeFileSync(path.join(emptyHome, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "LIVE",
        refreshToken: "LIVE-refresh",
        expiresAt: Date.now() + 8 * 3_600_000,
        refreshTokenExpiresAt: Date.now() + 30 * 24 * 3_600_000,
      },
    }));
    let thrown: unknown;
    try {
      manager().materialize("worker", {
        inherit: "none",
        mcp: { probe: { command: "x", env: { NEEDS: "${DEFINITELY_NOT_IN_ENV}" } } },
      }, claude);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(authRequiredOf(thrown)).toBeUndefined();
  });

  it("the refusal text still says what it always said — this adds a channel, it changes no wording", () => {
    expect(() => manager().materialize("worker", DEF, grok))
      .toThrow(/no credentials at .*run grok login first/s);
  });
});
