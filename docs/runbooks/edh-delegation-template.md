# EDH lane delegation template v1

Copy this block without weakening its ownership or isolation clauses.

```text
EDH target: worktree | main | vsix (choose exactly one)
Owner: <one agent or coordinator name>
SHA / VSIX identity: <immutable identity>
Scenario: <bounded scenario>

You own the EDH lane from lease acquisition through evidence capture and cleanup. Acquire with
`node scripts/edh-palliative/lane.mjs acquire --owner <owner> --target <target>` and stop if it is busy.
Do not steal or release another owner's lease. Use only the seeded fixture, private user-data/extensions/cache/tmux
paths, and the chosen immutable extension bits. Do not open the monorepo as the EDH workspace, reload a normal
window, install a VSIX unless this delegation explicitly selects `vsix`, access secrets, log raw model catalogs, or
make an inference call. Only the owner may drive desktop input. Observers are read-only.

Record the target, owner, SHA, scenario, pass/fail, and bounded evidence path. Clean only the printed fixture and
release with the matching owner. Report any abandoned lease rather than removing it. GUI/desktop activity requires
an explicit coordinator-owned step; automated headless dogfood does not authorize it.
```
