/**
 * SDD 477 (`t-16cd93`) — "this agent cannot execute until a human authenticates it".
 *
 * An agent lost its provider login mid-run and Tachyon read it as ordinary idleness, so a coordinator
 * could keep assigning work and restarting forever while every restart looked like a healthy start.
 *
 * The rule this module exists to hold: auth-required is reached ONLY from a signal that was measured
 * for that specific runtime and version. There is deliberately no shared fallback regex — a generic
 * matcher would claim coverage for runtimes whose wording nobody measured, and would have claimed it
 * for OpenCode, which emits no signal in a turn at all (it silently answers on a fallback model).
 * OpenCode's real signal turned out to live one step earlier — see `RUNTIME_AUTH_PREFLIGHT`
 * (`t-0338fc`), which is a second declaration rather than a loosening of this one.
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
  /**
   * How deep into the pane tail this runtime's signal may sit, when the default window cannot reach
   * it. Declared per runtime and only from measurement, because the number is a property of that
   * TUI's chrome height, not a preference: a window shorter than the chrome can never see turn
   * output at all, and a window longer than needed keeps stale text eligible for longer.
   */
  paneTailLines?: number;
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
    signals: [
      // Measured headless: {"type":"error","message":"Not signed in. To authenticate without a browser, run: …"}
      /\bnot signed in\b[^\n]{0,80}\b(?:grok login|authenticate)\b/i,
      // t-73ea6a — measured IN-PANE, which is the form the overlay actually sees. The provider
      // rejects the credential mid-turn and Grok renders its message verbatim:
      //   Retry failed: API error (status 400 Bad Request): invalid-argument: Incorrect API key
      //   provided. You can obtain an API key from https://console.x.ai.
      // The match is anchored on the PROVIDER's rejection, never on the `Retry failed` / `Turn
      // failed` wrapper around it. That wrapper is generic: it carries rate limits, 403s and
      // transport failures with equal enthusiasm, and matching it would make every failed turn look
      // like a login problem — the exact collapse NEIGHBOURS exists to prevent.
      /\binvalid-argument:\s*incorrect api key provided\b/i,
    ],
    // Measured: the failure text sits 24 non-empty lines from the bottom, because Grok's own bottom
    // chrome (composer box, footer, block glyphs) is 12 lines tall on its own — so the shared
    // 12-line window can never reach this runtime's turn output, which is why the state was
    // measurable and still unconsumed. Bytes: test/fixtures/grok-composer/post-turn.pane.txt.
    paneTailLines: 28,
    humanAction: "run `grok login --device-code`, or set XAI_API_KEY, then restart the agent explicitly",
    nonInteractiveRefresh: "grok login --device-code, or the XAI_API_KEY environment variable",
    source: "measured",
    verified: true,
    verifiedAt: "2026-07-28",
    notes:
      "grok 0.2.112. The interactive TUI renders a device-code approval screen ending in 'Waiting for approval...'. "
      + "The in-pane signal was captured by t-d2a4dc against a real canonical agent and is turn-attached: it is the "
      + "provider's answer to a turn, not chrome, so it cannot be present on an agent that never tried to work.",
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
  // opencode: deliberately absent HERE, and this absence is now a measured statement rather than an
  // open gap. Re-measured on 1.18.5 (t-0338fc): with an empty XDG_DATA_HOME it still does not error —
  // it answers on the fallback model `big-pickle` — and `--format json` carries no model field either,
  // so there is nothing in a turn to match. Its auth-required signal is a PRE-LAUNCH one instead; see
  // RUNTIME_AUTH_PREFLIGHT below.
};

/**
 * `t-0338fc` — runtimes whose auth-required signal is a **pre-launch query of the runtime's own
 * credential store**, not anything the runtime writes into a turn.
 *
 * This exists because OpenCode fails in the one direction a transcript matcher cannot see: with no
 * credential it does not error, it silently degrades to a fallback model and answers. Measured three
 * ways on 1.18.5 before landing here — `run --format json` reports no model at all, the effective
 * model (`big-pickle`) surfaces only in session storage *after* the turn, and an explicit `-m` pin
 * fails rather than degrading — so the only thing that answers "is this runtime authenticated?"
 * *before* work is burned is asking its credential store directly.
 *
 * It is declared alongside the output matchers on purpose: "which runtimes can report auth-required,
 * and by what measured signal" stays one list to read, with the mechanism named rather than implied.
 *
 * The honest bound, stated once here rather than re-derived at each call site: this proves a
 * credential is READABLE, not that it is VALID. An expired token is still an inventory entry.
 */
