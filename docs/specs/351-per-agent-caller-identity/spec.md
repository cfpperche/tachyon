# 351 — per-agent-caller-identity

_Created 2026-07-04._

**Status:** draft

## Intent

The Bridge authenticates every caller with ONE shared Bearer token, so it cannot tell agents apart: every
self-identifying tool param (`spawn_agent.parent`, `notify_agent.agent`, `create_task.agent`,
`create_pin.agent`, `attach_evidence.producer`, continuity/handoff `agent`, `probe_agent.caller`) is
self-declared and unverifiable. Task t-d7b3a9 documented the real damage from one evening: a coordinator
guessed `parent=claude` and mis-rooted a child's lineage + completion signal; a reviewer self-named "codex";
self-assign notification suppression is UNIMPLEMENTABLE (the update_task handler cannot know its caller —
348's known limitation). Layer A (shipped) made identity discoverable; this spec is **layer B: the Bridge
RESOLVES the caller** via per-agent tokens, following the spec-230 per-node nonce precedent.

Honest security posture up front: env-held tokens are readable by any same-user process — this is
**provenance hardening** (mistakes become impossible, casual spoofing becomes deliberate), not a sandbox.
The same residual Tachyon already documents for the pipeline nonce and every provisioned tool.

## Mechanism (the shape, for the dueto)

- **Mint**: at spawn AND resume, AgentManager mints a per-agent secret and injects it as the SAME
  `TACHYON_BRIDGE_TOKEN` env var agents already use — zero change to agent-side MCP config; the VALUE
  becomes per-agent instead of shared. Registry (in-memory, host-side): token → agent name.
- **Resolve**: Bridge.ts's auth check resolves the Bearer to a caller name and threads it into the
  per-request `registerTools(mcp, {...deps, caller})` — no global state, fits the stateless design.
- **Human/external**: the workspace master token remains (the "Copy Bridge Token" command) and resolves to
  caller `"human"`. Unknown-but-valid-master = human; invalid = 401 as today.
- **Tool semantics**: self-identifying params become OPTIONAL; when omitted → resolved caller is used; when
  present and different from the resolved caller → structured mismatch ERROR (never silent override).
  `spawn_agent.parent` defaults to the caller. `notify_agent.agent` defaults to the caller (docs finally
  get to say "Bridge-resolved" truthfully). `update_task` gains caller awareness → self-assign suppression
  works.
- **Compat window**: the legacy shared token stays valid during migration resolving to caller `undefined`
  (tools behave exactly as today: declared params accepted, no validation) — running agents keep working
  until their next respawn/resume picks up a per-agent token. A setting can later retire the legacy path.

## Acceptance criteria

- [ ] **Scenario: minted identity**
  - **Given** any agent spawned or resumed by Tachyon
  - **Then** its `TACHYON_BRIDGE_TOKEN` is unique to that agent (constant-time compared, like the 230
    nonce), the host registry maps it to the agent name, and kill/restart/dismiss invalidates it
- [ ] **Scenario: resolved caller wins**
  - **Given** a tool call whose Bearer resolves to agent X
  - **Then** omitting the self-identifying param uses X; passing the param equal to X succeeds; passing a
    different value fails with a structured mismatch error naming both values — covered for
    spawn_agent.parent, notify_agent.agent, create_task/create_pin agent, attach_evidence.producer,
    continuity/handoff agent, probe_agent.caller
- [ ] **Scenario: lineage cannot be mis-rooted** (the t-d7b3a9 case)
  - **When** agent X calls spawn_agent without parent (or with parent=X)
  - **Then** the child's parent is X — the claude-2 mistake becomes structurally impossible
- [ ] **Scenario: self-assign suppression works** (348's known limitation closes)
  - **When** resolved caller X assigns a task to X
  - **Then** no assign notification fires; assigning to a DIFFERENT live agent still notifies
- [ ] **Scenario: human and legacy callers**
  - **Then** the master token resolves to "human" (which identity claims the human path may make is decided
    in plan — e.g. human authors pins/tasks but is never a spawn parent); the LEGACY shared token
    (pre-migration sessions) resolves to undefined and preserves today's behavior verbatim, documented as
    the unvalidated path
- [ ] **Scenario: resume continuity**
  - **When** an agent is stopped and resumed
  - **Then** the resumed session gets a fresh valid token (old one invalidated) and its identity resolves
    identically — the stop/resume remedy for MCP staleness must not break identity
- [ ] Docs updated to the new truth: "Bridge-resolved when your session carries a per-agent token"; the
  honest residual (same-user env access) documented; no overclaiming
- [ ] Tests: registry mint/invalidate lifecycle; resolution + mismatch for every listed tool; legacy-token
  fallback parity (existing bridge tests run under the legacy path unchanged); constant-time compare; human
  token path
- [ ] Live dogfood: a spawned agent calls notify_agent with NO agent param (resolved), the RIGHT param (ok)
  and a WRONG param (mismatch observed); self-assign produces no poke

## Non-goals

- Sandboxing / cross-user security (env residual documented; out of scope).
- Per-agent authorization SCOPES (which tools an agent may call) — identity only; scopes are a future spec
  (the 349 plugin-UI action broker will want them — deliberate sequencing).
- Retiring the legacy shared token in this delivery (compat window stays until a follow-up flips a setting).
- Changing the pipeline nonce mechanism (230 stays; this generalizes its idea, not its code).

## Open questions

- Mismatch on identity params: hard error everywhere, or warn-and-resolve during a deprecation window?
  (Leaning: hard error — silent divergence is the bug class being killed.)
- Probe runtime gets per-run tokens like pipeline nonces? (Leaning: yes, same mint path.)
- Registry persistence across extension-host reloads: re-mint on activation (surviving tmux sessions would
  401) vs persist in workspaceState so they stay valid. (Leaning: persist — tmux outliving the host is
  Tachyon's normal, see t-2d3580.)
