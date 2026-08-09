# 501 — review-at-the-land-door — notes

_Created 2026-08-09._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

### S1 — how a sidebar action reaches its command today, and the path this slice follows

Read before writing: `src/worktree/review.ts`, `reviewWorktreeDiff` (`extension.ts:624`), the
`tachyon.createWorktreePrItem` registration (`extension.ts:3566`), `SidebarPrototype.ts:72,84-85,530`,
`sidebar/actions.ts:25`.

**The path, end to end.** The sidebar webview posts `{ type: "action", actionId, agent, hash }`. The
host's `SidebarPrototypeProvider.runAction()` looks the id up in one table — `ACTION_CMD`
(`SidebarPrototype.ts:72`), where `reviewWorktree → "tachyon.reviewWorktreeItem"` and
`createPr → "tachyon.createWorktreePrItem"` — and calls
`vscode.commands.executeCommand(cmd, ...ws.shellCommandArgs({ kind: "agent", agentName, contextValue }))`.
The argument is a **duck-typed item**: the command handlers only ever read `ws`/`workspaceHash` and the
identity off it, which is why the retired tree view does not have to exist for this to work. The
handler then resolves the worktree record through the engine query `worktree.review`
(`extensionOperationService.ts:242` → `inspectWorktree`), and hands it to the shared flow.

**This slice follows exactly that path, with no second pattern invented.** The Worktrees webview posts
`worktreeReviewDiff` / `worktreeCreatePr`; `WorktreesPanel.action()` calls
`vscode.commands.executeCommand("tachyon.reviewWorktreeItem" | "tachyon.createWorktreePrItem",
{ workspaceHash, worktreeId })` — the same two command ids the sidebar dispatches to, the same
duck-typed-item convention, one more identity shape on the same engine query. The `workspaceHash` is
the panel's **immutable project** (`session.target.project`), never the row's `wsHash`, because that is
already this panel's rule for every other action it dispatches (SDD 485 D6).

**What is deliberately NOT new.** `reviewWorktreeDiff` stays the only place a changed file is picked
and the only caller of `vscode.diff`. It already had two thin resolvers in front of it —
`tachyon.reviewWorktreeItem` (agent, spec 213) and `tachyon.reviewPipelineItem` (run, spec 230) — so a
third identity resolved by the *same* query into the *same* flow is the established shape here, not a
fork of it. `test/unit/singleDiffReviewImplementation.test.ts` is the guard that keeps it that way.

### D2 (spec.md § Open question 1) — the land-door review compares COMMITTED state

**Answered by measurement, not by preference.** Measured in this worktree over a 130-file range
(`HEAD~12..HEAD`), ten iterations each:

| comparison | 10 runs | per call |
| --- | --- | --- |
| committed `git diff -z --name-status --find-renames --find-copies <trunk> <head>` | 109 ms | **10.9 ms** |
| working tree `git diff … <base>` + `git ls-files -z --others --exclude-standard` | 164 ms | **16.4 ms** |

The committed comparison is the **cheaper** of the two, which inverts the assumption in plan.md § D2
that it might cost more: it never stats the working tree and it drops the `ls-files` subprocess
entirely. Serving the current side from the commit is `git show <head>:<file>` ≈ 4 ms per file the human
actually opens — the same provider and the same cost class the BASE side has always paid, because the
content provider already takes `cwd` + `ref` in its URI query. And none of it runs on render: the diff
is computed at click, like everything else behind these two commands.

So the land door compares `trunkRef..head` — exactly the commits the land command would introduce. The
implementation cost matched the runtime cost: one optional `headRef` argument threaded through
`gitArgs.diffNameStatus` → `WorktreeManager.changedFiles` → the diff-sides descriptor. No new module,
no second parser, no fallback needed.

**The sidebar and pipeline callers keep the working-tree comparison.** They are answering a different
question — *what has this agent touched so far*, including work not yet committed — and that question
is the right one there. The two comparisons now differ by an argument on one function rather than by
two functions.

**The base is named on screen** either way, which was the other half of the open question: the land
block prints the range it will show (`<trunkRef> … <head> · committed`), and the quick-pick's
placeholder and each diff editor's title name both sides too. A human never has to infer what they are
looking at.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- **The routing does not live in `src/cockpit/`.** plan.md § Files touched named it as the place to
  follow the existing worktree-action pattern. `src/cockpit/` turned out to be the pure, synchronous
  model composer; the host that receives a Worktrees action and dispatches it is
  `src/webview/WorktreesPanel.ts`, which is where `worktreeRemove` / `worktreeForgetRecord` /
  `worktreeReleaseLock` are already handled. The instruction was followed, at the file that actually
  implements it.
