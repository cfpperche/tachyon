# 403 — pi-interaction-profile — notes

## Measurements and decisions

- Pi v0.80.10 was launched in an isolated tmux server with a private empty home and deterministic local provider. Plain and escaped captures show the editor between the final two identical `─` rules; the empty editor is a reverse-video space and a draft is ordinary text inside the frame.
- A project-trust selector also uses horizontal rules, so two borders alone are not launch readiness. The profile additionally requires Pi's token/model footer (`0.0%/4.1k … model`) below the bottom border.
- Pi docs map default keys as Escape=`app.interrupt`, Ctrl+C=`app.clear`, Ctrl+D=`app.exit` when empty. Live measurement confirmed Escape → 300ms → Ctrl+C → 150ms → Ctrl+D exits an occupied draft; automated tmux dogfood also proved idle and active streaming turns, with a final conditional Ctrl+D retry.
- Existing `interruptActiveTurn` is Codex-pane-specific, so the Pi profile sends Escape directly rather than pretending that step recognizes Pi.
- Composer profiles gained an additive framed-region form. Prompt-glyph Claude/Codex behavior keeps the same start-to-end region semantics; regression suites stay green.
- `manifestEngine` uses the same framed body for prompt-box rules, and Pi now participates in the shared runtime manifest list. No Pi-specific rate-limit overlay was invented.

## Automated evidence

- Focused profile/Attention/readiness/AgentManager suite: 464 tests passed.
- Real tmux dogfood passed for idle, drafted and active-turn Pi panes with no paid/remote provider.
- Build passed; engine boundary passed with 250 vscode-free daemon files; product invariants passed.
- Full suite: 4,877 passed, 3 skipped, with only the inherited baseline failures from SDD 399–402:
  - generated `grokauthfixBehavior` invokes the pre-existing failing typecheck (`verifyFullLock.test.ts` declaration gap);
  - `verifyFullQuiet.test.ts` expects the pre-`t-6a9bc4` `verify:full` package script.
- Direct typecheck reports only the inherited `verifyFullLock.test.ts` declaration defect after SDD 403 type errors were fixed.

## Review notes

- Framed occupancy examines only lines strictly between the final two borders. Output above the top border and footer changes below the bottom border remain runtime output.
- A frame taller than the bounded 16-line tail degrades safely: no composer ownership is claimed and ordinary output-change behavior wins.
- Custom Pi keybindings are an explicit compatibility limit. Tachyon does not mutate user keymaps, so remapping interrupt/clear/exit can make the measured graceful sequence ineffective and trigger the existing fallback lifecycle handling.

## Human dogfood

### 2026-07-18 — pass — Dev Host interaction profile

- Commit `27c1f433`, isolated fixture `/tmp/tachyon-pi-interaction-profile-dogfood`.
- Maintainer confirmed the Pi pane settled idle without false Attention, retained idle state while `human-owned-draft` occupied the framed editor, and Stop exited cleanly without `stop-failed`.
- After Resume, Stop during an active `sleep 10` operation also exited cleanly, and a second Resume proved continuity remained available.
- Attention/composer and Graceful Stop were promoted from `~` to `✓` in the parity matrix.
- Dev Host pointer was cleared immediately after approval; its private engine was stopped.

## Verification log

### 2026-07-18T16:49:29Z — pass (1/1) — source: tasks.md
- `npx vitest run test/unit/runtimeProfile.test.ts test/unit/attention.test.ts test/unit/cxComposerFixBehavior.gen.test.ts test/unit/cxManifestsBehavior.gen.test.ts test/unit/launchReadinessRecovery.test.ts test/unit/agentManager.test.ts --maxWorkers=2 && npm run build && npm run check:engine-boundary && npm run test:invariants` — pass

## Dogfood log

### 2026-07-18T16:49:37Z — pass (1/1) — source: tasks.md — commit: 169c1cb0378dfef989c24bcdf14ea492227331cb
- `node scripts/dogfood/pi-interaction-profile.mjs` — pass
