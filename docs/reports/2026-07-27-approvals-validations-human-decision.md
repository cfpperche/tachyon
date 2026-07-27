# Approvals × Validations — measured inventory and unification proposal (t-d7dfb1)

_Measured 2026-07-27 against `main` `a435f67c`, in the change worktree `tachyon/change/t-d7dfb1-human-decision`.
Nothing in the product was modified: this report is the deliverable._

Method: read of every seam both flows cross — store, Bridge tools, engine command protocol, extension
host wiring, Control sections, Companion — plus every consumer that redeems an approval. Line
references below are `file:line` at that commit and were read, not inferred.

---

## 1. Inventory

### 1.1 The two flows, seam by seam

| | **Approval** (`a-<6hex>`) | **Validation** (`v-<6hex>`) |
|---|---|---|
| Owner module | `src/bridge/approvalRequest.ts` | `src/validations/ValidationStore.ts` |
| Created by | agent only, `request_human_approval` (`tools.ts:4685`) | agent **or** human, `create_validation` (`tools.ts:3969`); also discovered as candidates (`discover_validation_candidates`, `tools.ts:4112`) |
| Requester identity | Bridge-resolved caller; the tool has **no** requester param (`tools.ts:4727`) | `author` is a self-declared `agent` param, default `"human"` (`tools.ts:3983`) |
| Payload integrity | 4 verbatim child-authored fields + SHA-256 `payloadHash`, re-checked on every read (`approvalRequest.ts:149`, `:207`) | free-form `title`/`type`/`instructions`, mutable by `update_validation`; no hash |
| Who decides | **host only.** There is deliberately no `resolve_approval` Bridge tool (`approvalRequest.ts:331-340`, `tools.ts:4682`) | whoever calls `close_validation` — including an agent (`ValidationStore.ts:104`) |
| Decision transport | `extension.invoke` action `approval.resolve` (`extensionOperations.ts:131` → `extensionOperationService.ts:294`) | typed workspace commands `validation.close` / `validation.assign` (`protocol.ts:226`, `MissionControlTarget.ts:93`) |
| Effect of the decision | writes the record, appends a witness line, and **injects a fixed string into the requester's tmux session** after re-checking session ownership (`approvalRequest.ts:341-404`) | appends a round to the record; no injection, no wake-up |
| Audit | record file **plus** append-only `.tachyon/approvals.jsonl` (`requested`/`resolved`/`cancelled`, `:45`, `:251`) | rounds array inside the record; no separate ledger; the record itself is rewritten on update |
| Lifecycle | `pending → resolved | cancelled`, both terminal (`:53`) | `pending → triaged → running → closed`, and `closed → triaged` reopens with rounds preserved (`ValidationStore.ts:18`) |
| Concurrency | last-write; ownership re-checked at resolve | CAS via `expect{status,assignee,updatedAt}` (`ValidationStore.ts:269`) |
| Denial | `denied` is a first-class decision, recorded and injected | `failed`/`skipped` are outcomes of a round, not a refusal of authority |
| Expiry | none | none |
| Human signals | host notification with a `Review` action, replayed when a shell attaches late (`engineService.ts:121`); durable notice-inbox card, auto-dismissed on resolve (`Workspace.ts:3357`); Companion SSE `approvals.changed`; Control → Overview metric | **none.** `onValidationsChanged` only refreshes the tasks views (`Workspace.ts:2037`) |
| UI surfaces | Control → Approvals section (`Cockpit.ts:1045`); legacy `ApprovalPanel` kept only as a redirect shim (`ApprovalPanel.ts:18`); Companion Approvals tab | Control → Validations section (`Cockpit.ts:1063`); a second close path from the Mission board (`mission-control/messages.ts:60`); `boardSnapshot.validations` |
| Bridge tools | 4: request / list_pending / get_status(own) / cancel(own) | 7: create / get / update / list / next / close / discover |
| Redeemed as authorization | **yes** — see §1.3 | no |

### 1.2 What genuinely overlaps

Measured, not assumed:

1. **Both are "a record under `.tachyon/` waiting for a human"**, with the same id shape and the same
   workspace scoping, and both render as a Control section: list + per-item action + error channel +
   empty state. `approval/{viewModel,messages}.ts` and `validations/{viewModel,messages}.ts` are
   structurally the same triple with different fields.
2. **Both are refreshed by the same idiom** (`refreshCockpitApprovals` / `refreshCockpitValidations`,
   `Cockpit.ts:690-696`) and both re-post their whole view model on any change.
3. **Both are "pending human work" for the purpose of a human deciding what to do next** — and
   neither can answer "how much is waiting on me" together with the other.

Duplication that already exists *inside* each flow, and is part of the cost of the status quo:

- `src/webview/shared/ValidationQueue.tsx` (129 lines) is imported by nothing — dead since the
  Validations section grew its own list.
- Validations have two close paths (`closeValidation` from the Mission board, `closeValidationItem`
  from the Validations section) that reach the same store through different messages.
