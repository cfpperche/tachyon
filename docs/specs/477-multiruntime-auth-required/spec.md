# 477 — multiruntime-auth-required

_Created 2026-07-27._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

An agent lost its provider login mid-run and began answering `Login expired · Please run /login`. A
completely fresh section reproduced `Not logged in`, so this was a real credential loss, not a
restart, resume or compaction defect. The private `CLAUDE_CONFIG_DIR` was stable and the credential
file was present — the human's own login had simply expired.

Tachyon read that as ordinary idleness. Nothing distinguished "this agent is thinking" from "this
agent can no longer execute anything until a human logs in". A coordinator could keep assigning work
and restarting the agent forever, and every restart would look like a fresh, healthy start.

Done looks like: an agent that cannot execute for authentication reasons says so — as human-actionable
attention naming the runtime, the agent and the safe action — its assigned work is held rather than
burned, automatic restart/retry stops, and explicit retry after a confirmed human login resumes with
the task intact. Across runtimes, that state is reached only from a **measured** signal for that
runtime; where a runtime offers none, the gap is declared rather than guessed.

The reason this is a spec and not a patch: "the agent is unauthenticated" is a new lifecycle state
that cuts across attention, notification, task assignment and restart policy, and each runtime
authenticates differently. Getting the contract right matters more than any single detector, because
a false positive parks a healthy agent and a false negative burns a task queue against a wall.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: an unauthenticated agent is named, not merely idle**
  - **Given** a runtime with a measured auth-required signal
  - **When** that signal is observed for a live agent
  - **Then** the agent surfaces as auth-required human attention naming the runtime, the agent and
    the safe human action, and is not reported as idle or as a generic crash.
  - _Launch is covered by increment 2. MID-RUN is covered by increment 3 (`t-5bfb72`): the same
    measured matcher runs against the live pane and latches `AgentAttention.authRequired`, which
    surfaces as its own sidebar badge (the row's status stays `idle` — the latch is what tells the two
    apart), a warn toast, and a notice to the parent so a coordinator stops handing it work._
- [x] **Scenario: no token is ever surfaced**
  - **Given** any auth-required notification or stored state
  - **When** it is read by a human or an agent
  - **Then** it contains no credential material, no token fragment and no credential file contents.
- [x] **Scenario: assigned work is held, not burned**
  - **Given** an agent in auth-required with an assigned task
  - **When** the state holds
  - **Then** the task remains assigned and un-executed, and no automatic restart or retry loop runs
    against the unauthenticated agent.
  - _Both of Tachyon's automatic re-entry paths are gated on the latch: the crash-restart policy is
    overridden to `never`, and rate-limit auto-continue is cancelled rather than scheduled. Nothing in
    the path touches assignment — no code reassigns or clears an assignee on this state, so the task
    stays exactly where it was._
- [x] **Scenario: explicit recovery after a human login**
  - **Given** an agent that was auth-required and a human has logged the runtime back in
  - **When** a human or coordinator explicitly restarts or retries
  - **Then** the agent runs again and its held task is still assigned.
  - _Recovery needs no new API: the latch is released by the first genuine new-turn edge, which an
    unauthenticated runtime cannot produce. So a restart that works releases the hold and restores the
    configured restart policy, while a restart into a still-broken login simply re-latches._
- [x] **Scenario: auth is distinguished from its neighbours**
  - **Given** a rate-limit, quota, permission, network or invalid-session failure
  - **When** it is classified
  - **Then** it does NOT become auth-required.
- [x] **Scenario: a runtime without a measured signal never guesses**
  - **Given** a runtime whose auth-required behavior is unmeasured or unreliable
  - **When** its agent stops working
  - **Then** Tachyon does not claim auth-required for it, and the gap is recorded.
- [x] A runtime-neutral capability declares whether a runtime can report auth-required and by what
  measured signal — no Claude-specific string or file is imposed on any peer.
