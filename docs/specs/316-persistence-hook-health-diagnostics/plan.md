# 316 — persistence-hook-health-diagnostics — plan

_Drafted from `spec.md` on 2026-07-01. The approach, not the steps (those go in `tasks.md`)._

## Approach

Expose a small per-agent persistence hook health signal from existing evidence, without creating another health ledger.
The classifier lives in `Workspace` because it can compare desired config, current-spawn injection state, and hook-script
failure evidence.

State model:

- `active`: silent hooks are desired and the current spawn recorded successful injection.
- `skipped`: silent hooks are desired but current-spawn injection recorded inactive, usually because the runtime command
  shape prevented injection (for example custom Claude `--settings`).
- `failed`: a spec-317 failure row exists for the agent and is newer than the latest active injection timestamp.
- `unknown`: silent hooks are desired but no current-spawn injection evidence exists.

The first UI surface is the sidebar row metadata because the sidebar already shows compact operational chips for
continuity, harness, and verification state. The VM carries `active`, but the UI only renders a chip for
`failed/skipped/unknown`; a healthy active hook should not add visual noise. Problem states carry tooltip reason text.
This keeps diagnostics visible without typing anything into the agent pane.

## Key decisions

- Use current-spawn injection state from `.tachyon/activity/silent-persistence-hooks.json`; do not infer success from
  desired config alone.
- Use `.tachyon/activity/persistence-hooks-failures.jsonl` from spec 317 as the failed signal.
- If a newer active injection exists after an older failure, report `active` rather than stale `failed`.
- If no current-spawn injection state exists, return `unknown` even if an old failure row exists.
- If the newest failure timestamp is invalid, do not fall through to `active`; classify it as current failure once
  current-spawn state exists.
- Sidebar is acceptable as the first surface because the chip is compact and only appears for non-active states on
  declared Claude/Codex agents where silent hooks are desired.
- Handoff-pointer failure rows now include the agent name when silent persistence passes a failure ledger, so failures
  can be attributed per agent.

## Files touched

- `src/activity/sessionOwners.ts`
- `src/workspace/Workspace.ts`
- `src/sidebar/types.ts`
- `src/sidebar/agentModel.ts`
- `src/webview/SidebarPrototype.ts`
- `src/webview/sidebar/App.tsx`
- `test/unit/sessionOwners.test.ts`
- `test/unit/agentModel.test.ts`
- `test/unit/continuityWiring.test.ts`

## Risks & unknowns

- Highest risk: reporting hook health from desired config instead of actual current-spawn evidence. Mitigation:
  `Workspace.persistenceHookHealth()` returns active/skipped only from the injection state file written by the spawn path.
- Secondary risk: stale failures masking a later successful spawn. Mitigation: failure timestamps are compared against the
  last active injection timestamp.
- UI risk: sidebar noise. Mitigation: render no chip for `active`; render one compact chip for problematic/unknown states.

## Sources consulted

- `docs/specs/312-silent-persistence-hooks/`
- `docs/specs/314-persistence-hooks-v2/`
- `docs/specs/317-persistence-hook-failure-log/`
- `docs/specs/319-persistence-ledger-retention/`
- `src/workspace/Workspace.ts`
- `src/webview/sidebar/App.tsx`
- `src/webview/SidebarPrototype.ts`
- `test/unit/continuityWiring.test.ts`
- `test/unit/agentModel.test.ts`
