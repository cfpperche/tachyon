# 304 — sidebar-adhoc-parent-grouping — notes

_Created 2026-06-30._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Verification log

### 2026-07-01T00:04:31Z — pass (1/1) — source: tasks.md
- `env -u TMUX npx vitest run test/unit/sortRows.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit` — pass

## Human dogfood log

### 2026-06-30 — pass (maintainer, installed tachyon-0.54.5.vsix)
Packaged + installed `tachyon-0.54.5.vsix` (commit `96693c9`). First attempt spawned an ad-hoc entry with `cmd: bash`, which Tachyon classifies `kind: terminal` (not `agent`) — it landed in the Terminals tab, unaffected by this spec's Agents-only fix, and looked like a failure. Re-spawned with `cmd: claude` (a real AI-CLI ad-hoc agent, `kind: agent`, `parent: claude`): its row rendered with the `↳` glyph and "spawned by claude" immediately below the `claude` row, while the list's active sort was Z→A — i.e. the child was NOT in its plain-alphabetical Z→A position (which would have put a `t...` name above `codex`/`claude`), confirming `groupByParent` is actually overriding alphabetical placement rather than coincidentally matching it. Screenshot confirmed by maintainer ("agora sim"). Both ad-hoc verification agents killed after use.
