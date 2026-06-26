# 268 — agent-browser-form-driving (v2)

_Created 2026-06-26._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | superseded | abandoned | deferred. -->

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

- [ ] **Scenario: a headless write is auto-denied without confirmation**
  - **Given** the write-confirmation wiring is active and the agent (non-TTY) issues a state-mutating action
    (e.g. `click @e5` on a submit button)
  - **When** it runs
  - **Then** the action is **not executed** — it returns `confirmation_required` with an id and is auto-denied
    (non-TTY / 60 s), so a write never happens silently. The agent surfaces the pending action + id to the human.

- [ ] **Scenario: an explicit human confirmation lets the write through**
  - **Given** a pending write with id `c_…`
  - **When** a human approves it (`confirm c_…`)
  - **Then** the action executes exactly once; a `deny` (or timeout) blocks it. The decision is recorded.

- [ ] **Scenario: reads stay frictionless (v1 unchanged)**
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

## Non-goals (v2)

- A Tachyon login-broker (still the CLI vault + human headed-login from v1).
- `agent-browser mcp` typed surface → still v1.1 (separate).
- Provisioning Chrome (host-detect, from v1).
- **Always-on enforcement that the agent cannot bypass** — env/flag-based gating depends on the mandated session
  env; a launcher that injects default env/args for a tool would make it bypass-proof but is an **engine**
  change, tracked as OQ1, not built here.

## Open questions

- **OQ1 — launcher-injected default env/args.** Should the Tachyon tool model let a plugin declare default
  env/flags the launcher *always* applies (so `--confirm-actions` can't be omitted)? Would make v2's gate
  bypass-proof; it is an engine enhancement (spec 265 family), out of scope here but the cleanest long-term home.
- **OQ2 — exact write categories.** Pin the precise `--confirm-actions` category strings (and the command→category
  map for click/fill/type/upload/submit) from the binary during the build.
- **OQ3 — action-policy JSON vs env categories.** Ship a bundled static `--action-policy` as the default, or rely
  on the env categories + `--confirm-interactive`? (Lean: env default; bundled policy optional for stricter consumers.)
- **OQ4 — log capture point.** Does the skill wrap writes to append the log, or can a CLI flag emit a structured
  action log directly?
