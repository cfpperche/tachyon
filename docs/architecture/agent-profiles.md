# Agent profiles

An agent may remain inline in `tachyon.yml` or use one exact pointer:

```yaml
agents:
  codex:
    profile: .tachyon/agents/codex/agent.yml
```

The pointer and inline fields cannot coexist. The pointer is only a location: Tachyon loads the
profile after its bytes match the machine-local authority record and the selected runtime inspector
proves all native configuration inputs it understands. Missing/stale authority, changed profile bytes
or an incomplete inspection fails closed. A failed warm reload leaves the prior row visible but blocks
new starts for that profile-backed agent.

## V1 migration eligibility

Use **Tachyon: Migrate Agent Profile** only for a stopped agent. The command first performs a dry run,
shows blockers, asks for explicit classification of environment values, then asks for final
confirmation.

The first measured adapter accepts only the exact command `codex`. It can preserve lifecycle, cwd,
role, worktree policy, transcript isolation, ownership and explicitly confirmed non-secret environment
values. It refuses command arguments, Soul, persistent instructions, Agent Evolution, harness
capabilities, setup and verification references. Refusal writes nothing; the whole stanza remains
legacy.

The native Codex inspector currently requires known Codex config files to be absent or empty. This is
intentional: a non-empty native config may affect model/provider/capabilities, so migration waits for a
future measured adapter rather than guessing.

## Transaction and rollback

Migration stores a durable journal under `.tachyon/agent-profile-migrations/<transaction-id>/`, writes
`agent.yml` without following symbolic links, establishes machine-local authority, and writes the
single YAML stanza last. The source-range patch preserves every byte outside that stanza. Startup
reconciliation finishes a complete tuple or compensates a partial tuple; divergence is marked degraded
instead of overwritten.

Use **Tachyon: Roll Back Agent Profile Migration** for a stopped agent. Only committed, safely
rollbackable journals are listed. Rollback restores the original stanza while preserving unrelated
later config edits. It refuses if the pointer stanza, profile bytes or authority changed after commit.

LKG metadata is display-only and never authorizes a spawn. Workspace plugins are neither represented,
read nor changed by profile migration; future agent-scoped plugin placement has its own architecture
work.
