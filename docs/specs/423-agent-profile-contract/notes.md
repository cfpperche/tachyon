# 423 — agent-profile-contract — notes

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
# Review log

## 2026-07-22 — Codex adversarial architecture review

Probe `probe-def0b983-efa8-4b04-9bdf-ddd81d670462` blocked ratification of the first draft. The
blocking issue was semantic, not implementation detail: the draft did not fully distinguish desired
plugin assignment from consent, did not bind learned active bytes to external authority, and deferred
precedence/memory decisions that determine the trust boundary.

Substantiated corrections folded into `spec.md` and `plan.md`:

- classification is now two-dimensional (effect and custody), so operational policy cannot hide a
  forming or governing effect;
- one immutable `agentId` binds subordinate identities, authorities, snapshots and lifecycle;
- plugin/capability activation requires desired declaration, valid external authority and matching
  resolved bytes; payload/lock/catalog presence grants nothing;
- Evolution and runtime memory have explicit selector/producer/promotion bindings; direct changed bytes
  do not silently remain active;
- references declare pinned/floating behavior and every launch records resolved digests;
- snapshots are labelled projections with an externally custodied integrity head;
- resolution, authority join, secret-free snapshot, projection, ephemeral secret injection and launch
  provenance are ordered phases;
- semantic field precedence is normative now rather than deferred;
- lifecycle operations use host-owned intents, external commit points, launch blocking and idempotent
  recovery, with explicit clone/export behavior per lane;
- acceptance now requires field/reference/lifecycle/conflict matrices rather than prospective prose.

A second adversarial pass is required before maintainer ratification.

## 2026-07-22 — second Codex adversarial architecture review

Probe `probe-28259b4e-3301-4e8f-bd84-d6e81dfc4789` found two remaining blockers and five major
contract gaps. They were accepted and folded into the SDD:

- `runtime-managed` memory is now an explicit bounded delegation to a named/versioned adapter; the
  host validates updates and alone commits the activation head. Human-approved and disabled modes have
  separate closed transitions.
- Runtime cohorts were removed from V1 plugin assignment. Agent-local plugins bind to `agentId`;
  existing project-wide plugins remain a versioned project-owned set inherited by explicit reference.
- A reference matrix now fixes owner/scope, pinned/floating mode, identity/version/digest, resolution
  boundary and failure behavior for every reference class.
- A closed runtime-native input inventory maps model/provider, prompts, skills, MCP, hooks, plugins,
  workspace/trust, policy, environment, auth, memory and session selectors. Unknown forming inputs are
  denied by the adapter contract.
- Environment now has separate explicit-profile, secret and versioned adapter-operational channels;
  unknown inherited forming variables fail closed.
- Profile Edit has a per-lane authority transition table under one host-owned intent.
- A host-custodied session/fork selector binds snapshots and revalidates revocable execution authority
  on resume/fork while preserving approved session-pinned content.
- Structural invariants prevent a serialization refinement from merging agent-writable selectors with
  consent/freshness authority.

A third focused pass should confirm the remaining contract is ratifiable.

## 2026-07-22 — third Codex adversarial architecture review

Probe `probe-4498271b-eaba-46df-b3be-fee1f658249a` found two final blockers and one major ambiguity:

- CAS was incorrectly capable of looking like edit authorization. The contract now requires an
  externally custodied mutation predicate binding authenticated principal, `agentId`, permitted field
  lanes, expected revisions and resulting digest. Agent/runtime principals cannot authorize human
  definition/policy/capability changes.
- Free-form memory cannot be mechanically separated into “fact” versus “instruction”. The
  `runtime-managed` mode is now honestly specified as explicit bounded persistent prompt-writing
  authority delegated by the human to one adapter. Its enforceable boundary is one labelled text-only
  lane with quotas; the product must surface that text may instruct future behavior.
- Resume/fork now has a closed execution-authority matrix. Bytes remain session-pinned, while skills,
  plugins, MCP, hooks, executable resources, adapter, sandbox/network/tool policy, secrets and project
  plugin-set authority are revalidated on every process launch. Revocation fails closed rather than
  silently degrading the agent.

A final focused pass should confirm semantic ratifiability before maintainer review.

## 2026-07-22 — fourth Codex adversarial architecture review

