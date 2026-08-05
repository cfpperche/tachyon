# 491 — planner-time-axis-over-board

_Created 2026-08-05._

**Status:** draft

**Planning task:** `t-2bba9c`

**Origem:** sessão de brainstorm com o mantenedor em 2026-08-05, a partir do "Planejador" do Trello.

**Ratificação:** as nove decisões da § 3 foram argumentadas uma a uma e aceitas pelo mantenedor na
mesma sessão. D1–D4 saíram da estruturação inicial; **D5–D9 resolveram, uma por vez, as cinco
perguntas em aberto do rascunho**, e por isso a § 8 fechou vazia. Cada decisão registra as
alternativas rejeitadas com o motivo — é isso que impede a reintrodução silenciosa depois.

Duas decisões mudaram de forma durante a sessão e o registro preserva o porquê: **D2** começou como
"estouro vai para o Inbox" e virou uma escada com condição de estagnação (o custo de degradar o Inbox
superava o de deixar um atraso benigno só na timeline); e **D8** foi tomada depois de medir que o teto
de precisão que se supunha existir não existe (o ticker roda a 3 s).

---

## 1. Intent

O Tachyon tem duas superfícies de trabalho. O **Board** diz o que existe para fazer; o **Human
Inbox** diz o que espera por um humano. Nenhuma das duas diz **quando** — e a ausência é literal,
não interpretativa: `Task` (`src/tasks/types.ts:33`) carrega `status`, `priority`, `rank`, `deps` e
`assignee`, e nenhum campo de tempo. O Board é ordem mais dependência, e ordem não é cronograma:
ela responde "o que vem antes", nunca "isto começa terça e precisa estar de pé na quinta".

Existe um agendador, e ele não conhece o Board. `Scheduler` (`src/schedule/Scheduler.ts`) dispara
`every:`/`at:` e executa um comando/runbook ou spawna um agente
(`Workspace.runSchedule`, `src/workspace/Workspace.ts:6074`). Nenhum schedule referencia uma task,
porque schedules são automação de workspace — coisa que se repete independentemente do trabalho que
existe. Um cronograma é o oposto: é ligado a um trabalho específico e termina com ele.

Os mecanismos de **acordar um agente** também já existem, e existem soltos: `NoticeQueue`
(`src/bridge/NoticeQueue.ts`) com gating de idle, TTL e semântica de origem; `renew_context` com
suas recusas explícitas (`contextRenewalRequestRefusal`, `src/bridge/tools.ts:594`); continuity; e o
brief de startup que um agente recebe ao nascer, reiniciar ou retomar.

**O que falta não é um subsistema de execução. É o eixo do tempo que liga o Board a esses
mecanismos.** Um coordenador que monta um cronograma hoje o monta em prosa — no handoff, no journal,
na cabeça — e nada no produto o cobra depois. O plano não sobrevive ao fim do turno, não sobrevive à
troca de encarnação do agente, e não é visível para o humano enquanto acontece.

O Planner é a terceira ferramenta: **a superfície onde humano e agente montam e leem um cronograma
sobre trabalho que já está no Board, e a partir da qual o Tachyon dispara** — acorda o responsável
quando a janela abre, cobra checkpoint no meio, propõe renovação de contexto na fronteira entre
entradas, e escala quando a realidade contradiz o plano.

"Pronto" é: um humano abre o Planner, vê o cronograma da semana com faixas por agente, edita uma
entrada arrastando-a, e os disparos daquela entrada seguem a nova janela — e quando uma janela
estoura sem sinal de progresso, alguém é avisado sem depender de estar olhando para a tela.

### 1.1 O invariante central

> **O plano não possui trabalho. O plano possui tempo e sequência sobre trabalho que já está no
> Board.**

Uma `PlanEntry` **referencia** um `t-xxxxxx`. Ela não copia título, status nem assignee; lê tudo por
derivação. No minuto em que o plano puder carregar trabalho próprio, ele vira um segundo board, os
dois divergem, e o Board perde a autoridade que tem hoje sobre "isto foi feito".

O precedente é literal neste repositório: o Human Inbox é *"um roteador, não um resolvedor: lê todos
os stores, não escreve em nenhum"* (`src/humanInbox/model.ts:6`). O Planner assume a mesma postura
em relação ao Board — e, pelo mesmo motivo, em relação a `schedules` (§ 4.3).

---

## 2. Modelo

