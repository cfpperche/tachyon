# 477 — multiruntime-auth-required — plan

_Drafted from `spec.md` on 2026-07-27. The approach, not the steps (those go in `tasks.md`)._

## Approach

The measurement came first and it reshaped the design twice, so the plan starts from what the
runtimes actually do rather than from the incident's symptom.

Auth-required becomes a first-class agent state reached ONLY from a per-runtime declared signal.
The declaration lives next to the other runtime capabilities, so a runtime that cannot report is
`✗` by declaration rather than by silence, and turning a peer on later is a declaration plus a
measured note — the same shape SDD 473's `reportsEffectiveModel` uses.

```
runtime output ──► per-runtime declared matcher ──► authRequired evidence
                                                     │
                        (no matcher / no match) ─────┴──► unchanged behaviour
                                                     │
                          attention: needs-human ◄───┘
                                 │
        ┌────────────────────────┼──────────────────────────┐
   notify human            hold the task            stop auto restart/retry
   (runtime, agent,        (assigned, not           (explicit human/coordinator
    safe action)            executed)                action only)
```

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **D1 — a NEW state, not a reuse of `needs-input`.** `needs-input` means "answer me and I continue";
  auth-required means "nothing you type here will run". They differ in who must act (any agent vs a
  human at a provider) and in what unblocks them. Rejected: reusing `needs-input`, which would let
  `write_input` "answer" an unauthenticated pane forever.
- **D2 — turn-attached evidence, never the footer.** Measured: Claude's footer
  `Not logged in · Run /login` appeared on a fully functional agent mid-task. A pane matcher on that
  string parks healthy agents, which is the worst failure this spec can produce. The trustworthy
  signal is the runtime ANSWERING the login error. Rejected: the obvious pane regex.
- **D3 — declared per runtime, measured or absent.** Same contract shape as `reportsEffectiveModel`:
  a runtime declares its matcher and the version it was measured on, or declares nothing. Rejected: a
  shared generic regex like `GenericLaunchReadiness`'s — it would fire on peers whose wording was
  never measured and, worse, would silently claim coverage for OpenCode, which emits nothing.
- **D4 — hold the task, do not fail it.** An unauthenticated agent has not failed its work; it cannot
  start it. Failing would lose the assignment and invite a retry loop. Rejected: marking the task
  failed, and rejected: unassigning it (the coordinator would immediately re-hand it out).
- **D5 — recovery is explicit, never automatic.** No auto-login, no auto-refresh in v1 even where a
  provider offers one (grok's `--device-code`, env-var keys on pi/hermes). Driving those means
  handling secrets on a human's behalf; the spec leaves it open deliberately. Rejected: auto-refresh
  for grok, which is the one runtime where it would be technically possible today.
- **D6 — auth is separated from its neighbours by matcher, not by heuristic.** Rate limit, quota,
  permission, network and invalid session already have their own classifications; the auth matcher is
  additional and narrow, and anything it does not match keeps today's behaviour.

## Files touched

_The modules/files this will create or change, with a one-line note on each._

| File | Change |
|------|--------|
| `docs/specs/477-multiruntime-auth-required/` | **new** — this contract plus the measured matrix |
| `docs/runtimes/parity.md` | **done in this increment** — capability row 16 + §3.7 measured table + changelog |
| `src/runtime/runtimeProfile.ts` | declare the per-runtime auth-required matcher/capability |
| `src/attention/*` | the new state and its evidence, fed from the declared matcher |
| task/assignment path | hold the assigned task; suppress automatic restart/retry while held |
| tests + dogfood | fixtures from the captured bytes; recovery-after-login exercised |

## Risks & unknowns

- **False positives park healthy agents.** Directly measured on Claude's footer, and the reason D2
  exists. Any matcher must be turn-attached and version-stated.
- **Codex retries five times internally** before reporting 401. A Tachyon-side retry must not
  compound with that.
- **OpenCode cannot participate** (filed as `t-0338fc`): it answers on a fallback model instead of
  erroring, so an agent can look healthy while running a model nobody chose.
- **A genuinely expired credential cannot be fabricated** from a valid one, so the live-TUI Claude
  shape stays an open question rather than a guess.

## Sources consulted

`src/runtime/launchReadiness.ts` and `src/runtime/adapters/codexLaunchReadiness.ts` (an existing
`runtime_auth_rejected` that covers LAUNCH only, via a generic regex), `src/attention/AttentionMonitor.ts`
and `src/attention/manifests/`, `src/resume/adapters.ts` (per-runtime auth files and the OpenCode
fallback footgun recorded under t-e2ebe3), `src/harness/HarnessManager.ts` (credential symlink/copy
policy per runtime), `docs/runtimes/parity.md`, task `t-16cd93` and its journal, and direct
measurement of all six CLIs recorded in `spec.md`.