- `resolveApproval` is wired twice with the same inject/session-owner/completePin closure —
  `extensionOperationService.ts:294` (`resolvedBy: "vscode"`) and `Workspace.ts:3315`
  (`resolvedBy: "companion"`).

### 1.3 The asymmetry that decides the question

A resolved approval is **not a UI state — it is a redeemable capability**:

```
Workspace.resolveTrustedRecoveryApproval (Workspace.ts:4594)
  readOwnApprovalRequest(root, approvalId, actor.name)   // requester-scoped, tamper-checked
  status === "resolved" && resolution.decision === "approved"
  request.payload.proposedAction.includes(actionDigest)  // bound to the exact action the human read
```

Two governed Delivery operations refuse to proceed without exactly that receipt:
`projectionService.ts:641` (`reconcile_base`) and `leaseService.ts:1355` (quarantine recovery). The
binding is what makes it safe: the human authorized *this* digest, requested by *this* agent, in a
payload whose hash still matches.

A validation has none of those properties, by design and correctly: it attests that someone ran a
check and recorded evidence. `close_validation` takes no caller identity, and nothing downstream
redeems a closed round.

**So the two flows are not two presentations of one concept.** One is *ex ante* authorization that a
machine later redeems; the other is *ex post* attestation that a human later reads.

### 1.4 The framing is off by four

"Approvals and Validations" is not the whole set. The product has at least six places where a human
decides, each with its own store and its own path:

| Flow | Where | Human decision |
|---|---|---|
| Approvals | `.tachyon/approvals/` | approve / deny |
| Validations | `.tachyon/validations/` | close a round passed / failed / skipped |
| Schedule proposals | `.tachyon/schedules-pending.json` (`ProposalStore.ts`) | approve → writes `tachyon.yml` / reject |
| Agent evolution candidates | `EvolutionStore` (`extensionOperations.ts:209`) | approve / reject, guarded by `expectedActiveVersion` + digest |
| Task prototype review | `task.prototype.review` (`protocol.ts:228`) | accept / reject an attached prototype |
| Pipeline gates | `awaiting-approval` node status (`pipeline/runState.ts:135`) | approve / fail the gate |

Two of these — proposals and evolution — are *authorization* flows like approvals, and one of them
(proposals) carries a **self-declared** author. Any "single human flow" that merges only Approvals
and Validations at the model level would merge the two least similar members of the family while
leaving four out.

---

## 2. Options compared

### A. Keep them separate, change nothing

- **Cost:** the human has no single place to see what is waiting; pending validations produce no
  signal at all; duplication in §1.2 stays; the "two flows" question comes back.
- **Risk:** none added, but the measured defects in §4 remain.

### B. Unify the human surface and the orchestration; keep two models

One **Human Inbox** read-model that projects every pending human decision into one list, with one
count, one notification policy, and one "what is waiting on me" answer. Every row carries its
`kind`, and acting on a row **routes to that kind's existing typed path** — the inbox never resolves
anything itself.

- **Cost:** one projection + one section + per-kind row renderers; retire the duplication in §1.2.
  No store change, no migration, no Bridge/API break.
- **Risk:** low and contained. The inbox is read-only over the stores; the host-only resolve rule
  stays structural (there is still no Bridge tool that resolves an approval), and Delivery's redeem
  path keeps reading `ApprovalRequest` and nothing else.
- **Extensible:** proposals, evolution candidates, prototype reviews and pipeline gates can join the
  same inbox later without touching their models.

### C. Unify the model too (one `HumanDecision` with `intent: authorize | validate`)

- **Cost:** a migration of two on-disk formats; 11 Bridge tools collapsed into a new surface with
  compatibility shims; every consumer rewritten.
- **Risk — the disqualifying kind:** today "an approval" and "a validation" are different *types*,
  so `resolveTrustedRecoveryApproval` cannot be handed a validation: it would not compile. Under one
  record type, that guarantee degrades into a runtime `intent === "authorize"` check that must be
  repeated at every redeem site, plus re-assertions of requester scoping, `payloadHash`, digest
  binding and host-only resolution — per branch. A missed branch stops being a UI glitch and becomes
  privilege escalation, in the exact code path that guards `reconcile_base` and quarantine recovery.
  The task's own constraint ("não transformar Validation em caminho de autorização") is currently
  enforced by the type system for free; option C converts it into a rule someone must remember.
- It also hides two genuinely different lifecycles (terminal vs reopenable rounds) and two different
  identity models (unforgeable vs self-declared) behind one shape, which is how you get a "unified"
  API where half the fields are meaningless for half the records.

---

## 3. Recommendation

**Adopt B. Do not adopt C.**

The duplication that actually costs the human is *presentational and orchestrational* — no single
inbox, no signal for pending validations, no aggregate count. That is exactly the layer B unifies.
The duplication people imagine at the model layer is not duplication: it is two different security
contracts that happen to render as lists.

One rule keeps B honest, and it is the whole design:

> **The inbox is a router, not a resolver.** It reads every store; it writes to none. Each row's
> action dispatches to that kind's existing typed path, with that path's existing authority checks.

### 3.1 Lean SDD proposal — "Human Inbox"