| Entidade | O que é | Campos próprios |
|---|---|---|
| `Plan` | um cronograma nomeado ("SDD 485 fase D", "semana 32") | id, título, autor, janela geral, status, revisão |
| `PlanEntry` | uma alocação no tempo | `taskId` **ou** `marker`; janela (`start`/`end`, ou `after: <entryId>`); executor (agente ou humano); política de checkpoint |
| `PlanFiring` | o registro do que o motor fez | entrada, momento previsto, momento real ou `missed`, ação, resultado (inclusive recusa) |

`Plan` e `PlanEntry` são **mutáveis**. `PlanFiring` é **append-only**, e essa assimetria é a
propriedade de integridade da spec: se editar o plano reescrevesse o histórico, seria possível mover
uma entrada depois do fato e fazer ontem parecer pontual. O precedente é o Execution Graph (SDD 480):
atribuição é provada ou declarada não-provada, nunca inferida em silêncio.

`marker` é uma entrada que representa um marco de tempo que **não é trabalho** e nunca será: prazo
externo, reunião, congelamento de `main`. Marcador não tem executor e não dispara agente.

---

## 3. Decisões tomadas

Cada uma foi argumentada contra suas alternativas; as alternativas rejeitadas ficam registradas
porque a razão da rejeição é o que impede a reintrodução depois.

### D1 — Entrada é `taskId` ou `marker`; promover é gesto explícito

Uma entrada referencia uma task **ou** é um marcador não-executável. Existe uma ação deliberada
"promover marcador a task", que cria a task e reaponta a entrada.

- **Rejeitado: entrada livre executável.** Task carrega journal, `deps`, transições
  `landed`/`done`, `attention`, evidência anexada e reconciliação. Uma entrada executável sem task
  teria de reimplementar tudo isso, e no dia em que as duas registrassem conclusão haveria dois
  lugares capazes de discordar sobre se o trabalho foi feito.
- **Rejeitado: abolir `marker` e mandar tudo para o Board.** O prazo do cliente viraria uma task
  falsa, e task falsa é indistinguível de trabalho real para `next_task`, para as contagens do
  board e para `attention`. O marcador ser um braço de tipo distinto é o que garante que
  `next_task` não possa retorná-lo.
- **Rejeitado: auto-criar task a partir de entrada livre.** Transformaria o Planner em fábrica de
  tasks: todo bloco de tempo apressado viraria linha no board. Higiene do board é julgamento do
  humano ou do coordenador — por isso promover é explícito, e não efeito colateral de arrastar um
  bloco no calendário.

### D2 — Estouro de janela é uma escada com condição de estagnação

1. Estouro **sempre** aparece na superfície do Planner (de graça, não perde nada).
2. Estouro **com sinal de progresso** — journal novo, status mexeu, execução ativa na janela — para
   aí: a estimativa estava errada, e isso é insumo de replanejamento, não decisão.
3. Estouro **sem sinal nenhum** → poke no coordenador.
4. Persistiu além do próximo marco → **uma** linha no Human Inbox **por plano** (nunca por entrada),
   **derivada** do estado: se o plano se recuperar, a linha desaparece sozinha.

- **Rejeitado: todo estouro no Inbox.** Treina o humano a ignorar o Inbox. É do mesmo naipe do
  contador de segurança que lê zero (`src/humanInbox/model.ts`, § 3 do cabeçalho): a superfície
  continua lá e para de significar alguma coisa. Como o Inbox é a superfície mais cara do produto, o
  custo de degradá-la excede o de deixar um atraso benigno visível apenas na timeline.
- **Rejeitado: deslizar calado.** Um plano que se reescreve para sempre estar em dia nunca pode
  estar errado, e o que não pode estar errado não carrega informação.
- **Rejeitado: visível só no Planner.** Exige alguém olhando. A premissa da ferramenta é o Tachyon
  lembrar.
- **Rejeitado: escalada terminando no coordenador.** O coordenador costuma ser justamente o que
  travou; se a escada termina nele, um coordenador morto ou preso engole o próprio alarme. Ele é
  degrau, não destino.
- **Derivada, não evento único**, porque um estouro emitido uma vez e nunca reavaliado é a borda de
  saída engolida: se o disparo se perde, o plano fica errado para sempre sem segunda chance.

### D3 — O tick fica preso ao workspace aberto nas fatias A–E; o daemon é a fatia F

A limitação é **dita na UI**, com essas palavras: este plano só dispara com o workspace aberto.

O argumento que decide não é custo. **A reconciliação de catch-up é obrigatória nos dois cenários** —
a máquina hiberna, o daemon cai, a unidade reinicia, o relógio pula. Construir F primeiro tenta a
pular o catch-up ("sempre dispara"), que é exatamente o bug da borda de saída que a guidance do
repositório descreve. Fazendo A–E antes, o catch-up é forçado a existir, e F depois vira
**estreitamento da janela perdida**, não um mecanismo em que se confia às cegas.

