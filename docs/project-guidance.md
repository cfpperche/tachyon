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

- **A written Task is not an accepted Task.** Before implementing one, check that it still makes
  sense: that its premise holds, that the files it names still exist, and that the defect was not
  already fixed. Maintainer's rule, 2026-08-05. A task records what was true when someone wrote it,
  and this repository moves fast enough that a week-old body can describe code that no longer exists
  — SDD 485 phase E deleted whole hosts, and `t-e2c8a2` sat three releases in `triaged` after main
  had already fixed it. Measuring the CAUSE of a defect is a different check and does not cover this
  one: you can measure very well and still be building something nobody needs.
  Verify at the point of use, never by text search — on 2026-08-05 a grep for `surface:` reported two
  call sites as already done when both matches were unrelated parameters of the same name.
  If the premise is gone, say so and stop; that closes the task honestly and is a real outcome.
- Work from the checkout root. Run `npm ci` only when dependencies are absent.
- Bugs and improvements are Tasks, not prose-only findings. Keep evidence and detailed reasoning in
  the task journal or its spec; `docs/` contains durable project documentation, not loose work
  evidence or generated screenshots.
- When coordinating delegated work, use the Bridge tools (`create_pin/list_pins`,
  `append_project_handoff_note`, `write_input`, `spawn_agent`, `wait_for_agent`) so the work remains
  visible to the team. If you delegate, spawn through the Bridge; a bug you find is a Task
  (`create_task`, kind `bug`), not a pin.
- If you have a declared verify gate, run it and confirm it passes before reporting done; going idle
  is not proof that the work is green.
- These coordination and delivery rules moved here from `bridgeGuidanceTail` on 2026-08-05
  (t-f050af): they are this repository's working convention, while the native-sub-agent visibility
  limitation is a product fact and remains in the delivered guidance.
- Prefer the smallest coherent, reversible change. Use SDD only for ambiguous contracts,
  cross-cutting lifecycle or authority changes, migrations, or costly decisions. Avoid speculative
  hardening and unrelated follow-ups.
- Preserve unrelated changes. Stage explicit paths only; never `git add .` or `git add -A`. Run add
  and commit separately, and include the Task id when one exists.
- **Never `git stash` in a worktree.** The stash stack belongs to the repository, not the worktree, so
  every agent working in parallel shares one stack. On 2026-08-01 an agent stashed to check whether a
  typecheck error pre-existed; its `pop` restored a DIFFERENT agent's work into its tree and left its
  own dangling. Recovered only because that agent noticed and pinned both under `refs/recovered/`. To
  set work aside, commit it (amend later) or copy files out — both are worktree-local.
- Keep your continuity brief current with `set_continuity` as work proceeds — not merely when state
  is about to be lost. Moved here from the Tachyon primer on 2026-08-05 (t-486f43): the product
  states that continuity is durable; how often to checkpoint is this repository's decision, and the
  maintainer's is "always". Report style and the focused-check working loop are already stated above
  and below, and they came from the same separation.
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
- **Never push to a repository other than your own worktree's branch, and never cut a tag anywhere.**
  The rule above says a delivering agent does not advance `main` here; on 2026-08-06 that turned out to
  cover the wrong half of the risk. An agent fixing a plugin README correctly concluded the fix lived
  upstream, then committed, **tagged a release, and pushed both to a public GitHub repository**. The
  content was right and the repository was the maintainer's own, so nothing was reverted — but nobody
  had authorized publishing, and a public push is irreversible in practice: a later commit can correct
  it, nothing can unpublish it. The brief never said whether pushing outside the worktree was in scope,
  which is why this is a rule and not a reprimand. If a fix belongs in another repository, prepare it —
  commit locally, write the patch, say exactly what should be published and where — and stop. Publishing
  is the human's, the same way moving `main` is.
- **Never send a bare Enter to a runtime CLI, and change host-wide tooling only on purpose.** On
  2026-08-06 a measuring agent drove three runtime CLIs in tmux panes. One blind Enter landed on the
  codex update selector, which ran `npm install -g @openai/codex` and moved the **host** from `0.146.0`
  to `0.146.1`. The agent disclosed it unprompted and did not revert, because a downgrade was never
  authorized — stopping there was right.

  **The version was never the problem, and the maintainer said so:** *"os runtimes mudam constantemente,
  precisamos acompanhar sem isso o produto é inútil."* He declined the downgrade. Keeping runtimes
  current is required, not tolerated. A first draft of this rule banned host-wide upgrades outright; that
  banned maintenance, and it is corrected here.

  What was actually wrong is that **nobody chose**. An upgrade arrived as a side effect of a keystroke
  nobody read, and the measurement running at that moment silently changed which version it described.
  So:

  1. **Answer only a selector you recognized first.** Read the pane, name the option, then send the
     keystroke. A bare Enter accepts whatever is focused, which is often an upgrade prompt.
  2. **Upgrading a runtime deliberately is allowed.** Say the source and target version BEFORE, and
     re-measure whatever depended on the old one AFTER. Skipping the second half leaves `parity.md` and
     about ten source comments asserting a version the machine no longer runs (`t-1322b5`, `t-0ac2e9`).
  3. **Scratch-directory residue is yours to revert.** An agent that grants trust or writes config under
     `~/.<runtime>/` for a throwaway path must remove every entry it created and say that it did — that
     half was done correctly in the incident above, and it is the standard.

  This is **this repository's directive, not Tachyon product behavior**. Tachyon delivers this file to
  agents as project guidance; it does not encode this policy in the product. Another project may decide
  the opposite.
