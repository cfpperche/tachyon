# 479 — sidebar-agent-card-templates

_Created 2026-07-27._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence). -->

**Ratified 2026-07-27** (task `t-067540`, journal `j-946d602f8d47`): the human accepted all five
proposed decisions as written, and added one boundary that was not in the proposal — **V1 applies to
agent cards only; terminal rows are out of scope.** §"Decisions, as ratified" records each one and
what it now binds. Implementation proceeds in the phases at the end of `plan.md`; `tasks.md` is the
ordered backlog.

## Intent

The sidebar agent card grew one element per spec — model provenance (378), branch badge (384),
resource pill and lanes (386), focus line (390), evidence (273), continuity (241), external tools
(t-327f81), auth-required (SDD 477), and eleven more. Each addition was individually justified and
the result is a card that shows everything to everyone: a person running four Claude agents on one
repo reads the same row as a person running a mixed fleet across three worktrees, and neither can
say what they do not want to see.

Done means a human can decide **which elements a card shows, in what order**, per project and per
runtime, from Tachyon's settings — without being able to inject markup, break the sidebar's
narrowest layout, or lose a signal that only matters when something is wrong.

The constraint that shapes the whole design: a card is not a document, it is a **glance**. The
customization surface must make a card that is *worse for its owner* hard to build by accident and
*impossible* to build by injection.

## Acceptance criteria

_Each box is a scenario the implementation has to prove. A box is checked when a test proves it, and
names that test; the rest belong to phases 2–5 and stay open until then._

- [x] **Scenario: no configuration behaves exactly as today** — phase 1,
      `test/unit/sidebarCardTemplateEquality.test.ts`
  - **Given** a workspace with no card-template configuration of any kind
  - **When** the sidebar renders any agent row
  - **Then** the output is byte-identical to the current card, because the default template *is* the
    current layout expressed in the catalog — not a re-implementation that happens to look similar.
  - *Proven by* rendering the real `AgentRow` over a 60-card fixture matrix and comparing it, byte for
    byte, against output captured from the renderer at `76546c4d` — **before** the refactor, so the
    golden is evidence about the prior card and not about the new one. Terminal rows are in the same
    matrix: they share the component, and V1 must not move them.
- [x] **Scenario: a person reorders and hides elements** — phase 2,
      `test/unit/sidebarCardMetaRegion.test.ts`
  - **Given** a template listing a subset of catalog components in a chosen order
  - **When** the sidebar renders
  - **Then** exactly those components appear, in that order, and every omitted one is absent — with
    the escape-hatch rule below still holding.
  - *Also decided here:* a region the template does not MENTION keeps the default; an explicitly empty
    list (`meta: []`) hides everything in it. Silence should not delete the actions row from someone
    who only wanted to reorder badges, but `[]` is a sentence and is honored as one.
- [x] **Scenario: a runtime override falls back explicitly** — phase 3,
      `test/unit/sidebarCardRuntimeOverrides.test.ts`
  - **Given** a per-runtime template for `claude` and no template for `codex`
  - **When** rows of both runtimes render
  - **Then** the Claude rows use the override and the Codex rows use the default, and the override
    declares whether it extends the default or replaces it — the answer is never implicit.
  - *Two things the ratified wording left unsaid, decided in phase 3 rather than by whoever reads the
    code next:* (a) `extends: default` layers onto the **project's** template, so product → project →
    runtime compose and one runtime's override never discards what the project chose for every other
    row; (b) a **partial** `replace` is refused by name — "exactly as written", written in half, would
    mean a card with no name and no actions for someone who only wanted different badges.
  - *The fallback is a lookup miss and nothing else:* overrides resolve to complete templates when the
    config is parsed, so the renderer never merges and the wire carries no inheritance to re-interpret.
  - *Which runtimes may be keys:* every runtime Tachyon can run an agent on
    (`SUPPORTED_ADHOC_AGENT_RUNTIME_NAMES`), not the narrower attested four — an ad-hoc agent may be
    OpenCode/Gemini/Qwen/Hermes, and refusing those keys would refuse an override for rows the product
    itself creates. Still the product's own list, borrowed rather than redeclared.
