# 199 — tachyon-commands — notes

_Created 2026-06-10._

_In-flight design memory for this spec — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention. See `.agent0/context/rules/spec-driven.md` § The four artifacts for purpose, and `.agent0/context/rules/delegation.md` § The 5-field handoff for how sub-agents integrate._

**Entry shape:** `### YYYY-MM-DD — <author> — <one-line title>` followed by free-prose body. `<author>` is `parent` for the orchestrating agent, or the `subagent_type` (e.g. `general-purpose`, `Explore`) for delegated work.

**Routing rubric:** decision made under ambiguity → §1 Design decisions. Intentional departure from `plan.md` → §2 Deviations. Alternative weighed and chosen mid-flight → §3 Tradeoffs. Question surfaced during build, no answer yet → §4 Open questions. Sections may stay empty; the rubric is a guide, not a quota.

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision itself + why this option over others considered in the moment._

### 2026-06-10 — parent — run button hidden while running

`viewItem == command` (not the `/^command/` regex) gates the inline ▶ so a running
command can't be double-started from the UI; the runner refuses anyway, but hiding
the affordance beats surfacing an error toast.

### 2026-06-10 — parent — finished-result-reported-not-rerun

`run_command` on an already-finished command REPORTS the stored result instead of
re-running, unless `rerun: true`. Mirrors the run_runbook fix from the same package:
an agent retrying a tool call must not silently re-execute side effects.

## Deviations

_Places where implementation intentionally departed from `plan.md`. The departure + the reason it was necessary or better._

### 2026-06-10 — parent — i18n drift guard blind to the AgentForm `t` alias

The guard regex only matches `l10n.t("…")`; AgentForm aliases `const t = vscode.l10n.t`,
so its new Command-tab strings were added to the pt-BR bundle manually. Pre-existing
limitation (F17 strings were added the same way), noted here rather than widened
mid-package.

## Tradeoffs

_Alternatives weighed during implementation (not at plan time). The chosen path + what was given up + why the tradeoff was worth it._

## Open questions

_Questions surfaced during build that the implementer couldn't resolve alone. Owner (who decides) or path to resolution if known. Promote answered questions to `spec.md` § Open questions or as retroactive acceptance scenarios when the spec is updated._

## Verification log

### 2026-06-10T20:40:07Z — pass (1/1) — source: tasks.md
- `bash -c 'cd packages/tachyon && npx vitest run --reporter=dot 2>&1 | tail -3'` — pass
