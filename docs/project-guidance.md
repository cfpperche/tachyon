# Tachyon repository guidance

Repository-local rules transported through `settings.projectGuidance.files`. They are not Tachyon
product policy and must not be imposed on consuming projects.

## Nothing here is permanent

Every rule below is a current decision, not a law. A better proposal — argued, with evidence — is
always welcome and changes the file. The same holds one level up: a Tachyon product decision is a
position taken for stated reasons, and reasons can be revisited. "The product already decided this"
is the beginning of a review, never the end of one.

What is not acceptable is quietly routing around a rule. Follow it, or argue it down and rewrite it.
When a repository convention and the product protocol disagree, say so and name which one you think
is wrong — a stuck agent is a symptom worth reading, not a rule to work around.

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

## Who else can reach this?

Before adding behaviour to a mechanism, name every ACTOR × TRIGGER that can reach the same effect, and
say what happens for each. Actors here are the Interface (a human in the UI), an Agent (through the
Bridge), and Tachyon itself. Triggers matter as much as actors: create, restart, resume, fork and
crash-recovery are the same actor arriving through different doors.

This is not ceremony. On 2026-07-30 five defects landed with one shape between them — a mechanism
built for one actor, reached later by another that skipped the logic:

- `t-57a00a` assignee notice: built for Agent→Agent; the Interface writes straight to the store.
- `t-d79534` approval wake-up: built for `notify_agent`; the human's decision took a rawer path.
- `t-33ae3f` end-of-life cleanup: built for Temporary dismiss; Saved Agent forget ran a second machine.
- `t-e73e54` session attestation: built for spawn; restart/resume is the SAME actor, other trigger.
- `t-17d885` removal: took the roster entry, left the authority keyed by the same name.

The last two are why "list the actors" alone is not enough. `t-e73e54` has one actor on both paths, and
the residue in `t-17d885` was a different surface rather than a different caller — so ask "who else can
reach this?", not "who is this for?". The second caller usually does not exist yet on the day of the
plan; it arrives later, when nobody is re-reading the plan.

What gives it teeth: the actor × trigger list becomes the TEST CASE list, named the same way. When a
new door appears it either joins that list or is visibly uncovered. A comment claiming a mechanism has
one entry point is worth nothing — `t-e73e54` had exactly that comment, and a source test asserting
"in one place" that passed while the second door existed.

## Verification economy

- During implementation, run focused fail-before/pass-after checks. Run one `npm run
  verify:full:quiet` on the final coherent tree; creating a Task or doing read-only investigation
  does not justify a full gate.
- Always invoke the final gate: it reuses an existing attestation before taking the shared lock.
  `scripts/verify-full.mjs` owns reuse; `TACHYON_VERIFY_FORCE=1` forces execution, and `node
  scripts/verify-record.mjs check HEAD` inspects the record. Report the verified tree and never claim
  a check that did not run.
- Integrate `main` once at the end inside the change worktree, verify that combined tree, and deliver
  there. If `main` moves again, re-integrate and reverify.
- Moving `main` is a HUMAN action in the primary checkout, not the delivering agent's. Two product
  facts put it there: an agent is isolated to its own worktree, and the integrate door is
  record-only — it proves containment and records the fact, and never runs a main-mutating Git
  command. There is also a mechanical reason: while the primary checkout sits on `main`, advancing
  the ref from outside leaves its index and working tree inconsistent with the new HEAD, so the only
  safe place to fast-forward is that checkout itself. An agent that has verified its tree reports the
  commit and stops; it does not reach across. Closing this loop inside the product — a governed land
  door in the shape of Forget, where the agent prepares and the human executes — is `t-7cb971`.
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
