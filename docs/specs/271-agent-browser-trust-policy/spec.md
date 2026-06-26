# 271 — agent-browser-trust-policy

_Created 2026-06-26._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

> **Debate (2026-06-26) — verdict: REDESIGN.** See `debate.md`. Two adversarial reviewers (codex + a Claude
> security red-team), empirically confirmed against the binary, found the **per-command origin preflight** is not an
> authorization boundary (TOCTOU + popup/iframe/redirect confusion) and the **env-scrub/denyArgs denylists are far
> too narrow** (the binary honors `AGENT_BROWSER_INIT_SCRIPTS`/`_EXTENSIONS`/`_AUTO_CONNECT`/`_CDP`/`_STATE`/… +
> loader env; `--init-script`/`--auto-connect`/`connect` bypass readonly; the stateful command surface escapes the
> confirm list). Recommended pivot: **session-scoped, domain-pinned trust** (force `AGENT_BROWSER_ALLOWED_DOMAINS`)
> under a **sterile env + arg + command allowlist** (not denylist). The model below is the pre-debate design,
> retained for context; rewrite pending owner ratification of the pivot.

## Intent

Give the human a **per-site trust policy** for the `agent-browser` tool so browser work stops paying per-action
confirmation friction where the human has already decided it is safe — and tightens to read-only where the human
wants it locked. The human curates, per site: `bypass` (writes run, no confirmation), `confirm` (the spec-268
default — writes are held), or `readonly` (writes are **hard-denied**, reads only). The launcher (Tachyon) enforces
it; the **agent never sets or loosens it**. This is the first consumer of the spec-270 configurable-plugin UX: the
human edits the policy through the Plugins-view config editor and reaches the docs via the card's Docs button — but
the policy's **storage + enforcement** ride a Tachyon-owned, launcher-only lane, not generic agent-writable config.

Today the agent-browser write-gate is **static and total**: the plugin manifest forces
`AGENT_BROWSER_CONFIRM_ACTIONS=<all write categories>` for **every** invocation (spec 268/269), so every write on
every site is held. There is no notion of a trusted site. This spec makes the gate **dynamic and per-site** while
keeping it launcher-owned.

**Governance invariant (non-negotiable):** the human OWNS the policy. The agent cannot author, repoint, or relax
it. The launcher is the chokepoint. The spec-269 `denyArgs` already refuses the agent's
`--confirm-actions`/`--action-policy`/`--config` **args** and the `mcp`/`batch` side-channels. This spec closes the
matching **env** hole and makes `bypass` a launcher-computed decision, never an agent-supplied one.

## Enforcement architecture (Tachyon-side, per-command — the decided fork)

The upstream `agent-browser` binary has `--action-policy`/`AGENT_BROWSER_ACTION_POLICY` + `--config`, but its
policy file format is undocumented and shows **no per-origin schema** on inspection → treat it as global, not
per-site. agent-browser is invoked **per-command** against a persistent browser session (open/click/fill are
separate processes; the launcher wraps every one in force mode). So Tachyon enforces per-site **itself** in the
launcher rather than delegating trust to the third-party binary:

1. Resolve the action **category** from the subcommand (read vs write; which write).
2. Resolve the session's **current origin** (conservative preflight, e.g. `agent-browser get url`).
3. Look up the human policy: event-override (if any) → site default → unlisted default (`confirm`).
4. Apply: `bypass` → launch **without** the confirm env for this call; `confirm` → force the confirm env (today's
   behavior); `readonly` on a write → **refuse to exec** with a stable, agent-readable deny.

**Fail-closed origin rule:** if the current origin cannot be resolved **confidently** (TOCTOU race, navigation in
flight, ambiguous session), the launcher falls back to `confirm` or `deny` — **never** `bypass`. `bypass` requires
a confidently-resolved origin that matches a human `bypass` entry.

**Env scrub (closes the spec-268 residual, now central):** today the launcher does
`env = { ...process.env, ...policy.env }` (`toolLauncher.ts:258`) — it forces `AGENT_BROWSER_CONFIRM_ACTIONS` but
lets a hostile `AGENT_BROWSER_ACTION_POLICY` / `AGENT_BROWSER_CONFIG` (and `~/.agent-browser/config.json` /
`./agent-browser.json` discovery) pass through. The launcher must **scrub/neutralize** every agent-browser
policy/config env + config-file discovery input, so the only policy the binary sees is the one the launcher
computed from the human's file.

**Done** = the human authors a per-site policy (via the 270 config editor) stored at a Tachyon-owned fixed path;
the launcher, on each agent-browser invocation, computes bypass/confirm/readonly from current-origin + category +
the human policy (fail-closed on origin ambiguity), scrubs agent-supplied policy/config env, and either launches
with the computed confirm posture or refuses a write on a `readonly` site with a stable deny message. The agent
cannot reach a relaxation outside the human policy.

## Acceptance criteria

- [ ] **Scenario: the human authors a per-site trust policy (fail-closed schema)**
  - **Given** the agent-browser Config editor (spec 270 UX) over the trust-policy schema
  - **When** the human saves `{ sites: [ { pattern: "example.com", level: "bypass" }, { pattern: "x.com",
    level: "readonly" }, { pattern: "app.example.com", level: "confirm", events: { eval: "confirm",
    download: "confirm" } } ] }`
  - **Then** it validates fail-closed: `level` ∈ {`bypass`,`confirm`,`readonly`}; `events` keys are **known
    normalized action names** only (no selectors/regex/DOM conditions) and unknown names **fail validation**;
    duplicate patterns rejected; size-capped. Precedence is explicit: **event-override > site default > unlisted
    site = `confirm`**.

