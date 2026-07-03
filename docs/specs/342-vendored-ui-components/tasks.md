# 342 — vendored-ui-components — tasks

_Generated 2026-07-03. GATE-FIRST: T3's recorded pass/fail is the contract for everything after it. Commit
per task, ALWAYS by pathspec (shared index). Pin-studio suite green at every commit._

## Implementation

- [x] T1 Pipeline: Tailwind v4 build step in esbuild.mjs (opt-in per surface, preflight OFF), exact-pinned
  Radix/cva/clsx/tailwind-merge deps, `npm run test:browser` script scaffold (puppeteer-core + system
  Chrome detection), ui-gate esbuild entry.
- [x] T2 Token bridge: shared/vscode-theme.css with full variable set + fallback chains; unbridged-variable
  build check; injected once via renderWebviewShell; fixtures dark/light/HC/missing-token.
- [x] T3 COMPAT GATE: vendor the 5 components into shared/ui/vendor/ (shadcn CLI output, adapted imports);
  gate page exercising each; browser tests per spec checklist; RECORD per-component pass/fail + exclusions
  in notes.md. Staging: 1a = Tooltip + (DropdownMenu|Select); 1b = Popover + Dialog.
  **Result: Tooltip FAIL, DropdownMenu PASS, Select PASS, Popover PASS, Dialog FAIL — revised staging 1a =
  DropdownMenu + Select (T4); Popover's gate also done, wrapper lands per its own T4/T6 timeline; Tooltip and
  Dialog EXCLUDED (no Kit wrapper ships for either). Full table in notes.md.**
