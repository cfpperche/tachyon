# 355 — adhoc-transcript-isolation — plan

_Drafted from `spec.md` on 2026-07-04. The approach, not the steps (those go in `tasks.md`)._

## Approach

Reuse the existing `isolate: "transcript"` path for ad-hoc AI agents. When `AgentManager.spawn()` builds an ad-hoc `AgentDef`, detect Claude/Codex via the existing runtime adapter and set `def.isolate = "transcript"` for those supported AI runtimes. This makes the existing `applyHarness()` path materialize `.tachyon/harness/<agent>` and inject `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, while `withSessionOwnership(..., { declared: false })` continues to request ownership-only SessionStart hooks.

Tighten the Activity banner logic so it mirrors the actual attribution rules. The banner should indicate a real attribution gap, not merely a shared cwd. A private `configHome` already makes two same-cwd agents distinct; a valid ownership row also makes live Activity attributable. Keep the warning for plain shared-cwd sessions with no captured id and no ownership row.

Add focused unit coverage for ad-hoc spawn configuration and Activity warning computation. Use the existing headless tests; human dogfood remains useful because the visible banner is the user-facing bug.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Default ad-hoc AI transcript isolation** — chosen because ad-hoc agents are already Tachyon-owned runtime invocations and transcript isolation is the smallest way to give each child a durable session namespace; rejected worktree isolation because it changes files/cwd, not just transcript attribution.
- **Keep ownership-only hooks** — chosen because Activity needs the session owner row but ad-hoc persistence prompts/pills remain undesired; rejected full persistence hooks because it reintroduces the noise this arc removed.
- **Fix banner semantics separately from isolation** — chosen because the current banner can be false even after the transcript is attributable; rejected relying only on isolation because stale/shared rows and ownership rows should still render accurately.

## Files touched

- `src/agents/AgentManager.ts` — mark supported ad-hoc AI definitions as transcript-isolated before spawn wiring/ledger writes.
- `src/webview/ActivityPanel.ts` — align `sharesCwd()` with config-home and ownership attribution rules.
- `test/unit/agentManager.test.ts` — cover ad-hoc Claude/Codex spawn config homes and ownership-only hooks.
- `test/unit/activityView.test.ts` or nearby Activity tests — cover warning visibility rules.
- `docs/specs/355-adhoc-transcript-isolation/*` — SDD artifacts and verification notes.

## Risks & unknowns

- Codex with isolated `CODEX_HOME` must still inherit auth/config from the real home; existing harness tests cover the materializer, but ad-hoc spawn must exercise it.
- Cleanup must not leave user-visible ad-hoc rows; existing kill/dismiss behavior should still remove ad-hoc ledger rows, but private homes may need a follow-up GC if not already covered.
- The Activity banner should not become too optimistic; if no ownership row exists and same `cwd + configHome` is shared, keep the warning.

## Visual impact

The Activity panel banner is visible. Human dogfood should open ad-hoc Codex and Claude Activity panels after same-cwd spawn and confirm the banner is absent when messages render. If it appears, capture the screenshot and treat it as failed visual QA.

## Sources consulted

- `src/agents/AgentManager.ts` — `applyHarness()`, `runtimeConfigHome()`, `spawn()`, `withSessionOwnership()`, `transcriptPathOf()`.
- `src/harness/HarnessManager.ts` — `materializeHomeOnly()` for lightweight transcript isolation.
- `src/webview/ActivityPanel.ts` and `src/webview/activity/App.tsx` — banner predicate/rendering.
- `docs/specs/240-tachyon-transcript-isolation/spec.md` — existing transcript isolation contract.
