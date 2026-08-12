# Uma entrega para TUI, não quatro

Medição e desenho para `t-a5b186`. Zero código em `src/` / `test/`. Inventário por leitura no ponto de
uso (grep + open do caller), reutilizando o vocabulário de `docs/research/t-7a297f-delivery-truth.md`.

**Premissa do dono (aceita; fecha o desenho):** `tmux send-keys` já escreve no PTY. O composer da TUI não
é camada acima do PTY — é o que o programa de tela cheia faz com os bytes. Não existe canal "por baixo".
Confiabilidade não vem de escrever "mais direto"; vem de **não depender da escrita**.

**Task irmã:** `t-ba5357` (composerrule) mede regras de continuação de composer. Este documento não
redefine perfis; só nomeia o que cada caminho faz **hoje** quando o perfil existe ou não.

---

## 1. As três primitivas (medidas no ponto de uso)

| Primitiva | Arquivo | O que faz | O que **não** faz |
| --- | --- | --- | --- |
| `tmux.sendKeys(session, text, submit)` | `src/tmux/TmuxService.ts` | Cola texto (`send-keys -l` ou bracketed paste) e, se `submit`, manda um `C-m` cego | Não captura pane, não classifica composer, não repete Enter, não devolve recibo |
| `tmux.sendSubmittedLine(session, line, {composer?})` | mesmo | Digita o texto **uma vez**, espera ~180 ms, manda Enter, **repete só Enter** se o perfil disser `holds-text` (até 3 retries) | Não espera composer livre antes de digitar; sem `composer` cai na heurística legada `looksLikeStrandedSubmittedLine` |
| `AgentManager.sendStopText` (`t-ab2682`) | `src/agents/AgentManager.ts` | Espera composer **livre**, digita **uma vez**, só aperta Enter enquanto `composerText === text`, tenta limpar draft com `C-c` | Sem perfil medido → fallback **cego** para `sendKeys(..., true)` e return early se nunca liberar |

Recibo de `sendSubmittedLine` (`SubmitReceipt`):

- `submitted` + `composer-cleared` \| `no-stranded-line`
- `submit-unconfirmed` + `still-staged` \| `composer-diverged` \| `composer-unreadable` \| `capture-failed`

`sendManagedAgentInput` (`src/agents/agentInputService.ts`) **não é uma quarta primitiva** — é um
wrapper de liveness que chama **só** `sendKeys`. É o caminho cego com roupagem de serviço.

---

## 2. Inventário: todo caminho de produto que escreve num pane de agente

Colunas:

- **Primitiva** — o que toca o pane no final
- **Durável?** — existe registro em disco do **conteúdo** que sobrevive se a digitação falhar (não conta
  "o humano pode olhar o Activity")
- **Retry?** — re-tentativa de entrega (fila / loop de Enter / poll)
- **Recibo** — o que o caller vê
- **Quem paga** — se a entrega se perde ou mente, quem sofre

### 2.1 Caminhos de conteúdo (texto que deve iniciar ou continuar um turno)

