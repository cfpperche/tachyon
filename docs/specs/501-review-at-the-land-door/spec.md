# 501 — review-at-the-land-door

_Created 2026-08-09._

**Status:** implemented

<!-- The maintainer owns the intent; this is a transcription awaiting ratification.
     Read § "What already exists" first. This spec builds almost nothing — the finding that
     shaped it is that both features were already written and are in the wrong room. -->

## Intent

The land block asks a human to decide whether a branch becomes the trunk. It shows five checks and a
command to copy. **It does not offer a way to look at the code.**

So the human leaves. Measured on the coordinating agent's own behaviour, 2026-08-09: every one of the
day's merges was reviewed by running `git diff` in a terminal and reading the output there. Seven
merges, seven trips outside the product.

### What already exists

This is the part that changes the size of the work.

**Diff review is built** — spec 213 / 230. `tachyon.reviewWorktreeItem` quick-picks the worktree's
changed files and opens each in **VS Code's native diff editor** (`extension.ts:645`,
`vscode.commands.executeCommand("vscode.diff", …)`). `src/worktree/review.ts` parses
`git diff --name-status -z`, decides which side of a rename or delete is empty, and is unit-tested
without git. A content provider serves the base side.

**PR creation is built** — spec 223. `tachyon.createWorktreePrItem` probes readiness at click (no `gh`
spawn per refresh), shows an editable title and a modal body preview, then runs `gh pr create`.

Both are reachable — from the **sidebar agent row** (`SidebarPrototype.ts:84-85`,
`sidebar/actions.ts:25`). Neither is in the command palette (`package.json` gives both
`"when": "false"`), and neither appears in the Worktrees app where the land block lives.

**Nothing here needs a diff renderer, a hunk-staging UI, or a webview diff.** VS Code already ships
the best diff viewer we could put in front of this, and the product already opens it.

### So the defect is placement, not absence

The features are one room away from the decision. A human standing at the land block — five green
checks, a command on the clipboard — is given no path to the diff and no path to a PR from there.

This is adjacent to the class swept in `t-e50995`, but it is not the same: those five had **no**
production caller. These two have one, in the wrong place.

### What this spec does not settle

Whether this project adopts pull requests is a separate decision the maintainer is weighing. This spec
makes **Propose** reachable where **Land** is offered; it does not make either mandatory, and it does
not change what land does.

## Acceptance criteria

- [x] **Scenario: look before landing**
  - **Given** a worktree row whose land block is rendered
  - **When** the human wants to see what would land
  - **Then** the block offers it from there, and choosing it opens the changed files in VS Code's
    native diff — not a diff drawn by Tachyon

- [x] **Scenario: nothing to look at**
  - **Given** a branch with no changes against the trunk
  - **When** review is offered
  - **Then** it says so plainly instead of opening an empty picker

- [x] **Scenario: what you review is what would land**
  - **Given** a land block that is ready
  - **When** the diff is opened
  - **Then** it covers exactly the commits the land command would introduce, and the base it compares
    against is named on screen

- [x] **Scenario: propose instead of land**
  - **Given** a worktree row with a branch and a remote
  - **When** the human chooses to propose rather than land
  - **Then** the existing PR flow runs — readiness probed at click, title editable, body previewed,
    `gh pr create` only after confirmation

- [x] **Scenario: no forge, no door**
  - **Given** a repository with no remote, or no `gh`
  - **When** the row is rendered
  - **Then** Propose is absent or refuses by naming what is missing, and Land is unaffected

- [x] Land keeps working exactly as it does today: five preconditions, a command shown and copyable,
      and the product never runs the merge.
- [x] No diff is rendered by Tachyon. If a change adds one, this spec was misread.

## Non-goals

- **Building a diff viewer.** VS Code's is already opened by this product.
- **Per-hunk staging or cherry-picking across agents.** Orca's three-pane hunk picker exists because
  they fan one prompt across several agents and merge the winners
  (`docs/research/orca-orchestration-task-lifecycle-land.md`). Tachyon does not do that, and building
  the UI for a workflow we do not have is how machinery ends up without an inlet.
- **Review comments, threads, or approvals.** Adversarial review here is an agent reading the diff,
  and that already works.
- **Making the product press the merge.** That is SDD 498, still unbuilt, and unchanged by this.
- **Adopting pull requests as this project's workflow.** Separate decision.
- **Removing the sidebar entry points.** Two doors to one feature is fine; one door in the wrong room
  is not.

## Open questions

**Both answered during the build — the reasoning and the measurements are in `notes.md`.**

1. **Answered: committed.** The land door compares `trunkRef..head`. Measured cheaper than the
   working-tree comparison (10.9 ms vs 16.4 ms over a 130-file range), so the fallback in plan.md § D2
   was never needed. The base is named on screen. See `notes.md` § D2.
2. **Answered: below Land, not beside it.** Decided by looking, at 880 and 360, against the anchor.
   Land's copy action is the only emphasised control; the two doors are secondary buttons on their own
   row behind a rule. See `notes.md` § Visual QA.

---

1. **What the review compares.** `reviewWorktreeDiff` diffs `rec.baseRef` against the **working tree**
   (`extension.ts:645` uses `vscode.Uri.file(...)` for the current side). Land is about committed
   history — `trunkRef..head`. While `worktree-clean` is green these coincide; when it is red they do
   not, and review would then show something land refuses. Decide whether the land-door review compares
   committed state, and say so on screen either way.
2. **Where Propose sits relative to Land.** Side by side invites the wrong click on a repo that never
   uses PRs; hidden behind a menu is what got us here. Deciding this is Visual QA's job, not the
   plan's.
