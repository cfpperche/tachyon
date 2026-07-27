# 477 — multiruntime-auth-required — notes

_Created 2026-07-27._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

### `t-0338fc` — OpenCode's signal is its credential store, asked before launch

The spec left OpenCode as a declared gap: it emits nothing when unauthenticated, it just answers on
`big-pickle`. Re-measuring on 1.18.5 changed the conclusion, and the two measurements that failed are
worth more than the one that worked, because both are what a reasonable person would have assumed:

- **`opencode run --format json` carries no model field.** The events are `step_start`, `text`,
  `step_finish` and a token/cost block — no `providerID`, no `modelID`. The effective `big-pickle`
  exists only in session storage (`opencode export` → `info.model.id`), which is written *after* the
  turn. A model-divergence detector built on the JSON stream would have had nothing to read, and one
  built on storage would only ever report a degradation that had already happened.
- **An explicit `-m` pin does not degrade.** `-m anthropic/claude-sonnet-4-5` and `-m zhipuai/glm-4.6`
  both fail outright with no credential. So the silent fallback is specific to the *unpinned default*
  path — which is exactly how Tachyon launches opencode, and why the footgun is a real product risk
  rather than a curiosity.

That leaves the store: `opencode providers list`. It answers positively rather than by omission
(`└  0 credentials` on an empty private home; each provider listed on a real one), and it reports
environment-provided keys as their own `Environment` section, so both of OpenCode's authentication
paths are covered by one read. Declared in `RUNTIME_AUTH_PREFLIGHT` next to the turn matchers so the
answer to "which runtimes can report auth-required, and how" stays one list.

### The declaration lives beside the matchers, but is a different KIND

`RUNTIME_AUTH_PROFILES` still has no opencode entry, and that is not an oversight. A profile there
means "this wording, in a turn, means unauthenticated" — and OpenCode's unauthenticated turn is a
*successful* one. Adding an empty-signal entry would have made the two mechanisms look
interchangeable to the next reader. `RUNTIME_AUTH_PREFLIGHT` is the separate declaration, and
`authRequiredFromPreflight` converts its result into the same `AuthRequiredEvidence` the transcript
path produces, so the human sees one sentence regardless of which mechanism found the problem.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

### The OpenCode gate fails CLOSED, which is the opposite of the rule everywhere else in this spec

Everywhere else, 477 refuses to act without positive evidence: an unreadable Grok catalog resolves to
`unverifiable`, not to "the model is missing". The OpenCode gate inverts that — a timeout, a non-zero
exit, or output that is not the measured inventory shape refuses the launch.

The justification is narrow and measured, not a general preference. `opencode providers list` was
driven from a cold private home with `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` pointed at a dead port and
still answered correctly in under a second: it is a local read of a file the CLI owns, not a network
call. So a failure here means the environment is broken, not that the network blinked. And the two
failure modes are not symmetric: a refusal is loud, immediate, and names the probe, while guessing
"probably fine" produces precisely the invisible degradation this exists to stop.

The cost is real and stated: if a future OpenCode release changes this output, every opencode launch
refuses until the parser is re-measured. That is the direction chosen deliberately.

### Test hermeticity needed a seam that did not exist before

This is the first preflight adapter that EXECUTES its runtime unconditionally (Grok's only probes when
a model is pinned; Claude's and Codex's do not spawn at all for a bare command). Any suite inheriting
the production registry would therefore shell out to whatever `opencode` the machine has — or fail
where it is not installed. `createDefaultLaunchPreflightRegistry(overrides)` now owns the production
wiring in one place, and `test/helpers/hermeticLaunchPreflight.ts` overrides exactly that one adapter,
so the rest of the wiring is shared rather than hand-copied into tests and free to drift.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

**`opencode models` was the runner-up and is genuinely account-aware** — 7 anonymous/free slugs with
no credential, 58 with one. It was rejected because reading auth out of it means hardcoding which
slugs constitute the free set, i.e. deriving the answer from a list that changes upstream, when the
CLI already answers the question directly. Given up: nothing measurable. Gained: a signal that cannot
rot silently as the free tier changes.

**The gate costs every opencode launch a subprocess (~0.9s, bounded at the 3s preflight timeout).**
Accepted: it is once per launch, not per turn, and it is the only point at which this failure is still
visible.

**Row 16 stays `~` rather than moving to `✓`.** The signal is measured and consumed, which is the
letter of `✓`, but it is a launch-boundary signal — a credential expiring mid-run is still undetected
for OpenCode, where every other `✓` runtime reports it on the turn. Row 16's rubric was amended to
name that distinction instead of stretching the mark.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- **Mid-run credential expiry on OpenCode is still undetected.** The store is read once, before
  launch. Polling it during a run would be a different mechanism (and a different false-positive
  profile — the file is rewritten in place on token refresh), so it is not folded in here.
- **A readable credential is not a valid one.** An expired OAuth entry still counts as inventory. The
  runtime's behavior on an expired-but-present credential was not measured, and cannot be fabricated
  from a valid one.
- **OpenCode 1.18.5 moved session storage to SQLite** (`opencode.db`), while
  `src/activity/opencodeStorageReader.ts` still reads a `storage/session|message|part/*.json` tree.
  Noticed while measuring the effective model; out of scope here and filed separately as `t-4a4d30`.
  It matters to provenance as well as activity: the per-turn `model.{providerID,modelID}` the
  normalizer already consumes is present in the new store, so fixing the reader also restores
  OpenCode's observed-model line.
