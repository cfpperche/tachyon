# 491 — planner-time-axis-over-board — plan

_Drafted de `spec.md` em 2026-08-05, com as nove decisões (D1–D9) já ratificadas. Aqui está a
abordagem, não os passos — esses vão para `tasks.md`._

**As alternativas rejeitadas de PRODUTO estão em `spec.md` § 3 e não se repetem aqui.** Este documento
registra apenas as decisões de **implementação**: onde cada peça encosta no código que existe, e por
que ali e não em outro lugar.

---

## Approach

O Planner não introduz um mecanismo de execução. Ele introduz **um store, um avaliador e um
roteador**, e reusa cinco seams que já existem: o ticker do workspace, o `NoticeQueue`, o
`contextRenewalRequestRefusal`, o compositor de brief e o manifesto de apps da SDD 485.

A ordem das fatias é escolhida por uma propriedade só: **cada uma é observável sem a próxima**. A
fatia A é lida por `plan_status`; a B é exercitada por um agente sem UI nenhuma; a C dispara e grava
sem que exista tela; a D aparece no brief; a E desenha o que já funciona. Isso mantém a lição do
`0.56.159` executável — cada fatia pode ser provada pela porta que a produção usa, porque a porta
existe antes da tela.

### A — Modelo e store

`src/planner/PlanStore.ts`, no molde de `TaskStore`: raiz em `path.join(workspaceRoot, ".tachyon",
"plans")` (D5 — o mesmo `workspaceRoot` que `TaskStore.dir` usa, `src/tasks/TaskStore.ts:145`),
serialização de mutações por promise encadeada, e `withProcessLockSync` para a escrita, como
`PinStore` já faz (`src/pins/PinStore.ts:4`).

`PlanFiring` é **append-only e separado do `Plan`**, em `jsonl`. O precedente escolhido é
`worktree-hygiene.jsonl` (`src/worktree/ManagedWorktreeService.ts:94`) e não o journal de Task: o
journal é por-entidade com um arquivo por task (`TaskJournalStore.pathFor`, append em
`TaskJournalStore.ts:200`), e aqui a leitura dominante é *"o que disparou nesta janela de tempo,
através de todos os planos"* — que é varredura temporal, não leitura por id. Um arquivo por plano
obrigaria a abrir N arquivos para responder a pergunta mais comum.

A invariante de D6 (uma janela aberta por task) mora **no store, na escrita**, não no chamador. É a
única posição que sobrevive a um segundo chamador aparecer depois — e é exatamente o padrão que a
guidance do repositório cobra ("quem mais alcança isso?").

### B — Portas Bridge

`create_plan`, `add_plan_entry`, `update_plan_entry`, `remove_plan_entry`, `get_plan`, `list_plans`,
`plan_status`, `promote_marker` (D1).

`src/bridge/tools.ts` tem **6110 linhas** e a SDD 489 já está extraindo módulos de capacidade. As
ferramentas do Planner nascem em `src/bridge/planner/` como módulo próprio desde o primeiro dia —
somar mais um bloco a `tools.ts` seria criar dívida que outra spec já está pagando.

A recusa de D6 é redigida no formato contratual da 478 M6: nomeia a entrada conflitante e o plano
dono dela, para que a mensagem contenha o conserto.

### C — Motor

`src/planner/PlanEngine.ts`, puro e injetável no molde do `Scheduler` (`getState`/`now`/`onFire`,
`src/schedule/Scheduler.ts:23`) — a testabilidade do agendador atual vem inteira dessa forma, e o
motor do Planner precisa dela mais ainda, porque D2/D7/D9 são uma máquina de estados com relógio.

Roda dentro de `Workspace.tick()`, ao lado de `this.scheduler.tick()`
(`src/workspace/Workspace.ts:5955`), sob o ticker de 3 s (`ATTENTION_POLL_MS`, `Workspace.ts:295`) —
que D8 já mediu como suficiente.

Quatro responsabilidades, nesta ordem de construção:

1. **Catch-up primeiro.** `activate()` reconcilia janelas perdidas e grava `missed` antes de qualquer
   disparo novo (AT9). Construído primeiro de propósito — é a lição da borda de saída, e D3 depende
   dele para ser honesto.
