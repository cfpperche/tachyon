# 400 — pi-session-continuity

_Created 2026-07-18._

**Status:** shipped

**Closure:** Exact minted Pi session identity, private session directory and fail-closed Resume shipped in `dc3e8a60`; dogfood closure landed in `6dc5d197` with human Stop → Resume evidence at `ff71e6c3`.
**Verify:** `npx vitest run test/unit/adapters.test.ts test/unit/resume.test.ts test/unit/agentManager.test.ts test/unit/piSession.test.ts`
**Verify:** `npm run test:invariants`
**Dogfood:** `node scripts/dogfood/pi-session-continuity.mjs`

## Intent

SDD 399 proved that a Tachyon-managed Pi receives its primer, authenticated identity and Bridge tools, but the engine still classifies Pi as non-resumable. A stopped/crashed Pi therefore cannot advertise or execute Tachyon's exact-session Resume flow even though Pi exposes caller-selected `--session-id` and exact `--session <id>` primitives with durable JSONL transcripts.

Give every non-self-managed Pi agent a Tachyon-minted session id and a private per-agent session directory. Tachyon must resume the exact recorded transcript after restart/reload/reboot, validate its header/path before claiming readiness, and never guess from another Pi agent's same-cwd session.

**Affected Product Invariants: none — PI-001 onboarding/project-guidance transport is unchanged; no registered invariant currently owns session continuity.**

## Acceptance criteria

- [x] **Scenario: managed Pi receives stable session identity**
  - **Given** a Tachyon-managed Pi command without user-owned session flags
  - **When** Tachyon spawns it
  - **Then** Tachyon supplies a unique `--session-id`, persists runtime/id/session-home authority, and routes storage to a private per-agent directory
- [x] **Scenario: exact Pi conversation resumes**
  - **Given** a persisted Pi ledger row whose exact JSONL transcript exists with matching id and cwd
  - **When** Tachyon resumes the agent after stop, crash, reload or reboot
  - **Then** it launches `pi --session <exact-id>`, re-injects the Bridge, does not paste the primer, and preserves the existing conversation
- [x] **Scenario: same-cwd Pi agents cannot steal continuity**
  - **Given** two Pi agents with the same cwd
  - **When** transcripts are resolved or resume readiness is computed
  - **Then** each agent uses only its own private session directory and exact header id/cwd; newest-by-cwd guessing is never used
- [x] **Scenario: deleted, malformed or mismatched transcript fails closed**
  - **Given** a recorded Pi id whose transcript is missing, malformed, symlinked, or carries another id/cwd
  - **When** readiness, transcript lookup or resume runs
  - **Then** Tachyon reports unavailable/retry and does not launch that transcript as accepted continuity
- [x] **Scenario: user-owned Pi session lifecycle remains user-owned**
  - **Given** a Pi command with `--session`, `--session-id`, `--continue`, `--resume`, `--fork` or `--no-session`
  - **When** Tachyon starts it
  - **Then** the command's session semantics remain byte-preserved and Tachyon does not create a misleading managed resume block
- [x] Existing runtimes' adapter, path, readiness and resume behavior remains unchanged.
- [x] A headless real-Pi dogfood proves state written in one process is present after exact-id resume in a second process without invoking a paid/remote model.

## Non-goals

- Pi transcript normalization or the Activity UI (Phase 3).
- Tachyon-native Pi fork/clone/tree controls or managed-agent rename; rename fails closed while the private session directory remains name-keyed.
- Pi harness/private config home, provider auth isolation or plugin materialization.
- Following an in-TUI `/resume` to a different user-selected session; Phase 2 owns the exact Tachyon-minted session unless a future measured ownership hook is added.
- Merging either stacked branch into `main` without explicit maintainer authorization.

## Open questions

None for this slice. Pi's shipped CLI and session format provide exact mint/resume primitives; the implementation must prove them rather than infer new semantics.
