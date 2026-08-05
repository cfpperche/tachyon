# 490 — formation-authority-bootstrap — notes

_Created 2026-08-04._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

### Fatia C (2026-08-05, agent f490c) — combined gate, not instructions alone

The suppression receipt covers every enabled human lane. Measuring only `AGENTS.md`/`CLAUDE.md`
and calling that `verified` would unlock a memory lane receipt without a verified memory disable
(Codex). Combined evidence in `nativeLaneSuppression.ts` is `verified` only when instructions is
verified **and** memory is verified or unsupported. Codex instructions verified + memory declared
⇒ combined `declared`. Grok memory verified + instructions no control ⇒ combined `declared`.
Only Claude is combined `verified` on this measurement.

Evidence write-up: `docs/research/native-lane-suppression-sdd490-fatia-c.md`.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

### Fatia C — did not invent verified for Grok rules or Codex memory

Plan risk said: if a runtime cannot disable native rules/instructions, honest result is `declared`.
Grok has no disable control (measured). Codex `project_doc_max_bytes=0` works for AGENTS.md but
memory disable remains declared — combined stays declared rather than a partial green that would
unblock dual memory delivery.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

### Fatia C — Claude `--setting-sources user` vs `--bare`

`--bare` also skips CLAUDE.md but refuses OAuth (`Not logged in` with a working credential
symlink). Canonical Claude already launches with `--setting-sources user`; behavioral arms show
that flag alone suppresses **project** CLAUDE.md while private-home user CLAUDE.md still loads
(Tachyon owns that home). Chose the production argv as the verified control.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- When Codex memory disable is behaviorally verified, re-open combined gate and decide whether
  canonical launches must pin `project_doc_max_bytes=0` (or equivalent) so the control is not only
  measured but applied.
- Grok needs a real project-rules disable from the runtime vendor, or formation on Grok stays
  refuse-high for soul/instructions while ambient inspectors require file absence.
