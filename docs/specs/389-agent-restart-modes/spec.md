# 389 — agent-restart-modes

_Created 2026-07-16._

**Status:** shipped

**Branch:** `grok/agent-restart-modes`

**Closure:** Shipped 2026-07-16 — restart matrix stop×session; Bridge defaults graceful+resume; UI one-click Restart=force+resume + overflow new/force-new (no QuickPick); clearStopping on resume; terminal attach socket fix for Dev Host; headless dogfood + maintainer EDH approve.

## Intent

`restart_agent` / UI Restart were a single path: hard process replace + fresh session. Operators need:

1. **How to stop** — graceful vs force  
2. **How to come back** — resume conversation vs new section  

Bridge product default: **graceful + resume** (fallback new). UI one-click Restart: **force + resume** (no stopping badge). Crash/watch stay **force + new**.

## Acceptance criteria

- [x] **Scenario: Bridge restart modes**
  - **Given** `restart_agent` with optional `stop` / `session`
  - **When** called with defaults or explicit modes
  - **Then** graceful|force × resume|new run; resume falls back to new when unavailable
- [x] **Scenario: force + new section**
  - **Given** a running agent
  - **When** `stop=force` `session=new`
  - **Then** immediate process replace, fresh session
- [x] **Scenario: force + resume**
  - **Given** a running resumable agent
  - **When** `stop=force` `session=resume`
  - **Then** hard-replace onto resume command (or fallback new)
- [x] **Scenario: graceful + new + timeout force-fallback**
  - **Given** a process that ignores graceful stop
  - **When** graceful restart
  - **Then** after timeout, session-only hard kill (no ad-hoc wipe) then start
- [x] **Scenario: crash / watch restart unchanged**
  - **Given** on-crash or file-watch restart
  - **Then** force + new
- [x] **Scenario: UI without QuickPick**
  - **Given** sidebar ⋯
  - **Then** Restart (force+resume), Restart new section, Force restart (new section)
- [x] **Scenario: no stuck "stopping" after Restart**
  - **Given** Restart while pane open
  - **Then** row returns running; not stuck on stopping/stop-failed
- [x] Bridge + engine wire accept optional stop/session
- [x] Headless dogfood green; maintainer EDH approve

## Non-goals

- Changing Stop / Kill standalone semantics
- Auto-resume policy for crash loops beyond force+new
- Per-runtime custom graceful timeouts in v1

## Open questions

None.
