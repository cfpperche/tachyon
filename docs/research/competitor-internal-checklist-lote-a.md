# Lote A — checklist interno do runtime nos concorrentes

**Task:** `t-213110` · **Lote:** A (compozy, emdash, fusion) · **Measured:** 2026-08-16
**Perguntas do dono, nesta ordem:** (1) como cada um trata o checklist interno do runtime — lê o nativo, inventou o próprio, ou ignora? (2) como governam o runtime para *exigir* um plano interno na tarefa?

Observação e governança ficam em seções distintas. Não há proposta de desenho para o Tachyon.

## Método

Clones rasos fora do repositório do Tachyon, em `/tmp/t-213110-lote-a`. Prova é linha de código, não README. Nenhum código de terceiro foi copiado para cá.

| Repo | License | HEAD lido | Data do commit | Assunto |
|---|---|---|---|---|
| `compozy/compozy` | MIT | `e3a653290735d3b6545208b6babb31633c13b706` | 2026-08-16T11:58:37-03:00 | `test: preserve loop claim tokens in daemon fixtures (#418)` |
| `generalaction/emdash` | Apache-2.0 | `9b102a5f3a6605b0ac066d4dcae2c362e5d7503a` | 2026-08-15T16:39:33+02:00 | `Merge pull request #3000 from generalaction/feat-workspace-server-release-flow` |
| `Runfusion/Fusion` | MIT | `53acaf96c37278c6b7260254bbd6b16c0fa5d227` | 2026-08-16T04:05:45-07:00 | `FN-9123: Repair script test contract drift` |

O que os runtimes expõem nativamente já está em `docs/research/runtime-internal-checklist-capabilities.md` (remeasure 2026-08-16). Este lote mede o que o *concorrente* faz com isso. `TodosUpdated` (Grok ACP) foi procurado por nome nos três clones: **zero ocorrências** fora de `node_modules`/`.git`/CHANGELOG.

### Controle negativo (obrigatório)

Grep por nomes inventados. Tem que voltar vazio. Voltou.

| Repo | `checklistTelemetryXyz` | `requirePlanAbsurd` |
|---|---|---|
| compozy | 0 | 0 |
| emdash | 0 | 0 |
| fusion | 0 | 0 |

Comando: `rg -c --hidden -g '!**/.git/**' -g '!**/node_modules/**' 'checklistTelemetryXyz|requirePlanAbsurd' /tmp/t-213110-lote-a/<repo>` — zero matches, exit 1 em cada um.

## Veredito primeiro

Nenhum dos três governa o runtime para **exigir** um plano interno (`TodoWrite` / `update_plan` / `todo_write` / ACP `plan`) antes de um turno. Ausência medida, não falha da pesquisa.

O que existe é observação, em três profundidades:

| Concorrente | Lê checklist nativo? | Canal | Inventou o próprio? | Exige plano *do runtime*? | Só mostra? |
|---|---|---|---|---|---|
| **compozy** | Sim, o envelope ACP `plan`. **Não extrai as entries.** | `session/update` via `coder/acp-go-sdk` v0.13.5 | Kernel de Tasks (produto). Renderer de `TodoWrite` (Claude). | **Não exige.** | Mostra `TodoWrite` como checklist. O evento ACP `plan` cai no `default` da projeção UI. |
| **emdash** | Sim, entries e tudo. | ACP `sessionUpdate: 'plan'` → `PlanState` vivo | Não. `PlanState` é o plano ACP com IDs sintéticos. | **Não exige.** | Sim — `ChatPlan` na transcrição. |
| **fusion** | Sim, mas achata para uma linha de thinking. | ACP `sessionUpdate: "plan"` no event-bridge (4 plugins) | Sim: `PROMPT.md` + Plan Review (fábrica). Outra camada. | **Não exige o plano do runtime.** Exige, em alguns fluxos, o *próprio* spec. | O plano ACP vira texto de thinking. |

Dois checklists no mesmo produto é achado: Compozy (evento ACP `plan` + renderer `TodoWrite`) e Fusion (plano ACP como thinking + `PROMPT.md` da fábrica).

---

## 1. Compozy

**Fonte:** `github.com/compozy/compozy` @ `e3a653290735d3b6545208b6babb31633c13b706` (2026-08-16). Go daemon. Dependência `github.com/coder/acp-go-sdk v0.13.5` (`go.mod:11`).

### Observação — lê o checklist nativo?

**Sim, o canal ACP.** Não o arquivo `plan.json` do Grok, não o app-server `turn/plan/updated` do Codex, não `TodosUpdated`.

Caminho:

