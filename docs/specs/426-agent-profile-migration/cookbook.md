# 426 — Agent profile migration cookbook

## Migrate an eligible agent

1. Stop the agent.
2. Run **Tachyon: Migrate Agent Profile**.
3. Select the stopped agent.
4. If environment values are listed, confirm only when every listed value is non-secret.
5. Review the destination and confirm **Migrate profile**.
6. Open `tachyon.yml` and `.tachyon/agents/<agent>/agent.yml` to inspect the result.

If the command reports blockers, no migration bytes were committed. Keep the inline stanza and remove
or move only the deferred fields through their owning feature when that feature supports profiles.

## Roll back

1. Stop the profile-backed agent.
2. Run **Tachyon: Roll Back Agent Profile Migration**.
3. Select its transaction and confirm **Roll back profile**.

If rollback reports a conflict, do not delete files manually. Compare the current pointer stanza,
`agent.yml`, host authority and the transaction journal; the refusal means one of them changed after
migration.

## Isolated verification fixture

Use a temporary workspace and temporary Codex home. A real non-empty `~/.codex/config.toml` correctly
blocks the first adapter, so the live Tachyon fleet is not a suitable migration fixture.

```bash
npx vitest run test/unit/agentProfileMigration.test.ts -t "commits and rolls back"
npx vitest run test/unit/workspaceHeadless.test.ts -t "migrates and rolls back"
```
