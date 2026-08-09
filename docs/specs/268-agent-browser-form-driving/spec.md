# 268 — agent-browser-form-driving (v2)

_Created 2026-06-26._

**Status:** shipped
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

**Closure:** agent-browser → **2.0.0** declares a spec-269 `launchPolicy` forcing `AGENT_BROWSER_CONFIRM_ACTIONS`
(the mutating-command categories) + refusing the bypass surfaces (`--confirm-actions`/`--action-policy`/`--config`
/`mcp`/`batch`). Live-proven into `/home/goat/tachyon`: with the caller's env UNSET a common write (`click`) is
HELD (`confirmation_required` + id), reads run free, and an agent's `--confirm-actions ""`/`mcp`/`batch`/`--config`
is refused (`POLICY_CONFLICT`). SKILL.md teaches the held-write contract (surface the id + STOP; a human runs
`confirm <id>`; auto-deny 60s) + the allow-list/action-log conventions. Codex dueto returned **BLOCK on
"airtight"**; the maintainer ratified shipping **best-effort + honest scope** (see § Scope) — the cheap parts
folded (mcp/batch/config denied, expanded categories, de-overclaimed docs), the irreducible residuals (category
completeness, env/config-file override, self-confirm) documented as accepted limitations + future work (a launcher
`denyEnv` + a category-probe doctor would tighten them, still not airtight). NOT a sandbox; honest claim is "a
mechanical hold on common writes + a cooperative human-approval protocol." This also satisfies spec 269's
scenario 7 (the agent-browser write-gate fixture).

**Verify:** _(plugin payload in the external repo; proof is the dogfood transcript in notes.md)_

## Intent

Promote **form-driving** to a first-class agent-browser capability — `click` / `fill` / `type` / `press` /
`select` / `check` / `upload` / form submit — the actions that **mutate state** on a page. v1 (spec 267) shipped
read-first and gated writes with a **prose** policy in the skill ("ask before writing"); v2 makes that gate
**mechanical** by leaning on the CLI's *native* action-confirmation surface, and ships the form-driving workflow,
an action log, and enforceable domain restriction. The plugin goes **1.0.0 → 2.0.0**.

The enabling discovery: `agent-browser` has a built-in safety surface — `--confirm-actions <categories>` /
`AGENT_BROWSER_CONFIRM_ACTIONS` hold a write in a `confirmation_required` state with an id (`confirm <id>` /
`deny <id>` to resolve; **auto-deny after 60 s and auto-deny when stdin is not a TTY**), `--allowed-domains` /
`AGENT_BROWSER_ALLOWED_DOMAINS` restricts navigation, and `--action-policy <json>` is a static allow/deny/confirm
file. Because a Tachyon agent runs **headless (non-TTY)**, a write category placed under confirmation is
**auto-denied unless explicitly confirmed** — a genuine fail-closed gate, not a request the model can wave
through. v2 wires this on by default for write categories.

**Done (v2)** = with the plugin's write-safety wiring active, a headless agent's state-mutating browser action is
held + auto-denied unless a human explicitly confirms it (by id); reads/inspection (v1) are unchanged; navigation
can be restricted to an allow-list; every attempted/!confirmed/executed write is recorded to an action log; and
the skill teaches the snapshot → target → confirm → act form-driving loop with a staging-URL preference.

## Mechanism (ratified direction)

- **Default-on write confirmation.** The skill mandates exporting `AGENT_BROWSER_CONFIRM_ACTIONS=<write
  categories>` + `AGENT_BROWSER_CONFIRM_INTERACTIVE=1` **once per session**, so every subsequent write is held
  for confirmation and — because the agent shell is non-TTY — **auto-denied** unless a human runs `confirm <id>`.
  (Exact category strings — `click`/`type`/`eval`/`download`/… — pinned during the build from the binary's
  `confirmation_required` responses.)
- **Domain allow-list.** `AGENT_BROWSER_ALLOWED_DOMAINS` makes "prefer staging / avoid sensitive domains"
  enforceable, not advisory.
- **Action log.** Each write attempt (held / denied / confirmed / executed) is appended to
  `.tachyon/browser-actions.log` (gitignored) — capture the CLI's `--json` action result.
- **Static policy (optional).** A bundled `--action-policy` JSON for richer per-category allow/deny, for
  consumers who want a stricter default than the env categories.

## Acceptance criteria

