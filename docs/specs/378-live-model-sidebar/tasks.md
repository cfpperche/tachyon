# 378 — live-model-sidebar — tasks

_Generated from `plan.md` on 2026-07-13. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Activity vocabulary: add optional `model` + `effort` to `NormalizedEvent` (types.ts);
      hoist both in logStore flatten/hydrate (mirror the `runtimeVersion` lines); no
      schemaVersion bump
- [x] claudeNormalizer: latch `message.model` from assistant records — skip
      `isSidechain: true` and `"<synthetic>"`; fixture with an in-file sidechain record
      carrying a different model
- [x] codexNormalizer: extract `payload.model` + `effort` from `turn_context`; fixture from
      a real rollout shape (session_meta/token_count carry no model — assert they don't latch)
- [x] grokNormalizer + opencodeNormalizer: emit the model via the new field; stop smuggling
      through `runtimeVersion`; activityView header prefers the model field for these runtimes
- [x] snapshotService: model latch in ActivityProjection advanced in log append order (not
      timestamp compare); keep `modelObservedAt` as display metadata; project BOTH declared
      and observed + `divergence` (same alias table both sides, parser unified with
      agentModel's `modelFromCommand`)
- [x] View-independent per-agent accessor on the shared projection (advances the cursor
      itself); extension.ts onAppended: advance → compare `(label, source, stale,
      divergence)` tuple → sidebar refresh on change only; regression test: model update
      observed with the RuntimeOps view never opened
- [x] Boundary-aware precedence in the projection: process-rotating session boundaries
      (restarted/started/fork) demote observed; process-preserving ("new"/resumed) keep it
      with `stale: true`
- [x] Label policy: validated-open fallback for observed ids (charset/length gate;
      raw/title-cased render, never "Unavailable"); RuntimeOpsModelLabel keeps the closed
      union for declared/profile defaults
- [x] Sidebar VM: AgentExtras model input; `modelSource`/`modelObservedAt`/`modelStale`/
      `modelDivergence` siblings on AgentVM; precedence in the pure mapper; SidebarPrototype
      modelOf gather (verifyOf pattern)
- [x] Sidebar webview row: observed label + textual provenance marker (declared suffix /
      stale · divergence glyph with tooltip), never styling alone
- [x] Docs: upgrade note (pre-existing logs show `declared` until next observation); codex
      per-turn latency note; RuntimeOps-panel follow-up recorded in parity.md seam list

## Verification

- [x] All spec.md acceptance scenarios have a matching green unit/fixture test
- [x] `npm run typecheck` clean; full suite green
- [x] Verification record (canonical verify_task impossible — Delivery lease wedge, t-19026b):
      coordinator ran the manual equivalent — behavior suite 11/11 FAIL at BASE c0274b7b and
      11/11 PASS at delivered HEAD (scratch worktree); scope vs owns audited (1 out-of-owns
      file waived by name: src/webview/ActivityPanel.ts, load-bearing, reviewer-verified);
      suppression scan clean (only strengthened assertions)

**Verify:** `npx vitest run test/unit/livemodel2Behavior.gen.test.ts test/unit/agentModel.test.ts`
**Verify:** `npm run typecheck`

## Dogfood

**Dogfood:** `npx vitest run test/unit/livemodel2Behavior.gen.test.ts`

**Human dogfood:** with the fleet running, switch `/model` inside the codex TUI and watch the
sidebar row update within ~2s of the next turn start; confirm a freshly spawned agent shows
`· declared` until its first assistant turn; confirm `codex-budget`/`codex-soul` stop showing
"Codex default" and show the observed `gpt-5.6-sol`.

## Visual QA

_Sidebar row gains a live label + textual provenance marker; risk: marker crowding at narrow
widths, raw-id overflow._

- [x] Evidence: .tachyon/evidence/spec-378/dogfood-sidebar-live.png (installed branch build:
      provenance markers live — codex "GPT-5.6 Sol · declared", bare agents "· profile") +
      maintainer live dogfood 2026-07-14
- [x] Verdict: pass — maintainer confirmed codex-budget flip to observed "GPT-5.6 Sol" within
      seconds of a turn; markers legible at sidebar width; divergence-on-profile-default
      accepted as informative
