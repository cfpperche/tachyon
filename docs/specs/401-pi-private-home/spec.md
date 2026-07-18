# 401 — pi-private-home

_Created 2026-07-18._

**Status:** in-progress

## Intent

Tachyon-spawned Pi agents currently isolate only their session JSONL directory. Pi still reads and writes the shared `~/.pi/agent` home for authentication, settings, trust, model caches, packages, logs and user resources. Two Pi agents therefore have weaker process-state isolation than Tachyon's private-home runtimes and can race or leak mutable runtime state through the ambient user home.

Make private home the default for every Tachyon-managed Pi runtime process. Tachyon must set Pi's official `PI_CODING_AGENT_DIR` to a real per-agent directory, keep the proven exact-session continuity inside that home, seed only explicit regular JSON configuration snapshots and a mode-0600 credential copy, preserve project `.pi` behavior, and never write into the user's real Pi home. This phase establishes the strongest honest boundary Pi's current CLI supports without pretending copied OAuth credentials have cross-home refresh coordination.

## Acceptance criteria

- [x] **Scenario: every managed Pi receives a private runtime home**
  - **Given** two Tachyon agents whose runtime command is Pi
  - **When** they spawn, restart or resume in the same workspace and cwd
  - **Then** each process receives a distinct workspace-contained `PI_CODING_AGENT_DIR` under `.tachyon/harness/<agent>`, mode `0700`, and neither process uses `~/.pi/agent` as its mutable runtime home
- [x] **Scenario: continuity moves inside the private home**
  - **Given** a Tachyon-managed Pi session created under the Phase 3 layout
  - **When** the agent is stopped and resumed
  - **Then** Tachyon resolves and resumes the exact session ID from `<PI_CODING_AGENT_DIR>/sessions` with the Phase 2 ID/canonical-cwd/no-follow validation unchanged
- [x] **Scenario: safe configuration seeding**
  - **Given** the real Pi home contains supported configuration files
  - **When** Tachyon first materializes an agent's private home
  - **Then** regular JSON files are copied as private snapshots, `auth.json` is a regular non-symlink file with mode `0600`, and later Pi writes remain agent-local
- [x] **Scenario: malformed or unsafe sources fail closed**
  - **Given** a supported source file or any target home component is a symlink, non-regular file, malformed JSON, or escapes the workspace
  - **When** Tachyon materializes the Pi home
  - **Then** launch is refused before tmux mutation and no apparently isolated process is started
- [x] **Scenario: environment-only authentication remains valid**
  - **Given** the real Pi home has no `auth.json` and the selected provider authenticates through process environment
  - **When** Tachyon launches Pi
  - **Then** private-home materialization succeeds without inventing an auth file or forcing a global login
- [x] **Scenario: project configuration remains project-scoped**
  - **Given** the cwd contains trusted project `.pi` settings/resources
  - **When** a private-home Pi starts
  - **Then** Pi can still load those cwd-relative resources according to its native project-trust decision; Tachyon does not copy or rewrite project `.pi`
- [x] **Scenario: Tachyon owns both Pi home overrides**
  - **Given** a configured Pi agent declares `PI_CODING_AGENT_DIR` or `PI_CODING_AGENT_SESSION_DIR` in `env`
  - **When** Tachyon validates the configuration
  - **Then** validation rejects the conflicting override with an actionable error
- [x] **Scenario: explicit Pi session ownership remains an opt-out**
  - **Given** a Pi command explicitly supplies a native session/session-directory flag
  - **When** Tachyon launches it
  - **Then** Tachyon still provides the private agent home but does not claim exact-session continuity it cannot authoritatively resolve
- [x] **Scenario: forgotten agents do not leak private state**
  - **Given** a private-home Pi agent is canonically forgotten
  - **When** cleanup runs
  - **Then** its complete private home is removed through the existing no-follow harness cleanup boundary
- [x] Runtime documentation and runtime-profile metadata describe Pi as private-home isolation and state the credential/resource inheritance limits without claiming stronger guarantees.
- [x] Automated tests prove spawn/restart/resume parity, two-agent separation, permissions, no symlinked auth, fail-closed behavior, cleanup, and preservation of the Phase 2 real-Pi continuity dogfood.

## Non-goals

- Pi Activity normalization, metrics, hooks, or transcript rendering.
- Enabling Tachyon `harness:` capabilities such as agent-scoped Pi skills/extensions/packages; this phase isolates the default runtime home only.
- Copying ambient global `extensions/`, `skills/`, `prompts/`, `themes/`, `npm/`, `git/`, `tools/`, or `bin/` trees. Project `.pi` resources remain available natively; global executable resources are deliberately not inherited across the isolation boundary.
- Synchronizing refreshed OAuth credentials between multiple private Pi homes or promoting them back into `~/.pi/agent`. A private credential is seeded once and then owned by that agent; a later auth-coordination design must be explicit and race-safe.
- Migrating pre-Phase-3 transcript files from `.tachyon/pi-sessions/`; stacked/unmerged Phase 2 has no released compatibility obligation, so its storage path is folded directly into the private home before integration.
- Native Pi fork/tree UI or managed-agent rename. Rename remains fail-closed while homes are name-keyed.

## Open questions

- None. Pi source inspection confirmed `PI_CODING_AGENT_DIR` redirects auth, settings, models, resources, sessions and logs; `PI_CODING_AGENT_SESSION_DIR` has higher session-path precedence. Pi writes auth in place under a path-scoped lock, so a symlink from several private paths would create distinct locks around one shared target. A private regular-file copy is the honest isolation choice, matching Tachyon's OpenCode precedent while documenting OAuth refresh divergence.
