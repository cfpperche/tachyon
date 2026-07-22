# 425 — Agent profile resolver — notes

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

## 2026-07-22 — scope checkpoint

The work resumed after a worktree-cleanup detour. SDD 423 is ratified and Task `t-17a2c2` is active.
This implementation SDD keeps the dependency boundary intact: resolver foundation here, compact YAML
reference and migration in `t-4f82e0`, state/capability activation in their own slices, and plugins in
their dedicated task chain.

The existing registered PI-001 promise is affected mechanically because project-guidance dependency
provenance crosses this resolver. Its promise and fixed oracle remain unchanged.

## 2026-07-22 — first implementation review

Probe `probe-b3849139-30f7-4989-a42e-4ac32fd7b3ea` found two blockers and several major gaps in the
first green implementation. All were accepted:

- pathname `lstat` plus leaf `O_NOFOLLOW` did not protect against replaced ancestor directories;
- legacy raw command/environment values could leak credentials despite name heuristics;
- native-runtime observations were optional and therefore incomplete by default;
- canonical absence was not bound to external profile authority;
- `localeCompare` made hashes/order dependent on host ICU behavior;
- references did not remain attached to the exact profile directory that declared them.

The implementation now traverses from retained directory descriptors and fails closed on unsupported
hosts, keeps the profile descriptor through reference consumption, requires a host profile head and
digest-bound exhaustive runtime attestation, omits opaque legacy values, and uses fixed code-unit
ordering. Focused regression tests cover mid-read mutation, pathname replacement, stale authority,
missing/mismatched attestation and locale independence. A second probe is in progress against the
revised source.

## 2026-07-22 — follow-up implementation reviews

Probe `probe-8f87da21-b945-4d7b-975c-01f80d695b9e` confirmed the descriptor-custody corrections but
found that local-reference contents still escaped in the result, authority/attestation objects lacked
runtime shape validation, runtime executable text remained ambiguous and provenance missed composite
leaves. The implementation now discards reference bytes after hashing, accepts one executable token
and no canonical argv, validates strict authority/attestation schemas, and checks one provenance owner
for every effective definition leaf.

Probe `probe-e54cfa4a-18b3-45e5-912b-73256d8695c7` found that the initial secret-name heuristic
contradicted explicit channel classification, legacy command selectors were still partially exposed,
an inherited verifier could be dangling and descriptor duplication had one exceptional leak. Those
were corrected by removing name guessing, using independently supplied public legacy runtime ids,
requiring inherited verification to match a resolved pinned reference, and closing every acquired
descriptor on post-open failures.

Probe `probe-43e90ddc-64d3-4580-be2e-dafaaca3a416` found a final trust gap: a syntactically valid
runtime inspector could self-assert its identity. The host profile authority snapshot now carries the
expected adapter/inspector id, version and executable digest, and the attestation must match all four
plus authority revision and selector digest. Ordered arrays retain declared execution/source order;
only unordered structures use code-unit sorting.

Probe `probe-a080409d-90f5-40d8-8d61-933d238696a4` then found two remaining error-path/disclosure
issues: a child directory descriptor could become unowned if closing its parent threw, and legacy
instruction content still crossed the public compatibility result. Descriptor ownership now transfers
before any parent-close attempt, close failures cannot suppress cleanup of the child, and legacy
instructions are represented only by digest in the normalized compatibility result.

Final closure probe `probe-ac51bf08-2d66-4dee-b66c-659ea638264e` returned no blocker or major findings
in the reviewed custody, authority, attestation, disclosure, inheritance, provenance and determinism
boundaries.

## Dogfood log

### 2026-07-22 — pass (34/34)

`npm test -- test/unit/agentProfileResolver.test.ts` exercised canonical and legacy resolution against
real temporary workspace/profile trees. All 34 focused tests passed, including descriptor-bound path
custody, stale authority, native-input conflicts, secret redaction and deterministic reload behavior.

## Verification log

- `npm test -- test/unit/agentProfileResolver.test.ts` — pass (34/34 tests)
- `npm run test:invariants` — pass (PI-001; 1 invariant, 2 tests)
- `npm run typecheck` — pass
- `npm run verify:full:quiet` — pass (469 files; 5,341 passed, 3 skipped)
- `git diff --check` — pass
- SDD id uniqueness — pass
- Final closure probe — pass (no blocker or major findings)

### 2026-07-22T16:04:33Z — pass (4/4) — source: tasks.md
- `npm test -- test/unit/agentProfileResolver.test.ts` — pass
- `npm run test:invariants` — pass
- `npm run typecheck` — pass
- `npm run verify:full:quiet` — pass
