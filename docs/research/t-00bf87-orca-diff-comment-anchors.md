# Âncoras de comentários de diff: medição da Orca e recomendação para o Tachyon

Task: `t-00bf87`  
Medição: 2026-08-17  
Orca: clone somente em `/tmp/tachyon-t00bf87-orca`, revisão `a1cd7eaa7ed558f43312b8608a34181727b2a77c`  
VS Code: clone somente em `/tmp/tachyon-t00bf87-vscode`, revisão `da71f9583b692f815b533b88432d433afd66acf9`

## Resultado em uma frase

A Orca medida **não mantém uma âncora semântica através de revisões do diff**: ela persiste um UUID e uma coordenada `worktree + path + lado modified + linha`, depois recria a decoração nessa linha numérica. A movimentação que de fato existe no código é a do próprio modelo aberto do editor; para o Tachyon, a recomendação é usar `CommentController` para esse caso efêmero e persistir uma âncora própria, baseada no snapshot e reconciliada por diff, para sobreviver a reload, commit, amend e rebase.

## As cinco respostas medidas na Orca

### 1. Qual é a identidade de um comentário?

Um comentário recebe um UUID no renderer e guarda `worktreeId`, `filePath`, `lineNumber`, `side: 'modified'`, corpo e timestamps. Pode também guardar `startLine`; `scope`, `oldPath` e `diffIdentity` existem como campos opcionais, mas não participam da identidade observada. Não há blob SHA, hash de hunk, hash do conteúdo da linha nem coordenada no lado base.

Provas:

- O tipo persistido enumera UUID, worktree, path, linha e lado, e declara `diffIdentity` apenas como opcional: `/tmp/tachyon-t00bf87-orca/src/shared/diff-comment-types.ts:27-47`.
- O schema confirma a mesma forma: `/tmp/tachyon-t00bf87-orca/src/shared/diff-comment-schema.ts:3-18`.
- O UUID é criado no browser e adicionado ao registro no momento do save: `/tmp/tachyon-t00bf87-orca/src/renderer/src/store/slices/diffComments.ts:42-44` e `:401-407`.
- A criação no diff simples grava exatamente path, intervalo numérico e lado modified: `/tmp/tachyon-t00bf87-orca/src/renderer/src/components/editor/DiffViewer.tsx:234-261`. O diff combinado faz o mesmo: `/tmp/tachyon-t00bf87-orca/src/renderer/src/components/editor/diff-section-comment-submit.ts:47-60`.
- Busca exata por `diffIdentity` em todo `src/` encontrou somente o tipo e o schema acima: nenhum produtor, consumidor ou reconciliador em runtime.

Portanto, a identidade durável é o UUID; a localização é uma coordenada numérica no arquivo do worktree, lado modificado. O UUID não torna a localização estável.

### 2. O que ocorre quando o diff anda (novo commit, amend ou rebase)?

Não há migração medida. Ao renderizar, a Orca filtra por `worktreeId` e `filePath`, usa o UUID para manter a instância visual e cria a zona Monaco com `afterLineNumber: c.lineNumber`: `/tmp/tachyon-t00bf87-orca/src/renderer/src/components/diff-comments/useDiffCommentDecorator.tsx:132-139`, `:188-205` e `:214-248`. Quando o modelo é trocado, ela destrói as zonas e as recria, ainda a partir do número persistido: `:88-130`.

O slice de mutação só altera a lista por adicionar, editar corpo, marcar/enviar, apagar ou limpar; editar o corpo preserva a localização: `/tmp/tachyon-t00bf87-orca/src/renderer/src/store/slices/diffComments.ts:401-463` e `:465-567`. Uma busca por todos os usos de `clearDiffComments`/`clearDiffCommentsForFile` encontrou apenas ações explícitas de UI, não uma reação a Git: `/tmp/tachyon-t00bf87-orca/src/renderer/src/components/right-sidebar/source-control/notes/use-diff-comment-notes.ts:106-107` e `/tmp/tachyon-t00bf87-orca/src/renderer/src/components/editor/CombinedDiffViewer.tsx:1701`.

Assim, inserir ou remover linhas antes da âncora e depois recarregar o diff deixa o comentário no mesmo número, potencialmente sobre outro conteúdo. Commit, amend e rebase não têm algoritmo especial no caminho encontrado.

### 3. O que ocorre se a linha comentada for apagada?

O modelo da Orca não possui estado “órfão”, “outdated”, “resolvido” nem fallback para hunk. O tipo só oferece localização, corpo, envio e lado: `/tmp/tachyon-t00bf87-orca/src/shared/diff-comment-types.ts:27-47`. A decoração recebe o número salvo sem verificar conteúdo ou existência da linha: `/tmp/tachyon-t00bf87-orca/src/renderer/src/components/diff-comments/useDiffCommentDecorator.tsx:214-238`. O único desaparecimento automático de uma zona acontece quando o UUID deixa de existir na lista, isto é, quando o comentário foi removido da store: `:188-200`.

