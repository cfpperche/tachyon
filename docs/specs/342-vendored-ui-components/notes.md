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

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

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