1. `AgentProcess.handleSessionUpdate` decodifica `session/update` e chama `translateSessionUpdate` (`internal/acp/handlers_session_state.go:10-59`).
2. `translateSessionUpdate` — quando `notification.Update.Plan != nil`, só faz `event.Type = EventTypePlan` (`internal/acp/handlers_session_update.go:58-59`). **Não lê `Plan.Entries`.** O raw do update vai em `event.Raw` (`handlers_session_update.go:21`).
3. `EventTypePlan = "plan"` (`internal/acp/types.go:31-32`). O registry de eventos chama o mesmo token `ACPPlan = "plan"` (`internal/events/names.go:10`).
4. O evento entra no prompt ativo (`emitPromptEvent`, `internal/acp/agent_process_prompt.go:162`) e persiste como `store.SessionEvent{Type: event.Type, Content: payload}` (`internal/session/manager_prompt_event_storage.go:82-112`).

Struct que chega: `acpsdk.SessionNotification.Update.Plan` (SDK). Struct que Compozy guarda: `acp.AgentEvent` com `Type == "plan"`. **As entries do plano não viram campo tipado.** `canonicalEventPayload` não tem `entries` (`internal/transcript/canonical_payload.go:12-46`). `applyLegacyRawPayload` só copia `event.Raw` para o payload persistido quando o tipo é permission, clarify, compaction ou marker — **não quando é plan** (`internal/transcript/agent_event_codec.go:95-101`). Resultado: o tipo `plan` sobrevive; o corpo das entries no raw **não** entra no payload canónico.

`TestHandleSessionUpdateVariants` cobre `user_message_chunk`, `agent_message_chunk`, `usage_update`, `tool_call`, `current_mode_update`, tool result — **não** envia `sessionUpdate: "plan"` (`internal/acp/handlers_test.go:1443-1553`).

`TodosUpdated` / `todo_write` / `update_plan` / `plan.json`: não encontrados no código de produto.

### Observação — inventou o próprio?

Dois artefactos *outros*, nenhum é um clone do checklist do runtime:

- **Tasks do kernel** (`TaskCreate`, claim/lease). São trabalho do produto Compozy, não o todo do CLI. `internal/daemon/native_tool_binding_groups.go:267` e `internal/tools/builtin/tasks.go:49`.
- **Renderer `TodoWrite`.** A UI especializa o tool-call Claude `TodoWrite`: parseia `message.toolInput?.todos` e desenha “Plan · X of N” (`web/src/systems/session/components/tool-renderers/todo-content.tsx:23-80`). `SPECIALIZED_TOOLS` inclui `TodoWrite` e não inclui `update_plan` (`web/src/systems/session/components/tool-call-card.tsx:27`). `update_plan` cai em `GenericContent`.

O formulário de loops com `note.kind === "plan"` é preview de dry-run (`web/src/systems/loops/components/run-form/loop-run-form.tsx:36-37`), não o checklist do runtime.

Dois checklists a concorrer, se o guest emitir os dois: evento ACP `plan` (tipo persistido, entries descartadas) e tool-call `TodoWrite` (é o que a UI mostra).

### Governança — exige plano do runtime?

**Não exige.** Não há prompt de produto que mande `TodoWrite`/`update_plan`, nem tool obrigatória, nem gate que recuse turno sem `EventTypePlan`, nem retry quando o plano não veio. `EventTypePlan` aparece em repair só como “há dados de prompt” (`internal/session/repair_actions.go:36`) e como *alias de modo* de permissão (`"plan"` em `internal/acp/session_config_negotiation.go:255`) — modo de sessão, não exigência de checklist.

### Multi-runtime

Todos os guests passam pelo mesmo cliente ACP. O caso `Update.Plan` é único. A reconciliação de formatos é: Claude `TodoWrite` tem renderer; Codex `update_plan` não. Não há adaptador por runtime para o evento `plan`.

### Runtime mudo

Se o guest não emitir `Update.Plan`, não há evento `plan` e a UI não inventa lista vazia. A projeção de transcrição trata `plan` no `default`: `appendDataPart` genérico (`internal/transcript/ui_messages.go:199-218`). Sem entries no payload, isso não é um checklist. Não mente “está vazio”; some no data-event.

---

## 2. Emdash

**Fonte:** `github.com/generalaction/emdash` @ `9b102a5f3a6605b0ac066d4dcae2c362e5d7503a` (2026-08-15). Dependência `@agentclientprotocol/sdk` `^1.1.0`.

### Observação — lê o checklist nativo?

**Sim, o canal mais direto deste lote.** ACP `sessionUpdate: 'plan'` vira estado estruturado e UI.

