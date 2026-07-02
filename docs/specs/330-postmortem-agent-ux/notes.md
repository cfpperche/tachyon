# 330 — postmortem-agent-ux — notes

_Created 2026-07-02._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- Initial plan keeps postmortem output additive and bounded. After Claude/Fable review, v1 uses a session-local
  postmortem tail buffer rather than only state-specific errors, but still does not add a durable terminal-output
  archive.
- Claude/Fable probe `probe-5159b1ec-f676-4343-abfd-4c10254f5f15` returned one core blocker: the four UX/DX
  improvements need a single bounded postmortem output source or the API becomes misleading/non-additive.
- Implementation uses an in-memory/session-local postmortem buffer on `AgentManager`, populated before
  `dismissCleanExitPane` kills the clean-exit dead pane and destroyed by ad-hoc dismiss/kill/restart/spawn.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- `wait_for_agent(tailLines)` now reads from the same finalized postmortem source as `read_output`, rather than a
  separate best-effort live capture. This gives both tools the same truncation and destruction semantics.
- `read_output` keeps live output as raw text for backward compatibility and returns structured JSON only for
  postmortem output, where metadata is needed.

## Verification log

- `npm test -- --run test/unit/bridge.test.ts test/unit/agentManager.test.ts test/unit/sidebarActions.test.ts test/unit/agentModel.test.ts` passed.
- `npm run typecheck` passed.
- `npm run build` passed.
- `/sdd verify --run` passed.
- Initial `/sdd dogfood --run` failed because the regex selected legacy Bridge tests that depend on a prior
  `spawn_agent (declared)` test but skipped that setup. The dogfood command was narrowed to spec-330
  self-contained postmortem/final-tail/dismiss scenarios and passed.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- None for the headless implementation. Visual/human dogfood remains pending before marking the spec shipped.

### 2026-07-02T20:15:31Z — pass (1/1) — source: tasks.md
- `npm test -- --run test/unit/bridge.test.ts test/unit/agentManager.test.ts test/unit/sidebarActions.test.ts test/unit/agentModel.test.ts` — pass

## Dogfood log

### 2026-07-02T20:40Z — installed 0.54.46 live Bridge dogfood — pass with note

- Installed/reloaded Tachyon 0.54.46 exposed the new Bridge schema: `wait_for_agent` includes `tailLines`, `list_agents` describes advisory capabilities, and `read_output` describes retained postmortem output.
- `postmortem-330-smoke` (`agy --print ...`) clean-exited. `list_agents` showed `cleanExited: true`, `capabilities.canReadOutput: true`, `readOutputState: "postmortem"`, and `canDismiss: true`.
- `read_output postmortem-330-smoke` returned structured JSON with `postmortem: true`, `source: "retained"`, `truncated: true`, `maxLines`, and `maxBytes` instead of the old generic "not running" error.
- `postmortem-330-tail-agent` exercised `wait_for_agent(until=dead, tailLines=20)` while the pane was still present. It returned `state: "dead"`, `tail`, `tailTruncated`, `tailMaxLines`, `tailMaxBytes`, and `tailSource: "tmux"`. The smoke command itself exited 1 due its shell syntax, but the final-tail contract was exercised.
- `read_output postmortem-330-tail-agent` also returned structured postmortem JSON from the dead tmux pane.
- `dismiss_agent` removed all smoke rows (`postmortem-330-smoke`, `postmortem-330-tail`, `postmortem-330-tail-live`, `postmortem-330-tail-agent`); final `list_agents` returned only declared agents.
- Note: direct visual inspection of the VS Code sidebar chrome was not available to this agent. The installed Bridge data feeding that sidebar did expose `canDismiss: true` for the postmortem rows, and the headless action-matrix tests cover the Dismiss action rendering path.

### 2026-07-02T20:15:36Z — fail (0/1) — source: tasks.md — commit: 079c0c2a6c090336e3709ab45cd1bca86e4afad2
- `npm test -- --run test/unit/bridge.test.ts -t "read_output|wait_for_agent|list_agents|dismiss_agent"` — fail

### 2026-07-02T20:15:54Z — pass (1/1) — source: tasks.md — commit: 079c0c2a6c090336e3709ab45cd1bca86e4afad2
- `npm test -- --run test/unit/bridge.test.ts -t "postmortem|final tail|dismiss_agent"` — pass

### 2026-07-02T20:17:02Z — pass (1/1) — source: tasks.md
- `npm test -- --run test/unit/bridge.test.ts test/unit/agentManager.test.ts test/unit/sidebarActions.test.ts test/unit/agentModel.test.ts` — pass

### 2026-07-02T20:17:03Z — pass (1/1) — source: tasks.md — commit: 079c0c2a6c090336e3709ab45cd1bca86e4afad2
- `npm test -- --run test/unit/bridge.test.ts -t "postmortem|final tail|dismiss_agent"` — pass

### 2026-07-02T20:18:02Z — pass (1/1) — source: tasks.md
- `npm test -- --run test/unit/bridge.test.ts test/unit/agentManager.test.ts test/unit/sidebarActions.test.ts test/unit/agentModel.test.ts` — pass

### 2026-07-02T20:18:03Z — pass (1/1) — source: tasks.md — commit: 079c0c2a6c090336e3709ab45cd1bca86e4afad2
- `npm test -- --run test/unit/bridge.test.ts -t "postmortem|final tail|dismiss_agent"` — pass
