# t-73b2e1 — mapa medido de acoplamento core → plugins

Data da medição: 2026-08-09. Árvore: `eda5eb033c967b581bbbac23c702e90b56121633` (antes deste relatório).

## Conclusão

A premissa se confirma: SDD é o único dos 15 plugins instalados cujo formato e política entram no comportamento do produto. Tachyon não apenas conserva um `artifact_ref` opaco: lê arquivos do workflow SDD, interpreta seu formato, projeta seu vocabulário até as webviews, muda a seleção de trabalho e recusa mutações de Task com base no status encontrado.

O menor desacoplamento coerente não exige registro de provedores, barramento ou API genérica. O vínculo persistido pode continuar existindo como `artifact_refs: [{type: "sdd", ...}]`, porque `type` já é string extensível e opaca. O que deve desaparecer é toda interpretação desse valor pelo core.

## Método e contagem

- Busca base reproduzível: `rg -n -i '\bsdd\b' src --glob '*.{ts,tsx,js,mjs,json}'`.
- Resultado atual: **687 linhas**.
- Classificação manual por contexto: **622 linhas de comentário/proveniência** e **65 linhas de código, schema ou apresentação**. As 622 citações históricas (`SDD 4xx`, `spec 4xx`) não são acoplamento, explicam decisões e devem ficar.
- A diferença de uma linha para a medição registrada na Task (686) é mudança da árvore desde aquela medição; a separação relevante permanece 622/65.
- A busca foi ampliada a `package.json`, bundles l10n, `src/config/tachyon.schema.json`, runtime-api, projeções, tipos compartilhados e webviews. `package.json` e l10n não declaram comportamento SDD. A descrição do schema em `tachyon.schema.json:451` é apenas proveniência de SDD 422.
- Para evitar falsos positivos, nomes em strings/comentários históricos (por exemplo mensagens que citam “SDD 420”) foram contados como código na separação lexical quando aplicável, mas não classificados abaixo como acoplamento. A lista abaixo é a autoridade sobre acoplamento real.

## Acoplamentos reais classificados

### (a) O core lê arquivo do plugin

- `src/tasks/TaskStore.ts:631-652,1029-1054` — resolve refs contra `docs/specs/`, conhece `spec.md`, procura o diretório numérico por prefixo, percorre worktrees gerenciadas, lê o Markdown e extrai status. A falha de leitura é convertida em “missing”/status ausente.
- `src/validations/discovery.ts:25,37-54` — sempre varre `docs/specs/*/tasks.md` e transforma linhas com vocabulário de validação em candidatos cujo `source_ref.type` é `sdd`. Este ponto não constava da medição inicial e confirma que a fronteira vai além de TaskStore/nextTask/projeções.

### (b) O core conhece o formato ou vocabulário do plugin

- `src/tasks/TaskStore.ts:88,91-92,622-652,675-676,1020-1054` — batch/cache chamado SDD, enum de sete statuses, convenções de caminho, heading `**Status:**`, derived stage, missing/status e atenções SDD.
- `src/tasks/types.ts:104-121` — tipos `SddStatus`, `SddDerivedStage`, `TaskDerived.sdd` e códigos de atenção `missing_sdd_spec`/`sdd_needs_retriage`.
- `src/runtime-api/boardProjection.ts:7,21-23,298-318` — duplica o enum e valida a projeção estrita `derived.sdd`, inclusive `type: "sdd"`.
- `src/runtime-api/taskDetailProjection.ts:43-53` — schema Zod duplica o objeto, os sete statuses e os códigos de atenção SDD.
- `src/tasks/boardModel.ts:3,67-69,200-213` — converte o derived stage em campos de card `sddRef`, `sddStatus`, `sddMissing`.
- `src/webview/board/App.tsx:540-541` e `src/webview/task-detail/App.tsx:165-168` — apresentam badges e seção SDD específicos.
- `src/bridge/tools/tasks.ts:25` e `src/tasks/taskAuthoring.ts:51` — o contrato/ajuda do core privilegia `type:'sdd'` e promete enrichment local.
- `src/validations/discovery.ts:37-54` — além de ler arquivo, conhece `tasks.md`, checkbox/linha de tarefa e emite o tipo SDD.

