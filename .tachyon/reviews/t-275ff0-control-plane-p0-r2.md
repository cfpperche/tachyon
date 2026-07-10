# Revisão adversarial final P0 — t-275ff0 (R2)

**Agente:** `controlPlaneP0ReviewR2`  
**Commits:** `2ffb1d8195383d48b07953755cff2667870fe862` e `f90b6b32c81c9af7c012bf50cb46fe4be84453af`  
**Escopo:** revisão read-only do código dos commits; única escrita é este parecer  
**Veredito:** **FINDINGS**

## Findings priorizados

### P1 — `ControlModeClient.dispose()` aposenta o processo sem liquidar a geração; operações ativas ficam pendentes para sempre

**Cenário concreto:** há uma chamada `manager.list()`/`capturePane()` ativa no control-mode quando o workspace é removido ou a extensão recarrega. `Workspace.dispose()` agora chama corretamente `this.tmux.dispose()` antes dos awaits, mas esse método rejeita somente a fila e deixa operações já ativas terminarem. Em seguida `this.engine.dispose()` mata o processo e define `this.proc = undefined` sem rejeitar nem remover `this.pending`. O evento `exit` tardio chama `onClientDown(proc)`, mas é descartado pelo guard `proc !== this.proc`; pelo mesmo motivo, o timer da operação retorna sem rejeitar. A promise do executor nunca fecha, o `finally` de `TmuxService.run()` nunca libera o slot e qualquer handler que a aguardava fica órfão durante o teardown.

**Evidência:** `src/workspace/Workspace.ts:2903-2918`, `src/tmux/TmuxService.ts:576-582`, `src/tmux/TmuxService.ts:633-640`, `src/tmux/ControlModeClient.ts:210-220`, `src/tmux/ControlModeClient.ts:307-318`, `src/tmux/ControlModeClient.ts:330-335` (árvore de `2ffb1d8`). O teste de workspace em `test/unit/workspaceHeadless.test.ts:171-193` usa um executor fake e resolve manualmente as operações depois do dispose; o teste de engine em `test/unit/controlMode.test.ts:257-266` não mantém comando pendente.

**Correção esperada:** aposentar explicitamente a geração no dispose e liquidar todos os `pending` com erro terminal de descarte que não acione fallback; limpar seus timers antes de soltar a referência do processo. Cobrir uma operação control-mode ativa durante `Workspace.dispose()` e provar settlement/slot release, ausência de fallback e zero timers.

### P2 — uma falha transitória antes do spawn encerra definitivamente o loop de reconnect

**Cenário concreto:** depois do timeout de um frame, `onClientDown()` agenda reconnect. Se a chamada de fallback que recria/verifica o anchor falhar antes de `spawnClient()` — por exemplo durante reinício do servidor tmux — `start()` rejeita com `this.proc` ainda `undefined`. O `catch` chama `onClientDown(this.proc ?? proc)` com o processo antigo já aposentado; o guard de geração retorna imediatamente e nenhum novo timer é agendado. O control-mode permanece down até reconstrução externa do workspace. As operações ainda podem usar subprocess fallback, mas o loop anunciado como permanente deixa de existir após uma única falha de bootstrap.

**Evidência:** `src/tmux/ControlModeClient.ts:152-173`, `src/tmux/ControlModeClient.ts:307-326` (árvore de `2ffb1d8`). `test/unit/controlMode.test.ts:188-209` cobre somente reconnect cujo `start()` tem sucesso na primeira tentativa.

**Correção esperada:** reagendar o bootstrap sem passar uma geração já retirada pelo guard (ou separar falha de bootstrap de queda de cliente), preservando backoff e respeitando `disposed`; testar uma falha de anchor seguida por sucesso.

### P2 — o coalescing pode consumir todos os refreshes sem produzir o retry prometido

**Cenário concreto:** a listagem A continua pendente após o fallback visual de 250 ms. Todo `READY`, `requestSnapshot` ou `refreshAll()` recebido enquanto A não assentou reutiliza `request.bounded`, que já está resolvida como `unavailable`; esses refreshes não chamam `manager.list()` de novo. Quando A finalmente rejeita ou resolve, `release()` apenas apaga o mapa: não inicia uma tentativa trailing nem reposta o painel. Assim, mesmo que vários refreshes tenham ocorrido e o tmux já tenha recuperado antes de A assentar, o painel fica em `unavailable` até um refresh adicional posterior. Na composição com os limites do tmux, essa janela pode incluir espera de fila mais timeout ativo.

**Evidência:** `src/webview/MissionControlPanel.ts:127-140`, `src/webview/MissionControlPanel.ts:244-247`, `src/webview/mission-control/App.tsx:379-382` (árvore de `f90b6b3`). O teste `test/unit/missionControlPanel.test.ts:116-150` codifica que refreshes durante A não tentam novamente e só verifica uma nova chamada após resolver A e emitir mais um refresh.

**Correção esperada:** manter no máximo uma listagem ativa mais um sinal trailing; se houve refresh após o fallback de 250 ms, ao assentar a source iniciar exatamente uma tentativa nova (ou repostar automaticamente), ainda com guards de geração/workspace/dispose. Ajustar o texto se a política intencional for que somente um refresh posterior ao settlement retente.

## Fechamento dos findings anteriores

- **Timeout dos quatro executores ativos:** fechado no runtime normal. `TmuxService` passa deadline/op; o control-mode retira toda a geração FIFO no primeiro frame ausente; fallback recebe o mesmo deadline; frames tardios ficam isolados pelo processo de origem. O finding de teardown acima é uma lacuna distinta dessa liquidação normal.
- **Wiring de `Workspace.dispose()`:** o wiring foi adicionado e rejeita a fila, mas o fechamento não é completo por causa das operações ativas órfãs descritas no P1.
- **Posts antigos do Mission Control:** fechado. Geração monotônica, identidade do workspace e flag de dispose impedem snapshot/error tardio de sobrescrever estado novo.
- **Erro estruturado do Bridge:** fechado para `TmuxQueueError`. `structuredContent.error` preserva `message`, `code`, `op` e `queueWaitTimeoutMs`, com teste MCP ponta a ponta.
- **Acúmulo de listagens abandonadas:** fechado quanto ao crescimento sem limite por workspace; resta a falha de retry/trailing descrita no P2.

## Conclusão

Os dois commits corrigem o modo de falha principal em execução, o overwrite por posts antigos e o transporte estruturado do erro. Ainda não confirmo fechamento de todos os P1/P2: teardown pode deixar operações control-mode eternamente pendentes, o reconnect pode morrer após uma única falha de bootstrap e o coalescing pode absorver refreshes sem executar a recuperação anunciada.
