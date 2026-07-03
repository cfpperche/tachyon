# 345 — tachyon-mono-typography-system

_Created 2026-07-03._

**Status:** in-progress
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

Tachyon's webviews currently inherit VS Code UI/editor fonts in inconsistent ways. Some surfaces use the VS Code UI font, some raw/code fragments use the editor font, and individual panels still make local font decisions. The product direction is to make Tachyon feel like a focused agent-ops console: a bundled monospaced type family used deliberately across hierarchy, metadata, cards, badges, ids, forms, logs, and raw output.

This is not only a `font-family` swap. The deliverable is a small typography system: a Tachyon mono-first identity plus semantic roles for weight, size, opacity, line-height, limited positive tracking, and long-form reading/editing. Mono should dominate operational UI, but long prose surfaces must remain comfortable to read and write.

The canonical long-form role is `--tachyon-font-reading`. In v1 it applies to Task Detail body text, Task Studio rich editor prose, Pin/Task rich document previews when they render paragraph-heavy content, and Activity/agent-message markdown bodies that contain long prose. It does not apply to ids, badges, labels, toolbar controls, raw tool output, code blocks, logs, compact cards, or metadata.

## Acceptance criteria

- [ ] **Scenario: bundled mono renders offline**
  - **Given** a machine that does not have the chosen Tachyon font installed locally
  - **When** the packaged VSIX is installed and Sidebar, Mission Control, Plugins, Task Studio, and Activity are opened
  - **Then** Tachyon webview text renders with the bundled Tachyon mono family rather than falling back to VS Code's UI font.
- [ ] **Scenario: typography is role-based**
  - **Given** a Tachyon webview with titles, section labels, cards, badges, ids, metadata, inputs, and raw/code output
  - **When** the surface is rendered
  - **Then** each text role uses a documented typography token for family, weight, size, line-height, and optional positive tracking instead of ad hoc panel-local font styling.
- [ ] **Scenario: mono-first, not mono-only**
  - **Given** text appears at different hierarchy levels
  - **When** titles, metadata, badges, ids, cards, controls, raw output, task bodies, and rich editors are compared
  - **Then** operational UI uses the Tachyon mono family, while long-form reading/editing uses a documented reading role that prioritizes readability.
- [ ] **Scenario: long prose stays readable**
  - **Given** a task detail body or rich task editor contains multiple paragraphs of prose
  - **When** the surface is rendered at normal and narrow widths
  - **Then** the text uses the `--tachyon-font-reading` typography role with comfortable line-height, wrapping, and weight, and it is not forced into dense mono styling unless visual QA proves it remains readable.
- [ ] **Scenario: native VS Code chrome is not promised**
  - **Given** VS Code native UI such as view title bars, tab labels, native menus, command palette, tooltips, and the status bar
  - **When** Tachyon is installed
  - **Then** this spec does not claim control over those native VS Code surfaces.
- [ ] **Scenario: packaged font assets load under CSP**
  - **Given** the extension is built and packaged
  - **When** a Tachyon webview loads its shared CSS
  - **Then** required font files are present under `dist/webview/fonts/tachyon`, are addressable via webview resource URIs, and are allowed by the webview CSP.
- [ ] **Scenario: fallback is explicit**
  - **Given** a font load failure or future font replacement
  - **When** the CSS falls through
  - **Then** the fallback stack is explicit, readable, and still monospaced.
- [ ] Font licensing and source are documented before shipping; no proprietary or unclear-license font is bundled.
- [ ] The default recommended family for v1 is **JetBrains Mono** unless implementation-time license, size, or rendering checks reveal a better free alternative.
- [ ] No negative `letter-spacing` is introduced. Positive tracking is allowed only for deliberate label/metadata roles.
- [ ] Font sizes are tokenized, do not scale with viewport width, and remain anchored to VS Code's configured `--vscode-font-size` baseline so low-vision/user font-size preferences are preserved.
- [ ] Existing direct uses of `var(--vscode-font-family)` and `var(--vscode-editor-font-family)` inside Tachyon webviews are removed or justified as intentional exceptions.
- [ ] Tailwind-opted surfaces use the same Tachyon typography system through `src/webview/shared/tailwind-theme.css` by mapping Tailwind font tokens such as `--font-sans`, `--font-mono`, and a canonical reading token backed by `--tachyon-font-reading`.
- [ ] Visual QA evidence covers at least Sidebar, Mission Control, Plugins, Task Studio or Pin Studio, and Activity with raw/tool output at both normal width and minimum practical sidebar width.

## Non-goals

- Changing VS Code native chrome, native toolbar icons, native tabs, native menus, command palette, or terminal UI.
- Changing tmux/agent terminal font rendering.
- Redesigning the color palette or spacing scale beyond what typography needs.
- Adding a per-user font picker in v1.
- Bundling multiple decorative font families.
- Making every markdown/document surface behave like a code editor. Long-form reading/editing is allowed to use a separate reading role when that is more readable than mono.

## Open questions

- **Exact font file set:** use JetBrains Mono static WOFF2 weights or a variable WOFF2 file? Resolve during implementation by checking package size, browser support, and rendering in VS Code webviews.
- **Reading role font:** should long-form task bodies and rich editors use tuned JetBrains Mono, VS Code's configured UI font, or a bundled readable sans? Resolve with side-by-side visual QA on Task Detail and Task Studio before implementation.
- **User override later:** should a future setting allow "Tachyon bundled mono" vs "follow VS Code font"? Out of scope for v1, but worth tracking after dogfood.
