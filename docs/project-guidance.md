# Tachyon repository guidance

Repository-local rules transported through `settings.projectGuidance.files`. They are not Tachyon
product policy and must not be imposed on consuming projects.

## Work

- Work from the checkout root. Run `npm ci` only when dependencies are absent.
- Bugs and improvements are Tasks, not prose-only findings. Keep evidence and detailed reasoning in
  the task journal or its spec; `docs/` contains durable project documentation, not loose work
  evidence or generated screenshots.
- Prefer the smallest coherent, reversible change. Use SDD only for ambiguous contracts,
  cross-cutting lifecycle or authority changes, migrations, or costly decisions. Avoid speculative
  hardening and unrelated follow-ups.
- Preserve unrelated changes. Stage explicit paths only; never `git add .` or `git add -A`. Run add
  and commit separately, and include the Task id when one exists.
- Do not use the retired `agent-screen` or `agent-desktop` plugins.

## Verification economy

- During implementation, run focused fail-before/pass-after checks. Run one `npm run
  verify:full:quiet` on the final coherent tree; creating a Task or doing read-only investigation
  does not justify a full gate.
- Always invoke the final gate: it reuses an existing attestation before taking the shared lock.
  `scripts/verify-full.mjs` owns reuse; `TACHYON_VERIFY_FORCE=1` forces execution, and `node
  scripts/verify-record.mjs check HEAD` inspects the record. Report the verified tree and never claim
  a check that did not run.
- Integrate `main` once at the end inside the change worktree, verify that combined tree, then
  fast-forward `main` to that exact commit. If `main` moves again, re-integrate and reverify.
- Use `npm run dogfood -- <scenario>`; list scenarios with `npm run dogfood -- --list`. Dogfood must
  use existing harnesses rather than add one-off package scripts.
- Dev Host is checkout-local: `npm run dogfood -- dev-host -- point --fixture <slug>`; `--worktree`
  explicitly targets another checkout. On completion, run `point-clear`, confirm with `point-status`,
  then remove the change worktree. The retired flags
  `--owner`, `--slot`, `--activate`, `--no-activate`, `--require-owner`, and `--all` must not return.
- Visual/UI work requires visual evidence from the supported headless browser harness or
  `visual-qa`; a green functional suite is not visual judgment. Do not open a desktop VS Code window
  unless the human explicitly requests it.

## Review and reporting

- Use adversarial review for architecture, authority/security boundaries, migrations, destructive
  operations, costly reversal, or a real disagreement—not settled mechanical edits.
- Completion messages are doorbells: status, commit, tree, gate, one decisive finding, and a journal
  pointer. Do not repeat history already in git or the task journal.
- Hand off before context exhaustion. State unfinished work and the exact next action.

## Hygiene

- Remove a change worktree/branch only when clean, unoccupied, and contained in `main`. Preserve
  dirty, occupied, or unique work and all persistent agent worktrees.
- Closed Tasks must not be resurrected from stale briefs; only active board work is executable.

## Release

- “Release” means a local audited VSIX: bump when requested, build/package, audit provenance, and
  report path plus SHA-256.
- Marketplace publication is disabled. Never run publish/unpublish or mutate Marketplace state
  without an explicit policy change from the human.

## UI text

- Human-facing VS Code strings use `vscode.l10n.t(...)` (or the injected equivalent) and update
  bundles. Model/orchestration protocol text remains plain.
