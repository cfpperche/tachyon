# Base transitiva para monorepoizar o Tachyon

_Medição de 2026-08-14 sobre `1bbd23f5609ed4f66a96f648a9b05bf7862cec03` (Tachyon 0.91.0; task `t-aca1ca`)._

> Este documento **substitui como base de decisão** o levantamento de 2026-07-20,
> [`tachyon-monorepo-assessment.md`](./tachyon-monorepo-assessment.md). O anterior permanece como
> registro histórico da 0.56.x, mas contava imports diretos e deixava o custo de empacotamento sem
> número. Em 35 versões `src/` chegou a 773 arquivos TypeScript/TSX, há mais quatro módulos de
> runtime em `shared/`, e `src/webview/` deixou de
> coincidir fisicamente com um único runtime. Aqui a unidade é o fecho transitivo de imports.

## Resultado em uma frase

A monorepoização organizacional paga: **727/777 módulos de runtime (93,6%) são portáteis** — 723/773
em `src/` e 4/4 em `shared/` — e os dois programas já impõem dois conjuntos grandes e mensuráveis:
engine com 391 módulos e navegador com 206. Ela não é, porém, um simples `mv`: **32 arquivos são
compartilhados pelos dois programas**, quatro `.cjs` servem engine e scripts operacionais, e 212
ficam fora de ambos os fechos, e **14 arquivos dentro de subpastas de `src/webview/` importam `vscode`
em valor**. O primeiro corte seguro é por fecho de entrypoint, não por diretório. O custo difícil tem
**18 arquivos operacionais** que codificam raiz única, manifesto único ou `dist/` plano; o primeiro a
quebrar é `package.json#main`/`vsce`, antes do código da engine.

## Medição final — depois das seis fatias da SDD 506

_Medição de 2026-08-14 na árvore final da SDD 506, reproduzida por
`node scripts/research/measure-monorepo-graph.mjs`. Os números iniciais acima permanecem intactos para
que previsão e resultado possam ser comparados._

O primeiro ensaio final encontrou uma falha na própria régua: depois de a fatia 5 mover 164 fontes
para `apps/vscode-extension/src`, o script ainda varria apenas `src/` e `packages/`. Ele reportava 642
arquivos e dez imports relativos falsamente não resolvidos porque **não havia lido o app**. A régua
agora deriva os workspaces do `package.json` da raiz, identifica apps VS Code por `engines.vscode` e
recusa esse apagamento silencioso pela própria contagem: **164 fontes do app** entram no relatório.

### Inicial e final, lado a lado

| medida | antes das fatias | árvore final | por que divergiu |
|---|---:|---:|---|
| universo físico medido (`.ts`/`.tsx` + quatro `.cjs`) | **777** | **805** | o plano contou membros pelo grafo de valor; os compiladores independentes revelaram tipos que esse grafo não emite. As extrações adicionaram 29 módulos de tipo/conceito e o órfão `VsCodeHost.ts` foi apagado: `777 + 29 - 1 = 805` |
| fontes sob `src/` na raiz | **773** | **25** | 164 foram para o app e os fechos mais os tipos necessários foram para os três pacotes; ficam 17 apoios de dev/teste/medição e oito shims de endereço |
| fontes do app VS Code | **0** | **164** | a previsão dizia 212 “aplicação/adaptadores”; ela errou por tratar todo residual como produto. A medição da fatia 4 separou 17 apoios, oito shims e um órfão |
| `shared` físico, incluindo quatro `.cjs` | **4** | **45** | a previsão de 36 era de runtime; nove módulos de tipo puro/conceito foram necessários para o pacote compilar sozinho (D7) |
| `engine` físico | **0** | **368** | a previsão de 355 era de runtime; sete tipos puros e seis módulos de conceito acrescentaram 13 endereços de compilação |
| `webview-ui` físico | **0** | **203** | a previsão de 174 era de runtime; 29 tipos puros/conceitos foram necessários para fechar a compilação sem importar hosts |
| acoplados a `vscode` por valor transitivo | **50** | **49** | 47 pertencem ao app, dois são hosts de fixture em `src/`; o quinquagésimo era o órfão sem importador e foi apagado |
| imports diretos de `vscode` em valor | **42** | **41** | a única queda é o mesmo órfão apagado |
| imports diretos somente de tipo | **9** | **9** | todos pertencem ao app; continuam apagados do JavaScript |
| acoplados se tipos forem propagados | **88** | **78** | a extração de vocabulário removeu dez implementações host do fecho de tipos; não houve ganho fictício no fecho de valor |
| especificadores relativos não resolvidos | **3/2.544 pares** | **3/1.916 pares** | permanecem exatamente os três assets JSON nominais; os dez falsos não resolvidos do primeiro ensaio final desapareceram quando o app entrou no universo |

As três células de runtime previstas permaneceram numericamente estáveis: engine **391 = 355 próprios
+ 36 compartilhados**, navegador **206 = 174 próprios + 32 compartilhados**, e interseção de runtime
**32**. Isso não confirma a previsão inteira: confirma apenas o grafo de **valor**. A forma física é
maior porque cada pacote precisa também do vocabulário que o JavaScript não carrega.

### Os 26 residuais, depois da decisão sobre o órfão

Antes desta fatia havia exatamente **26** fontes sob `src/`, nos mesmos três grupos medidos na fatia
4. A revisão final encontrou os mesmos 17 apoios e oito shims; o único arquivo sem importador era
`src/workspace/VsCodeHost.ts`.

- **17 apoios de dev/teste/medição:** permanecem definitivamente no `src/` da raiz. São código do
  repositório (fixtures, fakes, parsers e instrumentos), não pertencem a nenhum dos quatro artefatos
  enviados e não formam um runtime que justifique pacote.
- **8 shims de compatibilidade:** são dívida de endereço, não arquitetura definitiva. O cartão
  `t-31bedf` enumera os oito consumidores a reendereçar e exige apagar os shims sem criar pacote.
- **1 órfão:** apagado. Busca nominal encontrou zero importadores de produção e teste; typecheck,
  build e os dois gates de fronteira são a prova mecânica da remoção. A raiz fica com **25** fontes.

### Onde o plano errou

1. **Fecho de runtime não fecha compilação.** Os números 36/355/174 eram corretos para JavaScript e
   insuficientes para pacotes TypeScript. D7 registra a correção: tipo puro ganha endereço junto do
   conceito, sem arrastar a implementação host.
2. **“212 aplicação/adaptadores” era uma célula residual, não um app.** Só 164 pertenciam a
   entrypoints enviados. Os outros 48 da diferença são explicados por 23 módulos de tipo absorvidos
   pelos pacotes e pelos 25 apoios/shims que continuam na raiz depois de apagar o órfão.
3. **A régua não acompanhou a última mudança de layout.** Sem derivar `apps/*`, a primeira medição
   final examinou um conjunto incompleto e ainda assim saiu verde. O número de membros, não apenas o
   exit code, revelou a perda de cobertura.
