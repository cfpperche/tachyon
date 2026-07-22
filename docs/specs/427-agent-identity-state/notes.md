# 427 — agent-identity-state — notes

_Created 2026-07-22._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## 2026-07-22 — current-state inventory

- `agent.yml` already models `prompt.soul`, `prompt.instructions`, `prompt.evolution` and
  `prompt.memory`, with typed digest-bound references, but `agentProfileProjection.ts` deliberately
  rejects every one as owned by `t-a2827d`.
- Legacy instructions are an inline `tachyon.yml` string flattened into `ManagedEntryDef.instructions`.
  Soul and `selfEvolution.enabled` are also inline selectors.
- Soul bytes already live at `.tachyon/agents/<agent>/SOUL.md` and have a durable transaction, but the
  v1 subordinate manifest binds `profileId` to mutable `owner` name rather than primary `agentId`.
- Evolution already separates active `LEARNINGS.md`/`skills` from candidates, reviews, history and
  recovery intents, and its active head is host-custodied. Its v1 profile/head are still primarily
  keyed by agent name/profile id and need an `agentId` join.
- Existing prompt composition has explicit Soul, role, Persistent Instructions, Evolution, guidance
  and task layers. Evolution/Soul session facts are recorded, but there is no single formation
  snapshot binding the canonical profile revision and every selected lane.
- No selected runtime-memory store exists. SDD 423 defines the trust boundary, but policy,
  delegation, activation-head and renderer implementation are new work and should not be smuggled in
  as ordinary file discovery.
- Rename/forget already have Soul/Evolution-specific behavior, while profile-backed Agent Studio
  lifecycle was explicitly deferred by SDD 426. This task must expose safe lane primitives and leave
  complete UI orchestration to `t-e50d4f`.

## 2026-07-22 — first adversarial review blocked implementation

Probe `probe-94a126a0-e794-4b14-b18c-abcdab5dd83f` found that the first draft had no complete authority
graph, allowed lane-local identity downgrade, described a digest-only snapshot that could not preserve
resume bytes, grouped session operations with different transfer semantics, and treated
runtime-managed memory too casually despite delegating durable prompt-writing power. It also found
ambiguous Evolution precedence, unsafe legacy fallback, non-vertical slices, lifecycle overlap with
`t-e50d4f`, and an unproved plugin boundary.

The contract was rewritten before code:

- `ProfileActivationHeadV2`, `EvolutionActivationHeadV2`, `MemoryActivationHeadV1` and
  `FormationSessionSelectorV1` now have separate subjects and trusted mutation operations;
- every enabled lane is required, so failure blocks the complete fresh formation;
- the host snapshot retains exact rendered bytes and Evolution skill artifacts, not only digests;
- fresh formation uses a complete authority revision-vector read barrier and atomic selector commit;
- restart/resume/rebind/re-anchor/fork have distinct identity/principal/runtime transition rules;
- Evolution uses one host-authorized complete active inventory, never directory discovery;
- legacy/profile mode is authority-recorded with no corruption-triggered fallback;
- runtime-managed memory moved to a separate future spec; SDD 427 permits only human promotion;
- the plan now uses end-to-end lane slices and leaves cross-lane lifecycle orchestration to `t-e50d4f`;
- plugins are excluded from formation/snapshot/lifecycle and receive explicit compatibility fixtures.

Full review evidence is retained at
`.tachyon/probes/probe-94a126a0-e794-4b14-b18c-abcdab5dd83f/result.json`.

## 2026-07-22 — second adversarial review blocked implementation

Probe `probe-38fe7be2-b857-4845-b931-bbfa23dce0f8` found that stable individual revisions still did not
authorize their combination, snapshot/selector publication lacked a crash-safe commit protocol, and
fresh-session ownership/replay authority was unspecified. It also required an exact migration cutover
state machine and removal of profile-like content from re-anchor's mutable session inputs.

The second correction added one host `FormationGenerationHeadV1` that binds the complete compatible
tuple, a transactional `FormationAuthorityStore`, durable-object/prepared-manifest/atomic-selector
publication with GC leases and recovery, authenticated idempotent fresh/fork creation, a single
migration cutover point, and a snapshot-only formation reminder for re-anchor. Full evidence is at
`.tachyon/probes/probe-38fe7be2-b857-4845-b931-bbfa23dce0f8/result.json`.

## 2026-07-22 — third focused review required two final bindings

Probe `probe-6984a192-32ab-40db-aa7b-323d6754ed8e` found no blocker, but correctly rejected a selector
commit that was not CAS-bound to the exact current formation generation and a re-anchor reminder that
could be rerendered later. Snapshot and selector now bind the generation/digest, publication aborts if
that generation changed or retired, and the immutable payload includes exact pre-rendered re-anchor
bytes/framing. Full evidence is retained at
`.tachyon/probes/probe-6984a192-32ab-40db-aa7b-323d6754ed8e/result.json`.

## 2026-07-22 — final ratification

Probe `probe-55abb9f0-c050-4bd1-94e8-4117dcd33e55` returned no findings and approved decomposition and
implementation. It confirmed that selector publication CASes the exact current non-retired formation
generation and that re-anchor consumes immutable pre-rendered bytes. Implementation was decomposed
into `t-4d6385` (foundation), `t-8f4420` (Soul/instructions), `t-59cbd6` (Evolution), `t-7217e1`
(human-approved memory) and `t-3ef947` (integration). Runtime-managed memory is isolated in
`t-d4c42e`.

