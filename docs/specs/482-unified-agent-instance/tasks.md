# 482 — unified-agent-instance — tasks

_Generated from `plan.md` on 2026-07-28._

**Ratified 2026-07-29** (`t-5e1113`, journal `j-f7fc20368177`). Implementation is authorised and
proceeds in verifiable slices, each landing green on its own tree.

## Gate

- [x] Measure the current code and record it with citations (`notes.md`).
- [x] Produce the ratifiable architecture (`spec.md`, `plan.md`).
- [x] Adversarial review by `claude-reviewer` — returned BLOCKER on two measured claims; both
      confirmed against the code and corrected (see `notes.md`, which keeps the errors visible).
- [x] Second adversarial pass on the corrected scope and the creation-door threat model — no new
      blocker; one residue of the first correction and two threat-model gaps, all three closed.
- [x] Present only the real decisions to the human and ratify — five approved, recorded in
      `spec.md` § Ratified decisions.
- [x] Decompose into verifiable slices (below).

## Slice 0 — symmetric durable lineage (ratified decision 5)

_First because it is small, self-contained, and the only ratified decision that changes measured
behaviour today. It also removes a strip that the fork work would otherwise have to reason around._

- [x] `stripDeclaredParent` stops discarding a declared instance's parent — the function is gone.
- [x] A Saved instance's parent survives a restart, exactly as a Temporary one's does. Needed BOTH
      halves: the write stopped stripping AND `rehydrateFromLedger` stopped skipping config-owned rows.
- [x] `declaredOwner` is untouched, and neither edge is derived from the other (asserted).
- [x] Lineage is bounded by the INSTANCE — `startedHere`, admitted in one place (`ledgerParentOf`).
      Caught by the existing suite, not by me: my first cut re-nested a top-level agent from a stale row.
- [x] A self-parent is refused on WRITE (`withoutSelfParent`), with a defensive read for older rows.
      Landed in `main` as 6882b2dc / tree 6a5131f0e085.

## Phase 1 — converge fork onto the spawn implementation

_Replaces the first draft's "durable lineage" phase, which adversarial review showed was aimed at a
non-problem (`notes.md`)._

- [x] `commitFork` stops building its own session — `createOwnedSession` is the one door, carrying the
      execution-env ordering, the memory scope and Pi admission. Identity is minted by the caller and
      passed in, because both callers need the provenance in their DIFFERENT failure paths (an
      ordinary launch must never kill an ambiguous same-named pane; a fork preserves its Git-locked
      checkout as recovery state). Pinned by `test/unit/ownedSessionCreationShared.test.ts`.
- [x] Equivalence proof. Two layers, because they catch different failures:
      `test/unit/ownedSessionCreationShared.test.ts` proves there is ONE door (a behavioural test
      cannot see a second `newSession` appearing), and `agentManager.test.ts`
      "spawn and fork both refuse an agent-forged execution identity" proves the door BEHAVES the same
      through both callers — a hostile agent declaring `TACHYON_EXECUTION_ID` is overridden on both
      paths, and the fork gets a distinct identity. Fork's transcript sharing, `--fork-session`,
      per-runtime refusals (`adapter.forkCommand`) and every gate stayed in `commitFork`; the existing
      fork suite covers them unchanged.
- [~] Forking a Saved agent and `declared: false` — **moved to phase 2, deliberately.** Measurement:
      there are TWO `declared: false` in `commitFork` with DIFFERENT meanings, which is itself the
      clearest illustration of invariant 5. (a) `withSessionOwnership(..., {declared: false})` sets
      `ownershipOnly` — it withholds the declared-agent lifecycle hooks, and that is a correct
      authority boundary: a fork has no profile authority to inherit. (b) the ledger row's
      `declared: false` means "config does not own this definition", which is TRUE — a fork has no
      `tachyon.yml` entry. Flipping (b) to `true` would make `rehydrateFromLedger` treat the fork as
      config-owned and NOT adopt its definition, so the fork would lose its definition on reload. The
      conflation is real but the fix is the `identity`/`lifetime` split, not a boolean flip.

## Phase 2 — identity and lifetime as declared fields

