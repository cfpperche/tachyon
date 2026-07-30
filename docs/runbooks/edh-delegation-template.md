# Dev Host lane delegation template v1

Copy this block without weakening its ownership or isolation clauses.

```text
Dev Host target: worktree | main | vsix (choose exactly one)
Owner: <one agent or coordinator name>
SHA / VSIX identity: <immutable identity>
Scenario: <bounded scenario>

You own the Dev Host dogfood lane from lease acquisition through evidence capture and cleanup.
Acquire with
`node scripts/dev-host/lane.mjs acquire --owner <owner> --target <target>` and stop if it is busy.
Do not steal or release another owner's lease. Use only the seeded fixture, private
user-data/extensions/cache/tmux paths, and the chosen immutable extension bits. Do not open the
monorepo as the Dev Host workspace, reload a normal window, install a VSIX unless this delegation
explicitly selects `vsix`, access secrets, log raw model catalogs, or make an inference call.
Only the owner may drive desktop input. Observers are read-only.

Record the target, owner, SHA, scenario, pass/fail, and bounded evidence path. Clean only the printed
fixture and release with the matching owner. Report any abandoned lease rather than removing it.
GUI/desktop activity requires an explicit coordinator-owned step; automated headless dogfood does not
authorize it.

Primary CLI: npm run dogfood -- dev-host
F5 pointer: npm run dogfood -- dev-host -- point|point-status|point-clear
Runbook: docs/runbooks/dev-host.md
```
