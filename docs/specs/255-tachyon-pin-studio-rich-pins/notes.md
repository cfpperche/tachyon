# Spec 255 — Pin Studio rich pins — notes

_Created 2026-06-24._

## Design decisions

### 2026-06-24 — parent — Maintainer scope decision

The maintainer chose Tiptap with a Notion-like editor for v1 and Excalidraw for v2. The spec should not treat Tiptap as a deferred enhancement; it is core v1 scope. Excalidraw remains a deliberate future whiteboard/sketch feature rather than a dependency in the screenshot-rich pins MVP.

### 2026-06-24 — codex — Isolated worktree planning

Implementation planning moved to isolated worktree `/home/goat/.cache/tachyon/worktrees/spec-255-pin-studio-rich-pins` on branch `tachyon/spec-255-pin-studio-rich-pins`. The source repo copy of the draft spec was left untouched except for being the copy source. `plan.md` now locks the storage-first implementation order and `tasks.md` is expanded into an ordered checklist.

## Claude review

### 2026-06-24 — claude-exec — Review verdict

Claude reviewed `spec.md` read-only via `claude-exec` and returned `SPEC-READY-WITH-CHANGES`.

Run artifact: `/home/goat/Agent0/.agent0/.runtime-state/claude-exec/20260624T152337Z-spec-255-pin-studio-review/last-message.md`

Required changes identified:

- Detail files plus gitignored blobs could create broken references on another machine. Folded by making the whole `.tachyon/pins/` rich-detail tree local/gitignored in v1 while keeping `.tachyon/pins.json` shareable.
- `get_pin` was underspecified for legacy/text-only pins and missing ids. Folded into an explicit contract.
- `updatedAt`, `detail`, and `attachmentCount` needed optional/backward-compatible semantics. Folded.
- Tiptap dependency list needed OSS/framework-neutral precision and no ambiguous DragHandle/Pro dependency. Folded.
- Size limits, path shape, UI proof, delete/GC, and single-editor behavior needed acceptance coverage. Folded.

## Deviations

- `Pin Studio` uses host-message tests and pure document-model tests as the project UI proof. The harness covers text-only create, repeated edit/reveal, transient paste image storage, import image storage, canonical image document rewriting, and no binary/base64 returned through `get_pin`. It does not launch a real VS Code window for manual visual inspection.

## Tradeoffs

- Rich pin image bytes cross the webview-host boundary transiently as base64 because VS Code webview messages are JSON-shaped; the implementation validates size before storing, never persists base64, and never returns base64 through MCP/list/sidebar payloads.
- Blob garbage collection remains conservative: deleting a rich pin removes the detail metadata file but does not delete content-addressed blobs, so a shared blob cannot be removed while another pin references it.

## Verification

- `npx tsc --noEmit` — pass.
- `npx tsc -p tsconfig.webview.json --noEmit` — pass.
- `bash scripts/check-engine-boundary.sh` — pass.
- `node esbuild.mjs` — pass; generated `dist/webview/pin-studio.js`.
- `env -u TMUX npx vitest run` — pass, 82 files / 1277 tests.
- `npm audit --omit=dev --json` — pass, 0 production vulnerabilities. Full `npm audit` reports 5 dev/tooling advisories in existing test/build dependencies (`@vscode/test-cli`/`mocha`/`serialize-javascript`, `vite`/`esbuild` path), not in the production dependency set.
- Spec-253 regression scan for `get_notes|set_notes|openNotes|ensureNotesFile|tachyon.openNotes|.tachyon/notes.md` across `src/`, `test/`, package/nls, README, site, scripts — empty.
- Forbidden dependency scan for `@tiptap/react|DragHandle|excalidraw|@excalidraw` — empty.

## EDH dogfood

### 2026-06-24 — tachyon-examples — text-only + import image + Bridge detail

Ran the worktree extension in VS Code Extension Development Host against `/home/goat/tachyon-examples` (`Run Tachyon (demo)`).

