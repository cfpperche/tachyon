# SDD 368 T10 R2 adversarial review

Verdict: **FINDINGS**

Reviewed immutable fix range `eef735a..ea7c5e9316adf06ec67c53bd7fce83837a153667` against R1 report `5fc0b45` and the correction contract at `docs/specs/368-delivery-worktree-leases/notes.md:559-583`.

## P1 — Operand-taking launcher flags are mistaken for the supported runtime

`parseLaunchCommand` skips every `npx`/`pnpx`/`bunx` token that starts with `-`, without consuming the operand of options such as `-p`/`--package`/`-c` (`src/runtime/launchPreflight.ts:93-109`). It likewise knows only a subset of `env` operand flags (`src/runtime/launchPreflight.ts:30-31,95-103`), omitting measured local options including `-a`/`--argv0` and `-f`/`--file`. The next operand can therefore be reported as `binary`, and its source end becomes the safety insertion point (`src/runtime/launchPreflight.ts:110-112`; `src/agents/AgentManager.ts:165-192`), even though the shell will pass that word to the wrapper rather than execute it.

Exact reproductions:

- `npx --package @openai/codex codex -- prompt` is parsed as if `@openai/codex` were the runtime (its basename is `codex`) and transforms to `npx --package @openai/codex --sandbox read-only codex -- prompt`. The safety words are in the wrapper option region, not in Codex's argv.
- `npx -p codex codex -- prompt` transforms to `npx -p codex --sandbox read-only codex -- prompt` for the same reason.
- `env --argv0 reviewer codex -- prompt` treats `reviewer` as an unsupported runtime, leaves the command unchanged with only an advisory, and then `env` launches the real Codex with no safety flag. This is a direct supported-runtime bypass. `env -a codex codex -- prompt` treats the first `codex` as `argv0` yet inserts after it; `env -f codex codex -- prompt` has the analogous file-operand failure.

On the installed npm, the malformed npx shape warns that `--sandbox` is an unknown npm option and tries to execute `read-only`; that happens to fail loudly today. The `env --argv0 reviewer ...` form does launch Codex without the flag. These falsify the bound authority predicate: the parser accepted commands for which it did not prove one supported runtime argv, reservation preparation can occur, and persistence is either unchanged/unsafe or contains a nominal safety flag that is not a Codex argument.

Required smallest fix: encode the supported operand grammar for each launcher and advance over each option plus its operand, including attached/separate package and env forms. Fail closed before `prepareDeliveryJoin` for every unknown or ambiguous wrapper option; supporting all forms is not required. Return the runtime token only after proving exactly one executable boundary. Add real argv-capture cases for separated `-p`/`--package`, attached `--package=`, and env's operand-taking short/long options.

Test gap: the wrapper regression uses only operand-free `npx --yes` and `env MODE=review` (`test/unit/agentManager.test.ts:863-877`); the parser test similarly uses only `npx --yes` (`test/unit/runtimeLaunchPreflight.test.ts:41-46`). Neither can detect an operand/runtime boundary swap.

## P2 — Attached Codex short sandbox values are neither recognized nor refused before reservation

The option matcher recognizes only exact `-s` and `-s=VALUE`; it does not recognize Clap's valid attached form `-sVALUE` (`src/agents/AgentManager.ts:171-180,188-192`). Empirically, installed Codex 0.144.1 accepts both `codex -sread-only --version` and `codex -sworkspace-write --version`.

- A valid already-safe `codex -sread-only` is transformed to `codex --sandbox read-only -sread-only`, rather than preserved byte-for-byte. Codex then rejects the duplicate sandbox option.
- A conflicting `codex -sworkspace-write` is not refused before reservation; it becomes `codex --sandbox read-only -sworkspace-write`. Current Codex rejects the duplicate rather than launching workspace-write, so this is not a demonstrated sandbox escape, but it violates conflict detection and fail-before-side-effect semantics.

Required smallest fix: parse `-sVALUE` as the short option with attached value in addition to `-s VALUE` and `-s=VALUE`; preserve exactly one `read-only`, and reject every conflicting value and duplicate before `prepareDeliveryJoin`. Add production-path cases for both attached values and duplicates spanning attached/separate/long forms.

Test gap: the only new short-option case is `-s=read-only`, while the conflict case uses separated `-s danger-full-access` (`test/unit/agentManager.test.ts:844-861`).

## Closed R1 cases and regression audit

The original bare `--`, pipeline/operator/redirection, quoted-value, expansion, and positional bypass-text failures are closed. The real shell capture proves the inserted option reaches the fake Codex argv, and the ledger assertion proves the same transformed command is persisted for that covered shape. Literal/static tracking and the runtime token source offset are sound for the tested quote/assignment forms. Later prompt, harness, Bridge, and ownership composition did not expose a path that removes or overrides an already-established sandbox/permission option; the ownership hook's `--dangerously-bypass-hook-trust` is distinct from approval/sandbox bypass.

`completeReview` production code is unchanged in this delta. Its immutable receipt replay, exact-holder completion checks, quarantine behavior, and authoritative-event singularity show no regression.

## Verification

- Focused serial matrix: `npx vitest run test/unit/deliveryLeaseService.test.ts test/unit/agentManager.test.ts test/unit/runtimeLaunchPreflight.test.ts --maxWorkers=1` — **304 passed** (50 + 230 + 24).
- `npm run typecheck` — **passed**.
- `git diff --check` — **passed** before adding this report.
- `npm run verify:full` — **passed**, 300 files; 3,419 passed, 3 skipped.
