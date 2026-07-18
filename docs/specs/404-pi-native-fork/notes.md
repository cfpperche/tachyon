# 404 — pi-native-fork — notes

## Measurements and decisions

- Installed Pi: `@earendil-works/pi-coding-agent` v0.80.10.
- Pi accepts `--session-id <new UUID>` together with `--fork <path|id>`. It rejects combinations with `--session`, `--continue`, `--resume` or `--no-session`.
- `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir, { id })` writes a distinct destination JSONL, sets the destination header UUID/cwd and `parentSession`, and copies the source active branch.
- The exact source is passed as an absolute shell-quoted path. Looking up A by ID from B's session directory cannot work honestly because every Tachyon Pi agent has a distinct private home.
- Pi emits `session_start` after startup, new, resume and fork and exposes exact ID/file/cwd through `ctx.sessionManager`. The bundled extension appends this positive identity to Tachyon's existing ownership ledger. Fork refuses if the row is absent or does not resolve through the bounded no-follow Pi header resolver.
- The extension ownership row also lets existing generic Stop→Resume and live Activity ownership prefer a post-rotation Pi session without introducing newest-file guessing.
- Pi destination IDs are UUIDs minted by Tachyon. A repeated source UUID from an injected generator retries once and then fails before destination launch.
- Existing explicit `harness:` Fork remains blocked by the pre-existing v1 policy. Pi's mandatory profile private home is not an explicit harness declaration; B is materialized through the normal private-home mechanism.

## Automated evidence

- Focused adapter/extension/AgentManager/Pi session suite: 489 tests passed.
- Build passed; engine boundary passed with 250 vscode-free daemon files; product invariants passed.
- Full suite: 4,892 passed, 3 skipped, with only the inherited baseline failures retained from SDD 398–403:
  - generated `grokauthfixBehavior` invokes the pre-existing failing typecheck (`verifyFullLock.test.ts` declaration gap);
  - `verifyFullQuiet.test.ts` expects the pre-`t-6a9bc4` `verify:full` package script.
- Real Pi local-provider dogfood:
  - A created UUID `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa` with a persisted conversation marker.
  - B launched with UUID `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb` and exact A JSONL path.
  - B inherited the marker; its header recorded B/cwd/`parentSession=A`.
  - A's SHA-256 stayed byte-identical across Fork.
  - Bundled extension recorded positive ownership for A and B.
  - Separate `--session A` and `--session B` processes both recovered the inherited context from distinct private directories.

## Human Dev Host evidence

- Target: isolated SDD 404 fixture, worktree build `397cea17`, 2026-07-18.
- `pi-a` UUID `5ad5f124-e7ca-4e43-bf00-fa06bb0cc9a8` established codeword `COBALT-404-FORK`.
- Tachyon's existing Fork action created persistent sibling `pi-a-fork-1`, UUID `6db24a47-7db7-4011-a891-24c8ca98f9c3`, with wired Bridge generation 28 and its own private session directory.
- B's header points `parentSession` at A's exact private JSONL; both transcripts contain the inherited codeword.
- Positive ownership rows identify A and B by exact UUID/path/cwd. Later startup rows for the same UUIDs prove separate Stop→Resume launches; the human confirmed both retained context.
- Human verdict: all expected Fork and independent Resume behavior passed.

## Scope reminders

- Tachyon Fork clones the current active branch into a sibling session, matching the existing product action. It does not expose Pi's interactive earlier-user-message `/fork` selector.
- Positive ownership is available when the Tachyon Pi extension is loaded. A Pi process without that evidence is resumable by its minted launch UUID but deliberately not forkable as a claim about the current live session.

## Verification log

### 2026-07-18T18:17:43Z — pass (1/1) — source: tasks.md
- `npx vitest run test/unit/adapters.test.ts test/unit/piBridgeExtension.test.ts test/unit/agentManager.test.ts test/unit/piSession.test.ts test/unit/resume.test.ts --maxWorkers=2 && npm run build && npm run check:engine-boundary && npm run test:invariants` — pass

## Dogfood log

### 2026-07-18T18:17:51Z — pass (1/1) — source: tasks.md — commit: 6f6667e312136f01f11ba38779ac890663283d04
- `node scripts/dogfood/pi-native-fork.mjs` — pass