### (c) O core executa a política do plugin

- `src/tasks/TaskStore.ts:322-323,655-676` — recusa `status: done` salvo `shipped`; também restringe quando uma referência SDD pode ser criada, removida ou trocada. O guarda falha aberto: status ausente/desconhecido permite fechar.
- `src/tasks/TaskStore.ts:1020-1025` — produz atenções e retriagem a partir dos statuses SDD; `shipped` muda o aviso de fechamento.
- `src/tasks/nextTask.ts:16-17,45-59` — `shipped`, statuses de retriagem e statuses “actionable” removem Tasks da fila de trabalho ou alteram sua atenção.

Categoria (c) é o começo obrigatório: ela altera Task e fila mesmo quando SDD não está instalado. (a) e (b) sustentam essa política e a apresentam; removê-las depois evita manter uma meia-integração enganosa.

## Os outros 14 plugins

Plugins instalados medidos em `/home/goat/tachyon/.tachyon/plugins`: `agent-browser`, `audio`, `dep-audit`, `diagram`, `hyperframes`, `image`, `product-foundation`, `secrets-guard`, `sound`, `terrarium`, `transcribe`, `verify-gate`, `video`, `visual-qa` (mais `sdd` = 15).

**Confirmado: os outros 14 estão limpos segundo (a)/(b)/(c).** `audio`, `dep-audit`, `hyperframes`, `terrarium` não aparecem em `src` pelo nome; `image`, `sound`, `video`, `diagram` e `transcribe` são palavras genéricas ou citações sem identidade/política de plugin; `product-foundation`, `verify-gate` e `visual-qa` aparecem apenas em comentário/descrição; `secrets-guard` aparece como exemplo documental de uma configuração genérica de hooks e em comentários. `agent-browser` aparece em comentários e em `src/externalTools/types.ts:2` como valor opaco de proveniência de ferramenta externa. Esse último deve **ficar**: identifica a origem observada sem ler arquivo, conhecer formato ou executar política do plugin; removê-lo perderia atribuição real e não ajudaria Tachyon a funcionar sem o plugin.

## Estado do Board

Leitura paginada de todas as **1.290 Tasks** via `list_tasks(fields:"full")`: **271 Tasks** têm ao menos um `artifact_ref.type === "sdd"`. Destas, **20 estão abertas** (11 inbox, 9 triaged, 0 active/landed), 232 done e 19 dropped. Há 70 Tasks com ao menos um vínculo SDD `deliverable`; 216 com ao menos um vínculo SDD não-deliverable (as categorias se sobrepõem).

Depois do desacoplamento, **o vínculo não some**: as 271 Tasks continuam apontando para as mesmas refs opacas em `artifact_refs`, inclusive role. Somem apenas `derived.sdd`, leitura/status/missing, badges/atenções SDD e efeitos na fila/mutação. Assim não há migração destrutiva e nenhum histórico é reescrito. Se o plugin quiser mostrar ou validar a spec, faz isso por suas próprias skills/comandos, fora do TaskStore.

## Proposta em três passos

1. Remover primeiro toda política SDD do caminho de mutação e seleção (`assertSdd*`, atenções derivadas e branches de `nextTask`); provar que uma Task fecha e é selecionável sem plugin e sem `docs/specs/`, preservando seus `artifact_refs` byte a byte.
2. Remover leitura/derivação SDD do TaskStore e discovery de `docs/specs/*/tasks.md`; SDD continua responsável por seu próprio workflow, sem criar um novo mecanismo genérico porque nenhum segundo plugin precisa dele.
3. Apagar apenas o vocabulário derivado SDD de tipos, runtime-api, modelos e webviews; renderizar refs pela superfície genérica de artefatos existente. Manter citações históricas e a proveniência opaca `agent-browser`.

