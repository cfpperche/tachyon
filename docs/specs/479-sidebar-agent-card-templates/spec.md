# 479 — sidebar-agent-card-templates

_Created 2026-07-27._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence). -->

**This is a proposal.** Nothing here is ratified, no product code exists for it, and no
implementation tasks were created. It exists to be read and argued with. §"Decisions that need a
human" is the shortest path through it.

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

_Unchecked on purpose: this is a draft, and each box is a scenario the implementation would have to
prove, not a claim about today._

- [ ] **Scenario: no configuration behaves exactly as today**
  - **Given** a workspace with no card-template configuration of any kind
  - **When** the sidebar renders any agent row
  - **Then** the output is byte-identical to the current card, because the default template *is* the
    current layout expressed in the catalog — not a re-implementation that happens to look similar.
- [ ] **Scenario: a person reorders and hides elements**
  - **Given** a template listing a subset of catalog components in a chosen order
  - **When** the sidebar renders
  - **Then** exactly those components appear, in that order, and every omitted one is absent — with
    the escape-hatch rule below still holding.
- [ ] **Scenario: a runtime override falls back explicitly**
  - **Given** a per-runtime template for `claude` and no template for `codex`
  - **When** rows of both runtimes render
  - **Then** the Claude rows use the override and the Codex rows use the default, and the override
    declares whether it extends the default or replaces it — the answer is never implicit.
- [ ] **Scenario: an invalid template is refused, not partially applied**
  - **Given** a template naming an unknown component, an unknown option, or a duplicate component
  - **When** the config loads
  - **Then** the sidebar renders the default template, the error names the offending key and the
    file, and no half-applied layout is ever shown.
- [ ] **Scenario: markup cannot enter**
  - **Given** any string a person can type into the template
  - **When** it is rendered
  - **Then** it is rendered as text by the same components that render today's card; the schema
    accepts no HTML, no CSS, no expressions, and no free-form templating syntax at all.
- [ ] **Scenario: a signal that matters is never fully hidden**
  - **Given** a template that omits the components carrying failure states (auth-required,
    config-invalid, verify failure, awaiting-human)
  - **When** a row enters one of those states
  - **Then** the state is still visible — the renderer re-admits the omitted critical component for
    the rows in that state and says why, rather than honoring a preference that hides an emergency.
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
- [ ] The template schema is versioned, and an unknown version is refused with the same fail-closed
      diagnostic as an unknown component.

## Non-goals

- Any template language, expression syntax, or user-supplied markup/CSS/JS.
- Per-agent templates (per-runtime and project-default only, in v1).
- Restyling: colors, spacing, typography and the badge vocabulary stay the product's.
- Customizing anything outside the agent card (groups, pins, commands, runbooks, the Control panels).
- Changing what any element *means* — this proposal moves elements, it does not redefine them.
- A migration for people who configured nothing: there is nothing to migrate, by construction.

## Decisions that need a human

Plain language, no jargon. Each fork changes the shape of the implementation, so none of them should
be decided by whoever writes the code.

1. **Whose preference is this — the project's or the person's?**
   A layout written in `tachyon.yml` travels with the repo: every teammate and every agent-authored
   checkout gets it. A layout in VS Code settings belongs to one person on one machine. Card layout
   feels personal, but per-runtime rules ("show branch for Claude rows because that is how we work
   here") feel like project knowledge. *Proposed:* project default in `tachyon.yml`, optional
   personal override in VS Code settings, personal wins, and the settings UI says which one is in
   effect. Alternative: pick exactly one home and refuse the other.

2. **Does a runtime override start from the default or from nothing?**
   If it extends the default, adding a new element to the product later makes it appear inside every
   override — good for discovery, surprising for someone who curated their layout. If it replaces,
   overrides stay exactly as written and silently miss new elements forever. *Proposed:* the
   override declares it (`extends: default` or `replace`), with no default guess.

3. **May a person hide a failure signal?**
   Someone who hides "auth required" to get a tidy card will eventually stare at an idle agent that
   cannot run. *Proposed:* critical states are re-admitted automatically for the affected row only,
   with a tooltip explaining that the template omitted it. Alternative: honor the preference
   literally and accept the silence.

4. **How much layout is enough?**
   *Proposed v1:* a flat ordered list of components in three fixed regions (header, meta, footer),
   plus per-component options from a closed set. No nesting, no columns, no conditionals. This is
   deliberately less power than a person will eventually ask for — the question is whether that is
   the right starting point or a frustration.

5. **Where does the live preview live?**
   *Proposed:* Control → Settings, beside the Companion block, which is already an editable settings
   block with host round-trips. Alternative: only the dev preview harness (cheaper, but then the
   person editing YAML has no feedback until they save and look).

## Open questions

- Should a template be able to declare a *compact* variant that the sidebar switches to under a
  width threshold, or is one template per runtime enough with components handling their own
  truncation? (Leaning: components handle it; a second template doubles the validation surface.)
- Do terminals get their own template arm, or is "runtime" the only axis? Terminal rows share the
  component catalog but never carry model/continuity/evidence.
- Does the preview need real fleet data (a live row from this workspace) or are fixtures enough for
  the decision the human is making while editing?
