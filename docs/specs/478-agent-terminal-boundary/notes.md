# 478 — agent-terminal-boundary — notes

_Created 2026-07-27._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- **The union replaced "a stricter validator" mid-analysis, and one measurement caused it.** The
  starting assumption was that `parseAgentEntry` simply needed to reject more keys for terminals. Then
  counting the agent-only fields on `ManagedEntryDef` showed **sixteen** of them, of which only
  **four** are actually refused (`kind`, `instructions`, `soul`, `selfEvolution`, plus `role`
  separately). The remaining twelve — including `harness`, `worktree`, `verify` and `isolate` — are
  fully declarable on a terminal today and are simply never read. That is the signature of per-field
  validation drift: each guard was added with its field, and the ones added later were not. A longer
  list of guards reproduces the same failure mode in a year, so the field has to leave the type.

- **`inferKind` is not deleted, it is demoted and renamed.** Two of its uses are genuinely different.
  At authoring time, suggesting "this looks like a terminal" to a human who can see and override it is
  good UX and violates nothing. At persistence time (`SessionLedger.ts:471`) the same function silently
  re-derives an entity's identity from a string, with no human in the loop. Keeping one and killing the
  other requires them to stop sharing a name — `inferKind` reads as authoritative at every call site.

- **The migration is ordered by what makes the next step mechanical, not by risk.** M1 (one runtime
  list) before M2 (the union) because the Agent arm needs `AttestedRuntime` to exist. M2 before M3
  (narrowing) because the compiler's output after M2 *is* the work list for M3 — estimating M3 before
  that would be guessing at 115 grep hits that are not 1:1 with real narrowings.

## Deviations

- **`spec.md` was drafted rather than left empty**, against the skill's default that intent belongs to
  the human. Justified because the human ratified the intent in `t-9c7a5d` in unusual detail (the seven
  deliverables are quoted almost verbatim into the acceptance criteria). Flagged in-file with a comment
  block: it is a draft awaiting ratification, not a fait accompli.

- **Four cited line numbers were wrong on first write and were corrected before publication.**
  `ManagedEntryDef` ends at 162 (not 165); the terminal-key refusals are at 779-782 and 863-864 (not
  778-786/860-870); `Workspace` continuity and compaction gates are at 1500 and 1404 (not 1483/1403 —
  those were read in the primary checkout *before* SDD 477 landed and shifted the file). All 20
  citations were then spot-checked against the worktree at `2320c2be`. Recorded because the spec's
  first acceptance criterion is precisely that these citations be true, and because it is the concrete
  reason that criterion is worth having.

## Tradeoffs

- **Counted evidence over exhaustive evidence.** The inventory states 115 conditionals across 40 files
  and lists six representative ones rather than all 115. The full list would be unreadable and would
  rot within a week; the counts are re-derivable by the commands in `tasks.md` § Verification, which
  makes the claim checkable without freezing it.

- **`attention` recorded as shared, knowing it may be wrong.** It is the one row where the matrix could
  flip, and flipping it would strand the needs-input scenario that `t-9418ac` just re-based onto a
  terminal. Recorded as an open question rather than blocking, because the reversal is small and
  contained, whereas waiting on it would block the entire backlog.

## Open questions

- **Ad-hoc `spawn_agent` is the real fork** (carried into `spec.md` § Open questions). An ad-hoc spawn
  with a `cmd` has no profile and no host authority, so under the ratified rule it cannot be an Agent —
  but the delegation contract in `spawn_agent`'s own description (spec 246) only makes sense for agents,
  and ad-hoc AI children are in daily use. Either they get a lighter attested path or they become
  Terminals and the delegation contract moves. Blocks M9 only; everything before it can proceed. Owner:
  the human.

### M9 (`t-8f3f7d`) — "supported" turned out not to mean "attested"

The plan, the spec and the architecture doc all said the ad-hoc door admits "a supported, attested LLM
runtime", and M1 had established that `ATTESTED_RUNTIMES` is the one answer to "which runtimes may
operate an Agent". Read literally that settles it — and reading it literally is wrong, which took a
measurement to see rather than an argument.

`agents:` already admits only a profile pointer whose executable is attested. So the ad-hoc door is the
*only* door through which OpenCode, Hermes, Gemini and Qwen can be agents at all. Applying the canonical
bar here would not have tightened a door; it would have removed four runtimes from the product, and with
them measured, shipped machinery: private XDG/HERMES homes, resume adapters, native fork, activity
normalizers, attention manifests, and OpenCode's credential preflight (`t-0338fc`, landed the same day).
This spec's own non-goals disclaim "changing what an LLM runtime *is*, or which runtimes are attested",
so a migration step reaching that conclusion is a signal the reading is wrong, not a mandate.

