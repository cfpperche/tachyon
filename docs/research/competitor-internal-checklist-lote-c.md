# Concorrentes lote C — checklist interno e governança de plano

**Task:** `t-bb1466` (lote de `t-213110`) · **Medido:** 2026-08-16 · **Âmbito:** openade, orca, paseo.

Prova é linha de código no clone raso. README e frase de marketing não entram como achado. Nenhum código de terceiro foi copiado para este repositório.

## Reprodução

Clones rasos **fora** do checkout do Tachyon, em `/tmp/compC-competitors/`:

| Concorrente | Repo | HEAD lido | Data do commit | Assunto |
|---|---|---|---|---|
| openade | github.com/bearlyai/OpenADE | `88d505039102375794fb3fd69967fdf571316729` | 2026-07-24 15:01:10 -0400 | `chore: update download links to v0.81.2` |
| orca | github.com/stablyai/orca | `e4e54a17d0551fa992bafa945aed706f8d155378` | 2026-08-16 03:30:47 -0700 | `feat(workspace): set project location from the create-worktree host picker (#14868)` |
| paseo | github.com/getpaseo/paseo | `8c4e54eacefca3248b0502c1275cfc4c391b0ca0` | 2026-08-16 16:05:29 +0200 | `perf(app): keep composer typing within the frame budget (#3450)` |

Para repetir: `git clone --depth 1` de cada URL e `git checkout` do SHA acima.

## Controle negativo (obrigatório)

Grep por nomes inventados, em cada árvore inteira:

```text
checklistTelemetryXyz
requirePlanAbsurd
```

**Resultado: vazio nos três repositórios.** Também vazios (controle extra, mesma regra): `ChecklistTelemetry`, `TodosInvented`, `TaskInvented`.

Se um desses nomes tivesse batido, a busca por `plan`/`todo`/`checklist` não seria confiável. Não bateu.

## Resumo — observação vs governança

| Concorrente | Lê checklist nativo do runtime? | Inventou o próprio? | Exige plano interno na tarefa? |
|---|---|---|---|
| **openade** | Sim, em parte: observa `TodoWrite` (Claude) e `todo_list` / `turn/plan/updated` (Codex). **Não** lê `TaskCreate`/`TaskUpdate`/`TaskList`. | Sim: verbo de produto `plan`/`revise`/`run_plan`/`do`/`ask`/`hyperplan`, persistido como action event em Yjs. | **Não exige o checklist nativo.** Exige um *evento de plano próprio* só no verbo `run_plan`. `do` começa sem plano. |
| **orca** | **Não encontrado.** Sem `TodoWrite`, `update_plan`, `turn/plan/updated`, `TodosUpdated`, ACP `plan`. | Sim, mas é outra coisa: DAG de orquestração (SQLite) + checklist de onboarding. Não é o checklist interno do runtime. | **Não exige.** `/plan` é sugestão de slash digitada no PTY. |
| **paseo** | **Sim**, por adapter: Claude `Task*`/`TodoWrite`, Codex `turn/plan/updated`, OpenCode `todo.updated`, ACP `sessionUpdate: "plan"`, OMP todos. | Não inventou um checklist concorrente. Inventou uma *projeção* canónica (`type: "todo"`) a partir do nativo. | **Não exige.** Observa se o runtime emitir; turno sem plano segue. |

Quem só mostra: **paseo** (e o lado observador do **openade**). Quem governa um plano próprio, sem governar o checklist do runtime: **openade** (`run_plan`). Quem não lê nem exige: **orca**.

---

## openade

MIT · `bearlyai/OpenADE` · `88d5050` · 2026-07-24.

### Lê checklist nativo?

**Parcialmente, como render/forward de evento. Não como store de checklist do runtime.**

Canal Claude — **transcript do tool `TodoWrite`**, parser de UI:

- `projects/web/src/components/events/parsers/claudeCodeParser.ts:277-298` — se `toolUse.name === "TodoWrite"`, mapeia `input.todos[]` (`content`, `status`, `activeForm`) para um grupo `todoWrite`.
- Render: `projects/web/src/components/InlineMessages/renderers/todoWriteRenderer.tsx:39-61`.

