# 362 — delegation-verification-gate — plan (Phase 1, Tier-1 only)

_Drafted 2026-07-07 by claude, after full ratification (all 6 decisions, spec.md). Scope per Decision 5:
the sound minimum — per-agent isolation + attributable commit + tiered tests + behavior verifier + tripwire
scan — as a coordinator-requested Bridge tool (Decision 1: A-now/B-ready) emitting SHA-bound records._

## Anchors (verified in code)

- `spawn_agent` — src/bridge/tools.ts:427, already validates the spec-246 delegation contract
  (task/context/constraints/deliverable|done_when).
- Worktree isolation — spec 210: `SpawnOptions.worktree?: boolean` (AgentManager.ts:115),
  `resolveSpawnCwd` returns `{cwd, worktree?: WorktreeRecord}`; WorktreeManager exists.
- Bridge tool registry — `registerTools(mcp, deps)` src/bridge/tools.ts:402.
- Canonical commands — `tachyon.yml` gains an optional `verify:` block (Decision 4/ratified #3 of the old
  list): `{ full: "npm test", typecheck?: "npm run typecheck" }`; default `npm test` when absent.

## Design (Phase 1)

### 1. The delegation record (spawn-side)
`spawn_agent` gains an optional **`gate`** param:
`gate: { behavior_test: string; owns?: string[] }`
- Passing `gate` FORCES worktree isolation (Decision 2): the spawn allocates the worktree + task branch
  (existing spec-210 machinery), and REJECTS if worktree creation is unavailable — a gated delegation may not
  silently fall back to the shared tree.
- At spawn, persist a **DelegationRecord** to `.tachyon/delegations/<agent>-<ts>.json`:
  `{ agent, taskId?, baseSha, taskRef, owns[], behaviorTest, contract: {task, done_when|deliverable}, createdAt }`.
  `baseSha = git rev-parse HEAD` of the source tree at allocation.
- `behavior_test` is the Decision-3 requirement: a vitest name/pattern (e.g. a `-t` filter or test file) that
  must FAIL at baseSha and PASS at the delivered HEAD. The contract gate rejects `gate` without it.

### 2. The `verify_task` Bridge tool (landing-side)
`verify_task({ agent | recordPath, waivers?: [{finding, reason, cites}] })` → runs, deterministically, against
the agent's task ref (never the shared HEAD):

- **(a) attributable commit** — resolve the delegation record; `refSha = git rev-parse <taskRef>`;
  FAIL if `refSha == baseSha` (nothing landed) or if uncommitted changes remain in the agent worktree;
  collect `changed = git diff --name-only baseSha..refSha`; FAIL if `changed ⊄ owns[]` (scope breach) or
  `changed = ∅`.
- **(b) tiered tests, harness-owned** — in a CLEAN checkout of `refSha` (the agent's worktree after
  `git status` clean, or a temp worktree of refSha): run typecheck + **affected tests** (vitest related /
  the test files under changed dirs) on every verify; run the canonical FULL command only when
  `full: true` is passed (the coordinator does this before merging to the integration ref — Decision 4).
- **(behavior)** — run `behaviorTest` at `baseSha` (temp worktree) expecting FAILURE, and at `refSha`
  expecting SUCCESS. Both wrong-direction results are blockers (a test that already passed at base proves
  nothing).
- **(c) suppression tripwire** — regex scan `git diff baseSha..refSha -- 'test/**'` for
  `.skip/.only/xit/xdescribe/xfail/deleted test file/renamed test file/test-config change`. Each hit must be
  matched by a `waivers[]` entry (coordinator-authored, with `cites` naming the deleted/changed production
  artifact) or it's a blocker. Waivers land inside the verification record (Decision 6).
- **Output** — `{ verdict: "accept" | "blocked", blockers: [{code, detail, file?}], record }` where `record`
  is also persisted to `.tachyon/verifications/<refSha>.json`:
  `{ refSha, treeSha, baseSha, taskRef, agent, taskId, verifierVersion, commands[], findings[], waivers[],
  verdict, at }` + an integrity hash over the record content (B-ready: a protected-ref hook can later demand
  this record for the exact SHA — Decision 1). Any new commit on the ref invalidates (verify matches SHA
  exactly; TOCTOU closed).

### 3. What Phase 1 does NOT do
No auto-hook on the completion envelope (coordinator calls the tool — locus A); no structured deliverables[]
(Tier 2); no coverage-delta/AST scan (tripwire only); no verifier-agent; no merge chokepoint (B). The record
format is the only B-ready obligation.

## Tasks (sequential codex contracts, checkpoint each — same discipline as 350 Phase 4)

- **T1 — delegation record + gate param on spawn_agent**: `gate` zod schema + contract-gate extension
  (reject gate without behavior_test), forced-worktree path, DelegationRecord persistence. Unit tests
  (spawn with gate → record written with real baseSha; gate without behavior_test → rejected; gate with
  worktree unavailable → rejected).
- **T2 — verify_task tool**: checks (a)+(behavior)+(c) + the SHA-bound record + waivers. Registered in
  registerTools with caller identity; unit tests with a scripted git fixture repo (temp dir): accept path,
  each blocker path, waiver path, TOCTOU (new commit after verify → record mismatch).
- **T3 — tiered test execution + `verify:` block in tachyon.yml config** (parse + default `npm test`),
  affected-tests resolution (vitest related over changed files), `full:true` mode. Tests.
- **T4 — dogfood + docs**: run the gate for real on the NEXT delegation of this repo (self-hosting proof),
  README section for the contract-writing pattern (how to name a behavior_test), notes.md truth pass.

GUARD for all: the existing spec-246 contract behavior for non-gated spawns is UNCHANGED (no gate param →
exactly today's flow); `formLogic`-style discipline — spawn_agent's existing tests stay green unchanged.
