# Agent profiles

The fleet is a directory. `.tachyon/agents/<name>/` with a readable `agent.yml` in it IS an agent,
and nothing else is (`t-ae221c`).

```
.tachyon/agents/
  codex/
    agent.yml        <- the definition; its presence is membership
```

`tachyon.yml` declares no agents. A file that still carries an `agents:` block loads with a warning
saying the block is ignored and can be deleted — there is no migrator and nothing rewrites a human's
file. Operational shell definitions remain supported under the separate `terminals:` block.

A directory with no readable `agent.yml` is NOT fleet. `reconcile_roster` names what it is —
`orphan-home` for a home with nothing in it, `unlisted-profile` for bytes that cannot be read — and
neither is ever deleted automatically.

Membership is the file's presence, not its contents: Tachyon loads the
profile after its bytes match the machine-local authority record and the selected runtime inspector
proves all native configuration inputs it understands. Missing/stale authority, changed profile bytes
or an incomplete inspection fails closed. A failed warm reload leaves the prior row visible but blocks
new starts for that profile-backed agent.

## Lifecycle and transactions

Create and edit agents through canonical Agent Studio. Canonical create, edit, rename and forget use
durable transaction journals under `.tachyon/canonical-agent-transactions/`, machine-local authority,
and profile publication that refuses symbolic-link targets. None of them writes `tachyon.yml`: since
`t-ae221c` the profile home is the only durable copy of the roster, so the config compare-and-swap
and the "published the profile but not the pointer" failure class it guarded are both gone.
Recovery finishes an internally consistent canonical lifecycle operation or reports it as degraded.

LKG metadata is display-only and never authorizes a spawn. Workspace plugins are not represented or
changed by canonical profile lifecycle transactions; future agent-scoped plugin placement has its own
architecture work.
