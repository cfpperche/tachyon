# 310 — codex-harness-studio-ui — plan

_Drafted from `spec.md` on 2026-07-01. The approach, not the steps (those go in `tasks.md`)._

## Approach

Fix the webview render gate in `Agent Studio` so harness/transcript controls are shown for `claude` and `codex`.
Introduce a small runtime helper in the webview layer instead of another ad-hoc `hasClaude` check, then use it to:

- show the shared isolation controls for Claude/Codex agents;
- hide rules/skills/hooks textareas when the current runtime is Codex;
- keep Claude's full harness controls unchanged.

Update `formLogic` validation so a Codex harness with rules/skills/hooks gets a blocking issue in the Studio layer,
matching the existing authoritative `loadConfig` validation.

## Key decisions

- **Expose Codex controls in UI, not just manual YAML** — chosen because Agent Studio is the product surface shown in
  the bug; rejected documenting manual config as sufficient because it leaves the pin visibly broken.
- **Hide unsupported Codex fields** — chosen because Codex harness currently supports MCP isolation only; rejected
  showing rules/skills/hooks and relying on backend errors because it invites invalid configs.
- **Keep backend unchanged** — chosen because spec 298 already validates and materializes Codex MCP harness correctly.

## Files touched

- `src/webview/agent-studio/App.tsx` — runtime gate and Codex-specific field visibility.
- `src/webview/formLogic.ts` — Studio validation for Codex unsupported harness fields.
- `src/webview/agent-studio/messages.ts` / host strings if a new validation message is needed.
- `test/unit/agentStudio.test.ts` — regression coverage for Codex form validation/entry behavior.
- `docs/specs/310-codex-harness-studio-ui/*` — SDD artifacts.

## Risks & unknowns

- Webview rendering has less direct unit coverage than pure form logic; verify with build/package and, if feasible, a
  focused preview or screenshot pass.
- Existing localization/message mapping may need a new stable error code.

## Sources consulted

- `docs/specs/298-codex-isolated-harness/spec.md` — Codex backend support and explicit MCP-only limitation.
- `src/webview/agent-studio/App.tsx` — current Claude-only `showHarness` gate.
- `src/webview/formLogic.ts` — form validation and YAML entry generation.
- `src/config/loadConfig.ts` — authoritative Codex MCP-only harness validation.
