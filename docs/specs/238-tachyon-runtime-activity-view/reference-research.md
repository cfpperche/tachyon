# Reference research — Activity feed perf + Tier 2 polish (spec 238)

Surface: the editor-area Activity WebviewPanel feed (`src/webview/activity/*`). Mode: `refine`.
Stack resolved via ladder **rung 1** (existing project stack): VS Code extension + Preact render-only webview, CSP+nonce, inline CSS in `ActivityPanel.ts`. No standard web framework → done-proof is EDH + `scripts/activity-preview.mjs` + unit tests (NOT a web e2e runner).

| Source | Domain relevance | Pattern borrowed | Pattern REJECTED | Implementation consequence |
|---|---|---|---|---|
| TanStack Virtual discussions #195 / #1013 (reverse + dynamic) | Virtualizing reverse-chat with variable heights | — | **Measured virtualization (measureElement + scroll-anchor)** for v1 | Reverse + async post-mount height changes + window-scroll + bottom-stick simultaneously is the documented painful path; too risky for a webview first pass |
| MDN / web.dev `content-visibility` | Skip layout+paint of offscreen subtrees natively | `content-visibility:auto` + `contain-intrinsic-size` per feed item | — | Zero protocol/scroll-model change; attacks the real cost (paint/layout of rich subtrees) directly. Node count unchanged → not a memory fix |
| CSS-Tricks / chat-UI `column-reverse` bottom-glue | Keep newest glued to bottom | — | column-reverse rewrite | Current 140px-near-bottom stick already works; a CSS-direction rewrite would churn scroll math for no gain |
| VS Code webview perf guidance (microsoft/vscode-discussions #503; mattbierner webview-web notes) | Keep DOM lean, lazy offscreen, dispose listeners | "lean DOM + lazy offscreen" principle | — | Validates content-visibility over a JS virtualization engine; reinforces the existing lazy mermaid/katex split |
| Existing code (`ActivityPanel.ts:10`) | The actual current bound | `MAX_ITEMS=600` host cap is the real DOM ceiling, not 16k | — | Reframes "virtualization": DOM is already ~600-bounded; the gap is (a) paint cost of 600 rich items and (b) the SILENT drop of older items |

**Codex debate** (decision-grade, anti-confirmation-bias): `.agent0/.runtime-state/codex-exec/20260620T211851Z-debate-task-activity-view-virtualization-tier-2/last-message.md`. Consensus: ship `content-visibility:auto` first (not measured virtualization), make the 600-cap visible, search client-side over the loaded window, cost only from transcript-provided fields, ship image lightbox. EDH risk flagged: async mermaid/katex height changes vs `contain-intrinsic-size`.
