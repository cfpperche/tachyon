# 395 — Cockpit desktop POC (reframe)

**Branch:** `grok/engine-bridge-inspector-poc`  
**Worktree:** `/home/goat/tachyon-worktrees/engine-bridge-inspector`  
**Product intent:** `t-fe52f0` frente **(1)** Cockpit geral — **sem** mobile/companion na v1.

## Framing (locked for this POC)

| | |
|--|--|
| **Cockpit** | Editor-area **project sysadmin** — health, engines, bridges, deep-links |
| **Cockpit chrome** | **Top tabs only** — no left rail inside the webview (would confuse with VS Code sidebar) |
| **Sidebar** | **Unchanged** — day-to-day agents, spawn, pins, fleet work |
| **Mission Control** | Unchanged work board (deep-link only) |
| **tmux Server Inspector** | Unchanged deep tool (deep-link / placeholder tab) |
| **Mobile** | Deferred (t-fe52f0 frente 2) |

Engine/Bridge is the **first module** inside the Cockpit shell (not a forever-standalone product view).

## Dev-host preview

```bash
cd /home/goat/tachyon-worktrees/engine-bridge-inspector
node esbuild.mjs
npm run preview:webview:catalog
npm run preview:webview
```

| Fixture | URL |
|---------|-----|
| Overview | http://localhost:5174/scripts/webview-preview/index.html?view=cockpit&fixture=default |
| Engine tab | http://localhost:5174/scripts/webview-preview/index.html?view=cockpit&fixture=engine |
| Empty | http://localhost:5174/scripts/webview-preview/index.html?view=cockpit&fixture=empty |

## F5 from monorepo

```bash
cd /home/goat/tachyon
npm run dogfood:dev-host -- point \
  --worktree /home/goat/tachyon-worktrees/engine-bridge-inspector \
  --fixture sample-workspace --spec 395 --slug cockpit
# Run and Debug → "Tachyon: Dev Host" → F5
# EDH: Tachyon: Open Cockpit
```

## Commands

| Command | Opens |
|---------|--------|
| `tachyon.openCockpit` | Cockpit shell (Overview) |
| `tachyon.inspectEngine` | Cockpit on Engine / Bridge section |

## Files

- `src/cockpit/model.ts` — shell model
- `src/webview/Cockpit.ts` + `src/webview/cockpit/*` — panel + UI
- `src/control-inspector/*` — Engine/Bridge data module (reused)
