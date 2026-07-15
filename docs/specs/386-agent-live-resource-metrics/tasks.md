# 386 — tasks

**Verify:** `npx vitest run test/unit/resourceSample.test.ts test/unit/agentModel.test.ts test/unit/agentLiveResourceMetrics.test.ts test/unit/sidebarRowAlignment.test.ts`
**Verify:** `npx tsc --noEmit && npx tsc -p tsconfig.webview.json --noEmit`
**Dogfood:** `npm run build` then point monorepo F5; expand metrics on running agents
**Human dogfood:** docs/specs/386-agent-live-resource-metrics/DOGFOOD.md

- [x] T1 — resource sampler (ticks delta, RSS subtree)
- [x] T2 — AgentVM.resources + toAgentVM + SAMPLE
- [x] T3 — gather samples for running agents with pane pid
- [x] T4 — AgentRow metrics UI + section Expand/Collapse metrics
- [x] T5 — CSS lanes, gutter, peek
- [x] T6 — unit tests + build
