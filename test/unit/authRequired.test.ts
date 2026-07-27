import { describe, expect, it } from "vitest";
import {
  RUNTIME_AUTH_PROFILES,
  classifyAuthRequired,
  describeAuthRequired,
} from "../../src/runtime/authRequired.js";

/**
 * SDD 477 / t-16cd93 — every string below is verbatim from driving that CLI against an isolated,
 * credential-free private home on 2026-07-27. No real credential was involved in producing them.
 *
 * The two properties that matter most are negative ones: a bare Claude footer must NOT match (it was
 * observed on a fully functional agent), and no neighbouring failure — rate limit, quota, permission,
 * network, invalid session — may be swallowed into "the human must log in".
 */

/** claude 2.1.220 — headless envelope `result` when unauthenticated. */
const CLAUDE_TURN = "Not logged in · Please run /login";
/** claude 2.1.220 — the TUI FOOTER, measured on a healthy agent mid-task. */
const CLAUDE_FOOTER = "Not logged in · Run /login";
/** claude — the live wording from the original incident, same turn-attached family. */
const CLAUDE_EXPIRED = "Login expired · Please run /login";
/** codex-cli 0.145.0 — turn.failed message. */
const CODEX = 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses';
/** grok 0.2.112 — error envelope message. */
const GROK = "Not signed in. To authenticate without a browser, run:  grok login --device-code";
/** pi 0.80.10 */
const PI = "No API key found for the selected model.";
/** hermes 0.18.2 */
const HERMES = "hermes -z: agent failed: No inference provider configured. Run 'hermes model' to choose a provider";

describe("SDD 477 — measured signals classify auth-required", () => {
  it.each([
    ["claude", CLAUDE_TURN],
    ["claude", CLAUDE_EXPIRED],
    ["codex", CODEX],
    ["grok", GROK],
    ["pi", PI],
    ["hermes", HERMES],
  ] as const)("%s recognises its own measured signal", (runtime, output) => {
    const evidence = classifyAuthRequired(runtime, output);
    expect(evidence?.runtime).toBe(runtime);
    expect(evidence?.humanAction).toBeTruthy();
  });

  it("surrounding output does not hide the signal", () => {
    const pane = ["some earlier output", "", CODEX, "and a trailing line"].join("\n");
    expect(classifyAuthRequired("codex", pane)?.runtime).toBe("codex");
  });

  it("the human sentence names runtime, agent and the safe action", () => {
    const evidence = classifyAuthRequired("grok", GROK)!;
    const sentence = describeAuthRequired("worker", evidence);
    expect(sentence).toContain("worker");
    expect(sentence).toContain("grok");
    expect(sentence).toContain("grok login --device-code");
    expect(sentence).toContain("will not retry or restart it automatically");
  });

  it("evidence is bounded and carries no credential material", () => {
    const noisy = `${CODEX} ${"x".repeat(1000)}`;
    const evidence = classifyAuthRequired("codex", noisy)!;
    expect(evidence.matchedLine.length).toBeLessThanOrEqual(301);
    // These are CLI notices; nothing token-shaped should ever ride along.
    expect(evidence.matchedLine).not.toMatch(/sk-|Bearer\s+\S{8,}|eyJ[A-Za-z0-9_-]{10,}/);
  });
});

describe("SDD 477 — the false positive that would park healthy agents", () => {
  it("Claude's bare TUI footer does NOT classify as auth-required", () => {
    // Measured: this exact footer appeared on a fully functional agent, mid-task, which then
    // completed that task and several more. Matching it would stop working agents.
    expect(classifyAuthRequired("claude", CLAUDE_FOOTER)).toBeUndefined();
  });

  it("the footer stays inert even in a whole pane of ordinary output", () => {
    const pane = [
      "● Propagating… (3m 43s · ↓ 6.8k tokens)",
      "  ⎿  Tip: Use /btw to ask a quick side question",
      `                                        ${CLAUDE_FOOTER}`,
      "❯ ",
    ].join("\n");
    expect(classifyAuthRequired("claude", pane)).toBeUndefined();
  });

  it("but the turn-attached form in the same pane DOES classify", () => {
    const pane = ["● thinking", CLAUDE_TURN, "❯ "].join("\n");
    expect(classifyAuthRequired("claude", pane)?.runtime).toBe("claude");
  });
});

describe("SDD 477 — neighbouring conditions are never swallowed", () => {
  it.each([
    ["rate limit", "Error: rate limit exceeded, please retry later"],
    ["quota", "quota exceeded for this billing period"],
    ["usage limit", "You have reached your usage limit; resets at 5pm"],
    ["permission", "permission denied: cannot write to /etc"],
    ["forbidden", "403 Forbidden: not permitted"],
    ["network", "connect ECONNREFUSED 127.0.0.1:443"],
    ["invalid session", "session not found: unknown session id abc"],
  ])("%s does not become auth-required", (_label, output) => {
    for (const runtime of ["claude", "codex", "grok", "pi", "hermes"] as const) {
      expect(classifyAuthRequired(runtime, output)).toBeUndefined();
    }
  });

  it("a neighbour wins even when an auth phrase is also present", () => {
    // A 401 that arrives alongside a rate limit is not a login problem; telling the human to log in
    // would send them to the wrong place, and logging in would not help.
    expect(classifyAuthRequired("codex", `rate limit exceeded\n${CODEX}`)).toBeUndefined();
  });
});

describe("SDD 477 — absence is a declaration, never a guess", () => {
  it("opencode has no profile, because it emits no signal", () => {
    // Measured 1.18.4: with no credential it answers on the fallback model `big-pickle`. Filed as
    // t-0338fc. Declaring a matcher here would claim coverage that cannot exist.
    expect(RUNTIME_AUTH_PROFILES.opencode).toBeUndefined();
    expect(classifyAuthRequired("opencode", "> build · big-pickle\nok")).toBeUndefined();
    // Even another runtime's wording must not leak coverage to it.
    expect(classifyAuthRequired("opencode", CODEX)).toBeUndefined();
  });

  it("a runtime never matches a peer's wording", () => {
    expect(classifyAuthRequired("claude", GROK)).toBeUndefined();
    expect(classifyAuthRequired("grok", CLAUDE_TURN)).toBeUndefined();
    expect(classifyAuthRequired("hermes", PI)).toBeUndefined();
  });

  it("empty output and unknown runtimes classify nothing", () => {
    expect(classifyAuthRequired("claude", "")).toBeUndefined();
    expect(classifyAuthRequired(null, CLAUDE_TURN)).toBeUndefined();
    expect(classifyAuthRequired(undefined, CLAUDE_TURN)).toBeUndefined();
  });

  it("every declared profile states the version it was measured on", () => {
    for (const [runtime, profile] of Object.entries(RUNTIME_AUTH_PROFILES)) {
      expect(profile.source, runtime).toBe("measured");
      expect(profile.verified, runtime).toBe(true);
      expect(profile.verifiedAt, runtime).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(profile.notes.length, runtime).toBeGreaterThan(20);
    }
  });
});
