# 264 — plugin-git-hook-target

_Created 2026-06-25._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

## Intent

The plugin engine materializes three target kinds — `settings-hook` (a runtime's PreToolUse hook), `skill-dir`, `mcp-server` — all of which fire only when an **agent** acts through a runtime. A whole class of capability needs a gate at **git commit time** that fires for **every actor**: the agent running `git commit` via Bash, the human committing in a terminal, the IDE's git integration, another tool. The canonical example is a secrets scan (the migrating Agent0 `secrets-scan`): a runtime PreToolUse hook catches only agent-driven commits, so it is half a feature. The only chokepoint that catches all actors is a **git `pre-commit` hook**.

Today a plugin cannot install one. And the naive approach is unsafe: `core.hooksPath` is **single-owner** — whatever sets it owns *all* git hooks, clobbering the user's existing hooks or a second plugin's. A real solution needs a **Tachyon-owned chaining dispatcher** so multiple plugins AND the user's own hook coexist, installed/removed through the same consent + lockfile + TOCTOU machinery as the existing targets (specs 250/263) — never a bespoke escape hatch.

**Done** = a plugin can declare a `pre-commit` `git-hook`; install (transactionally, under a repo lock) materializes a content-addressed leaf script registered with a Tachyon-managed dispatcher that runs the user's prior hook then every registered leaf and blocks the commit on any non-zero exit; the consent drawer surfaces "runs on every commit, for everyone" as its own broader category with the exact command; uninstall un-registers exactly its leaf and, only when Tachyon owns zero leaves across all events AND still owns `core.hooksPath`, restores the recorded prior value — never touching the user's own hook. Honest about its limits: `--no-verify` bypasses it (it is a default, not an absolute gate). A reusable primitive for **any** commit-time gate.

## Dispatcher contract (the load-bearing detail — folded from review)

The per-event dispatcher is **Tachyon-authored** (trusted code, generated — never plugin-authored). On a `pre-commit` invocation it:
1. runs from Git's hook working directory; forwards `"$@"` and stdin unchanged; streams each child's stdout/stderr through.
2. self-validates the registry's integrity hash first; a parse/integrity failure is **fail-closed** with a clear message (never a silent skip that disables the gate).
3. runs the captured **prior user hook FIRST** (preserving its exact exit code and labeling it distinctly), then every registered plugin leaf in canonical-plugin-id order.
4. is **run-all-aggregate**: it evaluates every step, collects all failures, and exits non-zero (blocking the commit) if **any** step — user hook or a leaf — exited non-zero. (Run-all over fail-fast: a multi-gate commit shows ALL problems at once.)
5. treats a missing/non-executable **managed leaf** as fail-closed with an actionable error (a disabled gate must never pass silently) — except while the installer is repairing/removing under the repo lock.

## Acceptance criteria

- [ ] **Scenario: a plugin declares a pre-commit git-hook and it materializes**
  - **Given** a manifest declaring a `git-hook` for `pre-commit` whose leaf is a plugin-owned payload file (or a declared argv array)
  - **When** the installer consents
  - **Then** install copies the leaf to a content-addressed managed path, registers it, and ensures the managed `pre-commit` dispatcher exists — a `git commit` runs the leaf.

- [ ] **Scenario: Tachyon claims `core.hooksPath` once via a repo-level ownership record**
  - **Given** the first git-hook plugin installs into a repo (possibly with a prior `core.hooksPath` or a `.git/hooks/pre-commit`)
  - **When** it installs
  - **Then** Tachyon writes a repo-level ownership record `{ claimedFrom (prior value or none), managedPath, leafRefs, generation }`, points `core.hooksPath` at the managed dir, and the dispatcher chains to the captured prior hook.

- [ ] **Scenario: worktree-correct path resolution**
  - **Given** the repo may be a linked worktree (`.git` is a file, hooks live in the common dir)
  - **When** install resolves hook/config paths
  - **Then** it uses `git rev-parse --git-path hooks/<event>`, `--git-common-dir`, `--show-toplevel` (not a hardcoded `.git/hooks`); if `extensions.worktreeConfig` is enabled it writes the correct scope or **refuses with a clear message** rather than guessing. Verified on a main worktree AND a linked worktree.

- [ ] **Scenario: prior-hook capture is precise**
  - **Given** an existing event hook
  - **Then** Tachyon chains it only if it is a **regular, executable file**, resolved via git-path, and **not a `*.sample`**; a `pre-commit.sample` or a non-executable file is treated as "no prior hook". A symlinked prior hook is resolved and its target + link metadata fingerprinted.

- [ ] **Scenario: multiple plugins + the user's hook coexist**
  - **Given** two installed plugins both registering a `pre-commit` leaf, plus a prior user hook
  - **When** a commit runs
  - **Then** the user hook runs first, then both leaves in canonical-id order; the commit is blocked iff any step exits non-zero; each step's exit code is reported distinctly.

- [ ] **Scenario: consent surfaces the broader blast radius (dedicated ack)**
  - **Given** an install that materializes a git-hook
  - **When** the consent drawer renders
  - **Then** the git-hook is its OWN category requiring a **dedicated second acknowledgement** showing: the event, repo scope, the EXACT command/leaf, its data-access class (reads staged content), the bypass note (`--no-verify` skips it), and the uninstall/restoration behavior.

- [ ] **Scenario: the lockfile records a precise, unambiguous removal identity**
  - **Given** an installed git-hook plugin
  - **When** the lockfile is written
  - **Then** the removal identity is `{ pluginId, event, managedLeafPath, leafContentHash, ownershipGeneration }` (NOT content-hash alone — two plugins with identical leaf content must not collide), bound into the remove fingerprint.

- [ ] **Scenario: uninstall un-registers exactly its leaf and restores prior state correctly**
  - **Given** a git-hook plugin installed into a repo that had a prior `core.hooksPath`
  - **When** it is removed
  - **Then** only its leaf is un-registered (by removal identity); the user's prior hook is never touched; `core.hooksPath` is restored to `claimedFrom` **only when** Tachyon owns **zero** registered leaves across **all** events AND `core.hooksPath` still equals `managedPath` (else leave it — the user or another plugin changed it). Empty Tachyon-owned event dirs/dispatchers are cleaned up.

- [ ] **Scenario: the gate actually blocks (and is honest about `--no-verify`)**
  - **Given** a registered leaf that exits non-zero
  - **When** a commit runs
  - **Then** the dispatcher exits non-zero and the commit aborts; a zero exit lets it through. Tachyon does **not** attempt to prevent `git commit --no-verify` — the spec documents it as a user bypass, not a hole Tachyon closes.

- [ ] **Scenario: transactional install + repo lock (no half-installed state)**
  - **Given** an install/remove
  - **When** it runs
  - **Then** it holds a repo-local lock; writes temp registry/dispatcher and `fsync`+atomic-renames them, then sets `core.hooksPath` **last**; any failure rolls back leaving the prior state intact. A `repair` flow detects and reconciles a half-installed or freshly-cloned state.

- [ ] **Scenario: clone behavior is defined**
  - **Given** a clone whose committed lockfile records a git-hook but the managed dir/registry is absent (gitignored, not present)
  - **Then** `core.hooksPath` is **not** claimed and the gate is **not** active until an explicit install/repair under consent — never silently activated from a lockfile a teammate committed.

- [ ] **Scenario: concurrency is safe**
  - **Given** concurrent installs/removes and commits
  - **Then** install/remove serialize on the repo lock; the dispatcher reads an integrity-validated immutable snapshot of the registry (never a torn read).

- [ ] **Scenario: TOCTOU — consent binds the full hook state**
  - **When** the user confirms a git-hook install
  - **Then** the fingerprint binds: the current `core.hooksPath` value (raw + resolved), the resolved prior-hook identity (kind/path/exec-bit/file-type/content-hash/config-scope), the registered-leaf set, and the ownership generation; apply refuses on any drift.

- [ ] **Scenario: manifest leaf constraints (no traversal, no shell eval)**
  - **Given** a malicious manifest registering `../../.git/hooks/pre-commit` or a shell string with surprising expansion
  - **Then** loading rejects it: a leaf must be a normalized, contained plugin-owned payload file or a declared argv array; no path traversal, no shell `eval`.

## Non-goals

- **Windows.** Linux / WSL / macOS only. POSIX `sh`, all paths quoted, repo paths with spaces tested; refuse Windows-Git execution of a WSL repo.
- **Git events other than `pre-commit` (v1).** The dispatcher design is generic, but v1 ships and proves **`pre-commit` only**. Message-file-arg hooks (`commit-msg`, `prepare-commit-msg`) need event-specific path-arg forwarding and are deferred.
- **Preventing `--no-verify`** (or other deliberate bypasses) — out of scope; documented as a user bypass.
- **Submodules.** Each submodule is a separate repo with its own hooks/config; a parent install does not protect submodule commits. Out of scope (documented), not silently implied.
- **The binary the hook RUNS** (e.g. gitleaks) — spec 265.
- **Shipping a secrets-scan plugin** — a consumer, migrated later.

## Decisions (folded from the 2026-06-25 codex review)

- **D1 — Managed dir = untracked, mode-checked `.tachyon/githooks/`.** Dispatchers are generated from trusted Tachyon code; plugin payload is copied into content-addressed leaf paths (a repo-writable tracked payload must not be able to mutate the dispatcher or a leaf before a commit). Gitignored (consistent with `.tachyon/`; reconstructable from the lockfile via repair).
- **D2 — v1 scope = `pre-commit` only** (see Non-goals) to avoid message-file-arg complexity.
- **D3 — Dispatcher = run-all-aggregate**, deterministic canonical-plugin-id order, prior **user hook runs first** (compat: preserves existing behavior; a security-sensitive "must-run-before-user-hooks" policy is a later opt-in, not v1).
- **D4 — Ownership is repo-level with a refcount across ALL events + a generation counter**; restore `core.hooksPath` only on `refs==0 && current==managedPath`.
- **D5 — Install is transactional under a repo lock; a `repair` flow** reconciles half-installed/cloned state and re-claims `core.hooksPath` under consent.

## Open questions

- **OQ1 — symlink policy for managed leaves:** reject outright (lean) vs resolve+fingerprint. Prior-hook symlinks are resolved+fingerprinted; managed leaves are Tachyon-written so a symlink there is always a tamper signal → lean reject.
- **OQ2 — relative `core.hooksPath` storage:** store both raw and repo-root-resolved forms; confirm resolution matches Git's own (relative to the repo top-level).
- **OQ3 — repair UX:** is `repair` automatic on the next plugin op when a half/clone state is detected, or an explicit user action? Leaning explicit (consent before claiming `core.hooksPath`).
