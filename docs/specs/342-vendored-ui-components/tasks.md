# 342 — vendored-ui-components — tasks

_Generated 2026-07-03. GATE-FIRST: T3's recorded pass/fail is the contract for everything after it. Commit
per task, ALWAYS by pathspec (shared index). Pin-studio suite green at every commit._

## Implementation

- [x] T1 Pipeline: Tailwind v4 build step in esbuild.mjs (opt-in per surface, preflight OFF), exact-pinned
  Radix/cva/clsx/tailwind-merge deps, `npm run test:browser` script scaffold (puppeteer-core + system
  Chrome detection), ui-gate esbuild entry.
- [x] T2 Token bridge: shared/vscode-theme.css with full variable set + fallback chains; unbridged-variable
  build check; injected once via renderWebviewShell; fixtures dark/light/HC/missing-token.
- [ ] T3 COMPAT GATE: vendor the 5 components into shared/ui/vendor/ (shadcn CLI output, adapted imports);
  gate page exercising each; browser tests per spec checklist; RECORD per-component pass/fail + exclusions
  in notes.md. Staging: 1a = Tooltip + (DropdownMenu|Select); 1b = Popover + Dialog.
- [ ] T4 Kit wrappers (passed 1a components): shared/ui/kit/ (KitSelect, KitFieldRow, KitLabeledInput,
  KitTooltip/KitDropdown), legacy fallback per component at wrapper boundary (build-time, no call-site
  change), a11y contract checks (axe-static + browser keyboard), preflight mixed fixture, shell CSS-order
  snapshot.
- [ ] T5 Pilot A: Plugins panel adopts kit components; fallback demonstrated on one wrapper; style
  isolation proven (fixture assertions hold on the real surface).
- [ ] T6 1b wrappers (Popover/Dialog) if gated; else record exclusion + keep legacy internals.
- [ ] T7 Pilot B: Task Studio fields row → Kit*; 339 behaviors intact (edit gating, CAS, freshness banner);
  before/after implementation stated; rebase over any round-2 dogfood fixes.
- [ ] T8 Accounting + docs: bundle deltas + duplicated-module count in notes.md; shared/ui/README.md import
  matrix; VENDORED.md (CLI version, registry commit, command, config baselines, LICENSES, pinned Radix);
  full suite + both typechecks green.

## Verification

- [ ] Compat gate results recorded per component with browser-level evidence.
- [x] Token bridge completeness check red/green demonstrable (remove a mapping → build fails).
- [ ] Preflight fixture: computed styles identical before/after Tailwind on .ds-* markup.
- [x] CSS-order snapshot fails on reorder.
- [ ] Fallback: one wrapper flipped to legacy without call-site changes, pilot still green.
- [ ] a11y contract checks green for every shipped wrapper.
- [ ] Pilot A + B surfaces behave (suite + targeted browser checks incl. pin-studio).
- [ ] `npm test` and both typechecks green.

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
