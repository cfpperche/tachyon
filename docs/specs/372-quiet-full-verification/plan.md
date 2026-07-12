# 372 — quiet-full-verification — plan

_Drafted from `spec.md` on 2026-07-11. The approach, not the steps (those go in `tasks.md`)._

## Approach

Add a small Node runner at `scripts/verify-full.mjs`. Verbose mode remains the existing package script. Quiet mode
runs `node esbuild.mjs` with stdout/stderr redirected to a private temporary log; only a successful build advances to
the local Vitest CLI, using its JSON reporter and `passed-only` console silence. The runner parses the JSON report for
file/test/pass/fail/skip/todo counters, then removes successful temporary artifacts.

On failure, retain the private temporary directory, preserve a non-zero exit, and print the failed phase plus bounded
diagnostics. Assertion rendering is capped at 10 failures, 2 KiB per failure, and 24 KiB overall; infrastructure or
build fallback output is a bounded tail. The message names the retained log and `npm run verify:full` fallback.
Forward termination signals to the active child so quiet mode cannot orphan build/test processes.

Add `verify:full:quiet` to `package.json`, leave `verify:full` verbose, and change only this workspace's
`tachyon.yml settings.verify.full` to the quiet command. Unit tests cover report formatting, bounds, failure fallback,
package/config defaults, and success cleanup; dogfood exercises the real full runner and records output bytes/lines.

## Key decisions

- **Machine-readable Vitest report** — chosen because local Vitest 3.2.6 exposes exact counters and
  `failureMessages`; rejected scraping the default reporter because formatting is unstable and successful noise is
  interleaved with failures.
- **Stream to temporary files** — chosen to keep both model context and runner memory bounded; rejected capturing the
  full run in a JavaScript string.
- **Quiet is the orchestration default, not a rename** — `verify:full` stays familiar and verbose for debugging;
  `tachyon.yml` mechanically selects quiet for agents.
- **Bound failure output** — actionable failures remain visible, but pathological failure fan-out cannot recreate the
  rate-limit problem; the complete private log and verbose rerun remain available.
- **No gate-frequency change** — isolates output-token savings from verification-policy changes so quality and the
  cause/effect measurement remain clear.

## Files touched

- `scripts/verify-full.mjs` — quiet orchestration, JSON parsing, bounded diagnostics, cleanup, and signal forwarding.
- `package.json` — add `verify:full:quiet`; retain verbose `verify:full`.
- `tachyon.yml` — select quiet as this workspace's declared full gate.
- `test/unit/verifyFullQuiet.test.ts` — formatter/bounds/config/package behavior.
- `docs/specs/372-quiet-full-verification/*` — contract, evidence, and closure.

## Risks & unknowns

- Vitest may fail before writing JSON; fall back to the bounded raw log and retain it.
- Child processes may ignore termination; forward SIGINT/SIGTERM and wait for their exit rather than reporting false
  completion.
- JSON suite counters are not test-file counters. Derive files from `testResults`, tests from top-level counters.
- Reporter changes must not change selection. Dogfood quiet and verbose on the same HEAD and compare totals.
- Concurrent runs need distinct private temporary directories.

## Visual impact

**Visual QA Opt-Out:** terminal text is mechanically asserted and measured; no browser/native visual surface changes.

## Sources consulted

- `package.json` current `verify:full` workload.
- `tachyon.yml` current `settings.verify.full` orchestration default.
- `esbuild.mjs` build logging and inherited Tailwind output.
- Local `vitest 3.2.6 --help --expand-help` and a real JSON reporter sample at
  `/tmp/tachyon-vitest-quiet-report.json`.
- `src/bridge/verifyTask.ts`/`docs/architecture/dogfood-product-boundary.md` boundary: other projects retain the
  generic default; only Tachyon opts into this command.
