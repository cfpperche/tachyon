# 381 — prompt-templates — notes

_Created 2026-07-14._

## Design decisions

- Storage flipped from `tachyon.yml` to `.tachyon/prompts/<id>.md` before plan (maintainer).
- Interactive HTML prototype approved before implementation.
- Related research task `t-5726dc` (custom terminal surface) tracked separately; does not block 381.
- Human dogfood uses stable **Tachyon: Dev Host** pointer (`**Human dogfood:**` in `tasks.md`).

## Deviations

- Human dogfood exercised **submit** as the primary end-to-end proof (toast + body in pane). Stage remains the default product choice; unit + delivery path cover stage without Enter.

## Tradeoffs

- On-demand readdir (no watcher) keeps v1 small; library changes need a re-open of the inject command.
- Fixture agent is `bash` (`kind: agent`) — prose submit produces shell "command not found" lines; that is expected for delivery proof, not an AI composer.

## Verification log

- 2026-07-14 — focused vitest: promptStore + injectFlow + sidebarActions + i18n — 33/33 pass.
- 2026-07-14 — re-run before ship: 33/33 pass.

## Dogfood log

- 2026-07-14 — **Human dogfood PASS** (Dev Host F5, WSL).
  - Armed: `npm run dogfood -- dev-host -- point` → worktree `feat/prompt-templates`, fixture `prompt-templates-dogfood`.
  - EDH: Bridge connected, agent `dogfood` running (bash).
  - Action: Inject Prompt Template → **Status + next step** → **Submit** → `dogfood`.
  - Evidence: toast `Prompt template 'Status + next step' submitted to 'dogfood'`; multi-line body visible in pane.
  - Note: bash printed `command not found` for English prose lines — expected for non-AI fixture.
  - Autostart race toast "already running" observed once; swallow fix applied in Workspace (same as `autostartNewlyDeclared`).

## Open questions

_None for v1._
