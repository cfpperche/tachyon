# 406 — pi-harness-resources

_Created 2026-07-18._

**Status:** in-progress

## Intent

SDD 401 made every Tachyon-managed Pi process use a private home and deliberately stripped ambient global extensions, skills, prompt templates, themes and packages. That default-deny boundary prevents sibling agents from silently executing the user's global Pi customization, but it also leaves no governed way to give one named agent the Pi resources its role requires.

Add an explicit `harness:` resource allowlist for Pi. A configured Pi agent may name workspace-contained local extensions, skills, prompt templates, themes and Pi package directories; Tachyon snapshots those resources into a private Tachyon-owned generation, disables Pi's automatic discovery for those resource classes, and passes only the private snapshots through Pi's explicit additive CLI paths. No Pi resource crosses from the real global home, `~/.agents/skills`, or trusted project resource directories implicitly while exact harness mode is active, and package acquisition never happens as an unreviewed network/install side effect of launch.

**Affected Product Invariants: none — this adds an opt-in runtime configuration surface and does not change PI-001's project-guidance ownership oracle.**

## Acceptance criteria

- [x] **Scenario: one Pi agent receives only its declared resources**
  - **Given** a Pi agent with workspace-relative `harness.extensions`, `skills`, `prompts`, `themes` and/or local `packages`
  - **When** Tachyon spawns, restarts or resumes it
  - **Then** the declared resources are snapshotted into that agent's mode-0700 private home, Pi discovers them through its native `--no-*` plus explicit additive resource flags, and the Tachyon Bridge extension remains loaded
- [x] **Scenario: siblings remain isolated**
  - **Given** two same-workspace Pi agents with different resource allowlists
  - **When** both homes are materialized
  - **Then** each home contains only its own declared snapshots and neither agent reads the other's resources or the ambient global Pi resource trees/settings
- [x] **Scenario: rematerialization removes stale declarations**
  - **Given** an already-materialized Pi harness whose configured resource list changes or is removed
  - **When** the next spawn/restart/resume materializes the home
  - **Then** Tachyon publishes a complete new resource generation and uses only that generation's CLI paths, so removed resources no longer load while private settings, auth and sessions remain untouched
- [x] **Scenario: unsafe resource sources fail before launch**
  - **Given** a missing, absolute, traversing, symlinked, special-file, workspace-escaping, duplicate-basename or structurally invalid declared resource
  - **When** Tachyon validates/materializes the Pi harness
  - **Then** launch is refused before tmux mutation and no partial resource set is promoted as active
- [x] **Scenario: conflicting native resource flags fail closed**
  - **Given** a Pi harness command that also supplies native resource include/disable flags
  - **When** configuration is loaded
  - **Then** validation rejects the ambiguous second authority instead of allowing argv to bypass or disable the declared allowlist
- [x] **Scenario: local packages are deterministic and offline at launch**
  - **Given** a declared workspace-local Pi package directory
  - **When** Tachyon materializes it
  - **Then** its safe regular-file tree is copied and passed to Pi as a temporary local `--extension` package source; Tachyon neither resolves npm/git package specs nor runs an installer/update command
- [x] **Scenario: ordinary private-home Pi remains default-deny**
  - **Given** a managed Pi agent with no resource harness
  - **When** its private home is first materialized
  - **Then** SDD 401 behavior remains unchanged: safe JSON/auth state is seeded, Pi-home global resource keys and trees are not inherited, and trusted project `.pi` resources remain governed natively by Pi
- [x] **Scenario: exact harness mode does not inherit alternate discovery roots**
  - **Given** the host has ambient `~/.agents/skills` and the cwd has trusted project `.pi` resources
  - **When** a Pi agent starts with a resource harness
  - **Then** Pi's automatic extension/skill/prompt/theme discovery is disabled, only declared private snapshots load for those classes, and unrelated project settings/trust behavior is not rewritten
- [x] Schema/autocomplete, parser diagnostics, runtime docs and parity metadata describe the Pi-specific resource fields, trust boundary, local-package limit and lifecycle ownership.
- [x] Focused automated tests plus real-Pi headless dogfood prove extension/skill/prompt/theme/package discovery, sibling isolation, stale cleanup and fail-closed handling.

## Non-goals

- Inheriting the entire global Pi home or supporting `harness.inherit: global`.
- Fetching, installing or updating npm/git Pi packages during an agent launch. External package acquisition, pin verification and consent need a separate lifecycle design.
- Copying project `.pi` resources into the private home, auto-trusting a project, or replacing Pi's native trust store. Exact resource harness mode intentionally disables automatic project extension/skill/prompt/theme discovery; ordinary Pi agents retain native project discovery.
- Synchronizing OAuth refreshes across private homes; that remains the next independent Pi slice.
- Forking a harness-enabled Pi agent. Existing harness Fork governance remains fail-closed; extending SDD 405 across a resource harness needs its own explicit inheritance contract.
- Generalizing extensions/prompts/themes/packages to every harness runtime in this change.
- Adding a new Agent Studio UI; the initial operator surface is validated `tachyon.yml` plus schema autocomplete and runtime documentation.
- Merging or pushing the implementation without explicit maintainer authorization.

## Open questions

None. This slice deliberately chooses workspace-local, no-follow snapshots, exact CLI resource loading and local package directories; remote package acquisition and implicit global/project resource inheritance remain separate security decisions.
