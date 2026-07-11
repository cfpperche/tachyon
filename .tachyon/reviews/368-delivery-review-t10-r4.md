# SDD 368 T10 R4 final review

Verdict: **ACCEPT**

Reviewed exact R3 fix delta `066d3d8..b5d4d98` against report `01f8fae`, then cumulatively regression-checked the accepted T10 wrapper and review-completion contract at `b5d4d98`.

## R3 finding closure

The one-line production fix closes the proven escape at the correct structural boundary: after the single permitted `env` grammar resolves its command token, a second token whose basename is `env` now makes `parseLaunchCommand` return no parse (`src/runtime/launchPreflight.ts:171-176`). `reviewerSafeCommand` consequently refuses before `prepareDeliveryJoin`; no tmux command is emitted.

Production-path regressions cover:

- `env env codex --`;
- assignment-prefixed `env MODE=review env codex --`;
- option/operand and absolute-path `env -i --argv0 reviewer /usr/bin/env codex --`;
- `env env npx codex --`.

For every case, the test asserts both `prepared === false` and an empty spawned-command list (`test/unit/agentManager.test.ts:928-945`). Parser tests independently require no parse for the same matrix (`test/unit/runtimeLaunchPreflight.test.ts:92-100`). This closes the exact real-shell reproductions from R3, where nested `env` previously consumed both layers and launched Codex unhinted.

## Cumulative wrapper and command review

No remaining bypass was found in the accepted allowlist.

- Exactly one `env` may resolve either a runtime or one `npx`/`pnpx`/`bunx`; each package launcher then resolves exactly one non-wrapper runtime. Allowed separate and long-`=` operands retain their measured consumption, missing/option-shaped operands and shell modes fail closed, and nested known launchers refuse.
- Known literal supported runtimes receive the inserted option immediately after the proven runtime source token. Deterministic wrapper execution proves Codex receives `--sandbox`, `read-only`, then the original delimiter/positionals; the same transformed command is persisted in the ledger.
- `packageLauncher` metadata refuses versioned, scoped, protocol-like, or otherwise adapter-unknown package-first specifications. Literal `npx codex` remains supported; literal known unsupported adapters retain advisory behavior.
- Direct unknown commands and a single `env` around an unknown command remain unchanged with an advisory, as expressly contracted. Arbitrary unknown executables could themselves be wrappers, but they are outside the measured allowlist and are not the known nested-`env` escape; treating them as advisory-only is the explicit T10 policy rather than a defect in this delta.
- Quoted/assignment source offsets remain stable. Codex long, separate short, `-s=VALUE`, and attached `-sVALUE` declarations enforce exactly one literal `read-only`; conflicts, missing values, and duplicates refuse before reservation. Claude/Grok permission declarations have the same single-declaration rule. The first literal `--` bounds inspection, and later prompt/harness/Bridge/ownership composition does not override the safety declaration.

The original R1 tail-append/operator cases, R2 wrapper-operand and attached-short cases, and R3 nested-env case are all closed by production-path assertions rather than string containment alone.

## Review completion regression

`src/delivery/leaseService.ts` and `test/unit/deliveryLeaseService.test.ts` have no diff from original T10 head `31094e1` through `b5d4d98`. Re-audit found no invalid authoritative ACCEPT path: immutable intent receipts govern drain/completion replay; exact holder, open reviewer tail, fence proof, and double Git inspection precede the completion CAS; invalid or uncertain postconditions quarantine without `review_completed`; and successful completion/replay remains singular.

## Verification

- Focused serial matrix: `npx vitest run test/unit/deliveryLeaseService.test.ts test/unit/agentManager.test.ts test/unit/runtimeLaunchPreflight.test.ts --maxWorkers=1` — **385 passed** (50 + 268 + 67).
- `npm run typecheck` — **passed**.
- `git diff --check` — **passed** before adding this report.
- `npm run verify:full` — **passed**, 300 files; 3,500 passed, 3 skipped.
