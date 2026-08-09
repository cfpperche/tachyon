# 465 — claude-native-policy-parity

_Created 2026-07-26._

**Status:** shipped
**Closure:** Shipped the measured Claude global/workspace scalar policy, typed
model/effort argv projection, closed permission validation and equivalent
fresh/restart/resume/fork materialization; focused dogfood and both repository
gates passed on 2026-07-26.
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

**Verify:** `npm run typecheck`
**Verify:** `npm run verify:full:quiet`
**Dogfood:** `npx vitest run test/unit/agentProfileConfigLoader.test.ts test/unit/harness.test.ts test/unit/agentManager.test.ts`

## Intent

Claude canônico já possui home privado, capabilities capturadas e projeção parcial de
settings workspace. Porém o contrato ainda é menor e menos preciso que o Codex:
não admite a fonte global medida, não trata selectors Claude comprovados, usa
validação permissiva para `defaultMode` e declara lifecycle sem o fork já suportado.

Completar a policy tipada e a projeção determinística para as fontes/operações
realmente medidas, mantendo auth, memória e tooling fora da herança escalar e
falhando fechado para valores ou selectors não comprovados.

## Acceptance criteria

_Observable outcomes. Given/When/Then scenarios for behavior; plain checkbox bullets for static facts. If every box can be ticked, the spec is delivered. Each criterion should be verifiable without re-reading the plan._

- [x] **Scenario: fontes escalares medidas**
  - **Given** um perfil Claude selecionando permissions, interface ou feature flags de global ou workspace
  - **When** o perfil é resolvido
  - **Then** somente as chaves tipadas da família são projetadas, com proveniência da fonte e sem payload executável/ambiente
- [x] **Scenario: selectors nativos**
  - **Given** model e effort suportados no perfil Claude
  - **When** fresh, restart, resume ou fork materializa o home privado
  - **Then** os selectors viram argumentos Claude determinísticos e provider/service tier não comprovados falham fechados
- [x] **Scenario: permissões não ampliam autoridade**
  - **Given** uma fonte permissions com modo ou shape inválido
  - **When** a policy é projetada
  - **Then** o perfil é recusado; nenhuma policy sintetiza bypassPermissions
- [x] Fresh/restart/resume/fork regeneram settings/selectors equivalentes e removem estado obsoleto sem perder auth externa, Bridge ou capabilities capturadas.
- [x] A matriz registra evidência nomeada e preserva diferenças nativas legítimas.

## Non-goals

- Memória runtime-managed (`t-d4c42e`), payloads MCP/hooks/skills sem grants ou plugins.
- Editor Agent Form (`t-36b7f0`) e Runtime Config de outros runtimes.
- Copiar settings completos, `settings.local.json`, credenciais ou estado mutável.

## Decisions

- `selectors` usa somente `(agent, overlay, every-launch,
  fresh+restart+resume+fork)`. `model` e `reasoningEffort` materializam em
  `--model`/`--effort`; provider e service tier falham fechados.
- Famílias escalares usam uma única fonte global ou workspace por família e
  materializam no `settings.json` privado selecionado por `--settings`.
- Chaves fora das famílias selecionadas falham fechadas. `defaultMode` aceita
  apenas os cinco modos medidos que preservam checagem de permissões; o modo
  `bypassPermissions` é recusado.
- O probe solicitado como Opus 5
  `probe-77505e6b-bc33-4973-87e3-091b56d7cff6` produziu crítica útil, mas seu
  artefato não registra o modelo efetivo. Ele não foi usado como autoridade
  decisiva; a lacuna está registrada em `t-37fb51`.
