# 342 — vendored-ui-components — notes

_Created 2026-07-03._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Compat gate results (T3, 2026-07-03)

Vendored from shadcn/ui registry `new-york-v4` (CLI-less: fetched each component's registry JSON directly
from `ui.shadcn.com/r/styles/new-york-v4/<name>.json` — see VENDORED.md, T8, for exact provenance) into
`src/webview/shared/ui/vendor/`, adapted (radix-ui meta-package → this project's exact-pinned
`@radix-ui/react-*` packages; `@/lib/utils` → `./lib/utils`; `lucide-react` icons → the project's own
codicon-backed `Icon`), and exercised on the `ui-gate` page (`src/webview/ui-gate/main.tsx`) via
`test/browser/uiGate.test.ts` against real system Chrome. Per-component checklist: open/close, Esc, outside-
click dismissal, Tab/Shift+Tab containment where applicable, focus restore, nested portals, keyboard
nav/typeahead, aria-expanded/aria-controls/id stability.

| Component | Verdict | Evidence |
| --- | --- | --- |
| **Tooltip** | **FAIL** | Neither a real mouse hover nor a programmatic focus opens it under preact/compat — verified with both trigger mechanisms and up to 1000ms wait (well past `TooltipProvider`'s `delayDuration={0}`). `data-state` stays `"closed"`; `[data-testid="tooltip-content"]` never mounts. Repro is a permanent `it.fails` regression probe in uiGate.test.ts (2 tests). |
| **DropdownMenu** | **PASS** | Open/close (click + Esc), aria-expanded/aria-controls↔id linkage, ArrowDown roving focus between items, outside-click dismissal, and Portal rendering outside `#root` all verified. 5/5 checks green. |
| **Select** | **PASS** | Open/close (click + Esc + focus restore), aria-expanded/aria-controls↔id linkage, typeahead ("b" → jumps to "Bravo") + Enter commit updating the trigger value, all verified. 3/3 checks green. |
| **Popover** | **PASS** | Opens auto-focusing the first focusable field in its content (no explicit Tab needed — Radix moves focus on open), Esc closes + restores focus to the trigger, outside-click dismissal, Portal rendering outside `#root`. 4/4 checks green. |
| **Dialog** | **FAIL** | Clicking the trigger opens (aria-expanded=true, the Overlay mounts) then throws an UNCAUGHT `TypeError: Failed to execute 'getComputedStyle' on 'Window': parameter 1 is not of type 'Element'.` before Content mounts — some ref Radix Dialog's internals (RemoveScroll/FocusScope machinery) expect attached by then isn't, under preact/compat's ref-forwarding timing. `[data-testid="dialog-content"]` never mounts. Repro is a permanent `it.fails` regression probe (4 tests). |

**Disposition per spec.md's "gate failures are outcomes, not blockers":**
- **Staging revised** (spec's default was "1a = Tooltip + (DropdownMenu|Select)"; Tooltip's failure forces a
  substitution): **1a = DropdownMenu + Select** (both clean full passes) → T4 builds KitSelect, KitFieldRow,
  KitLabeledInput, KitDropdown from these. **1b = Popover** only, moved forward to T4/T5 scope since it ALSO
  passed cleanly (Popover was originally 1b, but a passing component isn't held back arbitrarily per "batches
  absorb partial passes") — T6 still owns wiring it into a Kit wrapper on the 1b timeline the spec lays out
  (after Pilot A), the gate work is simply already done.
- **Tooltip: EXCLUDED.** No `KitTooltip` ships in this spec. Any surface needing a tooltip keeps whatever
  ad-hoc `title=` attribute or existing pattern it uses today; a future spec re-gates once Radix/preact
  compat improves (kill-switch is moot — there's no wrapper to flip).
- **Dialog: EXCLUDED.** No `KitDialog` ships in this spec. Unlike Select/FieldRow, there is no PRE-EXISTING
  legacy modal component in `shared/ui/` to fall back to — Dialog was a wholly NEW capability, so exclusion
  means "not introduced yet," not "wrapper reverts to legacy internals." Any surface needing a modal keeps
  its current approach (most Tachyon panels don't use modals today).
- **Reproductions are LIVE, not deleted.** Both failures are encoded as `it.fails(...)` in
  test/browser/uiGate.test.ts: the suite stays green, but the moment Radix/preact/compat fixes either bug,
  that specific `.fails` test starts PASSING, which vitest reports as a failure of the `.fails` wrapper itself
  — an automatic "re-gate this component" signal, not silent rot.
- **Radix version pinned at gate time** (exact, per VENDORED.md, T8): `@radix-ui/react-tooltip@1.2.11`,
  `@radix-ui/react-dropdown-menu@2.1.19`, `@radix-ui/react-select@2.3.2`, `@radix-ui/react-popover@1.1.18`,
  `@radix-ui/react-dialog@1.1.18`. Per spec F9: any FUTURE version bump of these packages must rerun this
  gate and update this table, even if vendored source is unchanged.

## Bundle accounting (T8, 2026-07-03) — measured, not blocking (spec F10)

Per-entry deltas, measured directly (a scratch `git worktree` built at the T4 commit — before either pilot —
compared byte-for-byte against the current build):

| Entry | Before (T4) | After (T7) | Delta | Note |
| --- | --- | --- | --- | --- |
| `dist/webview/plugins.js` | 36,963 B | 176,122 B | **+139,159 B (+~136 KB)** | Radix (dropdown-menu, select) + cva/clsx/tailwind-merge + KitSelect/KitDropdown, minified. |
| `dist/webview/task-studio.js` | 454,702 B | 573,407 B | **+118,705 B (+~116 KB)** | Radix (select) + cva/clsx/tailwind-merge + KitSelect/KitFieldRow/KitLabeledInput. Smaller delta than plugins.js despite a similar dependency set — this bundle already includes tiptap/rich-doc, so more of the shared runtime (preact/compat itself) was already paid for. |
| `dist/webview/plugins.css` / `task-studio.css` | unchanged | unchanged | **0 B** | Neither surface's OWN `.css` file was touched; the new styling lives entirely in the new `<surface>.tailwind.css` files below. |
| `dist/webview/plugins.tailwind.css` (new) | — | 20,502 B | **+20,502 B** | Compiled Tailwind utilities actually used by this surface's Kit components. |
| `dist/webview/task-studio.tailwind.css` (new) | — | 20,502 B | **+20,502 B** | Byte-identical to plugins' — both surfaces currently exercise the SAME small set of Tailwind utility classes (the shadcn-generated component styles), so the compiled output converges; NOT a sign of accidental duplication, Tailwind compiles per-surface by design (T1). |
| `dist/webview/vscode-theme.css` (new, SHARED) | — | 3,236 B | **+3,236 B total** (not per-surface) | ONE file, copied once, linked by every surface that opts in — never duplicated per surface (T2's design decision). |

**Duplicated Radix/shadcn module count, projected across all webview entries:** esbuild bundles each panel as
an independent IIFE with no cross-entry code-splitting (the current CSP model needs one nonce'd `<script src>`
per panel; ESM+`splitting:true` would need a different script-loading shape). Every surface that adopts
kit/vendor components therefore pays its OWN full copy of whichever of the 5 Radix packages + cva + clsx +
tailwind-merge it actually imports — there are **12 real panel entries** in esbuild.mjs total (sidebar,
activity, handoff, plugins, probes, inspector, agent-studio, pin-preview, pin-studio, mission-control,
task-detail, task-studio); **2 have adopted so far** (plugins, task-studio), at ~127 KB average JS delta
each. If every remaining panel eventually adopted the SAME component set, the projected cumulative dist/webview
disk footprint would grow by roughly **10 × ~127 KB ≈ 1.3 MB** — panels are separate on-demand webview
iframes (never all loaded simultaneously), so this is a DISK number, not a runtime-memory one. Per plan.md's
own framing (F10: "measure, don't block") and the maintainer's settled decision (spec.md: "bundle size is not
a strategic blocker (local-disk webviews)"), **no action is taken on this number** — code-splitting/
shared-chunks stays an explicitly DEFERRED decision, not a gap.

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

- **T3 — TYPE resolution for "react" mirrors the RUNTIME alias, via `tsconfig.webview.json` paths, instead of
  installing `@types/react`.** First attempt: `@types/react` alone. Result: every vendored file failed
  `tsc -p tsconfig.webview.json` with `VNode` (preact's JSX element type, since `jsxImportSource: "preact"`)
  not assignable to real React's `ReactPortal`/`ReactNode` — the type system doesn't know preact/compat's
  runtime IS what "react" resolves to at build time. Fix: `paths: { "react": ["./node_modules/preact/compat/"],
  ... }` (same specifiers esbuild's `preactCompat` alias already covers) + REMOVED `@types/react` (it would
  otherwise fight preact/compat's own `declare namespace React` shim, which already re-exports
  `ComponentProps`/`ReactNode` as Preact-native types — exactly what makes `React.ComponentProps<typeof
  RadixPrimitive>` in vendored source type-check cleanly against Preact's actual VNode shape).
- **T3 — vendored components fetched from shadcn's public registry JSON directly**
  (`ui.shadcn.com/r/styles/new-york-v4/<name>.json`), not the `shadcn` CLI. The CLI's `init`/`add` flow
  assumes a `components.json` + an existing Next.js/Vite-shaped project (aliases, a `tailwind.config`) that
  doesn't match this esbuild-multi-entry setup; the registry JSON IS the CLI's own data source (the exact
  same upstream `.tsx` content), so fetching it directly is equivalent provenance with a wiring cost this
  project's structure can actually absorb. Recorded in VENDORED.md (T8) as the generation command.
- **T3 — DialogFooter's optional "outline" Close button no longer imports the shadcn registry's own `Button`**
  (which this project doesn't vendor) — inlined as plain Tailwind classes over the SAME bridged
  border/input/accent tokens. Icons (`lucide-react`'s CheckIcon/ChevronRightIcon/ChevronDownIcon/
  ChevronUpIcon/CircleIcon/XIcon) replaced with the project's own codicon-backed `Icon` component — no new
  icon-library dependency for 5 glyphs Tachyon already ships (codicon).

- **T4 — fallback scope: only KitSelect gets a REAL dual radix/legacy implementation.** tasks.md's "legacy
  fallback per component at wrapper boundary" reads most literally as every wrapper needing a flippable
  second implementation; in practice only KitSelect has one to flip TO — a days-old, already-shipped native
  `<select class="ds-input">`. KitFieldRow is a thin re-export of the existing `.ds-field-row` rhythm (no
  Radix dependency, nothing to gate). KitLabeledInput is new a11y-composition wiring around a plain
  `<input class="ds-input">` — again no Radix dependency. KitDropdown wraps the gate-passed DropdownMenu with
  no pre-existing legacy dropdown-menu to fall back to (same posture as Dialog's exclusion, just on the
  passing side of the gate). Building parallel "legacy" implementations for these three where none serves a
  real purpose would be exactly the premature-abstraction/scope-creep the project avoids elsewhere.
- **T4 — the kill switch is `esbuild.mjs`'s `kitDefines` (one object, `TACHYON_KIT_SELECT` env var → `{select:
  "radix"|"legacy"}`), injected via the SHARED `sidebar` base config** so every webview entry spread from it
  (activity/plugins/task-studio/ui-gate/…) picks it up automatically — adding a new Kit component's flag
  later means editing ONE object, not every esbuild target. `shared/ui/kit/flags.ts` reads it via a
  `typeof __TACHYON_KIT_FLAGS__ !== "undefined"` guard (verified this compiles correctly through esbuild's
  `define` — esbuild hoists the define into a real `var`, so `typeof` on it is never a ReferenceError, in a
  bundle OR in plain vitest/tsc where the define is absent and the guard safely falls through to `"radix"`).
  **Verified for real, not just by reading the code:** built twice — default (`select:"radix"` inlined) and
  `TACHYON_KIT_SELECT=legacy` (`select:"legacy"` inlined, confirmed via `grep` on the bundled output) — and
  re-ran `npm run test:browser` against the legacy build: the Radix-specific KitSelect keyboard test (which
  asserts `aria-expanded`, a Radix-only attribute) correctly FAILED against the native `<select>` fallback,
  while every other kit/gate test stayed green. That asymmetric result (one test fails in exactly the way a
  real internals swap predicts, nothing else moves) is the actual proof the switch works, not just that it
  compiles.
- **T4 — a11y checks run axe-core via `page.evaluate(sourceString)`, NOT `page.addScriptTag`.**
  `addScriptTag` injects an inline `<script>`, which the gate page's own strict CSP (nonce'd `script-src`, no
  `'unsafe-inline'`) correctly blocks — axe silently never defined itself, and the resulting `ReferenceError`
  was the first real signal the CSP is doing its job. `page.evaluate()` executes via CDP's `Runtime.evaluate`,
  which runs in the page's JS context WITHOUT going through the DOM's script-loading gate (the same reason
  browser automation isn't itself a CSP bypass vector for page-authored content) — reading axe.min.js's
  source in Node and evaluating the string directly sidesteps the tag-injection path entirely.
- **T4 — CSS-order snapshot needed no extension.** The plan anticipated appending kit-wrapper CSS to the
  order snapshot, but Kit components contribute ZERO new stylesheets — they consume Tailwind utility classes
  (already compiled into each surface's `<surface>.tailwind.css`) and the legacy `.ds-input`/`.ds-field-row`
  classes (already in design-system.css). The T2 snapshot already covers the full stack Kit depends on;
  nothing to append.

- **T5 — Pilot A surface + component choices:** the Plugins panel's installed-list sort `<select>` →
  KitSelect (a real, always-visible, frequently-used control — the strongest possible fallback demo target).
  The per-card Check/Docs/Config buttons → a KitDropdown "⋯" overflow menu; the PRIMARY status action
  (Update/Reinstall/Remove) deliberately stays a direct, visible `Button` — collapsing a genuinely
  secondary/conditional action group is a real, justified UX tidy-up (less button clutter on cards with
  several conditional actions), not a forced DropdownMenu adoption for its own sake. No Tooltip/Popover/Dialog
  adoption in Pilot A: Tooltip is excluded (T3), Popover/Dialog Kit wrappers don't exist until T6 — spec.md's
  "one Tooltip/DropdownMenu, one Popover/Dialog" wording assumed Tooltip would pass the gate; the actual
  staging (notes.md's T3 section) already documents why DropdownMenu absorbed that slot instead.
- **T5 — production proof runs through the REAL dev preview harness** (`scripts/webview-preview`), not the
  synthetic ui-gate page: `test/browser/pilotAPlugins.test.ts` drives the ACTUAL `dist/webview/plugins.js`
  bundle + a `captured-host-vm` fixture (the same one `webviewPreviewPluginsFixture.test.ts` guards against
  builder drift) through `scripts/webview-preview/index.html?view=plugins&fixture=default`. Three checks: no
  console/response errors, KitSelect's sort control actually REORDERS the rendered list (functional proof,
  not just visual), and the KitDropdown overflow menu opens with reachable items. The gate server's existing
  generic static-file fallback (T1) served the harness's HTML/JS/fixture-JSON with zero new server code —
  only a `.json` MIME entry + an `origin` field were added to `test/browser/support/gateServer.ts`.
- **T6 — KitPopover found a real, reproducible test-timing bug in a T4 test, not just a new one.** Adding
  KitPopover's keyboard test surfaced that the EXISTING KitSelect keyboard test
  (`test/browser/kitA11y.test.ts`) raced: it waited for `aria-expanded="false"` then immediately read
  `document.activeElement`, but Radix flips `aria-expanded` SYNCHRONOUSLY on close while focus restoration
  can land a tick later — occasionally reading focus a moment too early. Fixed by waiting on the actual focus
  target instead of the aria flag (same `waitForFunction`-on-the-real-signal pattern used everywhere else in
  this test suite). Re-ran the full kitA11y file 3× after the fix with no flakes.
- **T6 — KitPopover ships with NO pilot consumer.** tasks.md's T4 wording ("legacy fallback per component at
  wrapper boundary… a11y contract checks… for every shipped wrapper") sets the bar at "wrapper exists +
  a11y-checked," not "every wrapper is deployed somewhere." KitPopover passed T3's gate cleanly and gets the
  same thin-re-export treatment as KitDropdown (no legacy popover to fall back to), added to the ui-gate Kit
  section + its own kitA11y.test.ts case — genuinely available for the next surface that needs one, without
  inventing a forced adoption site just to exercise it.
- **T7 — Priority's Radix Select needed a real sentinel for "none," not an empty string.** The legacy
  `<select>` used `<option value="">none</option>`; Radix's `SelectItem` REJECTS an empty-string value
  outright (its own documented constraint — empty string is reserved to mean "no selection" internally).
  `NO_PRIORITY = "none"` is the sentinel now: `value={priority !== undefined ? String(priority) : NO_PRIORITY}`,
  `onValueChange` maps `"none"` back to `undefined`. Preserves the exact prior capability (clear a set
  priority back to none, any time) without the crash a literal empty-string item would cause.
  `PRIORITY_OPTIONS` builds the list once (`[{value:"none",label:"none"}, ...P0..P3]`) so both the radix and
  legacy KitSelect branches read the identical option set.
- **T7 — scope is the `ts-fields` row only, NOT `ts-chip-fields`** (Deps/Artifacts). Those are a bespoke
  chip-input pattern — free text + Enter-to-add + removable pills — not a Select or a plain labeled input,
  and spec.md's own open question ("does KitChipInput need Combobox pulled forward…") explicitly defers this
  to a later batch. `KitFieldRow` (a byte-identical re-export) DOES wrap `ts-chip-fields` now too, for
  namespace consistency, but its CONTENTS are untouched.
- **T7 — label presentation is a deliberate, documented visual change, not an oversight.** Legacy Kind/
  Assignee used a plain `<span>` inside `.ts-field`'s flex-column (inheriting its `--ds-small`/`--ds-muted`
  styling); KitLabeledInput renders its OWN `ds-section` label (11px, weight 600, letter-spacing — the
  project's canonical section-label look). This is exactly the point of adopting a shared authoring surface
  instead of every panel hand-rolling its own field-label CSS (spec's own motivating complaint), so the
  small visual shift is accepted, not a bug — a human-dogfood pass (tasks.md) is where any spacing/rhythm
  fine-tuning would surface, not something a headless check can judge.
- **T7 — Task Studio has no dev-preview-harness route** (only pin-studio, its sibling, is onboarded into
  `scripts/webview-preview` so far — see routes.ts's own comment: "the last view onboarded"). Onboarding a
  whole new view into that harness is a separate, bigger undertaking outside this spec's scope. Instead,
  `test/browser/pilotBTaskStudio.test.ts` drives the REAL `dist/webview/task-studio.js` bundle directly: a
  minimal hand-built fixture VM (not a captured host VM — no existing fixture to reuse) is posted after the
  bundle's own `ready` handshake, the exact protocol `main.tsx`/`messages.ts` already define. Same proof
  shape as Pilot A (real bundle, functional interaction, not just a render check), different plumbing.
- **T7 — CAS + freshness banner needed NO test additions.** Both depend entirely on `dirty`/`originalRef`
  state tracked in `App.tsx`'s hooks, never on which control renders a field — the migration didn't touch
  `markDirty`, `save()`, or the live-merge effect at all, so their existing behavior is provably unchanged by
  inspection (no new code path for a headless/browser check to exercise) rather than by a fresh test.

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
- **T3 — `tsconfig.browser-test.json` gained `"lib": ["ES2022", "DOM"]`.** `page.evaluate(() => document...)`
  callback bodies are type-checked as ordinary TS in the CALLING file even though they only ever EXECUTE
  inside the browser (puppeteer serializes the function across the CDP boundary) — without DOM lib, `tsc`
  can't see `document`/`HTMLElement` inside those callbacks. Safe: this project only ever type-checks these
  files, never runs them as a Node global-scope program.
- **T3 — 1a's second component became {DropdownMenu, Select} instead of "DropdownMenu OR Select, whichever
  gates cleanest."** Tooltip's failure left the phrase without its intended partner-selection role (it was
  written assuming Tooltip passes); since BOTH DropdownMenu and Select passed with equal cleanliness, T4
  builds Kit wrappers for both rather than arbitrarily dropping one that gates fine. Full reasoning in the
  gate-results table above.
- **T5 — BLOCKER-class bug caught by the pilot, not the gate: the `plugins` esbuild target had no
  `preactCompat` alias.** ui-gate (T3) and excalidraw both set `alias: preactCompat` directly on their own
  target objects; every OTHER webview entry (sidebar, activity, plugins, task-studio, …) is built by spreading
  the shared `sidebar` base, which never carried that alias — invisible until a REAL surface (Plugins) tried
  to bundle `shared/ui/vendor`/`kit` source. Symptom: `TypeError: Cannot read properties of null (reading
  'useMemo')`, thrown right after the panel's header rendered, right before the KitSelect/Kit­Dropdown-bearing
  toolbar would have. Root cause: without the alias, esbuild resolved Radix's internal `import ... from
  "react"` to the REAL `react` package (present in node_modules as a transitive peer dep of `@radix-ui/*` +
  excalidraw, see T3's design decisions) instead of `preact/compat` — a SECOND, entirely uninitialized React
  copy whose hooks dispatcher is never set up (nothing ever calls real `ReactDOM.render`), so any Radix
  internal hook crashes reading a null dispatcher. Fix: moved `alias: preactCompat` onto the shared `sidebar`
  base in esbuild.mjs (esbuild aliases are a no-op for a target that never imports the aliased specifier, so
  this is free for every surface that ISN'T using kit/vendor yet). This is exactly why tasks.md's Pilot A step
  exists as a SEPARATE, later step from T3's synthetic gate — the gate proves Radix-under-compat can work in
  isolation; only a real production bundle proves the REST of the build graph (every OTHER target's config)
  is wired correctly too. T7's Pilot B inherits the fix automatically (same shared base).

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- **T3 — root cause of the Tooltip/Dialog compat failures is UNKNOWN**, only the symptom is (see gate-results
  table). Worth a future spike if either component becomes load-bearing: is it a Radix-side ref-timing
  assumption incompatible with preact/compat's ref-forwarding order, or a preact/compat gap in something
  Tooltip's open-state-machine / Dialog's RemoveScroll internals rely on? No owner yet — flagged for whoever
  picks up Batch 2 or re-gates after a Radix/preact version bump.

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

## Verification log

### 2026-07-03T20:41:42Z — pass (2/2) — source: tasks.md
- `npm test -- --run test/unit/vscodeThemeBridge.test.ts test/unit/cssOrderSnapshot.test.ts` — pass
- `npm run typecheck` — pass

## Dogfood log

### 2026-07-03T20:42:31Z — pass (1/1) — source: tasks.md — commit: efa1730f1a8e786f36843bbec619559543defb22
- `npm run test:browser` — pass

## Dogfood log

### 2026-07-03 — human dogfood round 1 (installed 0.55.10) — MIXED (4 findings)
Core green: theme switching, KitSelect operates, Pilot B save-no-edit/truncation/pin-smoke all pass,
triaged→inbox works. Findings:
1. **[342] KitDropdown "⋯" opens NOTHING in the installed VS Code webview** (Plugins panel) — it passed the
   T3 gate (system Chrome) and the preview harness. Same class as the alias bug but inverted: synthetic
   contexts pass, real webview fails. Hypotheses to check FIRST in the webview devtools console: Radix
   Popper's inline styles vs the shell's CSP style-src; portal target vs shell #root; zIndex/stacking.
   Whatever it is, the T3 gate must gain a check that reproduces it (gate parity with production).
2. **[342] Kit vs legacy heights STILL diverge when mixed** (the original sin, round 2): Plugins filter
   input (legacy .ds-input) taller than KitSelect beside it; Task Studio priority KitSelect renders
   borderless/naked next to boxed legacy inputs, and label styles diverge (KIND/ASSIGNEE uppercase legacy
   vs "Priority" kit label). The kit needs to match the .ds control box (height/border/radius/padding) on
   MIXED rows — that parity IS the point of the kit.
3. **[342 UX] Card actions order: maintainer wants "⋯" AFTER the primary button (Remove, then ⋯).**
4. **[339] "Open in Studio" from the task detail tab leaves the detail tab open** — maintainer expects the
   detail preview to close when the Studio takes over (product decision, confirmed).
5. **[339] Screenshot attached in Studio renders as a broken image in the detail tab** (body carries the
   logical `attachment:` ref that only the Studio resolves) **and the card gives no hint** the task has
   visuals. Fix: detail panel resolves attachment refs to webview URIs (read-only, from the sidecar
   metadata); card meta row gains a small attachment indicator (count), pushed through the snapshot.

### Round 1 fixes — root causes and disposition (2026-07-03)

All 5 findings above are fixed, one commit per finding/pathspec, on `main`: `a18cb3d` (#3), `faaae46` (#4),
`3822b5a` + `f9b4b24` (#5, two commits — see below), `dd236fa` (#1), `0993045` (#2).

- **#1 (CRITICAL) — root cause was NOT the CSP/portal/z-index hypotheses this log listed.** All three were
  ruled out by direct code inspection: `style-src 'unsafe-inline'` is hardcoded in `shell.ts` with no
  per-call opt-out (identical in the gate and every production panel); the Portal always defaults to
  `document.body` with no ancestor `overflow`/`transform`/`contain` in the way; no z-index conflict exists
  since the portaled content isn't nested inside the card's stacking context at all. Three further synthetic
  reproduction attempts (same-origin nested iframe, cross-origin sandboxed nested iframe, neutered
  ResizeObserver/IntersectionObserver) also failed to reproduce anything in headless Chrome — useful negative
  evidence, not wasted effort.
  The REAL root cause, confirmed with a before/after positional repro: production's only shipped KitDropdown
  consumer (Plugins card actions) composes `KitDropdownTrigger asChild` over `IconButton`. Radix's `Slot`
  clones the child with a composed ref so its Popper anchor can measure the real DOM node — but `IconButton`
  (and `Button`, same gap) was a plain function component, and React/Preact silently drop a `ref` prop on
  those instead of forwarding it. The anchor ref never attached, so floating-ui positioned the menu content
  at a fixed, trigger-independent offset instead of beside the button. `aria-expanded`/`data-state` still
  flipped correctly (so every existing check that only asserts DOM/aria state — including
  `pilotAPlugins.test.ts`'s own "opens and items are reachable" test — passed throughout), but the content
  rendered off in space: indistinguishable from "opens nothing" to a user. Fixed by making both components
  `forwardRef`. Also added `updatePositionStrategy="always"` to `DropdownMenuContent` as an independent,
  low-cost defensive hardening (floating-ui's own documented knob for its default RO/IO-driven `autoUpdate`),
  even though it wasn't the confirmed cause.
  **Gate parity**: `uiGate.test.ts` previously only exercised a plain-text trigger, one instance. Added the
  `asChild`/`IconButton` composition (production's actual shape) plus a second instance (Plugins renders one
  KitDropdown per card) to `ui-gate/main.tsx`, and two new assertions checking the content is actually
  POSITIONED within the viewport (not just aria-correct) and that a second instance opens correctly after the
  first closes. Verified these fail — content stuck at the same fixed off-screen offset — when the
  `IconButton` fix is reverted, confirming genuine regression coverage.
- **#2 — root cause: CSS cascade layers, not a missing override.** `design-system.css`'s own unlayered
  `button { border: none; background: none; padding: 0 }` reset always wins over Tailwind's `@layer
  utilities` classes on the same property (unlayered beats layered regardless of specificity or source
  order), silently stripping border/background/padding from every Radix `SelectTrigger` — while its `h-9`
  height utility survived (nothing unlayered contested `height`). Plugins masked this with an ad hoc
  `.plugin-sort` rule that guessed a wrong, hardcoded 28px height instead of matching `.ds-input`'s real
  (font-dependent — `--ds-mono` resolves to the user's editor font) computed height; Task Studio's Priority
  field had no such patch at all, hence fully naked. Fixed with ONE shared unlayered
  `[data-slot="select-trigger"]` rule (the stable attribute Radix/shadcn stamp on every trigger) using the
  SAME declarations as `.ds-input`, plus `height: auto` (beats `h-9`), `appearance: none` (this project skips
  Tailwind preflight, which normally normalizes `<button>` UA sizing quirks vs `<input>`), and a codicon-size
  override for the trigger's chevron (a fixed 16px icon box was the LAST source of height drift — a flex
  row's height follows its tallest child, not just its text; found by literally measuring `getBoundingClientRect`
  before/after each incremental fix, not by inspection alone). Deleted the now-redundant/conflicting
  `.plugin-sort` override. Priority's bare `<span>` label now gets `class="ds-section"` to match Kind/
  Assignee's uppercase treatment. New fixture: `test/browser/kitLegacyParity.test.ts`, plus a real legacy
  `.ds-input` sibling added to the gate's `kit-field-row` for a true mixed-row A/B.
- **#3 — straightforward DOM reorder**, `plugins/App.tsx`'s `.card-actions`: the primary status `Button` now
  renders before the `KitDropdown` overflow trigger. New DOM-order regression test on the real bundle via the
  preview harness.
- **#4 — straightforward, one call**: `TaskDetailPanelManager.handleMessage`'s `openTaskStudio` branch now
  disposes `entry.panel` after routing to Task Studio. Deliberately narrower than the manager's existing
  "never dispose out from under the user" invariant (tombstone/Done-task cases), which is unaffected.
- **#5 — landed as two commits because it split into an independent-file half and a blocked half.**
  `3822b5a`: `TaskDetailPanel.ts` resolves `attachment:<id>` refs in `task.body` to real webview URIs before
  sending to the webview (same resolution Task Studio already does, applied read-only from the sidecar) —
  this file had zero uncommitted foreign state, landed immediately. The card-indicator half
  (`boardSnapshot.ts`/`boardModel.ts`/Mission Control's card meta row) was explicitly deferred in that same
  commit: those files carried unrelated, uncommitted spec-344 (validation queue governance) work at the time,
  including an exact-line collision risk on `BoardSnapshotInput`'s `workspaceRoot` field and
  `buildBoardSnapshot`'s `return` statement — landing it then would have mixed another agent's in-flight,
  unreviewed diff into this commit. Once spec-344 landed as its own commit (`1768f9c`), which already threads
  `workspaceRoot` through `MissionControlPanelManager`'s `buildBoardSnapshot` call, `f9b4b24` added
  `attachmentCounts`/`attachmentCount` reusing that plumbing rather than re-adding it.

**Adjacent finding evaluated, not taken**: the maintainer flagged `t-321e9d` (Pin Preview renders `[Image]`
literal instead of an inline image) as possibly the same family as #5. Investigated: it is NOT a cheap
generalization. #5's fix substring-replaces `attachment:<id>` inside a MARKDOWN STRING; Pin Preview never
produces a markdown string at all — `SidebarPrototype.ts`'s `collectPinDocText`/`pinDocPreview` flattens the
Tiptap JSON doc straight to plain text, discarding image data into a literal `"[Image]"` placeholder before
`pin-preview/App.tsx` ever sees it. A real fix needs `PinPreviewVM.body` to carry structured blocks (not a
joined string), reusing the already-exported `toEditorDoc` (`rich-doc/document.ts`) to inject resolved URIs
into the doc, and `pin-preview/App.tsx` to render actual `<img>` blocks — a multi-file VM-shape change, not a
generalization of this fix. Left for the next batch, per the maintainer's own conditional instruction.

**Verification, all 5 fixes together on `main`**: `npm run build`, `npm run typecheck` (3 tsc invocations),
`npx vitest run` (168 files / 2286 tests, incl. `pinStudioView.test.ts`/`pinStudioPanel.test.ts`), and
`npm run test:browser` (36 tests) all green.

### 2026-07-03 — agent visual pass (reviewer, pre-human — new house rule's first run)
Captured the Plugins preview (webview-preview harness :5174, fixture default) via agent-browser after the
round-1 fixes: **PASS** — the mixed row (legacy filter input + KitSelect "Name A-Z") renders with identical
box/height/rhythm (anchor: "mixed rows indistinguishable"), card action order is Remove → ⋮. Evidence:
.tachyon/evidence/spec342-vpass-plugins.png. Task Studio fields row: verified mechanically by the kit×legacy
computed-style parity fixture (no preview route yet — gap noted for the harness); maintainer round 2 is its
first human eyeball. KitDropdown open-behavior: covered by the browser gate (asChild ref fix + house-button
composition test), green in this tree.

### 2026-07-03 — human dogfood round 2 (installed 0.55.11) — 3 residual polish findings
KitDropdown opens (F1 verified), detail attachments render + card clip + close-on-open-studio verified,
t-321e9d deferral accepted. Residuals:
1. **[342] Task Studio priority select STILL misaligned on the fields row** (maintainer screenshot): the
   KitSelect renders content-width and visually shorter than the flexible-width Kind/Assignee inputs — the
   parity fixture asserted box-model equality but not ROW behavior (width policy + baseline alignment).
   Fix: selects on a FieldRow stretch like inputs (or get a consistent fixed min-width policy), same
   rendered height on the same row; extend the fixture to assert bounding-box height equality AND row
   alignment on the REAL task-studio composition.
2. **[339/342 UX] Deps chip shows the full multi-line title inside the chip**: truncate to `t-xxxxxx ·
   Titulo trunc…` single-line with the full title as tooltip/hint (maintainer suggestion).
3. **[339 UX] Detail tab actions (Open in Studio / Refresh) float at the page BOTTOM** — move to a proper
   header/top placement (title row right side, like the Studios' header actions).
Also: add a task-studio route (+ detail-tab route if cheap) to scripts/webview-preview so the reviewer's
pre-human visual pass can cover these surfaces (gap noted in the round-1 pass).

### Round 2 fixes — root causes and disposition (2026-07-03)

All 4 items above are fixed, one commit per item/pathspec, on `main`: `f5d145f` (#1), `176fb7c` (#2),
`235a67b` (#3), `cc97eee` (#4, the harness route gap).

- **#1 — THREE stacked root causes, not one, all only visible on the REAL `.ts-fields` row (exactly what the
  finding predicted the extended fixture would catch):**
  1. *Width.* Radix's vendored `SelectTrigger` ships shadcn's upstream `w-fit` Tailwind class — an explicit
     width on the flex item, which overrides `.ts-field`'s (flex column) default `align-items: stretch`, the
     SAME stretch a plain `<input>` (no explicit width of its own) relies on to fill the field. Content-width
     "P1" is much narrower than a stretched input.
  2. *Font (height).* `.ts-field .ds-input { font: inherit; }` predates the Kit migration (from when Priority
     was still a native unstyled `<select>`) and made Kind/Assignee inherit the ambient VS Code UI font
     (`--vscode-font-family`), while round-1 #2's `[data-slot="select-trigger"]` rule always hardcoded
     `--ds-mono` for the trigger. VS Code's UI font and editor(mono) font are DIFFERENT fonts with different
     metrics — a 1px height gap (30px vs 31px) that the synthetic ui-gate parity fixture never caught, because
     its sample `.ds-input` sits OUTSIDE any `.ts-field`, so the override never applied to it.
  3. *Label margin (row alignment).* Priority's plain `<span class="ds-section">` is a DIRECT flex child of
     `.ts-field` (Kind/Assignee's `KitLabeledInput` bundles label+input into ONE wrapper child), so
     `.ts-field`'s row `gap: 4px` added a SECOND space on top of `.ds-section`'s own default
     `margin: 0 0 var(--ds-2)` (8px) — while `KitLabeledInput`'s label overrides that same margin inline down
     to 4px. Net: 12px between Priority's label and its control vs. 4px for Kind/Assignee, pushing the
     trigger 8px lower on the row (measured via a headless script: `top` 127 vs 119).
     Fixed all three: `flex: 1 1 160px` + `width: 100%` on both control types (width is now a row policy, not
     a per-control accident); dropped the `font: inherit` override so `.ds-input`'s own `--ds-mono` applies
     uniformly; dropped `.ts-field`'s row `gap` to 0 and gave the direct-child `.ds-section` span the same
     4px margin `KitLabeledInput` already uses. Found each cause by literally measuring
     `getBoundingClientRect()`/`getComputedStyle()` on the real bundle after each incremental fix (same
     discipline as round-1 #2), not by inspection alone.
  **Gate parity**: `test/browser/pilotBTaskStudio.test.ts` (drives the real `dist/webview/task-studio.js`
  bundle in its actual `.ts-fields` composition, not the synthetic ui-gate page) gained a new assertion
  comparing Priority's trigger against Kind's input on `width`/`height`/`top` (row alignment). Verified it
  fails at each intermediate fix — width-only fix left a 1px height gap, width+font fix left an 8px `top`
  gap — confirming genuine regression coverage for all three causes, not just the first one found.
  `kitLegacyParity.test.ts`'s existing synthetic box-model check stays (still valid for its own scope); this
  is additive REAL-composition coverage, per the finding's own framing.
- **#2 — straightforward UI gap, not a hidden root cause**: the deps chip's `id · title` text had no
  truncation styling at all. Fixed with a `.chip-pill-text` inner span (`text-overflow: ellipsis`,
  `white-space: nowrap`, and — the one non-obvious part — `min-width: 0`, since a flex item's default
  `min-width: auto` silently refuses to shrink below its own text's intrinsic width, defeating ellipsis
  without it). The full text now reaches the user via the button's `title` (was previously just "Remove
  dependency X"); that remove-action hint moved to `aria-label` so it isn't lost for assistive tech.
  Covered by a new browser assertion (`pilotBTaskStudio.test.ts`) with a long-titled dep fixture, asserting
  `scrollWidth > clientWidth` (ellipsis is actually clipping something, not just present in CSS) plus the
  `title`/`aria-label` values.
- **#3 — straightforward relocation**: `task-detail/App.tsx`'s `.td-actions` (Open in Studio / Refresh) moved
  from after `.td-body` into `.td-head`, reusing the existing shared `.ds-actions` right-alignment pattern
  (already used by Plugins' header) instead of inventing a bespoke class — `align-self: center` keeps the
  buttons vertically centered against the row's `align-items: baseline` text siblings. `.td-actions`'s old
  CSS rule deleted (no longer referenced).
- **#4 — routes.ts gained `task-studio`/`task-detail` entries** (CSS link order copied verbatim from each
  panel's real `renderWebviewShell` call in `TaskStudioPanel.ts`/`TaskDetailPanel.ts`), with new
  `synthetic-edge` fixtures (`scripts/webview-preview/fixtures/task-studio.ts`,
  `.../task-detail.ts`) carrying a long-titled dependency so round-2 #1/#2's fixes are visible in the
  harness, not just asserted headlessly. Both surfaces turned out to be genuinely absent from
  `src/webview/surfaces.ts` (`WEBVIEW_SURFACES`, spec 279's "every converted view" manifest) — they always
  were preact panels, just predated that manifest — so they're added there too, since
  `webviewPreviewCatalog.test.ts`'s completeness check spans exactly that list. `routes.json` regenerated
  from `buildCatalog()` (it's committed-generated, not hand-maintained, per that same test file).

**Agent visual pass (pre-human rule)**: captured both new preview routes via agent-browser after all 4 fixes
landed. Task Studio (`?view=task-studio&fixture=default`): Kind/Priority/Assignee render at identical
box height on one row, Priority's trigger is now as wide as the flexible inputs (anchor: "matches
Kind/Assignee's width, height, and baseline alignment") — **PASS**. The `t-1a2b3c · Vendor shadcn/Rad…` dep
chip truncates to a single line with an ellipsis; a short dep (`t-9f8e7d · Ship the compat gate`) renders in
full, confirming truncation is content-driven, not a blanket clip — **PASS**. Task Detail
(`?view=task-detail&fixture=default`): Open in Studio / Refresh render top-right in the title row, no
bottom-floating actions — **PASS**.

**Verification, all 4 fixes together on `main`**: `npm run build`, `npm run typecheck` (3 tsc invocations),
`npx vitest run` (168 files / 2288 tests), and `npm run test:browser` (38 tests, incl. the 2 new
`pilotBTaskStudio.test.ts` assertions) all green.

### 2026-07-03 — human dogfood round 3 (installed 0.55.12) — PASS (3/3), spec closed
Fields-row alignment, deps chip truncation, and detail header actions all confirmed by the maintainer.
Combined with rounds 1-2: KitDropdown/Select/Popover live in two production surfaces, theme switching clean,
gate + fixtures + visual-pass pipeline in place. Closed as shipped.
