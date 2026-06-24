# Spec 252 — webview design system (one consistent look across all panels)

**Status:** SHIPPED 2026-06-24 (all 6 webviews migrated; codex-reviewed; verified dark+light). · **Surface:** a shared `src/webview/shared/design-system.css` (copied to `dist/webview/`, linked by every host `html()`), then a migration of all 6 webviews onto it. · **UI impact:** ui (every Tachyon webview re-skins to one system; no behavior change). · **Verify:** each migrated panel is screenshotted under BOTH a dark and a light VS Code theme to prove it follows the user's theme.

> **Origin.** Tachyon has 6 webviews — the sidebar, the Activity panel, the Project Handoff panel, the Plugins view, the Agent Studio form, and the tmux Server Inspector — each grown with its own `<style>` block (41–221 lines). They redefine the same tokens independently and pick font sizes ad-hoc, so the same conceptual element (a panel title) ranges from 16px to 30px across panels and the spacing/badges/buttons drift. The maintainer wants **one design system** — consistent typography, spacing, and components — that **follows the user's VS Code theme** (light / dark / high-contrast), not a hardcoded look.

## Problem

No shared styling layer. Each host `html()` (and the Preact panels that consume its classes) defines its own `:root` tokens, type scale, and component CSS. Result: visible inconsistency (title 16↔30px, divergent badges/buttons/spacing), duplicated CSS, and hardcoded dark fallbacks that can fight a light theme. Adding a panel means re-inventing the look.

## Goal

A single `design-system.css` defines theme-driven tokens, a fixed type + spacing scale, and base component classes; every webview links it and uses its classes, keeping only genuinely panel-specific deltas. The look is **driven purely by `var(--vscode-*)`** so it adapts to whatever theme the user runs. Same components, same scale, same spacing — everywhere.

## Decisions (agreed with the maintainer)

- **D1 — Panel title = compact 16px** (the Plugins style), `font-weight: 600`. The 28/30px Activity/Handoff "hero" titles come down to 16px. Density over hero.
- **D2 — A shared CSS FILE** (`design-system.css`), copied to `dist/webview/` like `codicon.css` and linked via `asWebviewUri` + `<link>` (CSP already allows `style-src ${webview.cspSource}`). Not a TS string — a real stylesheet, cacheable, one source of truth.
- **D3 — Migrate one webview per step,** each verified by screenshot under a **dark AND a light** theme (proves theme-following) before the next. Order: Plugins (already closest) → Handoff → Server Inspector → Agent Studio → Activity → Sidebar.
- **D4 — Theme-driven tokens, no hardcoded dark fallbacks.** Tokens map to `var(--vscode-*)`; where a fallback is needed it is theme-neutral (e.g. `color-mix` of a vscode var), never a fixed dark hex that breaks light themes.

## The system (proposed — locked at Step 1)

- **Tokens** (`:root`): `--ds-fg`, `--ds-muted`, `--ds-border`, `--ds-focus`, `--ds-link`, `--ds-ok | --ds-warn | --ds-err | --ds-info`, `--ds-card`, `--ds-input-bg | --ds-input-fg`, `--ds-btn-bg | --ds-btn-fg | --ds-btn-hover`, `--ds-hover`, `--ds-mono` — each mapped from a `var(--vscode-*)`.
- **Type scale**: `--ds-title` 16px/600 · `--ds-section` 11px/600 uppercase (the small ALL-CAPS section labels) · `--ds-body` `var(--vscode-font-size)` · `--ds-small` 12px · `--ds-micro` 11px · `--ds-mono` 12px monospace.
- **Spacing**: `--ds-1` 4px · `--ds-2` 8px · `--ds-3` 12px · `--ds-4` 16px · `--ds-5` 24px · `--ds-6` 32px.
- **Components**: `.ds-wrap` (centered max-width content), `.ds-head` (sticky header bar), `.ds-title`, `.ds-sub`, `.ds-badge` (+ `.ok/.warn/.err/.info`), `.ds-btn` / `.ds-btn-primary`, `.ds-card`, `.ds-tabs` / `.ds-tab`, `.ds-input`, `.ds-empty`, `.ds-banner`, `.ds-degrade`, plus reset (body, button, `:focus-visible`).

## Acceptance

- [x] `design-system.css` exists, is copied to `dist/webview/` (esbuild), and is linked by all 6 host `html()`s (Plugins, Handoff, Server Inspector, Agent Studio, Activity, Sidebar).
- [x] Each webview uses the shared tokens + classes; per-panel `<style>` keeps only panel-specific deltas — no re-defined SHARED tokens (the Sidebar keeps only the genuinely sidebar-local `--hover`/`--sel`/`--idle`), no ad-hoc title sizes.
- [x] A panel title is 16px everywhere (`.ds-title`); badges/buttons/cards/inputs share the `.ds-*` look across panels (the Inspector's filled status pill + the sidebar's dense badge are deliberate, documented deltas).
- [x] Every panel renders correctly under a dark AND a light theme — verified via the spec-252 render harness (`scripts/screenshots/ds/`, headless Chrome, both themes); no hardcoded color breaks the light theme (D4).
- [x] No behavior change; `tsc ×2` + `check-engine-boundary.sh` + `esbuild` + the full suite (1229 tests) stay green after every step.
