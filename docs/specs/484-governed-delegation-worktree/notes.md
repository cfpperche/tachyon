# 484 — governed-delegation-worktree — notes

_Created 2026-08-01._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

**The probe archetype cannot review code, and that is by design.** The first adversarial review of this
spec was requested as `probe_agent(runtime: "codex", archetype: "adversarial-review")` pointed at the
spec file. It came back a single `blocker` finding: every verdict INCERTO, because it "was forbidden
to inspect the filesystem, run commands, or use tools." That is correct behavior, and the cause is
`src/probe/archetypes.ts:57`, whose brief says verbatim: *"or use tools. Base your answer only on the
TASK, CONTEXT, and CONSTRAINTS below."*

So `probe_agent` is a **context-only reasoner**, not a code inspector. `write: true` buys an isolated
cwd (`ProbeService.ts:37`, `:265` — `sandbox: workspace-write` vs `read-only`), which is about where
it may write, not whether it may read. For adversarial review OF CODE, the right instrument is a
spawned agent with tools (as `codex-revisor` was for t-21101f); for adversarial review of an ARGUMENT,
a probe works — provided the material is pasted into the context.

Recorded here because the misuse cost a round trip and the distinction is not obvious from the tool
description, which says "captured A2A duet" without stating that the duet has no hands.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

### Self-review findings, before the second probe returned

Three things the author found by re-reading the code after writing the spec. Recorded before the
adversarial verdict so it is visible which were caught in-house and which needed a second model.

**1. Failure of worktree creation drops the child into the workspace ROOT.** `WorktreeManager.ts:1126-1128`
— an ordinary `WorktreeUnavailableError` notifies and returns `null`, and `null` means the AgentManager
uses the workspace root. For a *declared top-level* agent that is defensible: the root is its normal
home. For a **Temporary child that explicitly asked for isolation, the root is the human's primary
checkout** — strictly worse than the status quo, where the child would at least land in the parent's
worktree.

Note that lines 1121-1125 already fail closed for the cases where a checkout may have been left
behind. The distinction being drawn there is "did we possibly create state", not "did the caller
depend on isolation". This spec needs an acceptance criterion that a parented child which asked for
isolation and did not get it **fails closed**, and must argue why that differs from the top-level
case rather than just asserting it.

**2. Promotion is an uncovered lifecycle.** `AgentManager.ts:3521` + its docstring: a Temporary can be
promoted to a declared agent (`lifetime: "saved"`). The spec enumerates dismiss and says nothing about
promotion. If a Temporary with its own worktree is promoted, does the worktree carry over as the
declared agent's owned worktree, or does the declared agent get a second one and orphan the first?
`branchFor` derives from the agent NAME, so the branch may in fact be identical — which would make
carry-over the natural answer, but that must be verified rather than assumed.

**3. The open question about branch naming is already answered by the code, so the spec should not
have deferred it.** `WorktreeManager.ts:1088` calls `branchFor(ctx.name, deps.settings, {branch: ctx.branch})`
— the same template a declared agent uses. So a Temporary child would take `tachyon/{name}` and share
one namespace with declared agents. The real question is not "what template" but **name reuse**: a
Temporary name can repeat across spawns, and `ensure()` receives `prior: deps.priorRecord`. What the
second spawn of a same-named Temporary does with a leftover branch or checkout is the thing to
resolve, and it is a sharper question than the one the spec wrote down.
