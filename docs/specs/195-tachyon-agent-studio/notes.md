# 195 — tachyon-agent-studio — notes

_Created 2026-06-10._

_In-flight design memory for this spec — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention. See `.agent0/context/rules/spec-driven.md` § The four artifacts for purpose, and `.agent0/context/rules/delegation.md` § The 5-field handoff for how sub-agents integrate._

**Entry shape:** `### YYYY-MM-DD — <author> — <one-line title>` followed by free-prose body. `<author>` is `parent` for the orchestrating agent, or the `subagent_type` (e.g. `general-purpose`, `Explore`) for delegated work.

**Routing rubric:** decision made under ambiguity → §1 Design decisions. Intentional departure from `plan.md` → §2 Deviations. Alternative weighed and chosen mid-flight → §3 Tradeoffs. Question surfaced during build, no answer yet → §4 Open questions. Sections may stay empty; the rubric is a guide, not a quota.

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision itself + why this option over others considered in the moment._

## Deviations

_Places where implementation intentionally departed from `plan.md`. The departure + the reason it was necessary or better._

### 2026-06-10 — parent — post-ship increment 2: kind-conditional fields (user request)

Dogfood observation: toggling Agent/Terminal only changed the hint — same fields for both. Now each kind shows its own: **agent** → quick-add catalog + Instructions (chips and role prompts are AI-CLI things); **terminal** → a new **Watch files** input (the `watch:` field was missing from the form entirely; comma-separated globs → string or list in yml) + terminal-flavored command placeholder. toEntry enforces it structurally (instructions dropped for terminals, watch dropped for agents) — tested. 4 new l10n keys (pt-BR; drift guards cover).

### 2026-06-10 — parent — post-ship increment: quick-add catalog (user request)

First dogfood of the Studio surfaced the refinement: the quick-add row showed only detected CLIs — no discovery, no explicit custom path. Added `AGENT_CATALOG` in formLogic: **majors always visible** (claude/codex/gemini/opencode/copilot/aider) — enabled with ✓ when detected, **disabled with an install-hint tooltip** when not (product discovery, HiveTerm-style); **long-tail** (goose/amp/grok/qwen/cursor-agent) appears only when detected; a **Custom…** chip (✎) clears and focuses the command field — the explicit door for uncataloged runtimes. Install hints are curated data (dated 2026-06 in code; commands age — a hint, not a contract). 3 new l10n keys (pt-BR added; drift guards cover them). `quickAddChips()` merge logic unit-tested (132/132; 16-passing integration).

## Tradeoffs

_Alternatives weighed during implementation (not at plan time). The chosen path + what was given up + why the tradeoff was worth it._

## Open questions

_Questions surfaced during build that the implementer couldn't resolve alone. Owner (who decides) or path to resolution if known. Promote answered questions to `spec.md` § Open questions or as retroactive acceptance scenarios when the spec is updated._

## Verification log

### 2026-06-10T15:57:28Z — pass (1/1) — source: tasks.md
- `bash -c 'cd packages/tachyon && npm run typecheck && npm run build && npm test'` — pass
