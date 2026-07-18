# 399 — pi-session-continuity — notes

_Created 2026-07-18._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- Managed Pi is a mint runtime: Tachyon supplies a UUID with `--session-id` and resumes only that authority with `--session`.
- `PI_CODING_AGENT_SESSION_DIR` points to a mode-0700 `.tachyon/pi-sessions/<agent>` directory. This is runtime state, not Pi config, and the host-owned value wins over project env for a managed session.
- Exact transcript acceptance requires one regular no-follow JSONL whose bounded header matches both id and canonical cwd. Missing ids and duplicate matches return no authority rather than selecting newest.
- The canonical forget-agent footprint now includes the private Pi session directory, so ad-hoc/dismissed and deleted declared agents do not leak transcript homes.
- Managed Pi rename fails closed in Phase 2. Moving a live name-keyed home, tmux session and ledger authority atomically needs its own contract; silently renaming would make Resume point at an empty new directory.

## Deviations

- No `engineService.ts` change was needed: Workspace already owns both AgentManager composition and daemon resolver wiring.
- Pi lazily creates a session file only after an assistant response. Provider-free dogfood could not truthfully prove a persisted conversation using only RPC metadata/bash messages, so the dogfood runs a deterministic local zero-cost OpenAI-compatible SSE provider to produce one assistant response, then resumes it in a second real Pi process.

## Tradeoffs

- Phase 2 intentionally does not follow an in-TUI `/resume` or `/new` transition. Exact Tachyon-minted authority avoids stealing another session; following user navigation requires a future Pi ownership hook.
- A private per-agent session directory means managed sessions do not appear in the user's default Pi session directory. This buys deterministic same-cwd isolation while remaining accessible through Tachyon Resume and ordinary file inspection.

## Open questions

- Human Dev Host Stop → Resume dogfood is pending maintainer interaction.
- The stacked base still carries the unrelated main verification defects recorded by SDD 398: missing `verify-full.mjs` declaration and stale `verifyFullQuiet.test.ts` expectation. Full suite result was 4,858 pass / 3 skipped / those same 2 failures; Phase 2 focused verification, build, engine boundary, PI-001 and real-Pi dogfood are green.

## Dogfood log

### 2026-07-18T15:09:48Z — pass (1/1) — source: tasks.md — commit: 494413a8669e2d2e2bd862a09a36e13ddc527b05
- `node scripts/dogfood/pi-session-continuity.mjs` — pass

## Verification log

### 2026-07-18T15:09:54Z — pass (2/2) — source: tasks.md
- `npx vitest run test/unit/adapters.test.ts test/unit/resume.test.ts test/unit/agentManager.test.ts test/unit/piSession.test.ts` — pass
- `npm run test:invariants` — pass