export interface RuntimeAuthPreflightProfile {
  /** The command whose output was measured. Recorded so a future version bump can be re-measured. */
  probe: string;
  /** Plain instruction for the human. Never contains credential material. */
  humanAction: string;
  source: "measured";
  verified: true;
  verifiedAt: string;
  notes: string;
}

export const RUNTIME_AUTH_PREFLIGHT: Partial<Record<ResumeRuntime, RuntimeAuthPreflightProfile>> = {
  opencode: {
    probe: "opencode providers list",
    humanAction:
      "run `opencode providers login` (or set a provider API key in the agent's environment), then launch the agent again",
    source: "measured",
    verified: true,
    verifiedAt: "2026-07-27",
    notes:
      "opencode 1.18.5. The store answers positively rather than staying silent: an empty private home prints "
      + "'0 credentials', a real one lists each provider and its count, and environment-provided keys are reported "
      + "as their own 'Environment' section — so BOTH of OpenCode's authentication paths are covered. The probe is "
      + "local: measured working from a cold private home with the network black-holed, in under a second.",
  },
};

/**
 * `t-2656d7` (SDD 495, first slice) — the runtime's OWN login command: the single action Tachyon
 * offers when a launch is refused for credentials.
 *
 * Declared here, beside the turn matchers and the pre-launch probe, for the reason `t-0338fc`
 * already gave: "which runtimes can report auth-required, and by what measured signal" stays one
 * list to read. This is the RECOVERY half of that same list.
 *
 * Absence is a declaration, exactly as above. A runtime with no entry gets no `Log in` control —
 * the refusal still reaches the human as a persistent, actioned notice, it simply carries no
 * command nobody measured. Guessing one opens a pane that fails in a way a human cannot tell apart
 * from being logged out, which is worse than offering nothing.
 *
 * Two measurements (SDD 495 `plan.md` §2.2, 2026-08-07) decide that the surface has to be a real
 * terminal the human types into, and they are why this is a `command` for a PTY rather than
 * something Tachyon could capture and render itself:
 *
 *  1. **Claude's login blocks on typed input.** It ends at `Paste code here if prompted >`, so a
 *     webview that merely displays a device code cannot serve it.
 *  2. **Grok's login prints nothing on a pipe.** Two captures (plain pipe; `script` with the
 *     typescript discarded) produced zero bytes; only the tmux capture carried the URL and code.
 *
 * Tachyon never writes to that pane. The human types; Tachyon allocates the PTY and gets out of the
 * way — the same rule that forbids a blind Enter into a runtime CLI, applied to the one pane where a
 * stray keystroke would land on a credential prompt.
 */
export interface RuntimeLoginProfile {
  /** The command line, run in a governed PTY. Tachyon never writes to its stdin. */
  command: string;
  /**
   * Measured: does the human TYPE into this pane, or only read a code and confirm elsewhere? Both
   * need a PTY (see above); the distinction is recorded because it is the property a future
   * non-terminal surface would have to satisfy, and it must be re-measured rather than assumed.
   */
  surface: "interactive-pty" | "device-code-pty";
  source: "measured";
  verified: true;
  verifiedAt: string;
  notes: string;
}

