# 380 — reload-safe-agent-rebind

_Created 2026-07-14._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Tachyon 0.56.2 reproduced a destructive interaction between the spec-364 Bridge-client rebind and
the spec-368 Delivery lifecycle.  On a host-generation bump, rebind stopped live Delivery-bound
agents before `AgentManager.resume()` rejected their forbidden generic resume, leaving the agents
dead.  Non-Delivery ad-hoc Claude reviewers were also restarted without their persisted
`CLAUDE_CONFIG_DIR`; Claude could not find their intact private transcripts, exited 1, and the
coordinator nevertheless recorded `resume_ok` before observing that immediate death.

Done means rebind proves that generic resume is safe before it sends any stop, resumes private-home
sessions in the exact persisted config home, and records success only after the replacement process
survives a bounded post-resume liveness check.  A VS Code reload may still restart ordinary wired
agents as specified by spec 364, but it must not destroy a Delivery execution or silently call a
crashed replacement healthy.

## Acceptance criteria

- [x] **Scenario: Delivery-bound survivor is never stopped by generic rebind**
  - **Given** a live Bridge-wired agent whose durable Delivery marker makes generic resume unavailable
  - **When** the Bridge generation advances under the default automatic rebind policy
  - **Then** the coordinator refuses before `markExpectedDeath`, graceful stop, hard kill, or resume
  - **And** the original tmux process remains alive and its durable binding is not falsely advanced
- [x] **Scenario: legacy private-home Claude reviewer resumes in its persisted namespace**
  - **Given** a rehydrated ad-hoc Claude row with an intact transcript under `resume.configHome` and no persisted `isolate` field
  - **When** rebind resumes that conversation
  - **Then** the launched process receives `CLAUDE_CONFIG_DIR=resume.configHome` and the exact session id
- [x] **Scenario: replacement dies during the post-resume window**
  - **Given** stop succeeds and the resume command launches, but the replacement exits immediately
  - **When** the coordinator performs its bounded post-resume liveness proof
  - **Then** it records `resume_fail`, does not write `resume_ok`, does not advance the durable generation, and notifies the operator
- [x] **Scenario: ordinary healthy rebind remains functional**
  - **Given** a non-Delivery Bridge-wired agent with a readable transcript
  - **When** generation-bump rebind runs and the replacement remains alive
  - **Then** it records `resume_ok`, stamps the current generation, and preserves existing concurrency/circuit behavior
- [x] Regression coverage includes the two deterministic failure classes behind all four real
  2026-07-14 outcomes: Delivery refusal before stop and private-Claude immediate exit.

## Non-goals

- It does not enable generic resume or restart for Delivery-bound executions.
- It does not redesign spec 364's stop/resume strategy or add an in-process MCP reconnect protocol.
- It does not recover already-killed agents, mutate their worktrees, or integrate their branches.
- It does not change ProcessFence, Delivery lease semantics, Bridge authentication, or user-facing layout.

## Open questions

None.  The production audit, tmux state, persisted ledger, and intact transcript files establish the
failure sequence and the narrow correction boundary.