| # | Caminho | Caller(s) | Primitiva | Durável? | Retry? | Recibo | Quem paga |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | `notify_agent` | Bridge MCP | `deliverNotice` → `submitNoticeLine` → **`sendSubmittedLine` + perfil** (fallback Bridge: `deliverNoticeFallback`) | **Sim** — `appendDoorbellEvent` → `.tachyon/doorbells.jsonl` **antes** da digitação; `read_notices` puxa | Fila se busy/throttled/needs-input/draft; Enter retry em `sendSubmittedLine`; flush em idle **não consome** se `submit-unconfirmed` | `notified` / `queued` / `held-human-draft` / `submit-unconfirmed` / `refused-not-ready` | Coordenação agent→agent. Pane falha **não apaga** o registro. Pagador residual: agente que **não chama** `read_notices` (medido em t-7a297f: 3 calls no histórico) |
| B | `write_input` submit | Bridge MCP | **`sendSubmittedLine` + perfil**; sem função: `sendKeys` cego | **Não** | Só Enter retry; **recusa** busy/composer (não enfileira) | `submitted` / `submit-unconfirmed` / `answered-prompt` / `refused-*` | Gesto de comando do caller (linha de autoridade). Humano/agente que mandou o comando |
| C | `write_input` submit=false | Bridge MCP | `sendKeys(..., false)` | Não | Não | `typed-unsubmitted` | Caller — deixa texto no composer de propósito |
| D | `write_input` bootstrap answer | Bridge MCP (`answering` + not ready) | literal-key → `sendKeys` sem submit; senão `sendSubmittedLine` **sem perfil** no call site | Não | Enter retry se `sendSubmittedLine` | `answered-bootstrap` / `refused-not-ready` | First-contract; caller. Perfil omitido = confirmação mais fraca (medido no call site `communication-io.ts`) |
| E | `agent.input` / Design Mode chat / handoff distill / Activity `sendAgentInput` | Engine `agent.input` ← ActivityTarget / ide-browser-bridge Design Mode / `handoffDistillService` / Activity share (stage) | **`sendManagedAgentInput` → `sendKeys` cego** | Design Mode grava chat **depois** do await (ordem: send, *então* `appendDmChatEvent`) — se o Enter se perde, o UI pode mentir "enviado". Handoff: prompt **não** é doorbell. Activity share: stage only (`submit=false`) | Engine recusa submit se probe de composer ocupado (`t-348c9a`); **sem** Enter retry, **sem** `submit-unconfirmed` | Sucesso void / erro liveness / `refused-composer` no engine | **Humano** (Design Mode = incidente `t-b09d9c`). Handoff: produto + operador. Este é o buraco que o dono tocou |
| F | `prompt.inject` submit | Extension op / sidebar template | **`sendSubmittedLine` + perfil** + `submitRefuseReason` | Não (template está em PromptStore; a **injeção** não) | Enter retry | `{injected, mode:"submit"}` ou throw refuse | Humano operador |
| G | `prompt.inject` stage / Agent pane stage | Extension / AgentPanePanel | `sendKeys(..., false)` | Não | Não | stage | Humano — intencional |
| H | Agent pane freeform submit | `extension.ts` `deliverText` → AgentPanePanel | **`sendSubmittedLine` sem `composer` no call site** | Não | Enter retry legada (sem perfil) | void do deliverText | Humano no pane webview; confirmação mais fraca que `prompt.inject` |
| I | Companion `companionSendPrompt` | Companion HTTP | `deliverNotice` → **`sendSubmittedLine` + perfil** | **Não** grava `doorbells.jsonl` (só fila em memória se busy) | Fila + Enter retry | `status` de `NoticeDeliveryResult` | Humano no companion; se processo morre com fila cheia, a mensagem some |
| J | Approval resolution inject | `approvalResolutionPorts` ← VS Code command + Companion | `deliverNotice` (queue-aware; `t-d79534`) | Decisão de approval é durável em `.tachyon/approvals/`; a **linha no pane** não é doorbell | Fila + Enter retry | `tmux:…` / `queued:…` / error `submit-unconfirmed` | Agente requester; decisão em disco sobrevive, wake pode atrasar |
| K | Validation close wake | `wakeValidationClosedAuthors` ← engine `validation.close` + BoardTarget in-process | **`sendSubmittedLine` direto, sem `deliverNotice`, sem perfil** no inject | Close da validation é durável; wake não | Só Enter retry legada; **sem fila** se author busy | delivery row offline / inject-error | Autor/assignee da validation. **Mais fraco que o twin de approval** (medido) |
| L | Task assignee / journal wake | `wakeTaskAssignee` / `notifyTaskAssignee` | `deliverNotice` | **Não** doorbell; task no board é a carga real | Fila + Enter retry | best-effort (erros engolidos) | Assignee pode não acordar; task no board permanece |
| M | Host pokes (death, needs-input, throttle, auth) | `Workspace.pokeParentOn*` | `deliverNotice` origin `host-poke` | Fila **só memória**; TTL 10 min; **não** `doorbells.jsonl` | Fila; drop se child morreu (`host-poke` + dismiss) | best-effort | Parent coordination; claim sobre estado **vivo** — perder depois que o filho morreu é desejável |
| N | Temporary backstop / gated completion / runtime slack / client rebind initiator | monitores + `clientRebind` | `deliverNotice` | gated: estado de candidate em disco; linha em si não é doorbell (`GatedCompletionMonitor` documenta "Never writes doorbells.jsonl") | Fila | best-effort | Parent; gated prova HEAD em disco mesmo se poke falha |
| O | Continuity inject (UI) | `Workspace.injectContinuity` | **`sendKeys(..., true)` cego** | Brief em `.tachyon/continuity/`; o **nudge** no pane não | Não | void best-effort | Agente pode não ver o nudge; brief permanece legível via ferramenta |
| P | Schedule `spawn` com agente já up + `instructions` | `Workspace.runSchedule` | **`sendKeys(..., true)` cego** | Def do schedule em config | Não | void | Trabalho agendado pode não rodar o prompt |
| Q | Resume `injectPrimer:true` | `AgentManager` resume opt-in | **`sendKeys` do primer cego** | Primer é regenerável; transcript/resume state em ledger | Não | void | Orientação; default resume **não** cola primer |

