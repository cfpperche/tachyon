# 418 — sidebar-agent-filter-dropdown — plan

_Drafted from `spec.md` on 2026-07-19. The approach, not the steps (those go in `tasks.md`)._

## Approach

Move the filter renderer into the Agents branch of `.sec-actions`, before the existing metrics/sort/add icons. Render a native `<select>` whose options come from `AGENT_STATUS_FILTERS` and show `Label · count`. Use direct `setAgentFilter(asAgentStatusFilter(value))`; native selection replaces the old chip re-click toggle. Keep the control absent for a zero-agent fleet, matching current behavior.

Replace pill CSS with a narrow, flex-shrinkable select that uses VS Code dropdown tokens. Add a source/CSS contract regression alongside the existing pure filter-behavior tests. Exercise the real sidebar bundle through the preview harness and capture headless screenshots at 360 px and a narrower 240 px viewport.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Native select** — chosen for built-in keyboard, focus, disabled-option, and screen-reader semantics; rejected a custom popover because six static modes do not justify extra interaction state.
- **Counts inside option labels** — keeps all information from the pills and makes the selected state self-describing.
- **Zero-count options disabled, not removed** — preserves category discoverability and the current pill behavior.
- **Session-local state remains session-local** — this is a layout change, not a persistence-policy change.

## Files touched

- `src/webview/sidebar/App.tsx` — move filtering into the section toolbar dropdown.
- `src/webview/sidebar/sidebar.css` — replace pill lane styles with responsive dropdown styles.
- `test/unit/agentStatusFilterDropdown.test.ts` — enforce markup, option, accessibility, and retired-CSS shape.
- `test/fixtures/sidebar-agent-status-filter-dogfood/README.md` — update operator description from chips to dropdown.

## Risks & unknowns

- Native select text can clip at very narrow widths; the control needs a bounded, shrinkable width and full title/aria text.
- The header action cluster can overflow when all three icon actions are present; preview both normal and narrow widths.
- A disabled currently-selected option must still permit selecting `All`; native select behavior and state updates cover this.

## Visual impact

The six-pill row disappears and the Agents header gains one compact dropdown. Headless Visual QA will judge vertical-space recovery, alignment with icon actions, text legibility, theme-token fidelity, and overflow at 360×760 and 240×760.

## Sources consulted

- Existing filter contract: `src/webview/sidebar/agentStatusFilter.ts` and `test/unit/agentStatusFilter.test.ts`.
- Existing native-select precedent: Pins filter in `App.tsx` / `.pin-filter select`.
- Preview target and fixtures: `scripts/webview-preview/routes.ts`, `scripts/webview-preview/fixtures/sidebar.ts`, and the visual-qa config baseline.