## Guarda contra o próximo acoplamento

### O grep ingênuo não é viável

A lista dinâmica dos 15 diretórios contém nomes comuns: `image`, `audio`, `video`, `sound` e `diagram`. Eles já aparecem legitimamente no core como tipos de anexo/nó Markdown, operações visuais e palavras inglesas. Procurar nomes como substrings faria o guarda falhar em código não relacionado; procurar só strings exatas ainda encontra valores legítimos como `type: "image"`. Um guarda assim seria ruído desde o primeiro dia.

A afirmação ampliada “SDD é o único nome de plugin no código” é, portanto, verdadeira apenas no sentido **plugin-específico**. Literalmente há também `agent-browser` em `src/externalTools/types.ts:2`, de propósito, e nomes comuns coincidentes. A busca confirmou que os três pontos citados pelo dono (`TaskStore.ts:623/626/628`, `taskDetailProjection.ts:45`, `types.ts:107`) são reais, mas não são exaustivos: há propriedades/símbolos SDD, projeções, UI e policy listados acima; `validations/discovery.ts:52` também emite `type: "sdd"`.

### Guarda proposto

Adicionar um teste de arquitetura, não um grep, com estas propriedades:

1. Descobrir os nomes em runtime enumerando os diretórios de `.tachyon/plugins/` (a instalação real), sem lista de plugins copiada no teste; limitar a busca a fontes de produção do core (`src/**/*.{ts,tsx,json}`), excluindo o próprio subsistema genérico de plugins apenas quando ele estiver tratando manifestos de forma opaca.
2. Tokenizar/parsear TypeScript/TSX/JSON e ignorar comments/JSDoc/JSX comments por construção. Normalizar identificadores (`SddStatus`, `sddStage`, `RETRIAGE_SDD`) em palavras para alcançar tanto literais quanto vocabulário de código; não usar substring para nomes comuns.
3. Comparar candidatos a uma allowlist pequena e revisável de **ocorrências semânticas**, cada entrada com arquivo, classe de nó e justificativa. A primeira exceção é `src/externalTools/types.ts:2`, literal `agent-browser`, porque é proveniência opaca observada. Coincidências genéricas (`image` como media type, por exemplo) precisam ser agrupadas por classe semântica estável, não centenas de linhas/line numbers. Qualquer nome novo ou uso novo sem justificativa falha e imprime plugin, arquivo, linha e nó.

O teste precisa provar o próprio vermelho com fixtures sintéticas, sem editar produção: (1) comentário `// SDD 410` passa; (2) config do dono fora de `src` passa; (3) `ref.type === "sdd"`, `z.literal("sdd")` e `interface SddStage` falham; (4) a exceção exata `agent-browser` passa, mas o mesmo literal num `if` de política falha; (5) um diretório de plugin sintético novo é descoberto sem mudar lista no teste. Assim a lista é dinâmica, a interpretação de falso positivo é explícita e o detector não depende da árvore que pretende vigiar.

Esse guarda é viável, mas a allowlist é parte do contrato: sem análise sintática e exceções semânticas, os plugins de nome comum o tornariam inutilizável.

## Portas a testar na implementação futura

- Interface → editar/fechar Task com ref SDD, com e sem diretório/plugin.
- Agent/Bridge → `update_task` e `reconcile_task` nas mesmas condições.
- Tachyon → `next_task`, snapshot Board, Task Detail e descoberta de validações sem plugin/diretório.
- Restart/resume/worktree alternativo → nenhuma busca de spec em outro checkout; refs persistidas permanecem idênticas.
- Guarda → fixtures sintéticas cobrem comentário, config fora do core, literal/propriedade/identificador proibidos, exceção de proveniência e descoberta automática de plugin novo.

Não rodei gate: esta rodada não altera produto, teste, configuração ou `tachyon.yml`; só adiciona este relatório.