- [x] `docs/runtimes/parity.md` carries an authentication/loss-of-session row per runtime with
  mechanism, measured signal, official non-interactive refresh, human action and recovery.
- [x] Auto-refresh is implemented only where the provider documents an official non-interactive flow
  that was measured; no fabricated refresh, no indiscriminate secret copying, no automatic login.

## Non-goals

- Logging any runtime in automatically, or opening an interactive login on a human's behalf.
- Copying, moving or regenerating credential material to "repair" an agent.
- Inferring authentication state from silence, exit codes alone, cost, latency or output shape.
- Changing how any runtime stores or refreshes its own credentials.
- Detecting auth-required for a runtime whose signal has not been measured (declared as a gap).
- Publishing a release or touching Marketplace state.

## Measured evidence (2026-07-27)

Every runtime was driven with an isolated, credential-free private home — the same shape Tachyon
already materializes — so nothing touched a real credential. Verbatim signals:

| Runtime | Version | Headless signal when unauthenticated |
|---|---|---|
| claude | 2.1.220 | JSON result `is_error: true`, `result: "Not logged in · Please run /login"` |
| codex | 0.145.0 | `{"type":"error"}` then `turn.failed`: `unexpected status 401 Unauthorized: Missing bearer or basic authentication in header` — after 5 automatic reconnect attempts |
| grok | 0.2.112 | `{"type":"error","message":"Not signed in. To authenticate without a browser, run:\n  grok login --device-code\n\nAlternatively, set the XAI_API_KEY environment variable…"}` |
| opencode | 1.18.4 | **none** — it answered normally on the fallback model `big-pickle` |
| pi | 0.80.10 | `No API key found for the selected model.` + `Use /login to log into a provider via OAuth or API key.` |
| hermes | 0.18.2 | `agent failed: No inference provider configured. Run 'hermes model' … or set an API key (OPENROUTER_API_KEY, OPENAI_API_KEY, etc.) in ~/.hermes/.env` |

Interactive (TUI) shapes, same conditions: codex renders a sign-in menu (`Sign in with ChatGPT` /
`Sign in with Device Code` / `Provide your own API key`); grok renders a device-code approval screen
ending in `Waiting for approval...`.

Two findings shape the design more than the table does:

**The Claude TUI footer is not a usable signal.** `Not logged in · Run /login` was observed in the
footer of a *fully functional* agent — this one, mid-task, which went on to complete that task and
several more. A pane detector keyed on that string would park healthy agents. The trustworthy Claude
signal is the one attached to a *turn*: the runtime answering the login error, which headless reports
structurally as `is_error: true` with that `result`.

**OpenCode fails silently in the dangerous direction.** With no credential it does not error; it
degrades to a fallback model and answers. There is nothing to detect, and worse, an agent can appear
healthy while running as a different model than the operator believes. That is a declared gap here,
not something to infer.

## Open questions

- **Live TUI detection for Claude — still open.** Increment 3 reads the live pane with the same
  turn-attached matcher, narrowed further: the signal must sit within the last 12 non-empty lines and
  the pane must already have gone quiet. That is enough to keep the measured false positive (the
  footer) and the obvious hazard (an agent *reading* these strings — this repository stores them
  verbatim) from parking anything. What it is NOT is a measurement: nobody has yet watched a genuinely
  expired Claude credential render live, and that reproduction cannot be fabricated from a valid one.
  So the gates are deliberately conservative, and the failure they are tuned for is the recoverable
  one: the latch withholds automatic restart/retry and asks for a human, but never stops, kills or
  rewinds anything, and any real turn releases it.
- **Codex's five automatic reconnects.** They happen inside the CLI before it reports failure. Any
  Tachyon-side retry policy must sit outside that, so the two do not compound.
- **Refresh capability.** Grok documents a non-interactive device-code flow and an env-var key; pi
  and hermes accept env-var keys. Whether Tachyon should ever drive those, versus always asking the
  human, is a product decision this spec deliberately leaves open rather than pre-empting.
