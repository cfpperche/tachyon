# 395 — Control MVP (desktop project sysadmin)

**Status:** landed on `main` (2026-07-16)  
**Product name:** **Control** (UI / `tachyon.openControl`)  
**Product intent:** `t-fe52f0` frente **(1)** — desktop only; **sem** mobile/companion na v1.  
**Merge:** `c3131f50` — `merge: land Control MVP (desktop project sysadmin)`  
**Branch / worktree:** removed after land (`grok/engine-bridge-inspector-poc`).

## Framing (locked for this POC)

| | |
|--|--|
| **Control** | Editor-area **project sysadmin** — health, engines, bridges, deep-links |
| **Control chrome** | **Top tabs only** — no left rail (VS Code sidebar confusion) |
| **Tab order** | Overview → Engine → Fleet → Approvals → Mission → Worktrees → Deliveries → Runtime → tmux → Plugins → Schedules → Settings |
| **No "soon"** | Every tab is a real page (data table and/or deep-link to existing surface) |
| **Sidebar** | **Unchanged** — day-to-day agents, spawn, pins, fleet work |
| **Mission Control** | Unchanged work board (deep-link only) |
| **tmux Server Inspector** | Unchanged deep tool (deep-link / placeholder tab) |
| **Mobile** | Deferred (t-fe52f0 frente 2) |

Engine/Bridge is the **first module** inside the Control shell (not a forever-standalone product view).

## Land checklist (2026-07-16)

- [x] Merge `grok/engine-bridge-inspector-poc` → `main`
- [x] Strip developer meta banners / POC copy from production UI
- [x] Focused tests green (cockpit / controlInspector / webviewPreviewRoutes)
- [x] Dev-host pointer cleared (`dogfood:dev-host` no fixture)
- [x] Worktree + feature branch removed
- [x] Journal on `t-fe52f0` (frente 1 shipped; mobile still open)

## Dev-host preview (from monorepo root)

```bash
cd /home/goat/tachyon
node esbuild.mjs
npm run preview:webview:catalog
npm run preview:webview
```

| Fixture | URL |
|---------|-----|
| Overview | http://localhost:5174/scripts/webview-preview/index.html?view=cockpit&fixture=default |
| Engine tab | http://localhost:5174/scripts/webview-preview/index.html?view=cockpit&fixture=engine |
| Empty | http://localhost:5174/scripts/webview-preview/index.html?view=cockpit&fixture=empty |

## F5 Dev Host (optional dogfood)

```bash
cd /home/goat/tachyon
npm run dogfood:dev-host -- seed --fixture sample-workspace
# Run and Debug → "Tachyon: Dev Host" → F5
# Palette / sidebar header: Tachyon: Open Control
```

## Commands / open paths

| Path | How |
|------|-----|
| **Sidebar header** | Icon **Control** (`$(dashboard)`) next to Mission Control / Plugins — `view/title` on `tachyonSidebarPrototype` |
| `tachyon.openControl` | Control shell (Overview) — palette + header |
| `tachyon.openCockpit` | Legacy alias → same as openControl (hidden from palette) |
| `tachyon.inspectEngine` | Control on Engine tab |

Product name for MVP: **Control** (not Cockpit in the UI).

## Files

- `src/cockpit/model.ts` — shell model
- `src/cockpit/disk.ts` — managed worktrees / git-deliveries disk reads (no `node:fs` in webview)
- `src/webview/Cockpit.ts` + `src/webview/cockpit/*` — panel + UI
- `src/control-inspector/*` — Engine/Bridge data module (reused)
- `src/extension.ts` — `openControl` + aliases + collect + deep-links
- `package.json` / nls — sidebar nav Control @3
