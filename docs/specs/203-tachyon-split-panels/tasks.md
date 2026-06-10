# 203 — tachyon-split-panels — tasks

_Generated from `plan.md` on 2026-06-10._

## Implementation

- [x] 1. layoutLogic: presets, leafCount, buildLayout, normalizeLayout, layoutsEqual, validateLayoutTree, captureToEntry
- [x] 2. Config: new presets, sizes, custom layout tree, settings.layout (+schema)
- [x] 3. Layouts.ts rewrite over layoutLogic: idempotent apply, auto-spawn hook, focus-first
- [x] 4. extension: applyLayoutWithSpawn, applyDefaultLayout on start/activation, saveLayoutAs command (+💾 button)
- [x] 5. upsertLayout on the yml editor; nls/l10n; 0.4.3
- [x] 6. Unit (13) + integration (sized apply, capture round-trip, settings.layout + auto-spawn)
- [x] 7. Dogfood: cockpit layout (main-left 70/30) + commented settings.layout + walkthrough

## Verification

**Verify:** `bash -c 'cd packages/tachyon && npx vitest run --reporter=dot 2>&1 | tail -3'`

- [x] Unit 188/188
- [x] xvfb integration 23 passing / 1 pending
