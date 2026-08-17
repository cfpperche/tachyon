# 513 — tachyon-diff-review — plan

_Drafted from `spec.md` on 2026-08-17. The approach, not the steps (those go in `tasks.md`)._

## Approach

Só a superfície troca. As 977 linhas de engine da SDD 511 ficam intactas: identidade sem URI,
captura de snapshot, reconciliação na leitura, `outdated`, store em `.tachyon/review/`, e o par
`review.view` / `review.mutate` no protocolo.

O que entra é uma webview do Tachyon que consome `review.view` — a mesma consulta que a extensão já
faz hoje — e desenha diff mais notas. O que sai é `apps/vscode-extension/src/review/comments.ts`, com
o `CommentController` junto.

O engine ganha uma coisa só: **hunks linha a linha**. Ele já roda git e já tem a lista de arquivos
mudados; falta o conteúdo do diff atravessar o protocolo.

## Key decisions

- **A âncora não é tocada** — escolhido porque ela é o coração medido da 511 e não menciona URI de
  propósito, justamente para a superfície não decidir nada durável. Esta reversão é a prova de que
  aquela decisão valeu: trocar de tela aposenta um arquivo em vez de reescrever a feature. Rejeitado
  *aproveitar a troca para revisar a reconciliação* — mexer no que está medido e testado por causa de
  uma mudança de render é como o retrabalho começa.

- **Aba do editor, não painel lateral** — diff precisa de largura e a sidebar é estreita. Board,
  Activity e Plugins já são abas do editor; a tela de review pertence à mesma família. Rejeitado
  *sidebar*, que forçaria diff unificado estreito e competiria com a lista de agentes.

- **Diff unificado como padrão, lado a lado como possibilidade** — unificado cabe em menos largura e
  a âncora é por linha do lado modificado, que é o que o unificado destaca. Rejeitado *começar por
  lado a lado*: dobra a largura mínima e não melhora o gesto de anotar. **Medir contra os diffs reais
  do projeto antes de fixar** — a decisão fica aberta na fatia 0.

- **`highlight.js` para realce** — já está empacotado e provado em Activity, com guarda de 20k
  caracteres em `markdownEngine.ts:13`. Rejeitado *Monaco ou CodeMirror*: trariam um editor inteiro
  para uma tela que não edita, e o non-goal diz que não construímos editor de código.

- **Nada se revela sozinho** — é o critério que motivou a spec. Nenhuma chamada que abra, revele ou
  redimensione painel do VS Code. Rejeitado *abrir a aba de review automaticamente ao anotar*: seria o
  mesmo defeito com a nossa pintura.

## Files touched

**Engine — só o que falta:**

- `packages/engine/src/worktree/review.ts` — ganha hunk linha a linha. Hoje tem `parseNameStatus`,
  `mergeChanges`, `emptySides`, `baseSidePath` e `diffTitle`, e nenhum conteúdo de diff.
- `packages/engine/src/runtime-api/reviewProjection.ts` — os hunks atravessam o contrato versionado.
- `packages/engine/src/engine-service/protocol.ts` — se `review.view` precisar de campo novo.

**Webview — a tela:**

- `packages/webview-ui/src/webview/review/` — **novo**. Diff, régua clicável, notas, envio do lote.
- reaproveita `highlight.js` do mesmo jeito que `activity/markdownEngine.ts`.

**Extensão — o host da aba e a aposentadoria:**

- `apps/vscode-extension/src/webview/` — o painel que hospeda a webview, no molde de `BoardPanel.ts`.
- `apps/vscode-extension/src/review/comments.ts` — **removido**, com o `CommentController`.
- `apps/vscode-extension/src/extension.ts` — o comando de review passa a abrir a aba.

## Risks & unknowns

- **Diff grande.** Não sei o tamanho típico nem o máximo de um diff de worktree neste projeto. Um
  agente que mexe em 50 arquivos produz uma tela que precisa paginar ou virar lista. **Medir na fatia
  0** — a 512 provou que medir antes de desenhar poupa a máquina inteira.
- **Custo do realce.** `highlight.js` tem guarda de 20k por bloco em Activity. Um arquivo de 4.000
  linhas é outra ordem. Medir e degradar explicitamente, nunca em silêncio.
- **A janela entre aposentar e substituir.** Se `comments.ts` sair antes de a tela existir, o dono
  fica sem review nenhum. A ordem das fatias tem de manter uma superfície viva o tempo todo.
- **`packages/webview-ui/src` não pode importar `vscode`**, em valor e em tipo — spec 233, tolerância
  zero, verificável por `scripts/check-engine-boundary.sh`.
- **O que se perde e o dono aceitou:** hover, ir-para-definição e find-references dentro do diff. Era
  o meu argumento para o Desenho 1 e ele decidiu contra, com uso real na mão.

## Visual impact

Uma aba nova do editor com o diff e as notas. Some o editor de diff nativo do fluxo de review, e some
o painel Comments se revelando sozinho.

O que pode ficar errado: diff largo demais para a aba, texto de nota competindo com o código, e a
régua clicável sendo difícil de acertar. A prova a capturar é a aba em duas larguras, com um diff de
arquivo grande e duas notas visíveis — uma migrada e uma `outdated`.

## Sources consulted

- `docs/specs/511-diff-review-line-notes/` — spec, plan e notes, incluindo a medição do `k` e a prova
  do `CommentController` em URI virtual que agora fica sem uso.
- `apps/vscode-extension/src/review/comments.ts` — 665 linhas, 22 usos de `vs.`, o único acoplamento.
- `packages/engine/src/worktree/reviewNotes.ts` (495), `reviewNotesStore.ts` (112),
  `reviewNotesService.ts` (124), `runtime-api/reviewProjection.ts` (75), `reviewCommands.ts` (171) —
  977 linhas agnósticas que ficam.
- `packages/engine/src/worktree/review.ts` — 87 linhas puras, sem hunk.
- `packages/webview-ui/src/webview/activity/markdownEngine.ts:13` — `highlight.js` com guarda de 20k.
- `apps/vscode-extension/src/extension.ts:719-765,3924` — o fluxo de review que existe hoje.
