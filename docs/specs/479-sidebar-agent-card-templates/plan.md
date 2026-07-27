# 479 — sidebar-agent-card-templates — plan

_Drafted from `spec.md` on 2026-07-27; **ratified the same day** — all five forks as proposed, plus
one boundary the human added: agent cards only, terminal rows out of scope. `tasks.md` is the ordered
backlog generated from § Phasing._

Every line number in § Inventory was read at **`237af29b`** and describes the card *before* phase 1.
§ What phase 1 changed in this design records where the shipped code diverges from what was proposed,
and why; the inventory is deliberately left as it was, because it is the measurement the design was
derived from, not a description of today's file.

## Inventory — what a card is today

### A. The rendered anatomy (`src/webview/sidebar/App.tsx`)

| Region | Element | Source | Condition |
|---|---|---|---|
| header (`.row-top`) | children toggle / gutter spacer | `:287-306` | has children, or top-level childless |
| header | status dot | `:307` | always |
| header | name | `:308` | always |
| header | `— model` + provenance marker (`≠ declared`, `· stale`, `· declared`, `· profile`) | `:308`, `ModelProvenance :120-132` | `model && modelSource` |
| header | CPU·Mem pill (expands lanes) | `:310-325` | `resources` and a live-ish status |
| meta (`.row-meta`) | `sub` line | `:329` | `sub` |
| meta | collapsed-children count badge | `:330-335` | collapsed with hidden rows |
| meta | branch badge (`⎇`, drift `⚠`) | `BranchBadge :135-152` | `liveBranch` |
| meta | config-invalid, attention, awaiting-human, auth-required | `AgentBadges :193-228` | per latch |
| meta | verify pass/fail/stale, evidence, external tools, harness, resumable/fresh-start, fork, continuity, persistence hooks | `AgentBadges :229-268` | per field |
| focus (`.row-focus`) | source chip + task id + focus text | `:339-348` | `focus` (spec 390) |
| detail (`.row-detail`) | CPU and Mem lanes with meters | `ResourceDetail :166-190` | metrics pill expanded |
| actions (`.actions`) | primary actions inline + overflow menu | `:351-354`, `src/sidebar/actions.ts:60-106` | per capability gates |

Two facts this table makes visible, and both shape the design:

1. **Every element is already conditional.** Nothing renders unconditionally except the dot and the
   name. A template does not introduce conditionality — it adds a second, human-owned filter on top
   of the product's own.
2. **Badges are a flat sequence inside one region.** `AgentBadges` is a single fragment with a fixed
   internal order. Ordering *within* the meta region is therefore the cheapest real power to offer,
   and it is exactly what a per-runtime override wants ("branch first for worktree-heavy work").

### B. The data (`src/sidebar/types.ts:34-112`)

`AgentVM` carries ~50 fields, each documented with the spec that introduced it. The catalog is
derived from this type, not invented beside it — a component exists because a field exists.

### C. Where settings live today — three surfaces, measured

| Surface | Scope | Validation | Precedent for us |
|---|---|---|---|
| `tachyon.yml` `settings:` | project, shared, in git | per-key fail-closed in `loadConfig.ts` (companion block `:1627-1654`: unknown key refused by name, whole block dropped on error) | the validation shape to copy verbatim |
| VS Code `contributes.configuration` | one person, one machine | JSON schema in `package.json` (10 keys today) | where a personal override would go |
| Control → Settings | UI over both | `src/webview/cockpit/App.tsx:1713-1760` — jump buttons plus the Companion block with live toggles and host round-trips | the live-preview host |

### D. How the sidebar gets its data

`SidebarPrototype` posts `fleetMessage(fleets, sortPrefs, collapsedKeys, appVersion)` (`:173`).
`sortPrefs` and `collapsedKeys` are already **personal, non-VM state riding beside the model** — the
template travels the same way, which is why this does not need a new transport.

### E. Preview already exists in the dev harness

`scripts/webview-preview/fixtures/sidebar.ts` renders the real sidebar bundle against typed
`FleetVM` fixtures (`default` is the shipped `SAMPLE`; the rest are synthetic edges). The in-Settings
preview reuses those fixtures and that component — it does not get a second renderer, because a
preview that can disagree with the real card is worse than no preview.