Logo, apagar a linha não resolve nem torna órfão o comentário no dado persistido. Ele continua pendente com a coordenada antiga; na próxima renderização, Monaco normaliza/posiciona a zona conforme o modelo disponível, mas a Orca não registra essa normalização como uma nova âncora. Não encontrei teste de linha apagada ou diff deslocado; procurei nos testes de `diffComments`, `useDiffCommentDecorator`, `DiffViewer` e `DiffSectionItem` por `shift`, `delete line`, `revis`, `model swap` e `afterLineNumber`.

### 4. Onde persiste e qual é o escopo?

Comentários locais ficam em `WorktreeMeta.diffComments`, portanto o escopo primário é o `worktreeId`, não branch nem `baseRef`: `/tmp/tachyon-t00bf87-orca/src/shared/worktree/meta-types.ts:55-80`. A própria definição explica que essa metadata é persistida; o arquivo do perfil é `<Electron userData>/orca-data.json`: `/tmp/tachyon-t00bf87-orca/src/main/persistence/loading-store/user-data-path.ts:8-26`.

O renderer persiste a lista inteira por worktree via `worktrees.updateMeta`; no caso de folder workspace, usa a identidade do folder workspace: `/tmp/tachyon-t00bf87-orca/src/renderer/src/store/slices/diffComments.ts:99-149`. Folder workspaces têm uma projeção top-level separada dentro do mesmo estado persistido: `/tmp/tachyon-t00bf87-orca/src/main/persistence/loading-store/store.ts:591-615` e `:1782-1792`.

Embora `scope` e `diffIdentity` existam opcionalmente no schema, os dois caminhos reais de criação de comentário de diff citados na resposta 1 não os preenchem. Portanto, na implementação medida, não há chave durável por branch/baseRef/diff.

### 5. Como o lote vira um prompt e como o agente alvo é escolhido?

Cada comentário vira três campos textuais (`File`, `Line`/`Lines`, `User comment`), com escaping do corpo; o lote é a concatenação desses blocos separados por uma linha vazia: `/tmp/tachyon-t00bf87-orca/src/shared/diff-comments-format.ts:7-33`. O menu seleciona somente notas ainda sem `sentAt`, monta um prompt para todas ou para o arquivo atual e entrega esse prompt como uma unidade: `/tmp/tachyon-t00bf87-orca/src/renderer/src/components/editor/DiffNotesSendMenu.tsx:54-82`.

Não há escolha automática de um único “dono”. O menu enumera agentes em execução daquele worktree a partir de status, tabs, layouts, PTYs vivos e títulos; o humano escolhe uma linha, ou inicia um agente novo: `/tmp/tachyon-t00bf87-orca/src/renderer/src/components/editor/ReviewNotesSendMenuContent.tsx:60-97` e `:147-209`. A derivação combina evidência de status com tabs que tenham PTY vivo e título reconhecido: `/tmp/tachyon-t00bf87-orca/src/renderer/src/lib/notes-send-agent-targets.ts:51-99` e `:111-145`. No clique, a coordenada explícita `{tabId, leafId}` é enviada junto com o prompt: `/tmp/tachyon-t00bf87-orca/src/renderer/src/components/editor/ReviewNotesSendMenuContent.tsx:147-177`; o transporte resolve esse terminal no host dono do worktree e faz envio guardado: `/tmp/tachyon-t00bf87-orca/src/renderer/src/lib/active-agent-note-send.ts:41-82` e `:257-264`.

## Controle negativo: documentação versus implementação

