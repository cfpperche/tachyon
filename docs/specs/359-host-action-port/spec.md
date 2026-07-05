# 359 — host-action-port

_Created 2026-07-05._

**Status:** in-progress

## Intent

Tachyon's moat is **governed, safe orchestration** — an agent replacing the human as project orchestrator
so work runs unattended ([[tachyon-orchestration-moat]]). Closing that loop needs the agent to ACT in the
human's host: after installing a build, RELOAD the window; open a view; run an editor command — today the
human must do these by hand, which re-centers them as the bottleneck (the exact thing the moat removes).

But the moat is **host-agnostic**: the orchestration/governance engine must run identically on a future
Tachyon-for-IntelliJ or a desktop app. Baking `vscode.commands.executeCommand` + a VS Code command catalog
into the core would **couple the moat to one editor** — the failure mode the maintainer flagged.

So this spec introduces a **ports-and-adapters** split for "the agent acts on the host":

- **CORE (host-agnostic, the moat piece):** a `HostActionPort` — the abstract contract "an agent requests a
  named host action with args; it is checked against an allowlist, audited, and executed; the result (or a
  denial) comes back." Plus the GOVERNANCE around it: the allowlist schema, the audit log, the consent model,
  and the Bridge tool (`run_host_action`). The core owns the GOVERNANCE, never the mechanism.
- **ADAPTER (host-specific):** `agent-vscode` implements the port via `vscode.commands.executeCommand` and
  ships the VS Code command catalog. A future `agent-intellij` / `agent-desktop` implements the same port its
  own way. Same port, swappable adapters.

"Done" looks like: a coordinator can, unattended, install a build and reload the window through a governed,
audited, allowlisted channel — and the core that makes that possible contains **zero** VS Code API references,
proving the IntelliJ path is a new adapter, not a rewrite.

## Acceptance criteria

- [ ] **Scenario: agent reloads the window after installing a build**
  - **Given** `workbench.action.reloadWindow` is in the host-action allowlist
  - **When** the coordinator calls `run_host_action("reloadWindow")` after installing a VSIX
  - **Then** the VS Code window reloads with the new build; the action is recorded in the audit log; the
    caller is identified (spec 351 identity); and the coordinator re-attaches to the Bridge after reload
- [ ] **Scenario: a non-allowlisted action is denied**
  - **Given** `workbench.action.terminal.new` is NOT in the allowlist
  - **When** an agent calls `run_host_action("terminal.new")`
  - **Then** it is DENIED with an actionable message, nothing executes, and the denied attempt is audited
- [ ] **The core contains zero `vscode` API imports** — the `HostActionPort` + governance live in the
  host-agnostic engine; all `vscode.commands.executeCommand` / command-catalog code lives in the `agent-vscode`
  adapter. (Enforced by a lint/dependency check — the forcing function that proves portability.)
- [ ] The allowlist is **default-deny**: with no config, `run_host_action` executes nothing.
- [ ] Every host-action attempt (allowed or denied) is auditable with caller, action, args, result, timestamp.
- [ ] A second adapter (even a stub `agent-noop` / test double) can satisfy the port without touching core —
      demonstrating the adapter boundary is real.

## Non-goals

- NOT arbitrary command execution — this is an allowlisted, curated surface, not "the agent runs any VS Code
  command." Breadth grows by explicit allowlist entries the human adds.
- NOT the IntelliJ/desktop adapters themselves — this spec delivers the PORT + governance + the `agent-vscode`
  adapter as the first proof. Other adapters are follow-ups against the finished port.
- NOT re-solving 349's plugin capability model — but it must decide how a HOST-PROVIDER relates to it (see
  Open questions).
- NOT per-agent policy scoping (which agent may run which action) beyond the global allowlist — that composes
  with [[t-f8758f]] (per-agent policy guard) as a later layer.

## Open questions

- **Host-provider: new plugin type, or the shell itself?** 349's plugin system is for capabilities that run
  INSIDE a host (skills/MCP/UI). A host ADAPTER is more fundamental — it IS the host integration. Is
  `agent-vscode` a new "host-provider" plugin kind, or just the existing VS Code extension shell (which is
  already the VS Code adapter — all webview/sidebar/activation code lives there)? _Owner: maintainer + dueto._
