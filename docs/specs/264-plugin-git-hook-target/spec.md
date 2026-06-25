# 264 — plugin-git-hook-target

_Created 2026-06-25._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

## Intent

The plugin engine materializes three target kinds — `settings-hook` (a runtime's PreToolUse hook), `skill-dir`, `mcp-server` — all of which fire only when an **agent** acts through a runtime. A whole class of capability needs a gate at **git commit time** that fires for **every actor**: the agent running `git commit` via Bash, the human committing in a terminal, the IDE's git integration, another tool. The canonical example is a secrets scan (the migrating Agent0 `secrets-scan`): a runtime PreToolUse hook catches only agent-driven commits, so it is half a feature — a human commit walks straight past it. The only chokepoint that catches all actors is a **git `pre-commit` hook**.

Today a plugin cannot install one. And the naive approach is unsafe: `core.hooksPath` is **single-owner** — whatever sets it owns *all* git hooks, clobbering the user's existing hooks or a second plugin's. A real solution needs a **Tachyon-owned chaining dispatcher** so multiple plugins AND the user's own hooks coexist, installed/removed through the same consent + lockfile + TOCTOU machinery as the existing targets (specs 250/263) — never a bespoke escape hatch.

**Done** = a plugin can declare a `git-hook` for a standard git event; install materializes a leaf script registered with a Tachyon-managed per-event dispatcher that runs every registered hook and chains to the user's prior hook; the consent drawer surfaces "this runs on every git commit" as its own (broader) category; uninstall un-registers exactly what it added and restores the prior `core.hooksPath` when Tachyon's last managed hook is gone — never touching the user's own hook. This is a reusable primitive for **any** commit-time gate, not just secrets-scan.

## Acceptance criteria

- [ ] **Scenario: a plugin declares a git-hook and it materializes**
  - **Given** a plugin manifest that declares a `git-hook` for `pre-commit`
  - **When** the installer consents
  - **Then** the install writes the plugin's leaf script into Tachyon's managed registry and ensures the managed `pre-commit` dispatcher exists — so a `git commit` runs the plugin's script.

- [ ] **Scenario: Tachyon claims `core.hooksPath` once, recording the prior value, and chains to it**
  - **Given** a repo that already has `core.hooksPath` set (or a `.git/hooks/pre-commit` present)
  - **When** the first git-hook plugin installs
  - **Then** Tachyon records the prior `core.hooksPath` (or its absence), points it at the managed dir, and the dispatcher **chains to the user's prior hook** (runs it with the same args/stdin) so existing behavior is preserved.

- [ ] **Scenario: multiple plugins hooking the same event all run**
  - **Given** two installed plugins that both register a `pre-commit` leaf
  - **When** a commit runs
  - **Then** the dispatcher runs **every** registered leaf in a deterministic order; the commit is blocked if any leaf exits non-zero.

- [ ] **Scenario: consent surfaces the broader blast radius**
  - **Given** an install that materializes a git-hook
  - **When** the consent drawer renders
  - **Then** the git-hook is shown in its OWN category, labelled that it runs on **every git commit** (not only on agent events) with the exact command — a strictly wider permission than a PreToolUse hook, called out as such.

- [ ] **Scenario: the lockfile records the registered git-hook (precise, reversible removal)**
  - **Given** an installed git-hook plugin
  - **When** the lockfile is written
  - **Then** it records the event + the registered leaf script's removal identity (content-addressed, like the hook-merge `removal`), bound into the remove fingerprint.

- [ ] **Scenario: uninstall un-registers exactly its leaf and restores prior state**
  - **Given** a git-hook plugin installed into a repo that had a prior `core.hooksPath`
  - **When** it is removed
  - **Then** only its leaf is un-registered; the user's prior hook is never touched; and when Tachyon's **last** managed hook is gone, `core.hooksPath` is restored to its recorded prior value (or unset if it had none).

- [ ] **Scenario: the gate actually blocks**
  - **Given** a registered `pre-commit` leaf that exits non-zero (e.g. a secret found)
  - **When** a commit runs
  - **Then** the dispatcher propagates the non-zero exit and the commit is aborted; a zero exit lets it through.

- [ ] **Scenario: fail-closed on a corrupt dispatcher/registry**
  - **Given** a tampered/corrupt managed dispatcher or registry
  - **When** install/remove reads it
  - **Then** it is an ERROR (never a silent skip that would leave the gate disabled or clobber state).

- [ ] **Scenario: TOCTOU — consent binds the hook state**
  - **Given** the consent drawer for a git-hook install
  - **When** the user confirms
  - **Then** the fingerprint binds the current `core.hooksPath` value + the registered-leaf set; apply refuses if either drifted since preview.

- [ ] **Scenario: worktree behavior is defined**
  - **Given** Tachyon agents working in git worktrees
  - **Then** the managed `core.hooksPath` applies to worktrees (they share the repo config) — verified, and documented as the expected behavior.

## Non-goals

- **Windows.** Linux / WSL / macOS only (git hooks are shell scripts; cross-platform shell is out of scope for v1).
- **The binary the hook RUNS** (e.g. gitleaks). That is spec 265 (tool provisioning); this spec is the *delivery mechanism* for the hook script, agnostic to what it calls.
- **Shipping a secrets-scan plugin.** That is a consumer of this primitive, migrated later.
- **Non-`pre-commit` events as a v1 requirement** — the engine is generic over standard git events, but `pre-commit` is the only one that must be proven.
- Changing the manifest/runtimes vocabulary beyond adding the git-hook declaration.

## Open questions / forks to ratify

- **OQ1 — managed location.** Tachyon owns a managed hooks dir (proposed `.tachyon/githooks/`) with per-event dispatcher scripts + a `<event>.d/` registry of plugin leaves; `core.hooksPath` points there. (Alternative — writing directly into `.git/hooks/` — is not shareable across clones and has the same single-file problem; leaning against.) Confirm the managed-dir model + the exact path.
- **OQ2 — gitignore vs tracked.** Is `.tachyon/githooks/` gitignored (reconstructable from the lockfile + payloads, like `.tachyon/`) or tracked so a clone inherits the hooks without reinstalling? This ties to the open "plugin-output gitignore is a user decision" follow-up (spec 263 notes). Leaning gitignored for v1 (consistent + reproducible), revisit as the consumer-choice follow-up.
- **OQ3 — leaf ordering.** Deterministic order across plugins — by plugin name (stable, predictable) vs install order (lockfile)? Leaning plugin-name sort.
- **OQ4 — exit semantics.** AND-gate (any non-zero leaf fails the commit) — confirm; and whether the chained user-hook runs before or after the plugin leaves.
- **OQ5 — prior-hook capture.** Exactly what "prior hook" Tachyon chains to: the prior `core.hooksPath/<event>` if set, else `.git/hooks/<event>` if present, else nothing. Confirm the precedence.
- **OQ6 — consent strength.** Does a git-hook need a second explicit acknowledgement (like MCP/OQ5 in spec 254), given it runs on every commit? Leaning yes — a dedicated "runs on every commit" ack.
