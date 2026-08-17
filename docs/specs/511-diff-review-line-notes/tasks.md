# 511 — diff-review-line-notes — tasks

_Generated from `plan.md` on 2026-08-17. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

**Fatia 0 — a pergunta que pode matar metade do desenho. Nada começa antes dela.**

- [x] Provar se `comments.createCommentController` aceita `createCommentThread` num URI de scheme
      próprio e read-only (`tachyon-worktree:`). Prova exigida: a thread aparece no diff aberto pelo
      comando de review, com o `+` na régua. Se **não** aceitar, registrar em `notes.md` e seguir pelo
      fallback do plano — âncora no arquivo real —, sem mexer em identidade nem reconciliação.
      **t-1c7627: SIM, VS Code 1.133.0, no Extension Host real. Os quatro pontos observáveis passaram,
      com controle negativo em `file:`. Fallback não acionado.**
- [x] Medir o k do contexto do snapshot: quantos casamentos ficam ambíguos com k = 0, 1 e 3 linhas nos
      diffs reais deste repositório. Adotar o menor k que zera a ambiguidade e **declarar a amostra**
      em `notes.md`. Sem esse número, nada de escrever a reconciliação.
      **Medido t-232111: nenhum k ∈ {0,1,3} zera (k=3 = 4.433% em review-all; k=5 extra = 2.716%).
      Pior caso: `scripts/webview-preview/routes.json:486`, bloco de 7 linhas em 43 posições.
      Não arredondar — a reconciliação herda `outdated` por ambiguidade como caminho estrutural.**

**Fatia 1 — engine: o dado e a corretude, sem `vscode`.**

- [x] `packages/engine/src/worktree/reviewNotes.ts` — identidade (`worktree + baseRef + path + lado +
      commentId`, **sem URI**), captura de snapshot com o k medido, e o tipo do estado incluindo
      `outdated`.
- [x] Reconciliação pura no mesmo arquivo: match único migra; zero ou mais de um vira `outdated`
      preservando texto e última posição. Nunca escolher o match mais próximo.
- [x] `packages/engine/src/worktree/reviewNotesStore.ts` — persistência em `.tachyon/review/`, no molde
      de `evidenceStore.ts`.
- [x] Guarda de tamanho no caminho caro, no molde de `markdownEngine.ts:13`: acima do limite, degradar
      **explicitamente** e dizer que degradou.
- [x] Testes de unidade da reconciliação antes da fiação: migração por deslocamento, linha apagada,
      ambíguo, snapshot que não bate, rename, e range empurrado discordando do snapshot.

**Fatia 2 — protocolo e fiação.**

- [x] `protocol.ts` — `WorkspaceQueryV1` ganha a leitura das notas (reconciliada **na leitura**);
      `WorkspaceCommandMethodV1` ganha a mutação, no molde de `sidebar.mutate`.
      **t-115091: `review.view` + `review.mutate` (`note.upsert` / `note.hint`).**
- [x] Handler de consulta e de comando no engine.
- [x] Provar que `packages/engine/src` e `packages/webview-ui/src` seguem com zero `vscode`:
      `bash scripts/check-engine-boundary.sh`.

**Fatia 3 — extensão: todo o acoplamento com o VS Code, e só aqui.**

- [ ] `apps/vscode-extension/src/review/comments.ts` — registro do `CommentController`, ciclo das
      threads, restauração a partir do registro **antes** de recriar thread.
- [ ] Empurrar o range que a plataforma mover, como **dica**. O empurrão pode falhar sem consequência:
      a leitura re-deriva.
- [ ] Comando de enviar o lote, vizinho de `tachyon.reviewWorktreeItem` em `extension.ts:3924`. Um
      prompt só, cada nota com `path:linha` e prioridade, alvo escolhido pelo humano entre os agentes
      da worktree. `reviewWorktreeDiff` e o content provider ficam intactos.
- [ ] O mesmo lote enviado vira registro imutável por `attach_evidence`.
- [ ] `package.json` + as duas `package.nls` — o comando novo, e `tachyon.reviewWorktreeItem` sai do
      `"when": "false"` do `commandPalette`.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [ ] Nota nasce na linha, aparece no painel Comments, e existe no registro durável com `baseRef`,
      path, lado, range e snapshot
- [ ] Lote chega ao agente como **um** prompt, e o mesmo lote está em `attach_evidence`
- [ ] Deslocamento mecânico migra, e o reconcílio nomeia o deslocamento
- [ ] Linha apagada vira `outdated`, com texto e última posição preservados
- [ ] Casamento ambíguo vira `outdated`, não palpite
- [ ] As duas portas do lado modificado se comportam igual — provado por **um** caminho de código, não
      por dois testes de dois caminhos
- [ ] Range empurrado discordando do snapshot: vence o snapshot, e a divergência fica registrada
- [ ] Reload, restart e resume não perdem nota
- [ ] Zero `vscode` em `packages/engine/src` e `packages/webview-ui/src`
- [ ] Nenhum webview novo
- [ ] Nenhuma nota removida por reconciliação

**Headless check:** `npm run verify:full`

**Verify:** `bash scripts/check-engine-boundary.sh`
**Verify:** `npm test`

## Dogfood

**Dogfood:** `npm test`
<!-- A nota nasce, é enviada e reconciliada por funções puras do engine; o ciclo completo é
     exercitável sem UI. A parte que exige olho humano está no Human dogfood abaixo. -->

**Human dogfood:**

1. Sidebar → item da worktree de um agente → **Review Changes** (e conferir que ele agora aparece na
   paleta de comandos)
2. Escolher um arquivo, comentar em duas linhas de arquivos diferentes
3. Enviar o lote e conferir no painel do agente que chegou **um** prompt só
4. Deixar o agente mexer no arquivo e commitar
5. Reabrir o diff: uma nota migrada, e uma `outdated` se a linha morreu

## Visual QA

- [ ] Evidence: o diff aberto em duas larguras, com uma nota migrada e uma `outdated` visíveis ao mesmo
      tempo, mais o painel Comments listando as duas
- [ ] Verdict:

Prototype: `docs/specs/511-diff-review-line-notes/prototypes/diff-review-proposta.html`

## Cookbook

**Cookbook-Opt-Out:** a superfície é gesto humano no editor nativo, descrita no Human dogfood; se a
fatia opcional da tool de Bridge para o agente reler as notas for feita, ela ganha cookbook então.