4. **O quinto pacote continuou sem número.** Os 25 residuais finais se dividem em 17 apoios e oito
   endereços temporários; ausência comum de entrypoint não é coesão.

## Método e semântica

O script reproduzível é `scripts/research/measure-monorepo-graph.mjs`. Ele parseia os 773 `.ts`/`.tsx`
sob `src/` e os quatro `shared/*.cjs` com a API do TypeScript, resolve `.js` tanto para `.ts` quanto
para `.tsx`, e constrói dois grafos. Das **2.647 ocorrências sintáticas** de especificadores relativos
(2.544 pares importador/especificador distintos), **2.541 pares resolvem e 3 não**. Os três não
resolvidos são deliberados e nominais: `src/attention/manifests.ts` →
`./manifests/{base,grok,neutral}.json`; são assets JSON, não módulos TS/CJS. Nenhuma aresta de código é
descartada em silêncio.

- **runtime**: imports/exports de valor, `require()` e `import()`; `import type`, especificadores
  `type` e `import("x").T` não criam aresta;
- **type-aware**: runtime mais arestas apagadas pelo compilador, usado apenas para precificar tipos
  compartilhados — nunca para declarar acoplamento em runtime.

Um arquivo é **acoplado** quando seu fecho runtime alcança o módulo externo `vscode`; caso contrário é
**portátil**. A classificação é por arquivo de origem, não por linha nem por bundle. Imports externos
diferentes de `vscode` não afetam esta pergunta. O analisador também parte dos entrypoints reais:
`src/engine-service/{engineService,daemonMain}.ts` e os 27 `src/webview/**/main.tsx`.

O gate existente confirma a fronteira já ratificada pela spec 382: `npm run check:engine-boundary`
passa e relata 390 itens no fecho do daemon. Esse número é 387 TS/TSX + três JSON; o gate confina sua
resolução a `src/` e não percorre `shared/`. Este levantamento mede 387 TS/TSX + quatro `.cjs` e exclui
os JSON, portanto o fecho correspondente tem **391 módulos de runtime**. A diferença é de universo,
não de caminho até `vscode`.

## 1. Portabilidade pelo fecho transitivo

| classificação | arquivos | proporção |
|---|---:|---:|
| portátil em runtime (`src/` + `shared/*.cjs`) | **727** | **93,6%** |
| acoplado a `vscode` em runtime | **50** | **6,4%** |
| acoplado se tipos apagados forem tratados como arestas | **88** | **11,3%** |

Em `src/` isoladamente, a classificação pedida pelo contrato permanece **723 portáteis / 50
acoplados**. Os quatro módulos adicionais de `shared/` são todos portáteis; nenhum alcança `vscode`.

Há 42 imports diretos de valor. O fecho acrescenta **8 surpresas** — arquivos sem import direto de
valor cujo código executável chega a outro arquivo que importa `vscode`:

- `src/presentation/TmuxAttachClient.ts`
- `src/webview/AgentStudioPanel.ts`
- `src/webview/CommandStudioPanel.ts`
- `src/webview/RunbookStudioPanel.ts`
- `src/webview/ScheduleStudioPanel.ts`
- `src/webview/TerminalStudioPanel.ts`
- `src/webview/ide-browser-bridge/designModeInject.ts`
- `src/webview/shared/studio/SingleModeStudioPanelManager.ts`

Isso confirma os zeros transitivos nos diretórios grandes que importavam zero diretamente: `agents`
46/46 portáteis, `bridge` 41/41, `config` 49/49, `engine-service` 21/21, `tasks` 21/21, `activity`
18/18, `runtime` 20/20 e `worktree` 16/16. A lista exaustiva por arquivo está no Apêndice A.

## 2. Tipo e valor não são o mesmo acoplamento

| import direto de `vscode` | arquivos | efeito |
|---|---:|---|
| valor | **42** | permanece no JavaScript e acopla runtime |
| somente tipo | **9** | apagado pelo TypeScript; não acopla runtime |

Os nove imports somente de tipo estão todos em `src/webview/`. Somar 42 + 9 e propagar tudo produz 88
“acoplados”; isso infla o conjunto real em **38 arquivos (76% sobre os 50 reais)**. O desenho de
pacotes deve aceitar dependências de tipos por um pacote compartilhado ou `exports` de tipos, sem
forçar esses 38 arquivos para dentro do shell VS Code.

## 3. `src/webview/` contém dois programas, mas não em duas metades físicas

| conjunto medido | arquivos | valor direto `vscode` | tipo direto | acoplados transitivos |
|---|---:|---:|---:|---:|
| raiz física de `src/webview/` | 42 | 20 | 6 | 25 |
| subpastas físicas | 227 | 14 | 3 | 16 |
| navegador, fecho dos 27 `main.tsx` | **206** | **0** | **0** | **0** |

O dado decisivo é o terceiro: o programa navegador real tem **206 arquivos e zero caminho runtime ou
de tipo até `vscode`**. Nenhum dos seus 27 entrypoints alcança arquivo na raiz física de
`src/webview/`; a fronteira de execução via `postMessage` está limpa. Corrigir `.js` → `.tsx` adiciona
`src/webview/design-mode-overlay/App.tsx`; `src/webview/shared/ErrorBoundary.tsx`, a segunda aresta
antes perdida, já pertencia ao fecho por outro entrypoint.

A fronteira **de pastas**, ao contrário, não está limpa. Há 192 arestas cruzando raiz/subpastas:

| direção física | valor | tipo | importadores distintos |
|---|---:|---:|---:|
| raiz → subpastas | 86 | 91 | 34 / 36 |
| subpastas → raiz | 8 | 7 | 2 / 7 |

As oito arestas de valor subpasta→raiz vêm de módulos host como
`shared/SectionPanelManager.ts` e `shared/studio/studioRegistry.ts`; elas **não** entram no fecho dos 27
`main.tsx`. Portanto “mover todas as subpastas para um pacote browser” quebraria imediatamente. O
pacote browser deve ser materializado pelo fecho de entrypoints (206). Desses, 165 estão fisicamente
em `src/webview/`; os outros 41 vêm de fora. Logo **104 dos 269 arquivos físicos** de `src/webview/`
ficam fora do programa browser e permanecem no shell/compartilhado até serem repartidos
conscientemente.

## 4. Pacotes que os números permitem

Esta é uma partição inicial de propriedade de fonte, não uma escolha de workspace nem uma proposta de
versionamento independente:

| pacote/célula | arquivos exclusivos | número que justifica o corte |
|---|---:|---|
| `engine` | **355** | fecho da engine tem 391 módulos e zero `vscode`; retiram-se 32 comuns ao browser e 4 comuns aos scripts |
| `shared` | **36** | 32 na interseção engine/browser + 4 `.cjs` consumidos por engine e scripts operacionais |
| `webview-ui` | **174** | fecho browser tem 206, zero `vscode`; retirando os 32 compartilhados sobram 174 |
| aplicação/adaptadores | **212** | módulos fora dos dois fechos; contém os 50 acoplados e 162 portáteis ainda não justificados como pacote autônomo |
| **total runtime** | **777** | partição sem duplicação; quatro `.d.cts` acompanham os `.cjs` como declarações |

