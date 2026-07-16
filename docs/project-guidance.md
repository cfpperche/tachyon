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
  `${workspaceFolder}/.tachyon/dev-host`. `npm run dogfood:dev-host -- point|point-status|point-clear`
  auto-redirects to the primary checkout when invoked from a linked git worktree; still pass
  `--worktree` for the feature checkout and verify with `point-status` before asking the human to F5.

## Git scope

- Preserve unrelated and pre-existing worktree changes. Inspect `git status` before staging.
- Stage only the files owned by the current task, using explicit pathspecs such as
  `git add -- path/to/file another/path`.
- Run staging and commit as separate commands. Never use `git add -A` or `git add .`, and do not hide
  the commit inside a compound `cd ... && git commit ...` command.
- Commit the same explicit path scope with one plain `git commit -m ... -- <paths>` invocation from
  the repository root. Include the Tachyon task id in the message when the work has one.

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
