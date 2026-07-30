# 483 — governed Saved Agent proposal v2 — plan

## Approach

Extend the sealed proposal schema and review projection, then cross the persistent engine seam through
one additive v2 action. Reuse the existing canonical lifecycle writer. Owner-present uses its plural
transaction; owner-absent uses the same writer for the new profile only. The engine constructs the
profile from the typed Studio mutation and merges only the closed grant object.

## Key decisions

- **Ownership is explicit data** — absent remains proposer-owned for compatibility; `top-level` means no owner edge.
- **Grant stays narrow** — only literal `proposeSavedAgent: true` is representable in the v2 action.
- **Selectors reuse runtime policy** — no raw runtime configuration is accepted.
- **Additive wire action** — old strict payload is not widened, preserving safe version skew.
- **No automatic start** — approval and execution remain separate human-visible actions.

## Files touched

- `src/agents/savedAgentProposal*.ts` — proposal, admission, review and commit.
- `src/bridge/tools.ts` — governed proposal input.
- `src/runtime-api/extensionOperations.ts` — additive v2 action.
- `src/engine-service/extensionOperationService.ts` — canonical profile construction.
- `src/workspace/Workspace.ts`, `src/shell/*` — optional-owner transaction wiring.
- `src/humanInbox/model.ts`, `src/webview/human-inbox/App.tsx` — review projection.
- focused unit tests — fail-before/pass-after coverage.

## Risks & unknowns

- An optional owner must not weaken ownership-cycle validation when an owner is present.
- Model/reasoning values must be validated by the same runtime policy as Agent Studio.
- The new grant must never become self-approval; it only permits proposing another human decision.

## Visual impact

The existing proposal detail gains compact rows for ownership, model, reasoning and requested grants.
No new layout system or animation is introduced.

## Sources consulted

- SDD 482 and its Saved Agent proposal implementation.
- Agent Studio mutation and native-config policies.
- Persistent engine extension-operation schemas and the 0.56.110 skew incident constraints.
