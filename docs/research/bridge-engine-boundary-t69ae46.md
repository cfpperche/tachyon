# Fronteira bridge/engine por símbolo

Medição de `t-69ae46` sobre a árvore `68443f59`, em 2026-08-14. Este documento descreve
uma decomposição possível; nenhuma extração foi implementada.

## Resposta curta

`bridge` deve virar pacote próprio, mas **não deve ser a próxima mudança**. Hoje existem 38
declarações de importação, em 15 arquivos fora de `bridge`, carregando 69 símbolos da gaveta
`packages/engine/src/bridge`. Destes símbolos, 36 (52%) são domínio da engine, 4 (6%) são
utilitários sem relação com transporte e 29 (42%) são transporte de fato. Os 29 símbolos de
transporte estão concentrados em cinco arquivos da engine.

Mover agora o transporte, sem reexportações que escondam a direção, toca nominalmente 112
arquivos. Antes disso, seis extrações de domínio/utilitário tocam conjuntos de 5 a 34 arquivos e
removem 40 das 69 arestas. Depois é preciso inverter as 29 arestas restantes nos cinco pontos de
composição. Só então o novo pacote compra o ganho decisivo: `@tachyon/bridge` depende de
`@tachyon/engine`, a engine não declara a dependência inversa, e `check:package-boundary` torna a
regra mecânica.

Portanto: **sim ao pacote como estado final; não a uma fatia de 112 arquivos agora**.

## O que foi contado

Uma aresta é um *binding* importado, e não um nome de módulo nem uma ocorrência lexical. Assim,
uma declaração que importa `Bridge` e `derivePort` conta duas arestas; um `import type` também
conta, pois ainda fixa a direção arquitetural. Imports internos a `bridge` não entram no universo
de 69: a pergunta medida é resto da engine → `bridge`.

Critério de classificação:

- **domínio**: vocabulário ou comportamento que continua necessário se MCP for substituído por
  HTTP, IPC ou chamada em processo;
- **utilitário**: operação geral, sem semântica de orquestração nem de transporte;
- **transporte**: autenticação, sessão, endereço, ciclo de vida, DTO ou composição especificamente
  necessários para expor/alcançar a engine por uma bridge.

Esse critério corrige duas leituras por nome. `primer` é domínio: ele projeta identidade,
precedência e protocolo de trabalho que qualquer transporte precisa entregar. `tools.ts`, ao
contrário, é misto: cinco dos seis conceitos que a engine importa dele são domínio; somente
`BridgeDeps` descreve a montagem do adaptador MCP.

## Inventário completo das arestas

As contagens entre parênteses são bindings, não arquivos.

