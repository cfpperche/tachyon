# 513 — tachyon-diff-review

_Created 2026-08-17._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

## Intent

A SDD 511 entregou notas de review presas à linha do diff, usando o diff nativo do VS Code e o
`CommentController`. O mecanismo funciona. A **superfície** não.

No primeiro uso real, escrever uma nota fez o painel Comments se revelar sozinho e tomar a barra
inferior inteira. Palavras do dono: *"ficou uma bosta isso, negocio abriu do nada a bottom bar"*, e a
decisão: *"vamos aposentar isso e criar nosso proprio diffreview integrado com nosso sistema e nao
usar do vscode que fica pessimo em UX"*.

Isto **reverte uma escolha minha.** Quando a 511 foi desenhada eu recomendei o Desenho 1 — hospedar
no editor nativo — com o argumento de que possuir o editor compra ergonomia e não corretude, e que a
âncora seria nossa nos dois casos. O argumento sobre corretude continua certo. O que eu subestimei foi
que **a ergonomia É o produto aqui**: a funcionalidade existe porque apontar em prosa no chat tinha
ergonomia ruim. Trocar uma ergonomia ruim por outra não era o objetivo.

**A reversão é barata, e é barata por desenho.** A identidade da nota nunca mencionou URI — decisão
tomada na 511 justamente para a superfície de render não decidir nada durável. Medido hoje:

    engine, agnóstico de runtime ...... 977 linhas  (identidade, snapshot, reconciliação,
                                                     outdated, store, protocolo, projeção, comandos)
    apps/vscode-extension/.../comments.ts .. 665 linhas  (o único acoplamento)

Trocar de superfície aposenta **um arquivo**.

Feito é: o dono abre o review de uma worktree numa tela do Tachyon, lê o diff ali, comenta na linha,
manda o lote ao agente — e **nada se revela sozinho**.

## Acceptance criteria

- [ ] **Scenario: o review acontece numa tela do Tachyon**
  - **Given** uma worktree de agente com mudanças
  - **When** o dono abre o review
  - **Then** o diff aparece numa superfície do Tachyon, e o editor de diff nativo do VS Code **não** é
    aberto para isso

- [ ] **Scenario: nada se revela sozinho**
  - **Given** o dono lendo o diff na tela do Tachyon
  - **When** ele escreve uma nota numa linha
  - **Then** nenhum painel do VS Code se abre, se revela ou muda de tamanho — a barra inferior fica
    exatamente como estava

- [ ] **Scenario: a nota continua sobrevivendo ao agente mexer no arquivo**
  - **Given** uma nota escrita na tela nova
  - **When** o agente altera o arquivo e commita, e o dono reabre o review
  - **Then** deslocamento mecânico migra e linha apagada vira `outdated`, exatamente como a 511 já faz
    — **sem nenhuma mudança na reconciliação**

- [ ] **Scenario: o lote continua chegando como um prompt só**
  - **Given** duas ou mais notas
  - **When** o dono envia ao agente escolhido
  - **Then** o agente recebe um prompt só, cada nota com `path:linha` e prioridade, e o mesmo lote
    fica em `attach_evidence`

- [ ] O `CommentController` e `apps/vscode-extension/src/review/comments.ts` saem do produto
- [ ] As 977 linhas de engine da 511 **não mudam** — identidade, snapshot, reconciliação, store,
      protocolo, projeção e comandos ficam como estão
- [ ] `packages/webview-ui/src` segue com **zero** import de `vscode`

## Non-goals

- **Não reescrever a âncora.** Ela é o coração da 511, está medida e testada, e não menciona URI de
  propósito. Se alguém precisar mexer nela para a tela funcionar, a tela está errada.
- **Não construir editor de código.** O dono lê o diff e comenta; ele não edita ali. Sem
  autocompletar, sem hover, sem ir-para-definição.
- **Não substituir o diff nativo para OUTROS usos.** O `vscode.diff` continua servindo quem quiser
  abrir um arquivo; o que sai é o review de worktree passar por ele.
- **Não inventar centro de notificações nem histórico.** Mesma disciplina da 512.
- **Não bloquear nada.** Nota é advisory; não recusa merge, não trava gate.

## Open questions

- **Aba do editor ou painel lateral.** A tela precisa de largura para diff lado a lado, e a sidebar é
  estreita. A inclinação é aba do editor, como Board e Activity já fazem. **Resolver no plano contra a
  estrutura de webviews que já existe.**
- **Lado a lado ou unificado.** Lado a lado precisa de largura; unificado cabe em menos espaço e é
  mais fácil de anotar por linha. **Medir contra os diffs reais do projeto antes de escolher.**
- **De onde vêm os hunks.** O engine já roda git e `worktree/review.ts` tem `parseNameStatus`,
  `emptySides`, `baseSidePath` e `diffTitle`, mas não hunk linha a linha. **Resolver no plano: git
  entrega isso, e a pergunta é qual formato atravessa o protocolo.**
- **Realce de sintaxe.** `highlight.js` já está no pacote e é usado em Activity com guarda de 20k
  caracteres. Serve? **Medir contra os arquivos maiores do projeto.**
