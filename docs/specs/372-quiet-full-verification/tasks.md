# 372 — quiet-full-verification — tasks

_Generated from `plan.md` on 2026-07-11. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [ ] Implement the private-temp, signal-forwarding build/test runner and pure bounded report formatting.
- [ ] Add `verify:full:quiet` while preserving verbose `verify:full` byte-for-byte in `package.json`.
- [ ] Add success/failure/bounds/cleanup and package/config regression tests.
- [ ] Switch only `tachyon.yml settings.verify.full` to `npm run verify:full:quiet`.

## Verification

- [ ] Focused unit tests prove exact counters, no passed noise, failure caps, fallback log pointer, and declared default.
- [ ] `npm run verify:full:quiet` passes the real build/full suite with successful stdout below 1 KiB.
- [ ] One final verbose `npm run verify:full` run has the same file/test totals as quiet mode.

**Headless check:** `npx vitest run test/unit/verifyFullQuiet.test.ts && npm run typecheck`
**Verify:** `npx vitest run test/unit/verifyFullQuiet.test.ts`
**Verify:** `npm run typecheck`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood:** `npm run verify:full:quiet`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** optional — run `npm run verify:full` only when inspecting the intentionally verbose fallback.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

**Visual QA Opt-Out:** terminal output is bounded by automated byte/line assertions; no visual UI changes.
