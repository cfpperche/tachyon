# t-a8f1fd — lifecycle de worktree: o que o Tachyon já tem (2026-08-19)

Medição contra a árvore desta worktree (`694eb16c`, tree `0d6dfdf2`), não contra o retrato de 2026-07-06.

`/tmp/orca-re` **não existe**. Nada abaixo afirma o que aquele produto faz: os onze nomes vêm só do corpo do cartão. Sem desenho, sem fatias, sem código.

Decisões fechadas lidas e não reabertas: `t-349678` (done) — recusa de ocupação nomeia o retry, sem force e sem espera interna; `t-8f48da` (done) — dismiss não mata processo; `t-71b18d` (dropped) — reabrir os dois foi o erro. Evidência de campo de hoje (19 processos com cwd em worktree já apagada) entra só como fato, não como pedido de matar no dismiss.

## Os onze do cartão

| # | Item no cartão | Veredito | Arquivo:linha | O que falta quando PARCIAL |
|---|---|---|---|---|
| 1 | create em background | **PARCIAL** | `packages/bridge/src/tools/worktrees.ts:10-37` (`create_worktree` espera `createChange`); `packages/engine/src/worktree/ManagedWorktreeService.ts:593-646` (`git worktree add` síncrono sob lock); `packages/engine/src/worktree/WorktreeManager.ts:1450-1472` (`ensure` no spawn, também bloqueia) | Create existe. Não há job em background, fila, nem estado `creating`. Setup e share de deps rodam dentro do mesmo `await`. |
| 2 | start-from picker | **PARCIAL** | Change: `worktrees.ts:20` `baseRef` opcional, default `HEAD` em `ManagedWorktreeService.ts:616-622`. Agente: `WorktreeManager.ts:897-909` — `ensure` ramifica sempre do `HEAD` do checkout primário. Studio: `agent-studio-shell/App.tsx:1137-1149` tem branch, **não** tem start-from. Fork: `WorktreeManager.ts:949-969` parte do HEAD commitado da origem | Change aceita um ref por string. Agente não escolhe origem. Não há picker em superfície nenhuma. |
| 3 | branch naming | **PRONTO** | Studio: `App.tsx:1148-1149` campo explícito (vazio → `tachyon/<name>`). Resolução: `WorktreeManager.ts:82-90` (`agent.branch` > template `{agent}` > `tachyon/<agent>`). Change: `worktrees.ts:19` + `managedWorktree.ts:87-88` (`tachyon/change/<slug>`). Temporary: `WorktreeManager.ts:124-131` e `1368-1392` (`tachyon/tmp.{agent}.{stamp}-{entropy}`, desjunto do nome) | — |
| 4 | issue link | **PARCIAL** | Persistido: `managedWorktree.ts:23-24` `taskId?`; escrito em `create_worktree` (`worktrees.ts:21,34`) e `register` (`ManagedWorktreeService.ts:401,489`). Spawn liga agente↔board por `claim_task` (`fleet.ts:160-166`), outro objeto. A linha do Control **não** carrega `taskId` (`packages/webview-ui/src/sections/model.ts:122-158`) | O id cabe no registry. Nenhuma superfície de worktree o mostra, filtra ou navega. Agente e change não compartilham o mesmo vínculo. |
| 5 | progress row | **AUSENTE** | `WorktreeRow` (`model.ts:122-158`) tem `classification` / `land` / `ownerPresence`. Não há campo de progresso, fase, nem `creating`. `ManagedWorktreeEntry.status` é só `active \| abandoned` (`managedWorktree.ts:29`) | A linha só aparece depois do `git worktree add` ter voltado. |
| 6 | review | **PRONTO** | Diff: `packages/engine/src/worktree/review.ts:1-10` (spec 213 / SDD 513). Protocolo: `review.view` / `review.diff` em `packages/engine/src/engine-service/protocol.ts:492`. Porta no land: `worktrees/App.tsx:209-210` + `messages.ts:216-219`. Notas: `reviewNotesService.ts` / `reviewNotesStore.ts` (SDD 511) | — |
| 7 | ship | **PRONTO** | Sugestão read-only: `packages/engine/src/worktree/land.ts:1-47`. Ato (humano, primary, `--ff-only`): `landAct.ts:1-24,85-99`. Botão: `worktrees/App.tsx:156-158`. PR: `packages/engine/src/worktree/pr.ts:123` + `worktrees.ts` actions `worktreeCreatePr` / `worktreeConfirmPr` (`messages.ts:221-223`) | — |
| 8 | archive/delete | **PARCIAL** | Delete: `remove_worktree` (`worktrees.ts:196-237`) + `remove`/`removeClassified` (`ManagedWorktreeService.ts:668-703,921-944`). Confirm + batch: `worktrees/App.tsx:538-575`. `abandoned` automático quando o path some (`managedWorktree.ts:189-201`). Forget do registro: `unregister` + `worktreeForgetRecord` (`App.tsx:436-438`) | Não há verbo *archive* (retirar da vista sem apagar o checkout). `abandoned` não é escolha: é path sumido. Preflight cobre dirty / ocupado-por-agente / commits únicos / lock — **não** varre `/proc` de descendentes antes do `rm`. |
| 9 | pin/multi-select | **PARCIAL** | Multi-select de higiene: `App.tsx:276-311,333-347,519-523,538-575` (`wtSelectAll`, checkboxes, `worktreeBatchCleanup`). Só `ready-to-remove` e `record-only`. Pin de worktree: nenhum `worktreePin` no painel; `create_pin` é checklist do projeto, outro objeto | Pin de uma worktree não existe. Multi-select não cobre occupied / needs-review / locked. |
| 10 | project groups | **AUSENTE** | Os grupos do painel são estados de higiene (`App.tsx:21-22,314-320`): `locked`, `ready-to-remove`, `needs-review`, `occupied`, `record-only`. Namespace de disco é `<base>/<wsHash>/…` (`managedWorktree.ts:52-54,78-85`) | Não há agrupamento por projeto. `wsHash` isola workspaces; não é grupo. |
| 11 | import de worktrees externos | **PARCIAL** | `register_worktree` (`worktrees.ts:125-166`) + `register` (`ManagedWorktreeService.ts:394-499`). Exige path sob `<base>/<wsHash>/`, mesmo `git-common-dir` deste repo, branch viva. Fora disso recusa (`:423-425,454-462`) | Adota checkout **já** plantado no root gerenciado deste repositório. Não importa path arbitrário, outro clone, nem worktree de outro repo. |

