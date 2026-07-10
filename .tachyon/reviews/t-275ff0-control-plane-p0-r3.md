# Revisão adversarial delta-only final P0 — t-275ff0 (R3)

**Agente:** `controlPlaneP0ReviewR3`  
**Commits:** `9d4fc01719d898116adac81421b31814b6417373` e `023ff721d51ae1daf34cc017328843b2fb664a28`  
**Veredito:** **FINDINGS**

## P1 — `dispose()` ainda pode ser desfeito por um bootstrap de reconnect já em voo

Cenário novo e concreto: o timer de reconnect dispara, limpa `reconnectTimer` e entra em `start()`; `start()` passa pelo guard inicial e fica aguardando o subprocesso `new-session`. Nesse intervalo, `dispose()` marca o cliente como descartado, não encontra timer/processo para cancelar e executa `kill-session`. Se o `new-session` concluir depois, `start()` não verifica novamente `disposed` após o `await`: cria uma nova geração, grava `this.proc` e instala listeners depois de o teardown ter terminado. Essa geração tardia pode reativar `up`, emitir `onStateChange(true)` e deixar um control client/anchor vivo após dispose. O teste novo cobre dispose com uma geração já ativa, mas não dispose durante bootstrap.

**Evidência:** `src/tmux/ControlModeClient.ts:152-173`, `src/tmux/ControlModeClient.ts:324-333`, `src/tmux/ControlModeClient.ts:337-360` na árvore de `9d4fc01`; `test/unit/controlMode.test.ts:267-311` não intercala dispose com o `fallbackExec` de bootstrap pendente.

**Correção esperada:** revalidar `disposed` depois de cada await de bootstrap e antes/depois de publicar a nova geração; se o dispose vencer a corrida, não spawnar (e remover o anchor tardio em best effort). Cobrir reconnect timer disparado → `new-session` pendente → dispose → bootstrap resolve, provando zero processo, zero timer e `isUp === false`.

## Confirmações do delta

- Operações já pendentes são retiradas em lote, têm timers limpos e recebem `ControlModeDisposedError`, que não aciona fallback por comando; frames/exit tardios da geração aposentada não as ressuscitam.
- Falha de bootstrap do reconnect reagenda com backoff e respeita dispose quando não há bootstrap já em voo; o finding acima é a corrida restante.
- O Mission Control mantém um único sinal trailing: múltiplos refreshes após o fallback produzem exatamente um retry ao settlement. O retry é bloqueado por dispose ou troca de identidade de workspace e ganha uma nova geração, impedindo posts antigos.

## Gates

- `9d4fc01`: `npm run verify:full` — verde, 292 arquivos / 3252 testes passados, 3 skipped; sem waiver.
- `023ff72`: `npm run verify:full` — verde, 292 arquivos / 3247 testes passados, 3 skipped; sem waiver.

