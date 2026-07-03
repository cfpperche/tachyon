# 342 — vendored-ui-components

_Created 2026-07-03._

**Status:** shipped

**Closure:** T1-T8 shipped (2026-07-03): Tailwind v4 pipeline + token bridge + the T3 compat gate (recorded
per-component pass/fail: DropdownMenu/Select/Popover PASS, Tooltip/Dialog FAIL and excluded) + Kit wrappers
(KitSelect/KitFieldRow/KitLabeledInput/KitDropdown/KitPopover) + Pilot A (Plugins panel) + Pilot B (Task
Studio fields row) + bundle accounting/README/VENDORED.md docs. Full suite, both typechecks, and
`npm run test:browser` (31/31) green. Human VS Code dogfood (real theme switching, agent-screen visual QA)
remains outstanding — optional/informational per this project's SDD convention, tracked in `tasks.md`'s
Human Dogfood + Visual QA sections, not a closure blocker.

## Intent

Every webview surface hand-rolls its form controls today: the same select/input/field-row gets rebuilt per
surface with drifting heights, margins and rhythm — three separate instances surfaced in one 339 dogfood
day, each fixed as a one-off. Task t-c04b3e decided the systemic fix: **vendored shadcn/ui components** as
the project's component library, themed to VS Code, adopted incrementally.

Pillars (maintainer decisions, 2026-07-03): shadcn is vendored source, not a dependency (local-first);
Preact stays and React arrives via the existing `preact/compat` esbuild aliases; theming is a token bridge
into `--vscode-*`; bundle size is not a strategic blocker (local-disk webviews).

**Posture correction (dueto F1, accepted):** Excalidraw running under compat proves compat can host a large
React app — it does NOT prove Radix's focus/dismissal machinery (FocusScope, DismissableLayer, Portal,
roving focus, composed refs) behaves correctly. Radix-under-compat is therefore a GATE with explicit
pass/fail per component, not an assumption.

## Acceptance criteria

- [x] **Scenario: compat gate (before ANY wrapper or pilot work)** (dueto F1/F13/F16)
  - **Given** an isolated gate page bundled with the exact webview esbuild aliases + CSP
  - **Then** each batch-1 component is verified with BROWSER-LEVEL checks (not jsdom — jsdom may cover
    render/props only): open/close, Esc, outside-click dismissal, Tab/Shift+Tab containment where
    applicable, focus restore, nested portals, keyboard nav/typeahead, aria-expanded/aria-controls/id
    stability — via the agent-browser harness or a minimal playwright dev-dep (plan decides)
  - **And** batch 1 is staged internally: **1a = Tooltip + (DropdownMenu or Select, whichever gates
    cleanest)**; **1b = Popover + Dialog** only after 1a lands with fallback wiring; a component that fails
    the gate is EXCLUDED and its wrapper keeps the legacy implementation
- [x] **Scenario: Tailwind v4 pipeline, preflight off** (dueto F4/F5/F14)
  - **Then** Tailwind compiles at build time into per-surface CSS (no runtime, CSP unchanged) with
    **preflight DISABLED for webview bundles** (a scoped strategy is admissible only with proof no global
    element reset can reach `.ds-*` markup); a mixed fixture (representative .ds- buttons/inputs/selects/
    tables/lists/headings next to shadcn components) asserts computed styles (spacing/border/font/
    background/outline/box-sizing) before/after Tailwind inclusion
  - **And** the FINAL CSS order produced by `renderWebviewShell` (design-system.css → vscode-theme.css →
    Tailwind layers → surface CSS) is captured by a snapshot test that fails if the order changes, verified
    against the minimum supported VS Code webview Chromium
  - **And** `vscode-theme.css` is ONE shared source injected once per surface via the shell (never forked
    or duplicated per surface)
