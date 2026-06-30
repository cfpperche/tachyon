# 302 — plugins-view-improvements — plan

_Drafted from `spec.md` on 2026-06-30. The approach, not the steps (those go in `tasks.md`)._

## Approach

1. Extend the Plugins webview dispatch/message contract with a per-plugin update-check action, e.g. `checkPluginUpdate(name)`, backed by a new inbound message type. Keep the existing `checkUpdates` path unchanged for the global header button.
2. Refactor the host update-check logic in `PluginsPanelManager` so the "resolve source -> load plugin -> previewUpdate -> deriveUpdateCheck" work is shared by global and per-plugin checks. The per-plugin path should merge one result into the existing `checks` map instead of replacing all checks.
3. Render a per-card "Check" action only for sourced installs (`p.sourceSpec` present). It should live in the existing card action group and use the same busy serialization as other plugin actions.
4. Add Installed-tab local state in `App.tsx` for filter text and sort mode. Filtering and sorting should derive a rendered list from `vm.installed`; do not mutate the VM or move model sorting out of the pure builder.
5. Add a compact toolbar above the installed list with search input, sort select, and visible result count. The toolbar should be hidden for Marketplace, empty, and parse-error states.
6. Update CSS for toolbar/card actions so controls wrap cleanly on narrow widths.
7. Add focused tests for the pure filter/sort helper and targeted host/update-check behavior where practical. Keep broader confidence through typecheck/build and webview preview dogfood.
8. Dogfood through the webview preview harness or a deterministic render route, plus existing plugin view model/unit tests and typecheck.

## Key decisions

- **Filter/sort stays in the webview** — chosen because it is presentation state; rejected pushing it into `buildPluginsViewModel` because that pure builder should represent workspace truth, not current UI controls.
- **Per-plugin update check is sourced-only** — chosen because local-dir installs have no remote source to resolve; rejected rendering a disabled action because it adds noise to every local card.
- **Per-plugin update merges into existing checks** — chosen so a single-card refresh does not erase statuses from a prior global check; rejected replacing the whole map because it would make unrelated badges disappear.
- **Simple sort modes** — chosen because installed plugins are cards, not a spreadsheet; rejected a full data-grid interaction because this view is operational and should stay compact.

## Files touched

- `src/webview/plugins/messages.ts` — add the per-plugin update-check action type.
- `src/webview/plugins/App.tsx` — card action, Installed toolbar, local filter/sort derivation.
- `src/webview/plugins/plugins.css` — toolbar/card action responsive styling.
- `src/webview/PluginsPanel.ts` — host handler and single-plugin update-check flow.
- `src/webview/plugins/listControls.ts` — pure helper for installed-card filtering/sorting.
- `test/unit/pluginsListControls.test.ts` — focused filter/sort coverage.
- `test/unit/pluginViewModel.test.ts` or existing preview fixture tests if action/status assumptions need adjustment.
- `docs/specs/302-plugins-view-improvements/*` — spec evidence.

## Risks & unknowns

- Update-check network operations can be slow; the existing busy guard serializes them, but the UI should show a plugin-specific busy label so the user sees what is happening.
- Sorting by version can be misleading across unrelated plugins; use name/status-focused modes unless a simple version mode proves useful.
- The Plugins View is frontend-heavy; screenshot/preview dogfood is needed to catch layout regressions that typecheck will not.
- Existing preview fixture shape may not need to change because the controls are component state, but the rendered screenshot should be refreshed/checked.

## Sources consulted

- Pin `p-014efe` via Bridge: "Melhorias View de plugins" with details "ter botao de checkupdate por plugin instalado" and "ter uma toolbar pra filtrar, ordenar plugins instalados".
- Attached pin screenshot showing current Plugins View with global Check updates and no Installed toolbar.
- `src/webview/plugins/App.tsx` — current card actions and tabs.
- `src/webview/PluginsPanel.ts` — current global `checkUpdates` host path.
- `src/plugins/viewModel.ts` and `test/unit/pluginViewModel.test.ts` — installed-card model, status, and actions.
