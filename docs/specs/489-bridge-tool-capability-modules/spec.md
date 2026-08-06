# 489 — Bridge tool capability modules

_Created 2026-08-04._

**Status:** draft

**Ratification:** locked on 2026-08-05. The maintainer ratified the revised draft — the one that
already carries the dispositions from `review-claude-opus.md` (three P0, all addressed). Ratified
without amendment and **without scheduling**: the intent is agreed, the work is not queued.

Author note: this spec was written by the `codex` agent, which the maintainer removed from the roster
on 2026-08-05. Its only surviving work is this spec, brought to `main` by an isolated cherry-pick
(`6c69d4d3`) so the discarded Design Mode prototype on the same branch could not ride in with it. It
has no author to answer questions; the review and this ratification are what it has instead.

**Unblocks:** `t-3b47ad` — `registerTools` is one 4064-line function with 101 inline MCP tools. That
task was triaged as structural debt with no design behind it; this spec is the design.

## Intent

Tachyon currently defines 113 tools in one `registerTools` function and presents most of them to every
connected agent. The 26 `user_browser_*` tools are already hidden unless
`settings.companion.tabTools` is enabled, and optional subsystem wiring can reduce the live count. A
project that wants Tachyon only for agent-to-agent communication nevertheless
still gives its agents a large, distracting catalog containing worktree, browser, task, schedule,
configuration, command, approval, and lifecycle operations. Runtime refusals limit some calls, but
they do not remove irrelevant tools from discovery and they are not a substitute for least
authority.

Introduce project-scoped **Bridge capability modules**: stable, human-readable groups whose enabled
set determines which Bridge tools are registered for agents in that workspace. A human can, for
example, select the `communication` preset and agents then discover only the small communication
catalog. Existing projects remain behaviorally compatible until a human opts into a restricted set.
The selected set is visible and editable in Tachyon Settings, travels in `tachyon.yml`, and is
enforced at tool-registration time rather than only inside handlers.

This is an MCP authority and lifecycle boundary, not merely a UI filter. The implementation must
make catalog ownership mechanically complete, prevent self-grant through the agent-facing config
tool, state the same-uid shell limitation honestly, and define live-session changes.

## Vocabulary and proposed v1 catalog

- A **module** is a stable configuration id mapped to a disjoint set of Bridge tool names.
- A **preset** is UI sugar for a set of modules; presets are not stored as an independent authority
  source.
- An **enabled catalog** is the union of tools owned by the selected modules, further reduced by
  existing availability gates (for example, an unwired optional subsystem).
- A tool has exactly one owning module. Cross-module calls inside Tachyon are implementation details
  and do not implicitly expose the callee's tools.

The initial module boundaries are proposed as follows. The canonical registry created by this spec,
not prefix inference, owns the exact tool-to-module mapping.

| Module id | Human meaning | Representative tool families |
|---|---|---|
| `communication` | Talk to and wait for existing agents | `list_agents`, `notify_agent`, `read_output`, `write_input`, `wait_for_agent`, `wait_for_output` |
| `fleet` | Create, restart, stop, dismiss, acknowledge, and inspect agents/runtimes | `spawn_agent`, `spawn_terminal`, `kill_agent`, `restart_agent`, `acknowledge_agent`, saved-agent proposals, `runtime_condition`, `probe_agent`, `read_probe_result` |
| `worktrees` | Create, register, inspect, reconcile, or remove managed worktrees | all managed-worktree tools, including `worktree_hygiene` |
| `runtime-security` | Inspect and retire orphaned runtime credentials | `reconcile_runtime_credentials` |
| `tasks` | Read and mutate Tasks and their prototypes | `create_task`, `get_task`, `update_task`, `reconcile_task`, `append_task_note`, `list_tasks`, `attach_task_prototype`, `continue_task` |
| `coordination` | Pins, handoff, continuity, and context-renewal records | pin, continuity, and project-handoff tools; `renew_context` |
| `human` | Human attention, notification, and approval workflows | `notify`, `flag_for_human`, `request_human_attention`, `request_human_approval`, approval-list/status/cancel tools |
| `verification` | Verification, evidence, validations, re-anchoring, pipeline completion | `verify_agent`, `attach_evidence`, `*_validation*`, `complete_node`, `reanchor_agent` |
| `automation` | Declared commands, runbooks, and schedules | `run_command`, `list_commands`, `run_runbook`, `*_schedule*` |
| `configuration` | Governed project/configuration and evolution mutations | `write_tachyon_config`, `submit_evolution_review` |
| `host-actions` | Invoke separately policy-granted host actions | `run_host_action` |
| `user-browser` | Operate the separately installed Browser Companion | `user_browser_*` |
| `ide-browser` | Operate the browser hosted by the IDE and Design Mode | `ide_browser_*`, `design_mode_chat_reply` |