O número refuta dois cortes por gosto:

1. `agents` e `runtime` não “caem sozinhos”: a engine alcança 36/46 arquivos de `agents` e 17/20 de
   `runtime`, enquanto o navegador alcança 2 e 5, e a interseção compartilhada contém 2 e 5. Cortar
   pelos nomes atuais criaria dependências cruzadas antes de criar isolamento.
2. `src/webview/` não é um pacote: só 165 dos 206 arquivos do programa browser estão ali; os outros
   41 vêm de 18 diretórios. Em sentido inverso, 104 dos 269 arquivos físicos de `src/webview/` não
   pertencem ao fecho browser.

Os 32 candidatos mensurados na interseção engine/browser estão no Apêndice B. Eles são um **teto
inicial**, não uma API pronta: durante a implementação, coesão e ciclos podem dividi-los, mas qualquer
divisão terá de preservar os dois consumidores medidos. Os 212 residuais não justificam um quinto pacote único; são o
aplicativo VS Code, hosts webview, entradas auxiliares e validadores. O número correto aqui é
“classificar depois”, não inventar unidade pelo nome.

### O `shared/` que já existe

Os quatro módulos CommonJS da raiz já materializam a mesma necessidade de compartilhamento por uma
segunda direção: **4 arestas de valor vindas de `src/`**, **3 vindas de scripts operacionais** e uma
aresta interna. Há ainda 4 consumidores diretos em testes. Todos os quatro módulos são portáteis e
entram no `shared` proposto acima; isso aumenta o pacote de 32 para **36 implementações de runtime**,
sem inventar outro pacote. Cada `.cjs` leva seu `.d.cts`, portanto são **40 arquivos físicos** no
artefato de pacote.

| módulo | consumidores de produção | dependência interna | chega a `vscode`? |
|---|---|---|---|
| `dependency-lockfile-validity.cjs` | `src/worktree/dependencySharing.ts`; `scripts/verify-record.mjs` | — | não |
| `host-resource-cost-inputs.cjs` | `src/host/vitestBudget.ts` | — | não |
| `host-resource-sizing.cjs` | `src/host/hostResources.ts`; `scripts/verify-full.mjs` | → `host-resource-cost-inputs.cjs` | não |
| `verify-record-validity.cjs` | `src/workspace/verifyRecordReader.ts`; `scripts/verify-record.mjs` | — | não |

A direção é deliberadamente `src/`/scripts → `shared/`; não existe aresta `shared/` → `src/` ou
`shared/` → scripts. Assim esses quatro caem no pacote compartilhado, enquanto suas quatro arestas
vindas da engine continuam contando dentro do fecho de 391 módulos.

Recomendação: monorepo organizacional de versão única e um VSIX continua justificável; **não** há
medição nova que justifique versionar engine e shell separadamente. O custo de compatibilidade
trimestre+ do levantamento anterior permanece fora de escopo.

## 5. A parte difícil, agora com número

Auditei arquivos operacionais executados por build, F5, pacote, provenance, release e gate. O critério
foi nominal e conservador: só entrou arquivo que lê/escreve o manifesto raiz, aponta para `dist/` do
produto, ou trata o checkout inteiro como a unidade de execução. São **18 arquivos únicos**:

| suposição | arquivos | nomes |
|---|---:|---|
| manifesto de extensão único na raiz | **8** | `package.json`, `.vscodeignore`, `esbuild.mjs`, `scripts/prepare-package.mjs`, `scripts/package-closure.mjs`, `scripts/record-provenance.mjs`, `scripts/vsix-smoke.mjs`, `scripts/dev-host/pointer.mjs` |
| `dist/` plano pertencente à raiz | **9** | `package.json`, `.vscodeignore`, `esbuild.mjs`, `scripts/prepare-package.mjs`, `scripts/package-closure.mjs`, `scripts/record-provenance.mjs`, `scripts/ship-boundary.mjs`, `scripts/vsix-artifact.mjs`, `.vscode/launch.json` |
| checkout raiz como unidade de instalar/gatear/F5 | **7** | `package-lock.json`, `tsconfig.json`, `tsconfig.webview.json`, `.vscode/tasks.json`, `.github/workflows/ci.yml`, `scripts/verify-full.mjs`, `scripts/verify-record.mjs` |

As categorias se sobrepõem; a união é 18, não 24. `esbuild.mjs` sozinho contém **20 configurações de
saída** sob `dist/` (19 `outfile` + um `outdir`, sem contar cada CSS copiado) e mais de 60 operações
explícitas de estágio/cópia/prune no mesmo `dist/`.

### Ordem real da quebra

1. **Manifesto/vsce quebra primeiro.** Hoje `package.json#main` aponta para `./dist/extension.js`,
   `vscode:prepublish` chama `scripts/prepare-package.mjs`, e `.vscodeignore` inclui `!dist/**` e
   `!package.json`. Mover o manifesto para `apps/vscode-extension/` faz o VS Code/vsce procurar o
   `main` relativo ao novo diretório antes de qualquer teste da engine importar um pacote.
2. **Build/staging quebra em seguida.** `esbuild.mjs` lê `package.json` do cwd e emite todos os
   artefatos no `dist/` raiz; `prepare-package`, `ship-boundary`, `package-closure` e provenance tratam
   essa árvore como uma única unidade fechada.
3. **F5/dev-host quebra depois do layout.** `.vscode/launch.json` usa cinco referências explícitas a
   `${workspaceFolder}[/...]/dist/**/*.js`; `.vscode/tasks.json` e `dev-host/pointer.mjs` pressupõem
   que a extensão apontada contém simultaneamente `package.json`, `node_modules` e `dist/`.
4. **Gate/CI não é o primeiro bloqueio, mas é trabalho obrigatório.** CI executa `npm ci` e
   `npm run verify:full` na raiz; `verify:full` e `verify-record` atestam a árvore inteira. Esse modelo
   pode continuar correto para versão única, mas scripts/tsconfigs precisam conhecer os novos roots.

Logo, “a parte difícil” não é um trimestre abstrato: é reendereçar **18 arquivos operacionais**, com
uma concentração de risco em **9 que possuem `dist/`** e **8 que possuem a identidade do manifesto**.
Isso sustenta uma migração organizacional, mas não uma mudança simultânea de release identity.

## Apêndice A — classificação exaustiva dos 773 arquivos

Formato: `R` = acoplado pelo fecho runtime a `vscode`; `P` = portátil. A classificação type-aware
permanece no JSON reproduzível emitido pelo script, porque não muda a decisão de runtime.

### R — 50 arquivos