- [x] **Scenario: an invalid template is refused, not partially applied** — phase 2,
      `test/unit/sidebarCardTemplateConfig.test.ts`
  - **Given** a template naming an unknown component, an unknown option, or a duplicate component
  - **When** the config loads
  - **Then** the sidebar renders the default template, the error names the offending key and the
    file, and no half-applied layout is ever shown.
  - *Severity, decided here:* a malformed template does **not** invalidate `tachyon.yml`. In this
    loader any `errors` entry refuses the whole file, which drops the workspace to ledger/last-known-good
    and makes spawning read-only — bricking a workspace over a cosmetic layout typo is a worse failure
    than the one being prevented, and this criterion's own wording ("the sidebar renders the default
    template") presumes a config that still loads. The block is dropped whole, a warning names the key
    and the file, and the sidebar shows a warn-toned banner saying the layout was ignored.
- [x] **Scenario: markup cannot enter** — phase 2, by construction plus
      `test/unit/sidebarCardTemplateConfig.test.ts`
  - **Given** any string a person can type into the template
  - **When** it is rendered
  - **Then** it is rendered as text by the same components that render today's card; the schema
    accepts no HTML, no CSS, no expressions, and no free-form templating syntax at all.
  - *Why this is now true and not merely intended:* every value a template carries is either the
    literal `version` number or an id checked against the closed catalog. There is no position in the
    schema where a person-supplied STRING reaches the DOM — an unknown id is refused by name, so a
    string can only ever select a fragment the product already renders.
- [x] **Scenario: a signal that matters is never fully hidden** — phase 2,
      `test/unit/sidebarCardMetaRegion.test.ts`
  - **Given** a template that omits the components carrying failure states (auth-required,
    config-invalid, verify failure, awaiting-human)
  - **When** a row enters one of those states
  - **Then** the state is still visible — the renderer re-admits the omitted critical component for
    the rows in that state and says why, rather than honoring a preference that hides an emergency.
  - *Bounded on purpose:* re-admission is per row AND per state. A passing or stale verify gate is
    information, not an emergency, and is not re-admitted — otherwise "critical" would quietly come to
    mean "always shown".
- [ ] **Scenario: live preview while editing**
  - **Given** the human is editing the template in Tachyon's settings surface
  - **When** the template text changes
  - **Then** a preview renders the real card component against fixture rows (healthy, attention,
    error, long names, no model, narrow width) and shows validation errors inline, before saving.
- [ ] **Scenario: the narrow sidebar still works**
  - **Given** any valid template at the sidebar's minimum practical width
  - **When** rows render
  - **Then** truncation, wrapping and focus order are owned by the components, not by the template:
    no template can produce horizontal scroll or an unreachable action.
- [ ] Accessibility is a component property, not a template one: each catalog component carries its
      own accessible name/description, and a template that reorders components reorders the reading
      order with them.
- [x] The template schema is versioned, and an unknown version is refused with the same fail-closed
      diagnostic as an unknown component — phase 2. A template with no `version` at all is refused too:
      the field is the contract, not decoration.

## Non-goals

- **Terminal rows** (ratified boundary, 2026-07-27). They render through the same component, so this
  is not "not yet implemented" but a rule the code has to carry: `resolveCardTemplate` returns the
  default for a non-agent row whatever is configured, and the equality matrix renders terminal rows so
  a regression shows up as a failing card rather than as a review someone forgot to do.
- Any template language, expression syntax, or user-supplied markup/CSS/JS.
- Per-agent templates (per-runtime and project-default only, in v1).
- Restyling: colors, spacing, typography and the badge vocabulary stay the product's.
- Customizing anything outside the agent card (groups, pins, commands, runbooks, the Control panels).
- Changing what any element *means* — this proposal moves elements, it does not redefine them.
- A migration for people who configured nothing: there is nothing to migrate, by construction.

## Decisions, as ratified

All five forks were decided on 2026-07-27, each as proposed. They are kept in the words they were
asked in — a decision is easier to revisit when you can still read the question — with what each one
now binds recorded underneath.

**Plus one boundary the human added:** V1 customizes **agent cards only**. Terminal rows share the
component and are explicitly out of scope; see § Non-goals.

