# 203 — tachyon-split-panels — plan

_Drafted from `spec.md` on 2026-06-10._

## Approach

Extract the layout math into a pure module (`layoutLogic.ts`: presets, leaf
capacity, build/normalize/equality/validation/capture) so everything is
unit-testable; `Layouts.ts` stays a thin vscode driver. Config grows the new
preset names + `sizes` (preset top-level proportions) + `layout` (captured
tree, mutually exclusive with grid) + `settings.layout`. The capture command
maps `vscode.getEditorLayout` (pixel sizes → normalized proportions) with the
`tabGroups` order (== leaf order) to find each group's ⚡ terminal, writing
through a new `upsertLayout` on the comment-preserving editor.

## Files to touch

**Create:** `src/presentation/layoutLogic.ts`, `test/unit/layouts.test.ts`
**Modify:** `src/config/loadConfig.ts` (+schema), `src/presentation/Layouts.ts`, `src/presentation/Sidebar.ts` (grid optional), `src/config/YamlConfigEditor.ts` (upsertLayout), `src/extension.ts` (applyLayoutWithSpawn/applyDefaultLayout/saveLayoutAs), `package.json`+nls+l10n (0.4.3), integration suite

## Alternatives considered

### Matching captures to the nearest preset
Lossy and surprising — arbitrary arrangements don't reduce to presets. Storing the normalized tree verbatim round-trips honestly.

### Preserving user file groups during apply
`setEditorLayout` rearranges the whole editor area by nature. v1 stance: tabs are never closed (VSCode redistributes, not destroys); files share groups after apply. Revisit only with real pain.

## Risks and unknowns

- `getEditorLayout` size units undocumented (pixels in practice) — normalize defensively by per-level sum; integration asserts the round-trip.

## Research / citations

- vscode source `editorGroupsService.ts` — GroupLayoutArgument.size proportional (sum=1), recursive orthogonal nesting (fetched 2026-06-10)
- microsoft/vscode PR #171224 — vscode.getEditorLayout added for capture→set round-trips
- VSCode custom-layout docs — locked groups; editor-area terminals auto-lock
