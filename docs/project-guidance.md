# Tachyon repository guidance

This file is owned by the Tachyon repository. Tachyon transports it to agents because this
repository explicitly lists it under `settings.projectGuidance.files`; it is not product-global
policy and must not be imposed on projects that consume Tachyon.

## Bootstrap and verification

- Work from the repository root unless a command explicitly requires another directory.
- If dependencies are not present in the current checkout (for example, `node_modules` is absent),
  run `npm ci` before Node-based checks. Do not reinstall merely because the checkout is a worktree;
  reused or prepared worktrees may already have dependencies.
- Do not assume built `dist/` artifacts exist. Use the verification commands declared by this
  repository; the full verification path builds the artifacts it needs.
- Dev Host F5 (`Tachyon: Dev Host`) reads the dev-host of **the checkout you run it in** —
  `<checkout>/.tachyon/dev-host/`. Every checkout has exactly one, so two agents in two worktrees
  cannot collide: `cd` to YOUR worktree, arm it with `npm run dogfood:dev-host -- point --fixture
  <slug>`, verify with `point-status`, then ask the human to open VS Code THERE and press F5.
  `--worktree` is optional and only arms a different checkout. Spec 448 removed slots, the `active`
  pointer and the flags that selected them (`--owner`, `--slot`, `--activate`, `--no-activate`,
  `--require-owner`, `--all`); each now fails immediately naming its replacement.
- **After land / after dogfood:** `point-clear` → `point-status` (confirm it is gone) → remove the
  feature worktree, in that order: if the path disappears first, the pointer reports broken and a
  persistent engine may still be alive under it. Do not leave a pointed worktree after merge.
  See `docs/runbooks/dev-host.md` § After land.

## Verification economy

The gates are not negotiable; how often you pay for them is. These rules exist because a full suite on
this repository costs minutes of a single machine-wide lock that every agent queues behind, so a
redundant run is not free caution — it is time taken from someone else's gate.

- **While implementing, run focused tests.** The full suite belongs to the tree you deliver, not to
  each step that led there.
- **Deliver related changes as ONE batch, and pay the gate once for it.** Changes belong in the same
  delivery when they share a contract and would have to be reverted together; a fix and the test that
  proves it, a projector and the renderer it feeds, a rule and the guard that enforces it. Split them
  across deliveries and you buy N full suites for one idea — on a machine-wide lock, that is N-1 gates
  taken from other agents. Keep a focused, fail-before test per unit inside the batch, then run one
  `verify:full` on the combined final tree. Nothing about landing relaxes: that exact tree must still
  be the recorded one.
- **Batch by coherence, never by convenience.** Two unrelated fixes bundled to save a gate are a
  worse delivery, not a cheaper one: they cannot be reverted independently, and the review has to
  hold two contracts in its head at once. And a batch must never be a place to park something that
  fails — if part of it is red, the delivery is red. Padding a green batch with an unproven change is
  the one use of this rule that is dishonest rather than merely wasteful.

  A worked example, from this repository: `t-26f508` shipped a Grok config projector, its renderer,
  the Studio wiring, the profile plumbing and the docs as ONE batch — focused unit runs per piece
  while building, then a single full on that tree. Everything in it shared one contract and would have
  had to be reverted together. What followed is the other half of the lesson: review then found an
  upgrade hazard in that batch, and the fix was a SEPARATE delivery with its own gate, because it
  changed a different contract (the authority/upgrade path) and had to be revertible on its own.
  Re-verifying after `main` moved is neither of these — that is an integration round, not a batch.
- **Do not hand-manage reuse of an attested tree — just run the command.** `verify:full` decides for
  itself whether an identical tree already passed, and it decides BEFORE taking the lock, so a
  reused run costs nothing and blocks nobody. Skipping the command to save time is now the slower
  path: it trades a few seconds for a claim nobody can check. The decision belongs to
  `scripts/verify-full.mjs` (t-5d0e9d), which is its authority; `TACHYON_VERIFY_FORCE=1` overrides
  it, and `node scripts/verify-record.mjs check [<commit-ish>]` answers what is already on file.
  Why a tree and not a commit is § Landing order's rule, unchanged.
- **Do not start a full run while another legitimate holder has the lock.** Wait through the governed
  mechanism rather than racing it; a refused start is the mechanism working.
- **Say so when a run was reused or skipped.** Report which tree the green belongs to, so a reader can
  check the claim instead of trusting it. Silence is indistinguishable from forgetting.

## Reporting and handoff

- **A completion notify is a doorbell, not a report.** It carries status, commit, tree, the gate
  result, the ONE decisive finding, and a pointer to where the rest lives. Findings, evidence and
  reasoning go somewhere durable — the task journal (`append_task_note`) or a file — because a notify
  is best-effort pane input, not history.
- **Do not re-narrate what is already durable.** Merge history, integration rounds, why an approach
  was chosen and what a review said are in the journal and in git; repeating them in the report costs
  the reader's attention and the next agent's context, and adds no fact a reader could not already
  check. The test is whether a line changes what the recipient does next. "Blocked on X" and "the
  measurement refuted the design" pass it; "merged main, resolved conflicts, re-ran the gate" does
  not — that is the job, and the tree hash already proves it.
- **Hand off before you run out, not after.** When context is closing, commit or stage what exists,
  write a short handoff naming the exact next step, and request recovery. A precise unfinished report
  beats a finished-sounding one; work nobody can resume was not delivered.
- **Never report a green you did not get.** A check that could not run is not a check that passed, and
  a scenario whose precondition was satisfied trivially proved nothing.

