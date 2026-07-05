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


## RESOLUTION — declarative capability specs + risk ladder (maintainer + claude, 2026-07-05)

_Supersedes the "per-action hand-coded WRAPPER" language of the dueto fold. The dueto's SECURITY requirements
all stand (broker-authority, external-checkpoint reload, independent audit, policy governance, arg
canonicalization); only the "wrapper vs declarative" mechanism and the enable-model for dangerous actions
change — driven by the maintainer's maintenance/agility objection (hand-coded wrappers + a build per action
is insustentável)._

**The model is config-driven end-to-end. Zero build to add/remove/narrow an action, at any risk tier.**

1. **Full gate behind the broker, never raw to the agent.** The generic host command mechanism
   (`executeCommand` on VS Code) lives inside the adapter, invoked ONLY by the broker. The agent never gets a
   raw command channel.
2. **What the human curates is a DECLARATIVE capability spec, not a command-id.** Each enabled action is a
   data descriptor: `{ command, args.schema (CLOSED — rejects unknown fields, callbacks, command:/URI schemes,
   nested commands), effects[], risk_tier }`. The broker is written ONCE and enforces every spec generically:
   canonicalize args → validate against the closed schema → execute → audit. Adding/removing/narrowing an
   action = editing this config (hot-reloadable like tachyon.yml). **No wrapper code, no build.**
3. **Risk-tier LADDER — hard-deny by default, human enables ANYTHING they want; only the CONSENT strength +
   audit loudness scale with risk (never "needs code"):**
   - **bounded** (closed schema fully constrains the effect — reload, open a named view): low-friction enable,
     standing grant OK.
   - **unbounded / dispatcher** (args reach code — runTask, command-URI takers, terminal): STILL config-
     enableable, but the descriptor must HONESTLY declare `effects: [unbounded/reaches-code]` and a high
     `risk_tier`; enabling requires deliberate elevated consent (explicit opt-in, optionally session/duration
     scoped) + loud audit. The human turns it on **eyes-open**. Safety for dispatchers = HONEST LABELING +
     explicit human consent, NOT an engineer writing a wrapper.
4. **This preserves the dueto's real fear — no SILENT grant of dangerous power.** Dangerous actions are
   default-deny, high-risk-labeled, and require deliberate consent, so nothing arbitrary-code-level is granted
   without the human knowing. It does NOT artificially cap the agent (no "ask one-by-one / wait for a build").
