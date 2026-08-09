# 395 — Control MVP (desktop project sysadmin)

**Status:** landed on `main` (2026-07-16)  
**Product name:** **Control** (UI / `tachyon.openControl`)  
**Product intent:** `t-fe52f0` frente **(1)** — desktop only; **sem** mobile/companion na v1.  
**Merges:**  
- `c3131f50` — Control MVP (desktop project sysadmin shell)  
- `f8230f78` — Control visual monolith (Mission board embedded; sidebar header Control-only)  
**Branches removed:** `grok/engine-bridge-inspector-poc`, `grok/control-mission-monolith-poc`

## Framing (current)

| | |
|--|--|
| **Control** | Editor-area **visual hub / project sysadmin** — health, engines, bridges, **Mission board**, deep-links |
| **Control chrome** | **Top tabs only** — no left rail (VS Code sidebar confusion) |
| **Tab order** | Overview → Engine → Fleet → Approvals → Mission → Worktrees → Deliveries → Runtime → tmux → Plugins → Schedules → Settings |
| **Mission** | Full Mission Control board **embedded** in Control (same Preact App + engine path); `tachyon.missionControl` → Control tab Mission |
| **Sidebar** | Day-to-day agents, spawn, pins; header **`view/title` = Control only** |
| **tmux / Plugins / Settings** | Via Control tabs (or palette); not sidebar header icons |
| **Mobile** | Deferred (t-fe52f0 frente 2) |

Engine was the first module; Mission board is the first **full product surface** hosted inside Control.

## Land checklist

### Shell MVP (2026-07-16)
- [x] Merge `grok/engine-bridge-inspector-poc` → `main`
- [x] Strip developer meta banners / POC copy from production UI
- [x] Focused tests green (cockpit / controlInspector / webviewPreviewRoutes)
- [x] Dev-host pointer cleared; worktree + branch removed
- [x] Journal on `t-fe52f0` (frente 1 shipped; mobile still open)

### Visual monolith Mission (2026-07-16) — `t-cf6562`
- [x] Embed `mission-control/App` in Control Mission tab
- [x] Host snapshot + board actions; `onTasksChanged` refreshes embedded board
- [x] Route `tachyon.missionControl` → Control `section: mission`
- [x] Sidebar header Control-only (no MC / Plugins / tmux / Settings / refresh icons)
- [x] Merge `grok/control-mission-monolith-poc` → `main`; point-clear; worktree + branch removed

## Dev-host preview (from monorepo root)

```bash
cd /home/goat/tachyon
node esbuild.mjs
npx vite-node --script scripts/webview-preview/generate-routes.ts
node scripts/webview-preview/serve.mjs
```

| Fixture | URL |
|---------|-----|
| Overview | http://localhost:5174/scripts/webview-preview/index.html?view=cockpit&fixture=default |
| Engine tab | http://localhost:5174/scripts/webview-preview/index.html?view=cockpit&fixture=engine |
| Empty | http://localhost:5174/scripts/webview-preview/index.html?view=cockpit&fixture=empty |

## F5 Dev Host (optional dogfood)

```bash
cd /home/goat/tachyon
scripts/dev-host/cli.sh seed --fixture sample-workspace
# Run and Debug → "Tachyon: Dev Host" → F5
# Palette / sidebar header: Tachyon: Open Control
```

## Commands / open paths

| Path | How |
|------|-----|
| **Sidebar header** | Only **Control** (`$(dashboard)`) on `view/title` — Mission / Plugins / tmux / Settings / refresh open via Control tabs or command palette |
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