| origem fora de `bridge` | símbolo importado | classe | razão pelo uso |
|---|---|---:|---|
| `agents/AgentManager.ts` | `URL_ENV_VAR` | transporte | injeta o endereço da bridge no processo filho |
|  | `redactSecrets` | utilitário | sanitiza transcript/log independentemente do protocolo |
|  | `spawnContractCompletion`, `SpawnContract`, `PARENT_CWD_REFUSAL` | domínio (3) | contrato e política de criação de agentes |
|  | `wrapWithPrimer`, `renderPrimer` | domínio (2) | onboarding entregue ao agente, não framing MCP |
| `agents/paneTranscript.ts` | `redactSecrets` | utilitário | sanitização de transcript |
| `agents/promptLayers.ts` | `briefCarriesTaskSubstance` | domínio | semântica do brief persistido |
| `resume/SessionLedger.ts` | `spawnContractCompletion`, `SpawnContract` | domínio (2) | persistência do contrato de spawn |
| `sidebar/sidebarFleetService.ts` | `truncateByCodePoint` | utilitário | truncamento Unicode geral |
| `engine-service/engineService.ts` | `approvalResolutionPorts` | domínio | portas do fluxo de aprovação |
| `engine-service/extensionOperationService.ts` | `approvalResolutionPorts`, `resolveApproval` | domínio (2) | executa o mesmo caso de uso de aprovação do Companion |
|  | `executeWait` | domínio | semântica compartilhada do caso de uso `agent.wait` |
|  | `BridgeDeps` | transporte | reutiliza diretamente o saco de dependências do adaptador MCP |
|  | `APPROVAL_CHANNEL_VSCODE_COMMAND` | transporte | identifica a porta de entrada VS Code |
| `engine-service/stateMigration.ts` | `PersistableEntry` | transporte | formato persistido do registro de identidade da bridge |
|  | `bridgeGenerationStateKey` | transporte | chave de geração/rebind do cliente da bridge |
|  | `bridgeTokenFileName`, `externalBridgeTokenFileName` | transporte (2) | nomes dos segredos de autenticação da bridge |
| `workspace/DaemonEngineHost.ts` | `NotifyLevel` | domínio | nível de notificação da porta de UI da engine |
| `workspace/EngineHost.ts` | `NotifyLevel` | domínio | tipo da porta `EngineHost.notify` |
| `workspace/authRequiredNotice.ts` | `NotifyLevel` | domínio | modelo de aviso da engine |
| `workspace/noticeInbox.ts` | `NotifyLevel` | domínio | modelo persistido e chave de deduplicação do inbox |
| `workspace/GatedCompletionMonitor.ts` | `NoticeQueueMetadata` | domínio | metadado de ciclo de vida de aviso |
| `workspace/RuntimeSlackMonitor.ts` | `NoticeQueueMetadata` | domínio | metadado de ciclo de vida de aviso |
| `workspace/bridgeSlowRequestPolicy.ts` | `BridgeRequestCompleteInfo` | transporte | política observa requests concretos da bridge |
| `workspace/Workspace.ts` | `approvalResolutionPorts`, `listPendingApprovalRequests`, `resolveApproval`, `ApprovalDecision` | domínio (4) | caso de uso e estado de aprovação |
|  | `APPROVAL_CHANNEL_COMPANION_HTTP` | transporte | identifica a porta HTTP de entrada |
|  | `AttachEvidenceInput`, `CMD_WAIT_PREFIX`, `NoticeDeliveryResult`, `NotifyLevel` | domínio (4) | comandos/estados que a engine implementa e outros transportes reutilizariam |
|  | `appendDoorbellOverflowEvent`, `hasDoorbellRung` | domínio (2) | ledger durável da comunicação entre agentes |
|  | `Waiters` | domínio | coordenação de waits da engine |
|  | `DEFAULT_NOTICE_TTL_MS`, `NoticeQueue`, `NoticeOrigin`, `NoticeQueueItem`, `NoticeQueueMetadata` | domínio (5) | fila e política de entrega, usadas antes do adaptador |
|  | `composeAgentNotice`, `prepareAgentSummary` | domínio (2) | política da mensagem agente→agente; não conhece MCP |
|  | `Bridge`, `derivePort` | transporte (2) | servidor e endereço concretos |
|  | `BridgeClientRebindCoordinator`, `DEFAULT_BRIDGE_CLIENT_REBIND`, `parseBridgeClientRebindSettings`, `reloadInitiatorStateKey`, `isTachyonBridgeWiredRecord`, `BridgeClientRebindSettings`, `ClientRebindState` | transporte (7) | ciclo de vida de clientes conectados à bridge |
|  | `loadOrCreateExternalToken`, `loadOrCreateToken`, `TOKEN_ENV_VAR`, `URL_ENV_VAR`, `AGENT_TOKEN_ENV_VAR` | transporte (5) | credenciais/endereço da bridge |
|  | `healUnknownBearerFromProc` | transporte | recuperação de bearer da bridge |
|  | `CallerIdentityRegistry`, `loadOrCreateHmacKey`, `CallerScope`, `CallerSnapshot`, `PersistableEntry` | transporte (5) | identidade/autenticação na fronteira de transporte |
|  | `redactSecrets` | utilitário | sanitização geral |

Totais conferidos por classe:

| classe | bindings | declarações que contêm a classe | arquivos consumidores |
|---|---:|---:|---:|
| domínio | 36 | 24 | 12 |
| utilitário | 4 | 4 | 4 |
| transporte | 29 | 12 | 5 |
| **total** | **69** | **40 ocorrências de classe em 38 imports** | **15** |

“40 ocorrências de classe” é maior que 38 porque dois imports são mistos:
`extensionOperationService` importa `executeWait`/`BridgeDeps`, e os imports de aprovação carregam
caso de uso e identificação do canal juntos.

## Volume das extrações

O volume abaixo é nominal e reproduzível: arquivo que define o símbolo + cada arquivo TypeScript que
o importa/reexporta hoje. Não inclui documentação, arquivos gerados nem um shim de compatibilidade.
Quando um símbolo sai do arquivo misto `tools/shared.ts`, entram também esse arquivo e a fachada
`tools.ts`. Um arquivo contado em dois grupos só é tocado uma vez dentro de cada fatia.

### 1. Coordenação de wait — 5 arquivos

