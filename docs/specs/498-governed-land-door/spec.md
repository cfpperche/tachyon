# 498 — governed-land-door

_Created 2026-08-09. Rewritten the same day, after an adversarial review demolished the first draft.
Revised 2026-08-11 (t-7cb971): the post-panel measurement the review looked for and could not find now
exists, and the four questions this spec must answer out loud — where the action lives, who may press
it, what every refusal says, and what happens when the trunk moves between the proof and the click —
are answered here instead of left to the build._

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
it justifies the panel, not this.

So the reason is not correctness. It is this, from the maintainer, on being told the review found no
defect to fix:

> "eu vou ter que ficar digitando comando git?"

**"I don't want to type git" is a sufficient product reason.** It does not need a measured defect
behind it. What this spec must not do is dress ergonomics up as safety — the first draft did, and an
adversarial review took it apart in an hour.

### What changed on 2026-08-11, and exactly how much it proves

The review's own limits section (`notes.md`) records that it could not verify *"qualquer quebra de
trunk … ocorrido **depois** da entrega de suggest-and-copy"*. That absence was the stated reason the
safety argument was struck. **That measurement now exists** (t-7cb971, journal `j-8dc923c6692e`):

> 22 merges in one day. The trunk moved during the operator's own verification **twice** — once
> between two consecutive calls. In one of them **the tree that landed was not the tree that had been
> proved**, caught only by checking the hash after the fact.

Read it precisely, because it is easy to over-claim:

- It was measured on merges run **by hand**, not through the panel. It does not show the panel
  computing a wrong answer. It shows the panel being **bypassed** — which is what a suggestion is
  always free to be.
- The condition that would have caught all three events is `fast-forward`, which the panel already
  computes correctly and already withholds a command for.

So the honest claim is narrow and it is not "the button is safer than the paste":

> **The button makes measuring and acting one gesture, so the act cannot be performed on evidence
> nobody consulted.** A suggestion is advice a hurried human skips; a button is a check they cannot
> route around without leaving the product entirely.

That is ergonomics in its mechanism and safety in its effect. Stating it as anything stronger would
repeat the first draft's mistake. Nothing below rests on it: the button is justified by the
maintainer's sentence alone, and this measurement only removes the review's stated reason for
demoting it.

### The five preconditions are the five that exist — no more

They come from `src/worktree/land.ts`, which is in the trunk and already computes them:
`worktree-clean`, `verified-tree`, `fast-forward`, `primary-on-trunk`, `primary-clean`.

**This spec adds none.** The task body (`t-7cb971`) listed five of its own, and two of them cannot be
checked because the machinery is gone, and one is a different act's precondition — measured and
recorded in `j-c51d4495e333`:

| listed in the task | disposition |
|---|---|
| verify:full attestation | **kept** — `readVerificationRecord`, keyed by tree |
| delivered head contained in the base | **kept** as `fast-forward` — the tool died, the primitive in `classify.ts` did not |
| `integratePrincipals` authorized | **impossible** — `settings.gitDelivery` is retired and ignored; there is nothing left to authorize against |
| worktree clean **and unoccupied** | **clean kept, unoccupied dropped** — an agent is normally still alive in its checkout when its work lands; requiring an empty checkout would refuse every ordinary delivery |
| trunk has not moved since integration | **kept** — it is the same question as `fast-forward`, asked once so the two answers can never disagree |

`integratePrincipals` also has nothing to protect here: the acting principal is the human at the
keyboard, and there is no agent-facing door to authorize (see *Who may press it*).

## The door

### Where it appears

In the **land block already on the worktree row** — Control → Worktrees, on a row carrying work the
trunk does not contain — beside the command it already shows. The block, its five checks and its Copy
button were delivered on 2026-08-07; SDD 501 later hung Review and Create PR from the same block. This
spec adds one control to a surface that already exists and opens no new one.

**When a precondition is red there is no button at all** — not a disabled one. The block keeps doing
what it does today: it names the failed conditions and offers nothing. A control that is visible and
cannot be pressed is the pattern this project has been removing.

### Who may press it

The Interface, and nothing else. The act is an Interface-only typed extension operation
(`worktree.land`), the same grammar as `worktree.remove-managed`: the webview posts it, the engine
re-validates fail-closed, and no Bridge tool dispatches extension operations.

It is deliberately **not** a `HostActionBroker` capability. That broker resolves an agent-scoped
Bridge token and refuses callers that are not agents (`src/host-action/policy.ts`) — registering the
land door there would create precisely the agent-facing path this spec forbids, whatever the word
"host action" suggests.