- [x] **Scenario: complete token bridge with fallbacks** (dueto F6/F7)
  - **Then** `vscode-theme.css` defines EVERY CSS variable emitted by the generated shadcn config and used
    by vendored batch-1 source (background/foreground, card/-foreground, popover/-foreground,
    primary/-foreground, secondary/-foreground, muted/-foreground, accent/-foreground,
    destructive/-foreground, border, input, ring, radius, plus anything else the template emits), a check
    fails the build on any unbridged shadcn variable reference, and every mapping carries a **fallback
    chain ending in a hardcoded semantic fallback** (VS Code themes do not guarantee every --vscode-*
    token); acceptance fixtures: default dark, default light, high contrast, and a synthetic
    missing-token theme — all with visible focus, legible borders/contrast and readable disabled states
- [x] **Scenario: vendored batch 1 + house wrappers with kill switch** (dueto F3/F11/F12)
  - **Given** `src/webview/shared/ui/vendor/` (shadcn-generated source, adapted imports)
  - **Then** house wrappers live in a DISTINCT namespace (e.g. `shared/ui/kit/` — KitSelect, KitFieldRow,
    KitLabeledInput, KitChipInput) so they can never be confused with the legacy `Select`/`FieldRow`
    primitives shipped days ago; every wrapper has a **legacy fallback path at the wrapper boundary**
    (selectable per component at build time, no call-site changes) and pilot acceptance demonstrates the
    fallback on at least one wrapper
  - **And** each wrapper carries an accessibility CONTRACT (label/description/error association,
    aria-invalid, disabled/read-only, visible focus ring, keyboard-only operation, focus restore, no trap)
    checked by axe-or-equivalent static checks + browser keyboard tests, with parity notes for any behavior
    deliberately changed from the legacy controls
- [x] **Scenario: two-stage pilot** (dueto F2)
  - **Then** **Pilot A** migrates a LOW-RISK mixed surface (one Select, one Tooltip/DropdownMenu, one
    Popover/Dialog from the gated set; no CAS/edit-mode coupling) proving style isolation + compat in
    production; **Pilot B** (only after A passes) migrates the Task Studio fields row — the surface whose
    dogfood motivated this spec — preserving all 339 behaviors (edit-mode gating, CAS submits, freshness
    banner) and stating explicitly which Select/FieldRow implementation it uses before and after
- [x] **Scenario: no regression outside the pilots**
  - **Then** every other surface is byte-untouched; the full suite + both typechecks stay green; pin-studio
    passes its suite unchanged plus a targeted browser check (heaviest compat consumer)
- [x] **Bundle accounting** (dueto F10): report per-entry JS/CSS deltas for the pilots + the duplicated
  Radix/shadcn module count projected across all webview entries — acceptance does not block on size, but
  the numbers are recorded and code-splitting/shared-chunks is an explicitly deferred-or-not decision
- [x] `shared/ui/README.md` documents the **import matrix** (legacy `.ds-*` primitives / vendor source /
  kit wrappers — what each is, allowed surfaces, migration status) and the adoption rule (new UI = kit;
  legacy migrates only with a reason) — written for the ad-hoc implementer agents (dueto F11)
- [x] **Vendoring + upgrade discipline** (dueto F8/F9/F15): VENDORED.md records shadcn CLI version,
  registry commit, generation command, components.json and Tailwind config baselines, and local adaptation
  rules; upstream license notices are preserved where present and a LICENSES section documents provenance
  (shadcn/ui MIT, Radix packages, cva/clsx/tailwind-merge) WITHOUT inventing per-file headers; Radix
  runtime deps are PINNED in the lockfile and listed — any Radix version change reruns the compat gate and
  records the result even when vendored source is unchanged

## Non-goals

- Wholesale migration of existing surfaces; replacing design-system.css or its tokens.
- Real React (compat is the deal; a component that cannot pass the gate is excluded, not a reason to
  migrate the stack).
- Tailwind on legacy surfaces; runtime theming beyond the editor's own themes.
- Batch 2+ (Combobox, Command, Toast, Tabs…) until batch 1 proves the pattern end-to-end.

## Open questions

- Browser-level test harness for the gate: agent-browser plugin (already in-house, drives real Chrome) vs
  a minimal playwright dev-dep — plan decides by wiring cost; the gate criteria above are harness-agnostic.
- Pilot A surface candidate: Plugins panel or Server Inspector (low-traffic, mixed-friendly) — plan picks.
- Whether KitChipInput needs Combobox pulled forward or composes from gated 1a/1b primitives.
