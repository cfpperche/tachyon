# 498 — governed-land-door — plan

_Created 2026-08-11 (t-7cb971), against `spec.md` as revised the same day. **No product code exists
yet and none may be written until the maintainer ratifies the spec.**_

Sources read before writing this, at HEAD `e0ed543f`: `src/worktree/land.ts` (whole file),
`src/webview/worktrees/App.tsx` (the land block), `src/webview/worktrees/messages.ts`,
`src/runtime-api/extensionOperations.ts`, `src/engine-service/extensionOperationService.ts`
(`worktree.remove-managed`), `src/host-action/policy.ts` + `types.ts` + `capability.ts`,
`src/agents/savedAgentRemovalProposal{,Commit}.ts` (the Forget pattern),
`test/unit/landCommandNeverExecuted.test.ts`, `docs/project-guidance.md`, and the `t-7cb971` journal.

## Approach

One control, one typed operation, one new function that runs git. Nothing else.

1. **The webview posts.** The land block gains a `primary` Land button, rendered only when
   `land.command` is present — the same condition that already decides whether Copy is offered. It
   posts `{ type: "worktreeLand", id, wsHash }`, exactly as `worktreeReviewDiff` and
   `worktreeCreatePr` already do from that block (`App.tsx`).
2. **The extension forwards.** `extension.ts` maps that message to
   `extensionInvoke(ws, { action: "worktree.land", id })`, the same way it already maps the Worktrees
   tab's removal to `worktree.remove-managed` (`extension.ts:1770`).
3. **The engine decides and acts.** A new case in `extensionOperationService.ts` re-runs
   `probeLandSuggestion` for that registry row and then, only if the result carries a `command`,
   calls the new act. Refusals and the outcome come back as data on the operation's reply.
4. **The act.** A new `src/worktree/landAct.ts` reads the trunk head, runs
   `git -C <primary> merge --ff-only <sha>`, reads the trunk head again, and returns what it observed.
   It writes no file and keeps no state.

The re-measure is not a second implementation of the five conditions — it is `probeLandSuggestion`,
the function the panel already calls. That is the whole reason the click can be trusted: the thing
that decides is the thing that was displayed.

## Key decisions

**D1 — An Interface-only typed extension operation, never `HostActionBroker`.**
`StaticHostActionPolicy.authorize` refuses any caller whose `kind` is not `"agent"`
(`src/host-action/policy.ts:63`), and `run_host_action` is a Bridge tool. Registering the door there
would make it agent-callable by construction. The extension-operation grammar is the opposite shape:
I grepped `src/bridge/` for `extensionOperation|extension.invoke|runExtensionOperation` and the only
hit is a comment in `approvalResolutionPorts.ts` — no Bridge tool dispatches these. This honours
Q2 of the task (the act runs host-side, in the primary checkout) while refusing the literal vehicle
the word "host action" suggests, because that vehicle is the forbidden door.

**D2 — The engine runs git, and there is no extension-host fallback.**
The engine already owns `GitExec`, `ManagedWorktreeService` and the land facts; the webview today can
only ask the extension host for `copyText`. If no engine is reachable, the button refuses. A fallback
path would be a second implementation of the decision, which is the failure this spec is built to
avoid.

**D3 — The click re-measures by calling `probeLandSuggestion`, and treats an absent `command` as the
refusal.** All-or-nothing is already the module's rule and already correct: `landSuggestion` withholds
the command unless every check is green. So the act's precondition is literally "the same function,
called now, still hands me a command". This is also why no sixth condition appears anywhere —
`worktree.remove-managed` uses the identical discipline, re-running the full classifier at execution
so "a stale UI verdict can never force a removal through" (`extensionOperationService.ts:497`).

**D4 — The refusal text is the check's own `detail` + `fix`. There is no second string table.**
Every red check already carries a `fix` naming the exit, and the block already renders it. A separate
set of sentences for click-time refusals would drift from the render-time ones and double the surface
that has to stay actionable. The spec's refusal list is therefore mostly a *ratification* of strings
that exist, with two edits (D5, D6).

**D5 — Drop "stash" from the `primary-clean` exit.** Today it reads "commit, stash or discard them
there". The stash stack belongs to the repository, not to a checkout — `docs/project-guidance.md`
records an incident on 2026-08-01 where one agent's `pop` restored a different agent's work. The
product should not hand a human a shared-state instruction as its first suggestion. New wording:
"commit or discard them there".

**D6 — Name the trunk's new head in the `fast-forward` refusal.** Today it says the trunk "has moved
past this branch's base". After 2026-08-11 the operator's next question is always *moved to what?* —
the incident was diagnosed by comparing hashes after the fact. Adding `<trunk-head>` costs one
`rev-parse` that the act already needs for its before/after reading.

**D7 — Read the trunk before and after; recover from `ORIG_HEAD`; keep no Tachyon state.**
`git merge` already writes `ORIG_HEAD` and a branch reflog — the adversarial review confirmed both in
a live trial. The before/after read is not a new subsystem: it is checking the result of the act just
performed, and it is what converts the review's measured wrong-branch window from a silent success
into a reported failure with a `reset --hard` to undo it. Undo, likewise, is read from the reflog at
render time and disappears on its own when the reflog no longer holds the predecessor.

