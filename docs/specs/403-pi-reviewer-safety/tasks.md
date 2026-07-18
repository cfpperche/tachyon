# 403 — pi-reviewer-safety — tasks

_Generated from `plan.md` on 2026-07-18._

## Implementation

- [x] Add canonical Pi reviewer denylist parsing/injection and conflict refusal.
- [x] Permit only the canonical reviewer exclusion through Pi Bridge wiring.
- [x] Add measured Pi permission profile metadata.
- [x] Prove spawn/lifecycle, zero-effects and ordinary-agent behavior with unit tests.
- [x] Add real Pi active-tool catalog dogfood.
- [x] Update Pi/parity documentation.

## Verification

- [x] Reviewer command tests cover bare/env/launcher/positional insertion and safe byte preservation.
- [x] Conflict tests prove refusal before reservation and tmux mutation.
- [x] Bridge tests prove canonical exclusion accepted and every other tool filter refused.
- [x] Real Pi dogfood proves mutators absent and read/probe tools present.
- [x] Existing Pi onboarding/private-home/interaction suites remain green.

**Verify:** `npx vitest run test/unit/agentManager.test.ts test/unit/runtimeProfile.test.ts test/unit/piRuntimeOnboarding.test.ts test/unit/piSession.test.ts --maxWorkers=2 && npm run build && npm run check:engine-boundary && npm run test:invariants`

## Dogfood

**Dogfood:** `node scripts/dogfood/pi-reviewer-safety.mjs`

**Human dogfood:** ✓ In the isolated Dev Host, `pi-reviewer-demo` ran the exact adapted command, read README through native `read`, reported `bash`/`edit`/`write` unavailable, kept the probe absent, and retained wired Bridge state. An ordinary `pi-full-demo` control retained all mutators.

## Visual QA

**Visual QA Opt-Out:** command/governance behavior only; no rendered UI changes.

## Cookbook

**Cookbook-Opt-Out:** internal reviewer adaptation; operators use the existing Delivery reviewer role.