Not minted as `docs/specs/NNN-…` — promote it with `/sdd` if accepted.

**Intent.** A human working with a fleet has no single answer to "what is waiting for me?". Pending
approvals notify but are counted wrong (§4.1); pending validations do not signal at all; four other
decision flows are invisible outside their own screens. Done means one Control surface and one count
answer that question across kinds, without any kind losing the authority rules it has today.

**Acceptance criteria (draft).**

- Given pending items of more than one kind, when the human opens the Inbox, then every pending item
  appears as one row carrying its kind, requester/author, age and workspace, ordered by kind
  severity then age.
- Given a pending approval, when the human acts from the Inbox, then the action routes to the
  existing `approval.resolve` path — the verbatim payload and provenance are shown before any
  decision, and no new resolve seam exists.
- Given a pending validation, when the human acts from the Inbox, then the action routes to the
  existing `validation.close` / `validation.assign` commands.
- Given pending human-executor validations, then the aggregate count and the Overview metric include
  them, and the count is derived from the stores rather than a shell-side constant.
- Given an item older than a configured staleness threshold, then it is *marked* stale; nothing is
  auto-approved, auto-denied or auto-closed.
- No Bridge tool that resolves an approval is added; Delivery's redeem path keeps reading
  `ApprovalRequest` exclusively.

**Non-goals.** One record type; one store; renaming or renumbering existing ids; changing which
actions require approval; agent-reachable resolution of anything; release-gating policy.

**Migration/compatibility.** None required on disk — the Inbox is a projection. `.tachyon/approvals/`,
`.tachyon/approvals.jsonl` and `.tachyon/validations/` keep their formats, so existing records,
Bridge tools, Companion and plugins are unaffected. The existing Approvals and Validations sections
can stay as deep-link targets (the Inbox is the aggregate view, they remain the per-kind views), so
there is no removal step and no compatibility window.

**Phasing (each independently shippable).**

1. Aggregate read-model over approvals + validations, plus a truthful Overview count (fixes §4.1).
2. Inbox section rendering both kinds, routing to the existing typed actions.
3. Symmetric signals: pending human-executor validations get the notice/badge treatment approvals
   already have — never the injection semantics.
4. Staleness marking (display only).
5. Optional, later: proposals, evolution candidates, prototype reviews, pipeline gates join as new
   row kinds — no model change in any of them.

### 3.2 Minimal consolidation to do regardless

Even if the Inbox is deferred, these are pure duplication and cost nothing to remove: delete the
dead `ValidationQueue.tsx`; collapse the two validation close messages into one; extract the twice-
wired `resolveApproval` closure (`vscode` and `companion` call sites) into one helper so the
session-owner and inject wiring cannot drift apart.

---

## 4. Independent defects found while measuring (filed as Tasks, not fixed here)

1. **Control → Overview always reports `approvals pending: 0`.** Both bundle producers hardcode
   `approvals: []` — `extension.ts:1319` ("pending list is owned by Approvals panel") and
   `Cockpit.ts:996` — and the metric is computed from that array (`cockpit/model.ts:263`). The
   Approvals *section* is unaffected: it builds its own view model from disk (`Cockpit.ts:1045`). The
   one aggregate signal the human has is structurally zero.
2. **`close_validation` does not enforce `executor: "human"`.** `next_validation` refuses to *hand*
   human-only work to an agent (`nextValidation.ts:29`), but `closeRound` checks only status,
   outcome and evidence — an agent can close a validation reserved for a human, and no caller
   identity is recorded (`author` is set at create time and is self-declared). Governance drift, not
   privilege escalation: nothing redeems a closed round.
3. **Schedule proposals carry a self-declared author.** `ScheduleProposal.by` is a tool parameter,
   while the same product treats requester identity in approvals as unforgeable-by-construction.
   A human approving a proposal is authorizing config-as-code changes attributed to a name any
   caller can type.

---

## 5. Answers to the task's mandatory questions

- **What overlaps today?** Presentation and refresh plumbing, workspace scoping, id shape, and the
  human's mental category "waiting on me". Nothing in the persistence, identity or authority layers.
- **What can be shared without letting a validation bypass authorization?** The read-model, the
  inbox surface, the counting/notification policy, and the staleness rule. Never the record type,
  the resolve seam, or the redeem path.
- **Does one typed model reduce complexity?** No — it moves a compile-time guarantee into runtime
  branches inside the code that guards Delivery recovery. It hides two domains rather than
  simplifying one.
- **Audit, requester/executor, segregation of duties, expiry, denial, reopening, automation:** each
  stays where it is. Approvals keep the append-only witness, the unforgeable requester and host-only
  resolution; validations keep rounds, CAS and reopening. Expiry becomes *marking*, never an
  automatic decision — an auto-denied approval is a security decision no timer should make.
- **Migration and compatibility:** none needed; the Inbox is additive and read-only.
- **UX:** one inbox, rows labelled by kind, each action routing to its own path — so the human sees
  one queue but is never asked to make two different kinds of decision through one undifferentiated
  button.
