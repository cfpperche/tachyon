# 429 — Agent profile lifecycle and Studio — plan

_Drafted from `spec.md` on 2026-07-22._

## Approach

Keep this SDD as the integration contract and deliver its four trust boundaries as separate Tasks/SDDs. First establish the exclusive lifecycle service and its revisioned read model. Then build identity/destructive operations and portable bundles independently over that service. Finally replace Agent Studio's legacy profile-backed save path with the typed lifecycle protocol and prove the installed UI.

The parent closes only when every follow-up is done and the final rollout proves the entire create → edit → disable/enable → clone/export/import → rename → forget sequence without leaking or copying authority.

## Key decisions

- **Nested decomposition** — chosen because the task contains four independently shippable outcomes; rejected one cross-layer patch because failures and authority changes would be difficult to review.
- **One mutation service** — chosen to make CAS, journaling and authority preservation uniform; rejected extending generic `YamlConfigEditor` because it cannot own profile provenance or external authority.
- **Opaque whole-snapshot revision** — chosen because edits race with canonical and authority inputs; rejected mtimes and form-local revisions because they do not bind all authoritative inputs.
- **Portable interchange schema** — chosen to make redaction and reauthorization explicit; rejected archiving `.tachyon/agents/<agent>` because that would mix canonical, learned, projected and external state.
- **UI last** — chosen so Studio consumes stable domain commands and diagnostics; rejected embedding transaction semantics in webview messages.

## Files touched

- `docs/specs/429-agent-profile-lifecycle-studio/*` — umbrella contract, decomposition and closure evidence.
- Follow-up SDDs will own production/test files; this parent intentionally introduces no production implementation.

## Risks & unknowns

- Existing live rename and forget paths span tmux, ledgers, worktrees and Evolution; their external commit point must be proven before mutation.
- Enable/disable needs one canonical representation plus enforcement at every launch entry point.
- A resolved display model can accidentally convert inherited/learned/projected values into explicit writes unless patches carry only user intent.
- Secret-free export needs allowlisting, not heuristic key-name redaction.

## Visual impact

The final follow-up changes Agent Studio substantially: source/authority badges, conflicts, disabled/degraded states and lifecycle actions. It requires dark/light/high-contrast inspection, keyboard/focus checks and installed Dev Host dogfood.

## Sources consulted

- SDDs 423, 425, 426, 427 and 428.
- `src/config/agentProfile{Schema,Authority,Migration,Resolver,ConfigLoader}.ts`.
- `src/agents/{AgentManager,forgetAgent,soulProfileTransactions}.ts`.
- `src/workspace/Workspace.ts`, `src/engine-service/extensionOperationService.ts` and `src/config/YamlConfigEditor.ts`.
- Agent Studio adapter, domain, protocol and shell modules.
- Independent review `probe-a581e95d-7849-4297-96e3-f3e89088eabc`.