- [x] `instance: { identity, lifetime }` on the session record, written by both real paths.
      TWO fields rather than one enum, and the fork is what proves it: no durable Profile
      (`temporary`) but it owns a resume block (`restartable`). One value would have to lie about one
      of the two, most likely about whether the fork survives.
- [x] No inference. Both are declared from what the operation WAS: `adhoc = !!opts.cmd ||
      forced.ephemeral` is the caller's declaration, never the name, the tmux session or
      `tachyon.yml`. Verified before writing this, because deriving from YAML presence is exactly the
      forbidden move.
- [x] Pre-split rows keep an ABSENT policy — synthesising one from `declared` at read time would
      re-create the inference this replaces. An unrecognised value is dropped, not coerced.
- [x] `declared` untouched as a storage fact; no reader moved. Phase 3 owns that, deliberately apart
      so the write side is proven before anything depends on it.

## Phase 3 — converge the readers (IN PROGRESS — foundation + first group landed)

- [x] The resolver: `src/agents/agentInstancePolicy.ts` answers the QUESTIONS readers ask
      (`isTemporaryInstance`, `mayRestartInstance`) instead of exposing the fields. The legacy path
      lives in exactly one place, and `legacyFallbackUsed` makes it observable so removing it later is
      an observation rather than a hope.
- [x] Legacy rows stay honest: no policy is invented for a pre-phase-2 row. The helper answers such a
      row the way the reader always did — which is exactly as right, and as wrong, as it has been.
- [x] The declared policy is exposed on the `AgentManager.list()` row so readers need not touch the ledger.
- [x] Equivalence proof, enumerating row shapes rather than sampling: policy agrees with `declared`
      on every shape this build writes, with ONE deliberate divergence — a fork is not `declared`, so
      the old answer said it could not be restarted, while it owns a resume block and always could.
      A contradictory row is pinned too, so no reader may depend on the two agreeing.
- [x] Converged: handoff distill (`isTemporaryInstance`) and handoff distill service
      (`mayRestartInstance`) — a coherent group that asks both questions.
- [x] Fleet/sidebar, converted per-read rather than per-file: `adhoc` (agent + terminal) and
      `canDismiss` (both sites) as identity questions; then `persistenceHooks` and `continuity` too,
      then `persistenceHooks` and `continuity` via `hasLifecycleHooks` — a declared CAPABILITY
      (`instance.lifecycleHooks`), recorded at spawn and never derived from identity. The promotion
      ruling (`j-20febbd260be`) removes the hybrid state but does not fuse the two: a promoted agent
      is `identity: saved` with `lifecycleHooks: false` while it keeps running. See `notes.md`.
- **DEFERRED (not this SDD):** surfacing "promoted, still running as Temporary" and offering
  `Restart as Saved`. New capability rather than reader convergence; registered here since phase 3 and
  never authorized as a slice. Carried out of SDD 482 as its own future task.
- [x] Remaining POLICY readers converted in one grouped delivery, each with its own assertion:
      `bridge/tools.ts` dismiss family (canDismiss, the kill_agent hint, the dismiss guard),
      `missionVm`'s live-Temporary filter, and the DEGRADED roster's `adhoc` flag — the last needed
      `DegradedRosterEntry` to carry the ledger's policy through, while LKG rows (a config snapshot,
      which never had one) fall back honestly.
- [x] Bridge-visible refusal WORDING deliberately unchanged, and pinned by a test: renaming a
      protocol-visible string inside a slice whose claim is "behaviour unchanged" would make that
      claim unfalsifiable from outside. The rename is phase 5's.
- [x] Swept the rest and classified it (`notes.md`): Attention, Execution Graph, worktree and cleanup
      have NO policy reads of `declared`. What is left is wire-protocol fields (`handoffProjection`,
      `workspaceProjection`, `activityProjection`, `engineService`) and genuine storage questions
      (`declaredAgentNames`, `configOwned`, `ownershipOnly`) — the former blocked by the
      no-wire-widening rule, the latter correct as they are.
- [x] HUMAN DECISION TAKEN (ratified decision 7): `declared` STAYS on the wire this phase, with a
      compatible meaning — not removed, not renamed, not silently reinterpreted. Policy fields and
      retirement of the legacy one are phase 5's, and only with an explicit protocol bump,
      cross-version proof and a compatibility window. The boundary test written for this delivery is
      now the enforcement of a ratified decision rather than a provisional guardrail.
