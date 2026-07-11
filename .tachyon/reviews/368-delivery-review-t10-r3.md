# SDD 368 T10 R3 final adversarial review

Verdict: **FINDINGS**

Reviewed the cumulative correction from R2 report `ac097eb` through implementation head `a4547fa2f6180ca01ef5f53623b9197403d00b0b`, grounded by correction contracts `f151179` and `2114017`. Re-audited the original T10 service at `31094e1`.

## P1 — Nested `env` escapes the wrapper allowlist and launches an unhinted supported runtime

The explicit wrapper parser consumes one leading `env`, assigns its command token to `start`, and updates `base` (`src/runtime/launchPreflight.ts:169-174`). It rejects nested wrappers only inside the subsequent package-launcher branch (`src/runtime/launchPreflight.ts:175-184`). If the command selected by the first `env` is another literal `env`, that branch is skipped and the second `env` is returned as the apparent runtime (`src/runtime/launchPreflight.ts:185-202`).

Exact production-path reproduction:

1. Supply reviewer command `env env codex --` (or `env MODE=review env codex --`).
2. `parseLaunchCommand` returns `binary: "env"`, no `packageLauncher`, and literal argv containing `codex`.
3. `reviewerSafeCommand` therefore treats it as a direct unsupported runtime, returns the command unchanged with an advisory (`src/agents/AgentManager.ts:166-171,215`), then permits reservation preparation and spawn.
4. The real shell consumes both wrappers and launches Codex without `--sandbox read-only`. Empirical wrapper-consumption proof on this host: both `env env codex --version` and `env MODE=review env codex --version` executed the installed Codex and printed `codex-cli 0.144.1`.
5. The ledger persists the unchanged unsafe command, so persistence is truthful to the string but the string is not a proven reviewer-safe effective runtime argv.

Impact: this is a direct recurrence of the R2 authority failure. A supported reviewer runtime launches without its measured safety mode even though the correction contract requires every unknown or nested launcher to refuse before reservation. It also falsifies the requested invariant that exactly one supported runtime argv is structurally proven.

Required smallest fix: immediately after resolving the single permitted `env` layer, reject `base === "env"` before adapter/advisory policy (or unify wrapper traversal so every second wrapper is rejected unless it is the one permitted `env -> package launcher` transition). Add parser and AgentManager production-path regressions for `env env codex`, assignment/option variants before the second `env`, and `env env npx codex`; assert `prepareDeliveryJoin` remains untouched. A real `env` capture should prove refusal rather than relying only on parser shape.

Test gap: nested package launchers are covered only by `npx --yes pnpx codex` (`test/unit/runtimeLaunchPreflight.test.ts:94-101`). The accepted/refused matrices do not include nested `env`, so the direct-unknown advisory tests inadvertently leave this known wrapper escape open.

## Closure of prior findings and remaining audit

R2's operand-taking wrapper and attached-short findings are otherwise closed. The explicit grammars correctly distinguish separate and long-`=` operands, reject missing/option-shaped operands and shell modes, handle the measured `pnpx --allow-build` operand, support the allowed `env -> package launcher` chain, and reject nested package launchers. `packageLauncher` metadata plus AgentManager policy refuses versioned/scoped/protocol and otherwise unknown package-first specifications while preserving the expressly accepted literal `npx codex`, literal known unsupported adapters, and direct/single-env unknown advisory policy. Source insertion offsets remain correct under the exercised quotes and assignments. Deterministic wrapper captures prove the inserted option reaches the runtime argv for the accepted env/npx/pnpx/bunx forms.

Codex `--sandbox`, `-s`, `-s=`, and attached `-sVALUE` forms now enforce exactly one literal `read-only` declaration; conflicting, missing, and duplicate declarations refuse before reservation. Claude/Grok permission modes have the same single-declaration rule. The first literal `--` bounds option inspection, positional bypass-looking data stays data, and later prompt/harness/Bridge/ownership composition does not remove or override the established reviewer mode in the reviewed paths.

`src/delivery/leaseService.ts` and its focused tests have no diff from `31094e1` to `a4547fa`. Re-review found no invalid authoritative ACCEPT path: drain/completion replay remains intent-bound to immutable receipts, exact holder/tail and two Git observations precede the completion CAS, fence uncertainty or postcondition failure quarantines without `review_completed`, and successful replay/event publication remains singular.

## Verification

- Focused serial matrix: `npx vitest run test/unit/deliveryLeaseService.test.ts test/unit/agentManager.test.ts test/unit/runtimeLaunchPreflight.test.ts --maxWorkers=1` — **377 passed** (50 + 264 + 63).
- `npm run typecheck` — **passed**.
- `git diff --check` — **passed** before adding this report.
- `npm run verify:full` — **passed**, 300 files; 3,492 passed, 3 skipped.