2. **Avaliação de progresso (D7)**, lendo `journalCount` + timestamp da mais recente + `updatedAt`.
   **Nunca materializa o journal** — `TaskStore` já expõe `journal: "none"` com contagem
   (`src/tasks/types.ts:59`), que é exatamente o modo desenhado por `t-ab7708` para este caso.
3. **Escada D2**, com a linha do Inbox **derivada** — ver "Human Inbox" abaixo.
4. **Roteamento de entrega**, com o resultado gravado no `PlanFiring`: entregue, recusado
   (`contextRenewalRequestRefusal`, `src/bridge/tools.ts:594`), expirado por TTL, ou executor ausente.
   D9 exige esse registro: sem prova de entrega, a escada não pode concluir estagnação.

**Human Inbox.** `HUMAN_INBOX_KINDS` (`src/humanInbox/model.ts:37`) ganha o braço `plan-overrun`. O
cabeçalho do módulo diz que o inbox *"lê todos os stores e não escreve em nenhum"* e que novos tipos
entram *"adicionando um braço aqui, sem mudar seus modelos"* — a linha derivada de D2 encaixa nessa
forma sem exceção: ela é uma **leitura** do `PlanStore` mais o resultado do avaliador, e some sozinha
quando o estado muda porque nunca foi persistida como evento.

**Entrega.** `Workspace.enqueueNotice` (`Workspace.ts:4413`) é a porta. O poke do Planner é
`origin: "agent-authored"`? **Não** — é `host-poke`: é o Tachyon falando SOBRE um estado vivo, e o
tipo em `NoticeQueue.ts:20` obriga a declarar isso. O `onExpired` do `NoticeQueue` já existe
(`NoticeQueue.ts:60`) e é o gancho que alimenta a prova-de-entrega de D9.

### D — Brief e renovação

`src/agents/sessionWorkRecord.ts` já compõe a seção WORK ON RECORD (`SESSION_RECORD_OPEN:64`,
`SPAWN_RECORD_OPEN:73`), projetada do board no lançamento. A obrigação de plano entra **como seção
irmã**, não dentro dela: WORK ON RECORD responde "qual task do board é sua"; a do plano responde
"qual janela está aberta agora". Fundi-las faria o precedente de `primer.ts:135` mentir — ele diz
que essa seção é projetada do board, e uma entrada de plano não é uma linha do board.

Isso resolve AT8 (restart/resume/fork) sem mecanismo novo, que é o caso `t-e73e54` — mesmo ator,
outra porta.

### E — App

Uma linha em `WEBVIEW_APPS` (`src/webview/webviewApps.ts:94`) com `cardinality: "dashboard"` — um
painel por projeto, como o Board (`viewId: "tachyonBoard"`, linha 123). Não é `document`: um plano
por workspace com N planos dentro (D5+D6) é uma dashboard, e abrir de novo revela o painel já aberto.

`esbuild.mjs` carrega seu próprio `WEBVIEW_APP_VIEWS` e `test/unit/webviewAppBudget.test.ts` falha se
os dois discordarem — a linha entra nos dois.

O tile: `planner` entra em `NAV_BY_ID` e `LAUNCHER_ORDER` (`src/cockpit/sectionNav.ts`), e o id em
`CockpitSectionId` + `COCKPIT_SECTION_IDS` (`src/cockpit/model.ts`) — **não** em
`COCKPIT_SECTION_ORDER`, que a SDD 485 esvaziou porque Control não renderiza mais apps.

---

## Key decisions

Decisões de implementação. As de produto estão em `spec.md` § 3.

- **`PlanFiring` em `jsonl` global do plano, não no molde do journal por-entidade** — escolhido porque
  a leitura dominante é temporal e atravessa planos; rejeitado o molde `TaskJournalStore` (um arquivo
  por entidade) porque obrigaria a abrir N arquivos para a pergunta mais comum.
- **Invariante de D6 imposta no store, não no chamador** — escolhido porque é a única posição que
  sobrevive ao segundo chamador; rejeitado impor nas ferramentas Bridge porque a UI é uma segunda
  porta para o mesmo efeito, e ela chega depois (fatia E), quando ninguém está relendo este plano.