- [x] PHASE 3 CLOSED. Every reader that asked a policy question asks the resolver; every remaining
      `declared` is either a wire field held deliberately stable or a genuine storage question.
- **RESOLVED in phase 5:** no duplicate proved removable. See "What phase 5 did NOT remove, and why".

## Phase 4 — the governed creation door (severable)

### Slice A — the proposal is inert data (delivered)

- [x] Capability in the proposer's Profile; absence refuses BY NAME. New `grants.proposeSavedAgent`,
      kept OUT of `capabilities` — see `notes.md`: `capabilities` lists resources the agent is given,
      this is authority over the roster, and folding them together repeats the one-word-two-jobs
      conflation this SDD exists to undo.
- [x] Capability recursion refused at ADMISSION (invariant 9). The proposal fails rather than being
      silently pruned, so a proposer that asked for it learns it was refused. The commit-side half
      lands with the commit path (slice C) — it is a second check, not a replacement.
- [x] Per-proposer pending ceiling; identical re-proposals collapse on digest FIRST, so a retrying
      agent never consumes its own slots and gets refused for flooding.
- [x] Typed, immutable, digest-bound proposal; the digest covers proposer + spec + base state and is
      computed over canonical (key-sorted) JSON. Approving one proposer's request never authorizes an
      identical request from another.
- [x] 24h expiry as a pure predicate; an unparseable expiry reads as EXPIRED, never as "never expires".
- [x] Every control above proven by disabling it: each disabled check produced exactly one failure.
- [x] Slice A ships NO reachable door on purpose — no Bridge tool, no Inbox surface, no commit. A
      half-open door teaches the human that approving is harmless; the data layer lands refused-by-
      default and stays unreachable until the commit path is proven.

### Slice B — the proposal is durable (delivered)

- [x] Store under `.tachyon/agent-proposals/<id>.json`, atomic temp+rename, mode 0600, witness log
      alongside. Survives a restart because it is a file; asserted by re-reading with nothing cached.
- [x] Digest RE-CHECKED on every read; a mismatch is a hard refusal, never a repair. Recomputing would
      launder the one edit that matters — changing a proposal a human already looked at.
- [x] A record moved into another id's file is refused too, by an INDEPENDENT check (proven: it still
      refuses with the digest check disabled).
- [x] Read-by-id fails loudly; LISTING excludes corrupt files instead of throwing, so one bad write
      cannot blind the human to the whole queue.
- [x] Traversal-shaped ids refused before becoming a path.
- [x] Expiry evaluated at READ time. The sweep is housekeeping and nothing depends on it — asserted by
      showing the ceiling admits again after expiry with no sweep having run.
- [x] Only the proposer may withdraw its own proposal, checked against the STORED record; a repeated
      cancel converges rather than failing a retry the caller cannot fix.
- [x] Collapse writes nothing new, and still records `collapsed` in the witness log: "nothing changed"
      and "nothing was attempted" must stay distinguishable in an audit.
- [x] Controls proven by disabling: tamper check, cancel ownership and read-time expiry each produced
      exactly their own failure.
- [x] Still NO agent-reachable door. The rule holds and tightens as the machinery grows: the door
      opens in one slice, complete, or not at all.

### Slice B (continued) — the Bridge door to PROPOSE only

- [x] `propose_saved_agent`, `list_saved_agent_proposals`, `cancel_saved_agent_proposal`. The first is
      the only agent-facing entry point, and it can do exactly one thing: leave a typed, digest-bound
      proposal where a human will find it.
- [x] IDENTITY IS AUTHENTICATED, NOT DECLARED. The proposer is `deps.caller`; there is no `proposer`
      parameter, asserted against the published input schema. This matters more here than almost
      anywhere: the Bridge authenticates with ONE shared token, so a tool that accepted a name would
      let any agent borrow the identity of one holding the grant, and the capability check would be
      decorative.
- [x] A non-agent caller (legacy/human kind) is refused outright — "no profile" must never read as
      "no restriction". Proven by disabling the check: exactly that test failed.
- [x] The grant is read per call from the caller's canonical profile, fail-closed on missing,
      unreadable, invalid-YAML and schema-mismatched profiles.
