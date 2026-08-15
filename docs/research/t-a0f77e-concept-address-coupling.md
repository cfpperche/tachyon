# Acoplamento pelo endereço do conceito depois das SDDs 506 e 507

Medição de `t-a0f77e` sobre `f0683a6c`, em 2026-08-15. Esta é uma auditoria; não muda código nem propõe, pelo nome, pacote novo.

## Pergunta e régua

Um ponto conta quando satisfaz as três condições abaixo:

1. o símbolo descreve vocabulário ou uma decisão que continuaria necessária se a implementação que hoje o hospeda fosse substituída;
2. pelo menos duas camadas de responsabilidade importam esse símbolo;
3. o endereço importado é um arquivo de implementação/transporte, de modo que substituir ou dividir esse arquivo obriga consumidores que não deveriam conhecer a troca a mudar.

“Camada” nesta medição é o primeiro diretório de responsabilidade dentro de cada workspace (por exemplo, `engine/config`, `engine/workspace`, `bridge/tools`, `webview-ui/webview` e `apps/vscode-extension/shell`). O arquivo solto `extension.ts` conta como a raiz da aplicação. A divisão não pretende provar arquitetura por nome: ela apenas torna verificável que os consumidores pertencem a responsabilidades diferentes. A classificação final foi feita pelo símbolo e por como cada consumidor o usa.

Para encontrar candidatos, percorri os 794 arquivos TypeScript/TSX de `packages/{bridge,engine,shared,webview-ui}/src` e `apps/vscode-extension/src` com a AST do TypeScript. Cada aresta é um *binding* estaticamente nomeado em `import` ou `export`; imports `type` contam, ocorrências lexicais, testes, docs, imports dinâmicos e `export *` não. A resolução relativa e as extensões candidatas vieram de `resolveSource` em `scripts/research/monorepo-imports.mjs`; aliases `@tachyon/<workspace>/...` foram convertidos ao arquivo do workspace e submetidos ao mesmo resolvedor. Agrupei por `(arquivo resolvido, símbolo)`, contei bindings, arquivos consumidores e camadas, e só então li definição e usos dos candidatos. O universo teve 5.908 bindings e 694 candidatos com duas ou mais camadas; tamanho/frequência serviram para ordenar a leitura, não para classificar a natureza.

Dois controles impedem repetir os erros que motivaram a task:

- `node scripts/research/measure-engine-bridge-imports.mjs` mede **0 bindings, 0 imports e 0 consumidores** de engine para bridge nesta árvore. Portanto, os números antigos da task (anteriores à fatia final) não foram reutilizados: a SDD 507 realmente zerou essa direção.
- `node scripts/research/measure-monorepo-graph.mjs` resolveu 1.778 de 1.781 especificadores relativos; os três restantes são os JSONs de manifesto que a própria régua declara fora do grafo TS/CJS. Não houve resolução de workspace ausente a contornar.

Os números abaixo somam bindings dos símbolos explicitamente listados. “Arquivos” e “camadas” são uniões, não somas, para não inflar consumidores que importam mais de um símbolo do mesmo endereço.

## Achados, por dano

### 1. O vocabulário de configuração tem o endereço do carregador YAML

Endereço atual: `packages/engine/src/config/loadConfig.ts` (2.080 linhas).

| Símbolos classificados | Bindings | Arquivos | Camadas |
|---|---:|---:|---:|
| `TachyonConfig`, `AgentDef`, `AgentEntry`, `ScheduleDef`, `EntryKind`, `asAgent` | 51 | 34 | 16 |

As 16 camadas são cinco da aplicação (`extension.ts`, `presentation`, `runtimeConfig`, `shell`, `webview`), `bridge/tools` e dez da engine (`agents`, `commands`, `config`, `resume`, `runtime-api`, `schedule`, `sidebar`, `webview`, `workspace`, `worktree`). O maior símbolo isolado é `TachyonConfig` (14 bindings/14 arquivos/8 camadas); `asAgent` chega a 11/11/10.

