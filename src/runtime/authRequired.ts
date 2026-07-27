/**
 * SDD 477 (`t-16cd93`) — "this agent cannot execute until a human authenticates it".
 *
 * An agent lost its provider login mid-run and Tachyon read it as ordinary idleness, so a coordinator
 * could keep assigning work and restarting forever while every restart looked like a healthy start.
 *
 * The rule this module exists to hold: auth-required is reached ONLY from a signal that was measured
 * for that specific runtime and version. There is deliberately no shared fallback regex — a generic
 * matcher would claim coverage for runtimes whose wording nobody measured, and would have claimed it
 * for OpenCode, which emits no signal at all (it silently answers on a fallback model, `t-0338fc`).
 *
 * Two measured facts constrain every matcher here:
 *
 *  1. **A bare footer is not evidence.** Claude's TUI footer `Not logged in · Run /login` was observed
 *     on a fully functional agent, mid-task, which then completed that task and several more. The
 *     trustworthy Claude signal is attached to a TURN — the runtime *answering* the login error, which
 *     its headless envelope reports as `is_error` plus that `result`. So the Claude matcher requires
 *     the turn-attached form and the footer alone is explicitly excluded.
 *  2. **Neighbours must not be swallowed.** Rate limit, quota, permission, network and invalid-session
 *     failures are their own conditions with their own recoveries. They are excluded before any
 *     matcher runs, so "the agent is stuck" never collapses into "the human must log in".
 */

import type { ResumeRuntime } from "../resume/adapters.js";

/** What a human must do, and whether the provider documents a non-interactive path. */
export interface RuntimeAuthProfile {
  /** Measured signals that the runtime cannot execute for authentication reasons. */
  signals: RegExp[];
  /** Plain instruction for the human. Never contains credential material. */
  humanAction: string;
  /**
   * An OFFICIAL, documented non-interactive re-authentication flow, when the provider has one.
   * Recorded for the operator; Tachyon does not drive it (SDD 477 keeps recovery human-explicit).
   */
  nonInteractiveRefresh?: string;
  /** Provenance, in the same shape the other runtime capabilities use. */
  source: "measured";
  verified: true;
  verifiedAt: string;
  notes: string;
}

/**
 * Conditions that are NOT authentication, checked first so a matcher can never swallow them.
 * Each has its own recovery and would be actively harmful to report as "log in again".
 */
const NEIGHBOURS: RegExp[] = [
  // rate limit / quota — the credential is fine, the budget is not
  /\b(?:rate[- ]?limit(?:ed|ing)?|too many requests|quota exceeded|usage limit|429)\b/i,
  // permission / authorization of an ACTION, not of the principal
  /\b(?:permission denied|not permitted|forbidden|403)\b/i,
  // network / transport
  /\b(?:ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network (?:error|unreachable)|connection refused)\b/i,
  // a session that is invalid or gone — resume territory, not login territory
  /\b(?:session (?:not found|expired|invalid)|no such session|unknown session id)\b/i,
];

/**
 * Per-runtime measured signals. Absence is a declaration: a runtime with no entry can never be
 * reported auth-required, which is the honest outcome when nobody has measured it.
 *
 * Every regex below is anchored on wording captured 2026-07-27 by driving that CLI against an
 * isolated, credential-free private home — the same shape Tachyon already materializes, so no real
 * credential was involved. The verbatim captures live in `docs/specs/477-multiruntime-auth-required/`.
 */
