# 511 — diff-review-line-notes — notes

_Created 2026-08-17._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

### Fatia 0a — `CommentController` em documento virtual read-only (t-1c7627)

**Resposta: SIM.** Medido no VS Code **1.133.0** por
`test/integration/commentControllerCustomScheme.test.js`, dentro do Extension Host real iniciado por
`npm run test:integration`. O teste registra um `TextDocumentContentProvider` em scheme próprio,
abre `vscode.diff` com base e modificado virtuais e cria a thread apenas no URI modificado.

Os quatro pontos observáveis passaram:

1. **Associação ao documento virtual:** o URI devolvido por `thread.uri` é exatamente o URI do
   `TextDocument` virtual modificado que consta em `window.visibleTextEditors`.
2. **Lado modificado, não base:** os dois documentos do diff estão visíveis; `thread.uri` coincide
   com o modificado e difere explicitamente do URI base.
3. **Afordância na régua:** depois de abrir o diff, o próprio VS Code chama
   `CommentingRangeProvider.provideCommentingRanges` para o documento virtual modificado e recebe o
   range habilitado. Essa chamada é o contrato observável pelo qual o editor pede os ranges que
   desenham a afordância de comentário; criar uma thread sem ela não satisfaria a prova.
4. **Range legível de volta:** `thread.range` permanece definido e volta exatamente como
   `0:0–0:5` (`Range.isEqual`).

**Controle negativo obrigatório:** o mesmo helper, com as mesmas quatro asserções, foi executado em
um diff cujos dois lados são `vscode.Uri.file(...)`; também passou. Resultado observado: uma
requisição de commenting range no lado modificado e range `0:0–0:5` tanto no scheme próprio quanto
em `file:`. Portanto a prova não está confundindo uma falha geral do teste com diferença de scheme.

O provider de produção `tachyon-worktree:` não foi duplicado no teste: o risco sob investigação é a
aceitação do URI pelo subsistema de Comments, e o caso isolado usa a mesma classe de documento
read-only (`TextDocumentContentProvider`) sem acoplar esta prova à leitura Git do provider Tachyon.
Como a resposta é positiva, o fallback do plano não é acionado; identidade e reconciliação seguem
inalteradas.

**Nota do claude sobre o delta não testado, para a fatia 3.** Concordo com o recorte, e o que fica de
fora tem nome: o URI de produção carrega **query string** — `tachyon-worktree:/<path>?cwd=...&ref=...`
— e o scheme sintético do teste não. Isso não muda a resposta (o subsistema de Comments decide por
scheme, não por query), mas é exatamente onde bug de identidade de URI mora: `toString(true)` inclui
a query, então dois URIs do mesmo arquivo em `ref` diferentes **não são iguais**. A fatia 3 tem de
comparar URI de propósito e escrito, nunca por acidente de igualdade de string. Lembrando que a
identidade da nota não menciona URI justamente para que essa comparação não decida nada durável.

**Custo operacional descoberto na entrega, e é meu erro de contrato.** `npm run test:integration`
sobe uma janela real do Extension Development Host: apareceu na tela do dono no meio do trabalho dele.
`xvfb-run` está instalado nesta máquina. Todo contrato futuro que rodar teste de integração passa por
ele; a alternativa é não despachar integração para agente em segundo plano.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._