- Text-only create: `+` on Pins opened Pin Studio, saving title `Apenas titulo` closed the panel and added `p-316257` to the sidebar with no attachment indicator.
- Filesystem check: `.tachyon/pins.json` contains only the summary for `p-316257`; no rich detail/blob file was created for that text-only pin.
- Rich import: created `pin com screenshot`, imported `docs/screenshots/pins.png`, saw inline preview in the editor and image card in the side rail, saved successfully.
- Sidebar check: Pins count moved to 2 and the rich pin displays the image indicator/count `1` without showing image data in the sidebar row.
- Filesystem check: rich pin `p-e8c44a` has summary metadata `detail: true`, `attachmentCount: 1`, detail file `.tachyon/pins/p-e8c44a.json`, and blob `.tachyon/pins/blobs/856993837d129e74abaf490fdafcce3d05c21426ce7ea9bd1abdd3d79a7f422d` (6373 bytes).
- Payload check: no `base64`, `data:image`, or `vscode-webview` string appears in `.tachyon/pins.json` or `.tachyon/pins/`.
- Bridge dogfood: external MCP client called authenticated `get_pin` on `p-316257` and `p-e8c44a`; legacy/text-only returned `detail: false`, `doc: null`, `attachments: []`; rich returned `detail: true`, `doc.type: "doc"`, attachment path `.tachyon/pins/blobs/856993837d129e74abaf490fdafcce3d05c21426ce7ea9bd1abdd3d79a7f422d`, `available: true`, no binary payload.

### 2026-06-24 — tachyon-examples — edit reuse + paste image

Continued the same EDH dogfood session against `/home/goat/tachyon-examples`.

- Edit existing rich pin: opening `p-e8c44a` reused the existing Pin Studio surface instead of creating duplicate editor panels.
- Saved title/body change: `pin com screenshot - alteracao` persisted to `.tachyon/pins.json` with `detail: true` and `attachmentCount: 2`.
- Paste image: adding a pasted screenshot created a second attachment `image.png` with source `paste`, while the original imported `pins.png` attachment remained intact.
- Filesystem check: detail file `.tachyon/pins/p-e8c44a.json` contains two attachments; both content-addressed blob files exist with expected byte sizes (6373 bytes and 280596 bytes).
- Payload check: no `base64`, `data:image`, or `vscode-webview` string appears in `.tachyon/pins.json` or `.tachyon/pins/` after edit/save.
- Bridge dogfood: authenticated `get_pin` on `p-e8c44a` returned `detail: true`, two available `image/png` attachments, and only relative `.tachyon/pins/blobs/...` paths.

### 2026-06-24 — tachyon-examples — delete cleanup semantics

Ran a controlled storage dogfood against `/home/goat/tachyon-examples` with a temporary rich pin `p-5071d5`.

- Create check: summary entry existed, detail file `.tachyon/pins/p-5071d5.json` existed, and blob `.tachyon/pins/blobs/725e9cd7b39674fa98258e0fcbd7801a1810f6225539e8fff25b382ad165311c` existed.
- Delete check: `PinStore.remove("p-5071d5")` removed the summary entry and removed `.tachyon/pins/p-5071d5.json`.
- Blob semantics check: the content-addressed blob still existed after delete, matching the v1 conservative cleanup contract for dedup/shared blob safety.
- Temp cleanup check: no `.tmp.` files remained in `.tachyon/pins/blobs/`.
- Operator cleanup: the unique dogfood orphan blob was manually removed after the evidence was captured so the demo workspace was not left with the synthetic test blob.

### 2026-06-24 — tachyon-examples — real EDH delete sweep

After deleting the two real dogfood pins from the EDH and closing the EDH, swept `/home/goat/tachyon-examples`.

- Summary check: `.tachyon/pins.json` is valid JSON with `pins: []`.
- Detail cleanup check: no `.tachyon/pins/p-*.json` detail files remain.
- Blob semantics check: the two real content-addressed blobs remain in `.tachyon/pins/blobs/` (`856993837d129e74abaf490fdafcce3d05c21426ce7ea9bd1abdd3d79a7f422d`, 6373 bytes; `e741ef2457c7ee72d7e8577992ed346c1cca13651a51d7f2d209469eb4b9e5b7`, 280596 bytes), matching the v1 conservative cleanup contract.
- Orphan reference check: no references to the deleted pin ids, attachment ids, `tachyon-pin-attachment`, or the blob refs remain in `.tachyon/pins.json` or `.tachyon/pins/`.
- Payload check: no `base64`, `data:image`, or `vscode-webview` string appears in `.tachyon/pins.json` or `.tachyon/pins/`.
- Temp cleanup check: no `*tmp*` files remain under `.tachyon/pins/`.

## Open questions