Canal Claude — **`TaskCreate` / `TaskUpdate` / `TaskList`:** **não encontrado.** Grep por `name === "TaskCreate"` / `"TaskCreate"` como tool do runtime em `projects/` voltou vazio. O `OpenADETaskCreate*` do módulo é a **task de produto** (quadro OpenADE), não a tool do Claude (`projects/openade-module/src/types.ts:127-142`).

Canal Claude — `system:task_updated`: existe e é **outro objeto**. Tipo em `projects/harness/src/harnesses/claude-code/types.ts:129-142` (`subtype: "task_updated"`, `task_id`, `patch.status`). O parser trata como grupo de sistema (`claudeCodeParser.ts:381-393`), o renderer rotula `"Task"` (`systemRenderer.tsx:16,36,102`). Isso é notificação de task/subagente do CLI, não o checklist `TaskCreate`.

Canal Codex — **item de transcript `todo_list`:**

- Tipo: `projects/harness/src/harnesses/codex/types.ts:151,203`.
- Parser: `projects/web/src/components/events/parsers/codexParser.ts:33,260-274` — `item.items[]` vira o mesmo grupo `todoWrite`.

Canal Codex — **app-server `turn/plan/updated`:**

- `projects/runtime-node/src/codexAppServerBridge.ts:561-567` — `item/plan/delta` e `turn/plan/updated` são reencaminhados como notificação genérica `agent/turn/delta` (`method` + `params`). Não há acumulador de passos nem recusa se o plano não vier.

**Não encontrado:** leitura de `~/.claude/tasks/`, `plan.json` do Grok, hook `TaskCreated`, ou ACP `plan`. OpenADE só fala Claude Code e Codex.

### Inventou o próprio?

**Sim. Plano-documento de produto, não checklist nativo.**

Modelo: verbos `plan | do | ask | revise | run_plan | hyperplan`. O “plano” que o produto reconhece é um **action event** com `source.type ∈ {plan, revise, hyperplan}` e `status === "completed"`:

- `projects/openade-module/src/node.ts:101-108` (`latestCompletedPlanEvent`).
- Espelho no cliente: `projects/web/src/store/TaskModel.ts:494-501`.

Persistência: writer Yjs `createActionEvent` / `appendActionStreamEvent` / `completeActionEvent` / `addHyperPlanSubExecution` (`projects/openade-module/src/yjsMutation.ts:46-63`). Não é o store `~/.claude/tasks` nem `turn/plan/updated`.

O texto do plano é **markdown do assistente**, não a tool nativa:

- Instrução de plan mode: “generate and output an implementation plan” (`projects/openade-module/src/promptBuilder.ts:50-66,121-122`).
- Extração: último `result`/`assistant` text no Claude, ou `item.completed` `agent_message` no Codex (`projects/openade-module/src/hyperplan.ts:398-433`). **Não** lê `TodoWrite` nem `update_plan` para decidir se há plano.

HyperPlan é o mesmo objeto em paralelo (vários steps, reconcile no terminal): `projects/electron/src/modules/companion/runtimeGateway.ts:1878-1915`, `projects/openade-module/src/hyperplan.ts:106` (“You must produce exactly one final plan”).

**Dois checklists podem coexistir.** O deny-list `disablePlanningTools` bloqueia `EnterPlanMode`, `ExitPlanMode`, `Task(Plan)`, `AskUserQuestion` — **não** `TodoWrite` nem `TaskCreate` (`projects/harness/src/harnesses/claude-code/args.ts:23-24,283-284`). O renderer ainda liga `disablePlanningTools: true` por omissão em toda execução (`projects/web/src/electronAPI/harnessQuery.ts:455-460`). O caminho server-owned em `runtimeGateway.ts` **não** passa essa flag (grep vazio em `projects/electron/src/modules/companion`). Resultado: o plano-documento do OpenADE e um `TodoWrite`/`todo_list` nativo podem aparecer no mesmo turno. O gate de `run_plan` olha só o action event.

### Exige plano?

**Não exige o checklist interno do runtime. Exige o próprio action event só em `run_plan`.**

Gate:

