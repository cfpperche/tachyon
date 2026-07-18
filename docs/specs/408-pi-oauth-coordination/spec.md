# 408 — Pi OAuth coordination

_Created 2026-07-18._

**Status:** in-progress

## Intent

Tachyon gives each Pi agent a private `PI_CODING_AGENT_DIR`, including a regular-file `auth.json`. That isolates agent-local state, but Pi locks OAuth refresh by auth-file pathname. Two private copies can therefore refresh the same rotating credential concurrently and leave branches whose validity cannot be ranked safely after the fact.

Preserve private Pi homes while moving only credential authority onto one literal, shared, regular-file path supported by Pi itself. Pi must expose an official auth-file override independent of its config directory; Tachyon will point every managed Pi agent at the validated canonical user auth file. Pi's existing cross-process lock and double-checked refresh then serialize refresh at the source instead of attempting unsafe reconciliation.

## Acceptance criteria

- [x] **Scenario: interim Tachyon safety before upstream support**
  - **Given** one Pi process is live in a workspace on a version without shared auth-file support
  - **When** Spawn, Resume, Restart, or Fork attempts to start a differently named Pi process
  - **Then** Tachyon serializes admission and refuses the second process with the live agent name; after the first is stopped, the slot becomes available
- [ ] **Scenario: Pi separates credential authority from the config home**
  - **Given** `PI_CODING_AGENT_DIR` names a private agent home and `PI_CODING_AGENT_AUTH_FILE` names a different absolute or tilde-expanded file
  - **When** Pi starts, resolves request auth, refreshes OAuth, logs in/out, refreshes model catalogs, or reports the credential location
  - **Then** all credential reads and writes use the explicit auth file while settings, models, sessions, and resources remain rooted in the private agent home
- [ ] **Scenario: existing Pi behavior remains compatible**
  - **Given** `PI_CODING_AGENT_AUTH_FILE` is absent
  - **When** Pi or its SDK creates a default runtime
  - **Then** credentials remain at `<agentDir>/auth.json`
- [ ] **Scenario: SDK callers can select the same boundary explicitly**
  - **Given** an SDK caller supplies `authPath`
  - **When** it creates agent-session services or an agent session without a custom `ModelRuntime`
  - **Then** the runtime uses that path without relocating other agent state
- [ ] **Scenario: concurrent refresh has one lock domain**
  - **Given** two Pi runtimes with different agent directories and the same explicit auth file containing one expired rotating OAuth credential
  - **When** they resolve that provider concurrently
  - **Then** exactly one network refresh occurs and both observe the single persisted replacement credential
- [ ] **Scenario: Tachyon preserves home isolation**
  - **Given** two managed Pi agents in one workspace
  - **When** their harnesses are materialized
  - **Then** their `PI_CODING_AGENT_DIR` values and non-auth state remain distinct, their private `auth.json` files are not symlinked, and both receive the same Tachyon-owned canonical auth-file path
- [ ] **Scenario: unsafe canonical auth state fails closed**
  - **Given** the canonical auth source or target is a symlink, special file, malformed JSON object, or otherwise unsupported
  - **When** Tachyon prepares a managed Pi launch
  - **Then** launch is refused before Pi starts and no credential content appears in diagnostics
- [ ] **Scenario: missing canonical auth remains valid**
  - **Given** the real Pi auth file is absent because credentials come from the environment
  - **When** Tachyon starts multiple managed Pi agents
  - **Then** it does not invent or copy a credential file, and environment-backed auth remains available
- [ ] Pi documents `PI_CODING_AGENT_AUTH_FILE`, its precedence, security implications, migration behavior, and shared-lock use case.
- [ ] Tachyon documents the shared credential authority and removes any claim that Pi OAuth writes remain agent-local.
- [ ] Focused upstream and Tachyon tests, typechecks, and a real Pi concurrency dogfood pass without printing token values.

## Non-goals

- Reconcile or rank independently refreshed token branches using `expires`, mtime, token hashes, or lexical order.
- Symlink/hard-link private `auth.json` files or depend on undocumented `proper-lockfile` realpath behavior.
- Permanently limit a workspace to one live Pi process after upstream shared credential authority is available.
- Broker provider tokens through the Tachyon Bridge or change provider OAuth protocols.
- Share Pi settings, sessions, extensions, skills, prompts, themes, packages, or other private-home state.
- Push, merge, publish, or release the upstream Pi change without separate human authorization.

## Open questions

- **Upstream release version:** resolved operationally after the Pi patch is accepted and published; Tachyon integration must require a version that contains the official hook and must not silently run on v0.80.10.
