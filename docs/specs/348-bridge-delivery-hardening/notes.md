# 348 — bridge-delivery-hardening — notes

_Created 2026-07-03._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- The 4 `update_task` assign-notice test cases were drafted first right after the existing task-round-trip test (early in `bridge.test.ts`, before `"claude"` is spawned by the `spawn_agent (declared)` test later in the file) and had to be relocated after the `write_input` hardening tests instead. Before `"claude"` is running, `hasSession` is correctly `false` and the notify step is a no-op, which made the "fires a notice" assertions fail for the wrong reason (ordering, not logic) — and briefly, a scratch version of the "no duplicate notify" tests pre-seeded the shared fake-tmux `sessions` map with a sentinel entry for `"claude"` before it was ever spawned, which then made a LATER test (`spawn_agent (declared) creates the tmux session`) see a phantom pre-existing session and fail with "already running". Moved all 4 cases to after `"claude"` is genuinely running so the sentinel-mutation only ever touches a real, already-open session.

## Gotchas

- This workspace had concurrent, unrelated in-flight work throughout this session: another agent's uncommitted changes for a different spec (349-plugin-ui-surfaces, `src/webview/**`/`src/sidebar/types.ts`/pin-preview) were present in `git status` alongside this spec's own changes, with zero file overlap. `npm test` shows one pre-existing failure (`webviewPreviewCatalog.test.ts`'s committed-routes-equal-buildCatalog check) caused by that concurrent work, confirmed via `git stash` (passes on a clean tree). Not touched — out of scope for 348, and touching `src/webview/**` is explicitly forbidden by this task's constraints. The commit for 348 was staged by exact pathspec (`git add src/bridge/tools.ts test/unit/bridge.test.ts docs/specs/348-bridge-delivery-hardening/`), never `git add -A`/`.`, so none of the other agent's in-progress files were swept in.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Verification log

### 2026-07-04T00:32:50Z — pass (2/2) — source: tasks.md
- `npm test -- test/unit/bridge.test.ts` — pass
- `npm run typecheck` — pass

## Dogfood log

### 2026-07-04T00:33:05Z — pass (1/1) — source: tasks.md — commit: 67ab4cc82e46b910f1899f0b406bfd163f96457e
- `npm test -- test/unit/bridge.test.ts` — pass

## Dogfood log

### 2026-07-04 — live dogfood on installed 0.55.15 — PASS (4/4 incl. maintainer's 1-2)
Maintainer verified the visualPolish pair (board header kit rhythm; pin-preview inline image). claude ran
the 348 pair live with a throwaway haiku agent (dogfoodee):
- write_input to a WORKING recipient → structured `refused-busy: use notify_agent or wait for idle`,
  composer untouched (test 3 PASS).
- update_task assigning t-b3fde9 to the still-busy recipient → notice queued per 341, flushed on idle,
  delivered via hardened submit, and the envelope STARTED a turn — the recipient read and acknowledged the
  assignment (test 4 PASS; full busy→queue→flush→wake pipeline observed in one pane).
Bonus repro: the throwaway agent self-named "dogfood-335" in its completion notify — expected, its brief
came from 0.55.15 which predates layer A (c957253); the identity line rides the next VSIX.
Cleanup: dogfoodee dismissed, t-b3fde9 dropped.
