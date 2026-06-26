# 271 — agent-browser-trust-policy

_Created 2026-06-26. Redesigned 2026-06-26 after the adversarial debate (see `debate.md`) — owner-ratified pivot
from per-command origin preflight to session-scoped, domain-pinned trust._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

## Intent

Give the human a way to mark a **browser session as trusted** for a fixed set of domains, so agent-browser work
stops paying per-action confirmation friction where the human has already decided it is safe — or to lock a session
**read-only**. The human declares **trust profiles**, each binding a session to a domain set and a level: `bypass`
(writes run, no confirmation, but **only on the pinned domains**), `readonly` (mutators denied, reads only), or the
implicit default `confirm` (the spec-268 behavior — writes held) for any session not in the profile list. The
launcher (Tachyon) enforces it; the agent never authors or relaxes it.

This replaces the original per-command "resolve the current URL, then decide" design, which the debate showed is
**not an authorization boundary**: the observed top-level URL is not the origin that receives a mutation
(popup/iframe/redirect/pending-confirm confusion), and the race between observation and action is intrinsic.
Instead, trust is **scoped to a domain-pinned session**: the launcher starts agent-browser with the browser's own
navigation filter forced (`AGENT_BROWSER_ALLOWED_DOMAINS=<profile domains>`), so a write **cannot land off the
trusted domains by construction** — there is nothing to race.

