# 479 — sidebar-agent-card-templates — proposed plan

_Drafted from `spec.md` on 2026-07-27. **Proposal only** — the approach, not the steps, and not yet
agreed. No `tasks.md` exists on purpose: implementation tasks follow ratification, not this file._

Every line number below was read at **`237af29b`**, the base of this proposal's worktree.

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

## Phasing (after ratification, one shippable slice each)

1. Catalog + default template + the equality test against today's card. No config surface yet: this
   phase is complete when the card is rendered *through* the template with zero visible change.
2. Project template in `tachyon.yml` with the fail-closed loader and the critical-state re-admission.
3. Per-runtime overrides with the explicit `extends`/`replace` switch.
4. Settings block with the live preview.
5. Optional personal override in VS Code settings, with precedence stated in the UI.

Phase 1 is where the design is proven or disproven, and it changes nothing a person can see — a good
place to stop if the answer comes out wrong.

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
