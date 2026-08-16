# Inbox sweep — bloco D (superfícies, backlogs e resto)

**Task:** `t-07acef` · **Agent:** sweepD · **Measured:** 2026-08-16  
**Tree:** `b4e7195e23c5bcd715137936935b057f83b10662` (`34a2887b`, `0.93.6`, same tip as `main`)  
**Regra:** conferir, não consertar, não reescrever cartões, não mudar status. Método do bloco A (`t-1cacae`).

Três perguntas por cartão: o caminho citado ainda existe? o problema ainda acontece? alguma entrega posterior já resolveu?

Vereditos: **VALE COMO ESTA** · **PRECISA REESCREVER** · **NAO FAZ MAIS SENTIDO**.  
Backlogs (`t-feda36`, `t-cb36c5`): o veredito útil é **quanto do saco ainda está aberto**.

---

## Tabela

| id | veredito | motivo |
|---|---|---|
| `t-784bc8` | PRECISA REESCREVER | Tese viva, inventário morto: `src/runtime-api/` virou `packages/engine/src/runtime-api/` (19 módulos); Bridge é pacote próprio e ainda gordo (~6696 linhas de tools); sem CLI; spec 492 é só design. |
| `t-e23e57` | PRECISA REESCREVER | Inventário `agent-desktop` + `agent-screen` está aposentado (`docs/project-guidance.md:57`); a pergunta de capability governada sob host-action sobrevive. |
| `t-f05aa5` | VALE COMO ESTA | As 4 frentes não começaram. Engine ainda recusa fan-in/fan-out (`loadPipeline.ts:297–307`). O `pipeline-studio` é Fake 1 da spec 350, não o grafo. |
| `t-fe52f0` | NAO FAZ MAIS SENTIDO | As duas frentes existem: Control (`tachyon.openControl`) e companion mobile (SDD 422, PWA em `media/companion-mobile/`). Follow-ups `t-44dfb6` / `t-bd281f` / `t-af2c9b` / `t-619157` estão `done`. |
| `t-bbf516` | PRECISA REESCREVER | A linha «herdr is AGPL» é falsa (Apache-2.0 em 2026-08-16). Overlays: `grok.json` + `neutral.json`. OSC / anti-flap / catálogo assinado continuam ausentes. |
| `t-f4a26c` | VALE COMO ESTA | A classe multi-agente pedida não existe em `/home/goat/tachyon-ade-bench`. O repo cresceu intel/aquisição/T001–T005; isso não entrega o pedido. |
| `t-feda36` | **4/4 fatias abertas** (C8 parcial) | Sem `tachyon attach`, sem `agent explain`, sem hooks agent-done→notify, sem docs SSH/headless. C8 andou só via manifests de atenção. Licença AGPL **não** é premissa deste cartão. |
| `t-cb36c5` | **10/10 abertos** | `needs_confirm` segue fail-closed sem UI humana (`tabSafety.ts:154`). Firefox, audit UI, picker, alerts/CDP, rotação de `mutations.jsonl` intactos. |
| `t-b1618e` | PRECISA REESCREVER | Agenda 1/2/3 ainda aberta (deps por status em `nextTask.ts:69`). O texto não sabe que a SDD 480 nasceu e foi abandonada, nem que a 491 (Planner) está `triaged`. |
| `t-960b3c` | VALE COMO ESTA | Camada 3 continua sem cliente de protocolo na UI. A nota de arquitetura ainda marca (3) como futura. |
| `t-9e5739` | VALE COMO ESTA | Mosaic / toolbar / operator-lock da Slice 3 não existem no agent-pane. A fatia 3 do plano interno (`t-281339`) é a **carta da sidebar**, não este chrome. |
| `t-e63164` | PRECISA REESCREVER | A barra stage/submit já existe (`App.tsx:379–437`). `t-de3dfc` done — o pane **carrega** `design-system.css`. Wrap medido em claude+hermes além de codex. Sem colisão com a fatia 3. |

---

## Medição por cartão

### `t-784bc8` — Runtime API / service-layer · PRECISA REESCREVER