Probe `probe-278d3c44-e061-4ca7-b9ff-c6bdc4194ca9` confirmed that profile-edit authorization and
resume/fork execution revocation were closed. It found one remaining major gap: a named/versioned
runtime memory adapter could be replaced by different code under the same label. The delegation and
every activation head now bind the immutable adapter executable digest and deterministic
renderer/prompt-layer contract digest. Any change to identity, version, executable or renderer revokes
the lane until a human issues a new authorization.

Probe `probe-875651c4-e3f9-40b5-bf78-c9fb5e658c65` then identified that scope and quotas were validated
but not explicitly bound/revoked. The delegation record and activation head now also bind authenticated
principal identity/kind, exact lane/operations, byte and entry quotas; any change revokes the lane until
new human authorization.

Probe `probe-b3bda261-c284-4426-9fac-46a48b881c97` caught an over-binding error: putting active content
digests in the delegation would make every legitimate autopromotion revoke its own authority. The
contract now separates a stable delegation record (principal/scope/quotas/adapter/renderer and epoch)
from a replaceable activation head (delegation epoch plus active manifest/content digests). Valid
promotion replaces only the activation head; changing delegated authority revokes the epoch and head.

Probe `probe-2729621d-290c-472d-adad-2a20bbdfba57` identified rollback/replay and concurrent
promotion-versus-revocation as the final missing rule. Activation heads now carry a strictly monotonic
host freshness revision, replace only through CAS against the current head, and serialize with
delegation status/epoch changes. Prior signed heads remain audit evidence but can never activate.

Probe `probe-b6ba8271-ed1f-4821-a9b7-2e72747ddf51` returned no findings and declared this separation
semantically ratifiable. SDD 423 is ready for maintainer architecture review; no product code has been
started.

## 2026-07-22 — maintainer correction: plugins are a separate scope

The maintainer rejected adding plugins to the agent profile now because a dedicated task chain already
owns workspace-versus-agent installation scope. Earlier probe conclusions about `plugins.yml`,
agent-local plugin assignment, project plugin-set references and plugin consent inside this SDD are
therefore superseded, not implementation commitments.

SDD 423 now defines no plugin field or file. Existing workspace plugins remain available to all agents
under the current workspace plugin contract. Agent-scoped installation and any future profile
integration remain with `t-f095b5` and `t-54cdb1`–`t-54cdb4`; this umbrella carries only a
non-interference requirement.

Focused probe `probe-ab51ca0c-cf45-4d04-93d7-a7ffcd37e923` found that generic snapshot and inspection
language could still pull external plugins back into the profile implicitly. The contract now limits
snapshot/provenance/completeness claims to profile-governed non-plugin inputs, states that plugin
mutations are outside this snapshot lifecycle, and removes an undefined “compatible agents” filter.

Probe `probe-44d58f9d-a91a-4297-8596-87e630d76302` found one remaining overreach: SDD 423 prescribed
which architectural contracts the future plugin tasks had to adopt. The boundary now assigns that work
exclusively to the dedicated task chain without imposing architecture or lifecycle requirements.

Final probe `probe-eac0f7c1-55bb-455f-8585-63a2a14139c5` returned no findings. The plugin boundary is
coherent with the maintainer correction.

Post-correction verification passed: SDD ids are unique, `git diff --check` is clean,
`npm run typecheck` passed, and `npm run verify:full:quiet` passed with 462 files, 5,274 tests passed
and 3 skipped.

## 2026-07-22 — maintainer ratification and acceptance audit

The maintainer ratified SDD 423 after the plugin-boundary correction. Every acceptance checkbox is
closed as **architecture-contract coverage**, not as a claim that product/runtime behavior has already
changed. Behavioral delivery remains assigned to the follow-up Tasks under `t-7d2cc0`.

Acceptance evidence:

- the classification, directory, field-ownership, current-surface, runtime-input, declaration and
  lifecycle matrices cover every required contract dimension;
- reference, path-custody, environment, secret, mutation-authority, identity, snapshot and
  resume/fork sections state the fail-closed boundaries;
- the repository inventory report and cited implementation sources ground the current-state mapping;
- independent Codex probes challenged authority, memory, replay and plugin-scope claims; the final
  focused probe returned no findings;
- plugins are explicitly absent from V1 profile schema and lifecycle. The later re-study in `t-f095b5`
  may propose a separate integration without changing what this documentation-only slice shipped.

## Verification log

### 2026-07-22T14:37:04Z — pass (3/3) — source: tasks.md
- `sh /home/goat/tachyon/.agents/skills/sdd/scripts/check-ids.sh` — pass
- `npm run typecheck` — pass
- `npm run verify:full:quiet` — pass
