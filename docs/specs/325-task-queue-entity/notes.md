# 325 — task-queue-entity — notes

_Created 2026-07-02._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

- LOW follow-up: decide whether corrupt task files should surface a `corrupt_task` attention item instead of being skipped silently during list/read normalization.
- LOW follow-up: harden `resolveSddSpec` against path traversal before expanding SDD-derived metadata beyond local trusted refs.
- LOW follow-up: decide whether idempotent `update_task` calls should be accepted as no-ops or continue returning "requires at least one changed field".
- LOW follow-up: define semantics for multiple `type:"sdd"` artifact refs; v1 reads the first one only.

## Verification log

### 2026-07-03T00:00:09Z — pass (1/1) — source: tasks.md
- `env -u TMUX npx vitest run test/unit/taskStore.test.ts test/unit/nextTask.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit` — pass

## Dogfood log

### 2026-07-03T00:00:25Z — pass (1/1) — source: tasks.md — commit: 911e731f064bc21537e80f39b2a47f1208ef0575
- `env -u TMUX npx vitest run test/unit/nextTask.test.ts -t "claim"` — pass

### 2026-07-03T00:01:03Z — pass (1/1) — source: tasks.md — commit: 911e731f064bc21537e80f39b2a47f1208ef0575
- `env -u TMUX npx vitest run test/unit/taskStore.test.ts -t "CAS claim"` — pass

### 2026-07-03T00:01:03Z — pass (1/1) — source: tasks.md
- `env -u TMUX npx vitest run test/unit/taskStore.test.ts test/unit/nextTask.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit` — pass

### 2026-07-03T01:21:43Z — pass (1/1) — source: tasks.md — commit: 911e731f064bc21537e80f39b2a47f1208ef0575
- `env -u TMUX npx vitest run test/unit/taskStore.test.ts -t "CAS claim"` — pass

### 2026-07-03T01:21:43Z — pass (1/1) — source: tasks.md
- `env -u TMUX npx vitest run test/unit/taskStore.test.ts test/unit/nextTask.test.ts && npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit` — pass

## Code review (claude/Fable, 2026-07-02, commit 0725107)

Verdict: **approved** — faithful to the spec (author/assignee split, no capability field, artifact_refs
open-ended, SDD as derive-only enrichment with no dual-write), full suite green (2053 passed). CAS claim is
correct: expect{} is checked against a fresh read under the store's in-process mutation lock; create mints
ids collision-safe via link(2); update writes via rename(2). next_task's ownership-over-priority tier,
structured empty reasons, and dangling-dep-as-attention all match the spec text and are unit-tested.

Findings beyond the implementer's own LOW follow-ups (all non-blocking):
1. **Spec/impl mismatch (minor)**: spec says transitions allow "dropped from any", but the allowed map has
   no `done -> dropped` (path is done -> triaged -> dropped). Fix the map or the spec wording at next touch.
2. **Misleading empty reason (minor UX)**: when the caller's only task is active with a shipped SDD artifact,
   next_task returns `{empty, reason:"no-tasks"}` — the ready_to_close signal is visible only via
   get_task/list_tasks. A dedicated reason (or attention passthrough on empty) would serve agents better. v1.1.
3. **Cross-process CAS (info)**: the mutation lock is in-process; two extension hosts on the same workspace
   can last-writer-wins each other. Acceptable for v1 (one window per workspace is the norm) — recording it
   here so the limitation is deliberate.
4. **resolveSddSpec traversal (agree LOW, cheap fix)**: one-line containment check
   (`path.resolve` + `startsWith(specsDir + path.sep)`) is worth adding before the Mission Control board
   starts rendering arbitrary refs.
5. **Cosmetic**: compareCandidates uses localeCompare for createdAt but `<` for rank — both fine on ASCII;
   unify to codepoint compare for consistency someday.