1. **Whose preference is this — the project's or the person's?**
   A layout written in `tachyon.yml` travels with the repo: every teammate and every agent-authored
   checkout gets it. A layout in VS Code settings belongs to one person on one machine. Card layout
   feels personal, but per-runtime rules ("show branch for Claude rows because that is how we work
   here") feel like project knowledge. *Proposed:* project default in `tachyon.yml`, optional
   personal override in VS Code settings, personal wins, and the settings UI says which one is in
   effect. Alternative: pick exactly one home and refuse the other.
   **Ratified as proposed.** Binds phase 2 (project home) and phase 5 (personal override + the
   "which one is in effect" statement, which is part of the feature, not a nicety).

2. **Does a runtime override start from the default or from nothing?**
   If it extends the default, adding a new element to the product later makes it appear inside every
   override — good for discovery, surprising for someone who curated their layout. If it replaces,
   overrides stay exactly as written and silently miss new elements forever. *Proposed:* the
   override declares it (`extends: default` or `replace`), with no default guess.
   **Ratified as proposed.** Binds phase 3: an override omitting the switch is refused by name, not
   resolved by picking the friendlier reading.

3. **May a person hide a failure signal?**
   Someone who hides "auth required" to get a tidy card will eventually stare at an idle agent that
   cannot run. *Proposed:* critical states are re-admitted automatically for the affected row only,
   with a tooltip explaining that the template omitted it. Alternative: honor the preference
   literally and accept the silence.
   **Ratified as proposed.** The four components this covers — `auth-required`, `config-invalid`,
   `awaiting-human`, and `verify` in its fail state — are already marked `critical` in the catalog
   (`src/sidebar/cardTemplate.ts`) and pinned by test, so phase 2 implements re-admission against a
   set that was fixed here rather than one chosen while writing the loader.

4. **How much layout is enough?**
   *Proposed v1:* a flat ordered list of components in three fixed regions (header, meta, footer),
   plus per-component options from a closed set. No nesting, no columns, no conditionals. This is
   deliberately less power than a person will eventually ask for — the question is whether that is
   the right starting point or a frustration.
   **Ratified as proposed.** Phase 1 found one thing the flat list cannot express and the catalog
   must: the model label and its provenance marker render *inside* `.name`, not beside it. That is
   declared by the catalog (`inlineWith`), so the template a person writes stays a flat ordered list
   exactly as ratified — see `plan.md` § What phase 1 changed in this design.

5. **Where does the live preview live?**
   *Proposed:* Control → Settings, beside the Companion block, which is already an editable settings
   block with host round-trips. Alternative: only the dev preview harness (cheaper, but then the
   person editing YAML has no feedback until they save and look).
   **Ratified as proposed.** Binds phase 4.

## Open questions

- Should a template be able to declare a *compact* variant that the sidebar switches to under a
  width threshold, or is one template per runtime enough with components handling their own
  truncation? (Leaning: components handle it; a second template doubles the validation surface.)
- ~~Do terminals get their own template arm, or is "runtime" the only axis?~~ **Answered on
  ratification: no.** Terminal rows are out of scope for V1 entirely — not a second arm, not a
  reduced one. Revisiting it is a new spec, not a phase of this one.
- Does the preview need real fleet data (a live row from this workspace) or are fixtures enough for
  the decision the human is making while editing?
- ~~Raised by phase 1: does an all-omitted meta region collapse the `.row-meta` wrapper?~~
  **Answered in phase 2: the wrapper follows the rendered content.** `.row-meta` exists when at least
  one of its components actually rendered — not when the row happens to carry a field. `hasMeta`, the
  fixed field-based predicate, is gone.

  Two things fell out of implementing it, both recorded in the golden's header:

  1. The change is invisible where it merely removes an empty wrapper, because `sidebar.css` already
     carried `.row-meta:empty { display: none }`. The DOM is now honest about what the CSS was
     already hiding.
  2. **It fixed a shipped bug.** `hasMeta` listed every meta field *except* `evidence`, so a row whose
     only meta content was the evidence badge (spec 273) rendered no `.row-meta` — and the badge was
     invisible. Rows usually carry a live branch too, which is why it went unnoticed. The equality
     matrix caught it: three evidence fixtures changed from "no meta row" to "badge present".

  The invariant this rests on — *every meta component returns `null` when it has nothing to show* —
  is pinned per component in `test/unit/sidebarCardMetaRegion.test.ts`, because getting it wrong put
  an empty `.row-meta` on **every** row during development.
