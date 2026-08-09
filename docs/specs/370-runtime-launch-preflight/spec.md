# 370 — Runtime launch preflight

_Created 2026-07-10 after the failed `rtObsVendorSpike` launch._

**Status:** shipped

**Closure:** Implementation, headless dogfood, full verification, and maintainer-owned Dev Host/F5 dogfood are green
**Verify:** `npm run verify:full:quiet`
**Dogfood:** `npm run dogfood -- runtime-launch-preflight`
on implementation commit `4509f294`; final review approved the main-reanchored branch and merge commit `44deb715`
landed the runtime launch preflight closure.

## Intent

`spawn_agent` currently validates delegation shape, isolation, worktree authority, and process-count limits, but it
does not validate that the selected runtime model exists for the effective CLI/authentication environment. It returns
success as soon as tmux is created. A real RuntimeOps delegation passed `codex --model gpt-5.6`; the authenticated
Codex catalog contained `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`, not the generic slug. Codex then rejected
the request with HTTP 400 while Tachyon had already created a worktree/session, exposed a running agent, and allowed a
Task assignment.

Add a runtime-native launch-preflight boundary shared by ad-hoc spawn, declared spawn/autostart, restart, resume, and
fork. Tachyon must not own a dated provider model catalog. Each runtime adapter reports what it can verify in the
effective launch environment; Codex v1 uses `codex debug models`, normalizes only the selectable slugs, and checks an
explicit `--model` exactly. A known-invalid model fails before tmux/ledger/assignment-visible success, with no silent
fallback. Runtimes that cannot expose a catalog remain honestly unverifiable and use a bounded provisional-startup
check rather than being declared valid.

## Acceptance criteria

- [x] **Scenario: Reject a model absent from the authenticated runtime catalog**
  - **Given** an ad-hoc Codex command requests `--model gpt-5.6` and the effective `codex debug models` catalog does not
    contain that exact selectable slug
  - **When** `spawn_agent` prepares the launch
  - **Then** it returns a structured `runtime_model_unavailable` failure with bounded close matches and creates no
    tmux session, durable agent ledger row, live lineage, task assignment notice, or persistent worktree
- [x] **Scenario: Accept an exact runtime-advertised model**
  - **Given** the same effective Codex environment advertises `gpt-5.6-sol`
  - **When** an agent requests that exact slug
  - **Then** preflight succeeds and normal launch proceeds without Tachyon persisting that slug in a static catalog
- [x] **Scenario: Respect the effective isolated runtime environment**
  - **Given** a runtime launch materializes a private config/auth home or profile
  - **When** model capability is checked
  - **Then** the probe uses the same binary, relevant config/profile, authentication context, and safe environment as
    the prospective launch, without exposing credentials or full catalog payloads
- [x] **Scenario: Fail closed on a broken authoritative probe**
  - **Given** an explicit model was selected and the runtime's authoritative catalog probe times out, exits non-zero,
    exceeds output bounds, or returns malformed data
  - **When** launch preflight runs
  - **Then** launch is rejected as `runtime_preflight_failed`; Tachyon does not reinterpret probe failure as model support
- [x] **Scenario: Remain honest for runtimes without model discovery**
  - **Given** a runtime supports `--model` but exposes no safe account-aware catalog
  - **When** an explicit model is requested
  - **Then** the adapter returns `unverifiable`, never `supported`; the product applies a ratified policy and surfaces
    that limitation rather than inventing a catalog
- [x] **Scenario: Detect immediate runtime startup rejection**
  - **Given** static/dynamic preflight cannot establish an entitlement and the runtime immediately emits a classified
    auth/model/config error or exits non-zero
  - **When** the bounded provisional-startup window observes it
  - **Then** launch is reported as rejected, the session is stopped, created launch artifacts are compensated, and the
    agent is never presented as ready