**D8 — The guard changes claim, not just scope.** `landCommandNeverExecuted.test.ts` asserts zero
call sites of `merge` / `--ff-only` under `src/`; this feature makes that claim false by design. The
review already established that narrowing it to "exactly one call site" proves nothing about
authority: it only records where a syntactic form appeared, and cannot see an argument list built
from a variable. So the replacement is two tests with two honest, separate claims:
  - **the one that matters** — no agent-facing door reaches the act: `worktree.land` appears in no
    host-action capability, no Bridge tool schema and no MCP tool listing, and nothing under
    `src/bridge/` references it;
  - **the cheap one, labelled as maintenance rather than security** — the mutating argument list
    appears only in `landAct.ts`. It costs microseconds (this repo's eight structure-policing tests
    total 1.7s) and documents the intended shape; it is not offered as proof of anything.
  Both proved red before green, per `docs/project-guidance.md`.

**D9 — `landAct.ts` is a separate file from `land.ts`.** `land.ts` is read-only by construction and
its header says so; the guard names one file, and a reader should be able to see the boundary without
reading a 380-line module. It also keeps the pure composer testable without a git that can mutate.

## Rejected alternatives

| alternative | why not |
|---|---|
| Register the door as a host-action capability | Agent-facing by construction: the broker requires an agent-scoped token and refuses non-agents. It is exactly the path `spec.md` forbids. |
| Literal Forget shape: agent calls `propose_land`, human approves in the Human Inbox | Forget needs a proposal because the human cannot otherwise see that an agent wants a Saved Agent retired. Here the ask is already visible — the land block appears on the row by itself the moment the work is deliverable. A proposal store, digest, TTL and receipt would be new machinery for an ask that already happens, and it would put an agent in the trigger path. |
| `git update-ref refs/heads/<trunk> <new> <old>` — a real compare-and-swap that closes the wrong-branch window | It moves the ref without touching the primary checkout's index and working tree, leaving them inconsistent with the new `HEAD` — the exact mechanical hazard that makes the primary the only safe place to fast-forward. Trading a named, milliseconds-wide window for a guaranteed inconsistent checkout is a bad trade. |
| A Tachyon mutex or queue for concurrent lands | Measured by the review on git 2.53.0: two simultaneous fast-forwards produced one winner and one atomic expected-old refusal, clean checkout. An external terminal would not respect a Tachyon mutex anyway. |
| A durable undo ledger written before the merge | `ORIG_HEAD` and the branch reflog already exist and were confirmed in trial. Two owners for one history. |
| Refuse when an agent or terminal occupies the primary checkout | Git already refuses concurrent git operations through its own locks; no occupancy defect has been measured; and probing occupancy before acting has the same race we are not closing. |
| A disabled Land button when a precondition is red | A control that is visible and cannot be pressed is the pattern this project has been removing; the block already refuses with reasons. |
| Claim the door prevents the 2026-08-11 incidents | It would have refused them, but they were hand-run merges that bypassed the panel — the panel's own answer was already correct. The claim `spec.md` makes is the narrower true one. |

## Files touched (when implementation is authorized)

- `src/runtime-api/extensionOperations.ts` — add `worktree.land` to `EXTENSION_COMMAND_ACTIONS` and a
  strict zod member (`{ action, id }`), alongside the other registry-id-scoped worktree actions.
- `src/engine-service/extensionOperationService.ts` — the new case: re-probe, refuse, or act.
- `src/worktree/landAct.ts` — **new**; the only file in `src/` that runs the mutating verb.
- `src/worktree/land.ts` — the two wording edits (D5, D6) and `<trunk-head>` in the facts.
- `src/webview/worktrees/App.tsx`, `messages.ts`, `src/webview/WorktreesPanel.ts` — the button, the
  posted message, the outcome/refusal rendering in the block.
- `src/extension.ts` — message → `extensionInvoke`.
- `l10n/bundle.l10n.pt-br.json` (+ siblings) — new chrome only; refusal prose stays engine-side per
  the accepted inconsistency in `spec.md`.
- `test/unit/landCommandNeverExecuted.test.ts` — replaced per D8.
- New tests: the act's decision table (one per refusal, measured and unmeasured variants), the
  actor × trigger rows, the before/after anomaly path.
- `test/browser/landSuggestionShots.test.ts` — extended for the new control.

## Risks

- **Weakening a guard is the riskiest edit here.** The replacement must be proved red before green in
  both directions, and the authority test — not the call-site count — is the one that has to be
  convincing. If it cannot be made convincing, that is a reason to stop and say so.
- **Engine/extension skew.** An engine that predates `worktree.land` will reject the action; the
  button must refuse legibly rather than fail silently. The Worktrees tab already has precedent for
  older engines omitting fields.
- **Unverified ground.** The review measured git 2.53.0 on Linux only. Windows and other git versions
  are untested, and this plan does not pretend otherwise.
- **Visual evidence is required, not optional.** A new control in an existing block changes a shared
  surface: 880 and 360, before and after, per `docs/project-guidance.md`.

## Next step

`tasks.md` is deliberately not written yet. The spec is awaiting ratification, and decomposing a
contract the maintainer has not agreed to would be work spent on the wrong shape.
