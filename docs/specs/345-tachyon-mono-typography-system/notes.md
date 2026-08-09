# 345 — tachyon-mono-typography-system — notes

_Created 2026-07-03._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- Initial product direction is "same font, different compositions": use one bundled mono family and express hierarchy through weight, size, line-height, opacity, casing, and limited positive tracking.
- After reviewing Task Detail and Task Studio screenshots, the direction changed from mono-only to mono-first: operational UI should carry the Tachyon mono identity, while long-form reading/editing gets a dedicated reading role.
- JetBrains Mono is the recommended starting point because it is free, readable in developer tooling, and has enough weights for UI hierarchy. Final implementation still needs to verify license text, bundle size, and rendering in VS Code webviews.
- Native VS Code chrome is deliberately out of scope. The user-facing promise should be clear so tab/menu/title-bar text not changing is not treated as a bug.
- Opus review added an accessibility constraint: keep Tachyon font-size tokens anchored to VS Code's configured `--vscode-font-size` rather than replacing the base size with a hardcoded value.
- Opus review added two implementation constraints: put Tachyon-owned font files under `dist/webview/fonts/tachyon` instead of mixing with KaTeX/Excalidraw fonts, and map Tailwind font tokens in `shared/tailwind-theme.css` for Tailwind-opted surfaces.
- Second Opus review accepted mono-first but required a canonical reading token. The spec now uses `--tachyon-font-reading` and scopes it to Task Detail prose, Task Studio rich editor prose, paragraph-heavy Pin/Task previews, and long Activity/agent-message markdown bodies.
- Implementation chose JetBrains Mono static WOFF2 files for weights 400/500/600/700. This avoids variable-font compatibility questions and keeps the shipped font set to the weights actually used by the UI.
- The reading role is implemented as `--tachyon-font-reading: var(--vscode-font-family, ...)`, not as a second bundled font. This preserves readability and user/editor accessibility preferences while operational UI uses the bundled mono identity.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- Following the user's VS Code font setting would preserve local preference but would not produce a stable Tachyon identity. Bundling a font gives repeatable output at the cost of a small VSIX size increase.
- A per-user font picker may be useful later, but including it in v1 would expand settings, fallback behavior, and QA scope before the base typography system is proven.
- Monospaced UI text is wider than proportional UI text, so narrow-sidebar visual QA is a required tradeoff check rather than an optional polish pass.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- Static weights vs variable font remains open until implementation checks package size and rendering support.
- Whether the reading role should use tuned JetBrains Mono, VS Code's UI font, or a bundled readable sans should be decided by side-by-side visual QA, not guessed in the spec.

## Verification log

- 2026-07-03: `npm test -- test/unit/typographySystem.test.ts` — pass (5 tests).
- 2026-07-03: `npm run typecheck` — pass.
- 2026-07-03: `npm run build` — pass; confirmed `dist/webview/fonts/tachyon/{JetBrainsMono-Regular,JetBrainsMono-Medium,JetBrainsMono-SemiBold,JetBrainsMono-Bold}.woff2`, `OFL.txt`, and `README.md`.
- 2026-07-03: `npx --yes @vscode/vsce package --allow-package-secrets --out /home/goat/tachyon/tachyon-0.55.12.vsix` — pass.
- 2026-07-03: `unzip -l tachyon-0.55.12.vsix | rg 'dist/webview/fonts/tachyon|JetBrainsMono|OFL|README'` — pass; VSIX contains all Tachyon font files and license docs.
- 2026-07-03: `npm test -- test/unit/typographySystem.test.ts test/unit/cssOrderSnapshot.test.ts test/unit/webviewPreviewRoutes.test.ts` — pass (22 tests).
- 2026-07-03: `npm test` — pass (169 files, 2293 passed, 3 skipped).

## Visual QA

- 2026-07-03 preview evidence captured with `agent-browser`/Chrome from `node scripts/webview-preview/serve.mjs`: `/tmp/tachyon-spec345-visual/task-detail.png`, `/tmp/tachyon-spec345-visual/task-studio.png`, `/tmp/tachyon-spec345-visual/activity.png`, `/tmp/tachyon-spec345-visual/plugins.png`, `/tmp/tachyon-spec345-visual/sidebar.png`, plus Puppeteer narrow-sidebar captures `/tmp/tachyon-spec345-visual/sidebar-340.png` and `/tmp/tachyon-spec345-visual/sidebar-300.png`.
- Verdict: mono-first identity is visible in operational UI; long prose remains readable via the reading role in Task Detail, Task Studio, and Activity markdown. Plugins renders cleanly with the Tailwind font mapping. Sidebar is clean at 340px. At 300px the existing compact controls start clipping, so 340px is the recorded minimum practical width for this pass. Mission Control remains a human installed-VSIX dogfood surface because the preview catalog does not currently expose it.