### 2.2 Caminhos de controle (não são "mensagem"; são tecla / comando de lifecycle)

| # | Caminho | Primitiva | Durável? | Retry? | Recibo / sinal | Quem paga |
| --- | --- | --- | --- | --- | --- | --- |
| R | Graceful stop text (`/exit` etc.) | **`sendStopText`** (ou `sendKeys` cego sem perfil) | N/A (gesto) | Poll free + até 3 Enter; C-c limpa draft | `stop-failed` row se não morrer no budget | Lifecycle; humano vê stop falho |
| S | Stop keys / interrupt (`sendKey`, Escape, C-c) | `tmux.sendKey` | N/A | Por step da sequência | exceção se tmux falha | Lifecycle |
| T | Rate-limit auto-continue | `sendKeys("", true)` = **Enter nu** | N/A | Re-arma backoff; **pula** se draft humano (`t-a53dd9`) | silencioso se held | Produto tenta retomar throttled; se Enter em draft → humano pagaria (guard existe) |
| U | Context renewal compact/fresh | `submitNoticeLine` → **`sendSubmittedLine` + perfil** | Pending in-memory; recusa se draft ou approval pendente | Enter retry; **não** re-enfileira se unconfirmed (apaga pending + warn) | host notify se unconfirmed | Agente perde renovação de contexto; humano é avisado |

### 2.3 O que **não** é escrita em pane (para fechar o inventário)

| Mecanismo | Como chega no runtime | Nota |
| --- | --- | --- |
| Spawn / restart brief + primer | Argv posicional / env (`composeCommand`, `HERMES_TUI_QUERY`, brief file + pointer) | **Não** passa por `sendKeys` no spawn normal. Contrato de first-line é do CLI, não do composer |
| Hooks de runtime (handoff remind, etc.) | Mecanismo nativo do runtime quando existe | Fora deste inventário de PTY write |
| `read_notices` | Pull do disco | Leitura; é a âncora de "não depender da escrita" |

Se um caminho novo aparecer e chamar `sendKeys`/`sendSubmittedLine`/`sendKey` em `src/`, ele entra nesta
tabela. A varredura de 2026-08-12 cobriu os call sites de produção listados por grep em `src/` (exceto
testes).

---

## 3. Classificação por peso do erro

O padrão **pode** (e deve) tratar classes diferentes. Uma entrega do produto perdida ≠ mensagem do
humano perdida ≠ Enter de lifecycle.

| Classe | Exemplos | Perda silenciosa custa | Exigência mínima |
| --- | --- | --- | --- |
| **C1 — Relato de trabalho (agent-authored)** | `notify_agent` completion | Coordenador descarta filho; trabalho "sumiu" | Durável **antes** do pane; batida idempotente; recibo honesto; pull (`read_notices`) |
| **C2 — Mensagem humana que inicia turno** | Design Mode chat, Companion prompt, schedule instructions, prompt inject submit, Agent pane submit | Humano acha que pediu e o agente nunca viu (`t-b09d9c`) | Durável do **intent** antes/atomicamente com a tentativa; primitiva confirmada; UI não marca "enviado" sem evidência |
| **C3 — Comando lineage (agent→child pane)** | `write_input` | Caller erra timing; pior se enfileirar em silêncio | Recusar busy (não filar); primitiva confirmada; sem inventar chat |
| **C4 — Wake de registro já durável** | Approval resolve, validation close, task assign | Decisão/task existem; agente só não acorda | Fila + primitiva confirmada basta; **não** precisa segundo barramento; perde-se só latência |
| **C5 — Claim sobre estado vivo (host-poke)** | child exited / needs-input / throttle / backstop | Parent age sem saber; claim **fica falso** se o filho morre | Fila ok; TTL/dismiss rules; **não** eternizar no doorbell de conteúdo |
| **C6 — Controle de processo** | stop, bare Enter continue, context renewal gesture | Processo zumbi / draft submetido / context stuck | Occupancy-first (estilo `sendStopText` / guards existentes); sem "mensagem" |

