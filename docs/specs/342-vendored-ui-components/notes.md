# 342 — vendored-ui-components — notes

_Created 2026-07-03._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- **T1 — Tailwind v4 preflight-off mechanism:** import `tailwindcss/theme.css` (layer `theme`) +
  `tailwindcss/utilities.css` (layer `utilities`) directly, skipping the package-root `tailwindcss` import
  (which also pulls `preflight.css`'s global element reset into a `base` layer). Provable by construction —
  `dist/webview/ui-gate.tailwind.css` contains zero `box-sizing: border-box` resets (verified by grep).
- **T1 — Tailwind CSS is a separate build artifact, NOT `import`ed from the entry `.tsx`.** An early attempt
  did `import "./tailwind.css"` in `main.tsx`; esbuild then bundled the raw `@import "tailwindcss/..."`
  source itself as a SECOND, unminified CSS output (duplicating the dedicated `@tailwindcss/cli` step,
  defeating the point of running it). Fixed: the compiled `dist/webview/<surface>.tailwind.css` is linked
  directly in the HTML shell's `styles` list; the entry file never references the Tailwind input.
- **T1 — gate page HTML is rendered by the REAL `renderWebviewShell`** (`test/browser/support/gateServer.ts`
  imports `src/webview/shared/shell.ts` directly; vitest transpiles TS on the fly, no build step needed for
  the test harness itself), not a hand-copied HTML string — so the gate's CSP shape can't drift from what
  shipped panels actually get. `cspSource` is the plain-http server's own origin (closest analog to
  `vscode-webview://<uuid>` a non-VS-Code test process can produce).
- **T1 — `test:browser` is a second vitest config** (`vitest.browser.config.ts`, `include:
  ["test/browser/**/*.test.ts"]`), not folded into `vitest.config.ts` — keeps it out of default `npm test`
  per plan.md without inventing a bespoke runner.

- **T2 — vscode-theme.css uses shadcn's UNPREFIXED variable names** (`--background`, `--primary`, …), not
  `--ds-*` — because vendored component source (T3) is unmodified upstream shadcn/Radix code and reads those
  names directly. The Tailwind `@theme inline` mapping (`--color-background: var(--background)` etc., which
  makes `bg-background`-style utilities resolve) lives in a SEPARATE new file,
  `src/webview/shared/tailwind-theme.css`, `@import`ed by each Tailwind-opted surface's own tailwind.css —
  `@theme` is a Tailwind-only at-rule, so it can't live in vscode-theme.css itself (which ships unprocessed to
  every surface, Tailwind-opted or not) without being silently dropped as an unknown at-rule by the browser.
- **T2 — semantic → `--vscode-*` mapping choices:** `card`/`popover` → `editorWidget`/`editorHoverWidget`
  background+foreground (VS Code's own "raised panel"/"floating widget" tokens — a natural fit for
  Radix's Popover/Tooltip/DropdownMenu/Dialog surfaces); `primary`/`secondary` → `button`/`button-secondary`;
  `accent` → `list-hover` (Radix uses `accent` for item-highlight states, which is exactly what
  `list.hoverBackground` means in VS Code); `muted-foreground` → `descriptionForeground`; `ring` →
  `focusBorder`. `--radius` has no `--vscode-*` analog (VS Code doesn't expose a corner-radius token) — kept
  at `0.375rem`, close to design-system.css's existing `--ds-radius: 6px` for visual parity with legacy
  controls on a mixed surface.
- **T2 — "acceptance fixtures: dark/light/HC/missing-token" implemented as a HEADLESS resolver, not 4 browser
  screenshots.** `test/unit/support/cssVarResolver.ts` walks vscode-theme.css's `var(--a, var(--b, #lit))`
  chains against a synthetic per-fixture `--vscode-*` token map (empty for missing-token) and asserts every
  chain resolves to a real value + a WCAG contrast check on the resolved hex pairs. This is a REAL check of
  the same fallback logic a browser runs (not a re-implementation of CSS cascade — it mirrors the exact
  `var(name, fallback)` grammar this file actually uses), and it runs in `npm test` with zero browser cost.
  Genuine visual confirmation across real VS Code theme installs is still human dogfood territory (tasks.md).
- **T2 — the two headless-check files exist as planned** (`test/unit/vscodeThemeBridge.test.ts`,
  `test/unit/cssOrderSnapshot.test.ts`), plus one extra (`test/unit/vscodeThemeFixtures.test.ts`) for the
  fixture acceptance criterion — tasks.md's headless-check line names the first two explicitly; the fixtures
  file is additive coverage, not a substitute.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- **T2 — the CSS-order snapshot (tasks.md lists it under T4) landed in T2 instead**, because T2 is what first
  wires `vscode-theme.css` into a real rendered shell (`gatePage.ts`) — the order it asserts (design-system →
  vscode-theme → Tailwind) only exists from this point forward. T4 will extend the SAME snapshot with kit
  wrapper CSS appended, not replace it.
- **T2 — a third TS project, `tsconfig.browser-test.json`, was added** (not in plan.md's file list).
  `puppeteer-core` ships ESM-only; `test/browser/**` living under the main CJS-resolution tsconfig failed
  `tsc --noEmit` with TS1479 (require-of-ESM). Excluded `test/browser` from the main tsconfig and typecheck
  it under its own `module: ESNext` / `moduleResolution: Bundler` project instead (mirrors how
  `tsconfig.webview.json` already carves out the webview surfaces). `npm run typecheck` now runs three `tsc`
  invocations; the script's NAME and calling convention are unchanged.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Design dueto (probe codex, adversarial-review, 2026-07-03, runId probe-850a053c)

16 findings (1 blocker), spec text inline per [[probe-sandbox-no-fs]]. Disposition — ALL ACCEPTED (no
rebuttals; the probe respected the maintainer's settled decisions and attacked execution risk):
- F1 (BLOCKER) compat-gate: Excalidraw precedent downgraded from proof to plausibility; browser-level gate
  with per-component pass/fail before any wrapper/pilot work. F13 folded (jsdom = render/props only).
- F16 staged batch (1a Tooltip+Dropdown/Select, 1b Popover+Dialog); F3 kill-switch at wrapper boundary.
- F2 two-stage pilot: low-risk surface first (Pilot A), Task Studio second (Pilot B) — piloting on a
  surface under active dogfood would make regressions unattributable.
- F4/F5/F14 preflight OFF + computed-style mixed fixture + shell CSS-order snapshot + single shared
  vscode-theme.css.
- F6/F7 complete token bridge (build fails on unbridged variable) + fallback chains + missing-token fixture.
- F11 naming trap resolved: kit/ namespace (KitSelect etc.) so the days-old legacy Select/FieldRow can
  never be import-confused; import matrix in README.
- F12 a11y contract per wrapper; F8/F9/F15 vendoring/upgrade/license discipline incl. pinned Radix +
  gate-rerun on Radix bumps; F10 bundle accounting (measure, don't block).