## Board — cada PARCIAL / AUSENTE

Varredura: `list_tasks` (compact, 500) + grep de título/corpo em `/home/goat/tachyon/.tachyon/tasks`. Cartão que só cita a palavra *worktree* não conta como cobertura.

| Item | Cartão que cobre a lacuna? |
|---|---|
| 1 create em background | **sem cartão** (só o próprio `t-a8f1fd` active) |
| 2 start-from picker | **sem cartão** |
| 4 issue link (projeção / navegação) | **sem cartão**. `claim_task` multi é `t-66c4d7` done — liga agente↔board, não worktree↔task |
| 5 progress row | **sem cartão** |
| 8 archive (verbo) | **sem cartão**. Delete/higiene já entregues: `t-9f8dfc` done, `t-e74631` done, `t-7cb971` done |
| 8 delete sem preflight de `/proc` descendente | **sem cartão** pedindo essa sonda. `t-1926ce` done e `t-8f48da` done fecharam *não matar no dismiss*. `t-71b18d` dropped. `t-9dd48e` active é teardown do **gate de teste**, outro objeto |
| 9 pin de worktree | **sem cartão** |
| 10 project groups | **sem cartão** |
| 11 import fora do root gerenciado | **sem cartão**. `t-d06da3` dropped era “delegue numa OUTRA worktree” por referência nomeada, não import externo |

Nenhum cartão aberto nesta rodada.

## O que o Tachyon tem e a lista dos onze não tem

Olhar só para falta esconde o que o produto já opera. Isto existe hoje e o cartão de 07-06 não nomeia:

