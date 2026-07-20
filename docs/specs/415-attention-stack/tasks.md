# 415 — attention-stack — tasks

_Generated from `plan.md` on 2026-07-19. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Record baseline evidence and classify notification producers as attention, modal, or ephemeral feedback.
- [x] Add validated, atomic persistence for the bounded daemon Attention queue.
- [x] Remove serialized `notice.present` scheduling and its shell protocol/handler path.
- [x] Preserve exactly-once live actions and mark restored actions honestly unavailable.
- [x] Replace native non-modal notification provider behavior with status feedback or QuickPick while retaining modal messages.
- [x] Render six oldest Attention cards, FIFO overflow count, timestamps, levels, duplicate counts, and accessible actions.
- [x] Update the Sidebar view badge from total open attention across workspaces.
- [x] Update focused unit/integration tests and producer guard tests.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Seven-item test proves six visible + one queued and dismiss promotes item seven.
- [x] Restart test proves queue persistence and unavailable restored callbacks.
- [x] Duplicate/action tests prove stable order and exactly-once invocation.
- [x] Structural test proves production has no non-modal native notification path and no `notice.present` broker.
- [x] Real VS Code dogfood confirms no native toast, passive badge, six-card layout, and queued promotion.
- [x] `npm run typecheck`, focused tests, `npm run test:invariants`, and `npm run verify:full:quiet` pass.

**Headless check:** `npx vitest run test/unit/attentionStack.dogfood.test.ts test/unit/daemonEngineHost.test.ts test/unit/notificationService.test.ts test/unit/sidebarPrototype.test.ts test/unit/workspaceClient.test.ts test/unit/engineServiceProtocol.test.ts --maxWorkers=1`
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood:** `npx vitest run test/unit/attentionStack.dogfood.test.ts --maxWorkers=1`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** In a marked VS Code dogfood host, enqueue seven sanitized notices, verify six simultaneous cards and `+1 queued`, close/reopen the Sidebar to inspect the passive badge, then dismiss/invoke one item and verify FIFO promotion without any native toast.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

- [x] Evidence: tracked headless PNG under `docs/specs/415-attention-stack/evidence/`, with observations recorded in `notes.md`.
- [x] Verdict: headless preview passed and the human confirmed the native EDH layout, badge, absence of toast, and FIFO promotion.

**Cookbook-Opt-Out:** no new operator command or Bridge API; this replaces an internal presentation surface.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <415>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

<!-- **Cookbook:** yes -->
<!-- **Cookbook-Opt-Out:** pure internal refactor; no new operator surface -->