- `projects/openade-module/src/promptBuilder.ts:213-216,250-266` — `revise` e `run_plan` chamam `requirePlanEventId`; sem `planEventId` lança `` `${request.type} requires a completed plan event` ``.
- `projects/openade-module/src/node.ts:341-343` e `runtimeGateway.ts:1936-1938` — `run_plan` sem evento de plano completo lança `"Run Plan requires a completed plan event"`.
- `revise` sem plano **degrada para `plan`**, não recusa (`node.ts:337-340`, `runtimeGateway.ts:1932-1935`).
- `do` **não** passa por `requirePlanEventId` (`promptBuilder.ts:281-288`). A UI vazia diz explicitamente “click Plan or Do to get started” (`projects/web/src/components/EventLog.tsx:23`).

O que o gate **não** verifica: se o runtime chamou `update_plan`/`TodoWrite`/`TaskCreate`; se o texto extraído parece um plano. Completar o turno `plan` basta.

O harness **recusa o plan mode nativo do Claude** no caminho read-only: `--permission-mode dontAsk`, e o teste diz “Must NOT use plan mode (it injects unwanted system prompts)” (`projects/harness/src/harnesses/claude-code/args.test.ts:120-126`). Governança é o system prompt do OpenADE, não o plan mode do runtime.

**Não encontrado:** retry quando o runtime não emitiu checklist; tool nativa obrigatória; recusa de `do` sem plano.

### Multi-runtime?

Dois harnesses (Claude, Codex). Parsers separados convergem no grupo UI `todoWrite`. O plano de produto é extraído por harness (`extractOpenADEPlanText`) mas o gate é o mesmo action event. `disablePlanningTools` no Codex é ignorado (`projects/harness/src/harnesses/codex/args.ts:171`). Grok/OpenCode/Pi: fora do roster deste repo.

### Runtime mudo?

Sem `TodoWrite`/`todo_list` no transcript, o parser não cria grupo `todoWrite` (não mente “lista vazia”). Sem action event `plan`/`revise`/`hyperplan`, `run_plan` falha; `do` segue. `turn/plan/updated` ausente só deixa de gerar `agent/turn/delta` daquele method.

---

## orca

MIT · `stablyai/orca` · `e4e54a17` · 2026-08-16.

### Cartões Orca já abertos — o que já estava lido

| Cartão | O que mediu | Serve para esta pergunta? |
|---|---|---|
| `t-c70fb9` CLI | Inventário de CLI; checkout citado `/tmp/orca-re` `057db5b` **já não existe** (journal 2026-08-06). | Não. Não fala de checklist nativo. |
| `t-a8f1fd` worktree | Lifecycle de worktree; mesma evidência morta. | Não. |
| `t-54d0c5` restore | Session restore vs tmux; mesma evidência morta. | Não. |
| `t-7ff4c2` DS | Tokens/radius Kit vs legacy. | Não. |
| `docs/research/orca-orchestration-task-lifecycle-land.md` | DAG próprio, commit `34f2a62`. | Só para o modelo *inventado* de orquestração. |
| `docs/research/t-5f4294-orca-chat-ui.md` | Chat = transcript/hook/PTY; ACP zero; commit `09ec516a` (2026-08-12). | Sim, como contexto de canal. |

**Contradição com o que está lá:** nenhuma neste recorte. Remediado hoje em `e4e54a17`: `agent-client-protocol` / `session/update` continua **ausente** em `src/`. `TodoWrite` / `update_plan` / `turn/plan/updated` / `TodosUpdated` continuam **ausentes** em `src/`. O DAG de orquestração continua no sítio que o doc de 2026-08-09 descreveu; as linhas andaram, o modelo não. Os quatro cartões de estudo não afirmavam leitura de checklist nativo, então não há o que contradizer — só o que não tinha sido medido.

### Lê checklist nativo?

**Não encontrado.**

Busca em `src/` por `TodoWrite`, `todo_write`, `update_plan`, `turn/plan/updated`, `TodosUpdated`: vazio. Sem ACP. O chat nativo continua a ser overlay sobre PTY + transcript + hooks (`t-5f4294`); este HEAD não acrescentou um leitor estruturado de plano.

O que *parece* o nome e não é:

