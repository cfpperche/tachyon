# 345 — tachyon-mono-typography-system — tasks

_Generated from `plan.md` on 2026-07-03. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Pick the v1 font file strategy: JetBrains Mono static WOFF2 weights or variable WOFF2, with license and source documented.
- [x] Add font assets under the chosen source location and wire the build using the existing KaTeX-style copy path so they land in `dist/webview/fonts/tachyon`.
- [x] Add `@font-face` declarations and Tachyon typography variables in `src/webview/shared/design-system.css`, preserving the current `--vscode-font-size` baseline.
- [x] Map Tailwind `--font-sans`, `--font-mono`, and a canonical reading token backed by `--tachyon-font-reading` in `src/webview/shared/tailwind-theme.css` so Plugins, UI Gate, and Task Studio inherit the Tachyon typography system.
- [x] Define role-level utilities/tokens for title, section label, metadata, ids, badges, controls, raw/code output, and long-form reading/editing.
- [x] Migrate webview CSS away from direct `var(--vscode-font-family)` / `var(--vscode-editor-font-family)` usage unless the exception is documented.
- [x] Verify webview CSP/local resource handling loads the bundled font in dev and packaged VSIX.
- [x] Add static/package tests or guards for font asset presence and forbidden direct font usage where practical.
- [x] Add a static guard, where practical, that `--tachyon-font-reading` exists and is referenced by Task Studio's long-form editor styling.
- [x] Run side-by-side visual checks for Task Detail and Task Studio comparing tuned mono reading vs VS Code/system reading font before locking the reading role.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Build and typecheck pass.
- [x] Packaged VSIX contains the font files; installed-extension dogfood remains the human follow-up below.
- [x] Tailwind surfaces visibly use the same Tachyon typography system as design-system surfaces, including the reading role where applicable.
- [x] Static scan shows remaining direct VS Code font usages are intentional exceptions.
- [x] Visual QA evidence covers Sidebar, Plugins, Task Detail, Task Studio, and Activity raw/tool output, including narrow-sidebar fit and long-prose readability. Mission Control preview evidence is pending because the preview catalog does not expose that route yet.
- [x] Font license/source documentation is present beside the vendored assets.

**Headless check:** `npm run typecheck && npm run build`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->
**Verify:** `npm run typecheck && npm run build`

## Dogfood

**Dogfood-Opt-Out:** the core acceptance is visual installed-extension rendering; headless checks can verify packaging and CSS, but not whether the typography feels correct in VS Code.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** pending maintainer install of `tachyon-0.55.12.vsix`. Open Sidebar, Mission Control, Plugins, Task Detail, Task Studio or Pin Studio, and Activity; confirm operational UI uses Tachyon mono with readable weights and no clipped labels/buttons, while long task bodies/editors remain comfortable to read. Repeat the Sidebar check at minimum practical width.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

- [x] Evidence: preview screenshots captured under `/tmp/tachyon-spec345-visual/`: `sidebar.png`, `sidebar-340.png`, `sidebar-300.png`, `plugins.png`, `task-detail.png`, `task-studio.png`, `activity.png`. Packaged VSIX generated at `/home/goat/tachyon/tachyon-0.55.12.vsix`.
- [x] Verdict: preview shows the operational UI carrying the mono identity and prose-heavy Task Detail/Task Studio/Activity markdown using the reading role. Sidebar is clean at 340px; 300px is below practical width and clips pre-existing compact controls. Mission Control needs installed-extension visual dogfood because it is not currently in the preview catalog.
