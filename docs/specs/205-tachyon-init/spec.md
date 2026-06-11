# 205 — tachyon-init

_Created 2026-06-10._

**Status:** shipped

**Closure:** 2026-06-10 — unit 197/197 (init 9 new incl. 6-stack round-trip), xvfb single-root 21 passing (never-clobber scenario) + multi-root 6; built in ~/tachyon pre-harness with SDD held by hand; residual: none

**UI impact:** render
<!-- A welcome view (viewsWelcome) when a folder has no tachyon.yml; the command writes a file and opens it. -->

## Intent

F5: onboarding. Today a folder with no `tachyon.yml` is inert — the user must
hand-author one to learn the format. `Tachyon: Init` detects the project stack
(by the manifest files present) and writes a sensible, heavily-commented starter
`tachyon.yml`, then opens it for review. Now that Tachyon is a public,
installable extension this is the first-run experience: install → open a project
→ "Initialize Tachyon" → a working config you can run immediately.

## Acceptance criteria

- [x] **Scenario: stack detection generates a starter**
  - **Given** a folder with no `tachyon.yml` and a recognizable manifest (one of: package.json, composer.json, Cargo.toml, go.mod, pyproject.toml/requirements.txt, Gemfile)
  - **When** `Tachyon: Init` runs
  - **Then** a heavily-commented `tachyon.yml` is written with: one AI agent (a detected CLI — claude preferred — autostart), stack-appropriate terminal(s) derived from the manifest, and a shell; the file opens in the editor

- [x] **Scenario: Node scripts become terminals**
  - **Given** a package.json with `scripts.dev` and/or `scripts.test`
  - **When** Init runs
  - **Then** the generated config includes terminals running those scripts (e.g. `npm run dev`, `npm test`), watch-globbed where sensible

- [x] **Scenario: no manifest → minimal but valid**
  - **Given** a folder with no recognized manifest
  - **When** Init runs
  - **Then** a minimal valid starter is written (one agent + a shell) — never an empty/invalid file

- [x] **Scenario: never clobbers**
  - **Given** a `tachyon.yml` already exists
  - **When** Init runs
  - **Then** it refuses and offers to open the existing file instead (no overwrite)

- [x] **Scenario: welcome entry point**
  - **Given** a folder with no `tachyon.yml`
  - **When** the Agents view is shown
  - **Then** a `viewsWelcome` placeholder offers an "Initialize Tachyon" button wired to the command

- [x] Detection + generation is a pure, unit-tested module (files-present + parsed-content → config text); the command is a thin I/O wrapper
- [x] Generated YAML parses clean through the existing config loader (round-trip test)
- [x] Multi-root aware: Init targets the picked folder (folder QuickPick when >1, like other commands)

## Non-goals

- Framework-specific deep templates (e.g. distinct Next vs Remix configs) — light hints only in v1.
- Detecting monorepo sub-projects / workspaces.
- Editing/upgrading an existing tachyon.yml (Init is create-only).