There is no always-on model-facing `core` module. There is, however, one transport invariant: the MCP
server must declare the `tools` capability and install the `tools/list` handler even when the selected
union is empty. The current SDK declares that capability lazily on the first `registerTool`, so the
implementation must separate capability declaration from Tachyon tool registration. An empty union
must return a successful `{ tools: [] }`, and list-change notification failures must be contained per
session rather than becoming unhandled rejections.

The built-in presets proposed for the Settings UI are:

- **Everything (compatibility):** every module.
- **Communication only:** `communication`.
- **Custom:** the exact checkbox selection.

## Configuration contract

The project-owned representation is proposed as:

```yaml
settings:
  bridge:
    toolModules:
      - communication
      - tasks
      - verification
```

- In a valid configuration, missing `settings.bridge.toolModules` means the **legacy compatibility
  catalog**: all modules enabled, still intersected with every pre-existing availability gate.
- An explicit empty sequence means **no model-facing Bridge tools enabled**.
- Unknown ids, duplicates, and non-string values are hard configuration errors; silently widening to
  all modules would violate the user's restriction.
- Serialization is deterministic in registry order. The UI displays each module's exact tool names
  and resulting tool count before saving.
- During the compatibility window, registration uses an AND: `user-browser` must be enabled and
  `settings.companion.tabTools` must be true. Thus an existing project with no module key and the
  legacy default `tabTools: false` does not gain 26 browser tools. Companion pairing, host
  allowlisting, and LAN access remain separate. Removal of the legacy bit requires a later migration.
- `ide-browser` becomes the catalog gate for `ide_browser_*`; whether the IDE browser is currently
  open affects call results, not discovery, once its module is enabled.

The registry is not descriptive metadata bolted onto the existing calls. `tools.ts` must expose one
module-aware registration wrapper as the only tool-registration door; a static guard forbids new
direct `mcp.registerTool` calls, and a golden assertion records every module's exact names and count.
The guard must be demonstrated red before green.

Configuration has three distinguishable states:

1. **Valid, never declared:** use the legacy compatibility catalog.
2. **Valid, explicitly declared:** use the exact selected union, including empty.
3. **Undeterminable:** missing file, invalid/unparseable file, or failed reload. Retain the last-known-
   good catalog in memory. On a cold start with no valid configuration, expose an empty catalog until
   valid configuration loads; never reinterpret failure as the compatibility default.

An older Tachyon version that does not understand `settings.bridge` cannot enforce this contract.
Downgrade/version-skew is an explicit limitation, not a security promise.

## Threat model, authority, and lifecycle contract

Capability modules bound the model-facing MCP catalog: what an agent discovers, is guided toward,
and can invoke through Bridge. They are not an OS sandbox against a process with shell access under
the user's uid. Such a process can edit `tachyon.yml`, read the current same-uid control nonce, and
reach engine operations. Closing that boundary requires process isolation or a non-agent-reachable
human witness and is outside v1.

The Settings surface is the intended human door for expansion. The agent-facing
`write_tachyon_config` path may preserve or reduce the currently loaded valid selection, but refuses
adding a module or deleting the restriction key. That comparison is against the last-known-good
loaded selection, not merely the current file, so an out-of-band edit cannot be laundered as “no
change” through the tool. Out-of-band edits are surfaced in diagnostics but, under the v1 threat
model, a valid file remains the project authority when it reloads.

A successful human change is pre-validated, persisted, reloaded, and then used to rebuild catalogs.
If reload fails after the write, the file may already have changed; the last-known-good live catalog
stays active and the failure is surfaced. Existing `forceToolListRefresh()` closes sessions
fire-and-forget and cannot guarantee that every runtime reconnects. Therefore narrowing is enforced
both at registration and at call time: a stale session cannot invoke a tool outside the current
accepted catalog. Runtime-specific integration tests establish which clients reconnect and relist;
the UI warns that saving interrupts active Bridge calls.

