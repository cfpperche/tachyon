# 357 — codex-session-identity — notes

_Created 2026-07-05._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Design dueto (probe codex, adversarial-review, 2026-07-05, runId probe-55ef12d7) — the draft's core mechanism collapsed

10 findings, 3 blockers. My draft leaned on "resolve-then-lock the codex session by cwd/newest right after
start" — the dueto demolished it, and correctly:
- BLOCKER 1: resolve-then-lock is intrinsically racy without a per-instance correlator observable in the
  rollout — locking "newest" can crystallize the WRONG session (persistent error). ACCEPTED — the spec now
  FORBIDS cwd/newest as the authoritative bind and requires (P) private namespace OR (C) injected correlator.
- BLOCKER 2: concurrent two-codex-same-cwd had no deterministic acceptance. ACCEPTED — added the
  concurrent-start criterion (distinct binding or fail-closed; never cross-bind).
- BLOCKER 3: isolate:transcript ASSUMED codex respects the redirected HOME — unverified. ACCEPTED — turned
  into the T0 discovery SPIKE (verify codex session storage + redirect behavior empirically under all 3
  modes) which now GATES the whole design; isolate:transcript is not assumed to isolate until proven.
- MAJOR 4 (resume may create new/unlinked rollout), 5 (ownership-filter is allowlist-only, not a chooser),
  6 (session-owners must be keyed per-INSTANCE, not name/cwd, or removal harms live panes), 7 (binding-
  evidence rule: cwd/mtime/newest/name insufficient), 8 (default may be unfixable without codex support →
  fail-closed, don't mask), 9 (resume.sessionId!="" only after exact evidence), 10 (filesystem-observing
  tests) — all ACCEPTED and folded.
Nothing rebutted. The probe earned its keep: it stopped a design that would have shipped a race-masking
heuristic. The pivot: per-instance PRIVATE NAMESPACE before spawn (or an injected persisted correlator), a
mandatory discovery spike, and FAIL-CLOSED over wrong-bind. This is design-first — no implementation until the
maintainer ratifies + the T0 spike runs.