## The proposal

### 1. Component catalog — closed, derived, versioned

A fixed set of ids, each mapping to one existing renderer fragment and one region. v1 candidate set:
`status-dot`, `name`, `model`, `model-provenance`, `metrics-pill`, `sub`, `hidden-count`, `branch`,
`config-invalid`, `attention`, `awaiting-human`, `auth-required`, `verify`, `evidence`,
`external-tools`, `harness`, `resume`, `fork`, `continuity`, `persistence-hooks`, `focus`,
`metrics-lanes`, `actions`.

Closed because an open catalog is a template language with extra steps: an id the product does not
implement can only be rendered by interpreting it, and interpretation is where markup gets in.

### 2. Schema — data, not language

```yaml
settings:
  sidebar:
    cardTemplate:
      version: 1
      header: [status-dot, name, model, model-provenance, metrics-pill]
      meta:   [branch, attention, auth-required, verify, harness]
      footer: [focus, metrics-lanes, actions]
      options:
        model: { maxChars: 24 }
        focus: { lines: 1 }
      runtimes:
        claude:
          extends: default        # or: replace
          meta: [branch, verify, continuity]
```

Three regions, ordered arrays of ids, a closed per-component options map, and an explicit
inheritance switch. No expressions, no strings that reach the DOM as anything but text, no styling.

### 3. Validation — the loader refuses, the renderer never guesses

Modeled on `settings.companion`: unknown key named and refused, malformed block dropped whole, errors
accumulated rather than thrown. Additional rules this schema needs: unknown component id refused
(with the catalog listed), duplicate id in one region refused, unknown `version` refused, unknown
runtime key refused against the same runtime name list the rest of the product uses. On any error the
sidebar renders the **default** template and surfaces the diagnostic where config errors already
appear — the existing `configInvalid` row banner is the precedent.

### 4. Critical states are re-admitted, not overridable

`auth-required`, `config-invalid`, `verify: fail` and `awaiting-human` are re-inserted into the meta
region for the rows that carry them even when the template omits them, with a tooltip saying the
template hid it. This is the one place the product overrides the person, and it is the difference
between a preference and a footgun. (Fork 3 in `spec.md` — a human may decide the opposite.)

### 5. Preview — the real component, fixture rows, inline errors

A Settings block renders `AgentRow` against the harness fixtures at the sidebar's real width, plus a
narrow-width pane, and shows validation errors inline as the text changes. It reuses the fixture set
so the preview cannot drift from production, and it never touches live fleet state (an editing UI
that mutates or depends on a live agent is a second failure mode for no gain).

### 6. Migration — nothing to migrate

The default template is the current layout expressed in the catalog. The proof obligation is a test
asserting that rendering the default template equals rendering today's `AgentRow` for a fixture
matrix — if that test cannot be written, this design is wrong and should be stopped there.

## What phase 1 changed in this design

Phase 1 was the test of the design, so what it had to change is the most useful part of this document.
Four things, none of which alters the ratified schema a person writes:

1. **The catalog needs an inline relation; the template does not.** `model` and `model-provenance`
   render *inside* the `.name` span, not beside it (`App.tsx:308` in the inventory) — the sidebar's CSS
   and the row's reading order both depend on it. A flat ordered list of three regions cannot say
   that. Rather than add nesting to the template — which is fork 4, ratified against — the CATALOG
   declares it: `inlineWith: "name"` on `model`, `inlineWith: "model"` on `model-provenance`. The
   template a person writes stays flat; a host renders its inline members in template order, and only
   when the host itself renders (so hiding `model` hides its provenance marker, which is the only
   sensible reading).

2. **The disclosure toggle is not a catalog component.** The proposal's v1 id list omitted it and that
   omission turned out to be load-bearing: the gutter reveals child *rows*, so a template able to hide
   it would make collapsed children unreachable — a customization that breaks navigation, not
   appearance. It stays structural, rendered before the header region, and a test pins its absence
   from the catalog so a later phase does not "complete" the list by adding it.

