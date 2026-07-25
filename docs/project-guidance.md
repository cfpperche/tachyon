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
- Dev Host F5 (`Tachyon: Dev Host`) always reads the **monorepo window** pointer at
  `${workspaceFolder}/.tachyon/dev-host` (`active` → `slots/<owner>/`). Multi-slot: agents arm with
  `npm run dogfood:dev-host -- point … --owner "$TACHYON_AGENT_NAME"`. `point|point-status|point-clear`
  auto-redirect to the primary checkout when invoked from a linked git worktree; still pass
  `--worktree` for the feature checkout and verify with `point-status` before asking the human to F5.
- **After land / after dogfood:** `point-clear --owner <you>` → `point-status --all` → remove the
  feature worktree. Do not leave a pointed worktree after merge; do not `point-clear --all` unless
  intentionally resetting every slot. See `docs/runbooks/dev-host.md` § After land.

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

Note the boundary: the pre-push gate cannot cover this. It runs at `git push`, and every step above
happens before the trunk is pushed anywhere.

## Product invariant testing

- Before implementing a behavior-changing Task or SDD spec, declare
  `Affected Product Invariants: PI-*` or `Affected Product Invariants: none — <reason>`.
- Follow `docs/architecture/product-invariant-testing.md`: Product Invariant names the stable promise;
  `e2e`/full-stack names only an execution topology. Do not derive or relax the registered fixed oracle.
- When a `PI-*` promise intentionally changes, land the ratified product decision, registry metadata and
  executable assertions together. Run `npm run test:invariants` for affected entries.

## Localization ownership

- New or changed strings shown to people through the VS Code UI use `vscode.l10n.t(...)` or the
  corresponding injected host translation function, with localization bundles updated as needed.
- Text whose audience is a model or an orchestration protocol remains plain text. This includes
  Bridge tool descriptions, primer/project-guidance blocks, and agent-facing task or brief text;
  those strings are not forced into VS Code localization bundles.