- [ ] **Scenario: a `bypass` site runs writes without confirmation (launcher-computed)**
  - **Given** `example.com = bypass` and a confidently-resolved current origin `example.com`
  - **When** the agent issues a write (e.g. `click @e3`)
  - **Then** the launcher launches **without** the confirm env for that call — the write runs frictionless —
    **only because** the launcher computed it from the human policy + a confident origin, never from an
    agent-supplied flag/env.

- [ ] **Scenario: an unlisted site keeps today's held-for-confirm behavior**
  - **Given** a site absent from the policy
  - **When** the agent issues a write
  - **Then** the write is **held** exactly as spec 268 (default `confirm`) — no behavior regression for the common
    case.

- [ ] **Scenario: a `readonly` site hard-denies writes (no pending confirmation)**
  - **Given** `x.com = readonly`
  - **When** the agent issues a write on `x.com`
  - **Then** the launcher **refuses to exec** the write (no confirmation is created) and emits a stable,
    agent-readable line: `TACHYON_AGENT_BROWSER_POLICY_DENIED: x.com is readonly; action click is denied, cannot be
    confirmed; stop and ask the human to change policy or use read-only inspection.` Reads on `x.com` stay
    frictionless.

- [ ] **Scenario: origin ambiguity fails closed (never silent bypass)**
  - **Given** `example.com = bypass` but the current origin cannot be resolved confidently (navigation in flight /
    ambiguous session)
  - **When** the agent issues a write
  - **Then** the launcher falls back to `confirm` (or `deny`), **never** `bypass` — `bypass` requires a confident
    origin match.

- [ ] **Scenario: env/config side-channels are scrubbed (the central hardening)**
  - **Given** the agent has exported `AGENT_BROWSER_ACTION_POLICY=/tmp/loose.json` (and/or
    `AGENT_BROWSER_CONFIG`, and/or planted `./agent-browser.json` / `~/.agent-browser/config.json`)
  - **When** it invokes agent-browser through the launcher
  - **Then** the launcher **scrubs** every agent-browser policy/config env + neutralizes config-file discovery, so
    the binary sees **only** the launcher-computed posture; the agent's loosened policy has **no effect**. (Closes
    the spec-268 env/config residual, which this feature makes central rather than incidental.)

- [ ] **Scenario: the agent cannot author or repoint the policy**
  - **Given** the trust policy at a Tachyon-owned fixed path
  - **Then** the policy is human-authored (270 editor); the agent cannot select an alternate policy path via
    args/env (denyArgs + env scrub), and the launcher reads **only** the Tachyon-owned path. The same-user residual
    (the agent editing the human's file directly with a shell) is documented as out of scope — identical to spec
    268/269's honest scope; not advertised away.

## Non-goals

- Per-**selector** / regex / DOM-condition rules — events are coarse, normalized action names only (no scripting a
  policy).
- A general network/origin sandbox — this is per-command confirm-posture shaping, not isolation.
- Delegating trust to the upstream binary's `--action-policy` (kept as research / possible upstream contribution,
  not the local enforcement path).
- Bypass-proofing against a same-user shell agent that edits the policy file or runs the binary raw — that needs
  agent sandboxing (a separate containment layer, per spec 269 OQ1), not this feature.
- Credential exposure changes — saved sessions stay in `.tachyon/browser-state/` (gitignored), never shown to the
  LLM (unchanged from 267/268).

## Open questions

- **OQ1 — origin resolution mechanism + cost.** Is a per-write `agent-browser get url` preflight acceptable
  latency, or should we (a) read the persistent session's current URL from agent-browser's own state, or (b)
  contribute an upstream "report origin in the confirm/action payload" / atomic "resolve-origin-and-exec" primitive
  so `bypass` has a stronger-than-preflight guarantee? Lean: ship the conservative preflight (fail-closed) in v1;
  pursue the upstream primitive for a hardened `bypass` later.
- **OQ2 — site pattern matching.** Exact-host only, or host + subdomain/path globs? Scheme handling (force https?
  treat http as never-bypass?). Lean: exact registrable-domain/host match in v1, https-only for `bypass`; defer
  globs.
- **OQ3 — policy storage + git.** Tachyon-owned fixed path (`.tachyon/plugins/agent-browser/trust-policy.json`?)
  committed vs gitignored; does it belong in the lockfile fingerprint (no — it's human-edited, must not trigger
  re-consent/drift, mirroring 270's config-excluded-from-fingerprint rule)?
- **OQ4 — `bypass` consent.** Should enabling `bypass` for a site require a one-time explicit acknowledgement in
  the UI (it's the only setting that *relaxes* the default gate), even though the agent can't set it? Lean: yes — a
  visible "this disables write confirmation for <site>" ack when the human first chooses `bypass`.
- **OQ5 — write-category granularity for `readonly`/events.** Reuse the exact spec-268 category set
  (click/fill/type/submit/upload/eval/download/…) for event overrides + readonly denial, and keep it in lockstep
  with the manifest's confirm-actions list so they can't drift. Confirm one canonical normalized list.
