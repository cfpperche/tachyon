# 411 — startup-brief-semantics — plan

_Drafted from `spec.md` on 2026-07-19. The approach, not the steps (those go in `tasks.md`)._

## Approach

Build one typed description of startup prompt composition, preserve the existing flattened body as
the model payload, and project only bounded facts from that description into the long-brief pointer
and file inventory. Work proceeds in four sequential slices because `promptLayers`, `AgentManager`
and `briefFile` are shared seams: typed composition (`t-f5cb0d`), visible terminology
(`t-fd63f7`), derived-file lifecycle (`t-5394c6`), then diagnostics/docs/dogfood (`t-9098c4`).

### 1. Extend the existing typed compositor

`src/agents/promptLayers.ts` already separates soul, role, persistent instructions, Bridge guidance
and task brief before producing the legacy string. Extend `ComposedAgentBody` with content-free layer
metadata rather than adding another prompt compositor. The task layer is a discriminated union:
absent, unstructured execution brief, or structured contract with `deliverable|done_when` completion.
`AgentManager` derives structured completion from the already-authoritative `SpawnOptions.contract`
on first launch and the ledger's structured contract on restart; it never parses `TASK:` text.

Project guidance remains loaded and rendered by `projectGuidance.ts`. Add a bundle-returning helper
that carries rendered body plus source count from the exact loaded array, retaining the existing
string helper as a compatibility wrapper. `AgentManager` combines that count with the prompt-layer
metadata only after every source was validated successfully.

### 2. Give long startup delivery a semantic envelope

Add a narrow `startupBrief.ts` module that owns `StartupBriefManifest`, validation and two bounded
renderings: a one-line/two-line pane summary and a readable inventory header for the derived file.
Both contain only fixed labels, booleans, the bounded guidance count, and the completion enum. They
never include task text, paths, profile IDs, instructions or source bytes.

`briefFile.ts` stays responsible for transport, byte measurement and atomic replacement. Its public
functions gain an optional typed startup context while retaining the existing arguments for generic
and re-anchor callers. For a long AgentManager startup, the file stores the inventory header followed
by the existing flattened body unchanged; thus every source/contract byte and precedence survive,
while the file explains its composition. Short delivery remains the exact legacy body inline and
creates no inventory/file. The pointer calls the aggregate `startup brief`, includes the bounded
summary, and explicitly says when no task objective was supplied. Re-anchor retains its own label and
path and does not receive startup-only metadata.

### 3. Make freshness a launch-reference rule, not a second authority store

Do not add timestamps, sidecars or correlation IDs in v1. A successful current pane/env pointer is
the correlation witness; an unreferenced file is retained derived residue for postmortem only. This
matches the single-live-session/name constraint, preserves the original body bytes, avoids volatile
metadata, and does not create a second authority that can drift from the ledger/Delivery.

Pin this rule with tests: a later inline launch neither points to nor overwrites an old long file;
preview/transport/write failure preserves the prior file and live session; restart replaces only
after preflight; spawn and re-anchor namespaces remain isolated. Document that inspection starts at
the current pane/session receipt, never by scanning `.tachyon/briefs`.

### 4. Close diagnostics and operator evidence

Rename aggregate-facing comments/errors/fixtures to startup brief while leaving the structured
`SpawnContract` API intact. Errors continue to report UTF-8 and shell-escaped sizes plus purpose and
stage, never content. Extend the AgentManager-backed project-guidance dogfood with long guidance-only
Codex-argv and Hermes-env cases, structured `DELIVERABLE`/`DONE_WHEN` children, re-anchor namespace,
and explicit resume non-injection where the existing capture seams support it. Add a focused
architecture/operator document and link runtime parity to it.

Verification is layered: characterization/focused Vitest during each slice, PI-001 after any
project-guidance integration change, then typecheck and configured full verification. The clean
`b75cd4f2` baseline currently has six unrelated full-suite failures recorded at
`/tmp/tachyon-verify-full-dXC0NV`; every run is compared honestly and closure requires either a green
full suite or separately resolved/owned baseline failures, never a false green claim.

## Key decisions

