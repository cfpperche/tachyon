# 463 — claude-canonical-private-fork — plan

_Drafted from `spec.md` on 2026-07-26. The approach, not the steps (those go in `tasks.md`)._

## Approach

1. Carregar junto da fonte o home exato já usado para validar o transcript.
2. Preservar no `forkDefinition` as projeções nativa e de capacidades da definição canônica.
3. Materializar o home privado do destino antes do seed e aplicar seu env/args no processo.
4. Semear sempre que home ou cwd diferir, com caminhos de origem e destino independentes.
5. Generalizar a limpeza do home criado em falhas seguras.
6. Cobrir mesmo-checkout, worktree e falha fechada; atualizar a matriz.

## Key decisions

- **Copiar projeções resolvidas, não o home** — mantém bytes autorizados e elimina estado configurável compartilhado.
- **Não copiar `profileLifecycle`** — ele identifica o agente declarado e acionaria autoridade usando o nome ad-hoc do fork.
- **Materializar antes de semear** — o caminho de transcript do destino pertence ao novo home.
- **Não criar formato persistido nesta entrega** — snapshots duráveis exigem validação própria contra adulteração.

## Files touched

- `src/agents/AgentManager.ts` — resolução, materialização, seed e cleanup do fork.
- `src/workspace/Workspace.ts` — seleção do materializador Claude com projeção nativa.
- `test/unit/agentManager.test.ts` — contratos de isolamento e falha fechada.
- matriz de paridade — evidência do suporte.
- `docs/specs/463-claude-canonical-private-fork/` — contrato e evidência.

## Risks & unknowns

- Dupla injeção do Bridge: reutilizar a ordem comum de materialização/Bridge.
- Limpeza indevida: remover somente home criado nesta tentativa e sem sessão possivelmente viva/worktree.
- Seed silenciosamente global: testar os quatro componentes home/cwd.

## Visual impact

Nenhum; mudança exclusiva de lifecycle/runtime.

## Sources consulted

- `src/agents/AgentManager.ts`
- `src/workspace/Workspace.ts`
- `src/harness/HarnessManager.ts`
- `src/resume/SessionLedger.ts`
- `test/unit/agentManager.test.ts`
