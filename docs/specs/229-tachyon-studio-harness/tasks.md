# 229 — tachyon-studio-harness — tasks

**Verify:** `npm run typecheck && npx vitest run`

## Implementation — DONE 2026-06-17
- [x] `formLogic.ts` — `FormState` harness fields; `parseYamlObject`; `toEntry` builds `harness:`;
      `validateForm` (claude-only / malformed-yaml / empty); `fromDef` round-trips; `HARNESS_DEFAULTS`
      spread into the non-agent FormState factories.
- [x] `AgentForm.ts` (webview, thin) — "Isolated harness" `<details>` section (toggle + inherit select
      + mcp/hooks YAML textareas + rules/skills path lists); strings; readState; applyStrings; prefill;
      agent-only show/hide in `setTab`.
- [x] `Workspace.issueMessage` — messages for the 4 new harness codes; pt-BR bundle entries.

## Tests — DONE (573 unit + typecheck + build green)
- [x] `agentStudio.test.ts` — toEntry builds the harness block (mcp/rules/skills); omitted when off;
      validateForm (claude-only / empty / malformed mcp+hooks); fromDef round-trip.

## Note
The webview JS that reads the fields into the posted state (`AgentForm.ts` string) is not unit-testable
(vscode-bound), same as the existing worktree/verify wiring — the tested `toEntry`/`validateForm` cover
the contract. A live dogfood (open Studio → toggle Isolated harness → save → check the yaml) confirms the wiring.