```text
src/extension.ts
src/plugins/ui/host.ts
src/presentation/Terminals.ts
src/presentation/TmuxAttachClient.ts
src/runtimeOps/openRuntimeOps.ts
src/webview/ActivityPanel.ts
src/webview/AgentFixtureStudioPanel.ts
src/webview/AgentPanePanel.ts
src/webview/AgentStudioPanel.ts
src/webview/BoardPanel.ts
src/webview/CommandStudioPanel.ts
src/webview/HandoffPanel.ts
src/webview/HumanInboxPanel.ts
src/webview/PinDetailPanel.ts
src/webview/PipelineStudioPanel.ts
src/webview/PluginsPanel.ts
src/webview/ProbeResultPanel.ts
src/webview/RunbookStudioPanel.ts
src/webview/RuntimeConfigPanel.ts
src/webview/RuntimeOpsPanel.ts
src/webview/ScheduleStudioPanel.ts
src/webview/SectionAppFixturePanel.ts
src/webview/SettingsPanel.ts
src/webview/SidebarPrototype.ts
src/webview/SystemPanel.ts
src/webview/TaskDetailPanel.ts
src/webview/TerminalStudioPanel.ts
src/webview/TmuxPanel.ts
src/webview/WorktreesPanel.ts
src/webview/agent-studio-shell/agentStudioDomain.ts
src/webview/chat-bridge/register.ts
src/webview/controlStrings.ts
src/webview/ide-browser-bridge/browserSession.ts
src/webview/ide-browser-bridge/cdpSession.ts
src/webview/ide-browser-bridge/designModeInject.ts
src/webview/ide-browser-bridge/manager.ts
src/webview/ide-browser-bridge/register.ts
src/webview/ide-browser-bridge/themeTokens.ts
src/webview/shared/SectionPanelManager.ts
src/webview/shared/panelIcon.ts
src/webview/shared/panelSerializer.ts
src/webview/shared/studio/SingleModeStudioPanelManager.ts
src/webview/shared/studio/StudioPanelManagerBase.ts
src/webview/shared/studio/documentStudioCancel.ts
src/webview/shared/studio/studioRegistry.ts
src/webview/task-detail/taskStudioDomain.ts
src/workspace/VsCodeHost.ts
src/workspace/legacyVsCodeSettings.ts
src/workspace/notify.ts
src/workspace/shellDiagnosticLog.ts
```

### P — 723 arquivos

