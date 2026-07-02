# 314 — persistence-hooks-v2 — plan

_Drafted from `spec.md` on 2026-07-01. The approach, not the steps (those go in `tasks.md`)._

## Approach

Keep this umbrella as a planning artifact. It does not change runtime code; it binds child specs to the same invariants
and recommends the sequence that reduces risk first.

Child specs:

- 315 `persistence-stop-hook-dogfood`: prove the existing Stop hook fires in real Claude and Codex sessions and leaves
  deterministic evidence; until 317 lands, it must include explicit manual failure checks rather than relying on UI
  diagnostics.
- 317 `persistence-hook-failure-log`: make hook script failures durable and inspectable without breaking the runtime
  hook contract.
- 319 `persistence-ledger-retention`: bound/rotate persistence ledgers and hook logs.
- 316 `persistence-hook-health-diagnostics`: surface whether silent persistence hooks are active, skipped, failed, or
  unknown for each agent, consuming the durable evidence from 315/317/319 rather than inventing a parallel signal.
- 318 `persistence-settings-ui`: expose the workspace kill switch and, if justified, per-agent override controls, linking
  back to the diagnostic surface from 316.
- 320 `persistence-handoff-candidates`: canceled/superseded after owner review because the existing Project Handoff
  pending-notes lane already provides the review-gated buffer this spec proposed.

## Key decisions

- **Umbrella plus child specs** — chosen because the six improvements have different risk profiles and validation paths;
  rejected one mega-spec because it would mix runtime dogfood, UI, retention policy, and semantic handoff automation.
- **Manual proof before health UI** — chosen because health UI should consume durable failure/success evidence instead of
  inventing signals; rejected UI-first because it can make unproven state look authoritative.
- **Failure log before full diagnostics** — chosen because diagnostics depends on a durable failure source; rejected
  building 316 before 317 because it would create throwaway ad-hoc health signals.
- **Retention before broad UI rollout** — chosen because activity ledgers/logs are local operational state and should be
  bounded before broader surfacing increases usage.
- **Semantic candidate lane superseded** — chosen because pending handoff notes already separate proposed project-state
  updates from the canonical handoff; rejected adding a second queue before pending notes.
- **Silent invariant remains global** — chosen because the user pain was visible pane spam; rejected any design that
  reports hook state by typing automatic messages into the agent pane.

## Files touched

- `docs/specs/314-persistence-hooks-v2/*` — umbrella contract and sequence.
- `docs/specs/315-persistence-stop-hook-dogfood/spec.md` — child spec for real Stop proof.
- `docs/specs/316-persistence-hook-health-diagnostics/spec.md` — child spec for active/skipped/failed/unknown state.
- `docs/specs/317-persistence-hook-failure-log/spec.md` — child spec for durable failure logging.
- `docs/specs/318-persistence-settings-ui/spec.md` — child spec for config controls.
- `docs/specs/319-persistence-ledger-retention/spec.md` — child spec for pruning/rotation.
- `docs/specs/320-persistence-handoff-candidates/spec.md` — child spec canceled/superseded by existing pending notes.

## Risks & unknowns

- Child specs can drift from spec 312 if they suppress visible fallbacks even when hooks were not injected.
- Health state can become false confidence unless it is tied to current-spawn injection plus hook-script evidence.
- A second semantic candidate queue would duplicate pending notes and create more review noise.
- Runtime hook behavior can differ between Claude and Codex; dogfood must cover both.
- The numbered specs did not exactly match execution order after review; the owner ratified the final decision by
  canceling 320 as overlap.
- Hook logs can expose sensitive local paths or payload fragments; child specs must preserve sanitized, minimal records.

## Sources consulted

- `docs/specs/312-silent-persistence-hooks/` — v1 behavior and shipped boundaries.
- `src/activity/sessionOwners.ts` — materialized SessionStart/Stop hook scripts and ledgers.
- `src/harness/HarnessManager.ts` — hook script/config materialization for Claude and Codex.
- `src/agents/AgentManager.ts` — current-spawn hook injection callback.
- `src/workspace/Workspace.ts` — silent persistence gating and visible fallback suppression.
- `src/config/loadConfig.ts`, `src/config/tachyon.schema.json` — `settings.persistence.silentHooks`.
- `src/webview/AgentForm.ts`, `src/webview/inspector/App.tsx`, `src/webview/sidebar/App.tsx` — likely UI surfaces for child specs.
- Claude probe `probe-6c0f33d0-adcf-49cf-8198-296b7b7b22b8` — reviewed the initial decomposition and forced the
  observability-first ordering above.