- [x] T4 Kit wrappers (passed 1a components): shared/ui/kit/ (KitSelect, KitFieldRow, KitLabeledInput,
  KitTooltip/KitDropdown), legacy fallback per component at wrapper boundary (build-time, no call-site
  change), a11y contract checks (axe-static + browser keyboard), preflight mixed fixture, shell CSS-order
  snapshot.
  **Shipped: KitSelect (dual radix/legacy via `TACHYON_KIT_SELECT` build define), KitFieldRow (thin
  re-export), KitLabeledInput (new a11y-composed wrapper, no legacy split needed), KitDropdown (thin
  re-export, no legacy dropdown-menu exists to fall back to — same posture as Dialog's exclusion). No
  KitTooltip (excluded in T3). Fallback mechanism build-verified for real (see notes.md); pilot-level proof
  is T5's job per this task's own wording.
- [x] T5 Pilot A: Plugins panel adopts kit components; fallback demonstrated on one wrapper; style
  isolation proven (fixture assertions hold on the real surface).
  **Shipped: KitSelect for the installed-list sort control; KitDropdown as each card's secondary-actions
  (Check/Docs/Config) overflow menu — primary status actions (Update/Reinstall/Remove) stay direct Buttons.
  Fallback demonstrated for real: rebuilt with `TACHYON_KIT_SELECT=legacy`, reran the Pilot A browser suite —
  the panel still renders + the dropdown still works; ONLY the Radix-specific sort-reorder assertion fails
  (predictably, since the native `<select>` fallback carries no `data-slot` attributes), zero App.tsx
  changes either way. CAUGHT A REAL BUG in the process: the `plugins` esbuild target had no
  `preactCompat` alias, so Radix internals resolved to a second, uninitialized real "react" and crashed with
  a null-dispatcher hooks error — fixed by moving the alias onto the shared `sidebar` base (esbuild.mjs), so
  every future kit/vendor-consuming surface (T7's Pilot B included) gets it automatically. Full account in
  notes.md.**
- [x] T6 1b wrappers (Popover/Dialog) if gated; else record exclusion + keep legacy internals.
  **Popover gated PASS (T3) → shipped as thin re-exports (KitPopover*, same posture as KitDropdown — no
  pre-existing legacy popover to fall back to). Dialog stays EXCLUDED (recorded in T3; no KitDialog ships).
  Added to the ui-gate Kit section + a11y/keyboard test (test/browser/kitA11y.test.ts): opens auto-focusing
  its field, Escape closes with focus restored. No pilot adopts KitPopover yet — available for a future
  surface, per T4's "wrapper exist + a11y-checked" bar (adoption isn't required for every wrapper).**
- [x] T7 Pilot B: Task Studio fields row → Kit*; 339 behaviors intact (edit gating, CAS, freshness banner);
  before/after implementation stated; rebase over any round-2 dogfood fixes.
  **The `ts-fields` row (Kind/Priority/Assignee) migrates: BEFORE — a raw `<label class="ts-field"><span>`
  wrapper around `<input class="ds-input">` (Kind, Assignee) and the legacy `Select` (Priority). AFTER —
  KitFieldRow (thin re-export, byte-identical row rhythm) + KitLabeledInput (Kind, Assignee) + KitSelect
  (Priority, defaults to Radix). The `ts-chip-fields` row (Deps/Artifacts) is UNCHANGED — it's a custom chip
  pattern, not Select/Input; spec.md's own open question defers Combobox/KitChipInput to a later batch.
  Edit-mode gating verified intact (Assignee disabled in "new" mode, enabled in "edit"); CAS
  (`expectUpdatedAt`) and the freshness banner are untouched — neither depends on which control renders a
  field, only on `dirty`/`originalRef` state, which the migration didn't touch. Full parity notes +
  Priority's empty-string→sentinel fix (Radix Select rejects `value=""`) in notes.md.**
- [ ] T8 Accounting + docs: bundle deltas + duplicated-module count in notes.md; shared/ui/README.md import
  matrix; VENDORED.md (CLI version, registry commit, command, config baselines, LICENSES, pinned Radix);
  full suite + both typechecks green.

## Verification

- [x] Compat gate results recorded per component with browser-level evidence.
- [x] Token bridge completeness check red/green demonstrable (remove a mapping → build fails).
- [x] Preflight fixture: computed styles identical before/after Tailwind on .ds-* markup.
- [x] CSS-order snapshot fails on reorder.
- [x] Fallback: one wrapper flipped to legacy without call-site changes, pilot still green. (rebuilt Pilot A
  with TACHYON_KIT_SELECT=legacy: panel renders + KitDropdown still works, only the Radix-specific
  sort-reorder assertion fails as predicted; zero App.tsx changes)
- [x] a11y contract checks green for every shipped wrapper.
- [x] Pilot A + B surfaces behave (suite + targeted browser checks incl. pin-studio). Pilot A:
  test/browser/pilotAPlugins.test.ts (real bundle via the preview harness). Pilot B:
  test/browser/pilotBTaskStudio.test.ts (real bundle, minimal fixture VM — Task Studio isn't onboarded into
  the preview harness). pin-studio has no dedicated browser check here (byte-untouched; its unit tests are
  part of the green `npm test` run below) — a targeted human/browser pin-studio smoke stays Human Dogfood.
- [x] `npm test` and both typechecks green.

**Headless check:** `npm test -- --run test/unit/vscodeThemeBridge.test.ts test/unit/cssOrderSnapshot.test.ts && npm run typecheck`

**Verify:** `npm test -- --run test/unit/vscodeThemeBridge.test.ts test/unit/cssOrderSnapshot.test.ts`
**Verify:** `npm run typecheck`

## Dogfood

**Dogfood:** `npm run test:browser`
<!-- The compat gate IS the dogfood: real Chrome driving the five components under the exact webview
     aliases/CSP. Surfaces need the human pass below. -->

**Human dogfood:** Install the VSIX after Pilot A: open the Plugins panel (kit controls uniform, themed,
keyboard-operable; switch VS Code theme dark/light/HC live). After Pilot B: Task Studio fields row —
uniform rhythm, all 339 interactions intact. Pin Studio smoke (untouched but compat-adjacent).

## Visual QA

- [ ] Evidence: agent-screen captures — gate page, Pilot A panel (3 themes), Pilot B fields row.
- [ ] Verdict:
