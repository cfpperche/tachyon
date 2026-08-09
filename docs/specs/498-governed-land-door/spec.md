# 498 — governed-land-door

_Created 2026-08-09._

**Status:** draft

<!-- Drafted from the maintainer's decision on 2026-08-09, closing the open half of t-7cb971.
     Intent is his; this file is a transcription awaiting ratification. -->

## Intent

`src/worktree/land.ts` already probes five preconditions, and when all five are green it composes the
exact `git merge --ff-only <sha>` for the primary checkout. Then it puts that string on the clipboard
and stops.

That half-measure is incoherent, and the maintainer named it on 2026-08-09: the product has already
taken on the judgment — it computed the conditions and concluded the merge is safe — so refusing the
act is ceremony rather than caution. `t-7cb971` asked whether "record-only" meant *the agent* must not
mutate the trunk or *the product* must not. The answer is the first.

The line that does not move: **nothing mutates without a human saying so.** The agent still cannot
land. What changes is who types after the human decides.

**Why copy-and-paste is not merely slower, but wrong in a way the panel cannot fix.** The suggestion
pins a **sha**, which protects against landing a different tree than the one that was proved. It does
not protect against a different **directory**: a human pastes into whatever shell is focused, and
nothing in the string says which checkout it belongs to. The product knows the primary path; the
clipboard does not carry it.

**The measured cost this exists to remove**, from `land.ts`'s own header: eight hand-run merges on this
host, three of which broke the trunk — and every one of the three failed a condition already
computable in that file.

**The strongest argument against**, recorded because it is legitimate rather than to be dismissed:
"the product never mutates the trunk" is a rule with no exceptions, and a rule with no exceptions
cannot erode. This spec opens the first one, and future work will cite it as precedent. It is accepted
because the honest invariant was never "the product never writes" — it was "nothing happens without a
human". That one survives intact.

## Acceptance criteria

- [ ] **Scenario: the human lands**
  - **Given** a delivery whose five preconditions are all green
  - **When** the human invokes the land action
  - **Then** the product runs `git merge --ff-only <sha>` in the primary checkout, reports the new
    trunk head, and the agent was never able to trigger it

- [ ] **Scenario: the panel was stale**
  - **Given** a rendered land action whose preconditions were green when drawn
  - **When** something changes before the click — the primary moves, the primary goes dirty, the
    trunk advances past the sha
  - **Then** the act **re-probes at the moment of acting** and refuses, naming the condition that
    changed. The rendered state is a suggestion; only the state at the instant of the act authorizes.

- [ ] **Scenario: undo is handed over, not reconstructed**
  - **Given** a land the product performed
  - **When** the human wants it back
  - **Then** the product shows the previous trunk head and the exact command that restores it, from a
    record it made **before** moving the trunk

- [ ] **Scenario: git refuses**
  - **Given** an act that passes every precondition
  - **When** git itself fails the merge
  - **Then** the trunk is unchanged, the failure is reported verbatim rather than summarised, and no
    partial state is claimed

- [ ] **Scenario: an agent tries**
  - **Given** any agent with Bridge access
  - **When** it attempts to reach the land act by any tool
  - **Then** it cannot. The act has no agent-facing door.

- [ ] Exactly **one** call site in `src/` may pass `merge` or `--ff-only` to git, it is named, and
      `test/unit/landCommandNeverExecuted.test.ts` enforces that count — narrowed from "none", never
      loosened to "some".
- [ ] No auto-land path exists: green preconditions never cause an act on their own.
- [ ] The act follows the Forget grammar the original task asked for — the agent prepares, the human
      executes.

## Non-goals

- **Auto-land.** Green is not permission; it is information.
- **Any integration other than fast-forward.** No merge commit, no squash, no rebase. `--ff-only` is
  what makes the landed tree byte-identical to the proved tree, which is the property the whole
  evidence model rests on.
- **Merging through a forge.** Every measured ADE clicks Merge against a remote API; this acts on the
  maintainer's local primary checkout, which is precisely why `primary-on-trunk` and `primary-clean`
  exist and why no forge can stand in for them.
- **Changing what counts as proof.** That is SDD 497; this spec consumes whatever `verified-tree`
  says and adds no opinion of its own.
- **Landing on behalf of an agent, or from a schedule, or from a hook.**

## Open questions

1. **Where does the act run?** The merge must happen with the primary checkout as cwd. Is it a host
   action, or does it belong to the engine? The engine does not necessarily live in the primary, and
   the answer decides who owns the failure path. _Owner or plan._

2. **Does the undo affordance survive a reload?** If the previous head is only in memory, the undo is
   a promise that evaporates on restart — the exact defect class this project keeps finding. A
   durable record has a place to live and a lifetime to decide. _Leaning: durable, because the
   alternative is a state the product created and can no longer help you leave._

3. **The primary is somebody's working directory.** `primary-clean` covers uncommitted work, but an
   agent or terminal may be running there. Does the act refuse, warn, or ignore? _Note the asymmetry
   with worktree removal, which refuses a busy checkout; landing does not destroy anything, so the
   same answer may not apply._

4. **Two clicks at once.** Two deliveries, both green, landed in the same second. The second's
   `fast-forward` precondition is stale the instant the first succeeds — criterion 2 already refuses
   it, but that should be stated as the intended behaviour rather than discovered as a race.
