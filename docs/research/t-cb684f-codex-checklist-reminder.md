# t-cb684f — the Codex checklist reminder does not reach a completed turn

Measured on 2026-08-17 (America/Sao_Paulo), Codex CLI 0.147.0. The binary
answer is **no**: after a real successful Codex turn without `update_plan`, the
production judgment has no verdict, so the reminder does not fire.

The card's proposed cause is not the cause in the current tree. A missing
`.tachyon/activity/codex-tool-hooks.jsonl` is correctly read as zero plan
events, but the production judgment does not come from
`codexTuiInternalChecklistReader`. It comes from `readCodexTurnEvidence`, and
that reader first requires a `persistence-stop.jsonl` row with a `turnId`.
`InternalChecklistRepromptMonitor` also uses a new persistence Stop row as its
only trigger. Without that row, the reader returns `undefined`, Workspace
returns `{ state: "pending", reason: "turn-open" }`, and the monitor never
considers `requireIn`.

## Live measurement and positive control

Window: `2026-08-18T00:50:53.373Z` through
`2026-08-18T00:51:24.641Z` (UTC), covering two newly spawned Codex 0.147.0
agents in the same workspace. Sample size: two agents, one turn each.

| agent | requested behavior | session owner | `update_plan` rows | Stop rows | visible outcome |
|---|---|---:|---:|---:|---|
| `cb684f-no-plan` | read `package.json`, never call `update_plan` | 1 | 0 | 0 | successful answer, idle, no reminder |
| `cb684f-with-plan` | call `update_plan`, then read `package.json` | 1 | 2 (Pre + Post) | 0 | successful answer, idle |

The positive control is decisive about the tool ledger. It created
`codex-tool-hooks.jsonl` at `2026-08-18T00:51:09.999Z` and recorded PreToolUse
and PostToolUse for turn `01a01259-8848-7a03-b002-05d6229e5ffb`. The no-plan
agent has no row in that file. Thus the hook channel exists and distinguishes
plan from no plan; absence of its row is valid negative evidence.

Both sessions were registered by SessionStart. Neither agent had a row in the
complete 1,461-row `persistence-stop.jsonl` ledger after its successful turn
became idle. This was a full-file JSON parse filtered by the two exact agent
names, not a lexically sorted or truncated `find | head` sample.

The full ledger is also a useful control for scope. Its 1,461 rows break down
as `claude` 1,427, `claude-cowntdown` 27, `claude-brainstorm` 3,
`claude-prosa` 3, and `codex` 1. Every writer is a declared Saved Agent; no
Temporary agent appears.

The following reproduces the ledger count after running the two controlled
turns (the workspace root in this checkout is `/home/goat/tachyon`):

```bash
node - <<'NODE'
const fs = require("fs");
const base = "/home/goat/tachyon/.tachyon/activity";
const agents = new Set(["cb684f-no-plan", "cb684f-with-plan"]);
for (const file of [
  "session-owners.jsonl",
  "persistence-stop.jsonl",
  "codex-tool-hooks.jsonl",
]) {
  const rows = fs.readFileSync(`${base}/${file}`, "utf8")
    .split("\n").filter(Boolean).map(JSON.parse);
  const sample = rows.filter((row) => agents.has(row.agent));
  console.log(JSON.stringify({ file, total: rows.length, sample }, null, 2));
}
NODE
```

## Executable production-door proof

The current tests make the distinction explicit:

```bash
npx vitest run test/unit/codexTurnEvidence.test.ts \
  test/unit/codexInternalChecklistTurn.test.ts \
  test/unit/internalChecklistReprompt.test.ts \
  test/unit/grokInternalChecklistTurn.test.ts
```

`codexTurnEvidence.test.ts` proves that a Stop with `turnId` and no tool row
becomes `verdict: "absent"`; it also proves that no usable Stop returns no
evidence. `internalChecklistReprompt.test.ts` proves that pending produces
`action: "none"`, while absent plus `requireIn: ["*"]` produces `reprompt`.
Together with the live zero-Stop result, these call the same production doors
and show why the reminder is absent today.

## Grok comparison

Grok does not silently accept a completed no-plan turn. Its
`updates.jsonl` is both the checklist channel and the turn window: a
`turn_completed` event closes the turn, and `judgeGrokInternalChecklistLines`
returns `verdict: "absent"` when that completed window contains no plan event.
If only `events.jsonl` proves completion while the plan-bearing channel is
missing, Grok says `no-channel`; if neither source proves completion, it stays
pending. It therefore affirms absence only with a measured turn boundary,
rather than treating missing evidence as success.

## Conclusion

The cause is the declared-only persistence policy in
`Workspace.automaticPersistenceNudgesAllowed` and
`Workspace.silentPersistenceHooksDesired`. Temporary agents are absent from
`tachyon.yml`, so `automaticPersistenceNudgesAllowed` returns false and their
spawn receives no silent persistence bundle. The live argv consequently
contained only `runtime-status-publish` under Stop, not
`persistence-stop-record`. The measured chain is:

```text
Temporary agent
  -> automaticPersistenceNudgesAllowed: false
  -> silentPersistenceHooksDesired: false
  -> no persistence Stop recorder in the spawn
  -> no persistence-stop row
  -> no monitor trigger and no Codex turn evidence
  -> pending judgment
  -> no checklist reminder
```

The defect is confirmed, but the prescribed reader-only fix is refuted by the
production call graph. Changing `codexTuiInternalChecklistReader` for a missing
tool ledger cannot affect `Workspace.judgeInternalChecklistTurn`, and cannot
create the Stop-row trigger consumed by `InternalChecklistRepromptMonitor`.
The practical consequence is broader than Codex: `requireIn: ["*"]` is inert
for coordinator-dispatched Temporary agents, because the persistence channel
is declared-only by an explicit existing policy. Grok happens to escape this
path because its own `updates.jsonl` carries `turn_completed`.

Extending persistence to Temporary agents would reverse that written lifecycle
policy and needs its own decision and task. Per the updated t-cb684f journal,
the measurement is the delivery here; runtime code remains unchanged rather
than claiming a reader fix that production cannot reach.