Extrair `Waiters`, `executeWait` e `CMD_WAIT_PREFIX` para domínio. É a fatia mais barata e prova cedo
que uma operação hoje exposta por MCP e pela extension pode ter uma implementação da engine.

`packages/engine/src/bridge/Waiters.ts`, `packages/engine/src/bridge/tools/shared.ts`,
`packages/engine/src/workspace/Workspace.ts`, `packages/engine/src/engine-service/extensionOperationService.ts`,
`packages/engine/src/bridge/tools/communication-waits.ts`. O teste nominal direto é
`test/unit/waiters.test.ts`; incluindo-o, são **6** arquivos. `test/e2e/bridge-host.ts` importa apenas
`CMD_WAIT_PREFIX`; tornando-o canônico na mesma fatia, são **7**.

### 2. Formatação/sanitização — 15 arquivos, em duas mudanças independentes

- `redactSecrets`: **9** arquivos — `apps/vscode-extension/src/webview/agent-studio-shell/agentStudioDomain.ts`,
  `packages/engine/src/agents/AgentManager.ts`, `packages/engine/src/agents/paneTranscript.ts`,
  `packages/engine/src/bridge/redact.ts`, `packages/engine/src/bridge/tools/communication-io.ts`,
  `packages/engine/src/bridge/tools/communication-waits.ts`, `packages/engine/src/bridge/tools/shared.ts`,
  `packages/engine/src/workspace/Workspace.ts`, `test/unit/redact.test.ts`.
- `truncateByCodePoint` e política de composição: **7** arquivos —
  `packages/engine/src/bridge/notifyAgent.ts`, `packages/engine/src/bridge/tools/communication-io.ts`,
  `packages/engine/src/sidebar/sidebarFleetService.ts`, `packages/engine/src/workspace/Workspace.ts`,
  `test/unit/codexComposerWrapMeasured.test.ts`, `test/unit/notifyAgent.test.ts`,
  `test/unit/notifyTruncation.test.ts`.

A união tem 15 arquivos. Recomendo separar `truncateByCodePoint` como utilitário, mas manter
`composeAgentNotice`/`prepareAgentSummary` no domínio de comunicação.

### 3. Fila e ledger de avisos — 14 arquivos

Mover `NoticeQueue` e `doorbell` como domínio toca:

`packages/engine/src/bridge/NoticeQueue.ts`, `packages/engine/src/bridge/doorbell.ts`,
`packages/engine/src/bridge/tools/communication-io.ts`, `packages/engine/src/bridge/tools/shared.ts`,
`packages/engine/src/workspace/GatedCompletionMonitor.ts`,
`packages/engine/src/workspace/RuntimeSlackMonitor.ts`, `packages/engine/src/workspace/Workspace.ts`,
`test/unit/bridge.test.ts`, `test/unit/doorbell.test.ts`, `test/unit/humanDraftHoldsNotice.test.ts`,
`test/unit/noticeQueue.test.ts`, `test/unit/notifyDoorbellDelivery.test.ts`,
`test/unit/snBellBehavior.gen.test.ts`, `test/unit/workspaceHeadless.test.ts`.

### 4. Contrato de spawn e primer — 17 arquivos

Mover os dois juntos evita criar um segundo lar temporário para o texto que `AgentManager` compõe:

`packages/engine/src/agents/AgentManager.ts`, `packages/engine/src/agents/promptLayers.ts`,
`packages/engine/src/bridge/primer.ts`, `packages/engine/src/bridge/spawnContract.ts`,
`packages/engine/src/bridge/tools/fleet.ts`, `packages/engine/src/resume/SessionLedger.ts`,
`scripts/dogfood-project-guidance.mts`, `test/unit/agentManager.test.ts`,
`test/unit/cxApproval2Behavior.gen.test.ts`, `test/unit/deadToolPointers.test.ts`,
`test/unit/declarableWorktreeDirectories.test.ts`, `test/unit/ocPrimerShapeBehavior.gen.test.ts`,
`test/unit/primer.test.ts`, `test/unit/projectGuidanceOwnership.test.ts`,
`test/unit/snBriefBehavior.gen.test.ts`, `test/unit/spawnContract.test.ts`,
`test/unit/spawnParentCwdRefusal.test.ts`.

Há um acoplamento que a mudança deve cortar: `spawnContract.ts` importa `CallerKind` de
`callerIdentity.ts`. O conceito mínimo de ator usado para decidir as saídas de cwd precisa ser um
tipo de domínio; mover o arquivo sem isso apenas inverte a seta errada.

### 5. Aprovação — 29 arquivos

