# POC — Control as visual monolith (Mission tab embeds MC board)

**Status:** landed on `main` (2026-07-16) — merge `f8230f78`  
**Task:** `t-cf6562`  
**Branch / worktree:** removed (`grok/control-mission-monolith-poc`)

## Goal

Control is the **visual monolith** in the editor. Mission Control (the task board) is used **exactly as before** (same Preact board, same engine mutations, same Task Detail / Studio). The product change is **access path** + **sidebar chrome**:

| Before | After |
|--------|--------|
| Sidebar / command → standalone Mission Control panel | Control tab **Mission** / `tachyon.missionControl` → board **inside Control** |
| Sidebar header: MC, Plugins, Control, tmux, refresh, Settings | Sidebar header: **Control only** |

## Stack

- **Control** = Preact (`src/webview/cockpit/*` → `dist/webview/cockpit.js`; also hosts Mission board)
- **Mission Control board** = Preact `mission-control/App` (imported into Control; standalone panel kept for deserialize/fallback)

## Approach (shipped)

1. Import `mission-control/App` into Control when `section === "mission"`.
2. Control host pushes `snapshot` / `taskError` and handles board actions (`updateTask`, `reorderLane`, …).
3. `tachyon.missionControl` opens Control with `section: "mission"`.
4. Sidebar `view/title`: only `tachyon.openControl`.
5. `refreshCockpitMissionBoard()` on task fan-out.

## Dogfood (from monorepo)

```bash
cd /home/goat/tachyon
node esbuild.mjs
# Open Control → tab Mission  OR  command "Mission Control" / "Tachyon: Control"
# Preview: ?view=cockpit&fixture=mission
```

## Non-goals (still open)

- Migrating Approvals / Plugins / Runtime fully into Control (beyond deep-link / summary)
- Killing Task Detail / Studio side panels
- Deleting `MissionControlPanel` entirely