export const RUNTIME_LOGIN: Partial<Record<ResumeRuntime, RuntimeLoginProfile>> = {
  claude: {
    // `claude auth login` is a real subcommand on 2.1.224 and runs OUTSIDE the agent TUI, which is
    // what makes a short-lived login pane possible at all. The `/login` slash command named by
    // `RUNTIME_AUTH_PROFILES.claude.humanAction` is typed INSIDE a running Claude, so it cannot be a
    // pane command. Whether the recommended human wording should switch to this subcommand is SDD
    // 495 Q4 and is still open — this entry does not answer it and does not touch `humanAction`.
    command: "claude auth login",
    surface: "interactive-pty",
    source: "measured",
    verified: true,
    verifiedAt: "2026-08-07",
    notes:
      "Claude Code 2.1.224. Browser OAuth followed by a paste-back prompt: the flow ends at "
      + "'Paste code here if prompted >' and waits, so this pane must accept typed input.",
  },
  codex: {
    command: "codex login",
    surface: "device-code-pty",
    source: "measured",
    verified: true,
    verifiedAt: "2026-08-07",
    notes:
      "codex-cli 0.146.1. Loopback-browser sign-in; the CLI polls and needs no typed input. "
      + "`codex login --device-auth` is the browserless variant. The stdin key paths "
      + "(--with-api-key / --with-access-token) are deliberately NOT offered: driving one would make "
      + "Tachyon a process holding raw key bytes.",
  },
  grok: {
    // The device-code variant, matching the wording `RUNTIME_AUTH_PROFILES.grok.humanAction` has
    // already been telling humans since 2026-07-28, so the button runs what the sentence says.
    command: "grok login --device-code",
    surface: "device-code-pty",
    source: "measured",
    verified: true,
    verifiedAt: "2026-08-07",
    notes:
      "grok 1.0.0. `--device-code` is an alias of `--device-auth`. Display-only (the CLI polls), but "
      + "it renders NOTHING on a pipe — measured silent across two capture styles — so it needs a PTY "
      + "even though nobody types into it.",
  },
  // opencode / pi / hermes: deliberately absent, and the absence is the honest answer rather than a
  // gap nobody noticed. `opencode auth login` was not measured by SDD 495; Pi authenticates through
  // `/login` INSIDE Pi (no standalone subcommand to put in a pane); Hermes takes a provider key in
  // `~/.hermes/.env` or a `hermes model` selection, which is not a login flow. Each still gets the
  // persistent, readable refusal — just no button. `docs/runtimes/parity.md` carries the gaps.
};

/** The measured native login for a runtime, or undefined when nobody measured one. */
export function runtimeLoginCommand(runtime: ResumeRuntime | null | undefined): string | undefined {
  if (!runtime) return undefined;
  return RUNTIME_LOGIN[runtime]?.command;
}

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
 * Build launch-boundary evidence from a credential-store report, so a preflight refusal reaches the
 * human through exactly the same sentence as a transcript-detected one (`describeAuthRequired`).
 *
 * `reportedLine` is the store's own summary line (`0 credentials`) — a count, never a secret.
 * Returns undefined for any runtime without a declared preflight profile, which is the same refusal
 * `classifyAuthRequired` makes for a runtime without a declared matcher.
 */
export function authRequiredFromPreflight(
  runtime: string | null | undefined,
  reportedLine: string,
): AuthRequiredEvidence | undefined {
  if (!runtime) return undefined;
  // The lookup IS the narrowing: a key present in this record is a declared ResumeRuntime by
  // construction, and an unknown name falls out as undefined rather than being coerced into one.
  const declared = runtime as ResumeRuntime;
  const profile = RUNTIME_AUTH_PREFLIGHT[declared];
  if (!profile) return undefined;
  const trimmed = reportedLine.trim();
  return {
    runtime: declared,
    matchedLine: trimmed.length > MAX_EVIDENCE_CHARS ? `${trimmed.slice(0, MAX_EVIDENCE_CHARS)}…` : trimmed,
    humanAction: profile.humanAction,
  };
}

/**
 * `t-2656d7` — launch-boundary evidence from a HARNESS credential refusal.
 *
 * The harness refuses before any pane exists: the runtime's credential is absent, unreadable or
 * expired in the home the private one is projected from (`HarnessManager`'s credential throw sites).
 * That is the same condition `classifyAuthRequired` reports mid-run and `authRequiredFromPreflight`
 * reports for OpenCode — so it produces the same value, travels the same channel, and reads in the
 * same words. One condition, one vocabulary; the owner's case was two presentations of one state.
 *
 * The human action is read from whichever declaration measured that runtime, never composed here: a
 * second source of wording is a second thing to go stale, and the sentence a human acts on must be
 * the measured one. A runtime declared by neither returns undefined — the same refusal every other
 * constructor in this module makes when nobody measured the runtime.
 *
 * `reportedLine` is the harness's own refusal text: a path and an instruction, never credential
 * content. It is bounded like every other echoed line.
 */
