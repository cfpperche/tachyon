# 200 — tachyon-runbooks — plan

_Drafted from `spec.md` on 2026-06-10. Update this file if implementation reveals the plan is wrong; do NOT silently diverge._

## Approach

A `RunbookRunner` layered on the same primitives as spec 199's CommandRunner but with
its OWN session namespace (`tachyon-rb-<hash>-<runbook>-<n>`) so step panes never
collide with plain command runs of the same name. `run()` drives the whole job
in-process: spawn step session → poll its pane until dead (configurable `stepPollMs`,
default 1s) → gate on exit code → tidy on success / keep + stop on failure. The job
object (steps with state/exitCode/durationMs) is the single source the sidebar,
the Bridge tool, and tests all read. `run_runbook` awaits the job up to its timeout;
on timeout it leaves the job running and reports progress on re-call.

## Files to touch

**Create:**
- `src/commands/RunbookRunner.ts` — sequential gated executor + job history
- `test/unit/runbooks.test.ts` — resolution, gate, concurrency, history (fake tmux)

**Modify:**
- `src/config/loadConfig.ts` + `tachyon.schema.json` — `RunbookDef {steps}` parsing
- `src/bridge/tools.ts` — `run_runbook` (timeout → progress, rerun param)
- `src/presentation/Sidebar.ts` — Runbooks group + expandable step items
- `src/extension.ts` — runner wiring, finish toast (Inspect on failed step), `_runRunbook`/`_runbooks` seams
- `src/config/YamlConfigEditor.ts` — deleteCommand warns referencing runbooks
- integration fixture + `test/integration/extension.test.js` — pass + gate scenarios
- `test/e2e/bridge-host.ts` — harness gains the runner

## Alternatives considered

### One tmux session with chained `cmd1 && cmd2 && cmd3`

Rejected: no per-step exit codes/durations/postmortem panes, no skipped-step
visibility, and no way to keep only the failing pane. The per-step session model
gives the sidebar and the agent the same structured job view.

### Driving steps through CommandRunner

Rejected: steps may be inline shell (not declared commands), and reusing the
`tachyon-cmd-*` namespace would make a runbook's `test` step collide with a
human's standalone `test` run. Shared helpers, separate namespace.

## Risks and unknowns

- In-process `run()` means a window reload mid-job abandons the job record (panes
  survive; sweep-on-next-run cleans stale step panes). Accepted for v1 — same
  session-memory stance as command history.
- Step poll at 1s bounds added latency per step to ~1s; fine for procedure-scale work.

## Research / citations

- github.com/opus-domini/sentinel — runbooks concept (analyzed in the F15/F21 briefing)
- spec 199 plan — shared namespace/lifecycle reasoning