Tool signatures and session notification state are scoped per Bridge/workspace. Different module
selections in a multi-root window must not flip one global signature or notify unrelated sessions.
Pair/unpair and IDE-browser open/close do not alter module selection.

Guidance injected into an agent session must be capability-aware. It must not instruct an agent to
call a disabled tool, and it should briefly state that the project intentionally restricts the
Bridge plus point the human—not the agent—to Tachyon Settings for expansion.

## Actor × trigger matrix

| Actor | Trigger | Required result |
|---|---|---|
| Human / Settings | Save a narrower selection | Pre-validate, persist, activate, interrupt affected sessions, and show the exact resulting catalog |
| Human / Settings | Save a wider selection | Pre-validate, persist, activate, and show the authority-expansion warning |
| Human / Settings | Edit one workspace in a multi-root window | Scope preview, write, refresh, and notifications to that workspace only |
| Agent / `write_tachyon_config` | Preserve or narrow selection | Validate normally; activate only after a successful write/reload |
| Agent / `write_tachyon_config` | Add a module, delete the restriction, or select legacy “all” | Refuse without writing |
| Agent / shell or control socket | Attempt widening outside MCP | Outside the v1 sandbox boundary; if valid configuration reloads it becomes project authority, and diagnostics records the change |
| Tachyon | Initial valid load with no module key | Use legacy compatibility catalog intersected with existing gates |
| Tachyon | Initial load with explicit selection/empty list | Register exactly the accepted union/empty catalog |
| Tachyon | Cold start with missing/invalid config | Expose an empty catalog and a visible config failure; never infer compatibility-all |
| Tachyon | Reload becomes invalid | Retain the in-memory last-known-good catalog and expose the failure |
| Tachyon | Restart, resume, fork, or crash recovery | Recompute from valid project selection; never fall back to all because state is unavailable |
| Tachyon | Optional subsystem becomes online/offline | Preserve module selection; use the subsystem's documented stable-catalog or availability behavior without granting another module |
| Tachyon | Two workspaces use different selections | Keep signatures, sessions, list-change notifications, and refreshes workspace-scoped |
| Tachyon | Older binary opens a config with modules | Explicitly unsupported downgrade; warn in release/migration documentation rather than claiming enforcement |

These rows are also the minimum named integration-test matrix.

## Acceptance criteria

- [ ] **Scenario: communication-only project has a small catalog**
  - **Given** a valid project with `settings.bridge.toolModules: [communication]`
  - **When** an authenticated agent connects and requests `tools/list`
  - **Then** the response contains exactly the canonical `communication` tools and none of the task,
    fleet, worktree, browser, configuration, human, verification, coordination, or automation tools
- [ ] **Scenario: an explicitly empty catalog is valid**
  - **Given** `settings.bridge.toolModules: []`
  - **When** an agent connects
  - **Then** Bridge authentication/transport still works, `tools/list` succeeds with `{ tools: [] }`,
    and list-change notification/refresh does not reject or crash any session
- [ ] **Scenario: existing projects remain compatible**
  - **Given** a valid pre-spec project with no `settings.bridge.toolModules`
  - **When** it loads after upgrade
  - **Then** it receives the same tool catalog it would have received before this spec, subject to the
    same optional subsystem wiring, and Settings labels that state as the compatibility default
- [ ] **Scenario: disabled tools are absent, not runtime-refused**
  - **Given** a module is disabled
  - **When** the agent requests `tools/list`
  - **Then** every tool owned by that module is absent from the advertised catalog
- [ ] **Scenario: a human changes modules**
  - **Given** a live agent session and a valid current selection
  - **When** the human confirms a different selection in Settings
  - **Then** the YAML is pre-validated and persisted, the accepted catalog changes only after a
    successful reload, stale sessions cannot call removed tools, and reconnecting covered runtimes
    receive a `tools/list` matching the preview
- [ ] **Scenario: an agent cannot self-grant capability**
  - **Given** an accepted restricted selection
  - **When** `write_tachyon_config` attempts to add a module, delete the module key, or otherwise
    reach the compatibility “all” state
  - **Then** the write is refused, the file and live catalog remain unchanged, and the response names
    the human Settings path for requesting expansion
