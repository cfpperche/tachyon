# 464 — claude-runtime-config-control — tasks

_Generated from `plan.md` on 2026-07-26. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

- [x] Definir envelope discriminado e documentos com CAS independente.
- [x] Implementar inventário/mutation Claude sem payloads sensíveis.
- [x] Generalizar serviço, mensagens, UI e pending.
- [x] Cobrir segurança, conflito, shadowing, lifecycle e regressão Codex.
- [x] Dogfood visual e atualizar paridade.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Testes Runtime Config e browser passam.
- [x] Typecheck e verificação completa passam.

**Headless check:** `npx vitest run test/unit/codexRuntimeConfigInventory.test.ts test/unit/claudeRuntimeConfigInventory.test.ts`
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood:** `npx vitest run test/unit/claudeRuntimeConfigInventory.test.ts test/unit/codexRuntimeConfigInventory.test.ts`
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** Control → Runtime Config; alternar Codex/Claude e documentos,
salvar um escalar em fixture, conferir shadowed/read-only e pending.
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

- [x] Evidence: `.tachyon/dev-host/interactive-out/claude-runtime-config.png`.
- [x] Verdict: selector/documentos, MCP read-only e save isolado sem regressão visual.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <464>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

**Cookbook-Opt-Out:** Runtime Config já possui fluxo de operador; esta slice adiciona adapter.