`approvalRequest` e `approvalResolutionPorts` são o corte quente mencionado na task. A união medida é:

`apps/vscode-extension/src/shell/BoardTarget.ts`,
`apps/vscode-extension/src/webview/HumanInboxPanel.ts`,
`apps/vscode-extension/src/webview/approval/viewModel.ts`,
`packages/engine/src/bridge/approvalRequest.ts`,
`packages/engine/src/bridge/approvalResolutionPorts.ts`,
`packages/engine/src/bridge/tools/coordination-continuity.ts`,
`packages/engine/src/bridge/tools/human-approvals.ts`,
`packages/engine/src/engine-service/engineService.ts`,
`packages/engine/src/engine-service/extensionOperationService.ts`,
`packages/engine/src/workspace/Workspace.ts`,
`packages/webview-ui/src/webview/approval/viewModel.ts`,
`packages/webview-ui/src/webview/human-inbox/App.tsx`,
`packages/webview-ui/src/webview/human-inbox/main.tsx`,
`packages/webview-ui/src/webview/human-inbox/messages.ts`, `src/webview/approval/App.tsx`,
`src/webview/approval/messages.ts`, e 13 testes:
`approvalCompletePinPolicy`, `approvalDecisionSeal`, `approvalResolutionPorts`,
`approvalResolveSocketReachability`, `approvalResolvedByChannel`, `approvalsPendingCount`,
`companionPairApprovalReachability`, `cxApproval2Behavior.gen`, `humanInboxApp`,
`humanInboxDeepLinkCrossing`, `namedActionHumanGateReachability`, `ocApprovalBehavior.gen` e
`validationCloseNotify` em `test/unit/*.test.ts`.

Os dois `APPROVAL_CHANNEL_*` não acompanham o domínio: ficam nos adaptadores VS Code/HTTP e entram
como argumento de `resolveApproval`.

### 6. Vocabulário misturado em `tools/shared.ts` — 34 arquivos

Extrair `NotifyLevel`, `NoticeDeliveryResult`, `AttachEvidenceInput`, `CMD_WAIT_PREFIX` e
`executeWait`, atualizando consumidores para o caminho canônico da engine, toca **34** arquivos:
15 arquivos de produção (incluindo os 2 definidores/fachadas), 1 script e 18 testes.

Produção: `packages/engine/src/bridge/tools/shared.ts`, `packages/engine/src/bridge/tools.ts`,
`apps/vscode-extension/src/shell/BoardTarget.ts`,
`apps/vscode-extension/src/workspace/NotificationService.ts`,
`apps/vscode-extension/src/workspace/notify.ts`,
`packages/engine/src/bridge/approvalResolutionPorts.ts`,
`packages/engine/src/bridge/tools/automation-commands.ts`,
`packages/engine/src/bridge/tools/communication-waits.ts`,
`packages/engine/src/engine-service/extensionOperationService.ts`,
`packages/engine/src/workspace/DaemonEngineHost.ts`, `packages/engine/src/workspace/EngineHost.ts`,
`packages/engine/src/workspace/Workspace.ts`, `packages/engine/src/workspace/authRequiredNotice.ts`,
`packages/engine/src/workspace/noticeInbox.ts`, `src/workspace/VsCodeHost.ts`.

Script: `scripts/dogfood/native-config-sources.ts`.

Testes: `approvalResolutionPorts`, `configDiscardSurface`, `continuityWiring`, `crashRestartMemory`,
`cxNoticeBehavior.gen`, `emptyRosterConfig`, `humanDraftHoldsNotice`, `launchAuthRefusalSurface`,
`nativeConfigSources`, `notifyDoorbellDelivery`, `ocGhostQBehavior.gen`, `resumeTokenProof`,
`savedAgentBypassConsent`, `tachyonConfigSelfEditGate`, `validationCloseNotify`, `workspaceHeadless`,
`workspaceSurfaceLifecycle` em `test/unit`, mais `test/e2e/bridge-host.ts`.

O número alto vem sobretudo de `NotifyLevel` (24 importadores no repositório), não de complexidade
intrínseca. Compatibilidade por reexport reduz o diff momentâneo, mas não conta como fronteira
concluída enquanto consumidores da engine ainda importarem `bridge/tools`.

## As arestas de transporte que ficam antes da inversão

Depois das seis extrações, ficam 29 bindings reais de transporte em cinco arquivos:

| consumidor | bindings que ficam | quantidade | por que não é domínio a “devolver” |
|---|---|---:|---|
| `agents/AgentManager.ts` | `URL_ENV_VAR` | 1 | lança o cliente com endpoint da bridge |
| `engine-service/extensionOperationService.ts` | `BridgeDeps`, `APPROVAL_CHANNEL_VSCODE_COMMAND` | 2 | montagem do adaptador e identidade da porta de entrada |
| `engine-service/stateMigration.ts` | `PersistableEntry`, `bridgeGenerationStateKey`, `bridgeTokenFileName`, `externalBridgeTokenFileName` | 4 | migra estado privado de autenticação/rebind |
| `workspace/bridgeSlowRequestPolicy.ts` | `BridgeRequestCompleteInfo` | 1 | observa request do transporte |
| `workspace/Workspace.ts` | `APPROVAL_CHANNEL_COMPANION_HTTP`, `Bridge`, `derivePort`, sete símbolos de client-rebind, cinco de token, `healUnknownBearerFromProc` e cinco de caller-identity | 21 | `Workspace` ainda é o composition root do servidor e da autenticação |
| **total** |  | **29** |  |

Elas “ficam” como resultado desta medição, não como dependência aceitável do pacote final. Não há
como declarar `@tachyon/bridge -> @tachyon/engine` enquanto qualquer uma continuar na direção
engine → bridge. A inversão é arquitetural:

1. o shell/composition root cria a bridge e entrega à engine portas estreitas;
2. migrações privadas de token/identity/rebind pertencem ao pacote de transporte;
3. `AgentManager` recebe launch env/configuração, não conhece o nome da variável da bridge;
4. a política de request lento é callback/telemetria fornecida pelo transporte;
5. canais de aprovação são valores do adaptador, não constantes do caso de uso.

O conjunto mínimo nominal dessa inversão começa nos cinco consumidores acima e nos oito módulos de
transporte que eles alcançam (`Bridge`, `token`, `callerIdentity`, `clientRebind`, `agentTokenHeal`,
`tools/shared`, `approvalRequest` para os canais e o futuro composition root): **13 arquivos antes
de testes e plumbing**. Isso é um piso mensurável, não uma estimativa de diff.

## Custo do pacote final

Contando os módulos de transporte, seus importadores/reexportadores atuais e o plumbing mínimo de
workspace (`package.json` raiz, `tsconfig.json`, manifests de engine, extension e webview), a mudança
sem shims toca **112 arquivos**. O conjunto contém 30 arquivos de implementação do transporte
(os 23 módulos em `bridge/tools/`, `tools.ts`, `Bridge.ts`, `token.ts`, `callerIdentity.ts`,
`clientRebind.ts`, `agentTokenHeal.ts`, `lifecycleScope.ts`, `spawnTaskClaim.ts` e
`waitForOutput.ts`), 13 consumidores/plumbing de produção e 69 scripts/testes. `spawnContract.ts`
também aparece no conjunto de transição porque hoje importa `CallerKind`; ele deve sair desse
conjunto na fatia 4.

O número de 112 responde por que o pacote não é a primeira fatia. O número de 29 responde o que
ainda impede sua direção correta. O número de 40 arestas removíveis responde por que a separação
ainda paga: mais da metade da dependência atual é a gaveta mentindo sobre propriedade.

## Ordem recomendada

1. Wait/command coordination: 7 arquivos incluindo testes — menor e informa se a porta interna é
   suficiente para MCP e extension.
2. Sanitização/formatação: 15 arquivos em duas mudanças independentes — baixo risco e elimina os
   quatro utilitários da contagem.
3. Fila/doorbell: 14 arquivos — estabelece o domínio de entrega antes de mover adaptadores.
4. Spawn contract + primer: 17 arquivos — corrige a propriedade do onboarding e corta `CallerKind`.
5. Aprovação: 29 arquivos — deliberadamente depois das fatias menores por tocar AgentManager/
   Workspace e os dois ingressos de resolução.
6. Vocabulário de `tools/shared`: 34 arquivos — mecanicamente amplo por `NotifyLevel`, mas conceitualmente
   simples; manter reexports apenas durante a migração.
7. Inverter as 29 arestas de transporte nos cinco consumidores; o piso é 13 arquivos antes de testes.
8. Criar `@tachyon/bridge`: 112 arquivos no inventário atual, menos os importadores já corrigidos nas
   fatias anteriores; então ligar a regra de package boundary e remover shims.

Essa ordem usa custo medido, mas não finge que contagem de arquivos é risco semântico: aprovação é
mais quente que `NotifyLevel`, embora toque menos arquivos. A primeira fatia é ao mesmo tempo a mais
barata e a que testa a forma desejada da fronteira.
