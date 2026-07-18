# 406 — pi-harness-resources — notes

## 2026-07-18 — kickoff

- Human authorized proceeding from the continuity proposal: configurable per-agent Pi resources while preserving the SDD 401 default-deny private home.
- Affected Product Invariants: none — opt-in runtime configuration; PI-001 is unchanged.
- Work is isolated in managed worktree `pi-harness-resources` for task `t-a6fc54`.
- Scaffold recovery: the SDD helper first ran from `main` by mistake, creating an untracked 406 directory that was immediately removed without touching tracked files. The same-clone allocation ledger then advanced to 407 in the isolated worktree; the freshly generated untouched scaffold was restored to the already-reserved intended ID 406, and `check-ids.sh` passed.
- Security decision: this slice accepts only workspace-local paths. Remote npm/git package acquisition, installers, global inheritance and project auto-trust are explicitly out of scope.

## 2026-07-18 — pre-implementation review

- Read-only Pi reconnaissance confirmed `PI_CODING_AGENT_DIR` does not suppress ambient `$HOME/.agents/skills`; settings-only projection would therefore overclaim default-deny.
- Revised design to Pi's native exact posture: inject all four `--no-*` discovery flags and explicit private paths. Local package directories are copied and passed via `--extension`; Pi v0.80.10's local package resolver expands all package resource classes without installing.
- This intentionally disables automatic project extension/skill/prompt/theme discovery while a Pi resource harness is active. Ordinary no-harness Pi retains native project discovery.
- Adversarial review's settings ownership/crash blockers are avoided by never mutating resource keys in private `settings.json`; argv binds only to a fully copied versioned generation.
- Separate trust/hash approval and Bridge-name collision concerns are not new enforcement added here: existing Tachyon harness configuration already authorizes executable project hooks/skills, and Pi project extensions already share the process/tool namespace. Docs will state that explicit resource config is powerful and not a sandbox; the immutable Bridge asset remains independently injected.

## 2026-07-18 — independent implementation review

- Independent reviewer found two blockers: quoted/shell-expanded resource flags bypassed whitespace-split validation, and mtime pruning/removal during fallible restart preparation could delete the unchanged live process's resource generation. It also found an SDD overclaim that harness Fork would work despite existing fail-closed harness policy.
- Fixed command ownership by using the canonical structural launch parser, requiring literal argv and reserving Pi's shipped long/short resource flags, including quoted forms.
- Replaced mtime pruning/removal with content-addressed immutable generations. Identical content reuses one generation; changed generations remain inert until canonical private-home cleanup, so failed restart preparation cannot break the live pane. Only never-published staging is cleaned during preparation.
- Corrected scope: spawn/restart/resume are supported; harness-enabled Pi Fork remains explicitly fail-closed and is a non-goal of SDD 406.

## 2026-07-18 — full-suite status

- Declared focused verification passed after supplying the worktree-local ignored `tachyon.yml` fixture required by PI-001: 672 focused tests, build, engine boundary and Product Invariants.
- Real Pi RPC dogfood passed for direct extension/skill/prompt/theme plus local package resources, ambient/project suppression, sibling isolation and no installer stores.
- Mandatory `npm run verify:full:quiet` ran and failed on two known pre-existing `verifyFullQuiet.test.ts` expectations plus an unrelated parallel `engineService.test.ts` response-order failure. The engineService test passed immediately in isolation with one worker; follow-up bug `t-c289cf` records the flake. No SDD 406 focused failure occurred.
- Mandatory `npm run typecheck` passed.

## Verification log

### 2026-07-18T20:47:58Z — fail (0/1) — source: tasks.md
- `npx vitest run test/unit/config.test.ts test/unit/harness.test.ts test/unit/agentManager.test.ts test/unit/piSession.test.ts test/unit/resume.test.ts test/unit/runtimeProfile.test.ts test/unit/piRuntimeOnboarding.test.ts test/unit/piNormalizer.test.ts --maxWorkers=2 && npm run build && npm run check:engine-boundary && npm run test:invariants` — fail

### 2026-07-18T20:49:05Z — pass (1/1) — source: tasks.md
- `npx vitest run test/unit/config.test.ts test/unit/harness.test.ts test/unit/agentManager.test.ts test/unit/piSession.test.ts test/unit/resume.test.ts test/unit/runtimeProfile.test.ts test/unit/piRuntimeOnboarding.test.ts test/unit/piNormalizer.test.ts --maxWorkers=2 && npm run build && npm run check:engine-boundary && npm run test:invariants` — pass

## Dogfood log

### 2026-07-18T20:49:22Z — pass (1/1) — source: tasks.md — commit: 26371f80e86b9f37dea65b68c4f7bba550481775
- `npx tsx scripts/dogfood/pi-harness-resources.mjs` — pass
