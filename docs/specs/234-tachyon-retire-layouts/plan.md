# 234 — retire the layouts feature — PLAN (for review)

_Created 2026-06-19. Plan only — no code yet. **codex reviewed → PLAN-NEEDS-CHANGES (3 MAJOR + 1 MINOR), all
folded below** (`/tmp/codex-234-plan-out.json`): keep the SCHEMA (deprecated, not dropped — else editor
diagnostics under `additionalProperties:false`); THREE YamlConfigEditor layout-ref loops (not two) + their
tests; README + system-design.md doc updates were omitted; remove the layout-only types
(`GridShape`/`GRID_SHAPES`/`PRESET_TOP_GROUPS`) for `noUnusedLocals`. Open questions resolved: silent
runtime ignore (no activation toast), schema kept-deprecated, one complete PR._

## Intent
The named-layouts feature was discontinued by a product call (2026-06-10, `features.ts`): VS Code's native
editor-group split/resize already covers it, so the machinery is redundant surface. It's been hidden
(`FEATURES.layouts=false`) but kept dormant across ~12 files; the spec-233 decoupling already removed its
`saveLayoutAs` half, leaving it asymmetric. **Remove the dormant feature surface; keep the config
tolerant** so an existing consumer `tachyon.yml` with a `layouts:`/`settings.layout` block does NOT error.
Git history preserves the code if it's ever wanted back (the flag-hedge is no longer worth the carry cost).

## Decision: config stays tolerant (no breakage) — at runtime AND in the schema
`layouts:` and `settings.layout` remain **recognized-but-ignored**:
- **Runtime (`loadConfig`):** keep `layouts` in the allowed-keys list (~577); **remove the whole layout
  VALIDATION block** (~630) and change `settings.layout` from "validate against parsed layouts" to
  recognized-but-ignored (~854) — not just the key. Drop the typed `LayoutDef` field; an old config loads
  clean, the values are not acted on. (codex: keeping only the allowed-key is NOT enough if validation
  remains.)
- **Schema (codex MAJOR):** `tachyon.schema.json` has `additionalProperties:false` at top + under
  `settings`; it's contributed for `tachyon.yml` in `package.json`. So **KEEP** `layouts` +
  `settings.layout` in the schema, marked `deprecated:true` and made **permissive** (`layouts` accepts any
  object) so editor diagnostics match the runtime ignore. **Do NOT drop them from the schema** (that was a
  bug in the first draft — it would red-squiggle existing configs).
- Silent ignore — **no activation-time deprecation toast** (avoid noise for published users); the
  deprecation lives in release notes + the schema `description`. (codex open-Q recommendation.)
- (Rejected: hard-remove the keys → `unknown top-level key 'layouts'` error breaks existing configs.)

## Removal inventory (per file)
**Delete files:**
- `src/presentation/Layouts.ts` (the `applyLayout` editor logic).
- `src/presentation/layoutLogic.ts` (capture/grid pure logic) + `test/unit/layouts.test.ts`.

**Edit:**
- `src/presentation/Sidebar.ts` — remove `LayoutTreeItem` + `LayoutsProvider`.
- `src/extension.ts` — remove the `LayoutsProvider` import + `layoutsView` + its `registerTreeDataProvider`
  gate; the `tachyon.applyLayout` command; both `FEATURES.layouts && applyDefaultLayout()` calls; the
  `onViewsChanged("layouts")` branch + the `layoutsView.refresh()` in `refreshAll`.
- `src/workspace/Workspace.ts` — remove `applyLayoutWithSpawn`, `applyDefaultLayout`, the `applyLayout`
  import, and the two `onViewsChanged("layouts")` calls.
- `src/workspace/EngineHost.ts` — drop `"layouts"` from `ViewKind` (and audit remaining callers).
- `src/config/loadConfig.ts` — remove `LayoutDef`, the `layouts` field on `TachyonConfig`, the parsing+
  validation block (~630), `settings.layout` validation (~854 → recognized-ignored), AND the layout-only
  helpers `GridShape` / `GRID_SHAPES` / `PRESET_TOP_GROUPS` (~162/~250) — `noUnusedLocals:true` fails the
  typecheck otherwise (codex MINOR). KEEP `"layouts"` in the recognized-keys list.