1. **Dois kinds com regras diferentes.** `agent` vs `change` (`managedWorktree.ts:12,14-30`). Sweep de higiene **nunca** varre agent (`ManagedWorktreeService.ts:714-723`). Agent órfão só sai por nomeação (`remove_worktree` / Control), não pelo sweep da ativação.
2. **`spawn_agent worktree:true`.** Filho delegado nasce no próprio checkout; dismiss apaga o checkout e **guarda** branch com commit não mesclado (`fleet.ts:131-148`). Temporary mint de branch por spawn (`WorktreeManager.ts:93-131,1388-1392`) — o nome do filho não é mais identidade de branch.
3. **Ocupação fail-closed.** `probeRememberedRootProcess` (`AgentManager.ts:82-97`) + `releaseOwnedWorktreeForRemoval` (`:2343-2370`). Recusa com a saída nomeada; sem force. Decisão de `t-349678`.
4. **Classificador + sweep na ativação.** `classify.ts:18` (`record-only` / `ready-to-remove` / `needs-review` / `occupied`); `Workspace.sweepWorktreeHygiene` (`Workspace.ts:3604-3620`) chama `reconcileHygiene` como humano, só anuncia remoções. `reconcile_worktrees` / `worktree_audit` são as portas manuais.
5. **`worktree_processes`.** Relatório de cwd em checkout já apagado (`orphanProcessHygiene.ts:25-69`; `worktrees.ts:89-103`). Texto do contrato: *does not terminate reported processes automatically*. Combina com a evidência de campo (19 pids) e com a decisão de não matar no dismiss.
6. **Quarentena de launch.** `git worktree add --lock` até o ledger gravar (`WorktreeManager.ts:687-694,907-928`). Porta humana `releaseLock` (`ManagedWorktreeService.ts:887-918`) — destrava, não apaga. Grupo `locked` no painel (`App.tsx:407-414`).
7. **Fork.** `createFork` (`WorktreeManager.ts:949-969`): checkout novo, branch nova, ponto = HEAD commitado da origem; dirty da origem não viaja.
8. **Share de dependências com digest.** `dependencySharing.ts:1-37`: link de `node_modules` só com lockfile byte-idêntico; divergência remove o link e falha alto.
9. **Projeção de plugin tooling** em todo register/ensure/reload (`ManagedWorktreeService.ts:513-552`; `Workspace.ts:6678-6681`).
10. **`agent_touched_files`.** Diff do próprio worktree de cada agente vivo (`fleet.ts:1043-1053`). Isola escrita; não é lock de arquivo.
11. **Reveal multi-root.** `applyWorktreeFolderReveal` (`apps/vscode-extension/src/extension.ts:460`).
12. **GitDelivery / leases de delivery — aposentados.** `settings.gitDelivery` é chave ignorada (`loadConfig.ts:1883-1892`). `land.ts:32-40` registra a aposentadoria. O cartão de 07-06 ainda fala de um mundo com Delivery; esse mundo saiu. Não é lacuna: é remoção.

## O que não deu para medir

- **Orca.** `/tmp/orca-re` commit `057db5b` não está na máquina. Os onze nomes são rótulos do cartão, não comportamento conferido.
- **Nenhum `git worktree add` / land / remove foi executado nesta sessão.** Vereditos são leitura do fonte + testes que o nomeiam, não um ciclo vivo.
- **`worktree_processes` não foi re-rodado.** Os 19 pids são a varredura do coordenador às 21:40 de 18/08; o número de agora não foi medido aqui.
- **Uso real de `create_worktree`.** A porta existe e os testes a exercitam. Não medi se alguém na frota a chama fora de teste.
- **Se o campo `branch` do Studio chega intacto ao `ensure` em todo restart/resume/fork.** A resolução (`branchFor`) honra `agentDef.branch`; os quatro gatilhos não foram executados.
- **Mission Control / Task Studio / sidebar como UX de worktree.** Fora do escopo desta rodada (desenho). Só registrei que `WorktreeRow` não carrega `taskId` e que o pin do produto não é pin de worktree.
- **Resíduo de `git-delivery/` em disco vs código morto.** `land.ts` e `loadConfig.ts` afirmam aposentadoria; não varri cada comentário histórico para provar zero chamador residual além do que a busca por `GitDelivery` já mostrou (comentários + teste).

## Método

Pontos de partida do brief, mais `packages/engine/src/worktree/*`, `packages/bridge/src/tools/worktrees.ts`, `packages/bridge/src/tools/fleet.ts`, `packages/webview-ui/src/webview/worktrees/*`, `packages/webview-ui/src/webview/agent-studio-shell/App.tsx`, `packages/engine/src/agents/agentRemovalCascade.ts`. Board: `list_tasks` + grep em `.tachyon/tasks` do checkout primário (esta worktree não monta esse diretório).