- **The land door is keyed on the managed-worktree ID, not on an agent name.** Neither spec nor plan
  said which identity to use, and the obvious one — the agent, since that is what the sidebar sends —
  is wrong here: `land` is computed for every row not contained in the trunk
  (`ManagedWorktreeService.listClassified`), including `change` rows that have no agent. Keying on the
  agent would have silently skipped half the rows that have something to land. So `worktree.review`
  gained a third identity beside `agent` and `runId`, which is additive on the same query.
- **`landCommandNeverExecuted.test.ts` was not touched**, as plan.md § D4 requires, and it is green.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- **One `changedFiles` with an optional `headRef`, not two functions.** A `changedFilesBetween`
  sibling would have read more explicitly at the call site and cost a second place for the parse, the
  rename handling and the error behaviour to drift apart. The two questions differ by one git argument;
  making them differ by one function argument keeps that true. Given up: a slightly less obvious call
  site, which the parameter name and the doc comment carry.
- **A third thin resolver in front of `reviewWorktreeDiff`, not a third flow.** The alternative
  considered and rejected was resolving the record in the panel host and calling a review helper
  directly, which would have been fewer hops — and would have put a second place that knows how to
  turn a worktree into a diff. Two doors to one implementation is what this spec is about.
- **`git show <head>:<file>` for the current side, not a temp checkout.** The content provider already
  takes `cwd` + `ref`, so this cost one branch in the URI builder. Given up: nothing measurable — the
  base side has always been read this way.

## Visual QA

_Run 2026-08-09 against the anchor written from spec.md § Intent, before the buttons existed. Harness:
`test/browser/landDoorActionsShots.test.ts` (headless Chrome, the production sheet list), widths 880
and 360. Screenshots: `.tachyon/visual-qa/t-3eaf77-land-door/`._

**The anchor.** A person at the land block, deciding whether this branch becomes the trunk, can get to
the code from where they are standing — without the trip to a terminal that all seven of 2026-08-09's
merges made. And the block still has to read as ONE decision (Land), with Propose distinguishable from
it at a glance on a repository that never opens a PR, and with the review's base readable in full at
any width.

**Verdict: the anchor is met, after two wording changes the screenshots caused.**

- *One decision.* At both widths exactly one emphasised control exists on the whole surface — Land's
  `Copy command`. Review and Propose are `default` buttons on their own row below a rule. Measured, not
  eyeballed: the harness asserts `primaryButtons === 1`. This is the answer to spec.md § Open question
  2 — **below, not beside**. Beside Land would have made three buttons of equal weight out of one
  decision and two preparations for it.
- *Blocked land.* Both doors stay, and the command still does not appear. That is deliberate: a red
  check is exactly when a human wants to look at the code, and reviewing is not landing.
- *360.* The buttons stack, the compare sentence wraps in full, no clipping and no horizontal scroll.
- **Changed as a result of looking:** the sentence read *"Review shows main … 9f3c1ab27d5e — the
  committed commits this command would land"*. Two defects only visible in the render: "committed
  commits" is clumsy, and the `…` reads as elision — as though the sha had been truncated — rather than
  as a range. Now: *"Review shows main..9f3c1ab27d5e — the commits this command would land, not the
  working tree."* Git's two-dot range is unambiguous to the reader this block is written for.

**What this run could NOT measure, stated rather than skipped:** the quick-pick the review opens and
the diff editor behind it are VS Code's own chrome. A headless browser renders the webview and nothing
else, so there is no screenshot of either here, and none is invented. What is proved instead is the
negative that matters — the block renders no diff markup of its own at either width. The maintainer
inspects the picker in the dev host before this lands, which is where that surface can actually be
seen.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- **`l10n/bundle.l10n.json` and the i18n gate do not see webview strings.** `test/unit/i18n.test.ts`
  scans for the literal `l10n.t(`, so every string routed through `WorktreesPanel`'s
  `const t = vscode.l10n.t` alias — the whole land block, and now these four — is invisible to it. The
  translations were added by hand here, as the existing ones were. Pre-existing and out of this spec's
  scope; worth a task, because a gate that silently covers less than it appears to is the shape this
  repository has been burned by before.
