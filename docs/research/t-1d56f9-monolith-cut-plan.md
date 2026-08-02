# t-1d56f9 — Monolithic-function cut plan (path only, no refactor)

**Author:** monolitos · **HEAD measured:** `407bd9f20e9cc8c30ba6410d43deaa2512ed4e1a` · **Date:** 2026-08-02  
**Method:** Node + TypeScript AST (`ts.createSourceFile`). Counts FunctionDeclaration / MethodDeclaration / Constructor / get/set, plus Function/Arrow bound to a name. Anonymous inline callbacks are **not** promoted to top-level “largest function” — so `registerTools` stays one 4k-line function rather than 98 small ones. Lines = `getStart`→`getEnd`. Same method as the 2026-08-01 remeasure (journal `j-52efd5e99729`), validated then against the 2026-07-24 baseline.

**Scope of this deliverable:** plan + remeasurement only. **Zero production code changes.** Execute cuts only under existing tasks (see t-3b47ad for `registerTools`); do not spawn one task per cut.

---

## (a) Remeasurement vs 2026-07-24 and 2026-08-01

| arquivo | linhas (hoje) | maior função | linhas | % | 07-24 (corpo) | 08-01 (journal) |
|---|---:|---|---:|---:|---|---|
| `src/bridge/tools.ts` | **5329** | `registerTools` (1057→5328) | **4272** | **80.2%** | 4998 / 4064 / 81% | 5064 / 4140 / 81.8% |
| `src/extension.ts` | **3575** | `activate` (1048→3567) | **2520** | **70.5%** | 3302 / 2287 / 69% | 3572 / 2525 / 70.7% |
| `src/webview/Cockpit.ts` | **3128** | `openCockpit` (1128→3127) | **2000** | **63.9%** | ~2312 / ~1499 / 64% | 3127 / 2000 / 64.0% |
| `src/workspace/Workspace.ts` | **6455** | `constructor` (665→2087) | **1423** | **22.0%** | 6036 / 1443 / 24% | 6149 / 1373 / 22.3% |

**Deltas (07-24 → hoje):**

| arquivo | Δ arquivo | Δ maior fn | Δ % | leitura |
|---|---:|---:|---:|---|
| tools.ts | +331 | +208 | −0.8pp | cresce em absoluto; razão estabiliza ~80% |
| extension.ts | +273 | +233 | +1.5pp | `activate` engordou com deps + comandos |
| Cockpit.ts | +816 | +501 | ~0 | maior crescimento absoluto; razão travada ~64% |
| Workspace.ts | +419 | **−20** | **−2.0pp** | único onde a maior fn **encolheu** vs 07-24 |

**vs 08-01:** tools +265/+132; extension ~estável; Cockpit estável em 2000; constructor Workspace +50 linhas com arquivo +306 (razão ainda ~22%).

**Contraste saudável (hoje, mesma métrica):**

| arquivo | linhas | maior fn | linhas | % |
|---|---:|---|---:|---:|
| `src/harness/HarnessManager.ts` | 3177 | `materializeHome` | 139 | 4.4% |
| `src/tmux/TmuxService.ts` | 1384 | `createTmuxExecutor` | 79 | 5.7% |
| `src/evolution/EvolutionStore.ts` | 2025 | `renameAgent` | 142 | 7.0% |
| `src/plugins/engine.ts` | 2164 | `applyInstall` | 200 | 9.2% |
| `src/agents/AgentManager.ts` | 5040 | `spawnCore` | 606 | 12.0% |

**Veredito de ranking:** 1 tools → 2 extension → 3 Cockpit → 4 Workspace. **Ordem inalterada** desde 07-24. Tese intacta: tamanho de arquivo não discrimina; razão maior-função/arquivo sim.

**Detalhe tools:** 98× `mcp.registerTool(...)` (SDK renomeou `server.tool`). Decomposição: **70 canônicas sempre** (fixadas em `test/unit/bridge.test.ts`) + **26** `user_browser_*` sob `if (deps.companionTabToolsEnabled?.())` + **2** probe (`probe_agent`, `read_probe_result`) sob `if (deps.probe)`.

**Premissa obsoleta (`nodePrompt.ts`):** já corrigida (t-93dbf2 / nota premissas 2026-08-02). Fora do escopo restante.

