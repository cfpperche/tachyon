# 465 — claude-native-policy-parity — plan

_Drafted from `spec.md` on 2026-07-26. The approach, not the steps (those go in `tasks.md`)._

## Approach

1. Medir o contrato existente e congelar os tuples aceitos após revisão Opus 5.
2. Generalizar o projector Claude para fontes global/workspace independentes.
3. Fechar validação de permissions e selectors; materializar somente flags medidas.
4. Atualizar materialização e lifecycle para equivalência fresh/restart/resume/fork.
5. Cobrir stale cleanup, auth/Bridge/capabilities e atualizar a matriz.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Fonte é selecionada por família** — rejeita merge bruto de settings.
- **`settings.local.json` continua runtime-local** — não é fonte autorável.
- **Capabilities e nativeConfig permanecem lanes separadas** — exigem grants distintos.
- **provider/serviceTier permanecem recusados** — Claude 2.1.220 não expõe flags medidas.
- **Selectors têm um único sink em argv** — model/effort nunca entram no JSON privado.
- **`bypassPermissions` não é herdável** — seleção de fonte não pode transformar
  um perfil canônico em bypass; valores inválidos recusam o perfil inteiro.
- **Revisão Opus sem provenance não decide arquitetura** — o probe concluído não
  persistiu o modelo efetivo; decisões acima ficam apoiadas nas medições locais e
  nos testes, enquanto `t-37fb51` corrige a observabilidade.

## Files touched

- `src/config/{agentNativeConfigPolicy,claudeNativeConfigProjection,agentProfileProjection}.ts`
- `src/harness/HarnessManager.ts`
- testes de profile loader, harness e lifecycle AgentManager
- `docs/runtimes/parity.md` e esta SDD

## Risks & unknowns

- Um modo permissions permissivo pode ampliar autoridade silenciosamente.
- Flags de selector duplicadas ou em ordem variável quebram equivalência de lifecycle.
- Rejeitar todo o documento por chaves não selecionadas é deliberadamente
  fail-closed; autoria granular será apresentada pelo Agent Form.

## Visual impact

Nenhum nesta slice; autoria visual pertence a `t-36b7f0`.

## Sources consulted

- `src/config/agentNativeConfigPolicy.ts`
- `src/config/claudeNativeConfigProjection.ts`
- `src/config/agentProfileProjection.ts`
- `src/harness/HarnessManager.ts`
- SDDs 460, 462, 463 e Claude Code 2.1.220 `--help`
