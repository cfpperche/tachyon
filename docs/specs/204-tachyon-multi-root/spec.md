# 204 — tachyon-multi-root

_Created 2026-06-10._

**Status:** shipped

**Closure:** 2026-06-10 — unit 188/188 unchanged; xvfb single-root suite 23 passing UNTOUCHED (the refactor gate) + new multi-root host suite 6 passing (two-folder .code-workspace fixture); residual: none

**UI impact:** render
<!-- Folder nodes in all four views with 2+ folders; single-folder rendering byte-identical (gate). -->

## Intent

F9: multi-root workspaces — `activate()` took `workspaceFolders[0]` and a
module-level singleton held all state, so a window with two tachyon.yml folders
orchestrated only the first. The per-folder isolation already existed underneath
(tmux namespace, token, derived port, .tachyon/ files — all wsHash-keyed); this
spec adds the organizational seam: a `Workspace` class owning everything one
folder runs, an extension-level registry, folder-aware views, and disambiguation.

## Acceptance criteria

- [x] **Scenario: refactor gate (phase 1)**
  - **Given** the single-folder integration suite (23 scenarios)
  - **When** the Workspace extraction lands
  - **Then** the suite passes WITHOUT editing any test

- [x] **Scenario: one Workspace per folder**
  - **Given** a .code-workspace with two folders, each with tachyon.yml
  - **When** the extension activates
  - **Then** both register (distinct wsHash, distinct Bridge ports/tokens), autostarts run per folder, agents/commands/pins/layouts are folder-scoped (verified: no cross-folder leakage in listings)

- [x] **Scenario: folders come and go live**
  - **Given** an active window
  - **When** a folder with tachyon.yml is added / removed (`onDidChangeWorkspaceFolders`)
  - **Then** its Workspace is created / disposed (tmux sessions survive removal)

- [x] **Scenario: sidebar grows folder roots only when needed**
  - **Given** one active folder → trees render exactly as before
  - **When** 2+ folders are active
  - **Then** each view gains 📁 folder roots; every item carries its Workspace; attention badge sums across folders; status bar shows ×N with per-folder tooltip

- [x] **Scenario: command disambiguation**
  - **Given** 2+ folders
  - **When** a palette command needs a target (Studio, Restart Agent, Apply Layout, New Agent, pins…)
  - **Then** a folder QuickPick comes first; tree-item commands act on the item's own folder; internal seams accept an optional wsHash arg

- [x] Each folder gets its own F20 engine (anchor `tachyon-ctl-<hash>`); both Bridges enforce auth independently (verified live)
- [x] No Bridge/tool change — 0.4.4 patch

## Non-goals

- A folder gaining tachyon.yml AFTER activation is picked up on window reload (no global config-file watcher in v1).
- Cross-folder agent operations (moving agents between folders).
- Repo-split concerns (F5/F7/F8) — unchanged.