Caminho:

1. `decodeSessionUpdate` — `case 'plan'` mapeia `update.entries` para `{ kind: 'plan', entries: { content, status, priority } }` (`packages/core/src/runtimes/acp/api/reducer/decode.ts:157-166`).
2. `updatePlanSlice` substitui o snapshot: `id: SESSION_PLAN_ID` (`'session-plan'`), entries com id sintético `` `${SESSION_PLAN_ID}:entry:${index}` ``, `updatedAt` (`packages/core/src/runtimes/acp/api/reducer/reducer.ts:364-376`; modelo em `packages/core/src/runtimes/acp/api/models/plan.ts:3-33`). Comentário no schema: ACP não dá id estável por entry; o reducer inventa um id de sessão.
3. Estado inicial `plan: null` (`reducer.ts:86-96`). Getter `parser.plan` (`packages/core/src/runtimes/acp/api/reducer/parser.ts:139-141`).
4. `SessionManager.syncRecord` publica `record.cell.transcript.plan ?? null` no live model `session.states.plan` (`packages/core/src/runtimes/acp/node/runtime/session-manager.ts:683-685`; contrato `packages/core/src/runtimes/acp/api/contract.ts:182`).
5. Desktop: `AcpLiveSession.plan` é `RemoteValueState<PlanState | null>` (`apps/emdash-desktop/src/core/features/conversations/browser/acp/acp-live-session.ts:86, 111`).
6. UI: `ChatPlan` / `ChatPlanEntry` “produzido por ACP `plan` / `plan_update`”; replace wholesale (`packages/chat-ui/src/model.ts:269-300`). Fold na transcrição: `create-plan-tool-call` com `planId: SESSION_PLAN_ID` (`packages/core/src/runtimes/acp/api/reducer/item-fold.ts:473-487`).

`plan_update` e `plan_removed` são **ignorados** de propósito: “UNSTABLE/ID-based ACP variants gated behind PlanCapabilities — not emitted by Claude” (`decode.ts:207-210`).

O overlay de plano vive no session-plane em memória. O schema do workspace-registry diz que o overlay de runtime **não** está no SQLite (`packages/core/src/runtimes/workspace-registry/node/persistence/schema.ts:7`). Persistência além da sessão viva: não encontrada como tabela de plan entries.

`TodosUpdated` / `todo_write` / `plan.json`: não encontrados. O único `TodoWrite`/`update_plan` no produto (fora snapshots) é o **texto de um fixture de teste** que pede ao agente para usar a tool (`packages/plugins/tooling/fixtures/acp/scenario.ts:164-170`). Isso não é gate de produto.

### Observação — inventou o próprio?

**Não** como checklist paralelo. `PlanState` é o plano ACP com IDs sintéticos. Tasks do Emdash são issues/worktrees, não um segundo todo do runtime.

### Governança — exige plano do runtime?

**Não exige.** Não há recusa de turno, retry, nem tool obrigatória. O prompt “Use your todo/task-tracking tool (TodoWrite or update_plan …)” é só o fixture ACP (`scenario.ts:164`). Arquitetura: o reducer publica slices; não decide se o plano *tinha* de existir (`agents/architecture/acp-runtime.md:70-73`).

### Multi-runtime

Um decoder/reducer para todo o catálogo ACP. Grok entra pelo mesmo `createNativeAcpBehavior` (`packages/plugins/src/agents/impl/grok/index.ts:112-115`). Reconciliação de formato: o que não for `sessionUpdate: 'plan'` não atualiza `PlanState`. Um runtime que só emita `plan_update` fica mudo neste slice.

### Runtime mudo

`plan` fica `null`. Live state é nullable. A UI não tem plan para mostrar. Não inventa lista vazia e não afirma que o plano está vazio.

---

## 3. Fusion

**Fonte:** `github.com/Runfusion/Fusion` @ `53acaf96c37278c6b7260254bbd6b16c0fa5d227` (2026-08-16). `@agentclientprotocol/sdk` `0.24.0`. Event-bridge vendido em quatro plugins: `fusion-plugin-acp-runtime`, `fusion-plugin-claude-runtime`, `fusion-plugin-omp-runtime`, `fusion-plugin-grok-runtime` (mesma lógica; citações no plugin ACP).

### Observação — lê o checklist nativo?

**Sim, e degrada para texto.**

`createEventBridge` — `case "plan": handlePlan(update.entries)` (`plugins/fusion-plugin-acp-runtime/src/event-bridge.ts:278-280`). Comentário no ficheiro: planos são *full replacement*; nunca acumula (`event-bridge.ts:17-18`).

