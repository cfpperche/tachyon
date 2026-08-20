# t-b9c377 — Grok SessionStart ownership hook

Measured 2026-08-20 on the real `grok 1.0.5 (5115b46bc9)` binary in this worktree.

## Cause

The generated Grok hook used `matcher: "startup|resume|clear|compact"`, copied from Claude's
SessionStart `source` vocabulary. A real headless Grok turn with that hook ran the `Stop` hook but
did not run the SessionStart hook. The same real turn with the matcher removed emitted:

```json
{"hookEventName":"session_start","source":"new","sessionId":"<uuid>","cwd":"<project>"}
```

Therefore the missing ownership row was caused by the matcher, not authentication or the recorder's
payload handling. The recorder already accepts Grok's camelCase `sessionId`/`cwd` and derives the
Grok transcript path when `transcriptPath` is absent.

## Change

`buildOwnershipSettings` retains the existing matcher by default for Claude and other callers. The
Grok materializer passes `sessionStartMatcher: null`, omitting the matcher so Grok's native `new`
source (and future native source values) reaches the recorder. The generated-hook test asserts that
the Grok SessionStart group has no matcher.

The `parity.ts:7` Grok coverage declaration remains a separate follow-up, as required by the task.

## Verification

- Real Grok probe: matcher present → only `stop`; matcher absent → `session_start` plus `stop`.
- Real Grok turn through the changed `HarnessManager` materialization: one row appended to
  `.tachyon/activity/session-owners.jsonl` with `source: "new"`, a session ID, cwd, and derived
  `chat_history.jsonl` transcript path.
- Focused Vitest: 3 files, 59 tests passed.
