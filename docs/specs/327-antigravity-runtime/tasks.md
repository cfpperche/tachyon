# 327 — antigravity-runtime — tasks

_Generated from `plan.md` on 2026-07-02. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Add `antigravity` to the runtime type map and detect `agy` as that runtime.
- [x] Add the Antigravity adapter: no id minting, `--conversation <id>` resume, and `--continue`
      fallback when no id is known.
- [x] Add an Antigravity resolver that reads
      `~/.gemini/antigravity-cli/cache/last_conversations.json` for the cwd's cached conversation id.
- [x] Thread Antigravity through current-session/capture-session dispatch without affecting Claude,
      Codex, Gemini, OpenCode, Qwen, or Continue behavior.
- [x] Teach config command composition to classify `agy` as an agent and deliver startup instructions
      via `--prompt-interactive`.
- [x] Update Agent Studio quick-add/runtime copy so Antigravity is the preferred Google CLI and Gemini
      is visibly legacy.
- [x] Update focused tests for adapter behavior, resolver behavior, config classification/composition,
      and Agent Studio catalog output.

## Verification

- [x] `runtimeOf("agy")` returns `antigravity`; `inferKind("agy")` returns `agent`.
- [x] `composeCommand({ cmd: "agy", instructions: "x" })` appends `--prompt-interactive 'x'`.
- [x] Antigravity resume builds `agy --conversation <id>` when an id exists and `agy --continue` when it does not.
- [x] Antigravity resolver returns the cwd's cached last conversation id and returns null on missing or malformed cache.
- [x] Existing Gemini adapter tests remain green.

**Headless check:** `npm test -- --run test/unit/resume.test.ts test/unit/config.test.ts test/unit/agentStudio.test.ts`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Verify:** `npm test -- --run test/unit/resume.test.ts test/unit/config.test.ts test/unit/agentStudio.test.ts`

**Dogfood:** `npm test -- --run test/unit/resume.test.ts -t antigravity`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** In Agent Studio, confirm the quick-add list shows Antigravity CLI and still offers
Gemini CLI as legacy. Optionally start an `agy` agent with a short instruction and confirm the TUI
opens with the prompt.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

**Visual QA Opt-Out:** Agent Studio change is catalog data only; focused unit tests cover the visible
labels and install hints.
