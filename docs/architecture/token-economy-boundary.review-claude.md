# Review — token-economy-boundary.md (claude, 2026-07-15)

Adversarial/quality review of the draft ADR, requested by grok. Product claims were
fact-checked against README, `src/bridge/tools.ts`, `src/bridge/redact.ts`,
`docs/research/codexbar-headless-vendor-spike.md`, `docs/architecture/dogfood-product-boundary.md`,
and this repo's `tachyon.yml`.

## Verdict

**Needs edits before further discussion** — the skeleton is right and most product claims are
accurate, but the doc overclaims its own authority in two places, misses the *strongest* argument
for its central rejection (D4/D5), and misses the largest fleet-level lever the product already
has. All fixable with targeted edits; no rewrite needed.

## Must-fix

### M1. Authority mismatch: "not ratified" header vs "Strong agreement" + "sticky" policy
The header says *draft / not ratified*, then §2 labels D1–D5 **"Strong agreement"** and §11 calls
itself **"One-line policy (sticky)"**. Worse, §11 mixes two different authority levels in one block:
"no token proxy" is an actual product invariant (README.md:23, :1114 — pre-exists this ADR), while
"single-runtime plugin pack as product identity" is this draft's own proposal. A future reader will
cite §11 as settled policy.
**Patch:** §2 — rename the strength values to `Proposed (thread consensus)` / `Proposed`; reserve
"Strong"/"Ratified" for after maintainer lock (§10 already defines that path). §11 — retitle to
"One-line policy (proposed; the *no token proxy* line is already a README-level product invariant,
the rest ratifies with this ADR)".

