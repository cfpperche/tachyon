# 191 — tachyon-bridge-auth

_Created 2026-06-10._

**Status:** shipped
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred. Do NOT append dates/commits/test-counts/rationale here — that goes on the optional **Closure:** line below. -->

<!-- Optional — fill at ship/close time: date + evidence + residual scope. Keeps **Status:** a clean enum. Uncomment when closing. e.g. `**Closure:** 2026-06-10 — shipped at <commit>; <proof, e.g. tests N/N>; residual: none` -->
<!-- **Closure:** -->

<!-- Optional — declare when this spec produces UI; drives the visual-contract acceptance gate (spec 155). Omit or keep `none` for non-UI work. See .agent0/context/rules/visual-contract.md -->
**UI impact:** none

## Intent

_One paragraph. What is this change? Why now? Who/what is the user or system this serves?_

Umbrella 187 item **F3**, decided "implement this design, validated, dogfood prepared" (user, 2026-06-10). The Bridge listened on loopback with no authentication: any local process could call `read_output` (agent screens may carry secrets), `spawn_agent`, and — worst — `write_input`, i.e. arbitrary command injection into the user's shells, on a now-deterministic port. Honest threat model: the realistic adversary is a generic local process (supply-chain scripts); a token raises the bar from "hit an HTTP port" to "locate and read extension storage" — real mitigation against scanners/accidents, not a fortress against same-user targeted malware. Design: a **stable per-workspace token** in the extension's globalStorage (never in a committable file; mode 0600), required as `Authorization: Bearer` on every Bridge POST (constant-time compare, 401 otherwise), default ON with explicit `settings: {auth: false}` opt-out. **No secret in shared files**: registered configs reference the `TACHYON_BRIDGE_TOKEN` env var — `${VAR}` headers in Claude Code's `.mcp.json` (officially documented), `bearer_token_env_var` in Codex (first-class support), `{env:VAR}` in OpenCode, `mcp-remote --header` for stdio-only clients. The closing elegance: Tachyon already injects env into sessions it spawns, so **every Tachyon-launched agent gets `TACHYON_BRIDGE_TOKEN` (and `TACHYON_BRIDGE_URL`) automatically** — auth with zero manual steps in the normal flow; external sessions use `Tachyon: Copy Bridge Token`.

## Acceptance criteria

_Observable outcomes as Given/When/Then scenarios for behavior, plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan. See `.agent0/context/rules/spec-driven.md` § Acceptance scenarios for shape guidance._

- [x] **Scenario: unauthenticated calls rejected**
  - **Given** the Bridge with auth on (default)
  - **When** a POST arrives without (or with a wrong) Bearer token
  - **Then** it is rejected with 401 and an actionable error body; nothing is executed

- [x] **Scenario: spawned agents authenticate automatically**
  - **Given** an agent spawned by Tachyon with a registered config referencing `${TACHYON_BRIDGE_TOKEN}`
  - **When** the agent's MCP client connects
  - **Then** the env var (injected into its tmux session) expands into the header and the full tool flow works — no manual step

- [x] **Scenario: opt-out**
  - **Given** `settings: {auth: false}`
  - **When** the extension activates
  - **Then** the Bridge accepts unauthenticated calls (pre-F3 behavior)

- [x] **Scenario: no secret in committable files**
  - **Given** an auth-on registration
  - **When** `.mcp.json`/`opencode.json`/codex snippets are produced
  - **Then** they carry only env-var references (no 64-hex literal anywhere); the token lives in extension storage (0600)

- [x] **Scenario: token stability**
  - **Given** repeated activations of the same workspace
  - **Then** the same token is returned (registrations keep working); different workspaces get different tokens

- [x] `settings.auth` validated in loader + JSON Schema; auth-aware `upToDate` (a legacy auth-less entry is stale when auth is on); declared agent env overrides injected env on conflict
- [x] Unit coverage: token store, constant-time match, 401/200 live HTTP, env injection args, auth-aware adapters/offers, config shapes
- [x] Live integration (VSCode host): raw POST without token → 401; with the clipboard token → passes the gate
- [x] Live E2E: real `claude -p` with `headers: {"Authorization": "Bearer ${TACHYON_BRIDGE_TOKEN}"}` in --mcp-config + exported env var drove list_agents/notify against a tokened Bridge — proving the ${VAR} expansion works on this platform

## Non-goals

_What this change explicitly does NOT do. Future scope or adjacent problems that look similar but aren't in this spec._

- Defense against same-user targeted malware reading extension storage (declared out of scope; honest framing in README).
- TLS on loopback, token rotation/expiry, per-agent scopes — future hardening if the product is published.
- Unix-socket transport (would allow SO_PEERCRED) — MCP clients speak HTTP; not worth losing client compat.

## Open questions

_Unknowns to resolve before `plan.md` can be locked. Each should have an owner (who decides) or a path to resolution. Empty if there are none._

_None — design agreed in the F3 discussion; runtime env-expansion verified against official docs + live E2E._

## Context / references

_Links to related specs, prior art, issues, docs, conversations. Optional but useful._

- Umbrella: docs/specs/187-tachyon-v2-umbrella/ (F3).
- Verified: Claude Code `${VAR}` expansion in .mcp.json headers (code.claude.com/docs/en/mcp; known Windows-leaning bug reports — live-validated on WSL here); Codex `bearer_token_env_var` (developers.openai.com/codex/config-reference).
