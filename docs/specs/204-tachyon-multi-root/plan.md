# 204 — tachyon-multi-root — plan

_Drafted 2026-06-10 (5 phases agreed in session)._

## Approach

Phase 1 (the bulk): extract `src/workspace/Workspace.ts` — everything one folder
runs (config, manager, terminals, Bridge, monitors, waiters, runners, F20 engine,
pins, watchers, per-workspace ticker) with `create()`/`dispose()`; view refreshes
flow through an injected `onViewsChanged` callback. Gate: single-root integration
suite passes untouched. Phases 2-4: extension.ts becomes a registry (Map folder →
Workspace) + `onDidChangeWorkspaceFolders`; Sidebar providers read `() => Workspace[]`
(folder roots only when >1; items carry `ws`); commands resolve their target via
item.ws / optional wsHash arg / folder QuickPick; status bar aggregates. Phase 5:
two-folder .code-workspace fixture + dedicated host suite (@vscode/test-cli
multi-config), dogfood second folder.

## Files to touch

**Create:** `src/workspace/Workspace.ts`, `src/workspace/notify.ts`, `test/fixtures/multiroot/*`, `test/integration-multiroot/multiroot.test.js`
**Modify:** `src/extension.ts` (thin registry), `src/presentation/Sidebar.ts` (workspace-list providers), `.vscode-test.mjs` (two labels), l10n, 0.4.4

## Alternatives considered

### One shared Bridge multiplexing folders
Would change tool schemas (folder param everywhere) and break agent env assumptions. Each folder keeps its derived port/token — registrations stay stable.

### One shared F20 engine for all folders
The dead-map is server-wide so one client could serve all, but the executor seam is per-TmuxService/folder; N small clients (realistically 2-3) beat multiplexing complexity.

## Risks and unknowns

- Biggest refactor since v1 over stable code — mitigated by the phase-1 gate (suite untouched).
- Tests/automation pass plain objects to item commands — handlers resolve `item.ws ?? single` (kept working, pinned by the suite).

## Research / citations

- VSCode API: workspace.workspaceFolders / onDidChangeWorkspaceFolders; @vscode/test-cli multi-config labels.
