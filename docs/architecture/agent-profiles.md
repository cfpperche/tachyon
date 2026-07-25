# Agent profiles

Every agent declaration in `tachyon.yml` is one exact canonical profile pointer:

```yaml
agents:
  codex:
    profile: .tachyon/agents/codex/agent.yml
```

Inline runtime fields under `agents:` are unsupported and fail closed. Operational shell definitions
remain supported under the separate `terminals:` block.

The pointer is only a location: Tachyon loads the
profile after its bytes match the machine-local authority record and the selected runtime inspector
proves all native configuration inputs it understands. Missing/stale authority, changed profile bytes
or an incomplete inspection fails closed. A failed warm reload leaves the prior row visible but blocks
new starts for that profile-backed agent.

## Lifecycle and transactions

Create and edit agents through canonical Agent Studio. Canonical create, edit, rename and forget use
durable transaction journals under `.tachyon/canonical-agent-transactions/`, exact config
compare-and-swap, machine-local authority, and profile publication that refuses symbolic-link targets.
Recovery finishes an internally consistent canonical lifecycle operation or reports it as degraded.

LKG metadata is display-only and never authorizes a spawn. Workspace plugins are not represented or
changed by canonical profile lifecycle transactions; future agent-scoped plugin placement has its own
architecture work.