**Caminhos.** `src/runtime-api/` não existe. Os 19 módulos estão em `packages/engine/src/runtime-api/` (`activityProjection`, `boardCommands`/`Projection`, `handoff*`, `pinStudio*`, `sidebar*`, `taskDetail*`, `taskStudio*`, `runtimeOpsProjection`, `extensionOperations`, `stagedPayload`, `richDocWire`, `agentInputCommands`, `workspaceProjectionTypes`). O Bridge saiu do monólito: `packages/bridge/src/tools/` tem 22 arquivos, ~6696 linhas — adapter gordo, não fino. Nenhum `package.json` declara `"bin"`. `src/cli/` nunca existiu neste tree.

**Problema.** Continua sem um contrato único versionado com Bridge/CLI/UI como clientes. `t-c70fb9` (CLI) segue `triaged`. A spec 492 (event-hub) está `draft`; `t-a8f4a9` está `done` como *design*, não como troca do file-watcher da 354 por eventos de domínio (`task.created`, etc.).

**O que envelheceu.** Contagem e forma da etapa 1 (projeção+comandos por superfície) já estava na nota de 2026-08-02; desde então o monorepo moveu os caminhos e extraiu o Bridge. A sequência consumer-first ainda é o norte, mas o corpo cita `src/` e não menciona 492 / `packages/bridge`.

### `t-e23e57` — Computer Use v1 · PRECISA REESCREVER

**Caminhos.** `docs/project-guidance.md:57` proíbe os plugins `agent-screen` e `agent-desktop`. Não há `plugins.lock.json` neste checkout. Não há `computer.listApps` / `computer.snapshot` / `computer.click` em código de produto. O broker `packages/engine/src/host-action/` existe. `ExternalToolSource` ainda lista `"agent-desktop"` e `"agent-screen"` como resíduos de tipo (`packages/shared/src/externalTools/types.ts:2`). Specs 283/334/336/338 são históricas.

**Problema.** A capability governada (snapshot→act sob host-action + audit + consent) não foi desenhada nem implementada. A nota operacional de timeout 300s no `create_task` (2026-07-06) não se reproduziu nesta sessão.

**O que envelheceu.** O «Estado Tachyon» do corpo. A nota de 2026-08-02 já dizia isso; dois meses depois o inventário continua morto e a pergunta de desenho continua viva.

### `t-f05aa5` — Pipeline Fase 2 · VALE COMO ESTA

**Caminhos.** Engine em `packages/engine/src/pipeline/loadPipeline.ts:297–307`: *«a v1 pipeline must be a single linear chain … parallel nodes are a follow pass»*. Sem sensores (file/glob/push/PR) no engine. Sem Tier B / commit-por-nó / staleness per-node / pause.

**O que parece entrega e não é.** `packages/webview-ui/src/webview/pipeline-studio/App.tsx:12–16` é *«spec 350 T4 — Pipeline Studio (Fake 1)»*, hidden, só preview harness — não é o studio visual de grafo que a frente (2) pede.

As quatro frentes do corpo continuam a mesma proposta, sem contradição no HEAD.

### `t-fe52f0` — Cockpit + Mobile + webapp · NAO FAZ MAIS SENTIDO

**Frente (1).** `tachyon.openControl` / `tachyon.openCockpit` (alias legado) em `apps/vscode-extension/package.json:309–315`. Journal do próprio cartão (2026-07-16) já deu a frente desktop por landada.

**Frente (2).** SDD 422 `shipped-partial`. PWA em `apps/vscode-extension/media/companion-mobile/` (`index.html`, `manifest.webmanifest`, `sw.js`). Engine: `packages/engine/src/companion/{CompanionHttp,CompanionPairingService,mobileAppStatic,pairQr}.ts`. Umbrella `t-af2c9b` `done`; estudo `t-619157` `done`; follow-ups `t-44dfb6` e `t-bd281f` `done`. Residual declarado da 422 (Headscale, TLS v1.1) não é o escopo original deste cartão.

A nota de premissas de 2026-08-02 (*«nada de companion MOBILE»*) estava errada: o mobile landou em 2026-07-23. O corpo ainda fala em DESIGN-FIRST e num `umbrella-spec.md` na máquina Windows do maintainer — isso envelheceu porque o produto já existe.