The actor × trigger list, which is also the test-case list:

| actor | trigger | outcome |
|---|---|---|
| Interface | presses Land on a green block | the engine re-measures, then runs the act |
| Interface | presses Land on a block that has gone red since it was drawn | refused by name; the trunk is not touched |
| Interface | presses Land in two windows at once | git's compare-and-swap decides; one wins, the other reports git's own refusal |
| Agent | any Bridge tool, including `run_host_action` | **no door exists** — nothing reaches the operation |
| Agent | works in the delivering checkout while the human lands | irrelevant: the act names a sha, not a branch |
| Tachyon | hygiene sweep, schedule, poll, reload | **never lands** — green is information, not permission |
| Tachyon | engine unreachable | the button refuses; there is no extension-host fallback |
| Tachyon | engine restarts mid-act | no Tachyon state to reconcile; the next refresh reads live git and says what is true |

### What every refusal says

A refusal that names only what failed sends the human back to git to work out why. Each of these
names **the exit**. They are contract, not implementation detail.

They are also the *same* sentences the block already renders when a check is red at draw time. One
vocabulary, one place: whether a condition was red when the panel drew it or turned red under the
click, the human reads the same words.

- **`worktree-clean`** — "The delivering worktree has uncommitted changes. Commit or discard them in
  `<worktree>`, then land again — anything left behind is neither in the tree that was verified nor in
  the tree that would land."
- **`verified-tree`** — "Nothing has proved the tree at `<head>`. Run the declared verify gate in
  `<worktree>` and commit nothing after it, then land again — the tree you land must be the tree you
  verified." *(Unmeasurable variant: "there is no commit to attest.")*
