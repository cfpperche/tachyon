# 481 — grok-runtime-config-control — tasks

_Generated from `plan.md` on 2026-07-28. Work top-to-bottom._

## Implementation

- [x] Medir o Grok instalado (0.2.112) e registrar fontes, layering, trust, MCP e impacto.
- [x] Estender o envelope: runtime `grok`, `number`, `readOnlyReason`, `impact`, `readOnly`.
- [x] Implementar inventário/mutation Grok sem payloads, credenciais ou autoridade editável.
- [x] Ligar extension/serviço/pending com a regra medida de escopo.
- [x] Selector, labels, campo numérico, motivo read-only e frase de impacto na UI.
- [x] Testes de segurança, escopo, MCP nativo, CAS, trust e pending.
- [x] Dogfood headless contra o binário instalado e cenário Dev Host.
- [x] Atualizar `docs/runtimes/parity.md` e o fixture de dogfood.

## Verification

- [x] `test/unit/grokRuntimeConfigInventory.test.ts` (10) verde.
- [x] Regressão Codex/Claude/dropdown/fixture verde.
- [x] Typecheck e verificação completa verdes.

**Headless check:** `npx vitest run test/unit/grokRuntimeConfigInventory.test.ts test/unit/claudeRuntimeConfigInventory.test.ts test/unit/codexRuntimeConfigInventory.test.ts test/unit/nativeConfigSources.test.ts`
**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood:** `npm run dogfood:grok-runtime-config`

Ele mede contra o `grok` instalado: escreve pelo adapter e pergunta ao próprio runtime, via
`grok inspect --json`, o que ele descobriu. Sem binário instalado ele sai com código 2 e a
mensagem `DOGFOOD SKIP` — uma medição ausente nunca é reportada como verde.

**Human dogfood:** Control → Runtime Config → selecionar **xAI Grok**; percorrer Global config,
Workspace config e Folder trust; conferir a frase de impacto de cada documento, o motivo read-only
em `Permission mode`, a ausência de escalar no workspace, o estado "Not decided" do trust, e salvar
`Reasoning display width` no documento global (deve gravar no profile-home descartável e nunca no
fixture versionado).

## Visual QA

- [ ] Evidence: `.tachyon/dev-host/interactive-out/grok-runtime-config.png`.
- [ ] Verdict: pendente de execução do Dev Host por um humano (F5).

## Cookbook

**Cookbook-Opt-Out:** Runtime Config já possui fluxo de operador; esta slice adiciona um adapter.