## Review proportionality

Adversarial review is the most expensive check available and the only one that catches a plausible,
well-argued, wrong design. Spend it where being wrong is dear and hard to undo:

- **Ask for it** on architecture and contracts, irreversible or destructive decisions, authority and
  trust boundaries, security posture, migrations and upgrade paths, and any place two agents actually
  disagree about a premise.
- **Do not ask for it** on a mechanical edit whose contract is already settled — a rename, a
  measured-value update, a test that pins behavior nobody disputes. There the gate and a focused test
  already say everything a reviewer would, and a review round buys a second opinion on a question that
  was never open.
- The choice is the author's to make and to state. Say which one this delivery is and why, so a
  coordinator can overrule the call instead of guessing at it.

Proportional is not optional: a change in the first list that ships unreviewed is a gap, and the
recent record shows why — a review caught an upgrade hazard that a green gate could not, because the
gate proved the code worked and the reviewer asked what it did to workspaces that already existed.

## Post-landing hygiene

- **The owner removes a change worktree and its branch only when both are clean and contained in
  `main`.** `worktree_hygiene` already classifies this: `ready-to-remove` means clean, unoccupied and
  with no unique commits; `needs-review` means something would be lost. Removing on `needs-review`
  destroys work.
- **Preserve what is not contained**: uncommitted WIP, an occupied checkout, and commits that exist
  nowhere else. Preserve the persistent AGENT worktree unconditionally — it is an agent's working
  home, not a per-task checkout, and an agent that did its work there has nothing to remove.
- **A restart must not resurrect a closed task.** Finishing is a state the next launch reads, not one
  it re-derives. `selectAssignedWork` (`src/agents/assignmentSelection.ts`, t-9d250c) is the
  authority and already refuses it: only `active` can become a restarted session's contract. What is
  still yours is the report — a replayed spawn brief can name a task that has since closed, so say
  which task you are actually on rather than inheriting the brief's word for it.

## Release boundary

- **VS Code Marketplace publication is temporarily disabled.** In this repository, “generate a
  release”, “release”, or equivalent wording means: bump the version when requested, build the
  stable candidate, generate the local `.vsix`, run the packaged-artifact/provenance audit, and
  report its path and SHA-256. It does **not** authorize uploading or changing Marketplace state.
- Do not run `vsce publish`, `vsce unpublish`, Marketplace publishing/removal APIs, or equivalent
  Marketplace UI actions. Keep the audited `.vsix` local.
- Marketplace publication remains disabled until the human explicitly updates or revokes this
  project policy. A request to generate another release is not such a revocation.

## Git scope

- Preserve unrelated and pre-existing worktree changes. Inspect `git status` before staging.
- Stage only the files owned by the current task, using explicit pathspecs such as
  `git add -- path/to/file another/path`.
- Run staging and commit as separate commands. Never use `git add -A` or `git add .`, and do not hide
  the commit inside a compound `cd ... && git commit ...` command.
- Commit the same explicit path scope with one plain `git commit -m ... -- <paths>` invocation from
  the repository root. Include the Tachyon task id in the message when the work has one.

## Landing order

**The tree you land must be the tree you verified.** Everything below follows from that one rule; it is
what makes a green run evidence about `main` rather than about something that resembled it.

This is not satisfied by verifying twice. Several agents land on this trunk each hour, so the tree that
results from merging your work is a THIRD tree — neither parent — and two green parents can merge red
with no textual conflict. Nor is it satisfied by verifying the merge afterwards: `main` in this
repository is a shared checkout, and other agents branch from its `HEAD`, so a merge that sits there
unverified while a suite runs is a window in which someone can branch from unproven work.

So integrate first, verify the integrated result, then move the trunk to that exact commit:

1. `git merge main` INSIDE the change worktree.
2. Run the verification THERE.
3. Move `main` to the commit you just verified.

Step 3 is where the rule becomes checkable rather than remembered:

```bash
git rev-parse <verified-commit>^{tree}    # must equal
git rev-parse HEAD^{tree}                 # this, after the merge
```

Equal trees mean the content that landed is the content that was verified, and no second run is needed.
Different trees mean the trunk moved underneath you and the verification is stale — re-integrate in the
worktree and verify again. `git merge --ff-only <verified-commit>` enforces the same property by
refusing outright, which is preferable when history shape allows it.

Compare trees, not commits: a rebase or an amended message produces a different commit id for identical
content, and it is the content that was verified.

**Integrate once, at the end.** The trunk moves under you constantly, so re-merging after every
advance turns one delivery into an integration treadmill and re-buys the gate each lap. Do the
integration once, when the work is otherwise finished. If `main` then advances again before you land:
inspect whether it TOUCHED what you touched. No intersection — same files untouched, same contracts —
means one more merge and one more verified tree, not a re-litigation of the work. An intersection is
different in kind: read the other change semantically before merging, because two green parents can
merge red with no textual conflict, and then verify the new tree. Either way the rule above is
unchanged — what lands is the tree that was verified, and "it was green one merge ago" is not that.

Note the boundary: the pre-push gate cannot cover this. It runs at `git push`, and every step above
happens before the trunk is pushed anywhere.

## Localization ownership

- New or changed strings shown to people through the VS Code UI use `vscode.l10n.t(...)` or the
  corresponding injected host translation function, with localization bundles updated as needed.
- Text whose audience is a model or an orchestration protocol remains plain text. This includes
  Bridge tool descriptions, primer/project-guidance blocks, and agent-facing task or brief text;
  those strings are not forced into VS Code localization bundles.