- Hook `PostToolUse` para `tool_name: 'TaskUpdate'`: só evita preview enganoso do input (`src/main/agent-hooks/server-claude-normalization.test.ts:94-106`). Não acumula itens, não persiste checklist.
- `TaskCreate`/`TaskList`/`TaskUpdate` em `src/main/runtime/rpc/methods/orchestration.ts:181-218` são **tasks da orquestração Orca** (`pending | ready | dispatched | completed | failed | blocked`), não as tools do Claude.
- `plan.jsonl` em testes do vault OMP (`src/main/ai-vault/session-scanner-omp-subagent-*.test.ts`) é fixture de artefacto OMP, não o `plan.json` do Grok.
- “checklist” no resto do tree é onboarding / setup / PR template / markdown Tiptap.

`/plan` existe como **sugestão de slash do Codex** para o compositor (“Switch to Plan mode”, `src/shared/native-chat-slash-commands.ts:55`). É texto que o operador (ou o compositor) manda no PTY. Não é leitura do plano nativo e não é gate.

### Inventou o próprio?

**Sim, dois objectos — nenhum é o checklist interno do runtime.**

1. **DAG de orquestração.** Mensagens `status | dispatch | worker_done | merge_ready | escalation | handoff | decision_gate | question | heartbeat` (`src/main/runtime/orchestration/types.ts:1-11`). Task status próprio (`types.ts:19`). Persistido em SQLite (o doc `orca-orchestration-task-lifecycle-land.md` já mediu as tabelas). `decision_gate` abre um gate de coordenador (`coordinator.ts:181-182`), não “o runtime tem de ter emitido um plano”.
2. **Checklist de onboarding / setup guide.** Estado em `src/shared/onboarding-state-types.ts`; UI em Settings/Setup Guide. É activação do produto, não telemetria de turno.

Se o runtime também tiver um checklist nativo, a Orca **não reconcilia**: não o lê. Os dois sistemas não competem no código da Orca porque só um deles existe lá.

### Exige plano?

**Não exige.**

Não há prompt de produto que mande o runtime chamar `update_plan`/`TodoWrite`. Não há tool obrigatória. Não há recusa de turno sem plano. `decision_gate` é pergunta do coordenador ao operador, não um require-plan do CLI.

Ausência medida: o runtime pode trabalhar o turno inteiro sem a Orca saber se existiu checklist.

### Multi-runtime?

Catálogo largo de CLIs em PTY. Sem adapter de checklist por runtime. Não há reconciliação de formatos porque não há leitura.

### Runtime mudo?

Não há superfície de checklist para degradar, esconder ou mentir. O TUI do runtime, se pintar todos, fica no PTY; a Orca não projecta isso.

---

## paseo

AGPL-3.0 · `getpaseo/paseo` · `8c4e54ea` · 2026-08-16.

Leitura anterior neste repo: `docs/research/t-1cb3f8-paseo-chat.md` (commit `635a8be`, 2026-08-12) já nomeava `sessionUpdate` incluindo “plano” em `acp-agent.ts:2612-2675`. Hoje o `switch` está em `acp-agent.ts:2639-2686`; o caso `plan` é `2664-2666`. O repo andou; o canal continua. Sem contradição.

### Lê checklist nativo?

**Sim. Vários canais, todos nativos, projectados para `timeline` `type: "todo"`.**

| Runtime | Canal | Prova |
|---|---|---|
| Claude (embutido) | Tools SDK `TodoWrite`, `TaskCreate`, `TaskUpdate`, `TaskList` | `packages/server/src/server/agent/providers/claude/task-state.ts:3,72-90,125-127,195-201`. Teste de snapshot canónico: `claude/agent.test.ts:1440-1473`. |
| Codex (embutido) | App-server `turn/plan/updated` | Schema+parse: `codex-app-server-agent.ts:2533-2542`. Handler: `5744-5769` — fora de plan mode emite `mapCodexPlanUpdateToTodo` (`969-980`); em plan mode trata como tool call `name: "plan"` (compat). Status `inProgress`/`in_progress` normalizados (`983-987`). |
| OpenCode (embutido) | Evento `todo.updated` (e tool `todowrite` só como fallback) | `opencode-agent.ts:2169-2175`; mapper `1990-2004`. Teste: o live `todowrite` é suprimido porque o evento já chega (`opencode/event-translator.test.ts:815-827`). |
| Catálogo ACP (inclui Grok `grok agent stdio`, Hermes `hermes acp`, …) | `sessionUpdate === "plan"` | `acp-agent.ts:2664-2666` → `mapPlanToTimeline` `3256-3263` (`plan.entries[]` → `todo`). Grok no catálogo: `packages/app/src/data/acp-provider-catalog.ts:210-217`. **Não encontrado:** leitor de `todo_write` / `plan.json` / `TodosUpdated` específico do Grok. Se o Grok não emitir ACP `plan`, o Paseo não vê o checklist. |
| OMP (embutido, off por omissão) | Fases/todos do RPC OMP | `packages/server/src/server/agent/providers/omp/todo-mapper.ts:11-47`. |
| Pi (embutido) | Campo `todoPhases?` no tipo de sessão | `pi/rpc-types.ts:102`. **Não encontrado** mapper que o transforme em `todo`. Tipo presente, porta não ligada. |

