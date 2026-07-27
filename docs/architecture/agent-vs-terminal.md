# Agent vs Terminal — the entity boundary

_Ratified 2026-07-27 (`t-9c7a5d`). Contract and migration: [SDD 478](../specs/478-agent-terminal-boundary/spec.md)._

## The rule

**An Agent is exclusively an entity operated by an LLM runtime that Tachyon supports and attests.**

**A Terminal is exclusively a generic process** — a shell, a server, a build, a watcher. A terminal has
no identity, no task, no memory, no model, no provider authentication and no agent lifecycle.

`cmd: sh`, echoers and prompt scripts are processes. They may never be declared or treated as agents —
not in `tachyon.yml`, not through a Studio, not through the Bridge, and **not in fixtures**.

## Why this is a boundary and not a preference

The distinction already decides things that matter. Whether an entity is an Agent determines whether
Tachyon will give it a task, a soul, a private config home, a git worktree, a verify gate, a resume
transcript, provider credentials and a restart policy. Getting it wrong is not cosmetic in either
direction: a process promoted to Agent is offered capabilities it cannot use, and an Agent demoted to
Terminal silently loses the ones it needs.

It went wrong in practice. `t-9418ac` spent three increments finding out that the editor-host test
suite could not start a workspace, and the cause was a fixture that declared three shell processes as
agents. Because every `agents:` entry must be a canonical profile pointer backed by a host authority,
that one invalid stanza invalidated the **entire** config — so commands, runbooks and schedules failed
for a reason that had nothing to do with agents. Two of the three were not even agents by Tachyon's own
inference; only a hand-written `kind: agent` had forced the third.

## What the boundary grants

| Agent only | Shared | Terminal only |
|---|---|---|
| runtime adapter, resume, fork | spawn / kill / restart policy | editor-terminal restore state |
| canonical profile + host authority | `autostart`, `watch` | |
| model identity, observed model | attention (terminals default off, may opt in) | |
| provider authentication (SDD 477) | pane presentation | |
| soul, self-evolution | crash exit code, postmortem pane | |
| role, instructions, spawn brief | | |
| task assignment | | |
| lineage (parent, delegator) | | |
| worktree, branch, verify gate | | |
| harness, transcript isolation | | |
| delivery join | | |
| continuity, memory, handoff, re-anchor | | |

The shared column is small and deliberately so: it is the process facts, not the agent facts. A
terminal restarts and can be watched because those are properties of *a process*, and a terminal can
opt into attention because pane-watching is runtime-agnostic. Nothing in the shared column implies an
identity.

## The three rules that keep it true

1. **Kind is declared and stored, never inferred.** No layer may decide Agent vs Terminal from a
   command string or a name. A persisted record carries its kind; one that does not is refused, not
   guessed.
2. **Agent-only capabilities are unrepresentable on a Terminal.** They are absent from the type, not
   merely rejected by a validator — a validator is added per field and therefore drifts per field.
3. **Ambiguity is refused with the fix in the message.** A generic command belongs in `terminals:`; an
   attested runtime belongs in a profile. The diagnostic names the block to move to, because the entire
   cost of the incident above was three increments spent discovering which block the entry belonged in.

For ad-hoc delegation, `spawn_agent` remains Agent-only: it accepts a supported, attested LLM runtime
through a lighter path that does not require a canonical profile. Generic commands use an explicit
Terminal operation instead.

## Where to declare what

```yaml
# A generic process. Supports autostart, watch, restart, and an explicit attention opt-in.
terminals:
  dev-server:
    cmd: npm run dev
    autostart: true

# An agent: a pointer to a canonical profile, backed by a host authority.
# Created through Agent Studio — never hand-written inline.
agents:
  reviewer:
    profile: .tachyon/agents/reviewer/agent.yml
```

Inline agent definitions are retired. `agents.<name>: inline agent definitions are no longer supported`
is the refusal, and it is correct.

## Consequences for tests

- **Agent semantics** are proven headless, against doubles in the domain, declaring an attested runtime
  name (`codex`, `pi`, `grok`, `claude`) with a fake tmux. No fake process stands in for a runtime and
  no API is called.
- **Terminal scenarios** — autostart, watch-restart, crash/postmortem, restart-on-crash — are declared
  under `terminals:`. That is not a downgrade: those scenarios never exercised agent semantics.
- **Real-runtime E2E** is reserved for tests whose object *is* the native integration: authentication,
  resume, native config, model observation.

The rule enforces itself rather than relying on review: a repository test asserts that no fixture
declares a non-attested command under `agents:`.

## Status

The rule is ratified. SDD 478 inventories the whole surface and orders the migration (M1–M9); **M1–M4
have landed**, and what remains is the doors (M6, M9), the fixture shim (M7, M8) and the parallel UI
encoding (M5). Read that spec before changing anything on this boundary.

**M1 has landed.** Which runtimes may operate an Agent is answered in exactly one place —
`ATTESTED_RUNTIMES` in `src/runtime/attestedRuntimes.ts` (`claude`, `codex`, `grok`, `pi`). The three
lists that used to disagree now derive from it or assert a relation to it: `ResumeRuntime` is defined
as `AttestedRuntime | <non-attested resumable>`, the private-home inspector registry is exhaustive over
it, and `KNOWN_AI_CLIS` is composed from it. Add a runtime there and the compiler plus
`test/unit/attestedRuntime.test.ts` demand the adapter and the inspector that make "attested" mean
something. `KNOWN_AI_CLIS` remains an authoring *suggestion* and is not an identity claim.

**M2 and M3 have landed.** A managed entry is `AgentEntry | TerminalEntry`, discriminated by the
stored `kind`. Every agent-only capability lives on the Agent arm, so `terminal.harness` is a compile
error and `asAgent(entry)` is the only way to reach one. That is what makes rule 2 above mechanical:
a conditional can no longer *be* what grants a capability, because the field is not there to reach.

**M4 has landed.** The kind is read back from the ledger exactly as written, and a record that never
carried one is refused rather than guessed — so editing the list of known binaries can no longer
reclassify rows already on disk. The surviving helper is named `suggestKindForCommand` because that
is all it is: a pre-selection an authoring surface shows a human, who can override it. Where it is
still called without a human in the loop — the ad-hoc spawn door (M9) and the inline `agents:` kind
default (M6) — the name now makes the violation legible instead of looking authoritative.
