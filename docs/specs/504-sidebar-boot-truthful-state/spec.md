# 504 — truthful sidebar boot state

_Created 2026-08-13 from t-bb152a._

**Status:** draft

## Intent

The sidebar currently treats an empty fleet array as proof that no Tachyon workspace exists. During
window boot that array also means that the extension has not attached to the engine or delivered its
first fleet yet. The retained webview therefore says “No Tachyon workspace” and offers Initialize
Tachyon while a configured workspace is starting.

Make discovery explicit: unknown, configured-and-starting, ready, confirmed-unconfigured, delayed,
and failed are distinct observable states. The empty welcome remains reachable, but only after the
host has checked every open folder and confirmed that none has `tachyon.yml`.

## Acceptance criteria

- [ ] **Scenario: configured workspace is still attaching**
  - **Given** at least one open folder has a Tachyon configuration
  - **When** the shell has discovered it but no first fleet is available
  - **Then** the sidebar says that Tachyon is starting and never offers Initialize Tachyon
- [ ] **Scenario: absence is confirmed**
  - **Given** the shell has checked all open folders and none has a Tachyon configuration
  - **When** the sidebar receives that discovery result
  - **Then** the existing no-workspace explanation and Initialize Tachyon action are shown
- [ ] **Scenario: startup exceeds its ordinary envelope**
  - **Given** a configured workspace is still attaching after 5 seconds
  - **When** no failure has been reported
  - **Then** the sidebar names that startup is taking longer than usual and offers a diagnostic path, without claiming failure
- [ ] **Scenario: startup fails**
  - **Given** a configured workspace was discovered
  - **When** engine attach or initial fleet loading fails
  - **Then** the sidebar names the workspace and failure, offers Retry and the existing Output diagnostic path, and does not fall back to the no-workspace welcome
- [ ] **Scenario: startup completes**
  - **Given** a configured workspace is starting, delayed, or being retried
  - **When** its first fleet arrives
  - **Then** the normal fleet replaces the transient state with no manual dismissal
- [ ] The protocol carries facts or named phases, never an invented percentage.
- [ ] Multi-root projection can represent configured folders still starting, ready folders, failed folders, and confirmed-unconfigured folders without collapsing the whole window to one boolean.
- [ ] Actor × trigger coverage names Interface opening/revealing the view, Agent-triggered refresh, and Tachyon activation, reload, folder add/remove, engine restart/upgrade, reconnect, and crash recovery.

## Non-goals

- Shortening engine startup unless a separate implementation task measures a dominant avoidable phase.
- Adding a status-bar item; the measured defect is contained in the already-visible sidebar.
- Showing fake fleet rows, progress percentages, or an indefinite “Starting…” state.
- Implementing this plan in t-bb152a.

## Open questions

- The 5-second delayed threshold is a first implementation value: validate it against a larger sample
  before shipping. The three configured reloads available on 2026-08-13 completed extension
  activation in 1.666 s, 2.875 s, and 3.479 s.
- Exact localized copy should be judged with the real sidebar at 880 px and 360 px during the
  implementation task.
