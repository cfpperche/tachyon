# 511 — diff-review-line-notes — plan

_Drafted from `spec.md` on 2026-08-17. The approach, not the steps (those go in `tasks.md`)._

## Approach

O fluxo de review já existe de ponta a ponta menos a nota. O plano acopla a nota nele sem redesenhar
nada: o humano abre o diff pelo comando que existe, comenta na régua do editor nativo, e um comando
manda o lote ao agente.

Duas metades, separadas pela fronteira do spec 233:

**Extensão** — registra um `CommentController`, cria e destrói as threads, e empurra para baixo o que
a plataforma mexer. Nada de lógica de âncora aqui.

**Engine** — guarda a nota, captura o snapshot, e reconcilia. É onde vive a corretude, e é o lado que
não sabe que o VS Code existe.

A regra que organiza tudo: **o snapshot é a verdade e o range da plataforma é dica.** O engine nunca
confia num range que ele não derivou; ele aceita como palpite e confirma contra o conteúdo.

## Key decisions

- **Snapshot é a verdade; o range da plataforma é dica** — escolhido porque nenhum range vivo
  sobrevive a commit, amend ou rebase, então a reconciliação por conteúdo é necessária de qualquer
  forma. Rejeitado *confiar no range da plataforma*, porque ele morre na troca de snapshot e a tela
  passaria a declarar uma posição que o dado não tem. Rejeitado *só hash da linha*, porque falha em
  linha repetida. Rejeitado *blob + offset*, porque é determinístico e não migra.

- **A identidade da nota NÃO menciona URI nenhum** — escolhido porque dissolve o problema das duas
  portas. O lado modificado do diff é `vscode.Uri.file(...)` quando não há `headRef` e
  `tachyon-worktree:/<path>?ref=<headRef>` quando há. Se a identidade fosse o URI, existiriam dois
  caminhos de código com uma guarda só — a classe de defeito desta casa. Sendo `worktree + baseRef +
  path + lado + commentId`, o URI passa a ser **só onde a thread é desenhada**, e um caminho serve as
  duas portas. Rejeitado *implementar e testar as duas portas separadamente*, porque duplicar o
  caminho é o que cria a assimetria.

- **`headRef` fica no snapshot, não na identidade** — escolhido porque nota feita contra um HEAD
  antigo tem de **reconciliar**, não desaparecer. Rejeitado *incluir `headRef` na chave*, que faria a
  nota sumir a cada commit do agente e pareceria "limpeza" em vez de perda.

- **Reconciliação acontece na LEITURA, sempre. Sem trigger, sem watcher, sem evento** — escolhido
  porque elimina a classe da porta esquecida. As portas que trocam snapshot são reabrir o review,
  refresh da worktree, restart/resume do engine e commit/amend/rebase do agente; qualquer lista dessas
  fica errada no dia em que alguém acrescentar a quinta. Lendo sempre reconciliado, existe **uma**
  porta. Rejeitado *watcher de arquivo* (gatilho invisível e custo por tick — a lição do monitor de
  reprompt que leu 335 MB por linha de ledger e derrubou o engine na 0.93.5). Rejeitado *reconciliar
  em eventos git*, pelo mesmo motivo. O custo é um diff por leitura, e leitura aqui é gesto humano,
  raro.

- **Ambiguidade é recusada, nunca resolvida** — escolhido porque um palpite silencioso é precisamente
  "declarar um estado que não tem". Match único migra; zero matches ou mais de um vira `outdated`,
  preservando texto e última posição. Rejeitado *escolher o match mais próximo*, que acerta na maioria
  e mente sem avisar exatamente quando importa.

- **O tamanho do contexto do snapshot é MEDIDO, não escolhido** — a tarefa mede, nos diffs reais deste
  repositório, quantos casamentos ficam ambíguos com k = 0, 1 e 3 linhas de contexto, e adota o menor
  k que zera a ambiguidade na amostra, declarando a amostra. Rejeitado *fixar 3 por gosto*: seria
  número mágico, e este projeto acabou de trocar número mágico por derivação na 0.93.7.

- **Dois registros, com naturezas diferentes** — o rascunho mutável em `.tachyon/review/`, e o lote
  enviado imutável via `attach_evidence`. Escolhido porque são fatos distintos: o que você ainda está
  escrevendo, e o que o agente recebeu. O segundo já existe e já estampa HEAD e copia artefato.
  Rejeitado *um registro só*, que ou perde o histórico do envio ou congela o rascunho.

- **`.tachyon/review/` segue o layout do evidence** — o precedente é `.tachyon/evidence/<agent>/<id>/`
  com o registro ao lado dos arquivos (`evidenceStore.ts`, t-1d198e). Escolhido por simetria de casa.

- **Nenhum webview novo** — a régua, a bolha, o painel Comments, resolved/unresolved e o reply são da
  plataforma. Rejeitado *tela de review própria* (Desenho 2), decidido pelo dono com o argumento de
  que possuir o editor compra ergonomia e não corretude, e custaria escrever um render de diff e
  perder hover, go-to-definition e find-references — que é justamente o que serve para checar se a
  mudança do agente quebra um chamador.

