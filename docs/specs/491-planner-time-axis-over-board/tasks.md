# 491 — planner-time-axis-over-board — tasks

_Gerado de `plan.md` em 2026-08-05. Trabalhe de cima para baixo. Se um passo revelar que o plano está
errado, corrija `plan.md` antes de continuar._

**As fatias A–E são entregáveis independentes** e cada uma é observável sem a próxima. Uma fatia
fecha quando seus critérios de `spec.md` § 5 podem ser marcados — não quando o código compila.

**Ordem inegociável dentro da fatia C:** o catch-up (C1) vem antes de qualquer disparo (C3+). É a
lição da borda de saída, e D3 só é honesta se ele existir.

**Regra que vale para todo teste de roteamento:** escreva o teste, **veja-o falhar**, só então
implemente. Em 2026-08-03 um guard estático escrito para fechar exatamente essa lacuna era ele
próprio cego — comparava texto de linha contra um corpo de `switch`, e toda violação passava. O
fail-before foi o único a pegar.

---

## Fatia A — modelo e store

- [ ] A1 `src/planner/types.ts`: `Plan`, `PlanEntry`, `PlanFiring`. A união task|marker é
      **discriminada**, para que "marcador com executor" não compile (D1)
- [ ] A2 `src/planner/PlanStore.ts`: raiz `workspaceRoot/.tachyon/plans` (D5), mutações serializadas,
      `withProcessLockSync` na escrita
- [ ] A3 `src/planner/PlanFiringLog.ts`: append-only em `jsonl`, um arquivo por workspace
- [ ] A4 Invariante D6 imposta **no store**: escrita que sobrepõe janela aberta da mesma task é
      recusada, e a recusa nomeia a entrada conflitante e seu plano
- [ ] A5 Unidades: entrada órfã (AT5), edição não reescreve `PlanFiring`, sobreposição entre planos
      e **dentro** de um plano, entradas sequenciais aceitas, rascunho não bloqueia
- [ ] A6 Prova negativa de A1: um teste de tipo confirma que `marker` + executor **não compila**

## Fatia B — portas Bridge

- [ ] B1 `src/bridge/planner/` como módulo próprio (não somar a `tools.ts`, 6110 linhas)
- [ ] B2 `create_plan`, `get_plan`, `list_plans`, `plan_status`
- [ ] B3 `add_plan_entry`, `update_plan_entry`, `remove_plan_entry`
- [ ] B4 `promote_marker` — cria a task e reaponta a entrada (D1); é gesto explícito, nunca efeito
      colateral
- [ ] B5 A recusa de D6 sai no formato contratual da 478 M6: nomeia o conserto
- [ ] B6 Autoria registrada na entrada; agente cria e altera plano **sem** aprovação

## Fatia C — motor

- [ ] **C1 Catch-up primeiro.** `activate()` reconcilia janelas perdidas, grava `missed` com o
      instante previsto real (D8), e apresenta antes de qualquer disparo novo (AT9)
- [ ] C2 `src/planner/progressSignal.ts`: D7 isolado e table-testable. Lê `journalCount` + timestamp
      da mais recente + `updatedAt`. **Nunca materializa o journal**
- [ ] C3 `src/planner/PlanEngine.ts` puro/injetável no molde de `Scheduler` (`getState`/`now`/`onFire`)
- [ ] C4 Cabear no `Workspace.tick()`, ao lado de `scheduler.tick()` (`Workspace.ts:5955`)
- [ ] C5 Roteamento de entrega via `enqueueNotice`, com `origin: "host-poke"`; resultado gravado no
      `PlanFiring` — entregue / recusado / expirado / executor ausente
- [ ] C6 Cabear `NoticeQueue.onExpired` (`NoticeQueue.ts:60`) na prova de entrega de D9
- [ ] C7 Escada D2: superfície → progresso? → poke no coordenador → Inbox
- [ ] C8 Braço `plan-overrun` em `HUMAN_INBOX_KINDS`, **derivado** (some sozinho) e **uma linha por
      plano**. Argumentar sua posição no ranking de severidade (`model.ts:41`) — não deixar implícito
- [ ] C9 Checkpoint D9: automático acima do limiar, constante nomeada e justificada em UM lugar;
      override nos dois sentidos; executor humano nunca recebe poke
