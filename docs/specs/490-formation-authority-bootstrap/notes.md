# 490 — formation-authority-bootstrap — notes

_Created 2026-08-04._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

### Fatia A — what "authenticates a human actor" can honestly mean here (2026-08-05)

The spec's criterion says the bootstrap door "authenticates a human actor rather than trusting a
caller-shaped payload". `plan.md` already flagged this as the risk: *"A precisa de uma decisão de
autenticação de ator humano que o repo ainda não tem em nenhum lugar."* It was right. Measured:

- **`src/engine-service/controlPeerAuth.ts` proves same-uid, not humanity.** The nonce is a `0600`
  file beside the socket, and `readControlNonce` checks `stat.uid === process.getuid()` and
  `(stat.mode & 0o077) === 0`. Every agent Tachyon spawns runs as that same uid, so every agent can
  read it. This is the SDD 489 review's finding, confirmed here rather than taken on report.
- **`src/bridge/callerIdentity.ts` cannot mint a human.** `resolveCaller` produces only
  `agent | legacy | external` from a Bearer (`callerIdentity.ts:303-317`), and its own contract says
  `master`/`human` are *"reserved for a deliberate human 'Copy Bridge Token' external-tool flow and
  an internal host-only call path, respectively"*. No Bridge tool can produce `kind: "human"`.

So there is no cryptographic proof of human presence in this repository, and **the door does not
pretend otherwise**. What it uses instead is the strongest boundary that actually exists:

> **Surface reachability.** `FormationCaller { kind: "human" }` is producible only by extension-host
> code invoked from a panel the human has open. The Bridge's HTTP auth cannot construct it, so the
> agent-facing surface has no route to the mutation at all.

The honest statement of the limit, which is written into `bootstrapTransaction.ts` and repeated here
so it is not lost: **an actor with code execution inside the extension host is indistinguishable
from the human today.** That residue is not closed by this slice and must not be described as closed.

Rejected alternative: routing adoption through the Human Inbox approval round-trip. That primitive
is agent→human ("may I?"), and adoption is human-initiated; wrapping a human's own click in an
approval the same human answers is ceremony that adds a queue without adding a witness.

### The correction that changed the design: three doors, not one

The maintainer's amendment on 2026-08-05 was that "no route through the Bridge" is not enough — the
**control socket** counts too, because its nonce is the same-uid file above. Chasing that turned up
something the plan had not anticipated, and it would have produced exactly the defect being guarded
against had the door been built "the way Agent Studio already does it":

> **Every existing Agent Studio soul mutation is already reachable over the control socket.**
> `ClientWorkspaceStudioTarget` implements `WorkspaceAgentStudioTarget` by sending
> `ExtensionCommandV1` actions — `soul.profile.create`, `.import`, `.replace`, `.adopt`, `.enable`,
> `.disable`, `.delete` — through `extension.invoke`. Modelling adoption on those would have put
> moment zero one control request away from any agent.

Two more doors were found by asking "who else can reach this?" rather than "who is this for?":

- **Any registered `vscode.commands` id is socket-reachable.** The shell's UI handler runs whatever
  command the daemon names — `await vscode.commands.executeCommand(request.command, ...request.args)`
  in `extension.ts`, with no allowlist. So registering `tachyon.adoptFormationAuthority` would have
  looked like a UI affordance and been a remote entry point.
- **`WorkspaceAgentStudioTarget` is itself the pressure.** Anything added to that interface has to
  exist on the far side of the socket, because that is what the remote client implements. Keeping
  adoption off the interface is what stops door 1 from being created later by someone doing the
  obvious thing.

So the door is a plain `Workspace` method, called in-process, and named as **unreachability** rather
than authentication everywhere it is described. `test/unit/agentFormationBootstrap.test.ts` fails if
any of the three routes appears.

### …and the door that was already open got closed (2026-08-05, second commit)

Finding the above raised a question the slice could not leave alone: adoption is now unreachable, but
the seven `soul.profile.*` MUTATIONS were still listed in `EXTENSION_COMMAND_ACTIONS`. Measured
rather than assumed — `controlServer.ts:382` authenticates a request with `controlNonceMatches` and
nothing else, so there is no caller identity to scope on. **Any agent could create, import, replace,
adopt, enable, disable or delete any agent's Soul, with no proposal, no human, and no record of who.**

The maintainer's decision — `profile-edit` carries the same unreachability as `bootstrap`, and an
agent that needs an identity changed PROPOSES rather than holding a door — made the closure a
prerequisite of routing `createSoulProfile`, not a follow-up to it. Routing first would have pointed
the new lane publisher at a same-uid entry point.

Removed: the seven actions, their schemas, the dispatch cases, `soulProfileMutation`, and the client's
`invokeSoulProfile`/`invokeSoulPayload` staging pair. `soul.profile.status` stays — reading is not
publishing. Three guards, each watched red first, including flipping
`engineServiceProtocol.test.ts`'s assertion from "accepts `soul.profile.replace`" to "refuses it by
action, including in its bare shape" so the refusal cannot be a payload-mismatch accident.

**What it costs, stated plainly:** the remote studio client loses Soul mutations, and refuses naming
where the capability lives. That is the intended effect, not collateral damage — but it is a real
capability removal from a shipped surface, and whoever reads this later should see it as a decision
rather than discover it as a regression.

### The guard is an AST walk, and it was watched red first

`test/helpers/formationBootstrapScan.ts` parses every `src/**/*.ts` and classifies each
`replaceVector` / `beginMutationBarrier` call site by what its `mutation:` property actually is. Two
reasons it is not a grep:

1. On 2026-08-03 a static guard written for this exact purpose compared line text against a `switch`
   body and passed on every violation. Text cannot answer "is this a call site".
2. A **dynamic** pass-through — `mutation: barrier.mutation` in `humanLaneTransactions.commit` — is a
   real second route to the mutation that the word "bootstrap" never appears near. It is enumerated
   and closed by its own behavioral test (a bootstrap barrier is rejected by `parseIntent`), not by
   assertion.

Proven red before being trusted green, twice: against synthetic inputs inside the suite, and by
dropping a real second-door file into `src/agents/formation/` and watching
"finds exactly one production call site" fail with that file named.

### The barrier already anticipated `bootstrap`; only its CAS did not

`authorityStore.parseMutationBarrier` has accepted `"bootstrap"` in its mutation allowlist since it
was written (`authorityStore.ts:922`), and `formation_mutation_receipts` is the table that records
who/when/from-which-generation. The single thing blocking a bootstrap barrier was
`beginMutationBarrier` requiring an existing generation row to CAS against — the same shape as C2 one
layer down. Rather than invent a second audit format beside a table built for this, the barrier now
takes `expectedGenerationSha256: undefined` to mean *"there must be no prior generation"*, exactly
as `replaceVector` already did. Non-bootstrap callers are unchanged: a `string` still means CAS
against that digest.

### Evolution and memory stay `disabled` at generation 1

`validateVectorTransition` would permit initial heads for them at bootstrap. Adoption does not use
that room: both lanes have their own promotion publishers, which presuppose an active vector, and
handing generation 1 a lane those publishers never authored would be a second way to author them.
### Fatia C (2026-08-05, agent f490c) — combined gate, not instructions alone

The suppression receipt covers every enabled human lane. Measuring only `AGENTS.md`/`CLAUDE.md`
and calling that `verified` would unlock a memory lane receipt without a verified memory disable
(Codex). Combined evidence in `nativeLaneSuppression.ts` is `verified` only when instructions is
verified **and** memory is verified or unsupported. Codex instructions verified + memory declared
⇒ combined `declared`. Grok memory verified + instructions no control ⇒ combined `declared`.
Only Claude is combined `verified` on this measurement.

Evidence write-up: `docs/research/native-lane-suppression-sdd490-fatia-c.md`.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

### The Agent Studio button is not in Fatia A — deliberately, and it is a real gap

`plan.md` scopes Fatia A's files to `src/agents/formation/*` and `src/workspace/Workspace.ts`, and
adds "Fora dela, nada — cada agente abre task nova se achar defeito adjacente." Ratification decided
adoption *lives* in Agent Studio; that is about WHERE the gesture belongs, and this slice delivers
the method that gesture calls plus the `inspect` state the lane fields need to stop being inert.

Naming the gap rather than implying it away: **until the button ships, no human can perform adoption
through the product.** The port is complete and proven, and it is reached by nothing yet. That is
the C2 shape one level up, so it is a follow-up task and not a footnote. The follow-up carries the
binding constraint discovered here — the surface must call `Workspace.adoptFormationAuthority`
in-process, and must NOT add an `ExtensionCommandV1` action, a `vscode.commands` id, or a
`WorkspaceAgentStudioTarget` member, all three of which are agent-reachable.

### `beginMutationBarrier` was widened rather than a second audit format invented

Recorded above under design decisions. The alternative considered and dropped was a JSON-lines
adoption audit under the host root: a new format, a new integrity story, and a second place to look
for "who adopted this", beside a table that already records exactly that for every other mutation.
### Fatia C — did not invent verified for Grok rules or Codex memory

Plan risk said: if a runtime cannot disable native rules/instructions, honest result is `declared`.
Grok has no disable control (measured). Codex `project_doc_max_bytes=0` works for AGENTS.md but
memory disable remains declared — combined stays declared rather than a partial green that would
unblock dual memory delivery.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

### Fatia C — Claude `--setting-sources user` vs `--bare`

`--bare` also skips CLAUDE.md but refuses OAuth (`Not logged in` with a working credential
symlink). Canonical Claude already launches with `--setting-sources user`; behavioral arms show
that flag alone suppresses **project** CLAUDE.md while private-home user CLAUDE.md still loads
(Tachyon owns that home). Chose the production argv as the verified control.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

1. **Should un-adoption exist, and what would it mean?** Explicitly out of scope for Fatia A. The
   store has `retire`, which retires a generation rather than removing authority, and
   `agentForgetPlan.ts` already models governed removal. Owner: `plan.md` / maintainer. Spec open
   question 2 remains open.
2. **Is `editor.<wsHash>` the right principal to write into the receipt?** It names the surface that
   acted, which is all this repository can honestly assert. If a workspace ever gains a real notion
   of *which* person is at the editor, the receipt should carry it — and until then, writing a name
   in would claim a witness that does not exist. Owner: whoever adds identity to the shell.
3. **Multi-workspace scope (spec criterion, C4) is enforced but only partly tested here.** The
   adoption host refuses a caller whose `workspaceId` is not this workspace's, and each workspace
   root gets its own store, so the same `agentId` in two roots is two independent adoptions. The
   "two windows on one root" and "reopen/restart" cases named in the criterion are not covered by
   this slice's tests — the store's CAS is what makes them safe, and asserting it through two live
   `Workspace` instances needs a harness Fatia A did not build.
- When Codex memory disable is behaviorally verified, re-open combined gate and decide whether
  canonical launches must pin `project_doc_max_bytes=0` (or equivalent) so the control is not only
  measured but applied.
- Grok needs a real project-rules disable from the runtime vendor, or formation on Grok stays
  refuse-high for soul/instructions while ambient inspectors require file absence.
