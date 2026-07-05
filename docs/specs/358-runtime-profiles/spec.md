# 358 — runtime-profiles

_Created 2026-07-05._

**Status:** in-progress

## Intent

Everything Tachyon needs to know about a RUNTIME (claude, codex, opencode, …) is scattered and rediscovered
per-agent, in prose briefs and one coordinator's private memory. This spec makes it a first-class
**RUNTIME PROFILE**: system data, per runtime, applied AUTOMATICALLY — so no agent hand-authors it and no
coordinator rediscovers a runtime's quirks in production.

Two frentes that turned out to be the SAME concept converge here:

**Frente 1 — delivery contract.** Prose instructions ("commit", "run the full suite") FAIL against codex's
defaults (green≠committed; runs focused tests; "done" = implementation-ready). Discovered by INTERVIEWING
codex itself (2026-07-05): the lever that works is a mandatory FINAL REPORT with literal evidence (commit
hash + full-suite result + git status) — the model can't fabricate a hash without committing. And a harder
lesson the same day: "green is not correct" — codexHome passed the suite but omitted the auth.json fix that
only a LIVE smoke test caught. So the contract needs a correctness/smoke dimension, not just commit+suite.

**Frente 2 — session isolation.** Maintainer hypothesis (2026-07-05): "per-instance transcript isolation
should be a native DEFAULT whenever the runtime permits — I never want two same-runtime agents in a shared
cwd without it." This is ALREADY realized by runtime-specific mechanisms: claude = per-session uuid +
customTitle (spec 220, logical isolation); codex = private CODEX_HOME (spec 357, physical isolation, now the
default). The `isolate: transcript` CHECKBOX is now VESTIGIAL (redundant for codex, overlapping "Isolated
harness" for claude) — it presents as opt-in what is guaranteed.

**The synthesis:** isolation mechanism, delivery contract, and startup quirks are all facets of ONE thing —
what Tachyon knows about a runtime. A RUNTIME PROFILE holds them; onboarding a new runtime (opencode) means
INTERVIEWING it and capturing its profile, not discovering quirks one-by-one in production.

"Done" looks like: a versioned per-runtime profile drives (a) automatic per-instance transcript isolation
(the checkbox goes away), (b) auto-injected delivery gates on spawn, (c) optional Bridge-side verification of
the FINAL REPORT — and adding a runtime is "interview + write its profile."

## The runtime profile (shape)

A profile per runtime declares at least:
- **isolation**: the mechanism guaranteeing per-instance transcript isolation — `mint` (own uuid + title
  match, like claude) or `private-home` (redirected config home, like codex/357). Tachyon applies it BY
  DEFAULT; there is no opt-in checkbox for the collision concern.
- **delivery**: the DONE_WHEN + FINAL REPORT gates injected into an implementation brief for this runtime
  (codex needs the strict evidence gate; a runtime that commits by habit may need less).
- **correctness**: whether a per-task smoke/dogfood declaration is required beyond suite-green.
- **startupPrompts**: interactive prompts to auto-pass at spawn (codex "Hooks need review"; claude "Bypass
  Permissions") — see t-4a70a0/t-4e286c.
- **capabilities/limits**: e.g. rate-limit accounting (t-71ec3b — the claude-fleet-shares-one-quota fact is
  profile data), resumable/mint vs capture, etc.

## Acceptance criteria

- [ ] **Isolation is a default invariant, not a checkbox**
  - Every agent instance gets per-instance transcript isolation via its runtime profile's mechanism
    automatically; two same-runtime agents in a shared cwd never share a transcript namespace. The
    `isolate: transcript` UI checkbox is REMOVED (or repurposed strictly to "Isolated harness" = own
    config/MCP/skills, the stronger, still-optional thing).
- [ ] **Delivery contract auto-injected by runtime** (frente 1a)
  - `spawn_agent`/the spec-246 delegation contract appends the runtime profile's delivery gates (DONE_WHEN +
    FINAL REPORT) to an implementation brief automatically; a coordinator passes task/context/constraints and
    the system attaches the right gate for the child's runtime. No hand-authoring.
- [ ] **Correctness dimension** (frente 1b — "green is not correct")
  - An implementation brief may declare a smoke/dogfood step; the delivery gate requires the agent to state
    how it verified the feature LIVE, not only "suite green".
- [ ] **Bridge-side verification (optional/strong)** (frente 1c)
  - `update_task(status:done)` on a delegated implementation task is accepted only if the FINAL REPORT
    evidence validates — the reported commit hash EXISTS in git and the suite result is present. Convention
    becomes an enforced gate. (Design: how strict, and the escape hatch for non-code tasks.)
- [ ] **Onboarding by interview**
  - Adding a runtime = a documented "interview it + record its profile" flow (the mechanism used for codex
    2026-07-05), producing a profile entry — not production trial-and-error.
- [ ] **Supersedes the stopgap memory**
  - The per-runtime knowledge currently in the coordinator's memory (implementation-runtime-codex) moves into
    the profile system; the memory becomes a pointer.

## Non-goals

- Not changing claude's or codex's isolation MECHANISM (220/357 stand); this codifies + generalizes them.
- Not the rate-limit auto-continue feature itself (t-71ec3b) — but the rate-limit TOPOLOGY is profile data.
- Not removing "Isolated harness" (that's the legitimate stronger, opt-in isolation).

## Open questions

- Where do profiles live? (a config file, a versioned system table, code?) Editable by whom?
- Bridge-side verification strictness: block done vs warn? How to handle tasks with no code deliverable
  (docs, design) that have no commit hash?
- How much of the delivery gate is universal vs runtime-specific (claude may need the same gate — the
  green≠committed quirk is codex-leaning but the FINAL REPORT helps everyone)?
- Interview cadence: one-time on onboarding, or periodically re-interviewed as the runtime's CLI evolves
  (codex 0.142.5 today; behavior may drift across versions)?


## DUETO FOLD (probe codex 525ea0c8, 2026-07-05) — the design sharpened hard

The codex reviewed a spec that profiles codex, and demolished the soft parts. 3 blockers, all ACCEPTED —
they reshape the design. THE THROUGH-LINE: the spec conflated **delivery INTEGRITY** (Bridge-verifiable) with
**CORRECTNESS** (not verifiable by the Bridge). Everything below enforces that separation.

### 1. Integrity ≠ correctness (blocker 1 — the reframe)
The Bridge validates **artifact INTEGRITY, not semantic correctness.** It may block only missing verifiable
artifacts: a commit when the task requires persisted change, a clean/explained worktree, a suite run with the
literal command + result, diff/files tied to scope. **Correctness stays REVIEWABLE evidence** — a
task-specific smoke, marked `reviewable evidence`, NEVER `verified correct`. Spec text: "Bridge validates
delivery integrity, not semantic correctness; correctness requires a task-specific smoke/review policy."

### 2. Contract MODES, not one monolith (majors 2/3/9 — no universal injection)
Injecting the full FINAL REPORT into EVERY codex spawn hurts low-friction work (questions, review, explore,
probes) and incentivizes junk commits. Fix: a `contract_mode` derived from task type —
`answer_only | review | explore | implement | release`. Only implement/release get DONE_WHEN + FINAL REPORT.
`review` wants findings+evidence, no commit. `explore` wants conclusion+uncertainties, no suite. A
`bounded_probe/json_only` escape disables the operational report entirely. The profile stores templates PER
MODE. And an `artifact_policy`: `required_commit` (implement) / `no_commit_expected` (analysis/design/review)
/ `optional_patch`; FINAL REPORT accepts `commit: none` with an enumerated reason; for implement the hash
must belong to HEAD/the expected branch, not merely "exist in git".

### 3. Profiles rot silently → fingerprint + drift + profile-smoke (blocker 4)
A profile captures ONE version's behavior; the CLI changes (codex 0.142.5 today) and a stale profile applied
as system data escalates error to ALL delegations. Fix: a `profile_fingerprint` (runtime, CLI version, model
family, tool-schema version, sandbox semantics, capture/resume support, prompt-contract version). The Bridge
compares the live fingerprint at spawn; on drift beyond tolerance → mark `stale` and FAIL-CLOSED for
implement/release (or drop to a conservative contract). Plus an automated **profile-smoke**: synthetic
microtasks that measure commit behavior, FINAL-REPORT adherence, isolation path, resume/capture — run to
DETECT drift, so re-interview happens only when the smoke or fingerprint says so.

### 4. Onboard = interview (hypothesis) + empirical probes (measured) (major 5)
Interviewing is SELF-REPORT — a codex can describe its defaults plausibly and wrongly. The interview yields
profile CANDIDATES; Tachyon then VALIDATES with probes (real isolation, transcript location, respected env
vars, commit/report compliance, rate-limit/capture behavior). A profile activates only after probes pass.
Every field carries `source: measured | declared | assumed`; the Bridge treats declared/assumed as
lower-confidence.

### 5. Isolation is a MEASURED property, not a UI intent (blocker 6 — don't blindly remove the valve)
Removing the checkbox assumes every runtime has mint or private-home. If opencode ignores HOME and has no
uuid/title, removing the manual valve HIDES the risk instead of creating isolation. Fix:
`isolation: none | unknown | mint | private-home` with `verified: true/false`. The Bridge FAILS CLOSED on
`unknown/none` for normal delegation — such a runtime is restricted to `isolated harness` or an explicit,
admin-opt-in `unsafe_shared_transcript` with a warning. "Default invariant" must be a MEASURED property.

### 6. Smoke tied to RISK, not the word "smoke" (major 7)
"I smoked login" without opening the app is worthless — the codexHome/auth gain came from a RISK-SPECIFIC
smoke, not the label. Fix: structured `smoke_evidence` (command, URL/route, input, observed result, optional
artifact) + a `risk_to_smoke_mapping` (each smoke ties to a risk of the change). A generic "app opens" does
NOT satisfy when the task touches auth/persistence/filesystem/resume. Where possible the Bridge checks the
harness actually ran the command / has the log/screenshot.

### 7. Profile governance (major 8/10)
A wrong profile is MORE dangerous than a bad instruction — applied automatically + invisibly to many
sessions. Fix: a `Profile governance` section — profiles are VERSIONED, OWNED, REVIEWED, rolled out with
traceability; no local edit silently changes all of a runtime's delegations. And typed sections
(`measured_capabilities`, `operational_limits`, `prompt_quirks`, `policy_contracts`, `isolation_mechanism`),
each item with `source`, `verified_at`, `valid_for_versions`, and defined behavior when unknown.

**Net:** the profile is no longer "a table of quirks we trust" — it's a MEASURED, fingerprinted,
mode-parameterized, governed contract where the Bridge enforces INTEGRITY and correctness stays honestly
reviewable. Nothing rebutted; the codex profiling itself was the sharpest possible reviewer. Design-first —
awaiting maintainer ratification before any implementation.
