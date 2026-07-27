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

- [x] `t-7f454e` · **Phase 2 — project template in `tachyon.yml`.** Fail-closed loader with the SHAPE of
      the `settings.companion` block but deliberately NOT its severity (`plan.md` § What phase 2 changed,
      1): unknown key, unknown component id, wrong region, duplicate id, missing/unknown version, and an
      inline member whose host is omitted are each refused BY NAME; the block is dropped whole; the
      sidebar renders the default and says so in a warn-toned banner. Critical re-admission implemented
      against the already-declared `CRITICAL_CARD_COMPONENTS`, per row AND per state. The `.row-meta`
      question is answered (the wrapper follows the rendered content), which also fixed a shipped
      evidence-badge bug the equality matrix caught. `options:` is refused by name and filed as `t-045d44`.
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
- [x] Terminal rows are untouched, three times over: `resolveCardTemplate` refuses to give them a
      configured template, the Terminals tab never passes one, and both their cards in the equality
      matrix and a direct render-with-a-template test prove it.
- [x] **A written template reorders and hides**, and an omitted region inherits while `meta: []` obeys.
- [x] **An invalid template is refused whole, by name, without taking the file down with it** — the
      roster still loads, the sidebar renders the default, and a warn banner names the file.
- [x] **Markup cannot enter**: every template value is the literal version number or a catalog id, so
      no person-supplied string has a path to the DOM.
- [x] **A hidden failure state comes back** for the affected row, with a tooltip saying the template
      omitted it — and a passing/stale gate does not, so "critical" keeps its meaning.
- [x] The schema is versioned; an unknown version and a missing version are both refused.
- [x] `.row-meta` exists only when something in it rendered — pinned per component, since the first
      implementation put an empty wrapper on every row.
- [ ] Explicit runtime fallback, live preview, narrow-sidebar behavior at a configured template,
      accessibility of a reordered reading order, per-component options — phases 3–5 and `t-045d44`.

**Headless check:** `npm run verify:full:quiet`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Phase 1: Dogfood-Opt-Out.** That increment was defined by producing **no** observable change, so
nothing a human could exercise would distinguish it from the tree before it. Asking a dogfooder to
confirm the sidebar looks the same produces a "looks fine" that is true whether or not the code works.
The evidence that fits that claim is the byte-for-byte comparison, which is mechanical and re-runnable.

**Phase 2: there is now something to judge, and it is NOT yet judged by a human.** The recipe below is
written and ready; it has not been run, because it needs a VS Code host and a person looking at a real
sidebar. Run it in the change worktree (`npm run dogfood:dev-host -- point --fixture <slug>` →
`point-status` → F5 there, per `docs/runbooks/dev-host.md`):

1. **It applies.** Add to the workspace `tachyon.yml`:
   ```yaml
   settings:
     sidebar:
       cardTemplate:
         version: 1
         meta: [harness, branch]
   ```
   Expect: agent cards show only those two badges, `harness` before `branch` (the reverse of the
   default's branch-first order — that inversion is what proves the template is in charge). Terminal
   rows are unchanged.
2. **It refuses.** Change `harness` to `cpu-graph`. Expect: cards return to the DEFAULT layout, a
   warn-toned banner reads "Card layout ignored — showing the default", and the message names
   `settings.sidebar.cardTemplate.meta[0]` and `cpu-graph`. The agents/commands/runbooks lists keep
   working — the file is not invalid, only the layout was refused.
3. **It cannot hide an emergency.** With `meta: []`, put an agent into an auth-required state. Expect:
   the `◆ auth required` badge appears on that row only, and its tooltip explains that the template
   omits it.
4. **The empty row really is gone.** With `meta: []`, confirm rows with no badges have no leftover gap
   where the badge row used to be.

## Visual QA

**Phase 1: opt-out**, with a stronger substitute — the golden file is the visual record in text
(every element, attribute, tooltip and handler of 60 cards), and it is *more* sensitive than a
screenshot, which cannot see a lost `title` or a dropped `onClick`.

**Phase 2: advisory, and open.** A configured card is a genuinely visual change (badge order, the
warn-toned banner, spacing once the badge row can vanish), and the golden covers only the DEFAULT card.
The web-only `visual-qa` plugin cannot drive a VS Code sidebar, so this belongs with the human dogfood
above — steps 1 and 4 are the ones where appearance, not behavior, is what is being judged.

## Cookbook

**Phase 1: opt-out** — nothing was configurable, so there was nothing to document.

**Phase 2: [`cookbook.md`](./cookbook.md).** Written from the refusal messages themselves, so the
documentation and the diagnostics cannot drift: where the template lives, the three regions and their
components, why silence inherits while `[]` obeys, the two components that travel inside a host, what
cannot be hidden and how the product says so, every refusal message with its exact wording, and two
worked recipes.