- **Módulo Bridge próprio desde o início** — escolhido porque `tools.ts` tem 6110 linhas e a SDD 489
  já extrai capacidades; rejeitado somar a `tools.ts` porque seria dívida que outra spec está pagando.
- **Catch-up construído ANTES do disparo** — escolhido porque D3 só é honesta se ele existir, e
  porque construir na ordem inversa cria a tentação de confiar no relógio; rejeitado deixá-lo por
  último (a ordem "natural") pela lição da borda de saída.
- **Poke do Planner é `host-poke`** — escolhido porque é o Tachyon falando sobre um estado vivo, e
  uma afirmação sobre estado vivo deixa de ser verdadeira quando o executor some
  (`NoticeQueue.ts:1`); rejeitado `agent-authored`, que sobreviveria ao executor e entregaria a
  cobrança de uma janela cujo dono não existe mais.
- **Seção de plano irmã da WORK ON RECORD, não dentro dela** — escolhido porque as duas respondem
  perguntas diferentes e `primer.ts:135` declara a origem da primeira; rejeitado fundir porque faria
  aquela declaração mentir.
- **`cardinality: "dashboard"`** — escolhido porque o escopo é o workspace (D5); rejeitado `document`
  (um painel por plano) porque D6 permite N planos e a superfície precisa mostrar o conflito ENTRE
  eles, o que dois painéis lado a lado não fazem.

---

## Files touched

**Novos**

| Caminho | Papel |
|---|---|
| `src/planner/types.ts` | `Plan`, `PlanEntry`, `PlanFiring`, `PlanEntryKind` (task \| marker) |
| `src/planner/PlanStore.ts` | persistência + invariante D6 na escrita |
| `src/planner/PlanFiringLog.ts` | `jsonl` append-only |
| `src/planner/PlanEngine.ts` | catch-up, avaliação D7, escada D2, checkpoint D9 — puro/injetável |
| `src/planner/progressSignal.ts` | D7 isolado e table-testable |
| `src/bridge/planner/tools.ts` | as oito portas |
| `src/webview/planner/` | o app |

**Alterados**

| Caminho | Mudança |
|---|---|
| `src/workspace/Workspace.ts` | instanciar store/engine; `planner.tick()` junto de `scheduler.tick()` (:5955); `activate()` para o catch-up |
| `src/humanInbox/model.ts` | braço `plan-overrun` em `HUMAN_INBOX_KINDS` (:37) |
| `src/agents/sessionWorkRecord.ts` | seção irmã com a janela aberta |
| `src/cockpit/model.ts` | `planner` em `CockpitSectionId` + `COCKPIT_SECTION_IDS` |
| `src/cockpit/sectionNav.ts` | tile em `NAV_BY_ID` + `LAUNCHER_ORDER` |
| `src/webview/webviewApps.ts` | linha em `WEBVIEW_APPS` (:94) |
| `esbuild.mjs` | linha correspondente em `WEBVIEW_APP_VIEWS` |

---

## Risks & unknowns

- **O maior risco é a segunda porta, e ele é conhecido pelo nome.** O efeito "uma entrada dispara" vai
  ser alcançável pelo tick, pelo catch-up de ativação e — na fatia E — por uma ação de UI. `0.56.159`
  passou verde exercitando um ponto de entrada enquanto cinco outros o contornavam. **Mitigação
  contratual:** a lista ATOR × GATILHO de `spec.md` § 4 é a lista de testes, com os mesmos nomes
  (AT1–AT13), e cada teste de roteamento **falha antes** de o roteamento existir.
- **Falso positivo de estagnação é o defeito caro desta spec.** D7 + D9 existem para evitá-lo, e o
  ponto frágil é a prova de entrega: se `onExpired` não for cabeado, o motor conclui estagnação sobre
  silêncio que ele mesmo causou. **Verificar cedo**, na fatia C, com TTL forçado.
- **Custo por tick não está medido, e a guidance manda medir frequência antes de custo.** O orçamento
  é 3 s; o consumidor é N entradas abertas × 2 campos. A expectativa é ruído, mas **expectativa não é
  medição** — a fatia C carrega uma medição com N realista, não uma impressão.
