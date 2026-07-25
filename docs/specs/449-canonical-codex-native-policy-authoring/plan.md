# 449 — canonical-codex-native-policy-authoring — plan

_Drafted from `spec.md` on 2026-07-25. The approach, not the steps (those go in `tasks.md`)._

## Approach

Add one shared constructor for the supported Codex scalar policy, then use it to seed New Agent form
state and to update one family at a time. Render a compact canonical-Codex card with one source select
per measured family. Serialization strips those defaults if a new profile resolves to a non-Codex
adapter. Existing projection and materialization code remains unchanged.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Global is the new-Codex default** — private-home isolation otherwise changes established behavior;
  rejected an empty default because it reproduced the reported permission prompt.
- **Choice remains per family** — this matches the ratified capability-scoped policy; rejected one
  broad “inherit config” checkbox because it hides provenance and invites whole-file copying.
- **Reuse exact adapter tuples** — the form constructs only already-supported policies; rejected
  user-editable treatment/refresh/lifecycle controls because they would expose unsupported states.
- **No projector changes** — the existing typed allowlist is the security boundary and already has
  lifecycle proof; this slice only supplies the missing policy.

## Files touched

- `src/config/agentNativeConfigPolicy.ts` — shared supported-policy constructors.
- `src/webview/agent-studio-shell/domain.ts` — default form state, source helpers and serialization.
- `src/webview/agent-studio-shell/App.tsx` — visible per-family source controls.
- `test/unit/agentStudioAdapter.test.ts` — default/edit/non-Codex payload coverage.
- `test/unit/codexNativeConfigProjection.test.ts` — global `never` reaches the typed private projection.
- `docs/specs/449-canonical-codex-native-policy-authoring/*` — contract and evidence.

## Risks & unknowns

- New-form defaults could leak into Claude/Grok/Pi payloads; cover adapter switching explicitly.
- UI could present a choice that the adapter rejects; derive every choice from one fixed constructor.
- Workspace config fails closed on out-of-family leaves by design; preserve the existing diagnostic.

## Visual impact

Agent Studio gains a full-width “Native configuration” card with three compact rows. Capture the New
Agent form in the Dev Host and verify the controls remain in document flow without recreating the
legacy harness.

## Sources consulted

- `docs/architecture/agent-native-config-inheritance.md`
- `docs/specs/441-native-config-policy-foundation/`
- `docs/specs/442-codex-native-config-adapter/`
- `src/config/agentNativeConfigPolicy.ts`
- `src/config/codexNativeConfigProjection.ts`
- `src/webview/agent-studio-shell/{App,domain}.tsx`
