# 381 — prompt-templates — tasks

_Generated from `plan.md` on 2026-07-14. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] 1. `PromptStore` + markdown parse (frontmatter title, body, id from stem, skip invalid)
- [x] 2. Pure inject helpers (running AI targets, submit refuse reasons)
- [x] 3. Unit tests for store + inject helpers
- [x] 4. Extension: palette command + item command (pick → confirm → stage/submit)
- [x] 5. Sidebar action matrix + ACTION_CMD + package.json/nls en+pt-BR
- [x] 6. README blurb for `.tachyon/prompts/`
- [x] 7. Spec status shipped after human dogfood + closure

## Verification

- [x] Parse valid/invalid prompt files as specified
- [x] Stage path does not submit; submit refuses busy/composer-occupied
- [x] Destination filter excludes terminals/stopped/dead
- [x] Empty library / no targets notify with `.tachyon/prompts/` hint
- [x] i18n keys present en + pt-BR
- [x] Sidebar offers inject only for running AI

**Headless check:** `npx vitest run test/unit/promptStore.test.ts test/unit/injectFlow.test.ts test/unit/sidebarActions.test.ts test/unit/i18n.test.ts`

**Verify:** `npx vitest run test/unit/promptStore.test.ts test/unit/injectFlow.test.ts test/unit/sidebarActions.test.ts test/unit/i18n.test.ts`

## Dogfood

**Dogfood-Opt-Out:** v1 is human QuickPick + tmux paste into a live agent pane; no headless E2E without a live AI CLI session. Covered by unit tests + approved interactive HTML prototype.

**Human dogfood:**

1. From monorepo root, agent (or you) arms Dev Host:
   ```bash
   npm run dogfood -- dev-host -- point \
     --worktree /home/goat/tachyon-worktrees/prompt-templates \
     --workspace /home/goat/tachyon-worktrees/prompt-templates/test/fixtures/prompt-templates-dogfood \
     --spec 381 --slug prompt-templates
   ```
2. Stay on the monorepo window. Run and Debug → **Tachyon: Dev Host** → **F5**.
3. In the **EDH window only**:
   - agent `dogfood` autostarts (bash, `kind: agent`)
   - Palette → **Tachyon: Inject Prompt Template…**
   - Pick a template → `dogfood` → **Stage in composer** → confirm body appears without Enter
   - Optional: overflow ⋯ on `dogfood` → Inject prompt template
   - Optional: start `claude`/`codex` if installed; try Submit idle vs busy refuse
4. Close EDH. Optionally: `npm run dogfood -- dev-host -- point-clear`
5. Do **not** reload the monorepo fleet window for this dogfood.

Fixture seeds: `test/fixtures/prompt-templates-dogfood/.tachyon/prompts/*.md`  
Runbook: `docs/runbooks/dev-host.md` § Dev Host (F5 pointer)

## Visual QA

- [x] Evidence: `docs/specs/381-prompt-templates/prototype.html` (approved 2026-07-14)
- [x] Verdict: product uses native VS Code QuickPicks/notifications; prototype stands as flow proof. No new webview surface in v1.