- [x] **Scenario: Answer a bounded Codex bootstrap prompt without bypassing readiness**
  - **Given** a provisional Codex runtime is blocked on a recognized terminal warning, update notice, directory-trust,
    or hook-review screen before its normal composer can appear
  - **When** `write_input` is called with `answering=true` and an answer plus submit mode admitted by that exact screen
  - **Then** only that bounded answer is submitted with a distinct bootstrap receipt; arbitrary text, raw typing,
    `notify_agent`, first-contract delivery, and Task assignment remain refused until normal readiness is observed
- [x] **Scenario: Launch a genuinely isolated Extension Development Host**
  - **Given** the EDH dogfood command is run from an isolated worktree under a WSL-hosted VS Code session
  - **When** it resolves and launches the VS Code executable
  - **Then** it selects a compatible native/test binary (including the shared checkout cache), rejects the WSL
    `remote-cli/code`, uses in-memory secret storage, and removes live Tachyon/Codex/tmux identity from the EDH child
    environment while preserving fixture-private tmux/cache paths
- [x] **Scenario: Clean an isolated EDH without orphaning its persistent Bridge**
  - **Given** the fixture's native EDH started a persistent Bridge through the Electron application binary
  - **When** the EDH closes and the lane cleans its fixture
  - **Then** Electron runs the daemon in Node mode and cleanup stops the identity-matched control socket before removing
    fixture files, terminates the fixture-private tmux server, and fails closed while the recorded EDH is live or
    ownership metadata is suspicious
- [x] **Scenario: Never silently change the requested brain**
  - **Given** a requested model is unavailable but similarly named models exist
  - **When** preflight rejects it
  - **Then** Tachyon may suggest exact catalog slugs but never rewrites, aliases, downgrades, upgrades, or retries with a
    different model automatically
- [x] **Scenario: Revalidate lifecycle launches after runtime drift**
  - **Given** a previously valid declared, stopped, resumable, or forkable agent carries an explicit model that later
    disappears from the effective catalog
  - **When** start, autostart, restart, resume, or fork is requested
  - **Then** the same preflight blocks the lifecycle operation before replacing the healthy/stopped state with a false
    running state
- [x] Model discovery is runtime-adapter-owned and dynamic; `RuntimeProfile.model.aliases` remains presentation-only
- [x] Preflight output is allowlisted and bounded: model slugs/status/reason only; no base instructions, raw catalog,
  tokens, auth files, environment, absolute config paths, or provider response bodies enter logs/UI/Bridge errors
- [x] Worktree creation and other reversible preparation either occur after authoritative preflight or participate in
  an explicit compensation transaction proven by tests

## Non-goals

- Ship or periodically curate a Tachyon-owned list of provider model ids
- Guarantee entitlement for a runtime that exposes neither a catalog nor a safe dry-run capability
- Make an inference request merely to test a model during static preflight
- Automatically choose a replacement model or mutate `tachyon.yml`
- Automatically answer, approve, or trust a Codex bootstrap choice; the bounded Bridge path only carries an explicit
  caller-supplied answer after matching the visible prompt
- Redesign model-selection UI, runtime economics, or RuntimeOps observability
- Treat `supported_in_api` as equivalent to ChatGPT-account availability; runtime-native selectability is the contract
- Solve every possible failure after an agent has already performed useful work; this spec covers launch readiness

## Ratified decisions

Maintainer ratified all three recommendations on 2026-07-10:

1. An explicit model on a runtime without an authoritative catalog fails closed for delegated spawns.
2. `spawn_agent` waits synchronously for a bounded readiness window; a Task cannot be assigned to a non-ready agent.
3. The default provisional-startup window is five seconds. A runtime that is neither ready nor rejected at the
   deadline becomes `starting/pending`, never false `ready` or false failure.
4. Live EDH dogfood may answer a provisional Codex bootstrap screen only through an explicit, prompt-specific,
   closed-grammar path. Line prompts require submit; measured hook-review key gestures require `submit=false`. This does
   not promote readiness or relax assignment/notification gates.