- **O comando de review sai do esconderijo** — hoje `tachyon.reviewWorktreeItem` tem `"when": "false"`
  no `commandPalette`. Uma tela sem porta não entra em rotina.

## Files touched

**Engine — a corretude, sem `vscode`:**

- `packages/engine/src/worktree/reviewNotes.ts` — **novo.** Puro: identidade, captura de snapshot,
  reconciliação, o estado `outdated`. É o arquivo que os testes atacam.
- `packages/engine/src/worktree/reviewNotesStore.ts` — **novo.** Persistência em `.tachyon/review/`,
  no molde de `evidenceStore.ts`.
- `packages/engine/src/worktree/review.ts` — hoje 87 linhas puras (`parseNameStatus`, `emptySides`,
  `baseSidePath`, `diffTitle`). Ganha o que faltar de leitura de hunk; o git já é rodado pelo engine.
- `packages/engine/src/engine-service/protocol.ts` — `WorkspaceQueryV1` (união na linha ~489) ganha a
  leitura das notas; `WorkspaceCommandMethodV1` (~250-267) ganha a mutação, no molde de
  `sidebar.mutate`.
- o handler de comando/consulta do engine — fiação dos dois acima.

**Extensão — o acoplamento com o VS Code, todo aqui:**

- `apps/vscode-extension/src/review/comments.ts` — **novo.** Registro do `CommentController`, ciclo
  das threads, e o empurrão do range como dica.
- `apps/vscode-extension/src/extension.ts` — registra o comando de enviar o lote ao lado de
  `tachyon.reviewWorktreeItem` (linha 3924). `reviewWorktreeDiff` (719-765) e o content provider
  (106, 3026) ficam **intactos**.
- `apps/vscode-extension/package.json` + `package.nls.json` + `package.nls.pt-br.json` — o comando
  novo, e a saída do `when: false`.

**Teste:**

- `test/unit/` — reconciliação: migração, linha apagada, ambíguo, snapshot que não bate, e range da
  plataforma discordando do snapshot.

## Risks & unknowns

- **`CommentController` aceita thread em URI de scheme próprio e read-only?** É o risco que pode matar
  metade do desenho, porque o lado modificado é virtual quando existe `headRef`. **Verificar primeiro,
  antes de qualquer outra linha.** Se não aceitar, o fallback é ancorar a thread no arquivo real e
  exibir a nota no lado editável — o que não muda identidade nem reconciliação, porque nenhuma das
  duas menciona URI.
- **O engine guarda um range que nunca observou.** Mitigado por desenho: o range empurrado é dica, e a
  leitura sempre re-deriva. Se o empurrão falhar, a leitura corrige em vez de mentir.
- **Custo do diff por leitura em arquivo grande.** Leitura é gesto humano, mas vale a guarda que o
  projeto já usa em `markdownEngine.ts:13`: pular o caminho caro acima de um tamanho e degradar
  explicitamente, nunca em silêncio.
- **Rename de arquivo.** `ChangedFile` já carrega `from` para status `R`. Nota em arquivo renomeado ou
  é seguida pelo rename, ou vira `outdated` — nunca aponta para o path velho como se ele existisse.
- **Nota advisory que ninguém lê.** O lote vai no texto do contrato justamente por isso; evidence não
  obriga ninguém. Se o agente ignorar, isso aparece no diff dele, não em silêncio.

## Visual impact

Muda o editor de diff, que passa a ter `+` na régua e bolhas, e o painel Comments passa a listar as
threads. Nenhuma tela nova, nenhum webview.

O que pode ficar errado: a bolha ocupando largura demais no diff lado a lado em janela estreita, e a
nota `outdated` parecendo erro em vez de estado. A prova a capturar é o diff aberto em duas larguras,
com uma nota migrada e uma `outdated` visíveis ao mesmo tempo.

Prototype: `docs/specs/511-diff-review-line-notes/prototypes/diff-review-proposta.html`

## Sources consulted

- `docs/research/t-00bf87-orca-diff-comment-anchors.md` — a medição que fundamenta o desenho: a Orca
  não reancora, e o VS Code move o range de graça em documento aberto.
- `apps/vscode-extension/src/extension.ts:106,719-765,3026,3924` — scheme `tachyon-worktree`, o quick
  pick de review, o content provider, o registro do comando.
- `packages/engine/src/worktree/review.ts` — as 87 linhas puras que já existem.
- `packages/engine/src/runtime-api/extensionOperations.ts:32,118-122` e
  `engine-service/extensionOperationService.ts:231` — `worktree.review` já é operação de engine.
- `packages/engine/src/worktree/evidence.ts:37-40` e `evidenceStore.ts` — o layout de
  `.tachyon/evidence/<agent>/<id>/`, precedente para `.tachyon/review/`.
- `packages/engine/src/engine-service/protocol.ts:250-267,489` — as uniões de comando e consulta.
- `scripts/check-engine-boundary.sh` e `scripts/check-vscode-import-boundaries.mjs` — spec 233,
  tolerância zero a `vscode` em `packages/engine/src` e `packages/webview-ui/src`.
- `packages/webview-ui/src/webview/activity/markdownEngine.ts:13` — a guarda de tamanho que serve de
  molde para o custo por leitura.
