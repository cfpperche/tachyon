# Spec 297 — panel commands resolve the target workspace (no silent folder[0])

**Status:** in-progress
**Status detail:** DRAFT → implementing.
**Motivated by:** spec 254 (plugin MCP) — MCP is the highest-risk plugin capability (it writes an executable server config), so installing it into the *wrong* folder of a multi-root window must not be possible by accident. This is a **pre-requisite fix** surfaced while building 254.
**UI impact:** flow (a "Which folder?" QuickPick appears when opening the Plugins / Handoff panel in a multi-root window with no explicit folder).

## Problem

In a multi-root VS Code window (≥2 Tachyon folders open), opening the **Plugins panel** silently targets the **first** workspace folder. Both entry points pass no folder identity:
- the Command Palette command `tachyon.openPlugins` (`package.json`), and
- the sidebar `view/title` 🧩 button (`package.json` `view/title`),

both invoke `tachyon.openPlugins(hash?)` with `hash === undefined`, and `PluginsPanelManager.open` then falls back to `getWorkspaces()[0]` (`src/webview/PluginsPanel.ts:70`). The only signal of which folder was chosen is the panel title (`🧩 Plugins — <folder>`), seen only *after* it opens. The user cannot choose, and a plugin (incl. an MCP server, once 254 lands) installs into folder[0]'s `.claude`/`.codex`/`.tachyon` regardless of intent.

This is **inconsistent** with the rest of Tachyon: ~every other folder-scoped command resolves its target through the shared `pickWorkspace()` (`src/extension.ts:65`), which auto-selects the sole folder and shows a **"Which folder?"** QuickPick on ≥2. The Plugins (and Handoff) panel commands are the outliers that skip it — exactly the "per-command logic in the vscode layer diverges from the shared, tested path" failure mode.

The read-only **Handoff panel** (`tachyon.openProjectHandoff`) shares the identical `getWorkspaces()[0]` fallback (`src/webview/HandoffPanel.ts:23`); it is opened *with* a folder hash from the sidebar handoff bar, so its only exposed gap is the no-hash Command-Palette path. It is folded in for consistency (same one-line bug class), with Plugins as the motivating, higher-risk case.

## Goal

Opening a panel command with **no explicit folder** resolves the target through the shared `pickWorkspace()`: 0 folders → the existing honest warning; 1 → that folder; **≥2 → a "Which folder?" QuickPick** before the panel opens. An explicit `hash` (e.g. a future per-folder entry) is still honored verbatim. No silent folder[0]. The panel registry/reveal behavior and the test/programmatic `open(hash?)` contract are unchanged — only the command handlers gain the resolve step, so the fix *reduces* per-command divergence rather than adding new vscode-layer logic.

## Decisions

- **D1 — Resolve in the command handler, reuse `pickWorkspace()`.** `tachyon.openPlugins` / `tachyon.openProjectHandoff` become `async (hash?) => { const ws = hash ? byHash(hash) : await pickWorkspace(); if (ws) panels.open(ws.wsHash); }`. This routes both through the SAME picker the rest of the app uses (the mitigation for the "vscode-layer logic escapes CI" lesson — converge on the shared path, don't fork a new one).
- **D2 — Leave `PluginsPanelManager.open` / `HandoffPanelManager.open` as-is.** They keep accepting `wsHash?` (the `undefined → [0]` fallback stays valid for single-workspace tests / programmatic callers, per the `wsOf` integration-test convention). The command now always passes a concrete hash, so the fallback is no longer the multi-root path.
- **D3 — Scope = the two panel-open commands only.** No change to creation-flow pickers (`pickAgentWorkspace`) or arg-style `targetOf`.

## Acceptance

- [ ] Opening Plugins via the Command Palette or the sidebar 🧩 button in a ≥2-folder window shows a "Which folder?" QuickPick; the chosen folder is the install target (its title + lockfile).
- [ ] With exactly one Tachyon folder, no prompt — it opens for that folder (unchanged).
- [ ] With zero Tachyon folders, the existing "no Tachyon workspace is active" warning fires (no panel).
- [ ] An explicit `hash` argument still opens that exact folder's panel (no prompt).
- [ ] `tachyon.openProjectHandoff` with no hash resolves the same way; opened with a hash (sidebar bar) is unchanged.
- [ ] `tsc` ×2 + engine-boundary + full suite green (no regression; panel `open(hash?)` contract unchanged).