### M2. The strongest argument for D4/D5 is absent: lossy filters are a verification-integrity hazard
§5 rejects vendoring rtk on packaging/scope grounds (second binary, release matrix, "not ADE core").
The sharper, product-truth reason is missing: **any lossy compressor/filter between an agent and its
evidence is a tamper surface.** Tachyon's whole delegation model (verify gates, `run_command` tails,
suppression-diff discipline) depends on output being honest; a filter that drops the failing line
converts a red run into a green-looking tail — silently. That is exactly the failure class the
dogfood-product-boundary doc calls "documented intent is a hope."
This also constrains **Q2**: first-party Bridge truncation must be *fail-visible* — truncated output
is explicitly marked with what was dropped (bytes/lines), never silently elided.
**Patch:** add one row to §5 ("Any lossy filter on the evidence path (vendored or first-party)
without explicit truncation markers | Verification integrity: gates and verify depend on honest
output; silent compression can hide failures") and add "must be fail-visible (marked truncation,
never silent)" to Q2's options/notes.

### M3. §1.1 asserts an identity ("Tachyon is an ADE") that Q6 admits is undecided
"ADE" appears nowhere in the product — README's identity is "Several agents. One editor. Native
terminals." The ADR coins the term, states it as settled identity in §1.1, then asks in Q6 whether
to keep it. Also, the expansion given ("agent development / fleet environment") is itself hedged.
**Patch:** §1.1 — "Tachyon is (in this ADR's working shorthand) an **ADE** — an agent fleet
environment inside VS Code…" and pick one expansion. Q6 stays open; §1.1 just shouldn't pre-answer it.

## Should-fix

### S1. §3.2 underclaims pipelines/runbooks as "Partial / evolving"
Both are shipped product surfaces: README has a full **Agent Pipelines** section (declarative
chains, approval gates, sidebar ▶ Run / ✎ Edit / 🗑 Delete, `complete_node`), and `run_runbook` is a
live Bridge tool. What's actually missing is *budget policy* — which is Q5, a separate row.
**Patch:** change the row to `Yes (shipped); budget signals open → Q5`.

### S2. Q4 is already partially answered by the product
README already contains a user-facing token-hygiene section: **"What Bridge calls cost"**
(README.md:218–232) — the three buckets, visible-pane default, "payload size, not call count,"
held-wait-costs-nothing. Q4 as framed ("do we want a README section?") ignores that it exists.
**Patch:** reframe Q4 as "extend the existing *What Bridge calls cost* README section into a fleet
playbook, or keep the rest architecture-only?"

### S3. Q7's premise should state the current fact — this repo has no `commands:` today
`tachyon.yml` in this repo currently declares agents + settings only; **no `commands:` block, no
runbooks**. So the dogfood repo does not yet demonstrate the pattern §6 calls "the baseline." That
makes Q7 sharper and more honest, and it clarifies §3.1's column semantics: "First-party today? Yes"
means *the capability ships in the product*, not *our own dogfood exercises it*.
**Patch:** Q7 notes → "currently absent from this repo's tachyon.yml; adopting it is also dogfood
proof for §3.1's first row." Optionally rename the §3.1/§3.2 column to "Shipped in product today?".

### S4. Missing open question: how do we know any lever actually saves tokens?
The doc's cost claims (§3.2 "cost intuition") are unfalsifiable as written, in a repo whose culture
is forcing-functions-over-intent (§10.3 even requires one for ship-facing ratification). There is no
Q about the **evidence standard** for ratifying a token-economy claim — and "no telemetry" plus
"cost scans deferred" (D8) make measurement genuinely non-trivial, which is exactly why it deserves
a question rather than silence.
**Patch:** add Q9: "What evidence accompanies ratifying a token-economy lever? (dogfood
before/after on a real task; payload-size fixture test on Bridge results; or accept 'reasoned, not
measured' explicitly)."

### S5. Missing fleet-level lever: runtime/quota routing
§3.2 lists coordination levers but omits what is plausibly the **largest** fleet-level economy only
an ADE can offer: *routing work to the right runtime/quota* — mechanical work to a cheap CLI,
adversarial review to a second model, surgical fixes to a mid-tier one, each on its own
subscription. This is not scope expansion: it's spawn-time agent choice, already shipped
(multi-CLI is the product's headline) and already practiced in this repo's own delegation. Its
absence makes the ADR read as if token economy = compression + coordination, when *allocation*
dominates both.
**Patch:** add a §3.2 row: `Task→runtime routing (choose the CLI/quota per task class) | The
biggest per-task cost decision is which fleet member does it | Yes (spawn-time choice; policy is
human/coordinator judgment)` and mention allocation in D2's wording.

### S6. Q1 should cite the existing boundary invariant
Default-injecting rtk (or anything) into spawned agents' environments is exactly the class governed
by PI-001 ("project guidance is explicit project input, not Tachyon product policy") and the
dogfood-product-boundary rule. Q1's options table should say that a default-on answer requires a
forcing function per that doc — this mostly pre-answers Q1 toward "off by default / opt-in yml."
**Patch:** add to Q1 notes: "default-on would cross PI-001 / dogfood-product-boundary; needs a
forcing function, which biases the answer to opt-in."

### S7. Reanchor row slightly overstates automation
§3.1 "reanchor_agent + role file after compaction — Yes": true, but auto-anchor is **opt-in and
default false** (`settings.anchor.auto`, README.md:897); detection covers claude + codex only. The
lever exists; it just isn't ambient.
**Patch:** "Yes (manual always; auto opt-in, claude/codex detection)".

## Nice-to-have

- **Typo** §1.1: "intermedi ate" → "intermediate" (line 29).
- **`run_command` shape** (§3.1): the happy-path result is indeed `{passed, exitCode, durationMs,
  tail}` (src/bridge/tools.ts:2511–2556), but a soft timeout returns `{name, running, note}` and a
  cached finished result omits `durationMs`. Fine as a lever description; just don't let anyone
  treat the ADR as the schema — consider citing the README/tool description instead of inlining
  the shape.
- **Cost formula** (§3.2): label it "illustrative, not a model" — `context_i × turns_i` isn't
  dimensionally honest (context grows per turn) and someone will eventually argue with it.
- **§6 duplicates §3**: the baseline list restates the §3.1/§3.2 tables. Could shrink §6 to its
  one real sentence ("extend these, don't invent a parallel token-killer product line") + links.
- **Related links**: add `product-invariant-testing.md` — §10.3's "test-locked when ship-facing"
  points at that machinery, and PI-001 (cited above) lives there.
- Q2's "redact (already partial)" is correct — `src/bridge/redact.ts` (spec 351 T7) redacts Bridge
  auth secrets from diagnostics. Fine to leave, or cite the file so it doesn't read as hand-waving.

## Alternative framing (offered, not required)

The ADR organizes by *ownership* (who builds what). A sharper cut is by **lever magnitude**, which
makes D4 fall out as a corollary instead of a defended position:

1. Token economy has three levers, in descending order of magnitude:
2. **Lever 1 — don't redo work.** Durable state outside any context window (pins, handoff,
   worktrees, verify, reanchor). Saves entire re-explorations. Wholly ADE-owned.
3. **Lever 2 — do the work on the right quota.** Task→runtime routing across the fleet's
   subscriptions. Only a multi-runtime ADE can even express this. (Currently missing from the ADR
   — see S5.)
4. **Lever 3 — shrink what crosses the wire.** Payload discipline, curated command tails,
   truncation, prose concision.
5. All four thread tools (rtk, CodeBurn, Morph, Caveman) attack lever 3 — the smallest one —
   inside a single agent.
6. Tachyon already owns levers 1–2 outright and the fleet half of lever 3 (Bridge payload policy).
7. Therefore: vendoring lever-3 tools buys the least valuable slice at the highest integration
   cost — D4 is a consequence, not a stance.
8. The one lever-3 piece worth first-party work is the piece with a *safety* dimension, not a
   savings dimension: fail-visible Bridge truncation (Q2 + M2).
9. Cost observability (CodeBurn's territory) is measurement, not a lever — it belongs with
   RuntimeOps (D8 already says this; keep).
10. Everything else in the current ADR survives unchanged under this framing.

## What I agree with (don't re-litigate)

- **The two-layer model (§3)** — the envelope/fleet split is the right decomposition and matches
  how the product actually works.
- **D4 (no vendoring)** — correct conclusion; M2 just strengthens the rationale.
- **§3.3 honest definition** — "not putting junk into context, not reprocessing state; NOT
  intercepting provider traffic" matches README's product invariant exactly (README.md:23, :230).
  Best paragraph in the doc.
- **CodexBar posture (D7, §4)** — accurately cited: the spike ADR really does say
  reference/conformance-oracle only, nothing ships, quota-first with cost scans deferred
  (codexbar-headless-vendor-spike.md:9, :166, :193, :25).
- **Rejecting "become a token proxy"** — correctly anchored to a real, pre-existing product
  anti-goal, not invented for this doc.
- **§8/§10 living-doc process** — the resolve-and-leave-a-trail discipline plus the
  forcing-function requirement on ratification is exactly the repo's established culture; keep
  as-is.
- **Fact-checks that passed:** `read_output` visible-pane default (README.md:224); "payload size,
  not call count" (README.md:230); `run_command` structured result (src/bridge/tools.ts:2511);
  redaction "already partial" (src/bridge/redact.ts); both Related links resolve.
