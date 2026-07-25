# 452 — agent-studio-canonical-trust-copy — plan

_Drafted from `spec.md` on 2026-07-25. The approach, not the steps (those go in `tasks.md`)._

## Approach

Add one host-localized canonical profile label and render it as an in-flow hint immediately below the
Working directory row. Guard it with the existing canonical form flag so New/Edit canonical share the
copy while legacy forms remain unchanged. Add source/label/localization regression coverage, then
inspect the real preview fixtures at desktop and narrow widths.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Place the hint under Working directory** — the authorization scope is defined by that field;
  rejected lifecycle-header copy because it would be distant from cwd selection in long forms.
- **Reuse host-projected `AgentProfileLabels`** — visible strings stay localized consistently;
  rejected an App literal because webview copy must use the localization boundary.
- **Use existing hint styling** — this is explanatory copy, not a warning or new control; rejected a
  bespoke card because it would overstate the behavior and add layout noise.

## Files touched

- `src/webview/agent-studio-shell/domain.ts` — localized label contract.
- `src/webview/agent-studio-shell/App.tsx` — canonical-only in-flow hint.
- `l10n/bundle.l10n*.json` — English and pt-BR messages.
- `test/unit/agentStudioProfileActions.test.ts` and `agentStudioAdapter.test.ts` — regression coverage.
- `docs/specs/452-agent-studio-canonical-trust-copy/*` — contract and evidence.

## Risks & unknowns

- Copy may wrap poorly at narrow widths or visually compete with advanced sections below.
- Tests must prove canonical-only rendering rather than merely searching for a string.
- New and Edit use the same form branch; preview both fixtures to guard state-specific layout.

## Visual impact

One additional help paragraph below Working directory. Visual QA judges hierarchy, wrapping, spacing,
contrast, and narrow-width overflow in New/Edit.

## Sources consulted

- `src/webview/agent-studio-shell/App.tsx`
- `src/webview/agent-studio-shell/domain.ts`
- `src/webview/AgentStudioAdapter.ts`
- `test/unit/agentStudioProfileActions.test.ts`
- `config/visual-qa.json` and webview preview catalog