- Use `npm run dogfood -- <scenario>`; list scenarios with `npm run dogfood -- --list`. Dogfood must
  use existing harnesses rather than add one-off package scripts.
- Dev Host is checkout-local: `npm run dogfood -- dev-host -- point --fixture <slug>`; `--worktree`
  explicitly targets another checkout. On completion, run `point-clear`, confirm with `point-status`,
  then remove the change worktree. The retired flags
  `--owner`, `--slot`, `--activate`, `--no-activate`, `--require-owner`, and `--all` must not return.
- Do not open a desktop VS Code window unless the human explicitly requests it.
- **Test through the door PRODUCTION uses, and prove the guard red before trusting it green.** A green
  test proves the door you called works; it never proves it was the only door. `0.56.159` shipped a
  coalescing fix with green units and changed nothing live — the tests called the one coalesced entry
  point while five other call sites bypassed it. Enumerate the paths that can reach the effect (the
  ACTOR × TRIGGER habit above, applied to your own change), then write the test. And watch it fail
  first: on 2026-08-03 a static guard written to close exactly that gap was itself blind — it compared
  line text against a `switch` body, so an injected bypass matched as a substring of the switch's own
  `case` and every violation passed. The fail-before caught it; nothing else would have.

## Measurement and diagnosis

Performance and correctness claims are measurements, not impressions. Three ways this repo has been
wrong, each paid for.

- **Self time is not caller attribution.** A CPU profile's self time answers *where the CPU is*, never
  *who asked for it*. On 2026-08-02 that confusion produced a confident wrong culprit (the Board),
  reported to the human and handed to a delegated agent before re-profiling with caller attribution
  showed the real distribution. Before naming a cause, check that your instrument answers the question
  you are asking.
- **Measure frequency before cost.** A 13 ms path means something different at once per three seconds
  than at thirty times per second. Cost per call is the cheaper number to get and the easier one to
  act on, which is exactly why it gets reported first and anchors the whole diagnosis to the wrong
  axis.
- **When you suppress or coalesce, the trailing edge is the safety property.** Collapsing N events is
  lossless only because the event carries no payload — an invalidation says "this is stale", never
  what changed. Swallow the *last* one and the view is stale forever, with no second chance. Trading
  slowness for wrong data is the worse defect, so design the catch-up first and the suppression
  second (`t-b51923`, then SDD 485 Phase B one layer down).

## Visual and UI work

A green functional suite is not visual judgment. Any change a human LOOKS at — a new surface, a
layout, a shared token, a refinement — carries visual evidence from the headless browser harness or
the `visual-qa` skill. This lived in the verification list and kept being missed there, so it says
how, not only that.

- **Write the anchor BEFORE you build.** It states the intent the screen has to satisfy, in the
  reader's terms, and it comes from the task's problem statement — never from what the screen ended
  up looking like. An anchor written afterwards only proves the screenshot matches itself.
- **Measure at least two widths.** 880 and 360 are this repo's pair. A single width hides exactly
  the class of defect worth catching: lists whose per-row state collapses, containers with no bound,
  rows whose alignment only holds while there is room.
- **It is ADVISORY and never gates a merge.** It informs the person deciding. A verdict you disagree
  with is a measurement to check, not an order to obey.
- **The verdict is input to judgment, not the conclusion.** Measured on `t-aaad95`, where the run was
  useful and two of its own findings were still wrong: it reported poor contrast on buttons that
  measure 13.01, and called a legitimately `disabled` state a defect. Check what it claims before
  acting on it.
- **A shared token needs before AND after.** Changing something every surface uses — the button box,
  a spacing scale — cannot be judged from the surface that motivated the change. Measure the
  neighbours too, and anchor on NOT regressing them.
- **If the browser is unavailable, say so in the report.** Never skip in silence and never describe
  a screen you did not measure. "I could not run it" is information; an invented visual verdict is
  worse than none.

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