- **Fuso e horário de verão.** `Scheduler.targetToday` usa hora local (`Scheduler.ts:58`) e é diário;
  janelas de plano atravessam dias. Instantes ISO (D8) já evitam a pior classe do problema, mas a
  RENDERIZAÇÃO tem de declarar o fuso.
- **Não provado: como duas linhas do Inbox de planos diferentes se ordenam entre si.** O ranking de
  severidade do inbox (`model.ts:41`) argumenta cada posição; `plan-overrun` precisa do seu argumento
  antes de entrar, não depois.

---

## Visual impact

A fatia E cria uma superfície nova e altera duas existentes (o grid do launcher ganha um tile; o
Inbox ganha um tipo de linha). Conforme a guidance do repositório para trabalho visual:

- **A âncora é escrita ANTES da construção** e sai da declaração de problema da spec — não do que a
  tela acabar parecendo. Redação proposta: *"um humano vê, de relance, quais janelas estão abertas
  agora, quem é o dono de cada uma, e quais estouraram sem sinal — sem abrir nada."*
- **Duas larguras: 880 e 360.** Uma timeline é precisamente o tipo de layout que colapsa numa só —
  faixas por agente com largura não-limitada e linhas cuja proporção só se sustenta enquanto sobra
  espaço.
- **O tile do launcher precisa de antes E depois**: é grid compartilhado, e a spec não pode ser
  julgada só pela tela que a motivou.
- Evidência em `docs/specs/491-planner-time-axis-over-board/evidence/`.
- O verdict é **consultivo** e não bloqueia nada — é insumo para julgamento, e já se mediu neste
  repositório que ele erra (contraste reportado sobre botões que medem 13.01, `disabled` legítimo
  chamado de defeito).

---

## Sources consulted

| Fonte | O que estabeleceu |
|---|---|
| `src/tasks/types.ts:33` | `Task` não tem eixo temporal — o buraco que a spec preenche |
| `src/tasks/types.ts:59` | `JournalMode: "none"` + contagem: o modo barato que D7 exige |
| `src/tasks/types.ts:61` (`t-ab7708`) | journal materializado = 66,6% do custo de `get_task` |
| `src/tasks/TaskStore.ts:145` | Board em `workspaceRoot/.tachyon/tasks` — o escopo que D5 herda |
| `src/tasks/TaskJournalStore.ts:200` | append por-entidade — o molde REJEITADO para `PlanFiring` |
| `src/pins/PinStore.ts:4` | `withProcessLockSync` + "toda porta é uma porta" |
| `src/schedule/Scheduler.ts:5,23,58` | escopo workspace-aberto; forma injetável; hora local |
| `src/workspace/Workspace.ts:295,5955,6074,4413` | ticker 3 s; onde o tick entra; `runSchedule`; `enqueueNotice` |
| `src/bridge/NoticeQueue.ts:1,20,60` | semântica de origem; união que obriga a declarar; `onExpired` |
| `src/bridge/tools.ts:594` | `contextRenewalRequestRefusal` — as recusas que o motor grava |
| `src/humanInbox/model.ts:6,37,41` | roteador-não-resolvedor; `HUMAN_INBOX_KINDS`; ranking de severidade |
| `src/agents/sessionWorkRecord.ts:64,73` | onde a obrigação de plano entra como seção irmã |
| `src/bridge/primer.ts:111,135` | WORK ON RECORD é projetada do board — por que não fundir |
| `src/webview/webviewApps.ts:94,123` | manifesto de apps; `dashboard` vs `document` |
| `src/cockpit/model.ts`, `sectionNav.ts` | `COCKPIT_SECTION_ORDER` esvaziada; onde o tile entra |
| `src/worktree/managedWorktree.ts:37`, `ManagedWorktreeService.ts:94` | registro de worktrees é workspace-level (D5); `jsonl` como precedente |
| SDD 480 (`docs/specs/480-execution-graph/spec.md`) | "provado ou declarado não-provado"; processo vivo ≠ agente trabalhando |
| SDD 485 (`docs/specs/485-standalone-section-apps/`) | a forma de somar um app |
| SDD 489 | extração de módulos de capacidade do Bridge |
| `docs/project-guidance.md` | ator × gatilho vira lista de testes; borda de saída; medir frequência antes de custo; visual em duas larguras |