- **`fast-forward`** — "`<trunk>` has moved to `<trunk-head>` and is no longer contained in `<head>`,
  so this is no longer a fast-forward. Integrate `<trunk>` into `<branch>` and run the verify gate
  again — the combined tree is the one that would land, and nothing has proved it yet."
  *(No local trunk: "this repository has no local trunk branch to fast-forward; create or check out
  the local trunk — a remote-only trunk cannot be fast-forwarded." Unmeasured: "ancestry could not be
  measured and is treated as unsafe; check that git can run in `<worktree>` and that `<trunk>`
  resolves.")*
- **`primary-on-trunk`** — "The primary checkout at `<primary>` has `<other>` checked out, not
  `<trunk>`. Check out `<trunk>` there and land again — a fast-forward run against the wrong branch
  moves the wrong ref, and it would not fail while doing it." *(Detached or unreadable branch, and
  "the primary checkout could not be located from this worktree; run the command yourself in the
  checkout that owns this repository's `.git` directory", keep their existing wording.)*
- **`primary-clean`** — "The primary checkout at `<primary>` has uncommitted changes. Commit or
  discard them there, then land again — a fast-forward carries them onto the trunk's new state, where
  nobody verified them."
- **git refused the act** — git's own message, verbatim and unsummarised, plus: "The trunk was not
  moved by this attempt. Refresh the row and look again — another actor may have moved it."
- **the act moved something else** (the window below) — "`<trunk>` is unchanged at `<before>`; the
  merge advanced `<other>` instead, because that is what `HEAD` pointed at in `<primary>` when it ran.
  Put it back with `git -C <primary> reset --hard <ORIG_HEAD>`, check out `<trunk>` there, and land
  again."

**No refusal is delivered only as a toast or a status-bar line.** It renders in the block, where it
has room to be read and stays put. This repository has already paid for the other shape twice —
`t-2656d7`, where the right instruction existed and died truncated in a one-line status bar, and
`t-7d6013` (commit `e0ed543f`), where a discard decision lived only in a toast that vanished.

### When the trunk moves between the proof and the click

Three different moments, three different answers, and the third one is **not closed**:

1. **Between the gate and the click** — the common case, and the one measured on 2026-08-11. The
   click re-measures before acting, `fast-forward` goes red, and the act is refused with the
   integrate-and-reverify exit above. The trunk is not touched. *This is the case the door exists for:
   the operator with git in hand did not refuse, and a door that checks would have.*
2. **Between the re-measure and git starting** — narrowed, not removed. If the trunk moved, git's own
   `--ff-only` refuses and the ref update is compare-and-swap; the honest claim is *this invocation
   made no partial update*, never *the trunk is unchanged*, because another invocation may have moved
   it. Reported as git's refusal, verbatim.
3. **If `HEAD` in the primary checkout changes branch inside that same window** — git moves whatever
   `HEAD` names when the command starts; it does not know the intention "move the trunk". Measured on
   git 2.53.0: the probe saw `main` green, a `switch other` landed in the window, and the same
   `git merge --ff-only <sha>` advanced `other` and left `main` untouched. **No mechanism here closes
   this**, and a Tachyon mutex would not be respected by an external terminal anyway. What this spec
   requires is that it be **loud instead of silent**: the act reads the trunk before and after, and a
   trunk that did not arrive at the expected sha is reported with the recovery above rather than
   counted as a success.

This window exists today and is larger — it runs from the moment the human copies to the moment they
paste. The button shortens it from minutes to milliseconds. It does not remove it, and this spec does
not claim to.

## Acceptance criteria

- [ ] **Scenario: the human lands**
  - **Given** a delivery whose five preconditions are green
  - **When** the human presses Land in the worktree row
  - **Then** the engine re-measures the five, runs the command shown on screen, and reports the trunk
    head before and after

- [ ] **Scenario: something changed while the panel sat there**
  - **Given** a rendered Land action
  - **When** a precondition has turned red since it was drawn
  - **Then** the trunk is not touched and the block re-renders naming the condition that changed, in
    the same words it would have used had the condition been red at draw time

- [ ] **Scenario: the trunk moved after the gate ran** *(the measured one)*
  - **Given** a delivery that was green, and a trunk that has since advanced past its base
  - **When** the human presses Land
  - **Then** nothing is merged, and the refusal tells them to integrate the trunk into the branch and
    re-run the verify gate — naming both refs and the trunk's new head

- [ ] **Scenario: every refusal names an exit**
  - **Given** any one of the five preconditions failing, in any of its measured and unmeasured forms
  - **When** the act is refused
  - **Then** the message says what to do next, names the paths and refs involved, and renders in the
    block rather than only in a toast or a status-bar line

- [ ] **Scenario: the act moved a different branch**
  - **Given** a land whose primary checkout changed branch inside the probe-to-act window
  - **When** the act completes
  - **Then** it is reported as a failure naming the branch that actually moved, the trunk's unchanged
    head, and the `reset --hard` that undoes it — never as a successful land

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
  - **Given** any agent with Bridge access, including `run_host_action`
  - **When** it looks for a way to land
  - **Then** there is none — the operation is reachable only from the Interface, and no host-action
    capability, Bridge tool or MCP tool names it

- [ ] **Scenario: the engine is unreachable**
  - **Given** no engine to serve the typed operation
  - **When** the human presses Land
  - **Then** the button refuses and says so; nothing falls back to the extension host

- [ ] A red precondition renders **no** Land button, disabled or otherwise.
- [ ] The command stays visible on screen before and after, and Copy still works.
- [ ] Tachyon writes no state of its own for undo, occupancy, or serialisation.
- [ ] The product never lands on its own: green is information, not permission.
- [ ] The guard that replaces `landCommandNeverExecuted` asserts the **absence of an agent-facing
      door**, not a call-site count.

## Non-goals

- **Pushing.** The trunk moved locally; sending it anywhere stays a human step.
- **Removing the worktree or the branch.** That is Forget, and it stays separate.
- **Any integration but fast-forward.** `--ff-only` is what makes the landed tree byte-identical to
  the proved tree, which is what the whole evidence model rests on.
- **Closing the probe-to-act window.** Named above. A Tachyon mutex would not be respected by an
  external terminal anyway, and would be a subsystem for a risk never measured in production.
- **Adding a sixth precondition.** The five are the ones the product already computes.
- **An agent-side `propose_land` tool.** The agent already asks by delivering: the block appears on
  the row by itself. A proposal store would be new machinery for an ask that already happens.
- **Changing what counts as proof.** That is SDD 497.
- **Auto-land, scheduled land, hook-triggered land, agent-triggered land.**

## Open questions

None blocking. The four the first draft carried were answered by the review and folded above: the act
runs in the engine through an Interface-only typed operation (never `HostActionBroker`, which is the
Bridge's door and would be exactly the agent-facing path this forbids); undo comes from the reflog;
occupancy is ignored; concurrency is git's compare-and-swap. The fifth — what the button says when a
precondition is red — is answered too: nothing, because there is no button.

One inconsistency is accepted rather than solved, and named so it is not discovered as a surprise:
**the refusal sentences are engine-authored and therefore not localized.** `src/webview/worktrees/messages.ts`
already records that decision for the existing block ("only the CHROME is localized: a check's `detail`
and `fix` are the engine's"). The new chrome — the button, the outcome line — is localized like its
neighbours. Making engine-side refusal prose translatable is a separate change across every check that
already exists, and this spec does not smuggle it in.