- **Rejeitado: construir F agora.** Arrasta três riscos não relacionados num pacote: lifecycle do
  engine, estado por workspace do daemon, e "quem autorizou este spawn às 3 da manhã" — que não é
  feature maior, é discussão de autoridade separada.
- **Rejeitado: nunca ter daemon.** Um plano noturno que só funciona se alguém deixou o VS Code
  aberto é meio produto. F é limitação com dono, não decisão encerrada.

### D4 — Nome: seção `planner`, entidades `Plan` / `PlanEntry`

- **Rejeitado: `schedule`/`cronograma`.** Colide com um mecanismo vivo que tem store próprio
  (`src/schedule/`), chave de config (`schedules`), tipo de proposta (`schedule-proposal` em
  `HUMAN_INBOX_KINDS`) e braço no Inbox. Duas coisas chamadas schedule que disparam timers é
  literalmente como o bug nasce.
- **Rejeitado: `timeline`.** Nomeia a view, não a coisa; o Planner terá mais de uma renderização.
- **Rejeitado: `agenda`.** Sugere o dia de uma pessoa; isto é coordenação de frota.
- **Colisão aceita:** `plan.md` de SDD é nome de arquivo, nunca id nem tipo. Em prosa há ambiguidade
  residual ("o plano da 485"), mitigada por chamar o documento sempre de `plan.md`.

### D5 — O escopo do Planner é exatamente o escopo do Board: o workspace

Ratificado em 2026-08-05. **Não é preferência — é forçado por D1 e pelo invariante da § 1.1:**

- a entrada **referencia** uma task, logo o plano precisa enxergar o Board que referencia →
  escopo do plano ⊇ escopo do Board;
- o plano **não possui trabalho próprio**, logo nada nele justifica enxergar mais que isso →
  escopo do plano ⊄ escopo do Board.

Portanto escopo do plano **=** escopo do Board, que é o workspace (`TaskStore`, `src/tasks/TaskStore.ts:145`,
grava em `workspaceRoot/.tachyon/tasks`). `Plan` mora no `.tachyon/` do workspace, ao lado de tasks,
pins, handoff, approvals, continuity e briefs.

- **Rejeitado: por worktree.** Ficaria abaixo do Board, e a entrada apontaria para trabalho que o
  próprio store não alcança. Custo concreto: AT12 (dois planos disputando a mesma task) passaria de
  detectável a **indetectável** — nenhum dos dois stores veria o outro e cada um se declararia
  consistente. É a divergência do invariante entrando pela porta do escopo em vez da porta do modelo.
- **Rejeitado: por Fleet (multi-workspace).** Mesmo cálculo na direção oposta: o Board não atravessa
  workspaces, então um plano que atravessasse referenciaria trabalho invisível.
- **A worktree não é um domínio independente**, e o repositório já diz isso: o registro DE worktrees
  é workspace-level (`managed-worktrees.json`, `src/worktree/managedWorktree.ts:37`;
  `worktree-hygiene.jsonl`, `ManagedWorktreeService.ts:94`). Um plano por worktree moraria dentro de
  uma coisa sobre a qual ele precisa poder falar.
- **O split existente confirma a categoria.** A `.tachyon/` de uma worktree carrega `evidence`,
  `designs`, `reviews`, `studies` — artefatos DO trabalho. A do workspace carrega coordenação SOBRE o
  trabalho. Plano é a segunda.

**Corolário que resolve a preocupação legítima do isolamento:** o executor É isolado à sua worktree,
mas isso é sobre o que a entrada DECLARA, não sobre onde o plano mora — **worktree é campo da
`PlanEntry`, não escopo do store**. AT10 (worktree removida → entrada inexecutável) vira comparação
de campo, e não varredura em N stores.

### D6 — N planos são permitidos; a restrição vive na task, não no plano

Ratificado em 2026-08-05.

> **Uma task tem no máximo uma entrada com janela ABERTA em todo o workspace.**

O problema real nunca foi "dois planos existem" — é o mesmo executor receber duas expectativas
contraditórias sobre a mesma task: dois pokes, duas escadas D2, dois prazos. E isso **acontece dentro
de um único plano também**: nada impede agendar `t-x` em duas janelas sobrepostas no mesmo
cronograma. Por isso a regra é escopada na task; escopá-la no plano seria escopá-la no objeto errado,
resolvendo o caso entre planos e deixando o caso interno passar.

Entradas **sequenciais** da mesma task continuam livres ("segunda de manhã e quinta à tarde"): a
regra é sobre **sobreposição**, não sobre repetição.