---

## (b) Plano por arquivo — costura · guarda · primeiro-a-quebrar

### 1. `src/bridge/tools.ts` — `registerTools` (80.2%) — **primeiro a cortar**

**Costura natural (não por linhas):** o arquivo **já está ordenado por domínio**. `registerTools` vira orquestrador curto: instrumenta `mcp` uma vez, depois chama registradores por domínio.

| fatia | linhas aprox. | tools | notas |
|---|---|---|---|
| **Preamble (fica)** | 1057–1141 | — | `emitExecution`, `executionCallerId`, **`instrument` (SDD 480 §7.3)**. O wrapper **deve** continuar único e *antes* de qualquer `registerTool` extraído. |
| worktrees | 1143–1393 | 8 | bloco comentado `spec 392` |
| host + agent lifecycle | 1395–2110 | ~10 | `run_host_action`, spawn/kill/dismiss/restart, saved-agent proposals, `list_agents` |
| **companion browser** | 2114–~3199 | 26 | **melhor primeira fatia mecânica**: um `if (deps.companionTabToolsEnabled?.())` já delimita; schemas/`gateMutation` locais vão com o módulo |
| config / evidence / IO | 3201–3694 | ~10 | `write_tachyon_config`…`notify_agent` |
| pins + tasks + human flags | 3696–4282 | ~15 | cluster de Mission Control |
| validations | 4284–4471 | 7 | |
| continuity + handoff | 4473–4672 | 6 | |
| commands / runbooks / wait / schedules | 4674–5001 | ~7 | usa `waitOutputGateFor` (já **módulo**, WeakMap) |
| approvals | 5003–5213 | 4 | |
| notify + probes | 5215–EOF | 1 + 2 cond. | probes já atrás de `if (deps.probe)` |

Helpers de nível-0 **já compartilhados** (`ok`, `fail`, `resolveDeclaredActor`, `emitTaskNotification`, `waitOutputGateFor`) — importar, não copiar. Estado local da função a transportar: sobretudo o bloco companion (`companionNotPairedMessage`, `gateMutation`, schemas de tab) e o `instrument`.

**Guarda existente:**

- `test/unit/bridge.test.ts` — `exposes exactly the 70 canonical tools` (lista ordenada de nomes)
- `test/unit/bridgeToolCountLunaR1Behavior.gen.test.ts` — trava a string do teste de catálogo
- `test/unit/deadToolPointers.test.ts` — `liveToolNames()` via `registerTools` real
- `test/unit/auth.test.ts` + dezenas de testes de comportamento por domínio (tasks, approvals, companion, probes, spawn…)

**Primeiro a quebrar se o corte errar:**

1. Catálogo canônico (nome some / sobra / ordem de listagem se o teste virar set-equality frágil — hoje é array sorted, então **ordem de registro não importa**; **presença** sim).
2. **`instrument` não envolve** os módulos extraídos → ledger SDD 480 some em silêncio (teste de execução/graph, não o de contagem).
3. Bloco companion ou probe **sempre** registrado (ou nunca) por mover o `if` errado.
4. Helper fechado sobre `deps` copiado em vez de importado → divergência sutil de auth/`resolveDeclaredActor`.

**Task de execução:** **t-3b47ad** (inbox). Não duplicar.

---

### 2. `src/extension.ts` — `activate` (70.5%)

**Costura natural:** `activate` não é uma lista de tools — é bootstrap + fábricas fechadas + dezenas de `registerCommand`. Cortar ao meio por linha é errado. Costuras reais:

1. **Early path (fica no topo de `activate`)** — settings globais *antes* de early-return (t-aaad95), gate tmux/Windows, metades per-workspace.
2. **`makeServerInspectorDeps`** (~116 linhas, 1156–1271) — fábrica já nomeada; extrair módulo.
3. **`makeCockpitDeps`** (**603 linhas**, 1274–1876, **16.9% do arquivo sozinha**) — maior sub-unidade; fecha sobre `workspaces()`, `context`, collectors. Extrair para `makeCockpitDeps.ts` (ou `src/cockpit/`) é o corte de maior ganho/risco baixo *dentro* de activate.
4. **Lazy activation + `folderWatcher`** (~2264–2324) — membership registry; manter junto.
5. **Registradores de comando por domínio** — comentários `// ----` já marcam: internal seams (`tachyon._*`), schedules (F23), views/Control, init/bootstrap (F5), pins, agents, resume (F29), fork (spec 225), lifecycle, bridge, commands/runbooks.
6. **Serializers / subscriptions** — `registerWebviewPanelSerializer`, dispose hooks; ordem de revive importa (Cockpit singleton).

