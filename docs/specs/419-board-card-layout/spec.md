# 419 — board-card-layout

_Created and ratified from maintainer screenshots on 2026-07-20._

**Status:** shipped

**Closure:** Implemented for `t-57e60b`; executable and visual evidence is recorded in `notes.md`.
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`
**Dogfood:** `npm run build && npx vitest run --config vitest.browser.config.ts test/browser/boardCardLayout.test.ts`

**Task:** `t-57e60b`

Affected Product Invariants: none — this presentation-only Board refinement does not change the
registered PI-001 project-guidance ownership boundary.

## Intent

The Board currently forces task id, author, SDD/attention indicators, assignee and priority into one
260px metadata row. That row intentionally clips its left side before the quick controls, so a long
assignee — especially historical “delivered by …” labels — can make the author look absent even
though `BoardCardVM.author` is populated. Narrow columns also make titles needlessly tall.

Done means equal Board columns are modestly wider and each card has stable visual regions: author at
the upper left without a color dot, badges at the upper right, title in the body, task id at the
lower left, and assignee plus priority at the lower right. Missing data stays honest; interactions,
status semantics and horizontal scrolling remain unchanged.

## Acceptance criteria

- [x] **Scenario: every author has reserved visible space**
  - **Given** a task card with a valid stored author and a long assignee or several badges
  - **When** the Board renders
  - **Then** the author text remains visible at the upper left without a dot and is not squeezed by
    the assignee controls
- [x] **Scenario: card metadata occupies stable corners**
  - **Given** any Board card
  - **When** it renders
  - **Then** kind/SDD/attention/attachment/journal badges are upper-right, task id is lower-left, and
    assignee plus priority are lower-right
- [x] **Scenario: wider columns remain a horizontal board**
  - **Given** the five always-on lanes at desktop or narrower width
  - **When** their combined width exceeds the viewport
  - **Then** each column keeps the same wider width and the Board scrolls horizontally without card
    or column overflow
- [x] Existing card open, copy-id, drag/drop, context-menu, assignee edit and priority edit handlers
  remain on their current authoritative paths.
- [x] A headless real-bundle browser test proves the corner ordering and author visibility with
  deliberately long metadata.

## Non-goals

- Changing Task schema, author/assignee derivation, workflow status, filters, or Board actions.
- Replacing the Board design system or changing the SDD 410 cockpit migration.
- Desktop/non-headless validation.

## Open questions

None. The maintainer supplied the desired layout and screenshots as the visual anchor.
