# 476 — codex-effective-model-proof

_Created 2026-07-26._

**Status:** shipped
**Closure:** Shipped in the `tachyon/change/codex-model-proof` worktree off `2ec2dd66`. The Codex
probe dropped `--ephemeral`, runs under a private per-run `CODEX_HOME` (auth by symlink, plugins /
remote plugins / apps / skill search disabled), correlates the `thread_id` from `thread.started` to
the one rollout that repeats it in its own `session_meta`, and reports every
`turn_context.payload.model` as `reportedNativeModels` — so `reportsEffectiveModel` is now true for
the whole fleet and `PROVENANCE_EXEMPT` is empty. `ProbeModelProof.evidence` distinguishes
`provider-usage` (Claude/Grok) from `session-record` (Codex) in the envelope, the stored metadata and
the model-cell tooltip. A new adapter `cleanup` hook is awaited by the runner on every exit path
(clean, timeout, cancel, spawn failure, throwing `interpret`), and registering the abort listener
before the now-async `buildInvocation` closes the cancellation window that widening it opened.
Evidence: `npm run verify:full:quiet` (521 files, 5887 tests), `npm run dogfood -- probe-codex-model-proof`
(10/10, against the real codex-cli 0.145.0 — proven, isolation, teardown, concurrency, timeout,
absent rollout), and `npm run dogfood -- probe-provenance-parity` (9/9).
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

**Verify:** `npm run verify:full:quiet`
**Dogfood:** `npm run dogfood -- probe-codex-model-proof`
**Dogfood:** `npm run dogfood -- probe-provenance-parity`

## Intent

SDD 473 made a probe refuse to read as evidence unless the runtime itself says which model ran.
SDD 474 narrowed that exemption to Codex alone: Grok proved capable, and Codex was measured and found
silent. `t-a10d31` recorded the measurement on codex-cli 0.145.0 — `exec --json` stdout carries only
`thread.started` / `turn.started` / `item.completed` / `turn.completed`, with no model identity in any
record. So every Codex probe launched with an explicit `model` is stored `unproven`: the answer is
kept, but it cannot be cited as proof that the requested model produced it.

The evidence does exist, one layer down. Codex writes its own session rollout to
`$CODEX_HOME/sessions/**/rollout-<ts>-<thread_id>.jsonl`, and each `turn_context` record names the
model that turn ran under. The probe never sees it because the probe passes `--ephemeral` precisely so
that no session state is persisted. That flag buys isolation and pays for it in provenance.

Done looks like: a Codex probe that requests a model either proves it from Codex's own session record —
correlated to that exact run by the `thread_id` the stream already emits, never guessed from a
timestamp, a cost, or the requested name — or fails as unproven; and the isolation that `--ephemeral`
provided is preserved by a different mechanism (a private, per-run `CODEX_HOME` that is torn down
deterministically) rather than surrendered, so probing never writes or accumulates session state in
the human's Codex home.

The evidence Codex offers is weaker than Claude's or Grok's and this spec must not blur that:
`modelUsage` is the provider's own accounting echoed back, while `turn_context.payload.model` is the
model Codex resolved locally and sent. It proves the runtime did not silently substitute a model
between the flag and the request — which is exactly the recorded failure class SDD 473 exists to catch
— and it does not prove what the provider served. That distinction is recorded with the verdict rather
than left to a reader's assumption.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: a Codex probe proves the model it was asked for**
  - **Given** a Codex probe requested with an explicit model
  - **When** the run completes and the session rollout correlated to the run's `thread_id` records
    that model in `turn_context`
  - **Then** the probe completes with verdict `proven`, the identifier Codex reported is persisted,
    and the stored evidence names its source as Codex's session record rather than provider usage.
- [x] **Scenario: a Codex model substitution is caught**
  - **Given** a Codex probe requested with an explicit model
  - **When** the correlated rollout records a different model
  - **Then** the probe fails as `model_mismatch`, naming both the requested and the reported model.
