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