### `t-bbf516` — Attention manifests phase 2 · PRECISA REESCREVER

**Item 1 (overlays).** `packages/shared/src/attention/manifests/` tem `base.json`, `grok.json` e **`neutral.json`** (novo desde 2026-08-02; evidência `t-c59600`, 2026-08-08). Continuam faltando overlays medidos de claude / codex / opencode.

**Itens 2–4.** `osc_title` / `osc_progress` ausentes em `packages/`. Sem anti-flap de N confirmações + grace. Sem catálogo remoto assinado.

**O que envelheceu.** O corpo: *«herdr is AGPL, do not copy code»*. Leitura de 2026-08-16 em `docs/research/competitor-internal-checklist-lote-b.md:20`: Herdr está **Apache-2.0** (`Cargo.toml`; `CHANGELOG.md:27` registra o relicenciamento). A disciplina de não copiar código continua sendo juízo de produto; a premissa legal não.

### `t-f4a26c` — ADE Bench multi-agent · VALE COMO ESTA

**Caminho.** `/home/goat/tachyon-ade-bench` existe. Suite atual: T001–T005 (bugfix, feature, dirty-worktree, CI normalizer, UI cards) — *single-task*. `docs/run-report-metrics.md` vive **naquele** repo, não neste checkout. Não há classe de cenário «start 2+ named agents / controller via API / detach-reconnect / false-positives».

O repo cresceu intel competitiva, aquisição e dashboard. Isso não fecha o pedido. O problema (score comparativo que mede o guest CLI em vez do ambiente) continua sem instrumento.

### `t-feda36` — Backlog Herdr B+C · 4/4 abertas (C8 parcial)

Backlog, não cartão de produto. Fatias da ordem sugerida, medidas hoje:

| fatia | estado |
|---|---|
| B4 `tachyon attach <agent>` | **Aberto.** Sem CLI, sem `bin`, sem comando attach. |
| C8 state/explain | **Parcial.** Manifests de atenção andaram (`grok` + `neutral`). Sem `agent explain`, sem labels customizáveis, sem lifecycle hooks por runtime além do que o attention já faz. |
| C9 hooks agent-done/crash/worktree.created → notify | **Aberto.** Nenhum hook reativo desses nomes no engine. |
| B2/B10 SSH remoto + Bridge headless | **Aberto.** Spec 235 existe como documento; sem path CLI/docs de attach remoto. |

**Licença.** Este cartão **não** assume AGPL. O framing (Herdr ≈ tmux consciente de agente; Tachyon ≈ fleet no editor) continua coerente com a leitura de 2026-08-16: Herdr é multiplexer/PTY host, sem board, sem plan store. O relicenciamento Apache-2.0 não fecha nenhuma caixa B/C e não torna o cartão falso.

### `t-cb36c5` — Backlog Companion browser · 10/10 abertos

| # | residual | hoje |
|---|---|---|
| 1 | Human confirm UI | **Aberto.** `tabSafety.ts:125–154` ainda devolve `needs_confirm` fail-closed. Sem superfície de aprovar/rejeitar mutação. |
| 2 | Native alerts / `window.confirm` / CDP | **Aberto.** Sem broker/CDP de dialog. |
| 3 | Cross-origin iframes | **Aberto.** Limite de browser; fail-closed. |
| 4 | Frames exóticos | **Aberto.** |
| 5 | `mutations.jsonl` rotation/retention | **Aberto.** `tabSafety.ts:179–194` é append-only; sem rotação. |
| 6 | Broader trust policy | **Aberto.** `allowedHosts` existe como v1; o «além de» da 414 continua deferred. |
| 7 | Companion Audit trail UI | **Aberto.** Closure da 414 ainda lista como fora do SDD. |
| 8 | Firefox + store | **Aberto.** |
| 9 | Multi-engine picker | **Aberto.** |
| 10 | Cookbook operator path | **Aberto** no companion *browser* (414 não tem cookbook). 422 tem `cookbook.md` — é o irmão mobile, não este saco. |

Nenhum dos 10 foi puxado. `t-5fcbd3` entregou o gate fail-closed e adiou a UI — exatamente o estado que o corpo descreve.