This is the first consumer of the spec-270 configurable-plugin UX (the human edits trust profiles through the
Plugins-view config editor; the card's Docs button points at the plugins repo). But — per the debate — the trust
**schema + storage path are first-party, Tachyon-owned code**, never derived from the (untrusted) plugin manifest.

**Governance invariant (non-negotiable):** the human OWNS the profiles. The agent cannot author, repoint, or relax
them. The launcher is the chokepoint and enforces via **allowlists, not denylists** (a denylist can never be
complete against the binary's full env/flag/command surface — the debate enumerated it).

## Enforcement architecture (session-scoped, allowlist-based)

agent-browser is invoked **per-command** against a persistent, **named** session (`--session` / `AGENT_BROWSER_
SESSION`, namespaced by `AGENT_BROWSER_NAMESPACE`) — the session is the state boundary. The launcher wraps every
invocation (spec-269 force mode) and, for the agent-browser tool:

1. **Identify the profile.** Read the invocation's session/namespace selector; match it to a human trust profile.
   No match → default `confirm` (today's spec-268 behavior, unchanged).
2. **Sterile env (ALLOWLIST).** Build the child env from a fixed allowlist of vars the tool legitimately needs;
   **drop everything else** — every `AGENT_BROWSER_*` policy/config/injection var
   (`ACTION_POLICY`, `CONFIG`, `INIT_SCRIPTS`, `EXTENSIONS`, `PLUGINS`, `CDP`, `AUTO_CONNECT`, `PROFILE`, `STATE`,
   `ARGS`, `PROXY*`, `ALLOW_FILE_ACCESS`, `DOWNLOAD_PATH`, `SOCKET_DIR`, …), the config-discovery inputs
   (`HOME`, `XDG_CONFIG_HOME`, `PWD`), and loader env (`LD_*`, `DYLD_*`, `NODE_OPTIONS`). The launcher sets a known
   `cwd`/`HOME` on `spawnSync` (today it sets neither — `toolLauncher.ts:186`).
3. **Force the domain pin.** For a `bypass`/`readonly` profile, force `AGENT_BROWSER_ALLOWED_DOMAINS=<profile
   domains>` (the binary restricts navigation to these — confirmed: "not allowed by domain filter").
4. **Arg ALLOWLIST.** Permit only the safe command + flag set; refuse `--init-script`, `--extension`,
   `--auto-connect`, `connect`, `--cdp`, `--profile`, `--proxy`, `--allow-file-access`, `--allowed-domains`,
   `--action-policy`, `--config`, `--confirm-actions`, `mcp`, `batch`, and any unknown flag (fail closed).
5. **Command category — DENY-BY-DEFAULT.** Classify the subcommand: an explicit **read allowlist**
   (open/snapshot/screenshot/get/read/find/is/wait/scroll/…) vs everything else = a **write**. For `bypass`: drop
   the confirm env (writes run). For `readonly`: **hard-deny** every write/mutator family
   (click/fill/…/eval/download/cookies/storage/route/clipboard/pushstate/auth/state/`confirm <id>`/trace/record)
   with the stable deny line. For `confirm` (default): force the confirm env (held), unchanged.

**Why session-scoping is the boundary:** even if the agent names a fresh session after a trusted profile, the
forced `AGENT_BROWSER_ALLOWED_DOMAINS` pins the browser to the human's domains — the agent gains exactly the trust
the human declared (those domains, that level) and nothing off-domain. There is no current-URL observation to race.

**Done** = the human authors trust profiles (via the 270 editor, first-party schema, Tachyon-owned path); on each
agent-browser invocation the launcher matches the session to a profile, builds a **sterile allowlisted env +
cwd/HOME**, forces the **domain pin** for trusted profiles, enforces the **arg allowlist**, and applies the level
(bypass: writes run on-domain; readonly: writes hard-denied; unlisted: held-for-confirm). The agent cannot
manufacture trust for an untrusted domain, inject a loosened policy/config/script via env or arg, or run a mutator
under readonly.

## Acceptance criteria

- [ ] **Scenario: the human authors a trust profile (first-party schema, fail-closed)**
  - **Given** the agent-browser Config editor (spec 270 UX) over the **Tachyon-owned** trust schema
  - **When** the human saves `{ profiles: [ { session: "shopping", domains: ["example.com"], level: "bypass" },
    { session: "research", domains: ["x.com"], level: "readonly" } ] }`
  - **Then** it validates fail-closed: `level` ∈ {`bypass`,`readonly`} (absence = `confirm`); `domains` are
    non-empty host patterns; `session` is a non-empty name; duplicates rejected; size-capped. The schema + path are
    first-party (not manifest-derived).

- [ ] **Scenario: a bypass session runs writes on-domain, frictionless**
  - **Given** profile `shopping → example.com → bypass`
  - **When** the agent runs `--session shopping ... click @e3` on `example.com`
  - **Then** the launcher starts the session with `AGENT_BROWSER_ALLOWED_DOMAINS=example.com`, a sterile
    allowlisted env, no confirm env → the write runs without confirmation. (Bypass is **launcher-computed** from the
    profile, never from an agent-supplied flag/env.)

- [ ] **Scenario: a bypass session cannot act off its pinned domains**
  - **Given** the same `shopping` (bypass, pinned to `example.com`)
  - **When** the agent tries to navigate/act on `attacker.com` within that session
  - **Then** the binary's domain filter blocks the navigation (the page never loads), so no write lands off-domain
    — the TOCTOU/redirect/popup confusion of the old design is structurally removed. (Coverage of
    iframes/popups/sub-resources is OQ1 — must be verified before build.)

- [ ] **Scenario: a readonly session hard-denies all mutators (deny-by-default)**
  - **Given** profile `research → x.com → readonly`
  - **When** the agent issues any write/mutator (`click`, `fill`, `eval`, `download`, `cookies set`, `storage`,
    `route`, `clipboard write`, `pushstate`, `auth …`, `state load`, `confirm <id>`, `trace`, `record`)
  - **Then** the launcher **refuses to exec** (deny-by-default: only the explicit read allowlist runs) with
    `TACHYON_AGENT_BROWSER_POLICY_DENIED: x.com is readonly; action <x> is denied, cannot be confirmed; stop and ask
    the human to change policy or use read-only inspection.` Reads stay frictionless.

- [ ] **Scenario: an unlisted session keeps spec-268 held-for-confirm (no regression)**
  - **Given** a session with no matching profile
  - **When** the agent issues a write
  - **Then** the launcher forces the confirm env and the write is held exactly as spec 268.

- [ ] **Scenario: env is a sterile ALLOWLIST (the deterministic-bypass class is closed)**
  - **Given** the agent exported `AGENT_BROWSER_ACTION_POLICY` / `AGENT_BROWSER_CONFIG` /
    `AGENT_BROWSER_INIT_SCRIPTS` / `LD_PRELOAD`, redirected `HOME`/`XDG_CONFIG_HOME`/`PWD` to planted configs, etc.
  - **When** it invokes agent-browser through the launcher
  - **Then** none reach the child: the launcher passes only an allowlisted env + a known cwd/HOME, so the binary
    sees only the launcher-computed posture. Adding a new upstream `AGENT_BROWSER_*` var cannot silently re-open the
    hole (allowlist, not denylist).

- [ ] **Scenario: dangerous args/commands are refused (arg allowlist)**
  - **Given** the agent passes `--init-script /tmp/mutate.js` (or `--auto-connect`, `connect 9222`, `--cdp`,
    `--extension`, `--profile`, `--allowed-domains other.com`)
  - **When** it invokes agent-browser through the launcher
  - **Then** the launcher refuses with a clear `POLICY_CONFLICT` (arg allowlist, fail closed) — a `readonly`/`open`
    "read" cannot smuggle a mutation via an injected script, and the agent cannot override the forced domain pin.

- [ ] **Scenario: the agent cannot author or repoint a profile**
  - **Given** profiles at the Tachyon-owned first-party path
  - **Then** the agent cannot select an alternate profile source via args/env, cannot widen a profile's domains, and
    cannot invent a profile for a new domain. The same-user residual (editing the human's profile file directly, or
    raw-exec'ing the binary outside the launcher) is documented as out of scope — identical to spec 268/269's honest
    scope; not advertised away.

## Non-goals

- Per-command origin resolution / a "current URL" authorization check — replaced by domain-pinned sessions.
- Per-**selector**/regex/DOM-condition rules — trust is per-(session, domain-set, level), coarse by design.
- A general network/process sandbox — this is session env/arg/command shaping + the binary's domain filter, not
  isolation.
- Delegating trust to the binary's `--action-policy` JSON — kept only as research / possible upstream contribution.
- Bypass-proofing against a same-user shell that edits the profile file or raw-execs the binary — needs agent
  sandboxing (spec 269 OQ1), not this feature.
- Per-event/per-action override maps (the pre-debate design) — superseded by the read-allowlist / deny-by-default
  model; a finer grain can be a follow-up if a real need appears.

## Open questions

- **OQ1 — domain-filter coverage (load-bearing; verify before build).** What exactly does
  `AGENT_BROWSER_ALLOWED_DOMAINS` restrict — top-level navigation only, or also iframes, popups/`window.open`,
  `about:blank`/`data:` opaque origins, and sub-resource requests? If it only filters top-level nav, a bypass
  session could still be driven to mutate an embedded off-domain frame. Empirically test the binary; if coverage is
  partial, narrow the `bypass` claim (e.g. bypass only for single-origin pages) or pin harder.
- **OQ2 — session identity + state isolation.** The launcher matches a profile by `--session`/`--namespace`. Does a
  trusted (bypass) session share browser state (cookies/profile dir) with untrusted sessions? Should a trusted
  profile force a dedicated namespace/state dir so a bypass session can't read/write another session's auth?
- **OQ3 — read allowlist completeness.** Pin the canonical read set vs the full command list, and re-derive it
  whenever the binary version bumps (a new read-looking command that mutates must default to write). The forced
  category list must stay in lockstep with the pinned binary version.
- **OQ4 — env allowlist contents.** The minimal env the tool needs to function under the launcher (PATH? a
  Tachyon-set HOME/cwd? `AGENT_BROWSER_SESSION`/`_NAMESPACE`? a Tachyon-owned `AGENT_BROWSER_SOCKET_DIR`?), so the
  sterile env doesn't break normal operation. Derive empirically.
- **OQ5 — profile storage + git.** Tachyon-owned first-party path (`.tachyon/agent-browser/trust-profiles.json`?)
  committed vs gitignored; excluded from the install fingerprint (human-edited, must not trigger re-consent/drift —
  mirrors 270's config-excluded-from-fingerprint rule).
- **OQ6 — bypass consent.** Should enabling `bypass` for a profile require a one-time explicit acknowledgement
  ("this disables write confirmation for example.com in session shopping"), even though the agent can't set it?
  Lean: yes.
