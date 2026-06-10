# 187 — tachyon-v2-umbrella — plan

_Drafted from `spec.md` on 2026-06-09. Update this file if implementation reveals the plan is wrong; do NOT silently diverge._

## Approach

_One or two paragraphs. The strategy in plain language — what we'll build, in what order, and why this shape (not just any shape)._

Process umbrella — no implementation here. Each backlog item F1–F11 (see spec.md) is opened as a child spec, discussed with the user, and decided: implement (child progresses through plan/tasks/ship), defer (reopen trigger recorded), or cancel (reasoning recorded). The umbrella table is updated at each decision; this spec closes when no row says "pending".

## Files to touch

_Concrete list of files to be created, modified, or deleted. Group by category if it helps._

**Create:** child spec dirs `docs/specs/NNN-tachyon-*` as each item is opened.

**Modify:** `docs/specs/187-tachyon-v2-umbrella/spec.md` backlog table (decision column) at every decision.

**Delete:** none.

## Alternatives considered

_At least one rejected approach with its reasoning. If there genuinely was no alternative, state that explicitly ("no real alternative — only viable approach is X because Y")._

### One mega-spec "tachyon-v2" with all features

Rejected because the user explicitly wants per-item discussion with implement/defer/cancel autonomy per feature; a mega-spec invites batch rubber-stamping and hides cancelled scope.

### No umbrella (ad-hoc follow-ups)

Rejected because decisions would scatter across sessions with no single place recording what was deferred/cancelled and why.

## Risks and unknowns

_What could go wrong, what we're not sure about, what assumptions we're making. Spell them out — surprises during implementation are usually pre-implementation risks that weren't named._

- Backlog rot: items decided "defer" without a reopen trigger become invisible — every defer must name its trigger.
- Scope creep via children: a child spec growing beyond its F-item must spawn a new row, not silently expand.

## Research / citations

_Sources consulted (docs, blog posts, code references) that informed this plan. Satisfies `.agent0/context/rules/research-before-proposing.md`._

- Session 2026-06-09 gap analysis (HiveTerm parity + product maturity); spec 186 artifacts.
