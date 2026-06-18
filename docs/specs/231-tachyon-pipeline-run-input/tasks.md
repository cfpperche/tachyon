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
- [ ] 2. **Loader work-source rule** — `loadPipeline` gains `agentHasPersona` predicate + `input:` enum;
        `task` required for cmd / persona-less agent / `input:none`; optional for persona agent + input.
        Loader test matrix. (HEADLESS)
- [ ] 3. **Run input in state + ledger** — `RunState.input` + `RunLedger` input/summaries persistence;
        back-compat load of old rows. (HEADLESS)
- [ ] 4. **Handoff bus in executor** — `complete_node` optional `summary` (schema, not guidance);
        sanitize+cap+store attributed; inject upstream into `assembleNodePrompt`; `rerunFrom` prunes. (HEADLESS)
- [ ] 5. **Workspace wiring** — replace `:567` concat with `assembleNodePrompt`; ledger-canonical input read
        once at start; `agentHasPersona` source; rehydrate re-injects; start fail-closed on empty input. (EDH)
- [ ] 6. **Input entry UX** — Run opens `.tachyon/runs/<id>.input.md` in an editor (not InputBox); "Edit
        input" tree action; NLS + pt-BR l10n. (EDH)
- [ ] 7. **Docs + examples** — README `input:` + run-input/handoff/work-source; an `input: required` example
        in tachyon-examples; the 4 no-input examples stay as the back-compat proof.

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
