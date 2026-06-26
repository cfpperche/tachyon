# 267 — plugin-agent-browser

_Created 2026-06-26._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

## Intent

Give any Tachyon agent (claude / codex / …) a **reusable browser-automation capability** — visual inspection +
screenshots, content extraction **even from auth-gated pages**, and (v2) form-driving — delivered as a **plugin**
on the shipped plugin engine, not a bespoke wrapper. The browser engine is the upstream **`agent-browser`** CLI
(`vercel-labs/agent-browser`): a native per-platform Rust binary that drives Chrome over CDP through a persistent
per-`--session` daemon and returns **accessibility-tree snapshots** with stable `@eN` element refs, so an agent
acts by intent ("click the checkout button") instead of brittle selectors.

The plugin's job is the **operational envelope** around that binary: provision + hash-verify it (spec 265), ship
a thin runtime-neutral skill that teaches the open→snapshot→act loop and the safe invocation path, give each
agent an isolated browser session, and make auth-gated reads work through the CLI's native saved-state model
without the LLM ever touching a credential. **This spec is a plugin DESIGN** — the plugin payload ships to the
external plugins repo, not into Tachyon (the engine bundles no plugins); Tachyon only gains a dogfood + this
record.

**v1 is read-first.** Inspection + extraction (incl. behind auth) are the headline. Form-driving (clicks/fills
that mutate state) is gated behind explicit human confirmation in v1 and promoted to a first-class **v2**.

**Done (v1)** = a tag-pinned `agent-browser` plugin that: provisions the correct per-platform binary
(content-addressed, launcher-revalidated), installs a thin claude+codex skill, fails **loud** when Chrome is
absent (`BROWSER_RUNTIME_MISSING` + remediation), opens a public page and returns a snapshot/screenshot through
the plugin-scoped launcher, reuses a human-established auth session to read a protected page headlessly, keeps
per-agent sessions isolated, and carries consent copy that names the real browser/network/auth-replay risk.

## Form / non-form decisions (ratified)

- **Exposure:** a provisioned **tool + a thin skill** in v1. The `agent-browser mcp` server (a spec-254 MCP
  capability) is **deferred to v1.1**, after the CLI path is dogfooded — it is the typed/discovery surface, not
  the only one.
- **Auth state location:** `.tachyon/browser-state/` (per-workspace, **gitignored**, credential-class). No
  Tachyon login-broker in v1 — the CLI's native `state`/`--session --restore`/encrypted vault + a human headed
  first-login is the model.
- **v1 read-first; v2 = form-driving** (the immediate next slice).
- **Confirmation policy (conservative, ratified):** in v1 the agent may navigate + read + screenshot freely on
  ordinary pages, but must get explicit human confirmation before (a) submitting a form / any click that writes,
  (b) extracting from an authenticated page, or (c) acting on a sensitive domain (admin/banking/destructive).

## Acceptance criteria

- [ ] **Scenario: the browser binary is provisioned + launcher-validated**
  - **Given** the `agent-browser` plugin declares the upstream binary as a pinned per-platform tool (the GitHub
    release assets `agent-browser-{darwin-arm64,darwin-x64,linux-arm64,linux-x64,linux-musl-arm64,linux-musl-x64}`
    + author-pinned `sha256` per platform)
  - **When** it is installed into a consented runtime set
  - **Then** the platform resolves (spec 265, incl. glibc/musl), the binary installs content-addressed +
    immutable, and the agent invokes it ONLY through the plugin-scoped launcher (`.tachyon/bin/_tachyon-tool
    agent-browser agent-browser …`), whose hash re-validation runs before every exec.

- [ ] **Scenario: Chrome absent fails loud, not silently**
  - **Given** the binary is provisioned but no usable Chrome/Chromium is present
  - **When** the skill's `doctor` step runs (`… agent-browser --version` + a non-destructive browser-detection
    probe)
  - **Then** it reports `BROWSER_RUNTIME_MISSING` with the exact remediation (install Chrome / run
    `agent-browser install`), and never lets the agent pretend it can browse. Chrome is NOT provisioned by spec
    265 (it is a multi-file browser runtime, not a single verifiable executable).

