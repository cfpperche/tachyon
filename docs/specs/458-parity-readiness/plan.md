# 458 — parity-readiness — plan

_Drafted from `spec.md` on 2026-07-25. The approach, not the steps (those go in `tasks.md`)._

## Approach

Add structured canonical limitation codes to runtime profiles where the prior parity slices recorded
an explicit gap. Build Studio readiness from those codes plus the resume adapter's native fork
capability, then add it to the redacted canonical snapshot. The webview maps codes to host-localized
labels and renders a compact readiness block immediately before lifecycle actions.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Project codes, not prose** — runtime profiles and adapters own evidence; the UI owns localized wording.
  Rejected copying runtime notes into Agent Studio because it would drift and could expose implementation detail.
- **Inform before acting, do not block** — limitations appear next to Enable/Start. Rejected a new gate because
  these are known operating boundaries rather than missing approval.

## Files touched

- `src/runtime/runtimeProfile.ts` — structured evidence-backed canonical limitation codes.
- `src/config/agentProfileStudio.ts` — redacted readiness projection, including adapter-native fork support.
- `src/webview/agent-studio-shell/{domain.ts,App.tsx,agent-studio-shell.css}` — labels and visible readiness block.
- `scripts/webview-preview/fixtures/agent-studio-shell.ts` — representative limited canonical preview.
- `test/unit/agentProfileStudio.test.ts` — projection regression coverage.
- `l10n/bundle.l10n*.json` — English and pt-BR labels.

## Risks & unknowns

Snapshot schema changes can reject existing preview fixtures and the block could crowd narrow layouts. Typecheck,
focused tests, full verification, and a desktop/narrow preview capture address those risks.

## Visual impact

The lifecycle card gains a small bordered readiness block before actions. Inspect the canonical-disabled
preview at desktop and narrow widths to ensure the status pill and list remain readable.

## Sources consulted

- `src/runtime/runtimeProfile.ts`
- `src/resume/adapters.ts`
- `docs/specs/454-codex-canonical-parity/` through `457-pi-canonical-parity/`
- `src/webview/agent-studio-shell/App.tsx` and preview fixture
