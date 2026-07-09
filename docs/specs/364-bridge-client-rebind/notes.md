# 364 — bridge-client-rebind — notes

_Created 2026-07-09._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- **2026-07-09 — Claude probe fold into `spec.md`.** Durable ledger stamps for
  `bound_generation` + `bridge_wired` (absent ⇒ 0); rebind-start preflight (running + still
  suspect + bound still stale); no concurrent rebind on double-bump (`pending_recheck` + stamp
  current gen at resume); `graceMs: 0` / honest restart-all default; 359 initiator result
  normatively lost + post-resume notice; single Bridge owner per workspace for generation;
  teardown-and-relisten always bumps; circuitFailCount = 3; queue removal on leave-suspect.
  Reviews: `.tachyon/reviews/364-bridge-client-rebind-codex.md`,
  `.tachyon/reviews/364-bridge-client-rebind-claude-probe.md`.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- **2026-07-09 — No `src/bridge/index.ts`.** Package has no bridge barrel; coordinator is imported
  as `../bridge/clientRebind.js` from Workspace (same pattern as other bridge modules).
- **2026-07-09 — Hard stop uses `tmux.killSession` only.** `AgentManager.kill` wipes ad-hoc ledger
  rows; rebind must keep the resume record. Coordinator injects `hardKillSession` that never cold-spawns.
- **2026-07-09 — Policy `off` does not bump generation.** Avoids a silent generation advance when
  the feature is disabled (re-enable then gets one intentional bump on next ready).
- **2026-07-09 — Grace-clear Bridge tool hook not wired end-to-end.** Default `graceMs: 0` makes
  clear a narrow escape hatch; `onAuthenticatedSelfCall` is implemented and unit-tested; host/Bridge
  call-site can wire later without API change.
- **2026-07-09 — Audit path:** `globalStorage/bridge-client-rebind/audit.jsonl` (sibling of
  host-actions), simple JSONL append (not hash-chain).
- **2026-07-09 — continuityWiring harness:** pre-existing failure (UI reinject test) because
  multi-line `sendKeys` uses bracketed paste (`load-buffer`) after t-17d7ea; fake tmux only
  captured `send-keys -l`. Fixed harness in `continuityWiring.test.ts` (not a 364 behavior change).

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- **Drain is serial (`await runOne`) even if maxConcurrentRebinds > 1.** Spec default is 1; raising
  concurrency later needs fire-and-forget slots. Circuit + FIFO still correct under serial drain.
- **Harness wired predicate:** `def.harness && Bridge URL present` counts as wired (Bridge folded
  into harness materialize). Avoids missing harness survivors; may include a harness agent if URL
  was set but materialize failed — accepted Phase 1 approximation.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- Live Grok post-reload dogfood remains maintainer gate (VSIX install + window reload).
- Wire `onAuthenticatedSelfCall` from Bridge resolve path when graceMs > 0 is dogfooded.
