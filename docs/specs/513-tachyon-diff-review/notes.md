# 513 — tachyon-diff-review — notes

_Created 2026-08-17._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- Fatia 0 (`docs/research/t-7eb2e4-diff-review-load.md`): lista de arquivos com um diff materializado
  por vez, porque a mediana é 3 arquivos/184 linhas mas o extremo chega a 131/5.354.
- Realce degrada explicitamente para texto escapado acima de 20.000 caracteres: o maior arquivo real
  tem 381.252 caracteres e custou 78,9 ms medianos no `highlight.js`.
- Diff unificado é o formato inicial: a 880 px contém 93,46% das linhas medidas, contra 56,79% por
  metade no lado a lado.

- **Fatia 1 wire (`t-e968c1`).** Hunks do **not** ride on `review.view`. That view stays
  `ReviewNotesViewV1` (notes after reconcile, exact keys). Putting hunks there would either
  materialize 131 files or force a change to `reviewNotesService.ts`, which is the 511 anchor
  and must stay byte-identical. The sibling door is named so fatia 2 does not invent a verb.

## Wire contract (fatia 2 consumes this; do not guess)

Named door: `REVIEW_DIFF_QUERY_METHOD` = `"review.diff"` in
`packages/engine/src/runtime-api/reviewProjection.ts`. This slice does **not** add the method
to `protocol.ts` — `review.view` needed no new field. Fatia 2 adds the protocol arm that
carries exactly these types.

**Query** — `ReviewDiffQueryInputV1`:

| field | required | meaning |
|---|---|---|
| `worktree` | yes | safe path segment, ≤128 |
| `path` | yes | post-image path; for a deletion, the deleted path. **Required.** No path ⇒ no query. |
| `baseRef` | yes | compare base |
| `headRef` | no | committed range `baseRef..headRef`. Omit for a worktree compare. |

There is no `files` array and no way to ask for every hunk. The file **list** is the existing
`ChangedFile[]` from the worktree-review payload (`parseNameStatus` / `mergeChanges`). That
list already includes status `D`. Fatia 2 renders the list from there and fetches hunks for
the selected path only.

**Result** — `ReviewDiffFileV1` (one file):

| field | required | meaning |
|---|---|---|
| `schemaVersion` | yes | `1` |
| `format` | yes | `"unified"` only. Side-by-side is not a value. |
| `worktree` | yes | must match the query |
| `path` | yes | post-image path |
| `from` | no | pre-image path on rename/copy |
| `status` | yes | `A` \| `M` \| `D` \| `R` \| `C` \| `T` |
| `baseRef` | yes | |
| `currentLabel` | yes | named current side (SDD 501): `"worktree"` or an abbreviated head |
| `headRef` | no | echo of the query when the compare is committed |
| `binary` | yes | `true` ⇒ `hunks` is `[]`; do not invent bytes |
| `hunks` | yes | `ReviewDiffHunkV1[]` |

**Hunk** — `ReviewDiffHunkV1`: `oldStart`, `oldLines`, `newStart`, `newLines` (0 is valid for
an empty side), `header` (text after the second `@@`, trimmed, may be `""`), `lines`.

**Line** — `ReviewDiffLineV1`:

| field | meaning |
|---|---|
| `kind` | `"context"` \| `"add"` \| `"del"` |
| `text` | payload **without** the +/-/space prefix and **without** the newline. Never truncated. |
| `oldLine` | 1-based pre-image; `null` on `add` |
| `newLine` | 1-based post-image; `null` on `del`. Notes attach here (SDD 511 `side: "modified"`). |
| `noNewline` | optional `true` when git emitted `\ No newline at end of file` after this line |

**Deletion.** Status `D`. Every content line is `kind: "del"`, `newLine: null`, `oldLine`
1..n. The screen must show it — fatia 0 corrected the probe that dropped 25 deletions
(`55de2fc4` is 131 files, not 106).

**Untracked add.** Git's `diff <base> -- <path>` does not emit untracked files. Feed
`unifiedDiffFromAddedFile(path, content)` in `worktree/review.ts` through `parseUnifiedDiff`
so the wire is still `ReviewDiffFileV1` with status `A` and `kind: "add"` lines. Do not
invent a second line format.

**Git stdout the parser accepts.** `git diff [<baseRef> [<headRef>]] -- <path>` of one path,
or `git show` of a one-file commit. A second `diff --git` is an error, not a silent drop.
Empty stdout is valid (`hunks: []`, mode-only / identical). Binary: `binary: true`, no hunks.

**What the engine does not do.** It does not cut at 20_000 characters. That is fatia 2
render (escape, no highlight, visible “realce desativado”). It does not put hunks on
`review.view`. It does not change `reviewNotes.ts`, `reviewNotesStore.ts`, or
`reviewNotesService.ts`.

**Projector.** `projectReviewDiffFileV1({ worktree, path, baseRef, parsed, status?, from?,
currentLabel?, headRef? })`. `status` from `ChangedFile` wins when supplied (untracked is
`A` even if git never wrote a header).

**Parse / guards.** `parseReviewDiffQueryInputV1`, `isReviewDiffQueryInputV1`,
`parseReviewDiffFileV1`, `isReviewDiffFileV1`. Closed objects (`exactKeys`). Hostile
payloads are refused at `REVIEW_DIFF_HUNK_LIMIT` (10_000), `REVIEW_DIFF_LINE_LIMIT`
(100_000), `REVIEW_DIFF_LINE_CHARS_MAX` (1_000_000) — those caps are for the wire
validator, not a render cut.

**Proof in this slice.** `test/unit/worktreeReview.test.ts` and
`test/unit/reviewDiffProjection.test.ts` parse two real diffs from this tree:
`55de2fc4` `packages/engine/src/commands/CommandRunner.ts` (deleted, 165 `del` lines) and
`2778ccc4` `packages/engine/src/workspace/Workspace.ts` (the fatia-0 large file: 6 hunks,
every git content line present, none truncated). The 381_252-character figure is the
**file**, not the hunk payload — highlight.js is fatia 2; the engine still ships every
line git emitted.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- **Fatia 2 preview is a standalone page, not a catalog route (`t-832633`).** `scripts/webview-preview/ROUTES`
  requires a `WEBVIEW_SURFACES` row, and that row requires a host file plus a reload-serializer policy in
  `extension.ts`. Those are fatia 3 (the BoardPanel-shaped host). The screen is still previewable:
  `scripts/webview-preview/review-fatia2.html` loads the same `dist/webview/review.js` bundle. Do not
  add a catalog key until the product host exists.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- **Fatia 3 protocol arm (`t-1a76c5`).** Fatia 1 wrote that fatia 2 would add
  `review.diff` to `protocol.ts`. It did not. Fatia 3 closes that gap first:
  `WorkspaceQueryMethodV1` + handler next to `review.view` + control-client size
  arm, carrying the existing `ReviewDiffQueryInputV1` / `ReviewDiffFileV1`
  types unchanged. WorktreeManager gained `unifiedDiff` so untracked adds still
  travel through `unifiedDiffFromAddedFile` → `parseUnifiedDiff`.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._
