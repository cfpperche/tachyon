# Spec 248 — tasks

**Verify:** `env -u TMUX npx vitest run test/unit/roles.test.ts test/unit/bridge.test.ts && npm run -s typecheck`

## Path C (hybrid) — DONE
- [x] T1 — `verify_agent` MCP description: gate BEFORE accepting a child's handoff (not only merge); idle/"done" is not evidence — run it for the evidence. (`src/bridge/tools.ts`)
- [x] T2 — `bridgeGuidanceTail`: child-side nudge — if you have a declared verify gate, run it + confirm green before reporting done; idle is not proof. (`src/roles/templates.ts`)
- [x] T3 — roles test asserts the new verify clause; typecheck + roles/bridge tests green.
- [x] T4 — record the migration-thesis finding: per-edit validator = project-domain (does not migrate); done-gate already shipped by 214 + `verify_agent`. (spec/notes)

## Path B (narrow freshness v1) — DEFERRED (rule-of-three demand)
Design is ready in spec.md §"Goal (path B)" + the OQ resolutions in notes.md. Build only on real demand:
- [ ] B1 — `autoVerifyStep` pure reducer (expanded event model: idleDebounceElapsed/verifyStarted/Completed/FailedToStart/attentionChanged/configChanged/headChanged/dirtyFingerprintChanged/manualVerifyStarted).
- [ ] B2 — AttentionMonitor working→idle edge subscription + debounce; worktree-only; per-agent `verify.auto` opt-in.
- [ ] B3 — cost controls: per-agent min-interval, per-workspace concurrency cap (default 1), queue/drop, max runtime, failure backoff.
- [ ] B4 — dirty-worktree identity: clean-only OR worktree fingerprint + "verified dirty snapshot" badge (never "verified at HEAD" when dirty).
- [ ] B5 — trigger metadata (`trigger: manual|auto-idle|mcp`, reason, startedAt, finishedAt, output link); FRESHNESS framing only, never "finished".

## Closure
**Closure:** D-PATH=C. Shipped the doc half (orchestration guidance teaching verify-before-handoff + idle≠done) into the two agent-facing surfaces that agents actually read, declared the per-edit validator unmigratable/project-domain, and left the freshness auto-trigger (B) as a demand-gated, design-ready deferral. No new executor, no new feature surface, honest framing — the cheap high-value move the dueto recommended.
