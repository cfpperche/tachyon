# 363 — agent-onboarding — plan (Phase 1, enforcement-first)

_Drafted 2026-07-07 after full ratification (3 decisions). Delivery experiment ordered by the maintainer:
ALTERNATE runtimes per task — T1 Sonnet, T2 codex, T3 Sonnet — same gated pipeline, recording per-runtime
compliance insights (exact-name, doorbell, F1/F2). This doubles as T4's measurement._

## Anchors (verified in code today)

- notify_agent handler — src/bridge/tools.ts (~:367 liveness gate); caller is self-declared `agent` param
  (provenance, not authentication — fine per ratified Decision 2, finding-only).
- verify_task — src/bridge/verifyTask.ts (record shape, blockers[], verifierVersion "362-phase1-t4");
  delegationRecord.ts (record + readLatestDelegationRecord; `delegator` field from t-1b6ab0).
- Brief composition — spawn contract text assembled in tools.ts spawn_agent handler (spec 246); instructions
  re-delivery + re-anchor machinery exists (spec 216).
- Gated worktree facts: fresh (no node_modules/dist/.tachyon), branch tachyon/<agent>, npm ci needed.

## T1 — Bridge-witnessed doorbell (runtime: SONNET)

- notify_agent handler appends an event `{from, to, at}` to `.tachyon/doorbells.jsonl` (single append-only
  file, source tree — worktree agents call the Bridge, the Bridge writes in the source tree; tamper-resistant
  like loadVerifySettings).
- verifyTask: new NON-BLOCKING findings support — record entries gain `blocking: boolean`; verdict is
  "blocked" iff any blocking entry (schema evolution, verifierVersion bump "363-phase1-t1"). First
  non-blocking check: `protocol_doorbell_missed` — no doorbell event from record.agent → record.delegator
  (fallback: any `from: record.agent` event) between record.createdAt and verify time.
- Tests: doorbell event written on notify; verify_task with doorbell → no finding; without → finding present
  AND verdict still accept when everything else green; existing blocker paths unchanged.

## T2 — container-generated canonical behavior test (runtime: CODEX; kills the 4/4)

- Gated spawn: after worktree allocation, the container WRITES a stub test file on the task branch
  (`test/unit/<agent>Behavior.gen.test.ts` or contract-named path) containing the EXACT behavior-test name
  with a failing body (`expect.fail("delegation not implemented yet")`) and COMMITS it as a setup commit
  (author: container) before the agent starts. The agent's job: make it pass (edit the body, never the name).
- Base leg semantics improve: at baseSha the stub doesn't exist → no-match 86 fail ✓; at refSha the stub runs.
- verify_task: compares the observed executed-test name via the JSON reporter against record.behaviorTest —
  mismatch = blocking `behavior_test_renamed` (the agent renamed/removed the stub = tampering, this one
  BLOCKS).
- Scope: the stub path is auto-appended to owns. DelegationRecord gains `stubPath`.
- Tests: real-git — gated spawn writes+commits stub; agent-passes path accepts; renamed stub blocks;
  stub-removal blocks.

## T3 — primer + Before-finishing block (runtime: SONNET)

- New module `src/bridge/primer.ts` (or src/agents/): ONE source renders two sections from
  (identity, delegation record, config.settings.verify, worktree facts):
  - **PRIMER** (~30 lines, fixed delimiters `── TACHYON PRIMER ──`): who you are (name, delegator/parent,
    gated? behavior test = the generated stub path+name), worktree bootstrap (npm ci, no .tachyon/ here),
    protocol (doorbell mandatory, never poll, findings → file + one-line notify, set_continuity), verify
    commands from config, "call orient if unsure" placeholder (Phase 2).
  - **BEFORE FINISHING** (≤8 lines, END of brief): full-suite + typecheck commands, commit by pathspec with
    task id, tree clean, make the stub pass WITHOUT renaming it, notify_agent(to:<delegator>).
- Wired into: spawn (ad-hoc contract brief AND declared instructions delivery), restart/resume, re-anchor —
  always full (no delta state).
- Precedence note rendered into the primer: task contract wins task-specifics; primer wins global protocol.
- Tests: snapshot the rendered primer for (gated ad-hoc / plain ad-hoc / declared) × (spawn/resume); budget
  guard (≤34 lines); single-source (contract boilerplate and primer share the renderer).

## T4 — dogfood + measurement + docs

Next delegation wave (T1-T3 themselves are the wave): record per-runtime, per-delivery: exact-name honored?
doorbell rung? F1/F2? Compare Sonnet vs codex. notes.md truth pass + spec close-out assessment.

GUARD for all: non-gated spawn behavior byte-identical when features unused; existing verifyTask/spawn tests
green unchanged; verifierVersion bumps per T.
