# 405 — pi-native-fork — specification

_Created 2026-07-18._

**Status:** shipped-partial

**Closure:** Exact positively-owned native Pi Fork shipped in `ee97ff02`; automated/human dogfood closure landed in `1e7f42e9` with Dev Host proof at `397cea17`. SDD 408 commit `97c2c215` temporarily refuses a simultaneous live Pi sibling for OAuth safety; follow-up `t-a1da29` restores live Fork after upstream shared-auth support.

## Intent

Make Tachyon's existing **Fork session** action first-class for managed Pi agents. A fork must start a distinct Pi session containing the source's current active branch while preserving the source session unchanged, private-home isolation, Bridge projection, cwd/worktree policy, and exact Resume authority.

Pi's native `--fork <path|id>` is the transport. Tachyon must target an exact positively-owned source transcript and mint the fork's destination UUID; it must never select a same-cwd sibling or newest transcript by guess.

## Acceptance criteria

- [x] **Scenario: a managed Pi source becomes forkable only with exact live ownership**
  - **Given** a running managed Pi source with a tracked UUID and a positive `session_start` ownership row
  - **When** Tachyon plans Fork
  - **Then** it resolves exactly one regular no-follow JSONL whose header UUID and canonical cwd match that row
  - **And** missing, stale, malformed, duplicate, symlinked or foreign-cwd ownership refuses before side effects

- [x] **Scenario: Pi Fork creates a distinct native session**
  - **Given** source session A has completed conversation context
  - **When** Fork commits
  - **Then** Pi launches with a fresh Tachyon UUID B and `--fork <exact canonical A path>`
  - **And** B's header records its own UUID/cwd and parent session A
  - **And** B contains A's active-branch context without appending to A

- [x] **Scenario: private home and Bridge remain isolated**
  - **When** Pi A forks to sibling B
  - **Then** B receives its own mode-0700 private home/session directory and copied credentials
  - **And** A's home is neither reused nor mutated
  - **And** the immutable Pi extension and authenticated Bridge environment are wired for B

- [x] **Scenario: Fork and Resume authorities stay independent**
  - **Given** B was created from A
  - **When** A or B is stopped and resumed
  - **Then** A resumes UUID A and B resumes UUID B from their respective private homes
  - **And** neither resolver guesses from the other agent's transcript

- [x] **Scenario: existing Fork governance is preserved**
  - **Then** stale-plan re-resolution, max-agent gating, worktree quarantine, model preflight, token compensation, unique sibling naming, persistent fork metadata and ordinary non-Pi Fork behavior remain intact

## Scope boundaries

- This is Tachyon's sibling-session Fork at the current active branch, matching the existing Claude/Grok product action. It is not Pi's interactive prior-user-message selector (`/fork`) or in-file `/tree` navigation.
- Fork requires a live source and positive Pi extension ownership. No terminal scraping, newest-file fallback or cross-home scan is allowed.
- Pi's private home remains mandatory; configurable inheritance of executable Pi packages/extensions/skills/prompts/themes is outside this SDD.
- Fork does not merge worktrees or copy dirty changes. Existing Tachyon worktree Fork policy remains authoritative.