- **The action broker is the attack surface** (same blocker the codex raised on 349): the agent→host action
  channel must be spec'd tightly — arg validation, no way to smuggle non-allowlisted actions via args, and the
  denial path fail-closed. _Owner: dueto (adversarial)._
- **Allowlist schema + who edits it.** Where does the allowlist live (tachyon.yml `hostActions:`? a governed
  system file?), what's its granularity (command id only, or id + arg constraints?), and what's the
  governance around editing it (a bad allowlist entry = a privileged capability granted)? _Owner: dueto._
- **Reload tears down its own executor.** `reloadWindow` kills the extension host + Bridge → the tool call's
  connection drops mid-flight. The contract must model this as "dispatch + expected disconnect + re-attach,"
  not an error. Is reload special-cased, or does the port have a general "action may terminate the adapter"
  flag? _Owner: dueto._
- **Audit location + retention.** Where the audit log lives, whether it's host-agnostic (core) or per-adapter,
  and how the human reviews "what did the agent do in my editor while I slept." _Owner: dueto._

## Sources
The moat thesis ([[tachyon-orchestration-moat]], t-ee7d5f) · 349 (plugin-ui-surfaces — the action-broker
blocker, host capability model) · t-f8758f (per-agent policy guard — sibling governance) · 351 (caller
identity — the audit needs it) · the dogfood loop (install → reload → validate) this closes.


## DUETO FOLD (probe codex 140c82b8, 2026-07-05) — 16 findings, 5 BLOCKERS, all ACCEPTED

The codex attacked with security + self-knowledge and demolished the naive design. THE THROUGH-LINE
(mostImportant): treating an allowlisted **command-id** as a safe capability is FALSE — VS Code
`executeCommand` is a broad DISPATCHER whose args reach tasks, terminals, extensions, callbacks, URIs,
command-URIs, and arbitrary code. A command-id allowlist is **security theater**: an agent doesn't ask for
"exec shell", it asks for a benign command with args that make another component run code. Without
per-action wrappers, strict schemas, an independent audit, and strong policy governance, `run_host_action`
becomes a **privilege-escalation API for unattended agents**. This reshapes the spec from "an allowlist +
executeCommand" into a **privileged, governed capability subsystem**.

### THE CENTRAL REFRAME (dissolves blockers 1, 10; majors 8, 9)
**No generic `executeCommand` port. No command-id allowlist.** Instead: a small set of **purpose-built,
individually-reviewed ACTION WRAPPERS** (`reloadWindow`, `openView`, …), each hand-written in the adapter with
its own closed arg schema, declared effects, preconditions, and adversarial tests. The "allowlist" becomes
**the set of implemented wrappers**, not a list of command-ids the agent may pass. `executeCommand` is an
adapter-internal implementation detail behind a wrapper — never exposed. When executeCommand is unavoidable
inside a wrapper: pin stable internal commands, version-gate the host, block extension-contributed commands,
log command provenance. This single decision removes most of the attack surface — the generic port WAS the
hole.

### Broker is the AUTHORITY; adapter is a minimal/untrusted EXECUTOR (blockers 2,5; majors 6,14,16)
- `run_host_action` IS a privileged capability (acting on the host unattended) — the spec was wrong to say it
  doesn't touch 349's capability model; it introduces one. **Per-agent AND per-action authorization happens in
  the CORE BROKER, before the adapter**, deny-by-default at the agent level too. Non-spoofable caller (351),
  versioned policy snapshot, explicit delegation chain. The adapter receives only a **validated action
  envelope**, never the policy.
- **Consent = an explicit versioned GRANT**: {subject, actions, arg-constraints, workspace, duration, adapter
  version, policy version, max risk tier, revocation}. Anything outside the grant fails closed.
- **Allowlist/policy is a ROOT capability with a human owner**: signed/hashed, per-session pinned, visible
  diff, risk-tier per entry, optional expiry, regression tests for dangerous entries; an agent CANNOT edit the
  policy that authorizes it without explicit consent; fail-closed if policy is absent/invalid/stale/divergent
  from the authorized snapshot. Same stale-system-data risk as 358's profile — treat it that seriously.

