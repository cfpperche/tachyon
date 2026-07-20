# 417 — claude-model-preflight

_Created 2026-07-19. Task: t-838af6._

**Status:** shipped

**Closure:** Shipped 2026-07-19 in `a9f37305`. Claude explicit-model delegation now yields an honest provisional preflight result and is validated by the existing bounded runtime-startup boundary; invalid models still reject and compensate, pending processes remain unassignable, and missing-adapter runtimes remain fail-closed. Dogfood, focused verification, typecheck, and the 5,108-test full suite passed headlessly.

## Intent

Delegated ad-hoc launches fail closed whenever an explicit model is used on a runtime without an authoritative catalog adapter. Claude Code intentionally exposes no safe account-aware catalog command, so valid runtime-native selections such as `--model sonnet` and `--model claude-sonnet-5` are rejected before Claude can validate them. This makes task-fit routing impossible and leaves the already-prepared worktree in recovery state.

Preserve the honest distinction between catalog verification and runtime validation. Claude explicit-model launches should enter the existing bounded provisional startup path: the actual CLI validates its model in the effective environment, fatal model/auth/config output rejects and compensates the launch, a measured composer proves readiness, and an inconclusive live process remains `starting` and unassignable. Runtimes with neither catalog verification nor a ratified startup-validation adapter remain fail-closed.

## Acceptance criteria

- [x] **Scenario: route a delegated Claude agent by model**
  - **Given** an ad-hoc delegated command `claude --model sonnet` or a literal full model id
  - **When** launch preflight runs without an account-aware Claude catalog
  - **Then** the result is explicitly provisional, not falsely catalog-supported or rejected as unverifiable, and normal bounded startup validation runs
- [x] **Scenario: reject an invalid Claude model at startup**
  - **Given** a provisional explicit-model Claude launch
  - **When** the runtime emits a classified model rejection or exits before readiness
  - **Then** spawn fails with the existing structured readiness code and executes existing session/worktree compensation
- [x] **Scenario: keep unknown runtimes fail-closed**
  - **Given** an explicit model on Grok or another delegated runtime with no catalog or startup-validation adapter
  - **When** preflight runs
  - **Then** it still fails with `runtime_preflight_unverifiable` before tmux/ledger success
- [x] Ambiguous or shell-composed explicit-model commands remain rejected without execution.
- [x] Claude default-model launches and Codex authoritative-catalog behavior are unchanged.

## Non-goals

- Inventing or persisting a dated Claude provider/account model catalog.
- Treating a provisional result as proof of account entitlement.
- Relaxing task/input readiness gates for a Claude process still marked `starting`.
- Changing Grok or other no-adapter runtime policy.
- Repairing the separate recovery/baseRef issue tracked by `t-2dd637`.

## Open questions

None. Claude already has measured readiness and generic fatal model classification; the missing contract is a typed preflight result that deliberately hands verification to that existing boundary.
