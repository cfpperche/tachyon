# 490 — formation-authority-bootstrap — plan

_Drafted 2026-08-05, after ratification._

## Approach

Três fatias independentes, uma por runtime, em paralelo. Cada uma entrega sozinha.

| # | Fatia | Runtime | Arquivos | Entrega |
|---|---|---|---|---|
| A | Porta de bootstrap (C2 do review) | claude | `src/agents/formation/*`, `src/workspace/Workspace.ts` | uma porta de produção para `mutation: "bootstrap"`, com ator humano e auditoria |
| B | Manifesto sem falso verde (C3) | codex | `src/agents/promptLayers.ts` + testes | manifesto atesta agentId, workspaceId, geração+digest, fonte da lane, digest do que foi composto |
| C | Supressão medida nos 3 runtimes (paridade) | grok | `src/runtime/*`, `docs/runtimes/parity.md` | evidência behavioral por adapter para claude, codex e grok |

## Key decisions

- **Split por fatia e não por runtime-do-alvo** — cada agente entrega uma peça inteira, em vez de
  três agentes medindo três runtimes e ninguém construindo a porta. Rejeitado o split por runtime
  porque as três medições colidem no mesmo registry e nenhuma delas destrava sozinha.
- **C é dono de `Workspace.ts:3034`** (`nativeSuppressionConfirmed`). A não toca essa linha.
- **Ordem de merge: B → C → A.** B é isolado; C dá a evidência que A precisa para o primeiro verde
  ponta a ponta.

## Files touched

Na tabela acima. Fora dela, nada — cada agente abre task nova se achar defeito adjacente.

## Risks & unknowns

- A supressão cobre as quatro lanes de uma vez (`humanLanes.ts:57-62`), não só memória. C pode
  descobrir que um runtime não tem como desligar entrega nativa de rules/instructions — nesse caso o
  honesto é `declared` e a lane recusa alto, não um `verified` inventado.
- A precisa de uma decisão de autenticação de ator humano que o repo ainda não tem em nenhum lugar.

## Sources consulted

`review-codex.md`, `src/agents/formation/humanLanes.ts`, `lifecycleHost.ts`, `authorityStore.ts`,
`src/runtime/nativeMemory.ts`, `docs/runtimes/parity.md`, `docs/specs/427-agent-identity-state`.