### Reload is a DESTRUCTIVE, unobservable action — never "dispatch = success" (blocker 3; major 11)
Model reload as an **async transaction checkpointed OUTSIDE the extension host**: persist `action_id` before
execution; `expected_disconnect=true`; deadline; and a reattach identity bundle persisted out-of-process —
`host_instance_id, workspace_id, extension_build_id, session_epoch, reattach_nonce`. After reload the broker
continues ONLY if all identifiers match AND the new session confirms the pending `action_id` AND a post-reload
health + build-version check passes. Explicit final states: `dispatched | disconnected | reattached_verified
| failed_to_return | returned_wrong_host | result_unknown`. **`result_unknown` is a DANGEROUS state** the
governance/UI must surface loudly — reload can be an adversarial smokescreen to bury a denial/error/audit.

### Audit: separate the AUDITOR from the EXECUTOR (blocker 4; major 12)
An append-only log the executor can write is just a convention. The broker emits to an **integrity sink**
outside adapter control (separate perms / local service): hash chain, `fsync` BEFORE execution, monotonic
sequence, actor identity, policy hash, canonicalized args (hashed; sensitive fields redacted by
classification), outcome later bound to `action_id`. The decision chain is logged: `requested_by,
delegated_by, policy_version, allowlist_entry_id, validated_args_hash, executor_adapter`. Allowlist changes
are audited too. This is the only thing that answers "what did the agent do while I slept."

### Args + effects (majors 9, 10)
Canonicalize args BEFORE the policy decision and audit (single representation, Unicode-normalized, closed JSON
schema, size/depth limits, URI/scheme validators, reject unknown fields, hash the canonical payload).
Classify every action by **effect type** — UI-only / lifecycle / filesystem / network / process /
extension-activation / workspace-trust / destructive-interrupting — and let policy allow/deny by effect +
context; composite-effect actions need wrappers that eliminate sub-effects or separate consent.

### The host-agnostic boundary is a DOMAIN, not a lint (majors 7, 13; blocker-adjacent)
"Core imports zero `vscode`" is necessary but insufficient — coupling leaks via shared host-shaped types,
embedded command-id constants, lifecycle/timing assumptions, Uri/Position serialization. Define a **canonical
host-neutral domain**: own `HostActionName`, own args, own error taxonomy, own lifecycle states; native
command-ids exist ONLY inside the adapter. Architectural tests ban command-id constants + host-shaped types in
core, not just imports. Replace the "stub adapter" acceptance with **adapter CONFORMANCE tests**: deny path,
malformed args, lifecycle, audit-before-execute, adapter-unavailable, timeout, reload-like disconnect,
policy-version mismatch, `result_unknown`. For VS Code, split a **minimal stable host shim** from the
reloadable plugin (the reload/update case is exactly when a plugin-packaged provider may be unavailable —
bootstrap circularity, major 6).

### Thrashing interlocks (major 15)
Rate limits per agent/action, circuit breakers, reload cooldown, max-consecutive-failures, and a `degraded`
state requiring human intervention after loops or repeated `result_unknown`.

### REVISED acceptance (supersedes the naive criteria above)
- The port exposes **named action WRAPPERS**, not a command-id allowlist; adding an action = writing +
  reviewing a wrapper with its schema/effects/adversarial tests. There is NO generic executeCommand path.
- The **broker (core)** authorizes per-agent + per-action, audits before executing, and owns the reload
  transaction state machine; the adapter only executes validated envelopes.
- Reload never reports success on dispatch; `result_unknown` is a first-class, surfaced state.
- Audit lives outside adapter control with a hash chain + fsync-before-execute.
- Policy/allowlist is human-owned, signed/pinned, fail-closed, and un-editable by the agent it governs.

### Scope tension for the maintainer (the real decision)
The dueto proved the GENERIC capability system is a serious security subsystem — bigger than "let the agent
reload the window." Two paths: **(A) the full governed subsystem** (the right long-term moat piece — broker
authority, capability wrappers, external-checkpoint reload, independent audit, policy governance); or **(B) a
minimal first slice**: ONE hand-written `reloadWindow` action wrapper (no generic port) + the external reload
checkpoint + the independent audit, deferring the general capability framework until a 2nd/3rd action needs
it. (B) closes the install→reload dogfood loop SAFELY now and grows into (A) without the naive hole. Nothing
rebutted; the security analysis was the sharpest possible reviewer. Design-first — awaiting maintainer
ratification (incl. the A-vs-B scope call) before any implementation.
