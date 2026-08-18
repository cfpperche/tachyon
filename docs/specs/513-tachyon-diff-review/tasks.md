# 513 — tachyon-diff-review — tasks

_Generated from `plan.md` on 2026-08-17. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

**Fatia 0 — medir o que a tela vai carregar. A 512 provou que isso poupa.**

- [x] Tamanho típico e máximo de um diff de worktree neste projeto: arquivos por review, linhas por
      arquivo, linhas totais. Amostra declarada — quais worktrees, quais commits.
- [x] Custo do realce com `highlight.js` no maior arquivo real. A guarda em Activity é de 20k por
      bloco; um arquivo de 4.000 linhas é outra ordem. **Se for caro, degradar explicitamente.**
- [x] Unificado ou lado a lado: contra os diffs medidos, qual cabe na largura de uma aba sem cortar.

**Fatia 1 — o engine ganha hunk, e só isso.**

- [x] `worktree/review.ts` — hunk linha a linha. O git entrega; a pergunta é o formato que atravessa.
- [x] `runtime-api/reviewProjection.ts` — os hunks no contrato versionado.
- [x] **A âncora NÃO é tocada.** `reviewNotes.ts`, `reviewNotesStore.ts` e `reviewNotesService.ts`
      ficam byte-idênticos. Se precisar mexer, PARAR e dizer por quê.
- [x] `bash scripts/check-engine-boundary.sh` verde.

**Fatia 2 — a tela.**

- [x] `packages/webview-ui/src/webview/review/` — diff, régua clicável, notas.
- [x] Realce reaproveitando `highlight.js` como Activity faz, com a mesma disciplina de guarda.
- [x] Escala herdada do host; nada de valor escolhido nesta tela.
- [x] **Nada se revela sozinho.** Nenhuma chamada que abra, revele ou redimensione painel do VS Code.

**Fatia 3 — a aba, e a aposentadoria.**

- [x] O painel host no molde de `BoardPanel.ts`; o comando de review passa a abrir a aba.
- [x] `apps/vscode-extension/src/review/comments.ts` **removido**, com o `CommentController`.
- [ ] **ORDEM:** a tela nova funciona ANTES de `comments.ts` sair. Nunca deixar o dono sem review.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [ ] O review abre numa tela do Tachyon; o diff nativo do VS Code não é aberto para isso
- [ ] Escrever uma nota **não** abre, revela nem redimensiona painel nenhum do VS Code
- [ ] Deslocamento mecânico migra e linha apagada vira `outdated` — sem mudança na reconciliação
- [ ] O lote chega ao agente como **um** prompt, e o mesmo lote está em `attach_evidence`
- [ ] `CommentController` e `comments.ts` ausentes do produto — prova por busca, com contexto
- [ ] As 977 linhas de engine da 511 inalteradas
- [ ] Zero `vscode` em `packages/webview-ui/src`

**Headless check:** `npm run verify:full`

**Verify:** `bash scripts/check-engine-boundary.sh`
**Verify:** `npm test`

## Dogfood

**Dogfood:** `npm test`
<!-- Âncora, hunks e lote são funções puras do engine, exercitáveis sem UI.
     O gesto humano está no Human dogfood. -->

**Human dogfood:**

1. Abrir o review de uma worktree de agente com mudanças
2. Conferir que abre a aba do Tachyon e **não** o diff nativo
3. Escrever uma nota numa linha — **a barra inferior não pode mudar**
4. Deixar o agente mexer no arquivo e commitar
5. Reabrir: uma nota migrada, e uma `outdated` se a linha morreu
6. Enviar o lote e conferir no painel do agente que chegou **um** prompt só

## Visual QA

- [x] Evidence: a aba em duas larguras, com um diff de arquivo grande e duas notas visíveis — uma
      migrada e uma `outdated` — `.vqa/t-832633/review-large-880.png` e `review-large-360.png`
      (standalone `review-fatia2.html`; catalog route waits for fatia 3)
- [x] Verdict: pass (advisory). 880 = lista ao lado do diff; 360 = empilha. Banner
      "realce desativado neste arquivo (grande)" visível nas duas. Nota migrated na linha 1;
      outdated no bloco "Notas fora do diff visível" acima dos hunks. Sem overflow horizontal.
      Preocupações menores: paths truncam a 360; o `+` da régua é quieto.

## Cookbook

**Cookbook-Opt-Out:** a superfície é gesto humano numa tela do produto, descrita no Human dogfood; não
há tool, CLI nem ciclo de vida que outro operador precise invocar.