UI: `packages/app/src/composer/task-list/index.tsx:12-21` lê `session.agentTasks`. Redutor: evento `timeline`/`todo` vira `taskSnapshot` (`session-stream-reducers.ts:1648-1650`); snapshot vazio **apaga** a entrada (`session-store.ts:361-378,1556-1559`). E2E real pede ao modelo que use a tool nativa e afirma a lista acima do compositor, **sem** badge `TaskUpdate` e **sem** `timeline-plan-card` (`packages/app/e2e/browser/provider-task-list.real.spec.ts:26-73`). Isso é observação + apresentação, não um gate.

Parser extra de tool call (Claude `TodoWrite` / `todo_write`, Codex `update_plan`): `packages/app/src/utils/tool-call-parsers.ts:272-337`. `ExitPlanMode` é excluído de propósito (`304-307`) — “not a task list”.

### Inventou o próprio?

**Não um checklist concorrente.** Inventou o tipo canónico `AgentTimelineItem` `{ type: "todo"; items: AgentTaskItem[] }` (`packages/server/src/server/agent/agent-sdk-types.ts:393`) e um `Map<agentId, TodoEntry[]>` no session store, **derivado do stream**. Não há writer de produto que crie itens sem o runtime os ter emitido. Não há segundo store que dispute com o nativo.

Se o runtime também tiver o checklist (sempre tem, neste desenho), o Paseo mostra a projecção. Um só objecto visto, vários fios de entrada.

### Exige plano?

**Não exige.**

- Sem prompt de produto que mande planear em todo o turno. Os prompts do e2e que dizem “Use TaskCreate / update_plan / TodoWrite” são **do teste**, não do agente em produção (`provider-task-list.real.spec.ts:31-44`).
- Sem tool obrigatória no launch do Claude (`claude/agent.ts` sem `must use` / `TodoWrite` / `update_plan`).
- Sem recusa de turno se não houver `todo`. `updateAgentTasks` com array vazio **remove** a lista; `AgentTaskList` retorna `null` se não houver items (`task-list/index.tsx:19-20`).
- Plan mode existe como **modo de sessão opcional** (ACP `setSessionMode`, Copilot `COPILOT_PLAN_MODE_ID` em `copilot-acp-agent.ts:39,67`). O operador pode pedi-lo; o servidor não recusa o turno default sem ele.
- `requirePlannedWorkspaceServicePort` é porta de worktree, não plano de agente.

**Não encontrado:** retry quando o plano não veio; gate que bloqueie `session/prompt` sem checklist.

### Multi-runtime?

Esta é a parte cara, e o Paseo já a paga: um adapter por porta nativa → um `todo` canónico. Formatos diferentes (Claude IDs+DAG de tools, Codex passos sem id estável, ACP `entries`, OpenCode `todo.updated`, OMP phases) saem com `text`/`status`/`completed`. Grok e Hermes só entram se falarem ACP `plan`. Pi declara `todoPhases` e não projecta.

### Runtime mudo?

**Esconde.** Sem evento `todo`, não há card. Não materializa uma lista vazia a fingir que o runtime reportou zero itens. Não há fallback que invente passos.

---

## O que este lote não é

- Não é desenho para o Tachyon.
- Não é medida de qualidade do plano (se o markdown do OpenADE é bom, se o `update_plan` do Codex está certo).
- Não é afirmação sobre runtimes que o concorrente não integra (OpenADE sem Grok; Orca sem leitor; Paseo/Grok só via ACP).