- [x] **Scenario: a common write is HELD (not run silently) without confirmation**
  - **Given** the launcher-forced policy is active and the agent issues a common state-mutating action
    (e.g. `click @e5`)
  - **When** it runs
  - **Then** the action is **not executed** — it returns `confirmation_required` with an id (held; auto-denies
    after 60 s), so a common write never happens silently. The agent surfaces the pending action + id to the
    human. _(Shipped model: HELD, not the originally-drafted auto-deny — forcing `--confirm-interactive` would
    auto-deny on non-TTY and kill autonomous form-driving entirely.)_

- [ ] **Scenario: an explicit human confirmation lets the write through**
  - **Given** a pending write with id `c_…`
  - **When** a human approves it (`confirm c_…`)
  - **Then** the action executes exactly once; a `deny` (or timeout) blocks it. The decision is recorded.

- [x] **Scenario: reads stay frictionless (v1 unchanged)**
  - **Given** v2 active
  - **When** the agent navigates / `snapshot` / `screenshot` / `get text`
  - **Then** no confirmation is required — only write categories are gated; the read-first loop is unchanged.

- [ ] **Scenario: navigation is restricted to an allow-list**
  - **Given** `AGENT_BROWSER_ALLOWED_DOMAINS` is set (e.g. to a staging host)
  - **When** the agent tries to navigate off-list
  - **Then** the navigation is refused — the staging-URL / sensitive-domain preference is enforced, not prose.

- [ ] **Scenario: every write is auditable**
  - **Given** any attempted write (held, denied, confirmed, or executed)
  - **Then** it is appended to `.tachyon/browser-actions.log` (gitignored) with the action, target, url, and
    outcome — a forensic trail for what the agent did on the web.

- [ ] **Scenario: the form-driving workflow is taught + dogfooded**
  - **Given** the v2 skill
  - **When** an agent drives a real form on a test page
  - **Then** it follows snapshot → identify `@eN` target → (confirm) → act → verify, with the gate firing on the
    submit. Proven by a live dogfood against a local/staging form.

## Scope — best-effort hold, NOT airtight (maintainer-ratified 2026-06-26)

The codex dueto returned BLOCK on "airtight": agent-browser has more gate-override surfaces than a `launchPolicy`
(env-set + deny-flags) can fully close. The maintainer ratified shipping a **best-effort hold + honest scope**.
What ships: the **common** mutating actions are HELD; the direct bypass subcommands/flags (`mcp`, `batch`,
`--config`, `--confirm-actions`, `--action-policy`) are refused. **Consciously-accepted residuals** (documented,
not hidden):
- **Category completeness is not provable** — an unknown `--confirm-actions` category is silently ignored, so a
  rare/renamed mutator can run ungated. (A future doctor that probes the pinned binary would close this.)
- **Env/config-file override not fully closed** — `AGENT_BROWSER_ACTION_POLICY`/`AGENT_BROWSER_CONFIG` (env) and
  on-disk config files can weaken the gate; the `launchPolicy` can only **set** env, not unset it (setting `""`
  breaks the binary). (A future launcher `denyEnv`/unset capability would close the env half.)
- **Self-confirm** — a same-user shell agent can `confirm <id>` its own held action (the spec-269 residual). The
  skill's "surface + STOP, never self-confirm" contract makes the human the approver for a cooperating agent.

The honest claim everywhere: **"a mechanical hold on common writes + a cooperative human-approval protocol, not a
sandbox."**

## Non-goals (v2)

- A Tachyon login-broker (still the CLI vault + human headed-login from v1).
- `agent-browser mcp` typed surface → still v1.1 (separate).
- Provisioning Chrome (host-detect, from v1).
- **The soft env-mandated gate is no longer the plan.** Sequencing decision (2026-06-26, codex-agreed): the
  launcher-enforced gate is built FIRST as **spec 269 (tool-launch-policy)**, then v2 declares its `launchPolicy`
  so the write gate is mechanical end-to-end. v2 is **sequenced after 269** — no band-aid env-mandated gate ships.

## Open questions

- **OQ1 — RESOLVED → spec 269 (tool-launch-policy).** The launcher-enforced `launchPolicy { env, args, denyArgs }`
  is being built first (codex POSITION A); v2 will declare it. Codex also surfaced that env injection alone isn't
  bypass-proof (argv-conflict + raw-path execution) — 269 owns closing/scoping those.
- **OQ2 — exact write categories.** Pin the precise `--confirm-actions` category strings (and the command→category
  map for click/fill/type/upload/submit) from the binary during the build.
- **OQ3 — action-policy JSON vs env categories.** Ship a bundled static `--action-policy` as the default, or rely
  on the env categories + `--confirm-interactive`? (Lean: env default; bundled policy optional for stricter consumers.)
- **OQ4 — log capture point.** Does the skill wrap writes to append the log, or can a CLI flag emit a structured
  action log directly?
