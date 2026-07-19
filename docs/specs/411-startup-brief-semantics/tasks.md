# 411 — startup-brief-semantics — tasks

_Generated from `plan.md` on 2026-07-19. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Record the clean-base focused/typecheck/full baseline in `notes.md`, including the six unrelated full failures and retained log pointer.
- [x] Add characterization tests proving `composeAgentPrompt().body` parity for legacy, soul, role, instructions, Bridge guidance and task ordering.
- [x] Add failing tests for typed prompt-layer metadata: absent, unstructured task brief, structured `DELIVERABLE`, and structured `DONE_WHEN`.
- [x] Extend `promptLayers.ts` and project-guidance loading with content-free typed metadata without changing the flattened body.
- [x] Add `startupBrief.ts` with closed manifest validation plus bounded pane and file-inventory renderers.
- [x] Add failing long-delivery tests for guidance-only `task contract absent`, structured completion kind, inventory/body preservation and pointer terminology.
- [x] Thread the manifest and authoritative structured contract through AgentManager fresh spawn and restart, including Hermes env delivery.
- [x] Extend `briefFile.ts` with optional startup semantics while preserving generic/re-anchor callers, byte thresholds, inline fallback and atomic replacement.
- [x] Add stale-residue tests proving a later inline launch does not point to or replace an old file and that failed replacement preserves the prior file/session.
- [x] Confirm spawn/re-anchor namespaces and explicit resume/unsupported-adapter non-injection remain unchanged.
- [x] Audit and update aggregate-facing comments, errors and fixtures without renaming the public structured `SpawnContract` API.
- [x] Add `docs/architecture/startup-briefs.md` and update runtime parity with ownership, composition, transport and freshness rules.
- [x] Extend project-guidance dogfood across long guidance-only Codex argv, Hermes env, structured completion kinds, re-anchor namespace and resume behavior supported by the capture harness.
- [x] Record per-slice decisions/deviations and sanitized terminal/file evidence in `notes.md`.
- [ ] Commit each reviewable slice with its Mission Control task ID using explicit path scopes.

## Verification

- [x] Focused prompt/brief/AgentManager tests pass with no truncation or threshold relaxation.
- [ ] PI-001 passes and an independent reviewer records mechanical equivalence of any evidence edit.
- [x] Typecheck passes.
- [ ] Configured full verification passes; any pre-existing failure remains explicitly unverified rather than described as green.
- [ ] The SDD duplicate-ID check and closure audit report no blocking findings when status becomes shipped.

**Headless check:** `npx vitest run test/unit/startupBrief.test.ts test/unit/projectGuidance.test.ts test/unit/soul-lifecycle-a2Behavior.gen.test.ts test/unit/briefFile.test.ts test/unit/snBriefBehavior.gen.test.ts test/unit/cxBriefBehavior.gen.test.ts test/unit/agentManager.test.ts test/unit/agentSoulLegacyParity.test.ts test/unit/workspaceHeadless.test.ts test/unit/t12DerivedFiles.test.ts --maxWorkers=1`

**Verify:** `npx vitest run test/unit/startupBrief.test.ts test/unit/projectGuidance.test.ts test/unit/soul-lifecycle-a2Behavior.gen.test.ts test/unit/briefFile.test.ts test/unit/snBriefBehavior.gen.test.ts test/unit/cxBriefBehavior.gen.test.ts test/unit/agentManager.test.ts test/unit/agentSoulLegacyParity.test.ts test/unit/workspaceHeadless.test.ts test/unit/t12DerivedFiles.test.ts --maxWorkers=1`

**Verify:** `npm run test:invariants`

**Verify:** `npm run typecheck`

**Verify:** `npm run verify:full:quiet`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood:** `npm exec -- vite-node scripts/dogfood-project-guidance.mts`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** inspect one real declared guidance-only agent startup and one delegated-long child; confirm the pane summary is readable and the referenced file inventory matches the actual layers without exposing body text.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

- [x] Evidence: sanitized pane/env and startup-file captures recorded under the spec notes or linked review artifact.
- [x] Verdict: primer → summary/pointer → before-finishing is readable in the real terminal/TUI delivery channels after any fixes prompted by inspection.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <411>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

**Cookbook-Opt-Out:** no new tool or operator command; the architecture document explains the automatically generated artifact.