Ordem interna sugerida: (3) makeCockpitDeps → (2) makeServerInspectorDeps → (5) command registrars por domínio → só então enxugar o corpo de `activate`.

**Guarda existente:**

- Typecheck + suite unitária ampla de comandos/sidebar/cockpit
- `test/mocks/cockpitDeps.ts` — contrato da fábrica
- Dogfood / integration (não rodar integration nesta task)
- Comentários t-aaad95 como testes de regressão comportamental (handler ausente em janela vazia)

**Primeiro a quebrar:**

1. Comando contribuído **sem handler** no early-return path (já quebrou uma vez — t-aaad95).
2. `makeCockpitDeps` capturando registry morto / lista de workspaces stale.
3. Serializer revive vs shim redirect (singleton Cockpit) — ordem de dispose.
4. `context.subscriptions` sem push → leak ou comando que some no deactivate.

---

### 3. `src/webview/Cockpit.ts` — `openCockpit` (63.9%)

**Costura natural:** a decomposição de **mensagens/VMs já aconteceu** (`src/webview/{mission-control,approval,human-inbox,activity,probes,handoff,...}/`). O monólito restante é **cola host**: painel + `send*` + `handle*` + switch `onDidReceiveMessage` + `html`.

| fatia | papel |
|---|---|
| lifecycle | create/reveal, `markCockpitSingletonClaimed`, dispose, title/icon |
| section senders | `sendModel`, `sendMission`, `sendApprovals`, `sendValidations`, `sendInbox*`, `sendHandoff`, `sendRuntime*`, `sendInspector`, `sendTaskDetail`, `sendProbes`, `sendSectionModule` — já são `const` irmãos |
| action handlers | `handleHandoffAction`, `handleTaskDetailAction`, `handleActivityAction`, `handleMissionAction`, `handleApprovalAction`, `handleValidationsAction`, `handleInboxAction`, `handleInspectorAction` |
| message router | `onDidReceiveMessage` + `switch (c.type)` (~2392+) |
| shell | `live.webview.html = renderWebviewShell(...)` (~2946) |

Padrão de corte: um `CockpitHostContext` (`live`, `panel`, `deps`, `navEpoch`/`readyEpoch`, `isCurrent`) passado a módulos `register*Section(ctx)` — espelha o que messages/ já fizeram no cliente.

**Guarda existente (forte):**  
`cockpitReadyHandshake`, `cockpitRouter`, `cockpitMissionBoard`, `cockpitActivity`, `cockpitProbes`, `cockpitFleetActions`, `cockpitNavPendingBracket`, `cockpitSupersededDispose`, `cockpitCssParity`, `cockpitStudio`, `cockpitWorktreeActions`, …

**Primeiro a quebrar:**

1. Corridas **ready/epoch** (`navEpoch` vs `readyEpoch`) — refresh após navigate.
2. Checks `panel === live` / `isCurrent` após mover closures.
3. Router roubando `ready`/`refresh` de plugins (comentário explícito no switch).
4. Singleton claim/clear assimétrico → painel em branco (histórico t-610705 / supersede).

---

### 4. `src/workspace/Workspace.ts` — `constructor` (22.0%) — **não cortar agora**

**Por que a costura existe mas não vale a pena nesta janela:**

O constructor é um **grafo de DI sequencial**, não um catálogo:

1. infra cedo (`tmux`, ledger, worktrees, harness)
2. `AgentManager({ ... materializeHarness: huge closure ... })` (~804–1270)
3. pipelines / waiters / AttentionMonitor / TemporaryBackstop / GatedCompletion / LifecycleMonitor
4. stores (pin, evolution, task, validation, continuity, handoff)
5. runners / scheduler / companion*
6. `Bridge` + ports SDD 480
7. `clientRebind` **depois** de manager+bridge