- `src/config/YamlConfigEditor.ts` — remove `upsertLayout` AND **all THREE** layout-ref loops (codex
  MAJOR — the plan said two): `upsertAgent`-rename (~113), `deleteAgent` (~314), `renameAgent` (~350) +
  their stale comments/warnings. The actual agent mutations are separate lines, so rename/delete keep
  working; only the dead layout-ref update goes.
- `src/config/tachyon.schema.json` — **KEEP** `layouts` + `settings.layout`, marked `deprecated:true` +
  permissive (codex MAJOR — dropping them red-squiggles existing configs under `additionalProperties:false`).
- `README.md` (codex MAJOR) — remove layouts from the managed-entries advert (~624) + drop `settings.layout`
  from the supported-settings list (~811).
- `docs/system-design.md` (codex MAJOR) — update the stale references (`presentation/Layouts.ts`,
  editor-layout ports, layout integration tests at ~22/~55/~130) — the EditorLayoutPort was already removed
  in spec 233, so this also corrects current-architecture drift.
- `src/features.ts` — remove the `layouts` flag (the feature is gone, not hidden). If `FEATURES` becomes
  empty, keep the object (`{}` as const) + fix the `FEATURES.layouts` readers (now deleted).
- `package.json` (+ `package.nls*.json`, `l10n` bundles) — remove the `tachyon.applyLayout` +
  `tachyon.saveLayoutAs` command + menu (`when:false`) entries + their nls keys.

## Test blast radius
- Delete `test/unit/layouts.test.ts`.
- `test/unit/config.test.ts` — adjust: assert `layouts:` is accepted-and-ignored (not parsed into
  `config.layouts`); drop assertions on the removed field.
- `test/unit/yamlEditor.test.ts` — drop `upsertLayout` + the layout-ref-update assertions (codex: ~line 89).
- `test/unit/agentStudio.test.ts` — drop the layout-rename-warning assertion (codex: ~line 259).
- `test/unit/config.test.ts` — assert `layouts:` + `settings.layout` are accepted-and-ignored (not parsed
  into `config.layouts`); ADD a legacy-tolerance case: a stale/malformed `layouts:` block + `settings.layout:
  ghost` both load with NO error (codex).
- `test/fixtures/sample-workspace/tachyon.yml` — KEEP a `layouts:` block as the tolerance fixture.
- `test/integration/extension.test.js` — drop any layout-command/view assertion.

## Acceptance
- `npm run typecheck && env -u TMUX npx vitest run` green; `check:engine-boundary` green; build clean.
- An existing `tachyon.yml` containing `layouts:` + `settings.layout` loads with **no error** (tolerant).
- No remaining reader of `config.layouts`; no `tachyon.applyLayout`/`saveLayoutAs` command; no Layouts view.
- No behavior change for anything else (the feature was already off).

## Decisions (codex-resolved)
1. **Tolerance vs deprecation toast** → **silent runtime ignore**; deprecation in release notes + schema
   `description` (no activation-time noise for published users).
2. **Schema** → **keep, deprecated + permissive** (NOT drop) — `additionalProperties:false` would otherwise
   red-squiggle existing configs.
3. **Non-obvious readers** → codex confirmed the surviving `ViewKind "layouts"` callers are
   `Workspace.ts:870` + `extension.ts:449` (both removed); no Bridge tool / runbook reads layouts. The
   Studio agent-rename path is the YamlConfigEditor loops (covered above).
4. **`ViewKind "layouts"`** → removed; both callers go.
5. **Delete vs flag-hedge** → **delete** (feature off, `saveLayoutAs` already gone, git history suffices).
6. **Sequencing** → **one complete PR** (parser + schema + README + system-design.md + tests + manifest/l10n
   together) so there's never a half-tolerant release.