---

## 4. O padrão único proposto

### 4.1 Escolha (uma peça, alcançando todos os caminhos)

**Nome:** *durable-first doorbell* (já implementado de ponta a ponta em `notify_agent` + `deliverNotice` +
`sendSubmittedLine`).

Não é barramento novo. É **generalizar o caminho A** e **apagar o atalho E** (e os cegos O/P/Q de
conteúdo) para que todo texto submetido ao composer use a **mesma** escada:

```
1. PERSISTIR a carga (ou apontar para carga já durável)
2. BATIDA no pane via sendSubmittedLine(session, line, { composer: profile? })
3. RECIBO honesto (notified | queued | held-human-draft | submit-unconfirmed)
4. SE a batida falhar: a carga ainda existe; re-bater é barato e não duplica a carga
```

Peças reutilizadas, cada uma no papel que já tem:

| Peça existente | Papel no padrão |
| --- | --- |
| `appendDoorbellEvent` / `read_notices` / fila `NoticeQueue` | Persistência + drain para **C1** (e, se o dono quiser, um journal de intent para **C2**) |
| `Workspace.deliverNotice` + `submitNoticeLine` | Política de fila, draft humano, idle flush, unconfirmed não-consome |
| `sendSubmittedLine` + `composerProfileFor` | Única primitiva de **submit de texto** |
| `sendStopText` | Única primitiva de **controle textual** (slash stop); **não** misturar com chat |
| Guards de `write_input` (busy refuse, composer refuse) | Mantidos para **C3** — comando não vira fila silenciosa |

### 4.2 Mapeamento caminho → padrão (o que muda conceitualmente; sem implementar aqui)

| Caminhos | Ação de padronização |
| --- | --- |
| A, I, J, L, M, N, U | Já na escada `deliverNotice` (I/L/M/N sem durable de conteúdo — ver gap). **Manter.** |
| E (Design Mode, handoff, `agent.input`) | **Substituir** `sendManagedAgentInput` cego por: (1) persistir intent C2, (2) `deliverNotice` **ou** `sendSubmittedLine+perfil` com recibo, (3) UI só marca enviado em `submitted`/`notified` |
| K (validation close) | **Alinhar a J**: inject via `deliverNotice`, não `sendSubmittedLine` nu |
| H (Agent pane submit) | Passar `composer: composerProfileFor(cmd)` como F |
| D bootstrap `sendSubmittedLine` | Passar perfil quando o runtime já tiver um |
| F, B | Já corretos na primitiva; B permanece refuse-not-queue |
| O, P, Q (conteúdo cego) | Migrar submits para escada; stage-only e argv spawn ficam de fora |
| R, S, T | **Fora** da doorbell de conteúdo; R continua `sendStopText`; T mantém guard de draft |

### 4.3 Separação "quem paga" dentro do padrão

- **C1:** durable = `doorbells.jsonl` (já). Batida = notice line. Duplicar batida ≠ duplicar fato.
- **C2:** durable = o store que o humano já tem (chat Design Mode, schedule def, prompt template id) —
  gravar **pending/sent/failed** *antes* de confiar no pane; **não** exigir que C2 entre em
  `doorbells.jsonl` (são origens diferentes; misturar polui `read_notices`).
- **C3:** sem durable de chat; recibo ao caller basta.
- **C4:** durable já é approval/validation/task; só wake.
- **C5:** sem durable eterno de conteúdo; fila + TTL + dismiss.
- **C6:** sem durable de mensagem.

### 4.4 Runtime **sem** regra / perfil de composer medido

Resposta explícita (alinha a `sendStopText` e a `sendSubmittedLine` hoje, e a `parity.md`):

1. **Continua desprotegido no eixo de confirmação de composer** — sem inventar `continuationLine` a
   partir do codex (`t-ba5357` é quem mede; até lá o leitor mantém o comportamento antigo **de
   propósito**).
2. A escada **ainda vale**: persistir primeiro; chamar `sendSubmittedLine` **sem** `composer`; aceitar
   recibos `submit-unconfirmed` / heurística `no-stranded-line` como o máximo honesto.
3. Documentar no parity do runtime: *"pane submit: unconfirmed; human draft guard: none/weak"*.
4. **Não** silenciar o gap: C2 (Design Mode etc.) em runtime sem perfil deve mostrar ao humano
   "entrega não confirmada", não um check verde.

