# 231 — tachyon-pipeline-run-input — plan

Build sequence for the spec-231 design (codex CHANGES folded). The whole feature is **additive over the
shipped 230 engine** — no new worktree/allocation path (unlike 230's B2), so the risk is concentrated in
(a) the prompt-assembly extraction and (b) the loader signature change. Order is pure-core-first so CI
locks every step before the vscode seam.

## Seams this rides on (real, in `~/tachyon`)
- `src/workspace/Workspace.ts:61` — `PIPELINE_NODE_GUIDANCE` literal (to be MOVED to `nodePrompt.ts`).
- `src/workspace/Workspace.ts:567` — the inline `def.task + "\n\n" + GUIDANCE` concat (to be REPLACED by
  `assembleNodePrompt`). `:583` — cmd-node task delivery (only signal nodes get it → why cmd keeps task).
- `src/pipeline/loadPipeline.ts:111,124` — loader takes a NAME SET + requires `task` unconditionally
  (gains the `agentHasPersona` predicate + the work-source rule).
- `src/pipeline/runState.ts:17,24` — `RunState` shape + `initRun` (gains optional `input`).
- `src/pipeline/RunLedger.ts` — `.tachyon/runs/<id>.json` save/load (gains `input` + `summaries`; already
  corrupt/missing-field tolerant).
- `src/pipeline/PipelineManager.ts:77` (`rehydrate`), `:307` (`rerunFrom`) — input from ledger on resume;
  prune summaries on re-run.
- `src/pipeline/completeNode.ts:10` + `src/bridge/tools.ts:250` — `complete_node` input shape (gains
  optional `summary`; auth path unchanged).
- `src/extension.ts:829` — `showInputBox` is single-line → input edited as a file in an editor.
- `startPipeline` / `pipelineDeps` in `Workspace.ts` (~`:644`,`:725`) — wire input read-at-start + the
  persona predicate source.

## Step order (pure → wiring → vscode → dogfood)

### Step 1 — `nodePrompt.ts` pure module (the regression lock first)
Create `src/pipeline/nodePrompt.ts`: move `PIPELINE_NODE_GUIDANCE` here (exported); add
`assembleNodePrompt({ task?, input?, upstream? })` and `sanitizeSummary(raw, cap)` (strip control/ANSI,
cap ~4 KiB with a truncation marker). Tests (`test/unit/nodePrompt.test.ts`): the equivalence lock
(`task` present, no input, no upstream → exactly `task + "\n\n" + GUIDANCE`); input section present;
upstream rendered in dependency order under the untrusted header; no-task+input → no leading blank / no
task line; over-cap truncation + control-char stripping. **Do NOT touch Workspace yet** — this step is
green-on-its-own and proves the byte-identical claim before anything calls it.

### Step 2 — loader work-source rule (+ predicate signature)
`loadPipeline.ts`: change the signature to also accept `agentHasPersona(name): boolean`. Replace the
unconditional `task` requirement (`:124`) with the rule: `cmd:` → task required; `agent:` → task required
UNLESS `input: required` AND `agentHasPersona(agent)`; else required. Add the top-level `input: none|
required` enum (default `none`/absent, fail-closed like `worktree`). Update `loadPipeline.test.ts` for the
matrix (codex test list): `cmd+exit`/`cmd+signal` require task; `agent` with-persona + `input:required`
optional-ok; `agent` no-persona + no task rejected; `agent` + `input:none` + no task rejected; bad `input:`
enum rejected. Keep ALL existing 230 loader assertions green (they pass `task`, so they stay valid).

### Step 3 — run input in the state machine + ledger (pure)
`runState.ts`: add optional `input?: string` to `RunState`; `initRun` accepts + persists it. `RunLedger`:
persist/load `input` + an attributed `summaries: { nodeId, summary }[]` (missing → `[]`/undefined, already
tolerant). Extend `pipelineDurability`-style unit tests: old row without `input`/`summaries` loads clean;
round-trip with both. No behavior change for `input: none` runs.

### Step 4 — handoff bus in the executor (pure-ish, deps-injected)
`completeNode.ts` + `tools.ts`: add optional `summary` to the `complete_node` input + Bridge schema; the
validator auth path is unchanged (summary is non-security-bearing but untrusted). `PipelineManager`:
on a valid `complete_node`, `sanitizeSummary` + store attributed in the run; `assembleNodePrompt` is fed
the upstream summaries when spawning the next node; `rerunFrom` (`:307`) prunes the reset node + transitive
downstream summaries. `pipelineManager.test.ts`: summary stored+injected; absent summary == today;
rerun prunes. `completeNode.test.ts`: accepts with/without summary; bad nonce still rejected.

### Step 5 — Workspace wiring (the vscode seam)
Replace the `Workspace.ts:567` concat with `assembleNodePrompt(...)`, sourcing input from the **ledger
snapshot** (read once at `start` from `.tachyon/runs/<id>.input.md`) and upstream summaries from the run.
Provide `agentHasPersona` to `loadPipeline` (derive from the agent def: non-empty role/instructions or an
isolated-harness config). `rehydrate` re-injects input from the ledger. `start` fails closed when
`input: required` and the file is empty/absent.

### Step 6 — input entry UX
`▶ Run` on an `input: required` pipeline creates+opens `.tachyon/runs/<id>.input.md` in an editor; a
follow-up confirm starts the run once the file is non-empty. "Edit input" tree action opens the file +
updates the ledger snapshot (affects only not-yet-started nodes). NLS + pt-BR l10n for the new strings.

### Step 7 — docs + examples
README "Agent Pipelines" section: add the `input:` field + the run-input/handoff model + the work-source
rule for `task`. Add an `input: required` example to `~/tachyon-examples` (e.g. `feature-issue.yml`:
plan→review-plan(gate)→implement→review, personas, no per-node task re-declaration) alongside the existing
no-input examples (which stay as the back-compat proof).

## Acceptance (mirrors the spec)
- `npm run typecheck && env -u TMUX npx vitest run` green; the 230 suite green with unchanged assertions.
- `assembleNodePrompt` equivalence test proves byte-identical output for a `task`-only node.
- An `input: required` pipeline runs per-issue end-to-end in the EDH; reload after node 1 → node 2 gets
  the identical input from the ledger; an upstream `summary` shows in the next node's prompt.
- The 4 existing no-input examples (smoke/feature/gated/mixed) still run unchanged on the new engine.

## Risks / watch
- The loader signature change ripples to every `loadPipeline` caller — grep + fix all (incl. tests).
- Moving `PIPELINE_NODE_GUIDANCE` must not change its bytes (the equivalence test catches a drift).
- `agentHasPersona` must be conservative: when unsure, return false → `task` required (fail-closed).
- vsce/publish, commit hygiene per the repo norms (no Co-Authored-By; `vsce publish minor`; separate
  staged/commit Bash calls; `env -u TMUX` test runs).
