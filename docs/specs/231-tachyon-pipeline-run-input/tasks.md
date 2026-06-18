# 231 — tachyon-pipeline-run-input — tasks

**Verify:** `npm run typecheck && env -u TMUX npx vitest run` (TMUX guard — spec 218)

## Design — gate LOCKED + codex CHANGES folded
- [x] Maintainer gate locked: one engine + `input:` optional; `task` conditionally-required (work-source
      rule); input source = file (ledger-canonical at runtime).
- [x] codex adversarial review (gpt-5.5 high, read-only) → CHANGES (2 BLOCKER + 3 MAJOR + 1 MINOR), all
      folded into spec.md. Transcript `/tmp/codex-231-out.json`.
- [x] plan.md written (pure-core-first build order grounded in real seams).

## Phase 1 — MVP
- [x] 1. **`nodePrompt.ts` pure module — DONE.** Exported `PIPELINE_NODE_GUIDANCE` (frozen-string test pins
        byte-identity to the 230 literal) + `assembleNodePrompt({task?, input?, upstream?})` +
        `sanitizeSummary` (ANSI/control strip, UTF-8-safe byte cap). `test/unit/nodePrompt.test.ts` 13/13:
        equivalence lock (task-only → exactly `task\n\nGUIDANCE`), input section, upstream-untrusted-ordered,
        no-task+input persona-only, empty-upstream drop, ANSI/control/over-cap/multibyte. Full suite 688
        green, typecheck clean. NOTE: Workspace.ts still has its own guidance copy — Step 5 replaces it with
        an import (the frozen test guards the move). (HEADLESS)
- [x] 2. **Loader work-source rule — DONE.** `loadPipeline(text, knownAgents, agentHasPersona?=()=>false)`
        + `input: none|required` enum; `task` required for cmd / persona-less agent / `input:none`, optional
        only for a persona agent under `input:required`; `NodeDef.task?` + `PipelineDef.input`. Predicate is
        an OPTIONAL 3rd param (default false → existing callers stay fail-closed; only `Workspace`/new tests
        pass a real one). `loadPipeline.test.ts` 40/40 (8 new matrix cases). (HEADLESS)
- [x] 3. **Run input in state + ledger — DONE.** `PipelineRun.input?` + `summaries: UpstreamHandoff[]`;
        `initRun(…, input?)`; pure helpers `recordHandoff`/`pruneHandoffs`/`upstreamHandoffs`/`dependenciesOf`;
        `RunLedger.parseRun` normalizes a pre-231 row (summaries→[], input→undefined). `runState.test.ts`
        10/10 + `pipelineDurability.test.ts` 7/7 (round-trip + back-compat). (HEADLESS)
- [x] 4. **Handoff bus in executor — DONE.** `complete_node` gains optional `summary` (Bridge schema
        `tools.ts` + `CompleteNodeInput` + `BridgeDeps.completeNode`; auth path unchanged); `completeSignal`
        sanitizes+records it; `start(pipeline, input?)`; `SpawnNodeArgs.{input,upstream}` fed from the run;
        `rerunFrom` prunes reset+downstream handoffs. `pipelineManager.test.ts` 14/14 (input passthrough,
        summary record+inject, sanitize, rerun-prune) + `completeNode.test.ts` 6/6. (HEADLESS)
- [~] 5. **Workspace wiring — CODE COMPLETE (EDH dogfood pending).** `Workspace.ts:567` now calls
        `assembleNodePrompt({task, input, upstream})` (local guidance const removed → imported); local
        `agentHasPersona` predicate (instructions / harness / non-custom role) passed to `loadPipeline`;
        `startPipeline(name, input?)` fails closed on `input: required` + empty, persists the durable
        `.tachyon/runs/<id>.input.md`; `applyRunInput` + `PipelineManager.setInput` for live edits;
        `rehydrate` re-injects input from the ledger (run.input is on the restored run). typecheck+build+706
        green. NOT unit-tested (vscode-bound) → EDH.
- [~] 6. **Input entry UX — CODE COMPLETE (EDH dogfood pending).** `startPipelineWithInput` opens a draft
        `.tachyon/runs/draft-<name>.input.md` in an editor + a non-modal Start/Cancel notification (NOT a
        single-line InputBox); strips HTML-comment guidance; empty → fail closed. New
        `tachyon.editPipelineInputItem` command + tree menu (gated on an active run) + commandPalette hide +
        package.nls(.pt-br) + l10n pt-BR bundle (i18n test green). EDH.
- [~] 7. **Docs + examples — example DONE; README pending EDH.** `~/tachyon-examples/.tachyon/pipelines/
        feature-issue.yml` (`input: required`, persona nodes omit `task`, gate:approve) added; the 4 no-input
        examples stay as the back-compat proof. README `input:`/handoff/work-source prose → after EDH validates.

## Phase 2 — fast-follow
- [ ] 8. Templates parameterized by input.
- [ ] 9. Sensors that start an input-driven run from a dev event (issue ref as input).

## Acceptance
- [ ] `npm run typecheck && env -u TMUX npx vitest run` green; 230 suite green with unchanged assertions.
- [ ] `assembleNodePrompt` equivalence test proves byte-identical output for a task-only node.
- [ ] An `input: required` pipeline runs per-issue end-to-end in the EDH; reload after node 1 → node 2 gets
      the identical input from the ledger; an upstream `summary` appears in the next node's prompt.
- [ ] The 4 existing no-input examples still run unchanged on the new engine.

**Closure:** _(open — design locked + codex-folded; implementation pending, Step 1 starting)_