- [ ] **Scenario: read a public page (the core loop)**
  - **Given** Chrome is present
  - **When** the agent runs open → `snapshot -i` → read/screenshot through the launcher
  - **Then** it gets an accessibility snapshot with `@eN` refs + a screenshot/text extract — the inspection +
    extraction primitive, runtime-neutral (identical shell path on claude and codex).

- [ ] **Scenario: read an auth-gated page without the LLM seeing a credential**
  - **Given** a human has established a session for a host (headed first-login, state saved under
    `.tachyon/browser-state/`, optionally encrypted via `AGENT_BROWSER_ENCRYPTION_KEY`)
  - **When** the agent navigates the protected host with `--session <id> --restore` (validated by
    `--restore-check-url/-text`)
  - **Then** it reads the authenticated content headlessly; the saved state is credential-class + gitignored;
    the LLM never receives the password. On expiry (a prior-working nav now 401/403/redirects to login) the
    agent surfaces a re-login signal and does NOT silently retry.

- [ ] **Scenario: per-agent isolation**
  - **Given** two agents browse concurrently
  - **When** each uses `--session tachyon-<workspace-hash>-<agent-id>`
  - **Then** each gets its own daemon + browser (no cross-talk, no cross-workspace collision); idle daemons
    self-close (`AGENT_BROWSER_IDLE_TIMEOUT_MS`) and the skill exposes an explicit cleanup command.

- [ ] **Scenario: write-actions are confirmation-gated in v1 (read-first)**
  - **Given** v1
  - **When** the agent is about to submit a form / click a state-mutating control / extract from an authenticated
    page / act on a sensitive domain
  - **Then** the skill requires explicit human confirmation first; ordinary navigation + read + screenshot need
    none. (v2 promotes form-driving to first-class with its own safety contract.)

- [ ] **Scenario: consent names the real risk**
  - **Given** install consent
  - **Then** beyond spec-265's "sha256 = integrity, not trust" copy, the drawer states the plugin can **control
    a browser, reach the network, replay authenticated sessions from saved local state, submit forms, and create
    credential-class local files** — louder than a scanner-class tool.

- [ ] **Scenario: the plugin auto-detects a newer upstream release**
  - **Given** the plugin is tag-pinned and a newer semver tag ships a newer `agent-browser`
  - **When** the user runs Check updates
  - **Then** spec 266 surfaces the bump (binary pin + thin skill contract updated together), re-pinned to the
    newer immutable tag.

## Non-goals (v1)

- **Form-driving as a first-class flow** → **v2** (the immediate next slice): clicks/fills/uploads that mutate
  state, with a dedicated safety contract (dry-run defaults, write-confirmation, prefer staging URLs).
- **`agent-browser mcp` server** → v1.1 (after CLI dogfood).
- **Provisioning Chrome** as a Tachyon-managed artifact (host-detect + documented setup only).
- **A Tachyon login-broker / credential UX** (the CLI's vault + human headed-login is the model).
- **Agent-kill → daemon teardown wiring**, a browser-state UI, and CI browser-test guarantees (declare v1 as
  local/dev browser work).
- **Windows** (spec-265 v1 excludes it, though upstream ships a `win32-x64.exe`).

## Open questions

- **OQ1 — agent-id for session names.** What canonical, stable Tachyon agent identity is available to a skill at
  runtime to build `tachyon-<workspace-hash>-<agent-id>`? (If none is exposed, fall back to a per-pane id.)
- **OQ2 — encryption key policy.** Require `AGENT_BROWSER_ENCRYPTION_KEY` for any saved auth state, or recommend
  it? Env-indirection only (never a committed value), mirroring the spec-254 MCP env rule.
- **OQ3 — gitignore.** Does install add a `.tachyon/browser-state/` `.gitignore` entry, or only document it?
- **OQ4 — confirmation enforcement.** Is the v1 write-confirmation policy skill-prose only (cultural), or is
  there a mechanical gate worth adding (and where — it cannot be a per-edit hook)?
- **OQ5 — headed first-login.** Does v1 ship a helper command for the human headed-login, or only document the
  raw `agent-browser` invocation?
- **OQ6 — profile isolation default.** Confirm the default never reuses a human's real Chrome profile
  (`--profile`), only isolated agent-browser state.
