# 311 — codex-harness-instructions-skills-hooks — notes

_Created 2026-07-01._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- Local dogfood with `CODEX_HOME=<tmp>/home codex debug prompt-input` proved `<CODEX_HOME>/AGENTS.md` is included in
  the model-visible prompt and `<CODEX_HOME>/skills/<name>/SKILL.md` appears in the initial skill list.
- Codex `rules` remains a rejected field. The native concept is persistent project/user instructions via `AGENTS.md`;
  Tachyon's new field is `harness.instructions`.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- Real hook firing under an authenticated interactive TUI should be human-dogfooded after package install; headless tests
  cover the native config materialization only.

## Verification log

### 2026-07-01T13:17:52Z — pass (1/1) — source: tasks.md
- `npm test -- --run test/unit/config.test.ts test/unit/harness.test.ts test/unit/agentStudio.test.ts && npm run typecheck` — pass

## Dogfood log

### 2026-07-01T13:17:58Z — pass (1/1) — source: tasks.md — commit: 10c14ed464c575eb847dc6aeb4342ebbf2ebb0e2
- `npm test -- --run test/unit/harness.test.ts -t "spec 311"` — pass