- [ ] **Scenario: an invalid reload fails closed**
  - **Given** a restricted valid selection has loaded
  - **When** `tachyon.yml` gains any hard error and an explicit reload, restart, or lifecycle reload occurs
  - **Then** the last-known-good restricted catalog remains active and the configuration failure is visible
- [ ] **Scenario: cold invalid configuration does not become all**
  - **Given** no valid configuration has loaded in this engine process
  - **When** the file is absent, invalid, or from an unsupported newer schema
  - **Then** agents receive an empty catalog until valid configuration loads
- [ ] **Scenario: narrowing survives every agent entry door**
  - **Given** a restricted accepted selection
  - **When** an agent is created, restarted, resumed, forked, or recovered after a crash
  - **Then** each session receives the same restricted catalog
- [ ] **Scenario: invalid module configuration never widens authority**
  - **Given** unknown, duplicate, or malformed capability ids
  - **When** configuration is loaded or edited
  - **Then** validation refuses the change and retains the last accepted catalog rather than defaulting to all
- [ ] **Scenario: guidance agrees with discovery**
  - **Given** one or more disabled modules
  - **When** Tachyon composes startup, continuity, task, and handoff guidance for an agent
  - **Then** it does not direct the agent to disabled tools and states that expansion is human-governed
- [ ] Every registered Bridge tool has exactly one canonical module owner; a test fails on unowned,
  duplicate, or stale tool names and prints the offending names.
- [ ] Registration filtering is backed by a call-time check, so a session holding a stale catalog
  cannot execute a tool removed by a narrower current selection.
- [ ] Module ids and membership are versioned public configuration: renaming/removing an id requires
  an explicit migration and cannot silently change the enabled tool union.
- [ ] Settings provides Everything, Communication only, and Custom choices; Custom shows module
  descriptions, exact tools, total count, authority-expansion warning, and reconnect impact.
- [ ] The registration API declares MCP `tools` capability independently of the first Tachyon tool;
  per-session notification failures are contained, and tool signatures/session sets are not global
  across workspaces.
- [ ] A module-aware registration wrapper is the sole registration door; a fail-before-green static
  guard rejects direct calls and golden tests list exact names/counts per module.
- [ ] Capability-aware guidance has an explicit snippet-to-module registry and a fail-before-green
  test over emitted guidance, including live monitor nudges and agent-profile `bridgeGuidance`.
- [ ] Tool descriptions and existing per-tool authorization/refusal checks remain in force when a
  tool is enabled; module enablement never bypasses caller identity, approvals, or subsystem safety.
- [ ] The final implementation has schema/parser/editor tests, registration-level catalog tests,
  actor × trigger integration tests, and visual evidence at 880 px and 360 px for Settings.

## Non-goals

- Per-agent, per-runtime, per-task, or per-pipeline module selections in v1; selection is project-wide.
- Dynamically loading/unloading implementation code to reduce extension memory or package size.
- Replacing existing per-tool authorization, approvals, caller identity, or runtime safety checks.
- Claiming isolation from agents/processes that have same-uid shell, filesystem, or control-socket access.
- Designing a general plugin permission marketplace or arbitrary third-party module format.
- Inferring module ownership from tool-name prefixes; the registry is explicit even where prefixes align.
- Changing Browser Companion host/pairing security or IDE Design Mode behavior beyond catalog gating.

## Open questions

1. **Is the proposed module granularity right?** Owner: human maintainer after adversarial review. In
   particular, decide whether `verification` should split validations from evidence/verify and whether
   `coordination` should split continuity from pins.
2. **How long is the `settings.companion.tabTools` compatibility window?** Owner: release plan. The
   migration needs one explicit precedence/refusal rule and removal version.
3. **Should Communication only include `read_output`/`write_input`?** Owner: human maintainer. They
   communicate through terminal panes but are more invasive than notice-queue messaging; the UI may
   need separate `communication` and `terminal-io` modules.
4. **Which declared features require modules?** Owner: implementation plan. For example, a configured
   verify gate with `verification` disabled can create a completion dead end. Decide the minimum set
   of hard cross-validation rules rather than discovering contradictions at runtime.