### `t-b1618e` — Graph Engineering · PRECISA REESCREVER

**Agenda ainda inteira.** Sem skill `orchestrate-project`. Deps desbloqueiam por **status** (`packages/shared/src/tasks/nextTask.ts:69`: só `done` / `dropped`), não por merge em `origin/main`. Sem runbook «Graph Engineering com Bridge» em `docs/runbooks/`. Sem Linear.

**O que o corpo não sabe.** SDD 480 (Execution Graph) entregou em 2026-07-28 e foi **abandonada** em 2026-08-09 (`t-af240d`, merge `566c7e36`) — e era grafo de *processos*, não waves merge-gated. SDD 491 (Planner: eixo do tempo sobre o Board) existe e o cartão `t-2bba9c` está `triaged`. Um leitor que pegar `t-b1618e` hoje reinventaria o contexto.

### `t-960b3c` — Layer 3 protocol UI · VALE COMO ESTA

Camada 1 (terminal integrado) continua o default. Camada 2 landou e cresceu (`packages/webview-ui/src/webview/agent-pane/` — identity, xterm, stage/submit, pin). Camada 3: zero cliente ACP / Codex app-server / stream-json alimentando UI própria no pane. A nota `docs/architecture/agent-pane-first-party-surface.md` ainda marca (3) como *Future, out of scope*. A decisão de 2026-07-24 (coexistir 1+2; 3 trilha futura) não foi contradita. Pesquisa estacionada, como o journal pede.

### `t-9e5739` — Agent pane Slice 3 · VALE COMO ESTA

Grep por `mosaic` / toolbar de paridade / operator-lock em `packages/webview-ui/src/webview/agent-pane` e `AgentPanePanel.ts`: vazio. O pane tem identity strip, viewport, stage/submit e Pin — fatias 1–2. A arquitetura ainda lista Slice 3 (toolbar, mosaic, paste policy) como futura. «Do not start until human prioritizes» continua verdadeiro.

**Não colide com a fatia 3 do plano interno.** `t-281339` (done 2026-08-16) acrescentou uma linha de checklist na **carta da sidebar** (`sidebar/App.tsx:556–575`), não no agent-pane.

### `t-e63164` — Composer do operador · PRECISA REESCREVER

**O que o MVP pedia e o que existe.**

| pedido | hoje |
|---|---|
| redação multi-linha | **Sim.** `<textarea rows={2}>` em `packages/webview-ui/src/webview/agent-pane/App.tsx:379–393`. |
| envio pelo inject 381 | **Sim.** `agent-pane/stage` e `agent-pane/submit`. |
| fila enquanto ocupado | **Não.** `busy` só desabilita o campo (`:385`, `:432` «Refused by host when the agent is busy»). |
| trava de teclado do xterm | **Não.** |

**Pré-requisito de wrap (o corpo diz «só o codex»).** Mentira atual: `continuationLine` medido em **codex** (`runtimeProfile.ts:418`, `t-7a297f`), **claude** (`:276`, `t-ba5357`) e **hermes** (`:569`). Grok e OpenCode continuam sem regra (`:476`, `:530`) — o teste `runtimeComposerWrapMeasured.test.ts:41–56` documenta os dois como undeclared de propósito.

**Restrição de superfície.** O corpo cita `AgentPanePanel.ts:161` recusando `design-system.css`. Hoje `:165–166` **carrega** `tokens.css` + `design-system.css` + `quick-picker.css`. `t-de3dfc` está `done`.

**Colisão com a fatia 3 do checklist interno.** Nenhuma. `t-281339` pintou a carta da sidebar. O agent-pane não ganhou linha de plano. Superfícies distintas.

**O que envelheceu.** Caminhos `src/webview/…`; a afirmação «medir os outros quatro antes da UI» (a UI já existe); a restrição do design system; o inventário de wrap. A decisão do dono (TUI nativa fica; o campo nosso tem que funcionar) continua o norte.

---

## O que este sweep não fez

Não reescreveu cartão, não mudou status, não implementou, não abriu cartão novo. Os dois backlogs não receberam vale/não-vale — só a contagem do que ainda está aberto.