3. **The V1 boundary lives in the resolver, not in its callers.** Agent and terminal rows render
   through the same component, so "terminal rows are out of scope" cannot be a convention. It is
   `resolveCardTemplate(row, configured)`: a non-agent row takes the default whatever is configured.
   That function exists in phase 1 with no producer for `configured` — it is written before there is a
   configuration surface to violate it, and proven by test now rather than reviewed later.

4. **`hasMeta` is untouched, and that is a decision.** Whether `.row-meta` exists is still the
   product's own predicate; the template only orders what goes inside. This preserves an existing
   quirk exactly (a row with `worktree` but no live branch renders an empty `.row-meta`), which phase 1
   pins as a fixture instead of quietly fixing — see the open question it raises in `spec.md`.

The equality proof needed a harness this repository did not have: the unit suite runs in node with no
DOM, and preact hooks require a rendering component. `test/helpers/staticPreact.ts` bundles the REAL
component with esbuild (the `dsButtonIconLabel.test.ts` pattern), aliases `preact/hooks` to an inert
stub, and serializes the vnode tree — including function-valued props as `[fn]`, so a lost `onClick`
is a diff rather than a silent pass. The golden was captured from the renderer at `76546c4d`
**before** the refactor: that ordering is what makes the file evidence about the prior card. It is
also, incidentally, the cheapest visual review this surface has ever had — a card change now shows up
as a readable text diff.

## Phasing (one shippable slice each)

1. **[done]** Catalog + default template + the equality test against today's card. No config surface:
   the card is rendered *through* the template with zero visible change.
   Landed as `src/sidebar/cardTemplate.ts` (closed catalog, default template, `resolveCardTemplate`),
   `src/webview/sidebar/App.tsx` (`CARD_COMPONENTS`, a `Record<CardComponentId, …>` so an id without a
   renderer does not compile), and the proof in `test/unit/sidebarCardTemplateEquality.test.ts` +
   `test/unit/sidebarCardCatalog.test.ts`.
2. **[done]** Project template in `tachyon.yml` with the fail-closed loader and the critical-state
   re-admission. Landed as `parseCardTemplate` (one validator, which phase 5's second home reuses
   rather than reimplements), the `settings.sidebar.cardTemplate` block in `loadConfig.ts`,
   `FleetVM.cardTemplate` + `cardTemplateRefusal` carried through the strict wire schema,
   `readmittedCriticalComponents`, and `CardMetaRegion`. See § What phase 2 changed in this design.
3. **[done]** Per-runtime overrides with the explicit `extends`/`replace` switch. Landed as the
   `runtimes:` arm in `parseCardTemplate` (each override resolved to a COMPLETE template at parse
   time), `CardTemplateConfig` = `{ base, runtimes }` on the wire, `AgentVM.runtime` projected by the
   same `runtimeOf` the model label already uses, and a lookup in `resolveCardTemplate`. See § What
   phase 3 changed in this design.
4. Settings block with the live preview.
5. Optional personal override in VS Code settings, with precedence stated in the UI.

Phase 1 was where the design was proven or disproven, and it changed nothing a person can see — a good
place to stop if the answer had come out wrong. It did not: the default template reproduces all 60
fixture cards byte for byte, so the catalog can express the card that exists.

## What phase 2 changed in this design

1. **Refusing a template must not refuse the file.** The plan said validation would be "modeled on
   `settings.companion`", and its SHAPE is — unknown key by name, block dropped whole, errors
   accumulated. Its SEVERITY could not be: in this loader any `errors` entry returns no config at all
   (`loadConfig.ts`, `if (errors.length > 0) return { errors, warnings }`), so the workspace falls back
   to ledger/last-known-good and spawning goes read-only. That is proportionate for a security-relevant
   key like `companion`; for a layout preference it would mean a typo in a cosmetic setting takes the
   fleet offline. A malformed template is therefore dropped with a WARNING plus a durable in-sidebar
   banner, and the rest of the file loads normally.

2. **The template belongs IN the fleet, not beside it.** The plan proposed carrying it like
   `sortPrefs`/`collapsedKeys`, which ride next to the fleet in the message envelope. Those are one
   person's preferences across every root; a card template is one PROJECT's, read from that folder's
   `tachyon.yml`, and multi-root means two folders can legitimately disagree. It is a `FleetVM` field —
   which also means it must be declared in the strict wire schema, or the projection silently drops the
   whole fleet (the SDD 478 M5 failure).

