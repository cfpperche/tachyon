# Spec 252 — tasks (build order)

One webview migrated per step, each screenshotted under a dark AND a light theme before the next (D3). No behavior change; keep tsc ×2 + engine-boundary + the suite green throughout.

**Verify:** `npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit && bash scripts/check-engine-boundary.sh && node esbuild.mjs && env -u TMUX npx vitest run`

## Steps

- [x] **Step 1 — the shared layer.** Author `src/webview/shared/design-system.css` (tokens + type/spacing scale + base components, all theme-driven per D4); copy it to `dist/webview/` in `esbuild.mjs` (like `codicon.css`); add a tiny helper to compute the `<link>` href via `asWebviewUri`. No panel migrated yet — just the layer + a standalone render proving the tokens under dark + light.
- [x] **Step 2 — Plugins** (already closest to the target). Migrated `PluginsPanel.ts` + `plugins/App.tsx` to `.ds-*`; dropped the bespoke `:root` tokens + reset + shared components (deltas now reference `--ds-*`). Built the dark+light render harness (`scripts/screenshots/ds/`) and verified both themes. tsc ×2 + engine-boundary + esbuild + 1229 tests green.
- [x] **Step 3 — Handoff** (`HandoffPanel.ts` + `handoff/App.tsx`). Title → `.ds-title` (14→16px per D1), staleness badge → `.ds-badge`, actions → `.ds-btn`; dropped redefined tokens/reset; markdown body (`.md`) kept as a panel delta on `--ds-*`. Verified dark+light (the harness `</script>`-in-bundle double-mount + the 2× device-scale tiling ghost were fixed). 1229 tests green.
- [x] **Step 4 — Server Inspector** (`ServerInspector.ts`). Linked the system; `<h2>` → `.ds-title` (was browser-default ~19px → 16px), `.sub` → `.ds-sub`, every button → `.ds-btn` (dropped the bespoke secondary-button block), empty → `.ds-empty`; the filled live/dead/crashed status pill stays a deliberate panel delta (rewired off `--ds-ok/--ds-err/--ds-muted`, dropping `#2ea043/#f14c4c/#d7ba7d`). Harness gained a static-fragment mode for vanilla-JS panels. Verified dark+light. 1229 tests green.
- [x] **Step 5 — Agent Studio form** (`AgentForm.ts`). Linked the system; tabs → `.ds-tabs`/`.ds-tab` (+ `.locked` delta), `<h2>` → `.ds-title` (16px), `label.section` → `.ds-section`, footer buttons → `.ds-btn`/`.ds-btn-primary`, form inputs/textarea rewired to mirror `.ds-input`; chips/checks/details/errors kept as deltas on `--ds-*` (dropped `--vscode-button-secondary*`/`input-border` raws). JS toggles are id-based so no class-selector breakage. Verified dark+light. 1229 tests green.
- [x] **Step 6 — Activity** (`ActivityPanel.ts` + `activity/App.tsx`) — the largest. Linked the system; dropped the redefined `:root` (`--muted/--border/--focus/--ok/--err/--link`) + reset, rewiring ~50 references onto `--ds-*`; `<h1>` → `.ds-title` (16px). The whole feed/markdown/hljs/math/diff CSS stays a deliberate panel delta (per the spec). Verified dark+light. 1229 tests green.
- [x] **Step 7 — Sidebar** (`SidebarPrototype.ts`) — dense. Linked the system; reduced the redefined `:root` to ONLY the genuinely sidebar-specific tokens (`--hover`/`--sel` list backgrounds + `--idle` status grey), rewiring `--muted/--border/--focus/--ok/--warn/--err` (~60 refs) onto `--ds-*`. Kept all the dense row/tab/badge/status-dot deltas (no hero title → D1 N/A). Override: `body` background pinned to `--vscode-sideBar-background` (the design system's `body` defaults to the editor surface). Verified dark+light. 1229 tests green.

## Closure
_(filled at ship)_
