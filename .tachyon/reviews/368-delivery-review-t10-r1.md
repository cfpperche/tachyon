# SDD 368 T10 R1 adversarial review

Verdict: **FINDINGS**

Reviewed immutable range `cdbc1b8..31094e128efaa587f1e6064c5e332f0e750fa85c` against the T10 contract in `docs/specs/368-delivery-worktree-leases/notes.md`.

## P1 — Reviewer safety flags can be moved past `--` or onto a different shell command

Evidence: `reviewerSafeCommand` identifies flags by `trim().split(/\s+/)` and appends a missing safety flag to the very end of the original command (`src/agents/AgentManager.ts:165-190`). The resulting string is then accepted as the reviewer override (`src/agents/AgentManager.ts:845-856`) and persisted as `originalCmd` (`src/agents/AgentManager.ts:1151-1153`, `1220-1232`). This is not an argv-aware transformation, so the persisted string can contain the required words while the runtime never receives the option.

Exact reproductions through `spawn(... deliveryJoin.role="reviewer")`:

- `codex --` becomes `codex -- --sandbox read-only`. Codex treats everything after `--` as positional input; the sandbox option is ineffective, while the ledger misleadingly persists it as the supposedly effective safe command.
- `codex | tee /tmp/review.log` becomes `codex | tee /tmp/review.log --sandbox read-only`. The flag is passed to `tee`, not Codex.
- `codex --sandbox read-only | sh` is returned unchanged because the whitespace scan sees a safe Codex flag, but the shell operator still launches a second unrestricted command.
- `codex --sandbox "read-only"` is falsely rejected because the parsed value is the literal token `"read-only"`; conversely, bypass-looking text in a quoted prompt or after `--` is treated as an active option. Thus existing quoting and option boundaries are not preserved truthfully.
- Launchers such as `env X=1 codex` happen to be recognized by `binaryOf`, but the same `--` and operator failures remain, so wrapper support does not repair the authority boundary.

Impact: a supported reviewer runtime can launch without the bound read-only/plan hint, and the durable ledger can falsely claim that the effective launch was safe. Shell composition can additionally run an unrestricted sibling command. This directly falsifies the contract requirements that reviewer flags remain effective, conflicting/bypass modes refuse completely, and the persisted command equal the effective safe launch.

Required smallest fix: parse the command with the same shell/argv model used for launch preflight. Locate the supported runtime argv through permitted wrappers; inspect only runtime options before its `--`; insert the safety option before `--`; preserve quoted arguments; and fail closed on shell control operators or any composition whose single effective runtime argv cannot be proven. Persist that structurally validated command. Add production-path regressions for quoted safe modes, `--`, permitted wrappers, pipelines/`&&`/`;`, bypass-looking positional text, and a real argv capture proving which process receives the flag.

Test truthfulness: the new AgentManager tests cover only bare runtime names and simple unquoted conflicts (`test/unit/agentManager.test.ts:827-863`). Their assertions use string containment, so `codex -- --sandbox read-only` and `codex | tee ... --sandbox read-only` would both pass despite proving no effective runtime confinement.

## Other reviewed areas

No additional blocking bypass was found in `completeReview`. Same-intent drain/completion retries use immutable operation receipts; different intents collide; completion revalidates the exact draining holder and open empty-authority reviewer tail; fence work is outside locks; both inspections fence HEAD/task-ref/index/tracked state; only the successful CAS closes/releases and emits `review_completed`; and failed postconditions quarantine without authoritative completion while preserving the open segment and current holder. The quarantine-persistence failure path retains the original cause in an `AggregateError`. Untracked-only changes are deliberately non-verdict-bearing as contracted.

Advisory (untested): the service's safety depends on `canonicalWorktreeFor`, `withWorktreeLock`, and `inspectReviewWorktree` sharing the same canonical-path authority and lock domain. T10 intentionally does not add production wiring, so this review could validate the service boundary and mocks but not an end-to-end real Git inspection/fence implementation.

## Verification

- Focused serial matrix: `npx vitest run test/unit/deliveryLeaseService.test.ts test/unit/agentManager.test.ts --maxWorkers=1` — **262 passed** (50 + 212).
- `npm run typecheck` — **passed**.
- `git diff --check` — **passed** before adding this report.
- `npm run verify:full` — **passed**, 300 files; 3,389 passed, 3 skipped.
