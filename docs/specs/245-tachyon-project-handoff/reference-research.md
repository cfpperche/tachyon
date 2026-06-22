# Reference research — Project Handoff editor webview (spec 245, Increment D)

Stack ladder: **rung 1** — the existing project stack decides it. Tachyon's UI is Preact webviews bundled by
esbuild, themed with VS Code CSS variables; there is no external design system to research or invent (repo rule:
reuse, don't invent). The "references" are therefore INTERNAL — the panels Tachyon already ships — plus VS Code
webview theming conventions. `detect` reports framework=unknown / design_system=none / browser_renderable=no
(it doesn't recognize a VS Code extension), confirming the internal-DS path.

| Source | Domain relevance | Pattern borrowed | Pattern rejected | Implementation consequence |
|---|---|---|---|---|
| `src/webview/ActivityPanel.ts` | sibling editor-area webview panel | `createWebviewPanel` + `asWebviewUri(dist/webview/*.js)` + `postMessage` data feed + slow-cadence refresh + `openFile`/terminal escape-hatch messages + `retainContextWhenHidden` | the live-tail / backward-paging machinery (handoff is a small static doc, not a growing feed) | a NEW small bundle `dist/webview/handoff.js`; host posts a single snapshot, re-posts on change — no paging |
| `src/webview/activity/{main,App}.tsx` | Preact webview entry pattern | `acquireVsCodeApi()` + `onMsg` → `setState` → render; never imports `vscode` (engine-boundary) | the chat/feed components | a `src/webview/handoff/{main,App}.tsx` pair, one message type `handoff` |
| `src/webview/activity/markdownEngine.ts` (`renderMarkdownHtml`) | render the canonical handoff body | reuse `renderMarkdownHtml` verbatim | re-implementing markdown | the body renders identically to assistant markdown elsewhere |
| `src/webview/sidebar/App.tsx` (`global(op,hash)`, folder header `App.tsx:521-530`, `const multi`) | the per-folder open affordance | a per-folder button+badge → `global("openHandoff", hash)`; top header single-root / folder header multi-root | a per-row `ActionId` (handoff is folder-scoped, not agent-scoped) | new `GlobalOp` `openHandoff`; `FleetVM.handoff` carries the badge state |
| VS Code webview theming (`--vscode-*` CSS vars), codicon.css (already shipped to `dist/webview`) | native look, no new font/icon deps | theme-var colors + codicon glyphs for the badge/actions | a bespoke color palette / icon set | zero new assets; inline CSS in the panel HTML using `--vscode-*` |

Accessibility: the badge conveys staleness by TEXT + glyph (not color alone); actions are real `<button>`s
(keyboard-operable); the panel is read-only so no form-a11y surface. Honors the active VS Code theme automatically
via theme vars.