export function authRequiredFromHarness(
  runtime: string | null | undefined,
  reportedLine: string,
): AuthRequiredEvidence | undefined {
  if (!runtime) return undefined;
  // The lookups ARE the narrowing, as in `authRequiredFromPreflight`: a key present in either record
  // is a declared ResumeRuntime by construction, and an unknown name falls out as undefined.
  const declared = runtime as ResumeRuntime;
  const profile = RUNTIME_AUTH_PROFILES[declared];
  const humanAction = profile?.humanAction ?? RUNTIME_AUTH_PREFLIGHT[declared]?.humanAction;
  if (!humanAction) return undefined;
  const trimmed = reportedLine.trim();
  return {
    runtime: declared,
    matchedLine: trimmed.length > MAX_EVIDENCE_CHARS ? `${trimmed.slice(0, MAX_EVIDENCE_CHARS)}…` : trimmed,
    humanAction,
    ...(profile?.nonInteractiveRefresh ? { nonInteractiveRefresh: profile.nonInteractiveRefresh } : {}),
  };
}

/**
 * `t-5bfb72` — how much of a LIVE pane may carry the signal, counted in non-empty lines from the
 * bottom. A launch capture is a short, purpose-built read and scans whole; a running agent's pane is
 * scrollback, and scrollback is full of text the agent merely *looked at*. This repository is the
 * sharpest case: `test/unit/authRequired.test.ts` holds every measured signal verbatim, so an agent
 * that opens that file has the bytes on screen while being perfectly authenticated.
 *
 * 12 clears the tallest composer frame we profile (the login notice sits above it, and the runtime
 * hint lines below) without reaching back into the body of the turn.
 */
export const AUTH_SIGNAL_TAIL_LINES = 12;

/**
 * Classify runtime output as auth-required, or not at all.
 *
 * Returns undefined for every runtime without a measured profile, and for every output that matches a
 * neighbouring condition first. Both are the same deliberate refusal: without measured evidence this
 * must not guess, because a false positive parks a healthy agent and a false negative burns a queue.
 *
 * `tailLines` bounds where the SIGNAL may sit (non-empty lines from the bottom); neighbours are still
 * excluded from the whole output, because a rate limit anywhere in view is a reason to stay quiet.
 */
export function classifyAuthRequired(
  runtime: ResumeRuntime | null | undefined,
  output: string,
  opts?: { tailLines?: number },
): AuthRequiredEvidence | undefined {
  if (!runtime) return undefined;
  const profile = RUNTIME_AUTH_PROFILES[runtime];
  if (!profile || !output) return undefined;
  // Neighbours win outright: they are separate conditions with separate recoveries.
  if (NEIGHBOURS.some((pattern) => pattern.test(output))) return undefined;
  let lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  // A declared per-runtime window wins over the shared default: it was measured against that TUI's
  // chrome, and the caller's default cannot know how tall that chrome is.
  const tailLines = profile.paneTailLines ?? opts?.tailLines;
  if (tailLines !== undefined) lines = lines.slice(-tailLines);
  for (const trimmed of lines) {
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

/**
 * `t-2656d7` — read the auth-required evidence an error carries, if any.
 *
 * Structural rather than `instanceof`, and that is a decision with a reason: two unrelated classes
 * already carry this field for the same meaning — `HarnessUnavailableError` (the launch boundary,
 * before a pane) and `RuntimeLaunchReadinessError` (a rejected launch, after one) — and they live in
 * layers that must not import each other. The alternative a caller would otherwise reach for is
 * matching the message text, which is the failure mode this repository has paid for.
 *
 * Validation is deliberately narrow: this reads a value Tachyon itself attached one call earlier, so
 * the check is "is this the shape we write?", not a parser for untrusted input.
 */
export function authRequiredOf(error: unknown): AuthRequiredEvidence | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = (error as { authRequired?: unknown }).authRequired;
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const { runtime, humanAction } = candidate as { runtime?: unknown; humanAction?: unknown };
  if (typeof runtime !== "string" || typeof humanAction !== "string") return undefined;
  return candidate as AuthRequiredEvidence;
}

/** The human-facing sentence. Names runtime, agent and the safe action; never a credential. */
export function describeAuthRequired(agent: string, evidence: AuthRequiredEvidence): string {
  return `agent '${agent}' cannot run: the ${evidence.runtime} runtime reports it is not authenticated`
    + ` — ${evidence.humanAction}. Tachyon will not retry or restart it automatically.`;
}