- [x] The tool cannot even EXPRESS a request for the proposing capability — no `grants` in its schema —
      and admission refuses it anyway. Schema stops today's callers; admission stops whatever calls
      the store next.
- [x] Asserted that the door still creates nothing: config byte-identical, no profile directory, no
      authority. And no profile in this repo holds the grant, so nothing is newly permitted today.

### Slice B preconditions from the adversarial review (closed here, not deferred)

- [x] **Corruption stays visible.** `readSavedAgentProposalQueue` returns `{proposals, unreadable}`;
      the empty catch is gone. A human can now tell "withdrawn or expired" from "someone edited this",
      and the Bridge list reports the untrusted files rather than hiding them.
- [x] **The blind-dedupe bypass is closed.** An untrusted file cannot be attributed or digest-matched,
      so it cannot collapse — corrupting a pending proposal used to make it invisible and the same
      request came back with a FRESH id every time. Untrusted files now COUNT against the ceiling, and
      the refusal says why instead of looking like an unexplained limit. Witness records the ids.
- [x] **Symlink fail-closed, proven.** `lstat` on both the proposal file and the store directory;
      reading through a link is refused even when the linked content would pass its digest — the
      digest cannot catch this because the content is genuine and it is the PATH that lies. Writing was
      already safe (temp + rename replaces a link rather than writing through it) and that is now
      asserted, including that the linked-to file outside the store is left untouched.
- [x] Both new controls proven by disabling: exactly their own three tests failed.

CORRECTION TO THE PREMISE these preconditions were filed under: they were scoped to "slice C must not
open the door without closing both", on the understanding that slice B was unreachable. Slice B as
DIRECTED included the Bridge tool, so the door is already reachable in `c61f2efbfc41`. That makes both
preconditions current, not future, which is why they are closed here.

### Slice C — the door opens (delivered)

- [x] Human Inbox review: a third inbox KIND, ranked between an approval (which blocks an agent) and a
      validation (evidence to read) — a proposal blocks nobody but creates durable authority.
- [x] The pane shows effective config, runtime, requested ownership, dangerous grants, what approving
      writes, and the digest. Environment renders as NAMES ONLY: a proposal cannot reference a secret
      provider by type, but nothing stops a proposer pasting a token into an ordinary value, and a
      pane that echoes it puts the credential into a screenshot.
- [x] Approval is DIGEST-BOUND end to end: the digest travels from the pane through the message to the
      commit path, which compares it. A proposal that changed between render and click is refused.
- [x] Revalidation/CAS on the base config; the row WARNS and the approve button is disabled before the
      click rather than failing after it.
- [x] Canonical Studio transaction, injected as a port — never a second write path.
- [x] Compensation: the receipt is written BEFORE the transaction (`committing`) and finalized after,
      so a crash is attributable; a failure records `failed` with the reason instead of leaving an
      in-flight claim.
- [x] Receipt names proposer, approver, digest, txid/revision, outcome. Idempotent: a retry converges
      on the existing receipt and the transaction runs exactly once.
- [x] Revocation is effective on a pending proposal: the proposer's grant is RE-READ at commit.
- [x] Capability recursion refused at commit as well as at admission.
- [x] Saving does not start the agent: no spawn, no port that could perform one, `lifecycle.enabled:
      false` in the created profile — asserted three ways.
- [x] Approval is unreachable from the Bridge, asserted by absence of the wiring.
- [x] Visual QA: two headless browser shots at 880px and 360px, each asserting no horizontal overflow,
      plus a DOM assertion that the secret VALUE never reaches the pane.

### Slice C — what did NOT land, and why

- [x] The review-only state is DECLARED, not implicit: a deployment table in `spec.md`, the reason
      written at the injection site in `extension.ts`, and a test that fails if someone supplies the
      port without updating the table. `claude-reviewer` named the failure mode — an optional
      dependency nobody declares is a silent gap rather than staging.