export const RUNTIME_AUTH_PROFILES: Partial<Record<ResumeRuntime, RuntimeAuthProfile>> = {
  claude: {
    // Measured headless: {"is_error": true, "result": "Not logged in · Please run /login"}.
    // `Please run /login` is the turn-attached wording; the FOOTER hint is `Run /login` without the
    // `Please`, and that footer was seen on a healthy agent — so the `Please` is load-bearing here,
    // not incidental phrasing. `Login expired` is the same turn-attached family, reported live.
    signals: [/\b(?:not logged in|login expired)\b[^\n]{0,40}\bplease run \/login\b/i],
    humanAction: "run /login in the Claude runtime, then restart the agent explicitly",
    source: "measured",
    verified: true,
    verifiedAt: "2026-07-27",
    notes:
      "Claude Code 2.1.220. Turn-attached only: the TUI footer 'Not logged in · Run /login' was observed on a "
      + "fully functional agent mid-task, so the footer alone is a measured false positive and must not match.",
  },
  codex: {
    // Measured: {"type":"error"} then turn.failed carrying the provider's own 401 wording. Codex
    // reconnects five times internally before reporting, so any Tachyon retry must sit outside that.
    signals: [/\b401 unauthorized\b[^\n]{0,80}\bmissing bearer or basic authentication\b/i],
    humanAction: "sign in to Codex (ChatGPT, device code, or an API key), then restart the agent explicitly",
    nonInteractiveRefresh: "codex offers a device-code sign-in and an API-key option",
    source: "measured",
    verified: true,
    verifiedAt: "2026-07-27",
    notes:
      "codex-cli 0.145.0. The CLI retries 5 times before surfacing this; the interactive TUI instead renders a "
      + "sign-in menu (ChatGPT / Device Code / API key).",
  },
  grok: {
    // Measured: {"type":"error","message":"Not signed in. To authenticate without a browser, run: …"}
    signals: [/\bnot signed in\b[^\n]{0,80}\b(?:grok login|authenticate)\b/i],
    humanAction: "run `grok login --device-code`, or set XAI_API_KEY, then restart the agent explicitly",
    nonInteractiveRefresh: "grok login --device-code, or the XAI_API_KEY environment variable",
    source: "measured",
    verified: true,
    verifiedAt: "2026-07-27",
    notes: "grok 0.2.112. The interactive TUI renders a device-code approval screen ending in 'Waiting for approval...'.",
  },
  pi: {
    // Measured: "No API key found for the selected model." + "Use /login to log into a provider …"
    signals: [/\bno api key found\b[^\n]{0,60}\bselected model\b/i],
    humanAction: "run /login in Pi, or set the provider API-key environment variable, then restart the agent explicitly",
    nonInteractiveRefresh: "an API key via --api-key or the provider environment variable",
    source: "measured",
    verified: true,
    verifiedAt: "2026-07-27",
    notes: "pi 0.80.10. Plain-text wording rather than a structured envelope, so the matcher stays narrow.",
  },
  hermes: {
    // Measured: "agent failed: No inference provider configured. Run 'hermes model' … or set an API key"
    signals: [/\bno inference provider configured\b/i],
    humanAction: "run `hermes model` to choose a provider, or set a provider API key in ~/.hermes/.env, then restart the agent explicitly",
    nonInteractiveRefresh: "a provider API key in ~/.hermes/.env or the environment",
    source: "measured",
    verified: true,
    verifiedAt: "2026-07-27",
    notes: "Hermes 0.18.2. Plain-text wording rather than a structured envelope, so the matcher stays narrow.",
  },
  // opencode: deliberately absent. Measured on 1.18.4 with an empty XDG_DATA_HOME, it does not error —
  // it answers on the fallback model `big-pickle`. There is nothing to match, and an agent can look
  // healthy while running a model nobody chose. Tracked as t-0338fc.
};

export interface AuthRequiredEvidence {
  runtime: ResumeRuntime;
  /** The matched line, trimmed and bounded. Never carries credential material — these are CLI notices. */
  matchedLine: string;
  humanAction: string;
  nonInteractiveRefresh?: string;
}

/** Longest line we will echo back into a notification; a CLI notice is never near this. */
const MAX_EVIDENCE_CHARS = 300;

/**
 * Classify runtime output as auth-required, or not at all.
 *
 * Returns undefined for every runtime without a measured profile, and for every output that matches a
 * neighbouring condition first. Both are the same deliberate refusal: without measured evidence this
 * must not guess, because a false positive parks a healthy agent and a false negative burns a queue.
 */
export function classifyAuthRequired(
  runtime: ResumeRuntime | null | undefined,
  output: string,
): AuthRequiredEvidence | undefined {
  if (!runtime) return undefined;
  const profile = RUNTIME_AUTH_PROFILES[runtime];
  if (!profile || !output) return undefined;
  // Neighbours win outright: they are separate conditions with separate recoveries.
  if (NEIGHBOURS.some((pattern) => pattern.test(output))) return undefined;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!profile.signals.some((pattern) => pattern.test(trimmed))) continue;
    return {
      runtime,
      matchedLine: trimmed.length > MAX_EVIDENCE_CHARS ? `${trimmed.slice(0, MAX_EVIDENCE_CHARS)}…` : trimmed,
      humanAction: profile.humanAction,
      ...(profile.nonInteractiveRefresh ? { nonInteractiveRefresh: profile.nonInteractiveRefresh } : {}),
    };
  }
  return undefined;
}

/** The human-facing sentence. Names runtime, agent and the safe action; never a credential. */
export function describeAuthRequired(agent: string, evidence: AuthRequiredEvidence): string {
  return `agent '${agent}' cannot run: the ${evidence.runtime} runtime reports it is not authenticated`
    + ` — ${evidence.humanAction}. Tachyon will not retry or restart it automatically.`;
}
