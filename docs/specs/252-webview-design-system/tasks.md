# Spec 252 — tasks (build order)

One webview migrated per step, each screenshotted under a dark AND a light theme before the next (D3). No behavior change; keep tsc ×2 + engine-boundary + the suite green throughout.

**Verify:** `npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit && bash scripts/check-engine-boundary.sh && node esbuild.mjs && env -u TMUX npx vitest run`

## Steps

- [x] **Step 1 — the shared layer.** Author `src/webview/shared/design-system.css` (tokens + type/spacing scale + base components, all theme-driven per D4); copy it to `dist/webview/` in `esbuild.mjs` (like `codicon.css`); add a tiny helper to compute the `<link>` href via `asWebviewUri`. No panel migrated yet — just the layer + a standalone render proving the tokens under dark + light.
- [ ] **Step 2 — Plugins** (already closest to the target). Migrate `PluginsPanel.ts` + `plugins/App.tsx` to `.ds-*`; drop the bespoke tokens/scale; verify dark + light.
- [ ] **Step 3 — Handoff** (`HandoffPanel.ts` + `handoff/App.tsx`).
- [ ] **Step 4 — Server Inspector** (`ServerInspector.ts`).
- [ ] **Step 5 — Agent Studio form** (`AgentForm.ts`).
- [ ] **Step 6 — Activity** (`ActivityPanel.ts` + `activity/App.tsx`) — the largest; markdown/feed-specific CSS stays as a panel delta.
- [ ] **Step 7 — Sidebar** (`SidebarPrototype.ts` + `sidebar/App.tsx`) — dense; keep density deltas but adopt tokens + components.

## Closure
_(filled at ship)_