A documentação pública afirma que os comentários acompanham a linha quando o diff se desloca e permanecem fixos depois que o agente revisa. Essa é a afirmação a testar, não a prova: [Annotate AI Diff, linhas 75 e 85](https://www.onorca.dev/docs/review/annotate-ai-diff).

O código da revisão medida não implementa essa promessa entre snapshots do diff:

1. os dados persistidos não contêm conteúdo da linha, blob, hunk ou baseRef;
2. `diffIdentity` nunca é produzido nem consumido em `src/`;
3. a única coordenada usada para recriar a UI é `lineNumber`;
4. nenhuma mutação reage a refresh Git, commit, amend ou rebase;
5. não existe estado para linha apagada ou thread resolvida.

A leitura mais generosa é que uma decoração do editor pode acompanhar edições enquanto o mesmo modelo está aberto. Isso não equivale à promessa documental: a própria Orca usa uma `IViewZone` numérica, não persiste uma posição atualizada emitida por uma decoração, e destrói/recria as zonas em troca de modelo. Portanto, **nem mesmo a continuidade limitada à tela aberta está implementada de forma observável pela Orca** no caminho medido. O comportamento documentado não está sustentado pelo fonte desta revisão.

## O que `vscode.comments` dá de graça

A API pública fornece a superfície de comentários: `comments.createCommentController(id, label)`, `CommentController.createCommentThread(uri, range, comments)`, `CommentThread.range` mutável, estado resolved/unresolved, reply, ações e descarte. Ela diz que threads aparecem em editores visíveis e no painel Comments, mas não promete persistência nem reconciliação Git: [API `CommentThread` e `CommentController` na revisão medida](https://github.com/microsoft/vscode/blob/da71f9583b692f815b533b88432d433afd66acf9/src/vscode-dts/vscode.d.ts#L17527-L17595), [criação do controller/thread](https://github.com/microsoft/vscode/blob/da71f9583b692f815b533b88432d433afd66acf9/src/vscode-dts/vscode.d.ts#L17749-L17808).

Enquanto o documento/modelo está aberto, o VS Code dá uma vantagem real: o glyph da thread é uma decoração do modelo. Ao mudar de linha por uma edição, a decoração emite a nova linha; o widget desloca o range inteiro e escreve o novo `CommentThread.range`: `/tmp/tachyon-t00bf87-vscode/src/vs/workbench/contrib/comments/browser/commentGlyphWidget.ts:27-52`, `:65-77` e `/tmp/tachyon-t00bf87-vscode/src/vs/workbench/contrib/comments/browser/commentThreadZoneWidget.ts:420-432`. Como a implementação usa `collapseOnReplaceEdit: true`, substituir/apagar a linha colapsa a decoração no limite da edição em vez de criar uma semântica de órfão: `/tmp/tachyon-t00bf87-vscode/src/vs/workbench/contrib/comments/browser/commentGlyphWidget.ts:65-75`.

Isso é estado vivo do modelo. A extensão ainda é responsável por criar as threads e, se quiser conservá-las, serializar seu próprio dado. O range alterado é propagado de volta ao objeto da extensão e enviado pelo bridge da API quando o setter muda: `/tmp/tachyon-t00bf87-vscode/src/vs/workbench/api/common/extHostComments.ts:413-446`, `:459-480` e `:490-507`. A API não fornece:

- identidade durável do comentário;
- armazenamento entre reloads/restarts;
- blob SHA, commit, branch ou `baseRef`;
- migração através de troca de documento/modelo, commit, amend ou rebase;
- decisão semântica para linha apagada;
- batching, formatação de prompt ou escolha do agente.

## Uma recomendação para o Tachyon

Adotar **uma âncora híbrida snapshot + range rastreado**:

- Na UI aberta, criar uma `CommentThread` no URI do lado modificado e aceitar o `range` que o próprio VS Code move durante edições do documento.
- No registro durável, salvar uma identidade nossa (`commentId`, agente/worktree, `baseRef`, path, lado), a revisão do conteúdo observado (blob SHA quando houver; hash de snapshot para conteúdo não commitado), o range e um pequeno contexto normalizado antes/na/depois da seleção.
- Em cada porta que troca o snapshot — refresh do working tree, restart/resume, novo commit, amend ou rebase — reconciliar do snapshot salvo para o atual com um diff. Um mapeamento inequívoco atualiza o range; seleção removida ou correspondência ambígua vira explicitamente `outdated`, mantendo o texto e a última localização em vez de flutuar para uma linha qualquer.
- O lote entregue ao agente usa a localização reconciliada e inclui a marca `outdated` quando aplicável. O alvo continua sendo uma escolha explícita entre agentes do worktree; não inferir autoria a partir da âncora.

Essa é uma só estratégia: o range nativo resolve com custo quase zero a edição aberta, enquanto o snapshot/contexto cobre exatamente a fronteira que a API não cobre.

**Tradeoff nomeado — precisão versus armazenamento/reconciliação.** Guardar snapshot/contexto e executar um diff custa mais que persistir apenas `path + line`, e renames ou duplicação de blocos ainda podem produzir ambiguidade. Em troca, o mecanismo nunca finge precisão: deslocamentos mecânicos migram, deleções ficam `outdated`, e casos ambíguos pedem decisão humana. Hash apenas da linha seria mais barato, mas falha em linhas repetidas; blob + offset seria determinístico, mas não migraria. O híbrido é o menor mecanismo que satisfaz continuidade durável sem transformar uma heurística em verdade.

## Casos que a implementação futura deve nomear

Os mesmos caminhos precisam virar casos de teste, porque alcançam o mesmo efeito por portas diferentes:

- Interface cria uma thread e edita o documento aberto: o range nativo acompanha.
- Agente altera o arquivo enquanto o review está aberto: refresh reconcilia e persiste o novo range.
- Agente cria commit, amend ou rebase: troca de snapshot reconcilia a partir da revisão salva.
- Tachyon reinicia ou retoma: restaura do registro durável antes de recriar `CommentThread`.
- Linha é apagada ou o match é ambíguo: estado `outdated`, nunca deslocamento silencioso.

