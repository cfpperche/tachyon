# 381 — prompt-templates — notes

_Created 2026-07-14._

## Design decisions

- Storage flipped from `tachyon.yml` to `.tachyon/prompts/<id>.md` before plan (maintainer).
- Interactive HTML prototype approved before implementation.
- Related research task `t-5726dc` (custom terminal surface) tracked separately; does not block 381.
- Human dogfood uses stable **Tachyon: Dev Host** pointer (not a free-floating `DOGFOOD.md` — SDD-native is `**Human dogfood:**` in `tasks.md`).

## Deviations

- None vs plan so far.

## Tradeoffs

- On-demand readdir (no watcher) keeps v1 small; library changes need a re-open of the inject command.
- Pre-existing NULs in `src/extension.ts` left untouched; inject wiring spliced via scripted edit.

## Verification log

- 2026-07-14 — focused vitest: promptStore + injectFlow + sidebarActions + i18n — 33/33 pass.
- 2026-07-14 — `tsc -p tsconfig.json --noEmit` clean.
- 2026-07-14 — Dev Host pointer armed for 381 (`npm run dogfood:dev-host -- point …`).

## Open questions

_None for v1._
