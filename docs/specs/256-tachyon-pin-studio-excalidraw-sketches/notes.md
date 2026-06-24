# Spec 256 - Pin Studio Excalidraw sketches - notes

_Created 2026-06-24._

## Design decisions

### 2026-06-24 - parent - V2 scope

V2 is scoped to Excalidraw sketch blocks inside Pin Studio, including blank sketches and annotating existing screenshot attachments. It does not include a global whiteboard, notes revival, share/promote workflow, real-time collaboration, or agent-created sketches.

### 2026-06-24 - codex - Excalidraw research baseline

Official Excalidraw docs and npm metadata were checked before planning. Relevant constraints: the package is currently `0.18.1` and MIT; docs describe a Preact build path via `process.env.IS_PREACT`; the package also declares React peer dependencies; fonts/assets should be self-hosted for non-CDN use; and Excalidraw scenes can surface `files` through `onChange`, so Tachyon must normalize those files into local blobs rather than persisting data URLs.

### 2026-06-24 - claude-exec - Read-only spec review

Claude reviewed `spec.md` read-only and returned `SPEC-READY-WITH-CHANGES`.

Run artifact: `/home/goat/Agent0/.agent0/.runtime-state/claude-exec/20260624T174459Z-spec-256-pin-studio-excalidraw-review/last-message.md`

Required changes identified:

- Define the v2 attachment union explicitly (`image` vs `excalidraw`) and the resolved sketch shape with separate scene/preview paths and availability flags.
- Make the schemaVersion read contract explicit: `PinStore.readDetail` must accept and validate schemaVersion 1 and 2, not just say "backward-compatible".
- Promote Excalidraw/Preact bundling from an open question into a decision: Claude argues `process.env.IS_PREACT` alone is insufficient for Tachyon's npm-package consumer path and that esbuild aliasing to `preact/compat` should be specified/proven.
- Decide whether Excalidraw is an on-demand bundle following Tachyon's mermaid/katex pattern, or justify inlining it into `pin-studio.js`.
- Add a normalization round-trip acceptance criterion for Excalidraw scene files/images, including whether the no-`data:image`/`base64` rule applies to scene blobs as well as detail JSON.
- Broaden CSP acceptance beyond fonts/assets: enumerate needed `connect-src`/`worker-src`/`blob:` handling and require a smoke test with zero CSP console violations.

### 2026-06-24 - codex - Claude review folded

Folded the Claude required changes into `spec.md`, `plan.md`, and `tasks.md`.

Closed decisions:

- V2 attachments are an explicit `image | excalidraw` discriminated union.
- Resolved sketch attachments expose `scenePath`/`previewPath` and independent availability flags.
- `PinStore.readDetail` must accept and validate schemaVersion 1 and 2.
- Excalidraw ships as an on-demand `dist/webview/excalidraw.js` bundle.
- React peer imports must resolve through Preact compatibility aliases; `process.env.IS_PREACT` alone is not the contract.
- Tachyon-normalized scene blobs must also be free of `data:image`, base64, `blob:`, `vscode-webview`, and absolute local paths.
- CSP acceptance now includes required `connect-src`, `worker-src`/`child-src`, and `blob:` handling if the implementation proves Excalidraw needs them.

## Deviations

## Tradeoffs

## Open questions

- OQ2: Confirm the preview export mechanism after a real webview build spike.
- OQ3: Pick final editor placement after testing canvas dimensions and keyboard/focus behavior in VS Code.
