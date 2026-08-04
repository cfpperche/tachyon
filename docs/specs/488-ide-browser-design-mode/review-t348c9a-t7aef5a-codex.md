# Adversarial review — `0a5bfda3`

**Review commissioned by the human maintainer (via grok). Reviewer: codex.**

Scope: only `t-348c9a`, `t-7aef5a`, and their four implementation/test files in commit `0a5bfda3`.

## Verdict

**Fail.** `t-7aef5a` is met cleanly and the size test is a useful source-growth ratchet, but `t-348c9a` cannot honestly be marked done: the draft refusal reads the cached attention snapshot, fails open when that query is missing/errors, and has a read→write race before `sendAgentInput`. The repository already documents this exact cached-signal failure class and exposes a fresh `probeComposerOccupied` path elsewhere. No test exercises the new refusal.

## Findings

| id | sev | claim | evidence | rec |
|---|---|---|---|---|
| R-01 | P1 | Draft protection can false-negative for several seconds: `attention.list` returns `workspace.monitor.states()` cache, while the codebase explicitly says `composerOccupied` is only recomputed on attention ticks and provides `probeComposerOccupied()` for injection-time reads. | `src/webview/ide-browser-bridge/manager.ts:459-477`; `src/engine-service/extensionOperationService.ts:77-87`; `src/attention/AttentionMonitor.ts:805-842`; precedent `src/workspace/Workspace.ts:4365-4371` | Make the send authority perform a fresh composer probe immediately before writing; do not treat the presentation snapshot as the guard. |
| R-02 | P1 | The guard fails open on query error or absent agent snapshot, then `sendManagedAgentInput` writes without any composer check. This violates “draft-clobber refuse” exactly when attention is unavailable/stale. | `manager.ts:461-477,503`; `src/agents/agentInputService.ts:31-69` | Refuse safely when draft state cannot be established, or add the authoritative guard to the actual `agent.input` submission door. |
| R-03 | P1 | There is a TOCTOU window between the query and pane write: a human can begin typing after the check. The existing notice path narrows the same race with a fresh probe at delivery; this path does not. | `manager.ts:459-503`; existing delivery sequence `Workspace.ts:4365-4373`; documented no-CAS limitation `docs/runtimes/parity.md:787` | Put the freshest available check adjacent to `tmux.sendKeys`; document the residual no-CAS race rather than claiming full protection. |
| R-04 | P2 | No test covers draft present, draft absent, query failure, missing snapshot, or agent switching. The only new test is the inject budget, so the task's behavioral half is unverified. | `test/unit/designModeInjectBudget.test.ts:1-27`; commit file list; task marked done in `docs/specs/488-ide-browser-design-mode/notes.md:61` | Add focused tests through the real Design Mode send door, including both false-positive and false-negative directions. |
| R-05 | P2 | The budget test is useful but measures TypeScript source size, not the generated Runtime.evaluate expression. Imported/generated theme CSS can grow the runtime payload without moving either ceiling. It is a maintainability ratchet, not an inject-payload budget. | `designModeInjectBudget.test.ts:10-25`; expression composition `src/webview/ide-browser-bridge/designModeInject.ts:55-63`; current measurement: 1,720 lines / 67,023 bytes versus ceilings 1,721 / 68,000 | Keep this test, but name it source-size budget; if acceptance means injected payload, also measure `buildDesignModeInjectExpression(...)` bytes under the existing VS Code test mock. |
| R-06 | P3 | Cached `composerOccupied=true` can briefly refuse after a human clears a draft. This is safe but produces a false positive with no “retry” wording. | `manager.ts:464-472`; cache semantics `AttentionMonitor.ts:805-842` | If the authoritative fresh probe returns false, allow send; otherwise tell the user to retry after clearing/submitting. |
| R-07 | P3 | Browser scope prefixes are complete and directionally correct: 26 Companion descriptions identify the paired human browser and eight IDE/Design Mode descriptions identify the editor browser, both excluding the other browser families. The prefix on `design_mode_chat_reply` is appropriate because its destination is that surface. | `src/bridge/tools.ts:2439-2445,2537-3641,3649-3831`; measured occurrences: `USER_BROWSER_SCOPE +` 26, `IDE_BROWSER_SCOPE +` 8 | Keep. A small registration test asserting every `user_browser_*`/`ide_browser_*` description begins with its scope prefix would prevent later omissions. |

## Scope-creep check

- Implementation changes remain within the two tasks: one query-field projection, one Design Mode refusal, one budget test, and repetitive description prefixes.
- Updating the two task rows in `notes.md` is bookkeeping, not feature scope creep; however `t-348c9a` is marked done prematurely.
- No unrelated runtime behavior or feature was added in the reviewed delta.

## What is solid

- `USER_BROWSER_SCOPE` and `IDE_BROWSER_SCOPE` remove ambiguity at the first sentence of every relevant tool description without renaming tools or changing handlers.
- The prefixes correctly distinguish Companion, VS Code Integrated Browser, and agent-browser.
- The size test is deterministic, fast, has very little headroom (one line and 977 bytes), and passed with the existing inject tests: 2 files / 20 tests.
- The refusal occurs before appending the user event or consuming the attached selection, so a detected draft does not create false chat history or lose selection context (`manager.ts:459-481`).
- The change contains no main merge or unrelated implementation.