```text
src/activity/ActivityLogManager.ts
src/activity/activityShare.ts
src/activity/activityView.ts
src/activity/attributionGap.ts
src/activity/claudeNormalizer.ts
src/activity/codexNormalizer.ts
src/activity/grokNormalizer.ts
src/activity/hermesNormalizer.ts
src/activity/hermesStorageReader.ts
src/activity/interrupt.ts
src/activity/logStore.ts
src/activity/logWriter.ts
src/activity/opencodeNormalizer.ts
src/activity/opencodeStorageReader.ts
src/activity/piNormalizer.ts
src/activity/sessionOwners.ts
src/activity/tailReader.ts
src/activity/types.ts
src/agent-vscode/hostActionAdapter.ts
src/agent-vscode/reloadCapability.ts
src/agents/AgentManager.ts
src/agents/LifecycleMonitor.ts
src/agents/agentInputService.ts
src/agents/agentInstancePolicy.ts
src/agents/agentMemoryScope.ts
src/agents/agentRemovalCascade.ts
src/agents/agentRuntimeAdmission.ts
src/agents/assignmentSelection.ts
src/agents/bridgeGuidance.ts
src/agents/briefFile.ts
src/agents/cmdRuntimeGate.ts
src/agents/derivedFile.ts
src/agents/forgetAgent.ts
src/agents/formation/adoptionHost.ts
src/agents/formation/authorityStore.ts
src/agents/formation/bootstrapTransaction.ts
src/agents/formation/domain.ts
src/agents/formation/humanLaneTransactions.ts
src/agents/formation/humanLanes.ts
src/agents/formation/lifecycleConsumer.ts
src/agents/formation/lifecycleContract.ts
src/agents/formation/lifecycleHost.ts
src/agents/formation/memoryLane.ts
src/agents/formation/objectStore.ts
src/agents/formation/resolver.ts
src/agents/formation/sessionPolicy.ts
src/agents/legacyFleetGate.ts
src/agents/managedHookTrust.ts
src/agents/openingPromptCapability.ts
src/agents/paneTranscript.ts
src/agents/persistentInstructions.ts
src/agents/piSession.ts
src/agents/promptLayers.ts
src/agents/runtimePromptAdapters.ts
src/agents/savedAgentProposal.ts
src/agents/savedAgentProposalCommit.ts
src/agents/savedAgentProposalReview.ts
src/agents/savedAgentProposalStore.ts
src/agents/savedAgentRemovalProposal.ts
src/agents/savedAgentRemovalProposalCommit.ts
src/agents/savedAgentRemovalProposalReview.ts
src/agents/savedAgentRemovalProposalStore.ts
src/agents/sessionWorkRecord.ts
src/agents/spawnPath.ts
src/agents/startupBrief.ts
src/agents/stoppedTemporaryResidue.ts
src/anchor/compaction.ts
src/attention/AttentionMonitor.ts
src/attention/completionHint.ts
src/attention/cpu.ts
src/attention/manifestEngine.ts
src/attention/manifests.ts
src/attention/patterns.ts
src/attention/resourceSample.ts
src/bridge/Bridge.ts
src/bridge/NoticeQueue.ts
src/bridge/Waiters.ts
src/bridge/agentTokenHeal.ts
src/bridge/approvalRequest.ts
src/bridge/approvalResolutionPorts.ts
src/bridge/callerIdentity.ts
src/bridge/clientRebind.ts
src/bridge/doorbell.ts
src/bridge/lifecycleScope.ts
src/bridge/notifyAgent.ts
src/bridge/primer.ts
src/bridge/redact.ts
src/bridge/spawnContract.ts
src/bridge/spawnTaskClaim.ts
src/bridge/token.ts
src/bridge/tools.ts
src/bridge/tools/automation-commands.ts
src/bridge/tools/automation-schedules.ts
src/bridge/tools/communication-io.ts
src/bridge/tools/communication-waits.ts
src/bridge/tools/configuration.ts
src/bridge/tools/coordination-continuity.ts
src/bridge/tools/coordination-handoff.ts
src/bridge/tools/coordination-pins.ts
src/bridge/tools/fleet-probes.ts
src/bridge/tools/fleet.ts
src/bridge/tools/host-actions.ts
src/bridge/tools/human-approvals.ts
src/bridge/tools/human-notify.ts
src/bridge/tools/ide-browser.ts
src/bridge/tools/runtime-security.ts
src/bridge/tools/runtime-status.ts
src/bridge/tools/shared.ts
src/bridge/tools/tasks-continue.ts
src/bridge/tools/tasks.ts
src/bridge/tools/user-browser.ts
src/bridge/tools/verification-validations.ts
src/bridge/tools/verification.ts
src/bridge/tools/worktrees.ts
src/bridge/waitForOutput.ts
src/commands/CommandRunner.ts
src/commands/LoginRunner.ts
src/commands/RunbookRunner.ts
src/companion/CompanionHttp.ts
src/companion/CompanionLiveSync.ts
src/companion/CompanionPairingService.ts
src/companion/CompanionTabChannel.ts
src/companion/lanReachability.ts
src/companion/mobileAppStatic.ts
src/companion/pairQr.ts
src/companion/protocol.ts
src/companion/screenshotPersist.ts
src/companion/tabEnvelope.ts
src/companion/tabRefCache.ts
src/companion/tabSafety.ts
src/config/YamlConfigEditor.ts
src/config/agentCapabilityCandidates.ts
src/config/agentCapabilitySource.ts
src/config/agentForgetPlan.ts
src/config/agentInstructionsDocument.ts
src/config/agentInstructionsWrite.ts
src/config/agentNativeConfigPolicy.ts
src/config/agentNativeConfigSchema.ts
src/config/agentProfileAuthority.ts
src/config/agentProfileBundle.ts
src/config/agentProfileConfigLoader.ts
src/config/agentProfileForget.ts
src/config/agentProfileGrants.ts
src/config/agentProfileHome.ts
src/config/agentProfileLifecycle.ts
src/config/agentProfileMaterialization.ts
src/config/agentProfileOwnership.ts
src/config/agentProfileProjection.ts
src/config/agentProfileReader.ts
src/config/agentProfileRefusal.ts
src/config/agentProfileRename.ts
src/config/agentProfileResolver.ts
src/config/agentProfileSchema.ts
src/config/agentProfileStudio.ts
src/config/agentProfileTransactions.ts
src/config/agentRosterDirectory.ts
src/config/agentSkillAuthorization.ts
src/config/agentSkillAuthorizationService.ts
src/config/agentWorkspaceCommandWrite.ts
src/config/agentWorkspaceCommands.ts
src/config/argvCommand.ts
src/config/claudeNativeConfigProjection.ts
src/config/codexNativeConfigProjection.ts
src/config/configDiscards.ts
src/config/configFailure.ts
src/config/configLkg.ts
src/config/framingSafety.ts
src/config/globalSettings.ts
src/config/globalSettingsDocument.ts
src/config/grokNativeConfigProjection.ts
src/config/grokSkillIsolation.ts
src/config/loadConfig.ts
src/config/nameValidation.ts
src/config/projectGuidance.ts
src/config/runtimePromptAdapters.ts
src/config/savedAgentState.ts
src/config/settingsImport.ts
src/config/terminalDeclarations.ts
src/config/withheldCapability.ts
src/continuity/ContinuityState.ts
src/continuity/ContinuityStore.ts
src/continuity/classifier.ts
src/continuity/orphanGc.ts
src/continuity/presentation.ts
src/control-inspector/model.ts
src/dataResolverEntry.ts
src/engine-service/commandIdentity.ts
src/engine-service/controlClient.ts
src/engine-service/controlPeerAuth.ts
src/engine-service/controlServer.ts
src/engine-service/daemonMain.ts
src/engine-service/daemonStateStore.ts
src/engine-service/devHostBoundary.ts
src/engine-service/engineBundleStore.ts
src/engine-service/engineCurrency.ts
src/engine-service/engineLogRing.ts
src/engine-service/engineService.ts
src/engine-service/engineSupervisor.ts
src/engine-service/eventJournal.ts
src/engine-service/extensionOperationService.ts
src/engine-service/pollingWatcher.ts
src/engine-service/protocol.ts
src/engine-service/runtimeSecurity.ts
src/engine-service/stagedPayloadStore.ts
src/engine-service/stateMigration.ts
src/engine-service/tmuxAuthority.ts
src/engine-service/uiRequestBroker.ts
src/externalResolverEntry.ts
src/externalTools/events.ts
src/externalTools/filters.ts
src/externalTools/procScanner.ts
src/externalTools/registry.ts
src/externalTools/types.ts
src/handoff/ProjectHandoffStore.ts
src/handoff/distill.ts
src/handoff/handoffDistillService.ts
src/handoff/handoffFileService.ts
src/handoff/handoffPath.ts
src/harness/HarnessManager.ts
src/host-action/audit.ts
src/host-action/broker.ts
src/host-action/capability.ts
src/host-action/externalPolicy.ts
src/host-action/index.ts
src/host-action/noopAdapter.ts
src/host-action/policy.ts
src/host-action/port.ts
src/host-action/reloadTransaction.ts
src/host-action/types.ts
src/host/hostResources.ts
src/host/vitestBudget.ts
src/humanInbox/artifacts.ts
src/humanInbox/deepLink.ts
src/humanInbox/loadArtifact.ts
src/humanInbox/model.ts
src/ide-browser/client.ts
src/ide-browser/protocol.ts
src/ide-browser/settings.ts
src/init/initLogic.ts
src/inspector/classify.ts
src/inspector/model.ts
src/locks/processLock.ts
src/memory/domain.ts
src/pi-bridge-extension/index.ts
src/pi-bridge-extension/toolProjection.ts
src/pins/PinAttachmentStore.ts
src/pins/PinStore.ts
src/pins/pinStudioModel.ts
src/pins/pinStudioService.ts
src/pins/types.ts
src/pipeline/PipelineManager.ts
src/pipeline/RunLedger.ts
src/pipeline/completeNode.ts
src/pipeline/doneContract.ts
src/pipeline/loadPipeline.ts
src/pipeline/nodePrompt.ts
src/pipeline/pipelineDriver.ts
src/pipeline/preflight.ts
src/pipeline/runState.ts
src/pluginValidateEntry.ts
src/plugins/adapters/claude.ts
src/plugins/adapters/codex.ts
src/plugins/adapters/grok.ts
src/plugins/adapters/hooks.ts
src/plugins/agentHookProjection.ts
src/plugins/appliedState.ts
src/plugins/consentViewModel.ts
src/plugins/dataLauncher.ts
src/plugins/dataPlan.ts
src/plugins/engine.ts
src/plugins/entryHtmlValidator.ts
src/plugins/externalTool.ts
src/plugins/fetcher.ts
src/plugins/fsx.ts
src/plugins/gitHookRegistry.ts
src/plugins/gitHookState.ts
src/plugins/gitRepo.ts
src/plugins/i18nPtbrGate.ts
src/plugins/lockfile.ts
src/plugins/manifest.ts
src/plugins/mcp.ts
src/plugins/mcpConfig.ts
src/plugins/paths.ts
src/plugins/pluginDeps.ts
src/plugins/projectedInputs.ts
src/plugins/skill.ts
src/plugins/source.ts
src/plugins/toolLauncher.ts
src/plugins/toolPlaceholder.ts
src/plugins/toolPlan.ts
src/plugins/toolPlatform.ts
src/plugins/toolProvisionRun.ts
src/plugins/toolProvisioning.ts
src/plugins/toolTransaction.ts
src/plugins/ui/broker.ts
src/plugins/ui/messages.ts
src/plugins/ui/projectionBuilder.ts
src/plugins/ui/projectionProvider.ts
src/plugins/ui/projectionTypes.ts
src/plugins/viewModel.ts
src/plugins/worktreeProjection.ts
src/presentation/agentPaneFont.ts
src/presentation/contextValue.ts
src/presentation/foreignTmuxClient.ts
src/presentation/items.ts
src/presentation/sessionViewport.ts
src/probe/ProbeRunner.ts
src/probe/ProbeService.ts
src/probe/ProbeStore.ts
src/probe/adapters/claude.ts
src/probe/adapters/codex.ts
src/probe/adapters/codexSessionEvidence.ts
src/probe/adapters/grok.ts
src/probe/adapters/types.ts
src/probe/archetypes.ts
src/probe/modelProof.ts
src/probe/probeView.ts
src/probe/taxonomy.ts
src/prompts/PromptStore.ts
src/prompts/injectFlow.ts
src/provenance/record.ts
src/provenance/verify.ts
src/registration/adapters.ts
src/resume/SessionLedger.ts
src/resume/adapters.ts
src/resume/planResume.ts
src/resume/resolvers.ts
src/richDoc/AttachmentStore.ts
src/richDoc/types.ts
src/runtime-api/activityProjection.ts
src/runtime-api/agentInputCommands.ts
src/runtime-api/boardCommands.ts
src/runtime-api/boardProjection.ts
src/runtime-api/extensionOperations.ts
src/runtime-api/handoffCommands.ts
src/runtime-api/handoffProjection.ts
src/runtime-api/pinStudioCommands.ts
src/runtime-api/pinStudioProjection.ts
src/runtime-api/richDocWire.ts
src/runtime-api/runtimeOpsProjection.ts
src/runtime-api/sidebarCommands.ts
src/runtime-api/sidebarProjection.ts
src/runtime-api/stagedPayload.ts
src/runtime-api/taskDetailCommands.ts
src/runtime-api/taskDetailProjection.ts
src/runtime-api/taskStudioCommands.ts
src/runtime-api/taskStudioProjection.ts
src/runtime-api/workspaceProjection.ts
src/runtime/adapters/claudeLaunchPreflight.ts
src/runtime/adapters/claudeMemory.ts
src/runtime/adapters/codexCatalogStream.ts
src/runtime/adapters/codexLaunchPreflight.ts
src/runtime/adapters/codexLaunchReadiness.ts
src/runtime/adapters/codexMemory.ts
src/runtime/adapters/grokLaunchPreflight.ts
src/runtime/adapters/grokMemory.ts
src/runtime/adapters/opencodeLaunchPreflight.ts
src/runtime/attestedRuntimes.ts
src/runtime/authRequired.ts
src/runtime/composerRegion.ts
src/runtime/defaultLaunchPreflight.ts
src/runtime/launchPreflight.ts
src/runtime/launchReadiness.ts
src/runtime/measuredCliVersions.ts
src/runtime/nativeLaneSuppression.ts
src/runtime/nativeMemory.ts
src/runtime/processIdentity.ts
src/runtime/runtimeProfile.ts
src/runtimeConfig/claudeInventory.ts
src/runtimeConfig/codexInventory.ts
src/runtimeConfig/grokInventory.ts
src/runtimeConfig/sourceLock.ts
src/runtimeConfig/types.ts
src/runtimeObservability/claudeStatusLineCapture.ts
src/runtimeObservability/claudeStatusLineSource.ts
src/runtimeObservability/codexAppServerSource.ts
src/runtimeObservability/grokInspectConfigSource.ts
src/runtimeObservability/preferences.ts
src/runtimeObservability/service.ts
src/runtimeObservability/source.ts
src/runtimeObservability/types.ts
src/runtimeObservability/validate.ts
src/runtimeOps/claudeSessionReader.ts
src/runtimeOps/codexSessionReader.ts
src/runtimeOps/collectSessionInspection.ts
src/runtimeOps/grokSessionReader.ts
src/runtimeOps/model.ts
src/runtimeOps/providerProjection.ts
src/runtimeOps/runtimeCondition.ts
src/runtimeOps/sessionInspection.ts
src/runtimeOps/sessionSources.ts
src/runtimeOps/snapshotService.ts
src/runtimeOps/types.ts
src/runtimeOps/workspaceLabels.ts
src/runtimeUsage/model.ts
src/schedule/ProposalStore.ts
src/schedule/Scheduler.ts
src/sections/model.ts
src/sections/resolveSection.ts
src/sections/route.ts
src/sessionContinuation/continueTask.ts
src/sessionContinuation/focusedHandoff.ts
src/shell/ActivityTarget.ts
src/shell/BoardTarget.ts
src/shell/ClientWorkspaceStudioTarget.ts
src/shell/FakeWorkspaceClient.ts
src/shell/HandoffTarget.ts
src/shell/PinStudioTarget.ts
src/shell/RuntimeOpsTarget.ts
src/shell/SidebarTarget.ts
src/shell/TaskDetailTarget.ts
src/shell/TaskStudioTarget.ts
src/shell/WorkspaceClient.ts
src/shell/WorkspaceClientRegistry.ts
src/shell/WorkspaceExtensionTarget.ts
src/shell/WorkspacePresentation.ts
src/shell/WorkspaceShellHandle.ts
src/sidebar/actions.ts
src/sidebar/agentFocus.ts
src/sidebar/agentModel.ts
src/sidebar/attentionStack.ts
src/sidebar/cardPreviewRows.ts
src/sidebar/cardTemplate.ts
src/sidebar/sidebarFleetService.ts
src/sidebar/sidebarMutationService.ts
src/sidebar/sortRows.ts
src/sidebar/types.ts
src/sidebar/wireText.ts
src/tasks/TaskAttachmentStore.ts
src/tasks/TaskAttemptStore.ts
src/tasks/TaskDetailStore.ts
src/tasks/TaskJournalStore.ts
src/tasks/TaskPrototypeStore.ts
src/tasks/TaskStore.ts
src/tasks/boardModel.ts
src/tasks/boardSnapshot.ts
src/tasks/docMarkdown.ts
src/tasks/listOrder.ts
src/tasks/markdownDoc.ts
src/tasks/nextTask.ts
src/tasks/prototypeHtmlPolicy.ts
src/tasks/rank.ts
src/tasks/reconcileLanded.ts
src/tasks/studioModel.ts
src/tasks/taskAuthoring.ts
src/tasks/taskNotificationPolicy.ts
src/tasks/taskPrototypeReview.ts
src/tasks/taskStudioService.ts
src/tasks/types.ts
src/tmux/ControlModeClient.ts
src/tmux/TmuxService.ts
src/tmux/clipboard.ts
src/tmux/sessionSweep.ts
src/tmux/wedgeWatchdog.ts
src/toolLauncherEntry.ts
src/validations/ValidationStore.ts
src/validations/discovery.ts
src/validations/nextValidation.ts
src/validations/types.ts
src/validations/validationCloseNotify.ts
src/webview/AgentStudioAdapter.ts
src/webview/CommandStudioAdapter.ts
src/webview/PinStudioAdapter.ts
src/webview/PinStudioPanel.ts
src/webview/RunbookStudioAdapter.ts
src/webview/ScheduleStudioAdapter.ts
src/webview/ServerInspector.ts
src/webview/TaskStudioAdapter.ts
src/webview/TaskStudioPanel.ts
src/webview/TerminalStudioAdapter.ts
src/webview/activity/App.tsx
src/webview/activity/activityFeed.ts
src/webview/activity/feedModel.ts
src/webview/activity/katex-entry.ts
src/webview/activity/main.tsx
src/webview/activity/markdown.tsx
src/webview/activity/markdownEngine.ts
src/webview/activity/markdownSanitizeConfig.ts
src/webview/activity/mermaid-entry.ts
src/webview/activity/mermaidViewport.ts
src/webview/activity/messages.ts
src/webview/agent-pane/App.tsx
src/webview/agent-pane/geometry.ts
src/webview/agent-pane/main.tsx
src/webview/agent-pane/protocol.ts
src/webview/agent-pane/terminalTheme.ts
src/webview/agent-studio-fixture/App.tsx
src/webview/agent-studio-fixture/main.tsx
src/webview/agent-studio-fixture/messages.ts
src/webview/agent-studio-fixture/types.ts
src/webview/agent-studio-shell/App.tsx
src/webview/agent-studio-shell/ForgetPlanView.tsx
src/webview/agent-studio-shell/domain.ts
src/webview/agent-studio-shell/main.tsx
src/webview/agent-studio-shell/messages.ts
src/webview/agent-studio-shell/runtimeLogos.tsx
src/webview/agent-studio-shell/types.ts
src/webview/agentPaneDelivery.ts
src/webview/approval/App.tsx
src/webview/approval/messages.ts
src/webview/approval/viewModel.ts
src/webview/board/App.tsx
src/webview/board/boardVm.ts
src/webview/board/interactions.ts
src/webview/board/main.tsx
src/webview/board/messages.ts
src/webview/chat-bridge/ops.ts
src/webview/chat-bridge/parse.ts
src/webview/cliDetect.ts
src/webview/command-studio-shell/App.tsx
src/webview/command-studio-shell/domain.ts
src/webview/command-studio-shell/main.tsx
src/webview/command-studio-shell/messages.ts
src/webview/command-studio-shell/types.ts
src/webview/design-mode-overlay/App.tsx
src/webview/design-mode-overlay/main.tsx
src/webview/design-mode-overlay/styles.ts
src/webview/formLogic.ts
src/webview/handoff/App.tsx
src/webview/handoff/handoffViewModel.ts
src/webview/handoff/main.tsx
src/webview/handoff/messages.ts
src/webview/human-inbox/App.tsx
src/webview/human-inbox/main.tsx
src/webview/human-inbox/messages.ts
src/webview/human-inbox/viewModel.ts
src/webview/ide-browser-bridge/homeUrl.ts
src/webview/ide-browser-bridge/hostServer.ts
src/webview/ide-browser-bridge/pick.ts
src/webview/inspector/App.tsx
src/webview/inspector/main.tsx
src/webview/inspector/messages.ts
src/webview/pin-preview/App.tsx
src/webview/pin-preview/editPolicy.ts
src/webview/pin-preview/main.tsx
src/webview/pin-preview/messages.ts
src/webview/pin-studio/App.tsx
src/webview/pin-studio/data-url.ts
src/webview/pin-studio/document.ts
src/webview/pin-studio/domain.ts
src/webview/pin-studio/excalidraw-entry.tsx
src/webview/pin-studio/messages.ts
src/webview/pin-studio/pinStudioDomain.ts
src/webview/pin-studio/tiptap.ts
src/webview/pin-studio/types.ts
src/webview/pipeline-studio/App.tsx
src/webview/pipeline-studio/domain.ts
src/webview/pipeline-studio/main.tsx
src/webview/pipeline-studio/messages.ts
src/webview/pipeline-studio/types.ts
src/webview/pipelineStudioAdapter.ts
src/webview/plugin-host/main.tsx
src/webview/plugin-host/relay.ts
src/webview/plugins/App.tsx
src/webview/plugins/consentViewAcks.ts
src/webview/plugins/listControls.ts
src/webview/plugins/main.tsx
src/webview/plugins/messages.ts
src/webview/probes/App.tsx
src/webview/probes/main.tsx
src/webview/probes/messages.ts
src/webview/rich-doc/ImageImportPicker.tsx
src/webview/rich-doc/StaticDoc.tsx
src/webview/rich-doc/VisualsPanel.tsx
src/webview/rich-doc/adapter.ts
src/webview/rich-doc/data-url.ts
src/webview/rich-doc/document.ts
src/webview/rich-doc/tiptap.ts
src/webview/rich-doc/toolbar.tsx
src/webview/rich-doc/types.ts
src/webview/runbook-studio-shell/App.tsx
src/webview/runbook-studio-shell/domain.ts
src/webview/runbook-studio-shell/main.tsx
src/webview/runbook-studio-shell/messages.ts
src/webview/runbook-studio-shell/types.ts
src/webview/runtime-config/App.tsx
src/webview/runtime-config/main.tsx
src/webview/runtime-config/messages.ts
src/webview/runtime-ops/App.tsx
src/webview/runtime-ops/main.tsx
src/webview/runtime-ops/messages.ts
src/webview/schedule-studio-shell/App.tsx
src/webview/schedule-studio-shell/domain.ts
src/webview/schedule-studio-shell/main.tsx
src/webview/schedule-studio-shell/messages.ts
src/webview/schedule-studio-shell/types.ts
src/webview/section-app-fixture/App.tsx
src/webview/section-app-fixture/main.tsx
src/webview/section-app-fixture/protocol.ts
src/webview/settings/main.tsx
src/webview/settings/messages.ts
src/webview/shared/ControlWorkspaceScope.ts
src/webview/shared/ErrorBoundary.tsx
src/webview/shared/PrototypePreview.tsx
src/webview/shared/agents/ContinuePicker.tsx
src/webview/shared/agents/continueTaskCandidates.ts
src/webview/shared/clientState.ts
src/webview/shared/control/CardTemplateBlock.tsx
src/webview/shared/control/EngineLogPanel.tsx
src/webview/shared/control/cardTemplateEditor.ts
src/webview/shared/control/messages.ts
src/webview/shared/lazySectionStyles.ts
src/webview/shared/panelWorkGate.ts
src/webview/shared/ready.ts
src/webview/shared/shell.ts
src/webview/shared/studio/StudioFrame.tsx
src/webview/shared/studio/StudioLoadError.tsx
src/webview/shared/studio/StudioTombstone.tsx
src/webview/shared/studio/adapter.ts
src/webview/shared/studio/dirtyGating.ts
src/webview/shared/studio/errorTaxonomy.ts
src/webview/shared/studio/protocol.ts
src/webview/shared/studio/restoreDecisions.ts
src/webview/shared/studio/singleModeEditPolicy.ts
src/webview/shared/studio/singleModeStudioMain.tsx
src/webview/shared/studio/studioFreezeBus.ts
src/webview/shared/studio/studioIds.ts
src/webview/shared/studio/studioLoadErrorTitle.ts
src/webview/shared/studio/tombstone.ts
src/webview/shared/studio/useStudioFreeze.ts
src/webview/shared/ui/Button.tsx
src/webview/shared/ui/Chip.tsx
src/webview/shared/ui/ConfirmForm.tsx
src/webview/shared/ui/Field.tsx
src/webview/shared/ui/Icon.tsx
src/webview/shared/ui/IconButton.tsx
src/webview/shared/ui/QuickPicker.tsx
src/webview/shared/ui/Tabs.tsx
src/webview/shared/ui/Toast.tsx
src/webview/shared/ui/cx.ts
src/webview/shared/ui/index.ts
src/webview/shared/ui/kit/KitDropdown.tsx
src/webview/shared/ui/kit/KitFieldRow.tsx
src/webview/shared/ui/kit/KitFilePicker.tsx
src/webview/shared/ui/kit/KitLabeledInput.tsx
src/webview/shared/ui/kit/KitPopover.tsx
src/webview/shared/ui/kit/KitSelect.tsx
src/webview/shared/ui/kit/flags.ts
src/webview/shared/ui/kit/index.ts
src/webview/shared/ui/patterns.tsx
src/webview/shared/ui/vendor/dialog.tsx
src/webview/shared/ui/vendor/dropdown-menu.tsx
src/webview/shared/ui/vendor/lib/utils.ts
src/webview/shared/ui/vendor/popover.tsx
src/webview/shared/ui/vendor/select.tsx
src/webview/shared/ui/vendor/tooltip.tsx
src/webview/shared/untrustedSrcdoc.ts
src/webview/sidebar/App.tsx
src/webview/sidebar/agentStatusFilter.ts
src/webview/sidebar/grouping.ts
src/webview/sidebar/main.tsx
src/webview/sidebar/menuPosition.ts
src/webview/sidebar/messages.ts
src/webview/sidebar/sectionNav.ts
src/webview/sidebar/studioFolders.ts
src/webview/studioSubmit.ts
src/webview/surfaces.ts
src/webview/system/App.tsx
src/webview/system/main.tsx
src/webview/system/messages.ts
src/webview/system/summary.ts
src/webview/task-detail/App.tsx
src/webview/task-detail/editPolicy.ts
src/webview/task-detail/interactions.ts
src/webview/task-detail/main.tsx
src/webview/task-detail/messages.ts
src/webview/task-detail/refDisplay.ts
src/webview/task-detail/taskDetailVm.ts
src/webview/task-prototype/types.ts
src/webview/task-studio/App.tsx
src/webview/task-studio/domain.ts
src/webview/task-studio/messages.ts
src/webview/task-studio/types.ts
src/webview/terminal-studio-shell/App.tsx
src/webview/terminal-studio-shell/domain.ts
src/webview/terminal-studio-shell/main.tsx
src/webview/terminal-studio-shell/messages.ts
src/webview/terminal-studio-shell/types.ts
src/webview/ui-gate/gatePage.ts
src/webview/ui-gate/main.tsx
src/webview/ui-gate/preflightFixture.ts
src/webview/validations/App.tsx
src/webview/validations/messages.ts
src/webview/validations/viewModel.ts
src/webview/webviewApps.ts
src/webview/worktrees/App.tsx
src/webview/worktrees/main.tsx
src/webview/worktrees/messages.ts
src/workspace/DaemonEngineHost.ts
src/workspace/EngineHost.ts
src/workspace/GatedCompletionMonitor.ts
src/workspace/NotificationService.ts
src/workspace/RuntimeSlackMonitor.ts
src/workspace/TaskNotificationService.ts
src/workspace/TemporaryBackstopMonitor.ts
src/workspace/TerminalPresentation.ts
src/workspace/Workspace.ts
src/workspace/authRequiredNotice.ts
src/workspace/bridgeSlowRequestPolicy.ts
src/workspace/doctorReport.ts
src/workspace/domainActions.ts
src/workspace/noticeInbox.ts
src/workspace/opencodeStorage.ts
src/workspace/operationalStateKeys.ts
src/workspace/surfacePreservation.ts
src/workspace/verifyRecordReader.ts
src/workspace/workspaceFolderOps.ts
src/worktree/ManagedWorktreeService.ts
src/worktree/WorktreeManager.ts
src/worktree/agentTouchedFiles.ts
src/worktree/classify.ts
src/worktree/dependencySharing.ts
src/worktree/evidence.ts
src/worktree/evidenceArtifacts.ts
src/worktree/gitBinary.ts
src/worktree/hygieneAuthority.ts
src/worktree/land.ts
src/worktree/landAct.ts
src/worktree/managedWorktree.ts
src/worktree/orphanProcessHygiene.ts
src/worktree/parentLocation.ts
src/worktree/pr.ts
src/worktree/review.ts
```

