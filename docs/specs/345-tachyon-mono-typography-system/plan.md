# 345 — tachyon-mono-typography-system — plan

_Drafted from `spec.md` on 2026-07-03. The approach, not the steps (those go in `tasks.md`)._

## Approach

Build a shared Tachyon typography layer in the webview design system, then migrate panels to consume it instead of choosing fonts locally.

The implementation should vendor one open-license monospaced family, expose it through `@font-face`, route Tachyon webview text through semantic CSS variables/classes, and package the font assets with the VSIX. The visual goal is mono-first rather than mono-only: stronger mono titles, compact mono section labels, subdued mono metadata, sharp mono ids, denser mono raw/tool output, and a separate reading role for long task bodies and rich editors when prose readability would suffer.

The size scale should keep using VS Code's configured font-size as its baseline. The typography system owns family, role weights, line-height, and composition; it should not silently reset accessibility/user size preferences back to a hardcoded pixel value.

Use `--tachyon-font-reading` as the canonical reading role. In v1 it is reserved for Task Detail body text, Task Studio rich editor prose, Pin/Task rich document previews with paragraph-heavy content, and Activity/agent-message markdown bodies with long prose. Operational UI remains on Tachyon mono.

Native VS Code UI stays outside the implementation boundary. The extension can style its webviews, but it cannot reliably restyle VS Code's own title bars, menus, tabs, command palette, status bar, or the integrated terminal.

## Key decisions

- **Bundle the font instead of relying on host install** — chosen because the user may not know or have the screenshot font installed; rejected "use local font name only" because installed VSIX output would vary by machine.
- **Recommend JetBrains Mono for v1** — chosen because it is free, readable at small sizes, familiar in developer tools, and has useful weights; keep IBM Plex Mono, Cascadia Code, and Geist Mono as fallback candidates if license, size, or rendering tests fail.
- **Use semantic typography tokens** — chosen because the desired look comes from weight, spacing, hierarchy, and density; rejected a single global `font-family` edit because it would not create the screenshot-like composition.
- **Use mono-first instead of mono-only** — chosen because Tachyon needs a strong operational identity without making long task bodies and rich editors tiring to read; rejected forcing mono everywhere because prose-heavy surfaces can become dense and wrap poorly.
- **Treat native VS Code chrome as out of scope** — chosen because those surfaces are owned by VS Code, not Tachyon webview CSS.
- **Allow only positive tracking for labels** — chosen because compact uppercase labels benefit from it; rejected negative tracking because project design guidance forbids it and it can harm readability.

## Files touched

- `src/webview/shared/design-system.css` — add `@font-face`, font stack, role tokens, and shared text utility classes while preserving the `--vscode-font-size` baseline.
- `src/webview/shared/tailwind-theme.css` — map Tailwind font tokens to Tachyon mono and expose a reading token backed by `--tachyon-font-reading` so Tailwind-opted surfaces do not bypass the design system.
- `src/webview/shared/shell.ts` — verify existing CSP/local resource handling supports font loads; current `font-src` is expected to be sufficient unless testing proves otherwise.
- `esbuild.mjs` and packaging config — follow the existing KaTeX font-copy precedent so Tachyon font files land in `dist/webview/fonts/tachyon` and are included in the VSIX.
- `src/webview/**/**/*.css` — migrate the small set of direct VS Code font-family usages to Tachyon typography tokens.
- `test/unit/**` or equivalent static tests — guard CSS/token/package behavior where feasible.
- Font license/source file near the vendored assets — document source URL, license, and bundled weights.

## Risks & unknowns

- Font asset path may work in dev but fail in packaged VSIX if copied outside webview local resource roots or mixed into the shared `dist/webview/fonts` directory owned by KaTeX/Excalidraw.
- A variable font may increase bundle complexity or behave differently across VS Code/Electron versions.
- A full mono UI can become heavy if titles, body, metadata, and long-form prose are not tuned separately.
- A reading role can weaken the console identity if applied too broadly; it should be reserved for prose-heavy task bodies, rich editors, and document-like previews.
- Mono text is wider than proportional text; the highest-risk surface is the sidebar at narrow widths.
- Some existing content may rely on VS Code editor font metrics; migrating it can change wrapping in dense panels.
- Direct CSS scans can miss inline styles or component-level `style={{ fontFamily: ... }}` usage.

## Visual impact

Every Tachyon webview should visibly shift to a mono console identity while preserving prose readability. Expected changes: denser rhythm, clearer ids/metadata alignment, less visual mismatch between cards and raw output, stronger section labeling, and more comfortable reading/editing in long task bodies.

Visual QA must capture installed-extension screenshots for Sidebar, Mission Control, Plugins, Task Detail, Task Studio or Pin Studio, and Activity. The review should check readability at normal VS Code sidebar widths and at minimum practical sidebar width, card wrapping, badge legibility, button/input text fit, whether operational UI still carries the mono identity, and whether prose-heavy surfaces remain comfortable.

## Sources consulted

- `src/webview/shared/design-system.css` — current `--ds-mono`, body font, inputs, select trigger, and shared utilities.
- `src/webview/shared/tailwind-theme.css` — Tailwind v4 shared theme mapping used by Plugins, UI Gate, and Task Studio.
- `src/webview/shared/shell.ts` — webview CSP includes `font-src` and shared stylesheet injection.
- `src/webview/sidebar/SidebarPrototype.ts` — webview local resource root points at built webview assets.
- `esbuild.mjs` — KaTeX and Excalidraw already copy CSS-referenced fonts into `dist/webview/fonts`; Tachyon fonts should use a dedicated `dist/webview/fonts/tachyon` subdirectory.
- `.vscodeignore` — `dist/webview/**` is already included in packaged VSIX output.
- `docs/specs/252-webview-design-system/tasks.md` — existing design-system direction.
- `docs/specs/342-vendored-ui-components/spec.md` — related component consistency work.
