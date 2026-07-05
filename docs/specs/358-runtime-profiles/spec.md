# 358 — runtime-profiles

_Created 2026-07-05._

**Status:** draft

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