- [x] Wire question ANSWERED by review, not by me: slice C touches no `engine-service/`, `runtime-api/`
      or `protocol.ts` file and leaves `ENGINE_SHELL_PROTOCOL` unchanged; the Cockpit↔webview messages
      ship in the same VSIX, so no skew is possible. No bump needed FOR THE TREE THEY REVIEWED (this
      records a review of slice C as it then stood; the single transaction later added one additive
      action — see the entry below). When a persistent
      engine client eventually needs the port, the safe shape is a NEW additive `extension.invoke`
      action (an old engine refuses an unknown action by name; an old client never sends it) — never a
      widened payload on an existing `.strict()` seam like the Studio snapshot, which is what broke
      0.56.110 D1.
- [x] HOST WIRING DONE. Protocol position, in the single precise form (see `spec.md` § Where the
      creation door is open): no existing `.strict()` payload or schema was widened; the protocol
      gained ONE additive named action, `agent-profile.saved-agent-create`, which an older engine
      refuses by name and an older client never sends; no version bump was taken, resting on that
      skew-safety alone.
      History, since it explains two contradictory sentences in earlier drafts: the intermediate
      wiring did run on existing seams alone (`commitAgentProfileStudio` with no `expectedRevision`,
      plus `set-subagents`), and the ratified SINGLE transaction then made that arrangement
      impossible — one transaction needs one crossing.
- [x] Ratified 2026-07-29: proposer becomes the new agent's declared owner; v1 refuses `ownsSubagents`
      and reparenting; approve-and-save writes DISABLED with start separate.
- [x] ONE canonical transaction for create-and-adopt (ratified after audit; the two-transaction
      version and its `owning` state are GONE). Optional `companion` subject on the existing phase
      machine: both locks, one journal, published inside the existing phases, unwound first in
      compensation, and part of the target tuple in `reconcile` — without that last one, a crash that
      published the agent but not the ownership edge would look converged and commit the half-state.
- [x] Both authority records carry `revision: lifecycle-<txid>`, ratified rather than incidental.
- [x] Compensation proven for BOTH subjects by disabling the companion unwind: exactly that test failed.
- [x] CRASH path proven, not just compensation: a hand-built journal describing a transaction that
      published the new agent but NOT the companion's ownership edge is compensated by `reconcile`,
      never committed. Proven by forcing the companion out of the target tuple — exactly that test
      failed. Compensation covers a failure in-process; reconcile covers the process that died, and
      they are different halves.
- [x] "Saving does not start the agent" re-pinned where it now LIVES: moving onto the canonical Studio
      path handed `lifecycle.enabled: false` to `createProfileFromStudioMutation`, which left the
      property unasserted from the proposal side — how a guarantee evaporates in a refactor that "only
      moved things". Asserted through that helper with the exact editable the extension sends.
- [x] Seam crossed by a NEW additive action, never a widened `.strict()` payload.

- [x] `ownsSubagents` REVIEWED (CLEAN) and its recommendation implemented: requested ownership is now
      validated at ADMISSION against the spec 352 contract, not left to fail-closed at commit. The
      child-side rules were EXTRACTED to `assertOwnershipTargets` so the proposal path and
      `ownershipPatchFromStudioMutation` share one rule with identical wording — a test asserts the
      two produce the same message. An unavailable roster REFUSES rather than defers: "I could not
      check" and "it is fine" are different answers.
- [x] Approve+save atomicity REVIEWED (CLEAN): `lifecycle.enabled: false` makes "saving does not
      start" a property of the DATA rather than of this path's conduct, and the commit has no port
      through which a launch could happen.
- [x] Human Inbox review: a third inbox kind with runtime, requested ownership, dangerous grants, what
      approving writes, and the digest. Environment renders as NAMES ONLY, asserted in the browser
      test that the value never reaches the DOM (`savedAgentProposalReview.test.ts`,
      `humanInboxShots.test.ts`).
- [x] Approval bound to the digest end to end — pane → message → commit, which compares it. A2A cannot
      simulate it because the approval has no Bridge tool at all, asserted by absence
      (`savedAgentProposalCommit.test.ts`).
- [x] Atomic commit of profile + authority + roster, for BOTH subjects, in ONE canonical transaction
      with compensation. Proven in-process by disabling the companion unwind, and on the CRASH path by
      a hand-built journal that `reconcile` compensates rather than commits
      (`agentProfileLifecycle.test.ts`).
