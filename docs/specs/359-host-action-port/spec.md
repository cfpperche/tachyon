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