- [x] **Scenario: correlation that is not exact yields no evidence**
  - **Given** a Codex probe whose stdout carries no `thread.started`, or more than one distinct
    `thread_id`, or whose private session tree holds no rollout for that `thread_id`, or more than one
  - **When** the result is interpreted
  - **Then** no effective model is recorded, the verdict is `unproven`, and nothing is inferred from
    the newest rollout, the run's timing, its cost or the requested model.
- [x] **Scenario: the rollout that is read is the run that produced it**
  - **Given** a rollout file whose name embeds a `thread_id`
  - **When** its `session_meta` records a different session id
  - **Then** the file is refused as evidence rather than trusted on its filename.
- [x] **Scenario: the human's Codex home is never written**
  - **Given** any Codex probe — completing, timing out, crashing, or cancelled
  - **When** the run ends
  - **Then** no session, rollout, history, cache or state file has been created or modified under the
    human's `CODEX_HOME`, and the run's own private Codex home no longer exists on disk.
- [x] **Scenario: concurrent Codex probes do not read each other's evidence**
  - **Given** two Codex probes running at the same time with different requested models
  - **When** both complete
  - **Then** each proves its own model from its own private session tree, and neither is influenced by
    the other's rollout.
- [x] **Scenario: a timeout is still a timeout**
  - **Given** a Codex probe that exceeds its wall-clock budget or is cancelled
  - **When** the runner terminates it
  - **Then** the result keeps its `timeout`/`killed_signal` reason, is not relabelled a model failure,
    and the private Codex home is still removed.
- [x] Whether Codex can report its effective model is a declaration on the adapter
  (`reportsEffectiveModel`), consistent with what the adapter actually extracts.
- [x] The recorded evidence distinguishes provider-reported usage from a runtime session record, and
  that distinction is visible wherever the verdict is read, not only in source comments.
- [x] The probe's Codex invocation still loads no user config, no user rules, and no user session
  state; the isolation `--ephemeral` provided is stated and preserved by the replacement mechanism.

## Non-goals

- Inferring the effective model from cost, latency, token counts, output characteristics, the newest
  rollout on disk, or the requested model itself. Only what Codex itself recorded for this exact
  `thread_id` counts.
- Changing Claude's or Grok's provenance path, or the shared verdict rules in `modelProof.ts` beyond
  carrying the evidence source.
- Persisting the rollout itself as a probe artifact (it embeds the full prompt and system preamble);
  only the correlated identifiers are kept.
- Reading, migrating, pruning or repairing the human's existing `~/.codex/sessions` tree.
- Retrying or re-running a probe whose model could not be proven — this detects and refuses.
- Asking upstream to add model identity to `exec --json`. That remains the better long-term fix and is
  out of this repository's control; this spec removes the dependency on it.
- Publishing a release or touching Marketplace state.

## Open questions

**Resolved before implementation, from measurement on codex-cli 0.145.0 (recorded in `notes.md`).**

- _Does dropping `--ephemeral` force the probe to write into the human's Codex home?_ No. `CODEX_HOME`
  redirects the whole home, and `--ignore-user-config` documents that "auth still uses `CODEX_HOME`",
  so a private home needs the credential made reachable there. Measured: a private home plus a symlink
  to the human's `auth.json` runs successfully and writes the rollout under the private tree.
- _Is `turn_context.payload.model` a proof or an echo?_ It is Codex's resolved model for the turn,
  written locally before the request. It catches local substitution (profile, config layering,
  collaboration-mode settings, alias resolution) and does not attest what the provider served. This
  spec records it as evidence with its source named, and does not present it as provider attestation.
- _What does the private home cost?_ Measured 38 MB / first-run remote plugin and app catalog fetches
  with defaults, versus 1.2 MB and ~3 s with plugins, remote plugins and apps disabled. The probe lane
  wants the narrower surface anyway, so the disable flags are part of the invocation.