- **Extend `promptLayers`, do not parse Markdown** — the compositor already knows which inputs were eligible; regex/heading inspection would let project-authored bytes spoof protocol metadata.
- **Keep `SpawnContract` and add aggregate `startup brief` terminology** — the former is accurate for the structured delegation object; renaming it would blur rather than fix the distinction.
- **Inventory plus unchanged flattened body** — the inventory makes a long file self-describing while preserving prompt precedence and every original body byte; wrapping/re-rendering each legacy segment would risk changing spec 377 compatibility and whitespace semantics.
- **No persistent freshness sidecar in v1** — the current launch pointer is sufficient under one live name/session, while a sidecar/timestamp would add drift, cleanup and false-authority risks without fixing a proven race.
- **Optional semantic context at the transport boundary** — `briefFile` remains reusable for re-anchor/direct tests, but AgentManager startup paths must supply the typed manifest; making generic callers fabricate startup facts would be dishonest.
- **Sequential slices in one managed worktree** — the tasks share the same composition and transport seams, so parallel branches would create conflicting type/API decisions; separate commits retain reviewability.
- **Model/protocol text remains plain English** — these strings are agent-facing orchestration protocol, not VS Code UI copy, so repository localization guidance does not require `vscode.l10n.t`.

## Files touched

- `src/agents/promptLayers.ts` — add content-free typed layer metadata while preserving the flattened prompt body.
- `src/agents/startupBrief.ts` — define/validate the combined manifest and render bounded pane/file inventories.
- `src/config/projectGuidance.ts` — expose rendered guidance and exact source count from one validated load.
- `src/agents/AgentManager.ts` — combine manifests for spawn/restart and pass structured contract completion to delivery.
- `src/agents/briefFile.ts` — rename the aggregate pointer and accept optional startup semantic context without weakening byte/atomic guards.
- `src/workspace/Workspace.ts` — keep re-anchor terminology/path explicit and adapt to any transport signature change.
- `test/unit/soul-lifecycle-a2Behavior.gen.test.ts` — characterize prompt-layer metadata and preserve body parity.
- `test/unit/briefFile.test.ts`, `test/unit/snBriefBehavior.gen.test.ts`, `test/unit/cxBriefBehavior.gen.test.ts` — pointer, inventory, threshold, stale residue and failure oracles.
- `test/unit/agentManager.test.ts` — guidance-only, restart, unsupported adapter and Hermes integration behavior.
- `test/product-invariants/PI-001-project-guidance-ownership.test.ts` — mechanical evidence update only if required, under independent equivalence review.
- `scripts/dogfood-project-guidance.mts` — AgentManager-backed representative startup-brief exercise.
- `docs/architecture/startup-briefs.md` — ownership, composition, transport and freshness operator model.
- `docs/runtimes/parity.md` — link delivery-channel behavior to the startup-brief model.

## Risks & unknowns

- `taskBrief` is also used by pipeline/Delivery paths; tests must distinguish unstructured execution briefs from structured Bridge contracts without calling either absent.
- Restart must source contract metadata from the same ledger definition as the task body; initial and restart summaries may otherwise drift.
- The inventory increases derived-file size but not pane threshold calculations. Assert the inventory itself is bounded and retain the 64 KiB upstream input caps.
- Direct `deliverableBody` callers lack semantic metadata by design; their pointer can use the correct aggregate label but must not invent a layer summary.
- Adding a header means AgentManager long files no longer equal the raw body as a whole. Tests must assert the raw body is preserved as an exact contiguous suffix and never relax the no-truncation oracle.
- Existing full-suite baseline failures can hide unrelated movement; focused tests and PI-001 are the development gates, while final closure remains explicit about full status.

## Visual impact

The visible surface is the agent terminal/TUI startup payload, not a webview. Capture sanitized real
argv/env renderings showing primer → startup summary/pointer → before-finishing, plus the referenced
file inventory. Verify line length/readability for Codex positional delivery and Hermes TUI env. No
browser visual QA is applicable.

## Sources consulted

- `src/agents/promptLayers.ts`, `src/agents/AgentManager.ts`, `src/agents/briefFile.ts`
- `src/config/projectGuidance.ts`, `src/workspace/Workspace.ts`, `src/bridge/spawnContract.ts`, `src/roles/templates.ts`
- `test/unit/agentManager.test.ts`, `test/unit/briefFile.test.ts`, `test/unit/snBriefBehavior.gen.test.ts`, `test/unit/cxBriefBehavior.gen.test.ts`, `test/unit/soul-lifecycle-a2Behavior.gen.test.ts`
- `scripts/dogfood-project-guidance.mts`
- tasks `t-11a2d1`, `t-90c47d`, `t-f5cb0d`, `t-fd63f7`, `t-5394c6`, `t-9098c4`
- specs 363 (onboarding), 377 (typed soul/prompt layers), 383 (project-guidance boundary) and PI-001 registry metadata