3. **An unmentioned region inherits; an empty one obeys.** Not previously decided. Silence deleting a
   person's actions row is exactly the "worse for its owner, by accident" outcome § Intent says the
   design must make hard, so an unmentioned region keeps the default. `meta: []` is explicit and is
   honored — with critical re-admission still applying.

4. **`options:` is refused, not accepted-and-ignored.** The ratified schema sketch shows per-component
   options (`model.maxChars`, `focus.lines`). No component implements one, and accepting a key the card
   cannot honor is a promise it does not keep — so the key is refused by name and filed as its own task.

The wrapper question phase 1 left open is answered in `spec.md` § Open questions: `.row-meta` follows
what its components render. That change also fixed a **shipped bug** the equality matrix caught — the
old `hasMeta` predicate omitted `evidence`, so spec 273's badge was invisible on any row whose only
meta content was evidence.

## What phase 3 changed in this design

1. **A row had no runtime to key on.** The whole feature is "per-runtime", and `AgentVM` — the ~50-field
   view-model this design was derived from — did not carry the runtime. It carries `model` and
   `modelSource`, which are *derived* from the runtime, so the information existed but only inside
   `agentModel`'s model resolution. `AgentVM.runtime` is now projected there, from the same command by
   the same `runtimeOf` the model label uses: a row cannot report one runtime to the card and another
   to the model, because there is one derivation.

2. **`extends: default` layers onto the PROJECT's template, not the bare product default.** The
   ratified text said "`extends: default` or `replace`" without saying what `default` names. Choosing
   the project's template makes the three layers compose (product → project → runtime) and keeps fork
   2's stated trade-off intact — a new product element still reaches an override, through the project
   template's own unmentioned regions. The alternative reading would let one runtime's override
   silently discard every decision the project made for all its other rows.

3. **A partial `replace` is refused, not completed.** "Exactly as written" is only safe when what is
   written is a whole card; a `replace` listing just `meta:` would leave rows with no name and no
   actions. The refusal names the missing regions and points at `extends: default`. This is the same
   principle as phase 2's "silence inherits, `[]` obeys" — the difference is that `replace` declared
   that it inherits nothing, so silence there cannot mean inheritance and must mean a mistake.

4. **Overrides resolve at parse time, not at render time.** The wire carries complete templates per
   runtime, so the strict schema validates concrete data, the renderer does a lookup rather than a
   merge, and "which template is this row using" has one answer computed in one place — which is also
   what phase 4's preview will need to display.

The override keys validate against `SUPPORTED_ADHOC_AGENT_RUNTIME_NAMES` rather than the attested four
named in the task: a declared agent is attested, but an ad-hoc one may be OpenCode/Gemini/Qwen/Hermes,
and refusing those keys would refuse an override for rows this product creates.

## Rejected alternatives

- **A string template language** (`{{name}} — {{model}}`). Rejected: it needs an interpreter, an
  escaping story and a versioned grammar, and its first feature request is conditionals. The card is
  a fixed set of typed fragments; ordering them is the actual need.
- **User CSS / a theme file.** Rejected outright by the task and correct on its own merits: CSS can
  hide an emergency badge, break the narrow layout, and violate contrast without any validation
  surface able to detect it.
- **Per-agent templates.** Rejected for v1: the axis people describe is "how I read Claude rows vs
  Codex rows", and per-agent multiplies the config surface by the fleet.
- **A drag-and-drop layout editor.** Rejected as the first deliverable: it presumes the schema is
  already right. If the YAML form proves itself, an editor becomes a thin producer of the same data.
- **Storing the template in `.tachyon/` as its own file.** Rejected: it would be a fourth settings
  home with its own reload path, next to three that already exist.
- **Letting a template add elements the product does not render** (arbitrary fields from `AgentVM`).
  Rejected: every current element carries meaning built by its own spec — provenance markers,
  drift warnings, tooltips. A generic field printer would produce true-but-unreadable rows.
