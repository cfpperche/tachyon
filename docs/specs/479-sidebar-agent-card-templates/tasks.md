# 479 — sidebar-agent-card-templates — tasks

_Generated from `plan.md` on 2026-07-27, after ratification. Work top-to-bottom. Check boxes as tasks
complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

The phases are independently shippable and are filed as their own queue tasks, because each is a
separate decision surface a human may want to stop at. Only phase 1 is executed here.

## Implementation

### Phase 1 — the catalog, the default template, and the proof (this increment)

- [x] Ratify: record the human's decision on all five forks plus the agent-cards-only boundary in
      `spec.md` (§ Decisions, as ratified; § Non-goals), move the status to `in-progress`, and turn
      the proposal's plan into a plan.
- [x] Build the equality harness the proof needs, since the repository had none: `test/helpers/staticPreact.ts`
      (esbuild-compiled real component + `preact/hooks` aliased to an inert stub + a vnode→HTML
      serializer that records handlers as `[fn]`) and `test/helpers/preactHooksStub.ts`.
- [x] Write the fixture matrix — 60 cards covering every catalog component in both its rendering and
      non-rendering state, the structural cases (no meta, empty meta, nested, collapsed, metrics open),
      the narrow-sidebar edges (long strings, escaping), and terminal rows —
      `test/fixtures/sidebar/agentCardFixtures.ts`.
- [x] **Capture the golden from the renderer that shipped, BEFORE refactoring it** (`76546c4d`) —
      `test/fixtures/sidebar/agentCardGolden.txt`. The ordering is the proof: a golden captured after
      the change would only say the new code equals itself.
- [x] Add the closed catalog and the default template: `src/sidebar/cardTemplate.ts` —
      `CARD_COMPONENT_IDS` (23 ids) → `CardComponentId`, `CARD_CATALOG` with region / `inlineWith` /
      `critical`, `DEFAULT_CARD_TEMPLATE`, `topLevelComponents`, `inlineMembers`, `resolveCardTemplate`.
      Framework-agnostic, same contract as `types.ts`.
- [x] Render the card THROUGH the catalog: `CARD_COMPONENTS` in `src/webview/sidebar/App.tsx`, a
      `Record<CardComponentId, CardComponentRenderer>` so an id without a renderer (or a renderer
      without an id) does not compile; `AgentRow` now maps regions instead of hard-coding fragments.
      `AgentBadges` is absorbed into the catalog.
- [x] Encode the V1 boundary where it cannot be forgotten: `resolveCardTemplate` returns the default
      for a non-agent row whatever is configured — written before a configuration surface exists to
      violate it.
- [x] Prove equality: `test/unit/sidebarCardTemplateEquality.test.ts` (60/60 cards byte-identical,
      terminals included) and the catalog's own invariants: `test/unit/sidebarCardCatalog.test.ts`.
- [x] Move the two spec-384 order guards from source POSITION to the default template's data
      (`agentLiveBranchBadge.test.ts`, `agentLiveResourceMetrics.test.ts`). The rule is unchanged; after
      phase 1 the order is decided by an array, so asserting on where fragments were typed would no
      longer measure anything.
- [x] Record what phase 1 changed in the design (`plan.md` § What phase 1 changed in this design) and
      the open question it raised about the `.row-meta` wrapper (`spec.md` § Open questions).

### Phases 2–5 — filed as queue tasks, executed elsewhere

Ordered; each must leave the tree green on `npm run verify:full:quiet`.

- [ ] `t-7f454e` · **Phase 2 — project template in `tachyon.yml`.** Fail-closed loader modeled on the
      `settings.companion` block (unknown key refused by name, malformed block dropped whole, errors
      accumulated), unknown component id / duplicate id / unknown version refused, the default rendered
      on any error with a diagnostic. Implements critical-state re-admission against the already-declared
      `CRITICAL_CARD_COMPONENTS`. Must also answer the `.row-meta` wrapper question phase 1 raised.
- [ ] `t-6a251c` · **Phase 3 — per-runtime overrides** with the explicit `extends: default | replace`
      switch, no default guess, unknown runtime refused against the product's own runtime list. Depends
      on phase 2.
- [ ] `t-e494e1` · **Phase 4 — the live preview** as a Control → Settings block rendering the REAL
      `AgentRow` against the harness fixtures, at sidebar width plus a narrow pane, errors inline before
      saving. Depends on phase 2.
- [ ] `t-601051` · **Phase 5 — optional personal override** in VS Code settings, personal wins, and the
      UI says which template is in effect. Depends on phase 2.

## Verification

_Acceptance checks tied to `spec.md`. Each maps to a checklist item there._

- [x] **No configuration behaves exactly as today.** The default template reproduces the pre-refactor
      card byte for byte across all 60 fixtures, including the actions and their handlers — proven
      against output captured from `76546c4d` before the renderer changed.
- [x] The catalog is closed in fact and not only in prose: `Record<CardComponentId, …>` makes an
      unimplemented id a compile error, and `isCardComponentId` refuses one at runtime.
- [x] The default template places every catalog component exactly once, in its declared region.
- [x] Every inline run resolves: a host that exists, in the same region, listed before its members.
- [x] The critical set is exactly the four states ratified in fork 3.
- [x] The disclosure gutter is NOT a catalog component (hiding it would make collapsed children
      unreachable), and a test fails if a later phase "completes" the list by adding it.
- [x] Terminal rows are untouched, twice over: `resolveCardTemplate` refuses to give them a configured
      template, and their cards are in the equality matrix.
- [ ] Reorder/hide, explicit runtime fallback, refusal of an invalid template, no markup, critical
      re-admission, live preview, narrow-sidebar behavior, accessibility, versioning — phases 2–5.

**Headless check:** `npm run verify:full:quiet`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood-Opt-Out** for phase 1: this increment is defined by producing **no** observable change, so
there is nothing a human could exercise that would distinguish it from the tree before it. Asking a
dogfooder to confirm the sidebar looks the same would produce a "looks fine" that is true whether or
not the code works. The evidence that fits the claim is the byte-for-byte comparison against the
renderer that shipped, which is mechanical, complete over the fixture matrix, and re-runnable.

Phases 2–5 each carry their own dogfood: from phase 2 onward there is a layout a person can change and
therefore something a person can judge.

## Visual QA

**Visual QA Opt-Out** for phase 1, for the same reason and with a stronger substitute: the golden file
IS the visual record, in text — every element, attribute, tooltip and handler of 60 cards. A screenshot
comparison would be less sensitive (it cannot see a lost `title` or a dropped `onClick`) and less
durable (it cannot be diffed in review). From phase 2 the card can actually change, and the visual
check becomes meaningful.

## Cookbook

**Cookbook-Opt-Out** for phase 1: no operator surface exists yet. Nothing is configurable, so there is
nothing to document beyond what the spec already says. The cookbook entry belongs to phase 2, where a
person first writes a template — and it should be written from the refusal messages, so the
documentation and the diagnostics cannot disagree.