Esses símbolos não descrevem “ler YAML”: descrevem as entidades configuradas e o estreitamento Agent/Terminal que agentes, scheduler, worktree, UI e bridge usam depois do parse. `EntryKind` já mora canonicamente em `@tachyon/shared/config/entry`, mas nove consumidores em seis camadas ainda o alcançam pelo re-export do loader. O endereço, não o tipo, continua errado.

**Dano concreto:** trocar YAML por outra origem, dividir o parser de 2.080 linhas ou apenas retirar o re-export de compatibilidade exige editar até 34 consumidores que não fazem parsing. A bridge também precisa importar a implementação de carregamento para nomear `ScheduleDef` e chamar `asAgent`; um transporte alternativo repetiria essa dependência ou teria de conhecer a gaveta atual.

### 2. O vocabulário da instância tem o endereço do ledger JSON

Endereço atual: `packages/engine/src/resume/SessionLedger.ts` (614 linhas).

| Símbolos classificados | Bindings | Arquivos | Camadas |
|---|---:|---:|---:|
| `SessionRecord`, `isResumable`, `durableBoundGeneration`, `AgentInstanceLifetime`, `AgentInstancePolicy`, `AgentInstanceResumePolicy` | 31 | 21 | 16 |

As camadas incluem `bridge/clientRebind`, duas áreas da UI, três da aplicação e dez responsabilidades da engine. `SessionRecord` sozinho é 9 bindings/9 arquivos/8 camadas; `isResumable`, 8/8/7. Os três `AgentInstance*` já têm dono canônico em `@tachyon/shared/resume/agentInstance`, mas são importados por UI, aplicação e engine através do re-export de `SessionLedger.ts` (12 bindings em 12 arquivos na soma desses três símbolos).

O registro, sua política de vida/reinício e a resposta “esta instância pode retomar?” sobrevivem à substituição do armazenamento JSON por outro ledger. A classe que lê/escreve `.tachyon/sessions.json` não.

**Dano concreto:** mudar a persistência ou decompor o ledger alcança bridge rebind, projeções/UI, diagnóstico, sidebar e gerenciamento de agentes. Em particular, duas camadas de UI conhecem `SessionLedger.ts` apenas para nomear políticas que já vivem em `shared`; o transporte de rebind conhece o mesmo arquivo para `SessionRecord` e `durableBoundGeneration`. A troca de armazenamento, portanto, vaza para consumidores sem autoridade sobre persistência.

### 3. A linha de roster compartilhada ainda é endereçada pela classe `AgentManager`

Endereço importado: `packages/engine/src/agents/AgentManager.ts`; dono real: `packages/shared/src/agents/managedEntry.ts`.

| Símbolo | Bindings | Arquivos | Camadas |
|---|---:|---:|---:|
| `ManagedEntryInfo` | 7 | 7 | 5 |

Os consumidores estão em `engine/agents`, `handoff`, `runtime-api`, `runtimeOps` e `workspace`. Todos importam o re-export da classe `AgentManager`, embora a interface já tenha sido extraída para `shared`.

**Dano concreto:** dividir/substituir `AgentManager` ou remover sua fachada de compatibilidade obriga cinco camadas que só precisam da linha de roster a mudar. É a mesma forma do caso que originou esta avaliação: o conceito correto existe, mas sete arquivos continuam chegando a ele pelo endereço de uma implementação grande.

### 4. O registro persistido de worktree mora dentro do gerenciador Git

Endereço atual: `packages/engine/src/worktree/WorktreeManager.ts` (1.490 linhas).

| Símbolo | Bindings | Arquivos | Camadas |
|---|---:|---:|---:|
| `WorktreeRecord` | 8 | 8 | 6 |

Os consumidores são a raiz da aplicação, `engine/agents`, `pipeline`, `resume`, `workspace` e `worktree`. O próprio comentário da interface a chama de “persisted source of truth”; ela viaja no `SessionRecord`, no estado de pipeline e nas portas de workspace. Isso é dado durável do domínio de checkout gerenciado, não comportamento de criar/remover worktree.