Fatias naturais *se* um dia: extrair `materializeHarness` factory; cluster de monitors; cluster de stores; factory do Bridge. Cada uma exige preservar **ordem de construção** e callbacks que fecham sobre `this` ainda meio-inicializado.

**Guarda:** 20+ arquivos de teste importam `Workspace` como valor; muitos fluxos de spawn/rebind/attention passam pelo constructor indiretamente. Blast radius máximo do repo entre os quatro.

**Primeiro a quebrar:** ordem `clientRebind` ↔ bridge ↔ manager; branch errada em `materializeHarness` (runtime pi/grok/claude/codex/hermes); AttentionMonitor sem host ports (toasts/open).

**Conclusão legítima:** em **22% e caindo** (24%→22%), com 210 métodos no arquivo (maioria pequenos) e conflito com trabalho paralelo de produção — **deixe quieto**.

---

## (c) Ordem recomendada (custo/risco)

| # | ação | por quê |
|---|---|---|
| **1 — FAÇA PRIMEIRO** | **t-3b47ad: quebrar `registerTools` por domínio** | Maior razão (80%); corte mecânico; catálogo contratual já testado; fora do cluster de perfil/lifecycle; segurança (superfície MCP) ganha legibilidade. Começar pela fatia **companion browser** (26 tools, um `if`) ou worktrees (8 tools, bloco comentado) como PR vertical; depois o resto. |
| 2 | Função forçante **sobre tamanho de função**, não de arquivo (item aberto do escopo original; formato `test/unit/webviewCssScope.test.ts`) | Em 8 dias o crescimento devolveu mais linhas monólito do que a remoção Delivery tirou (exceto Workspace). Sem trava, o plano vira faxina recorrente. |
| 3 | `extension.ts`: extrair **`makeCockpitDeps`** | 603 linhas já nomeadas; reduz `activate` sem tocar no grafo de comandos. |
| 4 | `extension.ts`: registradores de comando por domínio | Só depois da fábrica; cada bloco `// ----` vira `registerXCommands(ctx)`. |
| 5 | `openCockpit`: senders/handlers/router módulos | Guarda de testes webview é densa; fazer quando ninguém estiver em Control/Mission. |
| 6 | Workspace constructor | **Não na fila.** |

**Escolha explícita do primeiro:** **`registerTools` via t-3b47ad**, não `activate` e não Cockpit — porque o discriminante é mecânico (N registros independentes via `deps`), a guarda de catálogo é binária, e cinco outros agentes tocando produção colidem menos com Bridge tools do que com extension entrypoint ou Workspace.

---

## (d) Onde cortar **não** vale a pena

1. **`Workspace` constructor** — 22%, DI ordenado, blast radius, conflito com tasks adjacentes. Resposta correta: **deixe quieto**.
2. **Tetos por tamanho de arquivo** — incentivam espremer; o sinal é função monolítica.
3. **Bisseção arbitrário de `activate` / `openCockpit` por número de linha** sem respeitar fábricas/seções.
4. **Fragmentar o wrapper `instrument`** — tem de permanecer um único ponto que envolve *todo* `registerTool`.
5. **“Quebrar” métodos já pequenos em Workspace** (~3% max além do constructor) — ruído sem ganho.
6. **Criar uma task nova por fatia** — t-3b47ad cobre tools; demais entram quando a janela abrir, sob tasks de produto que já toquem o arquivo.

---

## (e) Entrega

- Este arquivo: `docs/research/t-1d56f9-monolith-cut-plan.md`
- Journal da t-1d56f9 (notas append)
- **Sem** commit de produção obrigatório para o DONE_WHEN; se o doc de research for commitado, é documentação de pesquisa apenas.
- **Sem** `verify:full` — zero mudança de código de produção; gate não se aplica a investigação/relato.

---

## Referências

- Task irmã: **t-3b47ad** (executar o corte de `registerTools`)
- Premissa `nodePrompt` / CI: **t-93dbf2** (feita)
- Remediação 08-01: journal t-1d56f9 `j-52efd5e99729`
- Formato de guarda mecânica: `test/unit/webviewCssScope.test.ts`, `test/unit/deadToolPointers.test.ts`
