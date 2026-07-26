# 465 — claude-native-policy-parity — notes

_Created 2026-07-26._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- Claude Code 2.1.220 mede `--model` e `--effort`; eles têm sink único em
  argv. O JSON privado nunca recebe aliases desses selectors.
- `defaultMode` aceita `acceptEdits`, `auto`, `manual`, `dontAsk` e `plan`.
  `bypassPermissions` é deliberadamente recusado para a seleção de fontes do
  perfil canônico.
- Cada família escalar escolhe global ou workspace. Um documento selecionado
  contendo chaves fora da família falha fechado, evitando importar hooks,
  ambiente, memória ou tooling por acidente.

## Deviations

- O probe adversarial `probe-77505e6b-bc33-4973-87e3-091b56d7cff6` foi
  solicitado como Claude Opus 5 e concluiu, mas os artefatos não registram o
  modelo efetivo. A crítica foi mantida apenas como insumo não decisivo; a
  arquitetura foi fechada pelas medições locais e a lacuna foi anexada a
  `t-37fb51`.

## Tradeoffs

- A rejeição integral de documentos com chaves não selecionadas é mais estrita
  que um filtro silencioso. Ela reduz conveniência, mas torna a proveniência e
  o limite de autoridade verificáveis.

## Open questions

- A compatibilidade entre cada modelo e cada nível de effort continua sendo
  responsabilidade do runtime; Tachyon valida o enum medido e nunca faz
  downgrade silencioso. Uma tabela de compatibilidade exigiria medição separada.

## Dogfood log

### 2026-07-26T13:55:27Z — pass (1/1) — source: tasks.md — commit: e2133038937d2dbf2d21c6c587c20981a13829a9
- `npx vitest run test/unit/agentProfileConfigLoader.test.ts test/unit/harness.test.ts test/unit/agentManager.test.ts` — pass

## Verification log

### 2026-07-26T13:55:40Z — pass (2/2) — source: tasks.md
- `npm run typecheck` — pass
- `npm run verify:full:quiet` — pass