**Dano concreto:** decompor ou substituir `WorktreeManager` força mudanças no ledger e no pipeline, mesmo que o formato persistido continue igual. Inversamente, evoluir o registro durável obriga consumidores a importar um arquivo que também contém 1.490 linhas de operações Git, confundindo a autoridade sobre schema com a implementação que o executa.

### 5. A metadata compartilhada de aviso ainda atravessa a fila da engine

Endereço importado: `packages/engine/src/workspace/NoticeQueue.ts`; dono real: `packages/shared/src/bridge/noticeQueue.ts`.

| Símbolo | Bindings | Arquivos | Camadas |
|---|---:|---:|---:|
| `NoticeQueueMetadata` | 4 | 4 | 2 |

As camadas são `bridge/tools` e `engine/workspace`. O caso é pequeno, mas cruza exatamente a fronteira avaliada: `packages/bridge/src/tools/shared.ts` importa a metadata pelo re-export da fila concreta da engine, embora o contrato já esteja em `shared`.

**Dano concreto:** substituir `NoticeQueue` preservando o contrato de metadata ainda exige editar o transporte bridge. Esse é o único achado aqui em que o transporte conhece diretamente a implementação que carrega um conceito já extraído. Pelo tamanho (4/4/2), fica abaixo dos quatro anteriores; não justifica sozinho qualquer pacote ou mecanismo.

## O que não vale mexer nesta avaliação

- **A direção engine → bridge:** está em 0/0/0 na régua existente. Não há resíduo para “terminar” por gosto; reabrir a extração da SDD 507 sem uma aresta medida seria fabricar trabalho.
- **Imports de serviços concretos** como `AgentManager`, `TaskStore`, `PinStore`, `ProjectHandoffStore`, `ValidationStore` e `TmuxService`: seus consumidores pedem comportamento/estado dessas implementações, não apenas vocabulário independente. Trocar o serviço naturalmente troca a composição; o critério desta auditoria não é “muitos imports”.
- **Vocabulário próprio de tmux/Git**, como `PaneSnapshot`, `SOCKET_NAME`, `workspaceHash`, `GitExec`, `WorktreeStatus` e `WorktreeRemovalResult`: ele desaparece ou muda junto com a implementação. `WorktreeRecord` entrou acima apenas porque é explicitamente persistido e consumido fora da operação Git.
- **Contratos de webview** (`messages.ts`, ações, bootstrap e modelos de tela): host e browser são as duas pontas do mesmo transporte. Duas camadas precisarem do protocolo é a razão correta para ele existir, não evidência de endereço errado.
- **Os conceitos já importados diretamente de `@tachyon/shared/...`:** `Task`, `ArtifactRef`, `AgentVM`, `TiptapJSON`, adapters de runtime e afins têm muitos consumidores porque `shared` é o endereço deliberado de contratos portáveis. Contagem alta sem implementação indevida não é achado.
- **Re-exports com alcance baixo e sem custo de troca demonstrado** (`ConfigDiscardsVM`, aliases de attachment e outros túneis de uma única responsabilidade): são dívida estética possível, mas não mostraram múltiplas camadas indevidamente presas a uma troca. A régua pede dano, não uma lista de tudo que poderia ter outro nome.
- **Criar outro workspace/pacote agora:** os cinco números medem endereços, não uma coesão nova. Um pacote para “tipos restantes” codificaria ausência de dono como API. Cada cartão deve primeiro escolher o dono conceitual do seu conjunto; os achados 3 e 5 inclusive já têm dono canônico e pedem, no máximo, corrigir endereços.

## Conclusão

A hipótese histórica sobre engine depender de bridge foi refutada na árvore atual: a direção está zerada. O acoplamento relevante que sobrou tem outra forma, mensurável: duas gavetas de implementação ainda são endereços públicos de vocabulário (`loadConfig.ts` e `SessionLedger.ts`), duas classes/filas mantêm túneis de compatibilidade para conceitos já extraídos (`ManagedEntryInfo` e `NoticeQueueMetadata`), e um schema persistido (`WorktreeRecord`) continua dentro do executor Git. A ordem acima segue o alcance e o custo concreto de substituição, não a facilidade de mover uma linha.
