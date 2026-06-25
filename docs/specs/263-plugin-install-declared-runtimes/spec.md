# 263 — plugin-install-declared-runtimes

_Created 2026-06-25._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

## Intent

Installing a plugin into a **fresh workspace** silently does almost nothing. The install model gates materialization on `detectRuntimes(workspaceRoot)` — a runtime counts only if the workspace already has a `.claude/` or `.codex/` directory. The caller (`PluginsPanel.ts`) passes that set into `previewInstall`, which marks every **declared-but-not-physically-present** runtime as `skipped` (`resolveCompat → missingFromWorkspace`). On a clean repo with neither dir, a `runtimes: [claude, codex]` plugin writes its committed payload + the lockfile but materializes **nothing** into any runtime — a green, consenting "success" that leaves the capability uninstalled. Observed live: the consent drawer for `sdd@1.1.0` showed `claude — skipped (not present)` and `codex — skipped (not present)` against a fresh `/home/goat/tachyon`.

This inverts who decides. The **plugin author** declares the target runtimes in `manifest.runtimes`; the **installer** sees those runtimes in the consent drawer and agrees by clicking Install. The workspace's pre-existing directory layout should not be the authority. "Install a plugin into a fresh workspace and it just works" is table-stakes for the marketplace — the current behavior breaks it silently.

**Done** = materialization is driven by the plugin's **declared runtimes** under the installer's **explicit consent**, creating whatever runtime structure those declarations require. `detectRuntimes` is demoted from a hard gate to an informational hint; a workspace that already has the dirs behaves exactly as today.

## Acceptance criteria

- [ ] **Scenario: fresh-workspace install materializes the declared runtimes**
  - **Given** a workspace with no `.claude/` or `.codex/` directory
  - **When** the installer consents to a `runtimes: [claude, codex]` plugin in the Plugins View
  - **Then** the install creates the needed structure and materializes the plugin into BOTH runtimes (`.claude/skills/<name>` + `.agents/skills/<name>` for a skill; the hooks/MCP targets for a hooks/MCP plugin) — not a no-op.

- [ ] **Scenario: the consent drawer is the agreement over declared runtimes**
  - **Given** a plugin declaring `[claude, codex]`
  - **When** the consent drawer renders
  - **Then** it lists each declared runtime as a target to be wired (distinguishing "already present" from "will be created"), and the FILE WRITES preview includes the runtime materialization paths — so the installer agrees to exactly what will happen.

- [ ] **Scenario: installer may deselect a runtime they don't want**
  - **Given** a claude-only user installing a `[claude, codex]` plugin
  - **When** they deselect `codex` in the drawer before confirming
  - **Then** only `claude` is materialized; no `.agents/` structure is created.

- [ ] **Scenario: no silent all-skipped install**
  - **Given** any install where zero runtimes would be materialized
  - **When** the installer reaches the consent drawer
  - **Then** the engine does not present it as an ordinary install — it either materializes the declared runtimes (default) or surfaces an explicit warning that nothing will be wired (never a green no-op).

- [ ] **Scenario: the consent fingerprint binds the runtime SELECTION (TOCTOU)**
  - **Given** the installer deselects `codex` in the drawer
  - **When** they confirm
  - **Then** the selected runtime set is an input to `previewInstall` and is included in the consent `fingerprint`; `applyInstall` recomputes the plan from the SAME selected set and refuses if it differs from what was consented (no apply wiring a runtime the user excluded, or excluding one they kept).

- [ ] **Scenario: the lockfile records what the install CREATED (for safe uninstall)**
  - **Given** an install that created `.claude/`, `.agents/skills/`, or other parent ancestors that did not pre-exist
  - **When** the lockfile is written
  - **Then** it records those installer-created paths (e.g. a `createdPaths`/`createdAncestors` field per runtime/target), bound into the remove fingerprint — so uninstall can reconstruct exactly what to clean.

- [ ] **Scenario: update / reinstall honor the consented runtime set, not raw presence**
  - **Given** a plugin installed into `[claude, codex]` whose `.codex/` was later removed from the workspace
  - **When** the installer updates or reinstalls (incl. drift repair / checkUpdates)
  - **Then** the target runtimes come from the **consented installed set** recorded in the lockfile (or the current selected declared set), NOT from `detectRuntimes` — so update never silently drops a runtime install honored.

- [ ] **Scenario: partial materialization failure has a defined contract**
  - **Given** an install that creates new runtime structure and wires claude successfully but fails writing codex
  - **When** the failure occurs
  - **Then** the engine either rolls back the newly created runtime structures, or records enough cleanup metadata BEFORE any activation that `applyRemove` can clean every newly created empty ancestor + partial wiring — never leaving orphaned installer-created dirs or half-activated hooks with no removal identity.

- [ ] **Scenario: deselecting ALL runtimes is not a payload-only no-op**
  - **Given** the installer deselects every declared runtime
  - **When** the drawer evaluates the selection
  - **Then** confirm is disabled (or the action becomes cancel); there is no green "install" that writes only the payload + lockfile and wires nothing.

- [ ] **Scenario: present-workspace behavior is unchanged (golden regression)**
  - **Given** a workspace that already has `.claude/` and `.codex/`
  - **When** a plugin is installed
  - **Then** a golden-style test asserts the new preview is byte-identical to the old for the both-present case: settings writes, skill targets, MCP targets, lock targets, warnings/errors, and consent-visible writes.

- [ ] `detectRuntimes` is no longer a gate on materialization — only a hint (label "already present" vs "will be created"). Verified by installing into a runtime whose dir does not pre-exist.

- [ ] A plugin declaring an unsupported/deferred runtime (e.g. `gemini`) still fails `manifest` validation and never reaches consent — this spec does not loosen `SUPPORTED_RUNTIMES`.

## Non-goals

- **Per-agent / isolated-harness install** (pin p-df3eef) — installing a plugin into a single agent's private harness rather than the workspace. Sibling spec; this one stays at workspace scope.
- Changing the **manifest format** or the `runtimes` vocabulary.
- Marketplace / registry / discovery.
- Gemini or any runtime beyond the shipped claude + codex.

## Decisions (ratified by the maintainer, 2026-06-25)

- **D1 — Default selection = wire ALL declared runtimes**, with per-runtime deselect in the consent drawer. The author's `manifest.runtimes` declaration leads; the drawer is the installer's consent and their chance to opt a runtime out. (Not "present + opt-in to add the missing".)
- **D2 — Hooks into an unused runtime are acceptable under consent.** No hard block. A softer "you don't appear to use codex — wire anyway?" nudge is a nice-to-have, not required for this spec.
- **D3 — Uninstall removes only what this install created**, and only when doing so leaves no unrelated content. This is **only safe if the install RECORDS what it created** — the lockfile must persist the installer-created ancestor paths (see the "lockfile records what the install created" acceptance scenario); uninstall removes exactly those recorded empty ancestors + the plugin's own targets, and never an ancestor that pre-existed or still holds unrelated content.

## Open questions

_None open at draft — the three forks above were ratified. New questions surfaced during review/build go here._