### 4.5 O que o padrão **não** cobre

- Conserto do instrumento de quebra de linha do composer (`t-ba5357` / resíduo de `t-7a297f`).
- Compare-and-write atômico no tmux (corrida keystroke entre probe e write — já admitida em
  `notify_agent`).
- Governance de **quem pode** digitar (`lifecycleScope` / lineage) — eixo orthogonal.
- Spawn por argv/env (não é pane write).
- Garantir que agentes **chamem** `read_notices` (educação / primer; o pull existe).
- Novo barramento MCP de mensagens, websockets de chat, ou "PTY raw bypass".
- Fazer host-poke viver para sempre em disco (seria mentir sobre estado vivo).

---

## 5. Gaps / defeitos medidos nesta leitura (não consertados)

Cada um é "mecanismo feito para um ator, alcançado por outro" ou "mesmo efeito, porta mais fraca".

| Gap | Evidência | Classe | Já tem task? |
| --- | --- | --- | --- |
| Design Mode / `agent.input` usa primitiva cega; chat grava depois do send | `agentInputService.ts`, `ide-browser-bridge/manager.ts` | C2 | `t-b09d9c` (inbox) — premissa confirmada ainda válida |
| Validation close wake mais fraco que approval wake | `engineService.ts` inject vs `approvalResolutionPorts` | C4 | **Abrir** se ainda não houver |
| Agent pane submit sem `composer` profile | `extension.ts` `deliverText` | C2 | **Abrir** |
| `write_input` bootstrap `sendSubmittedLine` sem profile | `communication-io.ts` | C3 | menor; pode ir na task de alinhar call sites |
| Companion / task-assign / host-poke sem `doorbells.jsonl` | só `notify_agent` chama `appendDoorbellEvent` | C2/C4/C5 | esperado para C5; C2 companion é gap de intent durable |
| Continuity / schedule instructions cegos | `Workspace.injectContinuity`, `runSchedule` | C2/C4 | candidatos a follow-up na implementação do padrão |

---

## 6. Ordem de implementação sugerida (para quem for autorizado a tocar `src/`)

Fora do escopo desta task; só para o dono decidir.

1. **Matar o atalho E:** `sendManagedAgentInput` submit → `sendSubmittedLine+perfil` (ou
   `deliverNotice` quando fila for correta); Design Mode só marca enviado com recibo `submitted`.
2. **Alinhar K a J** (validation → `deliverNotice`).
3. **Passar perfil em H e D.**
4. **C2 durable ordering** no Design Mode (event pending → attempt → sent/failed).
5. O/P conteúdo cego por último (menor volume).

Não implementar (1) sem o instrumento de wrap se o runtime for codex-class e a linha for longa — mas o
padrão de **não mentir o recibo** já reduz o dano (`submit-unconfirmed` vs "enviado").

---

## 7. Vocabulário (reuso de t-7a297f)

- **Batida / doorbell:** escrita no pane cujo único trabalho é acordar; a carga vive em outro lugar.
- **Carga:** o fato (summary, task id, chat text, approval decision).
- **Recibo honesto:** `submit-unconfirmed` em vez de `notified`/`submitted` quando o instrumento não
  viu a linha sair.
- **Draft humano:** composer ocupado → não escrever por cima; filar (notice) ou recusar (comando).

---

## 8. Método e limites desta medição

- Grep de `sendKeys` / `sendSubmittedLine` / `sendManagedAgentInput` / `sendStopText` / `deliverNotice`
  em `src/` no worktree `sendaudit`, branch de entrega desta task.
- Leitura dos call sites listados na §2; não se inferiu comportamento de testes.
- **Não** re-mediu panes ao vivo (isso é `t-ba5357` / t-7a297f).
- Se um campo não fechou por leitura, a tabela diz o que o código faz e não inventa taxa de falha.

---

## 9. Veredito em uma frase

O produto já tem **um** caminho certo (`notify_agent` → durável → `deliverNotice` →
`sendSubmittedLine`+perfil com recibo); tem **um** caminho de controle certo (`sendStopText`); e tem
**vários atalhos cegos** (`sendManagedAgentInput`, continuity, schedule, validation inject nu) que
reimplementam "colar no PTY" com qualidade pior. O padrão é **um só:** durable-first doorbell + uma
primitiva de submit — e runtime sem perfil medido permanece desprotegido na confirmação, de propósito,
até a irmã medir.