5. **Wrapper demoted to an OPTIONAL declarative narrowing**, not a gate: to bound a dispatcher (e.g. "allow
   runTask but only taskName ∈ {build}") the human adds arg constraints in the SAME config
   (`args.schema.taskName.enum: [build]`) — still data, still no build. (Honest caveat: narrowing a dispatcher
   bounds WHICH sub-thing runs, not WHAT it does — a `build` task is still whatever tasks.json says; the human
   consents to that. The system's job is legibility + default-deny, not pretending a dispatcher is bounded.)

**Net:** total gate + declarative capability specs + a risk-tier ladder the human dials, all config-governed
(the policy-governance blocker still applies: human-owned, signed/pinned, fail-closed, un-editable by the
governed agent). Agility for the maintainer, arg-level safety the dueto demanded, and the agent's reach is
capped only by the human's consent — not by whether code was written. **Scope: A (full subsystem), ratified.**


## STRESS DUETO 2 FOLD (probe codex 36e62c0a, 2026-07-05) — 6 BLOCKERS, all ACCEPTED

The codex attacked the declarative+ladder model and was right: the config-driven model shifts trust onto
LABELS and SCHEMAS but does not PROVE the command's real semantics on the host. A human (or the agent via
file-write) editing config to enable "any command" re-opens everything — mislabeled dispatchers, unknown
commands, arg-borne code. This does NOT abandon config-driven agility; it adds the missing INDEPENDENT
sources of truth.

### 1. The classification is a SIGNED INDEPENDENT REGISTRY, not the descriptor/adapter/workspace (blockers 1,6; majors 11,15; minor 16)
`effects`/`risk_tier`/semantic arg types are the trust root — they must come from a maintainer/security-SIGNED,
versioned REGISTRY, never self-declared by the adapter (which has incentive+ability to lie) or by a
workspace file (the agent controls that). Descriptors are **policy artifacts with a supply chain**: owner,
review, sign, provenance, revocation; workspace-originated descriptors are DENIED; unknown/new commands are
`unbounded` by default until classified. **Reconciles the maintainer's agility:** the human's config ENABLES
from the signed classified catalog (data, no build); introducing a genuinely NEW command requires a signed
classification step (a governed data+signature update, still not a code build) — the "we curate what passes"
IS the signed registry. Consent UX shows the BROKER-DERIVED explanation (real command id, canonical args,
potential effects, why high-risk), never the descriptor's own label.

### 2. Closed JSON schema ≠ semantic safety → HOST-AWARE SEMANTIC TYPES + resolve-then-authorize (blockers 2,3; majors 8,14)
Allowed fields still carry capability-bearing references (URIs, paths, task labels, viewIds, extension ids,
command:-URIs, remote authorities, symlinks) that reach code. Need restricted SEMANTIC TYPES (`SafeFilePath`,
`NonCommandUri`, `ViewIdLiteralFromEnum`, `NoRemoteAuthority`, `NoSymlinkEscape`, `NoProviderActivation`…),
and canonicalization AT THE BOUNDARY that resolves the real resource — **authorize the RESOLVED identifier,
not the raw string**. Any field selecting a code-capable entity (task label, launch name, extension id,
custom-editor id, URI-handler id…) = `dispatcher-indirect` → must bind to a pre-resolved, pre-approved
entity. Any arg without a semantic model → `unbounded`.

### 3. bounded/unbounded is a SPECTRUM — add a compound tier + host_lifecycle_disruptive effect (blockers 3; major 12)
Effects depend on host STATE (installed extensions, workspace trust, registered handlers), not just args:
opening a URI can activate an extension; opening a view can spawn a webview/provider; opening a file can
trigger formatter/watcher/task-detection/trust prompts. Add a `contextual/compound` tier (stronger consent +
audit) and a dedicated effect `host_lifecycle_disruptive` (reload/quit/disconnect) that ALWAYS requires the
external checkpoint + separate consent regardless of a "bounded" schema. `bounded` is reserved for
idempotent, no-activation, deterministic, verifiable-scope operations only.

### 4. The authorizing policy lives OUTSIDE the agent's workspace, signed, human-only reload (blocker 4)
Hot-reloadable config inside the agent-controlled workspace IS the self-grant vector (agent edits it →
reload → gains capability, directly or via file-write/git/task) + TOCTOU. So the AUTHORIZING policy lives
outside the agent's reach, signed/pinned, OS-permission-protected; reload accepts only human-signed versions;
every authorization records `policy_hash` + `descriptor_hash` + `adapter/registry version`; any change →
fail-closed for existing grants until explicit revalidation. (Enabling a bounded action is still config-easy —
it just isn't a file the agent can write.)

### 5. Dispatchers: per-invocation / narrow break-glass, NOT standing grants; audit ≠ confinement (blocker 5; majors 9,10)
A standing grant for a dispatcher = unattended arbitrary execution; loud audit only documents damage after.
High tiers need PREVENTIVE controls (per-invocation approval, sandbox, dry-run, quotas, timeout, fixed
cwd/env, network/file boundaries, kill switch) — not audit-as-confinement. Grants are PRINCIPAL-SCOPED:
`{agent identity (351), delegation chain, workspace, task id, policy version, descriptor version,
expiration, concrete args hash}`; the broker rejects use outside that envelope even if a global config
enables the capability (reconciles [[t-f8758f]] per-agent guard — a global enable never bypasses per-agent
governance). Broad terminal/runTask = break-glass, not a normal capability.

### 6. Audit = decision + OBSERVATION (major 7)
Logging canonical command+args isn't enough when VS Code resolves effects dynamically. Log the DECISION
(policy/descriptor hashes, adapter identity) AND the OBSERVATION (host-state fingerprint, activation events,
provider chosen, files touched, result_unknown, executor receipt, fsync-before for critical events). Compound
actions require effect evidence or are marked `result_unknown`.

### RE-SCOPING (drives the plan) — the subsystem is large; the actual NEED is small
Two duetos prove the FULL model (signed registry + supply chain + semantic types + dispatcher confinement +
principal-scoped grants) is a serious security subsystem. But the motivating need — **reloadWindow after an
install** — is a single `host_lifecycle_disruptive` action with **NO args**, so it needs the broker skeleton
+ external-checkpoint + independent audit + out-of-workspace signed policy, but NOT the registry / semantic
types / dispatcher-consent machinery (which exist for ARG-bearing and DISPATCHER actions). So Phase 1 delivers
the reload loop safely on the minimal surface; the heavy security machinery (registry, semantic types,
dispatcher confinement) lands in later phases WHEN an arg-bearing/dispatcher action is actually wanted — each
of those phases gets its own hardening dueto before implementation. A (full subsystem) is the destination;
the reload loop is the safe first rung. Nothing rebutted — the security analysis was correct twice.