- **Rejeitado: um plano ativo por workspace.** Insuficiente (não cobre a sobreposição interna) e,
  pior, proíbe o uso que justifica a ferramenta — **rascunhar o plano da semana que vem enquanto o
  desta semana roda**. Planejar adiante é o ponto de um planejador.
- **Rejeitado: N planos com conflito apenas DETECTADO.** Detecção não é resolução. Enquanto alguém lê
  o aviso, as duas entradas disparam e o executor já recebeu as duas instruções. Aviso na tela não
  desfaz poke entregue.

**Duas portas, não uma** — o mesmo efeito é alcançável por caminhos diferentes, então a invariante é
imposta nas duas:

1. **Na escrita**, quando ambas as janelas já são conhecidas: a segunda entrada é **recusada**, e a
   recusa **nomeia** a entrada conflitante e seu plano (a postura contratual de "uma recusa precisa
   nomear o conserto", SDD 478 M6).
2. **Na abertura da janela**, para entradas `after:`, cuja sobreposição é indecidível até a
   predecessora fechar.

**Só entradas de um plano que DISPARA participam da restrição.** Um plano em rascunho não dispara e
portanto não bloqueia nada — é exatamente isso que libera o planejamento adiantado.

### D7 — "Sinal de progresso" é atribuído à TASK, nunca ao agente

Ratificado em 2026-08-05. O degrau 2 da escada D2 avalia exatamente dois sinais:

- **nota de journal nova na task dentro da janela**, ou
- **transição de status da task**.

**Por que os sinais do agente estão fora.** A SDD 480 mediu que *"um processo vivo não é um agente
trabalhando"* — liveness e atividade são fatos diferentes e ficam em campos diferentes. Um nível
acima, aqui: **um agente trabalhando não é uma task avançando.** Attention state, atividade no
Execution Graph e commits na worktree dizem que o executor está ocupado, e ele pode estar ocupado com
outra coisa ou preso num loop dentro desta. Usados como condição, fariam o estouro estagnado
desaparecer exatamente no caso que a escada existe para pegar: o agente que parece vivo e não avança.

Journal e status não têm esse problema por construção — são escritas no registro **daquela** task, já
carimbadas no tempo. Não precisam de atribuição: nascem atribuídos.

**Rejeitados como condição, com o motivo, para não voltarem:** `attention` do executor; atividade no
Execution Graph; commits na worktree; liveness do processo. Todos respondem "o agente está ocupado?",
e a pergunta da escada é "esta task avançou?".

**Custo — a regra é dura porque já foi paga uma vez.** A avaliação roda a cada tick, para cada entrada
aberta. `t-ab7708` mediu o journal materializado como **66,6% do custo total de `get_task`** e mais de
90% de suas piores chamadas (ver o comentário de `JournalWindow` em `src/tasks/types.ts:61`). Portanto:
**nunca materializar o journal para avaliar progresso** — lê-se `journalCount` mais o timestamp da
entrada mais recente e compara-se com a janela; `updatedAt` cobre a transição de status. Dois campos,
payload zero.

**O que os rejeitados ainda fazem.** `attention` do executor não é condição, mas é **diagnóstico** na
linha do Inbox: "sem sinal de avanço em `t-x` desde 14:20; executor `idle` há 40 min" serve a quem
decide. Informa, não decide.

**A ausência é declarada, não interpretada.** Sem journal novo e sem transição, a escada não conclui
"o agente não fez nada": conclui *"nenhum sinal de avanço foi medido nesta janela"*, e é isso que fica
escrito. Mesma postura do `authRequired` (SDD 477) — a falta de um sinal medido é uma declaração, não
licença para adivinhar.

### D8 — A janela é um instante, não um quantum: granularidade é da UI

Ratificado em 2026-08-05.

- **Modelo:** `start`/`end` são instantes ISO com precisão plena. Nenhum quantum.
- **UI:** *snap* de 15 min por padrão, ajustável — **affordance, não tipo**.
- **Marcadores:** flag `allDay`, não uma granularidade paralela.
- **D6:** sobreposição é aritmética exata de intervalos, mais simples que comparação quantizada.

**O teto de precisão que se supunha existir não existe — foi medido.** O ticker do workspace roda a
cada **3 s** (`ATTENTION_POLL_MS`, `src/workspace/Workspace.ts:295`) e `scheduler.tick()` pega carona
nele (`Workspace.ts:5955`). Somado ao custo-zero de D7 (dois campos por entrada aberta), a
granularidade **não compra desempenho nenhum**. Não havendo troca a fazer, escolhe-se o modelo mais
simples, e ele é grátis.

- **Rejeitado: quantizar o modelo (minuto / 15 min / hora / dia).** É o erro que D4 já rejeitou uma
  camada acima — deixar a conveniência do renderizador definir a entidade. D4 recusou o nome
  `timeline` por nomear a view; quantizar em 15 min é o mesmo com números. E o quantum é
  irreversível de graça: mudar de 15 para 5 min vira migração de dados, enquanto instante nunca vira.
- **Custo específico da quantização:** a reconciliação de catch-up (AT9) precisa dizer *"deveria ter
  aberto às 09:15"*. Um modelo quantizado a arredondaria para o quantum mais próximo exatamente no
  relatório cuja função é ser honesto sobre o que se perdeu.

**Por que 15 min continua certo — na UI.** Ninguém planeja frota ao minuto, e a timeline a 360 px não
renderiza quinze minutos legíveis. Mas isso é o renderizador escolhendo sua escala, e ele pode
escolher diferente em 880 e em 360 sem que o dado mude. Snap é sugestão; janela autorada por agente
via Bridge pode trazer qualquer instante, e nada quebra.

**A limitação honesta não muda:** a precisão de segundos vale **com o workspace aberto** (D3). A UI
não pode sugerir confiabilidade ao minuto atravessando um período fechado — é a frase de D3, não uma
nova.

### D9 — O checkpoint é o instrumento que D7 mede, e por isso é automático acima de um limiar

Ratificado em 2026-08-05.

**O checkpoint não é cortesia — é a peça que impede D7 de produzir falso positivo.** D7 mede
estagnação por nota de journal ou transição de status. Um agente saudável trabalhando em silêncio
numa janela de 4 h não produz nenhum dos dois, e a escada concluiria estagnação sobre quem está
avançando bem. O checkpoint **fabrica o sinal** que D7 lê.

**Regra:** automático quando a janela excede um **limiar único e declarado** (proposta: **1 h**),
disparando na metade. Override por entrada nos **dois** sentidos — forçar em janela curta, suprimir em
janela longa. O limiar é uma constante nomeada e justificada em um lugar, nunca gosto por entrada.

A derivação: o checkpoint existe onde *"ainda sem sinal"* é **informativo**. Em janela curta não é
(ninguém escreve journal em 20 min); o limiar é o ponto onde passa a ser.

- **Rejeitado: opt-in puro.** Quem esquece de marcar não ganha menos ruído — ganha **escalada falsa**.
  Um default cujo esquecimento produz alarme errado não é default seguro.
- **Rejeitado: sempre ligado.** Em janela curta interrompe sem comprar informação.

**O fecho de entrega, que é a parte que faltava.** O checkpoint é entregue pelo `NoticeQueue`, que
faz gating por idle e tem TTL (`src/bridge/NoticeQueue.ts`) — ou seja, **pode não chegar**. Se não
chegar, o executor não produz sinal e D7 escalaria por um silêncio que o próprio Tachyon causou.
Portanto:

> A escada só pode concluir **estagnação** se o checkpoint foi **comprovadamente entregue**. Sem
> entrega comprovada, a conclusão é outra: *"sinal não medido — o checkpoint não foi entregue"*.

São duas afirmações com **donos diferentes**: a primeira é sobre o executor; a segunda é sobre o
Tachyon, e roteia para outro lugar porque é defeito nosso e não atraso dele. Extensão natural de AT7
— a recusa é fato gravado no `PlanFiring` — agora aplicada também à **entrega**.

**Executor humano:** entrada com executor humano não recebe poke; o checkpoint vira marca na
superfície do Planner e nada mais.

---

## 4. Ator × Gatilho

A guidance do repositório exige esta lista antes de adicionar comportamento a um mecanismo, e ela é
a **lista de casos de teste, nomeada do mesmo jeito**. Atores: Humano (Interface), Agente (Bridge),
Tachyon.

| # | Ator × Gatilho | Comportamento exigido |
|---|---|---|
| AT1 | Humano cria/edita entrada pela UI | reagenda; `PlanFiring` passados não são reescritos |
| AT2 | Agente cria/edita via Bridge | idem, com autor registrado na entrada |
| AT3 | Agente pede spawn por entrada de plano | **ação governada** → aprovação humana, mesma porta de `propose_schedule` |
| AT4 | Task muda de status fora do plano | entrada reconcilia por derivação; nunca por cópia |
| AT5 | Task referenciada é `dropped`/removida | entrada fica **órfã e visível**, não desaparece |
| AT6 | Executor designado dismissed/morto na hora do disparo | roteia para o Inbox; **nunca** poke em painel morto |
| AT7 | Executor ocupado / `needs-input` no disparo | a recusa (`tools.ts:594`) é **fato gravado** no `PlanFiring`, não retry cego |
| AT8 | Restart / resume / fork do executor durante a janela | nova encarnação herda a obrigação via brief de startup |
| AT9 | Workspace ativa após período fechado | **reconciliação de catch-up**: o que deveria ter disparado é listado como `missed` e apresentado |
| AT10 | Worktree do executor removido | entrada marcada inexecutável e sinalizada |
| AT11 | Entrada `after:` cuja predecessora nunca fecha | não dispara e não fica invisível: entra na escada D2 |
| AT12 | Segunda entrada sobrepõe janela aberta da mesma task (entre planos **ou** dentro de um) | **recusada na escrita**, nomeando a entrada conflitante e seu plano (D6) |
| AT13 | Entrada `after:` cuja janela, ao resolver, sobrepõe outra da mesma task | mesma invariante imposta **na abertura**; a entrada não dispara e entra na escada D2 (D6, porta 2) |

### 4.1 O que o motor dispara

| Momento | Ação | Destino e razão |
|---|---|---|
| janela abre | poke nomeando a task e a expectativa | informação para quem trabalha |
| meio da janela | checkpoint barato ("declare progresso em `t-x`") | nudge, não decisão |
| fronteira entre entradas | `renew_context(compact)` | é onde um coordenador longo precisa compactar |
| janela estoura | escada D2 | um estouro estagnado é decisão; um estouro com progresso não é |
| executor ausente | Human Inbox | AT6 |

### 4.2 O plano alimenta o brief

O plano é fonte para o **brief de startup** e para `renew_context`, não só para pokes. Um agente que
nasce ou reinicia dentro de uma janela ativa vê a entrada no próprio brief, do mesmo modo que hoje vê
"WORK ON RECORD". É isso que faz o plano sobreviver à troca de encarnação **sem mecanismo novo** — e é
a resposta a AT8, que é o caso `t-e73e54` (mesmo ator, outra porta) aplicado a este subsistema.

### 4.3 Relação com `schedules`

Uma entrada recorrente ("triagem do board às 09:00") **é** um schedule. O Planner **renderiza** os
schedules como faixas de fundo somente-leitura na mesma linha do tempo e **não os possui** — mesma
postura de projeção-e-não-substituição que o Inbox tem com approvals/validations. Um mecanismo de
agendamento, duas leituras.

---

## 5. Acceptance criteria

### Modelo e integridade

- [ ] **Scenario: entrada não copia estado do Board**
  - **Given** uma `PlanEntry` referenciando `t-abc123` com título "X" e status `active`
  - **When** a task é renomeada para "Y" e movida para `landed` pelo Board
  - **Then** a entrada exibe "Y" e `landed` sem qualquer escrita no store do Planner
- [ ] **Scenario: editar o plano não reescreve o histórico**
  - **Given** uma entrada cuja janela já abriu e cujo `PlanFiring` registra o disparo
  - **When** a janela é movida para o futuro
  - **Then** o `PlanFiring` anterior permanece íntegro e legível, e a revisão do `Plan` avança
- [ ] **Scenario: task removida deixa a entrada órfã e visível** (AT5)
  - **Given** uma entrada referenciando `t-abc123`
  - **When** `t-abc123` passa a `dropped`
  - **Then** a entrada é exibida como órfã, com a razão, e não é removida nem silenciada
- [ ] `marker` não aceita executor, e nenhuma porta permite atribuí-lo a um agente
- [ ] `next_task` nunca retorna um `marker` (garantido por tipo, não por filtro em runtime)
- [ ] `Plan` é persistido no `.tachyon/` do **workspace**, no mesmo escopo do Board — nenhum estado de
      plano é gravado na `.tachyon/` de uma worktree (D5)
- [ ] **Scenario: executor em worktree é campo, não escopo** (D5 / AT10)
  - **Given** uma entrada cujo executor trabalha numa worktree gerenciada
  - **When** essa worktree é removida
  - **Then** a entrada é marcada inexecutável comparando o campo da própria entrada, sem que exista
    qualquer store de plano dentro daquela worktree para consultar

### Disparo, recusa e catch-up

- [ ] **Scenario: catch-up após workspace fechado** (AT9)
  - **Given** duas entradas cujas janelas abriram enquanto o workspace estava fechado
  - **When** o workspace ativa
  - **Then** ambas constam como `missed` com o horário previsto, e a reconciliação é apresentada
    antes de qualquer disparo novo
- [ ] **Scenario: recusa de renovação é gravada, não retentada** (AT7)
  - **Given** uma fronteira de entrada que pediria `renew_context(compact)`
  - **When** o executor tem aprovação humana pendente (recusa de `contextRenewalRequestRefusal`)
  - **Then** o `PlanFiring` grava a recusa com a razão e o motor não repete a chamada nesse marco
- [ ] **Scenario: executor morto não recebe poke** (AT6)
  - **Given** uma entrada cujo executor foi dismissed
  - **When** a janela abre
  - **Then** nada é entregue ao painel do executor e uma linha aparece no Human Inbox
- [ ] **Scenario: estouro com progresso não chega ao Inbox** (D2)
  - **Given** uma entrada estourada cuja task recebeu nota de journal dentro da janela
  - **When** o motor avalia o estouro
  - **Then** a superfície do Planner marca o atraso e o Human Inbox permanece inalterado
- [ ] **Scenario: estouro estagnado escala uma vez por plano** (D2)
  - **Given** três entradas estouradas sem sinal de progresso no mesmo plano, além do marco seguinte
  - **When** o motor avalia
  - **Then** existe exatamente uma linha no Human Inbox para aquele plano
- [ ] **Scenario: a linha do Inbox é derivada** (D2)
  - **Given** a linha de estouro do cenário anterior
  - **When** as entradas voltam a apresentar progresso
  - **Then** a linha deixa de existir sem qualquer ação humana
- [ ] **Scenario: agente ocupado sem avanço na task NÃO conta como progresso** (D7)
  - **Given** uma entrada estourada cujo executor está `working`, com execuções ativas no Execution
    Graph, e cuja task não recebeu nota de journal nem transição de status dentro da janela
  - **When** o motor avalia o estouro
  - **Then** a escada trata como estagnado e prossegue ao degrau 3
- [ ] **Scenario: o journal não é materializado para avaliar progresso** (D7)
  - **Given** uma task com journal grande e uma entrada aberta
  - **When** o motor avalia progresso a cada tick
  - **Then** a avaliação lê apenas contagem, timestamp da entrada mais recente e `updatedAt`, e
    nenhuma entrada de journal é materializada
- [ ] A linha do Inbox declara *"nenhum sinal de avanço foi medido nesta janela"* — nunca uma
      afirmação sobre o que o agente fez ou deixou de fazer (D7)
- [ ] `attention` do executor aparece na linha do Inbox como **diagnóstico** e não participa da
      condição da escada (D7)
- [ ] **Scenario: checkpoint não entregue impede a conclusão de estagnação** (D9)
  - **Given** uma entrada longa cujo checkpoint foi enfileirado e expirou por TTL sem entrega
  - **When** a janela estoura sem sinal de progresso
  - **Then** a escada NÃO conclui estagnação; registra *"sinal não medido — o checkpoint não foi
    entregue"*, e essa conclusão roteia como defeito do Tachyon, não como atraso do executor
- [ ] **Scenario: janela curta não recebe checkpoint** (D9)
  - **Given** uma entrada de 20 min sem override
  - **When** a janela avança até a metade
  - **Then** nenhum checkpoint é disparado
- [ ] **Scenario: override força e suprime** (D9)
  - **Given** uma entrada curta com checkpoint forçado e uma entrada longa com checkpoint suprimido
  - **When** ambas atingem a metade da janela
  - **Then** a curta dispara o checkpoint e a longa não
- [ ] O limiar de duração é uma constante única, nomeada e justificada em um só lugar (D9)
- [ ] Entrada com executor humano nunca gera poke de checkpoint (D9)
- [ ] **Scenario: obrigação sobrevive ao restart** (AT8)
  - **Given** um agente executor com uma entrada em janela aberta
  - **When** o agente é reiniciado
  - **Then** o brief de startup da nova encarnação nomeia a entrada e sua task
- [ ] Toda porta capaz de disparar um agente a partir do plano é enumerada em `plan.md` e cada uma
      tem um teste que **falha antes** de existir o roteamento (lição do `0.56.159`)

### Unicidade da janela aberta (D6)

- [ ] **Scenario: sobreposição entre planos é recusada na escrita** (AT12)
  - **Given** o plano P1 com uma entrada de janela aberta para `t-abc123`
  - **When** o plano P2 tenta adicionar uma entrada para `t-abc123` com janela sobreposta
  - **Then** a escrita é recusada e a mensagem nomeia a entrada de P1 e o próprio P1
- [ ] **Scenario: a mesma regra vale DENTRO de um plano** (AT12)
  - **Given** o plano P1 com uma entrada de janela aberta para `t-abc123`
  - **When** P1 tenta adicionar uma segunda entrada sobreposta para `t-abc123`
  - **Then** a escrita é recusada com a mesma mensagem — a regra não conhece fronteira de plano
- [ ] **Scenario: `after:` é verificado na abertura** (AT13)
  - **Given** uma entrada `after:` para `t-abc123` cuja janela ainda não resolveu
  - **When** a predecessora fecha e a janela resolvida sobrepõe outra entrada aberta de `t-abc123`
  - **Then** a entrada não dispara, e o conflito é tratado pela escada D2
- [ ] **Scenario: rascunho não bloqueia planejamento adiantado** (D6)
  - **Given** um plano que dispara, com entrada aberta para `t-abc123`
  - **When** um plano em rascunho adiciona uma entrada sobreposta para `t-abc123`
  - **Then** a escrita é aceita, e nada dispara a partir do rascunho
- [ ] Entradas **sequenciais** (não sobrepostas) da mesma task são aceitas em qualquer quantidade
- [ ] A checagem de sobreposição é aritmética exata de intervalos, sem arredondar para quantum (D8)

### Granularidade (D8)

- [ ] `start`/`end` são instantes ISO de precisão plena; nenhum quantum aparece no modelo, no store
      nem nas portas Bridge
- [ ] **Scenario: o catch-up reporta o instante real** (AT9 / D8)
  - **Given** uma entrada cuja janela abriria às 09:07 com o workspace fechado
  - **When** o workspace ativa e a reconciliação é apresentada
  - **Then** ela informa 09:07, e não um valor arredondado para a escala da UI
- [ ] O *snap* de 15 min é comportamento da UI e pode diferir entre 880 e 360 sem alterar o dado
- [ ] Uma janela autorada por agente via Bridge com instante fora do snap é aceita sem erro

### Autoridade

- [ ] **Scenario: spawn por plano exige aprovação** (AT3)
  - **Given** uma entrada cujo executor não está vivo e cuja política pede spawn
  - **When** a janela abre
  - **Then** uma aprovação humana é criada e nenhum agente é spawnado antes da decisão
- [ ] Um agente pode criar e alterar planos sem aprovação; a autoria fica registrada na entrada

### Superfície

- [ ] O Planner é um app standalone na forma da SDD 485 (tile no launcher + linha em `WEBVIEW_APPS`)
- [ ] A UI declara, com essas palavras, que o plano só dispara com o workspace aberto (D3)
- [ ] Evidência visual em **880 e 360**, com a âncora escrita **antes** da construção

---

## 6. Fatiamento

| Fatia | Entrega |
|---|---|
| **A** | Modelo + store (`.tachyon/plans/`), invariante de referência, `PlanFiring` append-only |
| **B** | Portas Bridge: `create_plan`, `add_plan_entry`, `update_plan_entry`, `plan_status` |
| **C** | Motor de disparo + catch-up + escada D2 + roteamento poke/Inbox |
| **D** | Plano no brief de startup e em `renew_context` |
| **E** | App standalone `planner` |
| **F** | Tick no engine daemon — **fora desta spec**, com discussão de autoridade própria |

---

## 7. Non-goals

- **Não é um segundo board.** O Planner não cria, fecha nem reordena trabalho; escreve tempo.
- **Não substitui `schedules`.** Projeta-os somente-leitura (§ 4.3).
- **Não dispara com o workspace fechado** nesta spec (D3); a fatia F é trabalho futuro declarado.
- **Não estima nem prevê.** Janelas são autoradas por humano ou agente; o Planner não sugere
  duração, não calcula caminho crítico e não replaneja sozinho.
- **Não é calendário pessoal.** Não integra Google/Outlook e não modela o dia de uma pessoa.
- **Não altera o modelo de `Task`.** Nenhum campo de tempo entra em `src/tasks/types.ts`.

---

## 8. Open questions

**Nenhuma.** As cinco perguntas do rascunho de 2026-08-05 foram todas resolvidas na mesma sessão e
promovidas a decisões: escopo → **D5**, número de planos → **D6**, sinal de progresso → **D7**,
granularidade → **D8**, checkpoint → **D9**.

O que resta em aberto pertence ao `plan.md` (como construir), não a esta spec (o que construir). Duas
questões conhecidas de implementação, registradas aqui para não se perderem:

- **Onde o motor roda dentro do `Workspace.tick()`** — junto de `scheduler.tick()` (`Workspace.ts:5955`)
  ou como serviço próprio com seu ciclo.
- **Se `PlanFiring` compartilha o mecanismo de append-only do journal de Task** ou usa `jsonl` próprio
  como `worktree-hygiene.jsonl`.