- [ ] **C10 A escada não conclui estagnação sem entrega comprovada** (D9). Testar com TTL forçado
- [ ] C11 Testes AT1–AT13 nomeados como na tabela de `spec.md` § 4, cada um de roteamento
      **falhando antes**
- [ ] C12 **Medir** o custo por tick com N realista de entradas abertas. Registrar o número em
      `notes.md` — expectativa não é medição

## Fatia D — brief e renovação

- [ ] D1 Seção **irmã** da WORK ON RECORD em `sessionWorkRecord.ts` (nunca dentro dela)
- [ ] D2 Presente em spawn, restart, resume e fork — os quatro, porque são o mesmo ator em portas
      diferentes (AT8)
- [ ] D3 `renew_context(compact)` na fronteira entre entradas; recusa gravada, sem retry cego (AT7)

## Fatia E — app

- [ ] **E1 Escrever a âncora ANTES de construir**, em `notes.md`. Redação proposta em `plan.md`
- [ ] E2 Linha em `WEBVIEW_APPS` (`cardinality: "dashboard"`) e a correspondente em `esbuild.mjs`
- [ ] E3 `planner` em `CockpitSectionId` + `COCKPIT_SECTION_IDS` — **não** em `COCKPIT_SECTION_ORDER`
- [ ] E4 Tile em `NAV_BY_ID` + `LAUNCHER_ORDER` (`sectionNav.ts`)
- [ ] E5 `src/webview/planner/`: timeline com faixas por executor; schedules como fundo read-only (§ 4.3)
- [ ] E6 A UI declara, com essas palavras, que o plano só dispara com o workspace aberto (D3)
- [ ] E7 Strings humanas via `vscode.l10n.t(...)` e bundles atualizados
- [ ] E8 Evidência visual em **880 e 360**; o tile do launcher com **antes e depois**

---

## Verification

Cada item mapeia para um critério de `spec.md` § 5.

- [ ] Entrada não copia estado do Board; task removida deixa entrada órfã e visível
- [ ] Editar o plano não reescreve `PlanFiring`
- [ ] Sobreposição recusada entre planos **e** dentro de um; sequenciais aceitas; rascunho não bloqueia
- [ ] Catch-up reporta o instante real, não arredondado
- [ ] Agente ocupado sem avanço na task **não** conta como progresso
- [ ] Journal não é materializado na avaliação de progresso
- [ ] Checkpoint não entregue **impede** a conclusão de estagnação
- [ ] Executor morto não recebe poke; a linha vai ao Inbox
- [ ] Uma linha de Inbox por plano, derivada
- [ ] Obrigação sobrevive ao restart
- [ ] Spawn por plano exige aprovação humana
- [ ] Toda porta que dispara um agente tem teste que falhou antes

**Headless check:** `npm run verify:full:quiet`

**Verify:** `npm run verify:full:quiet`

## Dogfood

**Dogfood:** `node scripts/dogfood/run.mjs planner`

Cenário novo no runner existente (`scripts/dogfood/run.mjs`) — não um script de pacote avulso. Deve
exercitar, sem humano: criar plano e entrada pela porta Bridge; recusa de sobreposição nomeando o
conflito; janela abrindo com o executor vivo; entrega e a gravação do `PlanFiring`; e a reconciliação
de catch-up sobre uma janela deliberadamente perdida.

**Human dogfood:** abrir o Planner pelo tile do launcher; arrastar uma entrada e confirmar que os
disparos seguem a nova janela; confirmar que a frase da limitação de D3 está visível sem interação.

## Visual QA

Superfície nova (o app) mais duas existentes alteradas (grid do launcher, tipos de linha do Inbox).
O risco visual concreto é o de uma timeline: faixas por executor sem largura limitada, e linhas cuja
proporção só se sustenta enquanto sobra espaço — a classe de defeito que uma largura só esconde.

Âncora (escrita antes de construir, E1): *"um humano vê, de relance, quais janelas estão abertas
agora, quem é o dono de cada uma, e quais estouraram sem sinal — sem abrir nada."*

O verdict é **consultivo** e não bloqueia merge; já se mediu neste repositório que ele erra.

- [ ] Evidence:
- [ ] Verdict:

## Cookbook

**Cookbook:** yes

Oito portas Bridge novas (fatia B) são superfície de operador: quem for montar um cronograma precisa
saber o que a recusa de D6 significa e por que um rascunho não bloqueia. Escrever no ship, não antes.
