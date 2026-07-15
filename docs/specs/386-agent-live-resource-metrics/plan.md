# 386 — plan

## Approach

Sample pane-subtree CPU% and RSS during fleet gather (reuse pane pid resolution already used for external tools). Project onto `AgentVM.resources`. Webview owns `metricsOpen` set; hierarchy collapse stays on existing `collapsed` keys.

## Key decisions

1. **Two toggles** — left chevron = tree only; metrics = separate button + peek
2. **Sampler** — module next to `attention/cpu.ts`; delta ticks → % with CLK_TCK=100 default; RSS from `/proc/.../status` VmRSS, one level of children
3. **Host samples on gather** — SidebarPrototype keeps a process-lifetime `ResourceSampler` map keyed by agent name
4. **UI** — L3 CPU, L4 Mem bars; L5 future slot omitted in v1 UI (only CPU/Mem lanes)

## Files

- `src/attention/cpu.ts` / `resourceSample.ts` — RSS + sampler
- `src/sidebar/types.ts`, `agentModel.ts`
- `src/webview/SidebarPrototype.ts`
- `src/webview/sidebar/App.tsx`, `sidebar.css`
- unit tests

## Risks

- First sample has no CPU% until second gather — omit cpu until ready, still show mem
- CLK_TCK variance rare; document 100