## Apêndice B — interseção engine/browser (32 arquivos)

```text
src/agents/agentRuntimeAdmission.ts
src/agents/runtimePromptAdapters.ts
src/anchor/compaction.ts
src/attention/AttentionMonitor.ts
src/attention/manifestEngine.ts
src/attention/manifests.ts
src/attention/patterns.ts
src/config/agentForgetPlan.ts
src/config/agentInstructionsDocument.ts
src/config/agentNativeConfigPolicy.ts
src/config/agentNativeConfigSchema.ts
src/config/agentProfileRefusal.ts
src/config/agentProfileStudio.ts
src/config/agentWorkspaceCommands.ts
src/config/globalSettingsDocument.ts
src/handoff/distill.ts
src/pins/pinStudioModel.ts
src/presentation/foreignTmuxClient.ts
src/resume/adapters.ts
src/runtime/attestedRuntimes.ts
src/runtime/authRequired.ts
src/runtime/composerRegion.ts
src/runtime/launchPreflight.ts
src/runtime/runtimeProfile.ts
src/sidebar/cardTemplate.ts
src/sidebar/types.ts
src/tasks/docMarkdown.ts
src/tasks/nextTask.ts
src/tasks/rank.ts
src/tasks/types.ts
src/webview/shared/untrustedSrcdoc.ts
src/workspace/TemporaryBackstopMonitor.ts
```
