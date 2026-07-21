# 419 — board-card-layout — notes

_Created 2026-07-20._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- Repository audit confirmed author is not conditionally missing: `TaskStore.create` defaults and
  bounds it, `BoardCardVM.author` is required, and `buildBoardModel` copies it for every card. The
  visual disappearance is caused by `.meta-left { overflow: hidden }` sharing one 260px row with a
  non-shrinking quick-controls group. Existing CSS comments describe the same pressure failure.

## Deviations

- The first local build attempt could not resolve `esbuild` because the newly created worktree had no
  `node_modules`. Following repository guidance, `npm ci` provisioned the checkout; no source change
  was needed and all subsequent builds passed.
- The `visual-qa` skill's required `agent-browser` doctor could not start because the plugin launcher
  `.tachyon/bin/_tachyon-tool` was absent. Per the maintainer's headless-only constraint, validation
  used the repository's real-bundle Puppeteer route instead of desktop or interactive browser control.

## Tradeoffs

- Fixed 300px lanes show fewer whole columns at once than 260px lanes, but improve scanning and use
  the Board's existing horizontal navigation as intended.

## Open questions

None.

## Headless visual evidence

- `.tachyon/vqa/visual-qa/board-card-layout-1440x900.png` — 1440×900 real-bundle capture.
- `.tachyon/vqa/visual-qa/board-card-layout-900x900.png` — 900×900 real-bundle capture.
- Verdict: pass. The desktop capture keeps each 300px lane equal and shows the deliberately long
  author in the upper-left region independently from the upper-right badges. The task id and bounded
  assignee/priority controls occupy opposite footer regions. The narrow capture retains 300px lanes
  and clips only at the Board viewport boundary, confirming horizontal scrolling rather than lane
  compression. No author identity dot remains; the assignee dot is intentionally preserved.

## Dogfood log

### 2026-07-20T18:31:03Z — pass (1/1) — source: tasks.md — commit: 77be6eeb694be48ae85351729441e9dc6cbc114f
- `npm run build && npx vitest run --config vitest.browser.config.ts test/browser/boardCardLayout.test.ts` — pass

## Verification log

### 2026-07-20T18:31:36Z — pass (2/2) — source: tasks.md
- `npm run typecheck` — pass
- `npm run verify:full:quiet` — pass
