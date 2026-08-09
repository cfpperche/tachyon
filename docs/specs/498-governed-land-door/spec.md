# 498 — governed-land-door

_Created 2026-08-09. Rewritten the same day, after an adversarial review demolished the first draft._

**Status:** draft

<!-- The maintainer owns the intent; this is a transcription awaiting ratification.
     The first draft and the review that killed it are in git history and in notes.md.
     Read notes.md before re-litigating anything here — most of the obvious objections
     were already raised, measured, and answered there. -->

## Intent

`src/worktree/land.ts` probes five preconditions and, when all five are green, composes the exact
command for the primary checkout. Then it puts that string on the clipboard and stops. The human
opens a terminal and pastes.

**This spec replaces the paste with a button.** That is the whole change.

### The reason, stated honestly, because the first draft got this wrong

The first draft argued that pasting was *unsafe*: that the pinned sha protected the tree but nothing
protected the directory. **That was factually false** — `landCommand` already emits
`git -C <primaryPath> merge --ff-only <sha>`, so the clipboard carries the directory and the command
works from any cwd. It also leaned on "eight hand-run merges, three broke the trunk" from `land.ts`'s
header. That number is real, but it measures the world *before* the suggest-and-copy panel existed —
it justifies the panel, not this. **No trunk breakage has been measured since.**

So the reason is not correctness. It is this, from the maintainer, on being told the review found no
defect to fix:

> "eu vou ter que ficar digitando comando git?"

**"I don't want to type git" is a sufficient product reason.** It does not need a measured defect
behind it. What this spec must not do is dress ergonomics up as safety — the first draft did, and an
adversarial review took it apart in an hour.

### What the review changed, and why the scope is now small

Every mechanism the first draft proposed was refused, each because something that already exists does
the job (`notes.md` has the measurements):

| first draft | what replaced it |
|---|---|
| a durable undo ledger written before the merge | nothing — `git merge` already writes `ORIG_HEAD` and the branch reflog |
| a mutex for two simultaneous clicks | nothing — ref update is already compare-and-swap; measured: one wins, the other gets an expected-old refusal, checkout clean |
| refuse when an agent or terminal occupies the primary | nothing — git already refuses concurrent git operations through its own locks |
| "re-probing at click closes the race" | it does **not** close it; it narrows it. Said out loud instead of promised away. |
| a guard proving "exactly one call site" | the rule that matters is that no agent-facing door exists |

What remains is a button, an engine operation, and honest wording.

### The window, named rather than closed

Between the engine re-measuring and git running, another actor can change the primary checkout.
Measured on git 2.53.0: the probe saw `main` and a green fast-forward; a `switch other` landed in the
window; the same `git merge --ff-only <sha>` advanced `other` and left `main` untouched. Git moves
whatever `HEAD` points at when the command starts — it does not know the intention "move main".

**This window exists today and is larger**: it runs from the moment the human copies to the moment
they paste. The button shortens it from minutes to milliseconds. It does not remove it, and this spec
does not claim to.

## Acceptance criteria

- [ ] **Scenario: the human lands**
  - **Given** a delivery whose five preconditions are green
  - **When** the human presses Land in the worktree row
  - **Then** the engine re-measures the five, runs the command shown on screen, and reports the trunk
    head before and after

- [ ] **Scenario: something changed while the panel sat there**
  - **Given** a rendered Land action
  - **When** a precondition has turned red since it was drawn
  - **Then** the trunk is not touched and the block re-renders naming the condition that changed

- [ ] **Scenario: the row heals itself**
  - **Given** a land that succeeded
  - **When** the worktree list refreshes
  - **Then** that delivery is now contained in the trunk, so the land block is gone and the row sits
    with the removable ones — no separate step tells the UI what happened

- [ ] **Scenario: undo, from what git already recorded**
  - **Given** a land the product performed
  - **When** the human wants it back
  - **Then** the product shows the previous trunk head and `git -C <primary> reset --hard <predecessor>`,
    read from the reflog, and the offer disappears once the trunk has moved on or the reflog no longer
    holds it

- [ ] **Scenario: two clicks**
  - **Given** two green deliveries landed at the same moment
  - **When** both acts run
  - **Then** one succeeds and the other reports git's own refusal verbatim; nothing is queued,
    serialised or retried by Tachyon

- [ ] **Scenario: an agent tries**
  - **Given** any agent with Bridge access
  - **When** it looks for a way to land
  - **Then** there is none — the operation is reachable only from the Interface

- [ ] The command stays visible on screen before and after, and Copy still works.
- [ ] Tachyon writes no state of its own for undo, occupancy, or serialisation.
- [ ] The product never lands on its own: green is information, not permission.

## Non-goals

- **Pushing.** The trunk moved locally; sending it anywhere stays a human step.
- **Removing the worktree or the branch.** That is Forget, and it stays separate.
- **Any integration but fast-forward.** `--ff-only` is what makes the landed tree byte-identical to
  the proved tree, which is what the whole evidence model rests on.
- **Closing the probe-to-act window.** Named above. A Tachyon mutex would not be respected by an
  external terminal anyway, and would be a subsystem for a risk never measured in production.
- **Changing what counts as proof.** That is SDD 497.
- **Auto-land, scheduled land, hook-triggered land, agent-triggered land.**

## Open questions

None blocking. The four the first draft carried were answered by the review and folded above: the act
runs in the engine through an Interface-only typed operation (never `HostActionBroker`, which is the
Bridge's door and would be exactly the agent-facing path this forbids); undo comes from the reflog;
occupancy is ignored; concurrency is git's compare-and-swap.

One thing to decide while building, not before: **what the button says when a precondition is red.**
Today the block renders a blocked message and no command. It should stay refusing rather than offering
a disabled button — a control that exists and cannot be pressed is the pattern this project has been
removing all week.
