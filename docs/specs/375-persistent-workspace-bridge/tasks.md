# 375 — persistent-workspace-bridge — tasks

_Generated from `plan.md` on 2026-07-13. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Implement and test proxy/control protocol, singleton handshake and owner-only socket/descriptor.
- [x] Implement detached loopback proxy with bounded `HOST_UNAVAILABLE` and explicit stop.
- [x] Add Workspace-side ensure/register/health/stop client and advertised endpoint support.
- [x] Wire activation, reload-safe disposal, Restart Bridge and Stop Bridge.
- [x] Add packaging/file-list coverage and headless user-manager lifecycle tests.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Stable proxy PID/port across backend detach and reattach.
- [x] Linux/WSL proxy is not a direct child of the caller or Extension Host process.
- [x] Requests proxy before/after reattach and return bounded 503 during the gap.
- [x] Concurrent ensure elects one proxy; stale socket recovery does not kill by PID.
- [x] Typecheck, focused tests, diff-check and full verification pass.

**Headless check:** `node scripts/dogfood/persistent-bridge.mjs`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Verify:** `npm run verify:full:quiet`

**Dogfood:** `node scripts/dogfood/persistent-bridge.mjs`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** Reload the installed Extension Host and confirm the current agent reconnects without restart.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

**Visual QA Opt-Out:** command-palette-only lifecycle change; headless behavior is the acceptance surface.
