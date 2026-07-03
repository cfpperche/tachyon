# 342 — vendored-ui-components

_Created 2026-07-03._

**Status:** draft

## Intent

Every webview surface hand-rolls its form controls today: the same `<select>`/`<input>`/field-row gets
rebuilt per surface with drifting heights, margins and rhythm — the maintainer hit three separate
instances of this during the 339 dogfood (unthemed select, select shorter than inputs, DEPS/ARTIFACTS row
off-rhythm), each fixed as a one-off. Task t-c04b3e decided the systemic fix: stop reinventing controls and
adopt **vendored shadcn/ui components** as the project's component library — themed to VS Code, incrementally.

The three pillars (settled with the maintainer, 2026-07-03):
1. **shadcn is vendored source, not a dependency** — components are copied into the repo and become ours
   (fits local-first). Their runtime deps are Radix primitives + Tailwind.
2. **Preact stays; React arrives via `preact/compat`** — the esbuild aliases already exist
   (esbuild.mjs, `react → preact/compat`) and are battle-proven by Excalidraw, a far more demanding React
   component than any Radix primitive, running in production in two Studios.
3. **Theming = token bridge**: shadcn styles by CSS variables (`--background`, `--primary`, `--radius`…);
   one mapping file points them at `--vscode-*` equivalents and dark/light/high-contrast come free with the
   editor theme. Bundle size is a non-issue (webviews load from disk; the VSIX already ships Excalidraw).

## Acceptance criteria

- [ ] **Scenario: Tailwind v4 pipeline**
  - **Given** the esbuild-based webview build
  - **When** a surface opts into the component library
  - **Then** its Tailwind CSS compiles at build time into that surface's local stylesheet (no runtime, no
    external fetches — CSP posture unchanged), and **preflight is scoped or disabled** so Tailwind's global
    reset can NEVER restyle existing `.ds-*` markup on surfaces that mix both (cascade layers or
    preflight-off; the chosen mechanism is proven by a mixed-surface test)
- [ ] **Scenario: VS Code token bridge**
  - **Given** the shadcn theme variables
  - **Then** one `vscode-theme.css` maps them to `--vscode-*` tokens (background/foreground/primary/
    muted/border/ring/radius at minimum), the mapping is the ONLY place editor tokens are referenced by
    the vendored code, and dark/light/high-contrast render correctly with zero component changes
- [ ] **Scenario: vendored batch 1**
  - **Given** `src/webview/shared/ui/vendor/` (shadcn-generated source, adapted imports)
  - **Then** Select, DropdownMenu, Dialog, Popover and Tooltip render and behave correctly under
    `preact/compat` (portals, focus trap, keyboard nav, Esc/click-outside), each covered by a smoke test,
    and the house wrappers (`LabeledSelect`, `FieldRow`, `LabeledInput`, and a `ChipInput` for deps/
    artifact_refs) compose them with the uniform control height/row rhythm the 339 findings demanded
- [ ] **Scenario: pilot adoption — Task Studio form**
  - **Given** the surface whose dogfood motivated this spec
  - **When** its fields row migrates to the new components (kind/priority/assignee/deps/artifact_refs)
  - **Then** the form renders with uniform dimensions and rhythm, all 339 behaviors survive (edit-mode
    gating, CAS submits, freshness banner), and the surface carries both stacks without style bleed —
    proving incremental adoption end-to-end
- [ ] **Scenario: no regression outside the pilot**
  - **Then** every other surface is byte-untouched, the full suite + both typechecks stay green, and
    pin-studio (heaviest compat consumer) passes its existing tests unchanged
- [ ] A short `src/webview/shared/ui/README.md` documents what exists, when to use vendor components vs
  `.ds-*` legacy, and the adoption rule (new UI = component library; legacy surfaces migrate only with a
  reason) — written for the ad-hoc implementer agents who build most UI here
- [ ] Vendored code is license-clean (shadcn is MIT; headers preserved where present) and pinned by a
  VENDORED.md note recording the shadcn version/commit each component came from

## Non-goals

- Migrating existing surfaces wholesale (adoption is incremental and per-reason; `.ds-*` stays supported).
- Replacing design-system.css or its tokens (the bridge maps INTO them, not around them).
- Switching webviews to real React (compat is the deal; revisit only if a vendored component proves
  incompatible in practice).
- Tailwind on legacy surfaces; runtime theming beyond the editor's own theme switching.
- Batch 2+ components (Combobox, Command, Toast, Tabs…) — follow-up once batch 1 proves the pattern.

## Open questions

- Radix under compat: Dialog/Popover focus guards are the known risk area (Excalidraw proves the general
  case, not these exact primitives) — the plan must front-load a compat spike for the five batch-1
  components before any wrapper work.
- Tailwind v4 vs the shared `renderWebviewShell` styles order: layer strategy to be fixed in plan.
- Whether `ChipInput` is buildable from batch-1 primitives or needs Combobox pulled forward.
