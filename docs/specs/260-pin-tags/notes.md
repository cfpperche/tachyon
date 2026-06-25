# Spec 260 — Pin tags — notes

## 2026-06-24 — Planning

Source pin:

- `p-a051b3` — "Adicionar tags aos pins"
- Body: "alterar pins para poderem ser marcados com tags , facilitando filtros identificacao, ordenacao"

Local research:

- `PinStore` summary rows are the right storage surface for tags because sidebar and Bridge list tools read that file directly.
- Rich detail files should not duplicate tags; they should stay document/attachment-only.
- The current Bridge pin tool count can remain unchanged by extending `create_pin` and `update_pin` schemas instead of adding a dedicated tag tool.
- Sidebar tab scrolling from spec 259 should be preserved; tag filtering must happen inside the existing `.panel.active` row list.

Implementation decisions:

- `update_pin` treats omitted `tags` as "leave unchanged" and `tags: []` as "clear all tags".
- `.tachyon/pins.json` remains the only persisted summary surface for tags; rich detail files stay doc/attachment-only.
- Pin Studio has a local tag editor for immediate UX validation, but `PinStore` remains the authoritative normalizer.
- Cmd/Ctrl+K search matches both `tag` and `#tag`; choosing a Pins result clears the active tag filter so the selected row can be revealed.

## 2026-06-24 — Closeout

Implemented:

- `Pin.tags` storage, normalization, create/update/rich-detail plumbing, and legacy/malformed tag tolerance.
- Bridge `create_pin`/`update_pin` optional tag support without adding tools.
- Pin Studio tag editor, VM/save message routing, and pending input inclusion on Save.
- Sidebar pin tag chips, global tag filter, tag search keywords, and stale-filter cleanup.

Validated:

- `npm run typecheck`
- `npm run build`
- `npm test` — 95 files passed; 1401 tests passed; 3 skipped.
- `node scripts/screenshots/ds/render.mjs sidebar` — `sidebar-dark.png` and `sidebar-light.png` rendered.
- `git diff --check`

Claude review:

- First run hit `error_max_budget_usd` at `/home/goat/Agent0/.agent0/.runtime-state/claude-exec/20260625T021231Z-spec-260-pin-tags-review/last-message.md`.
- Successful read-only review: `/home/goat/Agent0/.agent0/.runtime-state/claude-exec/20260625T021453Z-spec-260-pin-tags-review-2/last-message.md`.
- Verdict was `SHIP-WITH-CHANGES` for whitespace/style cleanup only; required cleanups were applied and all gates were rerun green.
