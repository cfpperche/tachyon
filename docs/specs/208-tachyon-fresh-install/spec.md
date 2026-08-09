# 208 — tachyon-fresh-install

_Created 2026-06-11._

**Status:** shipped

**Closure:** 2026-06-11 — unit 211/211, xvfb 22 single-root (hot path unchanged) + 6 multi-root; native walkthrough auto-opens on install; lazy activation verified (no Bridge/tmux on a look-only folder); 0.6.6; residual: none
**Verify:** `bash -c 'cd packages/tachyon && npx vitest run --reporter=dot 2>&1 | tail -3'`

**UI impact:** render
<!-- A native Getting-Started walkthrough + a viewsWelcome that now actually shows; both verified manually + by the regression suite. -->

## Intent

F24: the fresh-install experience. A user installing from the marketplace got (a) a
Bridge + tmux server booted on a folder they only opened to look at (eager
activation), (b) a viewsWelcome "Initialize" button that never rendered (the Agents
tree always had a Bridge node, so the tree was never empty), and (c) zero onboarding.
Close all three: activate lazily, fix the empty-state, and add a native opt-in
walkthrough.

## Acceptance criteria

- [x] **Scenario: look-only folder stays inert**
  - **Given** a folder with no tachyon.yml
  - **When** the extension is installed / the folder opened / the ⚡ icon clicked
  - **Then** no Bridge port is opened and no tmux server is started; the views show a welcome instead (Workspace boots only on config-at-startup or an explicit create action)

- [x] **Scenario: the welcome appears and guides**
  - **Given** the look-only folder
  - **When** the Agents view is shown
  - **Then** a `viewsWelcome` offers **Initialize Tachyon** (runs `Tachyon: Init`) and **Open the Get Started walkthrough**

- [x] **Scenario: walkthrough auto-opens on install**
  - **Given** a fresh install
  - **Then** the native "Get Started with Tachyon" walkthrough opens (VSCode default), with 5 steps — Check requirements, Initialize, Meet your fleet, Connect a runtime, Coordinate — each with a real screenshot and auto-completion (onCommand/onView/onLink); also reachable via `Tachyon: Get Started`

- [x] **Scenario: create acts as opt-in**
  - **Given** a fresh folder
  - **When** New Agent / a Studio tab / Init is invoked
  - **Then** Tachyon boots that folder on demand (writes config / opens the form), so creating is the opt-in — not merely installing

- [x] `Tachyon: Check Requirements` surfaces the doctor (tmux presence/version + install hint)
- [x] No tool-schema change — 0.6.6 patch

## Non-goals

- A custom onboarding webview — VSCode's native walkthrough is the idiomatic, auto-opening primitive.
- Booting on passive view focus (clicking the icon to look is not opt-in).
