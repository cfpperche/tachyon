# POC — Control as visual monolith (Mission tab embeds MC board)

**Branch:** `grok/control-mission-monolith-poc`  
**Worktree:** `/home/goat/tachyon-worktrees/control-mission-monolith`  
**Date:** 2026-07-16

## Goal

Control is the **visual monolith** in the editor. Mission Control (the task board) is used **exactly as today** (same Preact board, same engine mutations, same Task Detail / Studio). The only product change is **access path**:

| Before | After (POC) |
|--------|-------------|
| Sidebar / command → standalone Mission Control panel | Sidebar / command / Control tab **Mission** → board **inside Control** |

## Stack fact

- **Control** = Preact (`src/webview/cockpit/*` → `dist/webview/cockpit.js`)
- **Mission Control** = Preact (`src/webview/mission-control/*` → was standalone bundle; board `App` is now also imported into the Control bundle)

## Approach

1. Import `mission-control/App` into Control when `section === "mission"`.
2. Control host pushes the same `snapshot` / `taskError` envelope and handles the same board actions (`updateTask`, `reorderLane`, …).
3. `tachyon.missionControl` and Control “Mission” tab both open Control with `section: "mission"`.
4. Sidebar `view/title`: **only Control** — Mission, Plugins, tmux, Settings, refresh no longer in the sidebar header (Control tabs / palette).
5. Standalone `MissionControlPanelManager` remains in the codebase for deserialize / safety, but the **primary open path** is Control.

## Dogfood

```bash
cd /home/goat/tachyon-worktrees/control-mission-monolith
node esbuild.mjs
# F5 Dev Host or install extension from this worktree
# Open Control → tab Mission  OR  command "Mission Control"
```

## Non-goals (POC)

- Migrating Approvals / Plugins / Runtime into Control
- Killing Task Detail / Studio side panels
- Deleting MissionControlPanel entirely
