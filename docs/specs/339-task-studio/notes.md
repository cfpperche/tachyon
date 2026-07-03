# 339 — task-studio — notes

_Created 2026-07-03._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

### T1 — extraction

- New neutral type module `src/richDoc/types.ts` (host+webview safe, no vscode dep) holds the doc/attachment
  shapes (`TiptapJSON`, `RichDocAttachment`, `ResolvedRichDocAttachment`, ...). `src/pins/types.ts` now
  re-exports these under its historical `Pin*` names via `export type ... as ...` — a pure type alias, zero
  runtime change, every existing pin import keeps resolving unchanged. This is what lets `TaskAttachmentStore`
  (T2) and `TaskDetailStore`/serializers (T3/T4) share the same shapes without importing from `src/pins/*`.
- `src/webview/rich-doc/` holds the extracted webview modules: `document.ts` (toEditorDoc/toStoredDoc/etc,
  generalized off `PinStudioAttachmentVM` → `RichDocAttachmentVM`), `tiptap.ts` (`createRichDocEditor`,
  `RichDocImage`/`RichDocSketch` — the `tachyonSketch` node-type STRING is unchanged, only the TS class
  names moved), `data-url.ts` (verbatim), `toolbar.tsx` (new: `EditorToolbar`/`SlashMenu`, data-free but
  JSX-driven — the "toolbar registry" from plan.md), `VisualsPanel.tsx` (new: the Visuals aside +
  `SketchModal` + the excalidraw script/css lazy-loader, extracted from pin-studio's ~500-line App.tsx),
  `adapter.ts` (the `StudioAdapter` seam; `createPinStudioAdapter()` is the first implementation — used only
  for the eyebrow label strings in v1, since PinStudioPanel's host-side save semantics/paths are untouched by
  design — T5 will build `createTaskStudioAdapter()` analogously for its own App).
- `pin-studio/{document,data-url}.ts` became one-line `export * from "../rich-doc/..."` shims so every
  existing import path (including both pin-studio test files, which import these modules directly) keeps
  resolving with ZERO edits to test files, satisfying "pin-studio unit tests untouched and green" literally.
  `pin-studio/tiptap.ts` re-exports both the new names and the historical `createPinEditor`/`PinImage`/
  `PinSketch` aliases for the same reason.
- CSS: entity-neutral editor/toolbar/visuals/sketch-modal styles moved to a new `rich-doc.css` (shared by
  pin-studio and task-studio); `pin-studio.css` keeps only the pin-specific tag editor. `.pin-editor` CSS
  class renamed to `.rich-doc-editor` (mechanical rename, both the tiptap `editorProps.attributes.class` and
  the CSS selector updated together — no visual change). `PinStudioPanel.ts`'s webview `styles` array now
  loads `rich-doc.css` before `pin-studio.css`; esbuild.mjs copies it to `dist/webview/`; the dev preview
  harness route for `pin-studio` includes it too.
- tsconfig: `src/webview/rich-doc` added to main `tsconfig.json`'s exclude list and to
  `tsconfig.webview.json`'s include list, mirroring exactly how `pin-studio` itself is split across the two
  configs (Node16 host resolution vs Bundler/JSX webview resolution) — avoids double-checking the same files
  under two incompatible module-resolution modes.
- Verified: both typechecks green, full `npm test` suite green except one PRE-EXISTING flaky test
  (`test/unit/tmux.real.test.ts` — real-tmux capture timing race, unrelated to this change; passes in
  isolation on rerun — logged here per the task's "prove and register" rule for pre-existing failures).
- Unrelated pending changes noted, not touched by this work: `docs/specs/338-*` (4 modified files) and an
  untracked `assets/` directory were already present in the working tree before T1 started — left alone,
  committed nothing from them.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Design dueto (probe codex, adversarial-review, 2026-07-03, runId probe-8f6c9a57)

22 findings (5 blockers). Spec text was embedded inline in the probe prompt per [[probe-sandbox-no-fs]].
Disposition:

- **F1/F2/F15/F18 (BLOCKERS + majors, the "three writers" cluster)** — ACCEPTED via a SIMPLER mechanism
  than proposed: body-hash anchoring instead of conflict metadata/merge UI. The sidecar records the hash of
  the body it derived; a mismatched hash at load means an external (agent) edit happened and the doc is
  REIMPORTED from body — most-recent-writer-wins, body is the interchange format, no dual truth, no merge.
  No-op saves never rewrite body (round-trip preservation unit-tested). F15's limitation is now explicit in
  the spec + requires a follow-up queue task for read-only doc access via bridge tools.
- **F3 + F20 (BLOCKER, truncation)** — ACCEPTED merged: ≤4000 TOTAL incl. a stable non-localized ASCII
  marker, block/line-boundary cuts, no surrogate splits, fence-closing, exact-boundary tests.
- **F4 (BLOCKER, save shape)** — ACCEPTED: dirty-field patch only, never status/rank/untouched fields.
- **F5 + F11 (BLOCKER, sidecar CAS/atomicity)** — ACCEPTED reduced: with body-hash anchoring the sidecar is
  a derived companion, not independent truth, so full sidecar CAS is unnecessary; staged create transaction
  (temp sidecar → store create → atomic promote) + taskUpdatedAt echo cover the failure windows.
- **F6/F9/F13/F21 (lifecycle/namespace/size/schema)** — ACCEPTED as the consolidated lifecycle criterion.
- **F7 (create-mode contradiction)** — ACCEPTED with a 325-consistency correction the probe missed: full
  field set in create EXCEPT assignee, which 325's mutability table forbids outside triaged/active —
  disabled with an "assign during triage" hint (probe proposed enabling it; that would violate the table).
- **F8 (extraction boundary)** — ACCEPTED: entity-neutral modules + adapter seams, pin tests protect Pin
  Studio.
- **F10 (board race)** — ACCEPTED trimmed: dirty-patch exclusion of board-owned fields makes field-level
  CAS unnecessary; banner names changed fields.
- **F12 (quick-add migration)** — ACCEPTED: create semantics + tests preserved/updated.
- **F14/F16 (webview memory, import security)** — ACCEPTED as criteria.
- **F17 (validation via store parser)** — ACCEPTED.
- **F19 (create visibility)** — ACCEPTED: reveal-or-confirm after Save.
- **F22 (integration coverage)** — ACCEPTED: named integration list added.
- Nothing rebutted outright; F5 and F7 were accepted with corrections where the probe's concrete proposal
  conflicted with the shipped 325 contract (sidecar-as-derived-truth; assignee mutability).