The fix is a second list rather than a wider first one. `ATTESTED_RUNTIMES` keeps answering "may this
back a canonical profile"; `SUPPORTED_ADHOC_AGENT_RUNTIMES` answers "can Tachyon hand this a delegation
and get an answer back". Every attested runtime is in the second; the reverse is deliberately false, and
a test asserts both directions so the two cannot quietly merge.

### The membership evidence, measured door by door

Per runtime, against the tree: a resume adapter (`src/resume/adapters.ts`), a brief channel
(`PROMPT_ADAPTERS` via `instructionsDeliverable`) and Bridge MCP wiring (`AgentManager.withRuntimeBridge`,
which reaches exactly `claude`/`codex`/`opencode`/`grok`/`hermes`/`pi` and returns `{ wired: false }` for
everything else).

| runtime | resume | brief | Bridge |
|---|---|---|---|
| claude, codex, grok, pi | yes | yes | yes |
| opencode | yes | yes (`--prompt`) | yes (`OPENCODE_CONFIG`) |
| hermes | yes | yes (`HERMES_TUI_QUERY`) | yes (`HERMES_HOME`) |
| gemini | yes | yes (`-i`) | **no** |
| qwen | yes | **no** | **no** |

Gemini and Qwen are admitted anyway, because removing a working capability inside a boundary migration
is the decision-by-negation this work was told not to make. What they cannot do is written into their
entries and owned by `t-59f67c`: a delegated Gemini child receives the contract and has no way to answer
it; a Qwen child receives neither.

`antigravity` and `continue` are absent, and that removes nothing: they have resume adapters but are not
AI CLIs to any authoring surface, so the old inference already produced Terminals for them.

## Deviations (M9)

**The manager stopped choosing the arm, which exposed a door the inventory missed.** Removing
`suggestKindForCommand` from `spawnCore` meant every ad-hoc caller had to declare its kind — and there
were two, not one. Pipeline inline `cmd:` nodes deliberately accept both kinds ("an exit-based one-shot
(sh / codex exec) runs its command as-is"), and `pipelines:` has nowhere to write a kind down. That door
now makes its own suggestion at its own call site, visible and testable, instead of sharing the
manager's; migrating it properly is `t-c003e1`.

**`delivery_join` is excluded from the admission check on purpose.** It is a different door with its own
contract, and SDD 368 T10 measured that an unrecognized reviewer runtime runs there with an advisory
rather than a refusal. Folding it in would have withdrawn that quietly.

**An omitted `kind` means `agent`, not "figure it out".** That is the strict arm: a caller who forgets
gets a refusal naming `spawn_terminal`, never a Terminal silently holding agent capabilities.

## Ratification

- **2026-07-27:** the human ratified `spec.md` § Intent and § Acceptance criteria.
- **Ad-hoc spawn decision:** `spawn_agent` remains Agent-only and accepts supported LLM runtimes through
  a lighter path without a canonical profile. Generic commands use an explicit Terminal operation.
  M9 (`t-8f3f7d`) is unblocked — and delivered; see § M9 above for why "supported" is its own list.

- **Is `kind:` under `agents:` retained at all?** A canonical `agents:` entry is a profile pointer, so
  `kind: terminal` under `agents:` is self-contradictory. Deleting the key is cleaner than validating
  it, but it is a config-surface break. Not urgent — it can ride M6.

- **How large is M3 really?** 115 grep hits is an upper bound on conditionals and a lower bound on
  narrowing sites: a place that reads `def.harness` without checking `kind` at all does not appear in
  the grep but will fail to compile after M2. The true number is knowable only after M2, which is why
  M3 is not estimated here.

## Verification log

### 2026-07-27T19:57Z — pass (1/1) — source: tasks.md
- `npm run verify:full:quiet` — pass (546 files, 6237 passed, 4 skipped; `verified tree 4c4ffe240ede`)
- `npm run typecheck` — pass (3 projects)

Run at closure, on the tree carrying the closure edits merged with `main` at `e250084e`. The gate is
declared for a spec that changes no source because the tree had to stay green THROUGH the migration
this spec ordered — and it did, at every one of M1–M9, each landing on a tree its own run had
recorded. This entry is written after the run, per the `/sdd verify` write discipline, so it names
the tree measured immediately before it.

