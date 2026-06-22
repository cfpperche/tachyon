# Spec 244 — resume reopens the CURRENT session (ownership-driven resume target)

**Status:** shipped (0.31.2) · **Date:** 2026-06-21 · **Follows:** spec 243 (session-ownership ledger), 220 (claude mint-by-title), 212 (refreshOwnership at stop) · **Surface:** `src/agents/AgentManager.ts` (`refreshOwnership`, `resume`) · **Review:** codex (design + impl) · **Validate:** stop→resume a shared-cwd claude agent after a `/clear` and confirm it reopens the NEW session, not the pre-`/clear` one

## Problem

Spec 243 made the Activity feed **follow** the right session after a `/clear` on a shared cwd (via the per-spawn
SessionStart ownership ledger). But that fixed *attribution* only. The **resume target** — which session claude
actually REOPENS on a stop→resume / restart — still comes from the ledger's `resume.sessionId`, and on a shared cwd
that value is **stale after a `/clear`**.

**Live-observed (2026-06-21, the spec-243 dogfood):** `claude-tachyon` ran in `/home/goat/Agent0` (shared cwd). Its
ledger held `resume.sessionId = ee308fa6` (the pre-`/clear` session, captured at 13:05). After a `/clear` rotated it
to `db3f3453`, a stop→resume ran `claude --resume ee308fa6` — reopening the OLD conversation, not the one the user
was actually in. (The Activity correctly followed `db3f3453` thanks to 243; only the resume target was wrong.)

### Why the stored id stays stale

`refreshOwnership` (spec 212, runs at kill/stop) is the place that refreshes `resume.sessionId` from disk. On a
shared cwd it can ONLY disambiguate by the Tachyon-minted `customTitle` (`resolveClaudeIdByTitle`) — but a
`/clear` session carries an auto-generated `customTitle` (not the minted one), so the resolve returns null/the old
id and the ledger is never advanced to the post-`/clear` session. `resume()` then trusts that stale id.

## Goal

A stop→resume / restart reopens the agent's **actual current session** — even after a `/clear`/`/resume` on a
shared cwd — by using the spec-243 ownership ledger (the reliable positive per-agent signal) as the resume target,
without ever resuming another agent's session.

## Decisions

- **D1 — ownership is the FIRST source in `refreshOwnership` (claude).** Before the title/newest-by-cwd resolve,
  consult `ownedSession(name, cwd)` (the latest ledger row for this agent+cwd). When present, that uuid is the id
  to persist. The existing "transcript exists" guard still applies (never persist a phantom id) and the existing
  title/newest paths remain as the fallback when no ownership row exists (pre-243 agents, non-claude).
- **D2 — `resume()` ALSO consults ownership directly, guarded by existence.** `refreshOwnership` runs at a clean
  stop, but a CRASH (no clean teardown) leaves the ledger stale; so `resume()` independently prefers the owned
  session **only when its transcript exists on disk** — else it falls back to the stored id resolution (no
  regression: a missing owned transcript must not make a resumable agent fall to a fresh spawn).
- **D3 — never resume another agent's session.** `ownedSession`/`latestOwnerFor` (spec 243) is per-agent + requires
  a canonical cwd match, so it can only ever return THIS agent's row. Ownership is positive attribution, not a
  shared-cwd guess — the spec-240 "ambiguous → don't guess" rule is preserved (no ownership row → fall through).
- **D4 — claude-only, reuse 243 infra.** No new ledger, no new hook; this only *reads* the spec-243 ownership
  ledger from two more call sites. Non-claude runtimes are unchanged (codex/opencode already resolve newest-by-cwd
  via their capture resolvers; gemini/qwen unaffected).
- **D5 — no change to the spec-243 Activity resolver.** `transcriptPathOf` already consults ownership (243); this
  spec only wires ownership into the resume/teardown id resolution.

## Non-goals
- Changing the ownership ledger format, the hook, or the SessionStart recorder (spec 243 stands).
- Backfilling a stale ledger for agents spawned BEFORE 0.31.1 had no hook (they have no ownership rows until they
  next start under ≥0.31.1; until then they resume via the existing title/captured-uuid path, as today).
- Non-claude resume-target resolution.

## Risks
- **R1 — an ownership row points to a transcript that was since deleted/rotated.** Mitigation: D2 — `resume()`
  overrides with the owned id ONLY if its transcript exists; `refreshOwnership` keeps its phantom-id guard. Worst
  case = falls back to the existing resolution (today's behavior), never a hard failure.
- **R2 — ordering vs the spec-220 rename-by-title path** (a not-yet-captured `name` id). Mitigation: ownership is
  consulted first and only short-circuits when it returns a (live-transcript) row; the title path remains intact
  for agents with no ownership row.
- **R3 — stale-but-newer ambiguity** (two owned rows). Mitigation: `latestOwnerFor` already returns the single
  newest row for the agent; there is no cross-agent ambiguity (per-agent + cwd match).

## Acceptance criteria
- [x] After a `/clear` on a shared cwd (agent started under ≥0.31.1), `refreshOwnership` at stop advances the ledger's `resume.sessionId` to the post-`/clear` session via the ownership ledger — unit-tested.
- [x] `resume()` reopens the owned (current) session when its transcript exists, even if the stored id is stale — unit-tested; and falls back to the stored-id resolution when the owned transcript is gone — unit-tested.
- [x] Never resumes another agent's session on a shared cwd (no ownership row → existing prefer-gap/title path) — unit-tested.
- [x] `resumeReadiness`/`computeReadiness` mirror the same owner-first resolution so the sidebar badge can't say "fresh start" when Resume would reopen the owned session (codex SHIP-WITH-CHANGES fold) — unit-tested.
- [x] No regression to: an unambiguous-cwd resume, the spec-220 name→title resume, capture runtimes, harness agents (908 green; tsc + build + engine-boundary clean).
- [ ] **Live (user gate):** stop→resume a shared-cwd claude agent (started under ≥0.31.2) after a `/clear` and confirm it reopens the new conversation, with the ledger now holding the new uuid. Ships in 0.31.2.

## Closure
**Closure:** Shipped in 0.31.2 (follow-up to 243). Reuses the spec-243 ownership ledger as the resume TARGET in `refreshOwnership` + `resume()` + `computeReadiness`, owner-first and transcript-validated under the current configHome/cwd. Codex: design pass REFINE (validate via current adapter/configHome, not the row's raw path; owner-first; restart untouched; lazy correction) → impl review SHIP-WITH-CHANGES (readiness must mirror resume — folded). +5 tests (908 total). **Live stop→resume-after-/clear is the user's gate.** Note: agents spawned BEFORE 0.31.1 have no ownership rows until they next start, so they keep the existing title/captured-uuid resume path until then (no backfill — D-non-goals).

## Open questions (for the codex pass)
- **OQ1** — Should `resume()` prefer ownership even when the stored id ALSO resolves to a live transcript (i.e. is
  ownership strictly authoritative), or only when the stored id is stale/missing? (Lean: ownership is the current-
  session truth → prefer it whenever its transcript exists.)
- **OQ2** — Do we also need ownership in the `restart` path, or does restart already re-mint a fresh session (so
  resume is the only stale-target site)? (Verify: restart spawns fresh, so the resume target only matters for resume.)
- **OQ3** — Worth a one-time ledger reconciliation on activation (sync `resume.sessionId` from ownership for all
  agents), or is lazy correction at stop/resume sufficient? (Lean: lazy is enough; avoid a startup scan.)
