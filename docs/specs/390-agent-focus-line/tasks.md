# 390 — tasks

**Verify:** `npx vitest run test/unit/agentFocus.test.ts test/unit/agentStatusFilter.test.ts test/unit/sidebarRowAlignment.test.ts`  
**Dogfood:** live sidebar with mixed sources; compare to `docs/specs/390-agent-focus-line/prototype.html`
**Human dogfood:** fleet glance — can you name each agent’s work without opening a terminal?

## After POC approval

- [x] POC HTML + maintainer approve (2026-07-16)
- [x] Plan written
- [x] Spec acceptance criteria finalized from plan
- [x] `resolveAgentFocus` pure + unit tests
- [x] Project `focus` on AgentVM (engine/sidebarFleetService)
- [x] Render focus line in sidebar (no working badge; no delegated-by text)
- [x] Filters On task / Has focus
- [x] Child row meta/focus pad matches name column (no double-indent)
- [x] Dogfood + evidence; close 390 (2026-07-16)
- [ ] Click → task when source=task (best-effort) — **deferred** (tooltip only in v1)

## Not in v1

- [ ] Manual human pin override
- [ ] `set_focus` Bridge tool
- [ ] Activity-scrape focus