- [x] Receipt: proposer, approver, digest, txid, outcome — with idempotent retry converging on it.
- [x] Revocation/cancellation, expiry, idempotent retry and post-restart behaviour — slice B.
- [x] Ownership: reviewed CLEAN, and the model changed under ratification. v1 REFUSES `ownsSubagents`
      by name; the only edge an approval creates is proposer-owns-the-new-agent, validated at
      admission by the shared spec 352 rule (`assertOwnershipTargets`, one implementation, asserted to
      produce wording identical to a Studio edit).
- [x] Saving does not start the agent — `lifecycle.enabled: false` written by the canonical create,
      no spawn call, and no port through which a launch could happen. Asserted three ways, including
      through the canonical helper that now owns the guarantee.

## Phase 5 — terminology and removal (delivered)

- [x] `Saved` / `Temporary` in the Cockpit badges — the ONE user-visible surface for the distinction.
      A two-line change rather than a sweep, because the concept was already centralized in the
      strings table; every other `declared`/`adhoc` occurrence is a field name, a config key or a wire
      value that decision 7 freezes. `Probe` was already named Probe.
- [x] The Bridge refusal phase 3 deferred, renamed WITH the old term kept in the same sentence:
      "is a Saved Agent (declared in tachyon.yml)". That is what a compatibility alias means for a
      message — an operator grepping logs for the old phrase still lands here instead of concluding
      the refusal was removed.
- [x] Wired the expiry sweep into the one path that already writes to the proposal directory. It was
      an exported function with no caller, which is its own debt; it is still NOT a control, and the
      read-time filter test proves that independently.

### What phase 5 did NOT remove, and why

- **DECISION — keep:** the legacy `declared` fallback in `agentInstancePolicy` STAYS. It is the one duplicate the plan
      pointed at, and removing it needs field evidence that no pre-phase-2 ledger row survives —
      `legacyFallbackUsed` exists precisely to make that removal an observation rather than a guess.
      Deleting the instrument before the measurement would be the opposite of the plan.
- **DECISION — keep (ratified 7):** `declared` itself stays everywhere: decision 7 froze it on the wire, and phase 3 proved the
      remaining reads are storage questions rather than policy. There is no proven duplication left to
      delete — the honest finding is that phase 3 converged the READERS without creating a redundant
      mechanism to remove.

## Verification

- [x] Each phase green under `npm run verify:full:quiet` on the tree it delivered — trees recorded in
      the task journal, the last being `e36b9e69f32e` (633 files / 7237 passed / 4 skipped).
- [x] Every threat-model control has a test that fails without the control. Each was proven by
      DISABLING it and observing exactly its own test fail: capability absence, capability recursion,
      digest collapse ordering, tamper, cancel ownership, read-time expiry, symlink refusal,
      untrusted-counts-toward-ceiling, companion compensation, companion reconcile.
- [x] No regression: the full suite is green on every delivered tree, and no runtime adapter behaviour
      was touched — this SDD changed instance policy, a proposal store and one lifecycle transaction,
      none of which are per-runtime.

**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood-Opt-Out:** the creation door cannot be dogfooded from here. No profile in this repository
holds `grants.proposeSavedAgent`, so nothing can propose; granting it is a human edit in Agent Studio,
and approving is a human action in a Dev Host, which agents in this project do not open (`t-ce83a2`).
What COULD be exercised headlessly was, and is listed under Verification.

## Visual QA

**Visual QA DONE, headlessly.** Phase 4C shipped the Human Inbox proposal pane, so the opt-out no
longer applies. `test/browser/humanInboxShots.test.ts` renders the real `ItemApp` against the shipped
stylesheets at 880px and 360px, asserts neither width scrolls horizontally, and asserts the
environment VALUE never reaches the DOM — the property a screenshot would otherwise immortalize.
Screenshots in `docs/screenshots/e76acc-human-inbox/`. A human still owns the in-editor pass, since
agents do not open a Dev Host here (`t-ce83a2`).

## Cookbook

**Cookbook-Opt-Out:** the operator flow exists but is not reachable by default — the capability is
granted by a human editing a profile in Agent Studio, and no profile holds it. A cookbook entry should
accompany the first workspace that turns it on, describing grant → propose → review → approve; writing
one for a path nobody can currently walk would document an intention rather than a procedure.
