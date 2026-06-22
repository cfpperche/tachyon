# Design direction — Project Handoff editor webview (spec 245, Increment D)

**UI impact:** ui (a new editor-area webview panel + a sidebar button). Done-proof: `browser_renderable: no`
(VS Code webview) → pure view-model logic is unit-tested; the visual surface is **EDH/prod-validated by the user**
(the same gate as spec 242), labeled NOT a headless UI-test proof.

## Feel
Reuse Tachyon's existing webview language verbatim — it IS the design system. VS Code theme variables for every
color (so it tracks the user's theme), codicon glyphs (already bundled), the Activity panel's spacing/typography.
The panel reads like a calm, curated document, not a dashboard: a compact header, the handoff body as clean
markdown, the pending notes as a quiet secondary list. No new tokens, no imagery, no motion.

## Surfaces (the agreed layout)
- **Header row:** `◆ Project Handoff — <folder>` · a **staleness badge** (text + glyph, never color-only):
  `○ Fresh` · `◆ Needs distill · N` · `◷ Possibly stale` · `✗ Old` · actions `⤓ Open` (opens the `.md`) + `↻ Refresh`.
- **Metadata subline:** `updated <relative> · by <human|agent|tachyon> · revision <short>`.
- **Body:** the canonical handoff rendered via `renderMarkdownHtml`. Cold-start empty state: a short hint +
  `Open` (which creates the file from the 4-section template) when none exists.
- **Pending notes (`Pending notes · N`):** append-only list, each row = a kind glyph
  (✓ completed · ⊘ blocked · ◆ decision · ⚠ gotcha · → next) + agent + relative age + summary + dimmed evidence.
  Empty → "no pending notes". Read-only.

## Tokens (reused — proposing nothing)
- Colors: `--vscode-foreground`, `--vscode-descriptionForeground` (sublines/dim), `--vscode-panel-border`
  (separators), `--vscode-button-*` (actions), `--vscode-textLink-foreground` (links), the editor bg.
- Staleness accent: map to existing semantic vars — Fresh→descriptionForeground, Needs distill→`--vscode-charts-yellow`/notificationsWarningIcon, Possibly stale→`--vscode-charts-blue`, Old→`--vscode-errorForeground`. Glyph carries meaning if a var is absent.
- Type/space: inherit the Activity panel's base font + paddings.

## Pure, testable view-model (the CI-covered part)
`stalenessLabel(state) → {glyph,label}`, `noteGlyph(kind)`, `relativeTime(iso, now)`, and the host→webview
message assembler (snapshot + notes → the view-model). These are pure → unit-tested (the "logic in the vscode
layer escapes CI" lesson, spec 240). The Preact render + the panel host plumbing are thin and EDH-validated.

## Stop criteria (craft loop)
Stop when: the panel renders the four header states + body markdown + the notes list, reuses only `--vscode-*`
tokens + codicons (no new assets), the pure view-model is green in CI, and tsc + build + engine-boundary pass.
Max 4 refine iterations; the user's EDH look is the visual sign-off.
