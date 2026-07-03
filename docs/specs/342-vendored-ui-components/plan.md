# 342 — vendored-ui-components — plan

_Drafted 2026-07-03 (post-dueto, 16 findings folded). Implementation is delegated (Fable never implements);
this plan is the implementer's map. GATE-FIRST is the non-negotiable ordering: no wrapper or pilot work
before the compat gate has recorded per-component pass/fail._

## Approach

1. **Pipeline scaffold** — Tailwind v4 enters the esbuild build as a build-time step (the `@tailwindcss/cli`
   invoked from esbuild.mjs for opted-in surfaces; each opted surface has a `tailwind.css` input importing
   `tailwindcss` with **preflight disabled** in config). No runtime, no external fetches. Radix packages for
   batch 1 + cva/clsx/tailwind-merge land as EXACT-pinned deps (lockfile + VENDORED.md).
2. **Token bridge** — `src/webview/shared/vscode-theme.css`: every variable the generated shadcn config
   emits, each as a fallback chain `var(--vscode-x, var(--vscode-y, #hardcoded))`. A small build check
   (script in esbuild.mjs or a unit test scanning vendor CSS/source) fails on any shadcn variable without a
   bridge entry. Injected ONCE per surface via `renderWebviewShell` (never per-bundle copies).
3. **Compat gate** — vendor the five components' source into `src/webview/shared/ui/vendor/` (shadcn CLI
   output, imports adapted), build an isolated gate page (`src/webview/ui-gate/`, its own esbuild entry,
   same aliases + CSP shell) exercising each component, and drive it with **puppeteer-core against the
   system Chrome** (`npm run test:browser` — separate script, NOT in default `npm test`; agent-browser was
   considered and rejected for automation: its mutation gate holds clicks for human confirmation by
   design). Checks per component per the spec criterion. RECORD pass/fail in notes.md; a failing component
   is excluded from its sub-batch and its Kit wrapper keeps legacy internals.
4. **Kit wrappers (1a)** — `src/webview/shared/ui/kit/`: KitSelect, KitFieldRow, KitLabeledInput (+
   KitTooltip/KitDropdown as thin re-exports where useful), each with: legacy fallback at the wrapper
   boundary (build-time flag per component; call sites never change), the a11y contract (axe-static +
   browser keyboard tests on the gate page), uniform height/rhythm tokens. Preflight mixed fixture + shell
   CSS-order snapshot land here too.
5. **Pilot A** — the Plugins panel (low blast radius, mixed-friendly, has real controls): adopt 1a kit
   components + one gated 1b component when available. Proves style isolation + compat in a real surface.
6. **1b (Popover + Dialog)** — only after Pilot A ships and fallback wiring demonstrably works.
7. **Pilot B** — Task Studio fields row migrates to Kit* (stating before/after implementations — the days-
   old legacy Select/FieldRow stay for non-pilot surfaces per the import matrix); all 339 behaviors survive.
8. **Accounting + docs** — bundle deltas per entry + duplicated-module count recorded in notes.md;
   `shared/ui/README.md` import matrix; VENDORED.md with CLI version/registry commit/command/config
   baselines/LICENSES/pinned Radix versions.

## Key decisions

- **puppeteer-core + system Chrome for the gate** — chosen over playwright (heavier install) and over the
  agent-browser plugin (its human-confirmation gate on clicks makes automation impossible by design).
  System Chrome exists on the dev host (agent-browser already requires it).
- **Preflight OFF** (not scoped) — the dueto's fixture requirement stands either way; off is provable.
- **kit/ namespace** — legacy Select/FieldRow keep their names and surfaces; import matrix prevents mixups.
- **Gate failures are outcomes, not blockers** — an excluded component keeps its legacy wrapper internals;
  the spec's staged batches absorb partial passes.

## Files touched (new unless noted)

- esbuild.mjs (modified: tailwind step + ui-gate entry), package.json (deps, test:browser script).
- src/webview/shared/vscode-theme.css · shared/ui/vendor/* · shared/ui/kit/* · shared/ui/README.md.
- src/webview/ui-gate/{index page, main.tsx} · test/browser/uiGate.test.ts (puppeteer runner).
- Pilot A: src/webview/plugins/* (adopt kit) · Pilot B: src/webview/task-studio/App.tsx (fields row).
- VENDORED.md · fixtures under test/unit (token bridge scan, CSS-order snapshot, preflight computed-style).

## Risks & unknowns

- The gate may fail Dialog/Popover under compat — that is a RESULT (record, exclude, continue with 1a).
- Tailwind v4 CLI integration with multi-entry esbuild — if per-surface invocation is slow, batch it.
- puppeteer-core → system Chrome path discovery on WSL (reuse agent-browser's detection notes if present).
- Task Studio is under active dogfood — Pilot B rebases on whatever round-2 fixes landed first.

## Visual impact

Gate page (internal), Plugins panel (Pilot A) and Task Studio fields row (Pilot B) — human dogfood on
installed builds after each pilot; agent-screen evidence for Visual QA.

## Sources consulted

docs/specs/342-vendored-ui-components/{spec,notes}.md (post-dueto) · esbuild.mjs (compat aliases, entries,
shell css copy) · src/webview/shared/ui/* (legacy primitives) · specs 339/335 notes (dogfood findings that
motivated) · probe-850a053c result.