`handlePlan` formata até `MAX_PLAN_ENTRIES` (100) e emite `callbacks.onThinking?.(line)` (`event-bridge.ts:231-257`). `formatPlan` produz `Plan:\n- [status] text` (`event-bridge.ts:99-109`). **Não há `PlanState`.** Não há persistência estruturada do snapshot ACP.

- `plan_update`: NO-OP de propósito — a variante experimental não traz `entries` no topo (`event-bridge.ts:282-287`).
- `plan_removed`: “Clearing the plan: surface nothing” (`event-bridge.ts:288-290`).
- Lista vazia ainda emite a linha `Plan:` (`formatPlan([])` → `"Plan:\n"`).

`TodosUpdated` / `todo_write` / `plan.json`: não encontrados nos plugins.

### Observação — inventou o próprio?

**Sim — outra camada.** Spec da fábrica:

- Artefacto: `.fusion/tasks/<id>/PROMPT.md`. Recovery recusa spec vazio (`packages/engine/src/triage.ts:1445-1448`). `PROMPT.md` em falta = unplanned, admite para planear (`triage.ts:1974-2001`).
- Persistência: `persistPlanArtifact` reconcilia o spec do worktree para `.fusion/` e espelha no documento de task `plan` (`packages/engine/src/plan-artifact-writeback.ts:170-180`; chamada em `triage.ts:3432`).
- Gate de *aprovação* do spec da Fusion, não do checklist do runtime: `requirePlanApproval` (default `false`, `packages/core/src/workflows/builtin-workflow-settings.ts:194-198`); `planApprovalMode` default de projeto `"auto-approve-all"` (`packages/core/src/config/settings-schema.ts:478-482`); `resolvePlanApprovalRequired` (`packages/core/src/planner/plan-approval.ts:144-155`).
- Plan Review é “the single operator-controlled AI plan gate” depois de `PROMPT.md` escrito (`triage.ts:3417-3419`).

Dois planos a concorrer: o ACP do guest (linha de thinking, efémera) e o `PROMPT.md` da Fusion (durável, com review). O skill Compound Engineering *pede* `TaskCreate`/`update_plan` no runtime (`plugins/fusion-plugin-compound-engineering/src/skills/ce-work/SKILL.md:146`) — é prompt de skill, não gate.

### Governança — exige plano do runtime?

**Não exige o checklist interno do runtime.** Não há recusa de turno ACP sem `sessionUpdate: "plan"`, nem retry, nem tool obrigatória no cliente ACP.

O que a Fusion exige, quando o workflow tem lane de planning, é o **próprio** `PROMPT.md`. Isso não é governança do `todo_write`/`update_plan`/`TaskCreate` do guest. `askAcpOnce` “Planning tolerates an absent stop reason” (`docs/acp-contract.md:55`) — e não menciona plano ACP.

### Multi-runtime

O mesmo event-bridge está vendido em ACP / Claude / OMP / Grok. Reconciliação: todos os `plan` viram a mesma linha de thinking. O spec da fábrica é independente do runtime. O skill CE nomeia tools por harness (`TaskCreate` vs `update_plan`) só no texto do skill.

### Runtime mudo

Sem evento `plan`, não há linha de thinking. Não inventa snapshot vazio. `plan_removed` também não emite. Uma lista `entries: []` *ainda* emite `Plan:` — o único sítio deste lote em que um plano vazio vira texto visível.

---

## Observação vs governança (os três)

| | Observação (lê / mostra) | Governança (recusa / retry / tool obrigatória no *runtime*) |
|---|---|---|
| Compozy | Recebe ACP `Plan`, descarta entries no persist; mostra `TodoWrite`. | Não. |
| Emdash | Recebe ACP `plan`, guarda `PlanState`, mostra `ChatPlan`. | Não. |
| Fusion | Recebe ACP `plan`, mostra como thinking; guarda `PROMPT.md` próprio. | Não sobre o plano do runtime. Sim, em parte, sobre o spec da fábrica. |

Quem só mostra: os três, no eixo do checklist do runtime. Quem exige plano *interno do runtime*: **ninguém neste lote.**

## O que não foi encontrado

- Consumo de `TodosUpdated` (Grok) nos três.
- Leitura de `~/.grok/sessions/.../plan.json` ou `~/.claude/tasks/` nos três.
- Subscrição Codex `turn/plan/updated` nos três.
- Gate que recuse `session/prompt` / turno sem um plano ACP nos três.
- `checklistTelemetryXyz` e `requirePlanAbsurd` nos três (controlo negativo).
