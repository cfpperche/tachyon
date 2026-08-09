# 501 — plan

_Created 2026-08-09._

## Approach

Two actions appear on the worktree row where the land block already renders. Both dispatch to commands
that already exist. Almost nothing new is written.

## Decisions

### D1 — reuse the commands, do not reimplement

`tachyon.reviewWorktreeItem` and `tachyon.createWorktreePrItem` are registered in `extension.ts`
(`:3565` for the PR one) and already wired from the sidebar via `SidebarPrototype.ts:84-85` and the
action kinds in `sidebar/actions.ts:25`.

The Worktrees app posts an action; the host dispatches to the same command. **If this slice grows a
second implementation of either flow, it is wrong** — that is the `scripts/host-resources.mjs` mistake
this project deleted the same day.

### D2 — the review compares committed state, and the base is named

spec.md § Open question 1. `reviewWorktreeDiff` currently compares `rec.baseRef` against the working
tree. From the land door, the honest comparison is what the land command would introduce:
`trunkRef..head`.

Two paths, and the cheaper one is probably right: pass the refs the land block already computed
(`land.ts` returns `head`, `trunkRef`, `branch`, `primaryPath`) into the existing flow, so the current
side reads from the commit rather than the file on disk. The content provider that already serves the
base side is the mechanism — it takes `cwd` and `ref` in its URI query (`extension.ts:645`).

**Measure before choosing.** If serving both sides from refs is more than a small change, the fallback
is to keep the working-tree comparison and state the base and the cleanliness precondition on screen,
so the human is never misled about what they are looking at. Record which, and why, in `notes.md`.

### D3 — Propose is offered only when it can work

`createWorktreePrItem` already probes readiness at click and refuses by naming the reason
(`extension.ts:3582`). That behaviour is kept — the row does not pre-spawn `gh` on every refresh, which
is a property spec 223 deliberately bought.

The row shows Propose when the worktree has a branch. A repository with no remote or no `gh` gets the
existing refusal, not a hidden button and not a silent no-op.

### D4 — Land is untouched

`landCommandNeverExecuted.test.ts` holds the line that the product never runs the merge. Nothing in
this spec goes near it, and the test must stay green without modification. If it needs editing, stop.

## Files touched

- `src/webview/worktrees/App.tsx` — two actions in the land block area
- `src/webview/worktrees/messages.ts` — the action payloads
- `src/cockpit/` — routing the action to the host, following whatever pattern the existing worktree
  actions use (read it first; do not invent a second one)
- `src/extension.ts` — dispatch the two actions to the existing commands; the ref-based diff from D2
- `l10n/` — the two labels and any refusal text
- tests: the new actions dispatch; the empty-changes case; a guard that no second implementation of
  either flow appears

## Risks

- **Reimplementation by accident.** The single largest risk is an agent writing a new PR or diff flow
  because the existing one is in a file it did not read. D1 exists for this.
- **The working-tree/committed gap.** Named in D2. Getting it wrong means the human reviews something
  other than what lands — which is worse than not offering review at all, because it looks like proof.
- **Button placement.** spec.md § Open question 2. Propose next to Land on a repo that never opens a PR
  is a misclick waiting to happen. Visual QA decides.