## 2026-07-22 — foundation implementation and closure review

The foundation implements the closed authority model without enabling any new lane: validated v2
profile/lane heads, the complete formation-generation vector, immutable content-addressed objects,
prepared publication leases, atomic selector commit, exact fresh/fork replay, live lineage checks and
dedicated read/revocation authorization. The compatibility converter starts every legacy v1 lane in
`disabled`; plugin paths and plugin-shaped namespaces are rejected from the Evolution skill inventory.

Adversarial code review was intentionally iterative:

- `probe-22efc983-563e-4e80-a54c-1bf560149c65` found the original caller-owned payload, weak mutation
  labels, unsafe paths, non-expiring ownerless leases, wrong revocation capability and missing cascade.
- `probe-288a640f-1333-48fc-95c9-5485f3ef3509` found rollback-unsafe GC, orphan disabled-lane heads,
  incomplete caller replay identity, unsafe authority-root handling and textual time ordering.
- `probe-cab35658-ea1f-42fa-ba3a-52de01b06d84` found prepare-to-commit caller takeover, fabricated
  bootstrap history, insufficient object-store directory protection and reusable expired operations.
- `probe-d2b9b556-a07f-422a-95a7-a46bb3f38b5d` found unauthenticated payload reads and leases that
  could expire between the final heartbeat and publication.
- `probe-b5998afc-1855-4425-aa2b-a5c46904958b` found missing manifest-digest verification and
  crash-abandoned staging files outside GC.

All findings were converted into fixed-oracle regressions. Payload bytes now come only from a trusted
resolver bound to the exact authority vector and renderer set; caller principal and kind are bound
from prepare through commit/read/replay; every lease transition checks owner, state and numeric expiry;
expired operation ids become terminal tombstones; GC commits reference removal before deleting files;
manifests and objects are integrity-read before publication; private roots reject symlinks, foreign
owners and non-private permissions; revocation cascades over the complete root lineage; and stale
staging is collected after a conservative grace period.

Closure probe `probe-d7974bda-f6ee-47ad-aacd-c165da7111f1` returned no blocker or major findings.
Focused evidence: `test/unit/agentFormationFoundation.test.ts` (17 tests). Full probe artifacts remain
under `.tachyon/probes/<probe-id>/result.json`.

## 2026-07-22 — Soul and Persistent Instructions implementation

The human-lane slice makes `.tachyon/agents/<agent>/agent.yml` the exact profile authority for Soul
and Persistent Instructions. Soul manifests accept legacy v1 for discovery but active resolution
requires v2 bound to immutable `agentId`; the coordinated legacy cutover upgrades that manifest in
the same recoverable operation that publishes `agent.yml`, `instructions.md`, the config pointer and
the next formation generation. There is no corruption-triggered fallback to inline legacy fields.

Persistent Instructions and Soul bytes are bounded, UTF-8/no-follow reads selected by pinned profile
references. The active profile digest, selector, subordinate identity, path and source digest are all
checked before rendering. Native runtime suppression is represented by a host-keyed HMAC receipt
bound to the exact fresh operation, authority vector, adapter, trust class, enabled lane set and a
bounded issuance time. Startup and fixed re-anchor bytes are then stored in the immutable formation
snapshot; re-anchor excludes one-run task text.

Source publication and authority replacement use one durable mutation barrier. Beginning the barrier
terminally abandons pre-existing fresh leases for that agent, and `commitFresh` also rejects an active
barrier. The barrier commits the exact caller, mutation, workspace, agent, prior generation and next
vector. Descriptor-rooted source replacement uses staged files plus recoverable custody links and
directory-fsync checkpoints. Crash recovery either restores every prior byte before recording a
rolled-back receipt or completes the exact next bytes/generation before recording a committed receipt.
Terminal receipts make commit/recovery idempotently inspectable without exposing stored source bytes.
Retirement preserves the exact lane heads and performs the single active-to-retired generation
transition required by the foundation contract.

Adversarial review was iterative. `probe-9200b5af-db0d-4f51-a054-2aa9dfbfb218` identified the missing
coordinated cutover, weak mutation authorization and lifecycle placeholders. `probe-15c22795-0e52-40ff-8ec0-1546b759202d`
found fresh leases crossing the barrier, unsafe abort, replayable suppression, source TOCTOU, missing
Soul-byte validation and incomplete transaction identity. The full-patch closure reviews
`probe-1117286b-9288-43c6-807b-978069da0540` and `probe-c48613f9-2ac6-4d72-9ad2-5f543c4761fa`
then found exact barrier-intent, legacy-source and fsync gaps; each became a regression or explicit
validation. Final probes `probe-91498aa6-aa3c-4219-82a9-22984a7eacdd` and
`probe-881d4e5c-57ac-4172-8eee-9901a1cad89c` confirmed the remaining canonical-path correction and
returned no blocker/major finding. Detailed probe artifacts remain under `.tachyon/probes/<probe-id>/result.json`.

## Verification log

### 2026-07-22T18:50:42Z — pass (3/3) — source: tasks.md
- `npm run test:invariants` — pass
- `npm run typecheck` — pass
- `npm run verify:full:quiet` — pass
