# t-54d0c5 — o que o Tachyon já recupera depois de um restart

Medição em 2026-08-19, worktree `restauragrok`, HEAD `2387f008`. Este documento mede o que já
existe; não propõe desenho.

O cartão foi escrito em 2026-07-06 olhando o Session Restore de outro produto. A lista de itens
veio da doc pública (worktrees abertos, tabs/splits, processos se o daemon sobrevive, scrollback,
foco; no reboot do host layout/scrollback voltam e processos morrem). `/tmp/orca-re` não existe
mais. A fonte de referência usada aqui é `/home/goat/.cache/tachyon/reference/orca` (HEAD do clone
`200d8a57`; o commit citado `057db5b287` está presente). Li `LEIA-ME.md` ao lado: forma, não
código, nomes de comando nem estrutura de arquivo.

A varredura de 2026-08-02 (`t-29c627`, journal do cartão) dizia que não havia restore de layout,
foco ou scrollback, e que a captura de provider session IDs não existia. Isso já não descreve o
código de hoje.

## Amostra viva medida nesta rodada

| fato | valor |
|---|---|
| engine de produção | `tachyon-engine-b349073a…service`, PID 1031709, no ar desde 2026-08-19 12:06:32, `KillMode=control-group`, `NRestarts=0`, unidade transiente |
| scope do server tmux de produção | `tachyon-tmux-98131ca8a476.scope`, no ar desde **2026-08-17 21:47:44** — dois dias mais velho que o processo do engine |
| panes tmux vivos | `claude` criado 2026-08-17 21:47:51; `toolgrok` 13:46:28; `restauragrok` 13:48:17 |
| `session-owners.jsonl` | 318 linhas, 12 agentes, todos claude ou codex. Zero grok |
| `.tachyon/sessions.json` | 4 linhas: `claude` + 3 grok (`grok`, `toolgrok`, `restauragrok`), cada uma com `resume.sessionId` |
| hook grok deste agente | `…/restauragrok.grok/hooks/session-start.json` aponta o recorder de `session-owners.jsonl` |
| `Linger` do user systemd | `no` |
| socket tmux | `/tmp/tmux-1000/tachyon` |

O engine deste workspace atravessou pelo menos um ciclo de vida do processo (12:06 de hoje) com o
server tmux e o pane do `claude` intactos. Isso é medição, não inferência de comentário.

---

## 1. Tabela item a item

Veredito sem arquivo e linha não vale. “O que falta” só entra em PARCIAL.

### Do corpo do cartão

| item | veredito | arquivo:linha | o que falta / cartão |
|---|---|---|---|
| Worktrees abertos (checkout gerido) | **PARCIAL** | `packages/engine/src/worktree/worktreeRecord.ts:11–34` (record no ledger); `packages/engine/src/worktree/managedWorktree.ts:37` (`.tachyon/managed-worktrees.json`); `packages/engine/src/workspace/Workspace.ts:6807–6810` (reproject no `start()`) | O checkout e o registro sobrevivem nos três níveis. Não há “aba de worktree aberta” restaurada como superfície própria: a lista vive na sidebar projetada e no painel Worktrees. `t-a8f1fd` triaged cobre o ciclo de vida, não este restore de UX. |
| Tabs e splits | **PARCIAL** | `packages/engine/src/workspace/TerminalPresentation.ts:62–64, 86–101, 123–137, 184–185` (intent durável no estado do engine); `apps/vscode-extension/src/presentation/Terminals.ts:128–132, 180–198` (`isTransient: true`, restore pelo Tachyon, não pelo VS Code); `packages/engine/src/workspace/Workspace.ts:6894, 7220–7221` | Tabs de terminal integrado (camada 1) voltam com `viewColumn`. Não há splits aninhados nem mosaic. `t-9e5739` triaged (Slice 3: mosaic). `t-a03fb6` done exercitou restore de apps entre grupos de editor (SDD 485 D16) — é o editor do VS Code, não split de agente. |
| Processos do agente se o daemon sobrevive | **PARCIAL** | `packages/engine/src/engine-service/engineService.ts:301–305, 408` (`start()` é do daemon, attach do shell não entra); `packages/engine/src/workspace/Workspace.ts:2948–2952` (rebind só em encarnação nova do engine); `packages/bridge/src/clientRebind.ts:323–351` (generation bump → stop→resume); `packages/engine/src/tmux/TmuxService.ts:158–166` + `packages/engine/src/engine-service/engineSupervisor.ts:459–473` | Janela: processos ficam. Engine: o **pane** fica (scope tmux medido), o **processo do runtime** é trocado pelo rebind. Host: morre. Portas humana/agente recusam mid-turn (`t-a281e7` done). A porta do engine/rebind ainda corta. Sem cartão para esse resto; `t-3da510` done é o scope tmux. |
| Scrollback do pane vivo | **PRONTO** | `packages/engine/src/tmux/TmuxService.ts:689–692` (`history-limit: 10000`); `1061–1067` e `packages/engine/src/agents/AgentManager.ts:4196–4200, 4645` (`respawn-pane -k` conserva clientes e output) | — `t-4d2630` done. Depois que o server tmux morre, este item não se aplica: ver “snapshot após morte do host”. |
| Snapshot de scrollback depois que o host morre | **AUSENTE** | `packages/engine/src/agents/paneTranscript.ts:5–9, 45–47` (o arquivo sobrevive; não é reinyetado no pane); `packages/engine/src/agents/sessionWorkRecord.ts:3–4` (restart `session:new` declara o scrollback perdido) | Orca, no reboot, devolve o último buffer. Tachyon guarda evidência em `.tachyon/pane-transcripts/<agent>.log` (`t-6a6a00` done) e abre um pane vazio. Sem cartão para reinyetar. |
| Foco (worktree / tab / agente) | **PARCIAL** | `apps/vscode-extension/src/webview/AgentPanePanel.ts:112–117` (deserialize **descarta** o pane); `packages/engine/src/sidebar/agentFocus.ts:1–3, 115–148` (linha de trabalho, não tab focada); `packages/engine/src/workspace/TerminalPresentation.ts:86–101` (`viewColumn` da tab camada 1) | VS Code restaura o editor nativo. Agent Pane avisa para reabrir. Sidebar não persiste “qual agente estava focado”. Sem cartão para foco de UX; `t-9e5739` triaged é mosaic, não foco. |
| Provider session ID — Claude | **PRONTO** | `packages/shared/src/resume/adapters.ts:247–262` (name-mint `-n`, resume `--resume`); `packages/engine/src/resume/resolvers.ts:337–367` (uuid por `customTitle`); `packages/engine/src/activity/sessionOwners.ts:1–16, 54–56, 457–502` (SessionStart grava o uuid); `packages/engine/src/resume/sessionRecord.ts:69–77` (fica em `.tachyon/sessions.json`) | Medido hoje: `claude` → `05dfb028-5b5a-47f2-92dc-7820167f9a83` no ledger e no `session-owners` (`source: resume`). `t-58fb60` done (não confundir com o nome da sessão tmux). |
| Provider session ID — Codex | **PRONTO** | `packages/shared/src/resume/adapters.ts:326–330` (CAPTURE, `codex resume <id>`); `packages/engine/src/resume/resolvers.ts:225–251` (`session_meta.payload.id` no rollout); `packages/engine/src/activity/sessionOwners.ts:457–502` + Harness Codex SessionStart | 113/318 linhas do ledger de ownership são rollout Codex. Não há linha Codex em `sessions.json` **agora** porque nenhum Codex está no ledger vivo; a captura existe. `t-cdb013` (triaged) não contradiz isto — mede fala parcial, não a ausência do id. |
| Provider session ID — Grok | **PARCIAL** | `packages/shared/src/resume/adapters.ts:300–325` (MINT `-s`, resume `-r`, path `$GROK_HOME/sessions/<cwd>/<id>/`); `packages/engine/src/agents/AgentManager.ts:3473–3479` (UUID gravado no ledger na hora do spawn); `packages/engine/src/harness/HarnessManager.ts:2987–3023` (hook SessionStart **instalado**); `packages/engine/src/resume/resolvers.ts:375–396` (`resolveCurrentSession` para grok cai no `default` e devolve `null`) | O id está em `sessions.json` (este agente: `88e2b646-73c4-4278-8f32-bd46c5a99af6`). O hook aponta o recorder. **Zero linhas grok em 318 do `session-owners.jsonl`.** `refreshOwnership` só consulta o ledger de ownership para Claude (`AgentManager.ts:3510`). Seguir `t-cdb013`: Grok escreve `sessionId` em `updates.jsonl`; o activity writer não o ingere. Sem cartão para “grok não grava session-owners”. |

### O que o código restaura e o cartão não listou

| item | veredito | arquivo:linha | o que falta / cartão |
|---|---|---|---|
| Objeto de sessão tmux (server dedicado) | **PRONTO** | `packages/engine/src/tmux/TmuxService.ts:26, 462–469` (socket `/tmp/tmux-<uid>/tachyon`); `158–166, 172–182` (server em `systemd-run --user --scope`, fora do cgroup do engine); `770` (`remain-on-exit on`, `exit-empty off`) | Sobrerevive a reload de janela e a restart do engine (medido). Não sobrevive a reboot (`/tmp`). `t-3da510` done, `t-9713ff` done. |
| Ledger de instância + `--resume` / `resume <id>` | **PRONTO** | `packages/engine/src/resume/SessionLedger.ts:14–18`; `packages/engine/src/resume/planResume.ts:8–57, 35–55` (`reattach` / `auto-resume` / `offer`); `packages/engine/src/workspace/Workspace.ts:6773–6861` | — spec 209. Auto-resume só com sessão **ausente** + autostart. |
| Sidebar (frota projetada) | **PRONTO** | `packages/engine/src/sidebar/sidebarFleetService.ts:118–119`; `packages/engine/src/agents/AgentManager.ts:1494–1534` (`rehydrateFromLedger`) | Não é um dump de UI: reconstrói de tmux + ledger + config. Reloads de janela não precisam rehidratar se o engine ficou de pé. |
| Transcript durável do pane (`pipe-pane`) | **PRONTO** | `packages/engine/src/agents/paneTranscript.ts:5–9, 45–47`; `packages/engine/src/agents/AgentManager.ts:3843–3859`; `packages/engine/src/tmux/TmuxService.ts:1193–1197` | É evidência, não restore visual. 10 arquivos vivos hoje. `t-6a6a00` done. |
| Ledger `session-owners.jsonl` | **PARCIAL** | `packages/engine/src/activity/sessionOwners.ts:54–56, 147–160, 457–502`; `packages/engine/src/workspace/Workspace.ts:1127–1129` (`ownedSession`) | Claude e Codex gravam. Grok tem o hook e não aparece. Ver linha Grok acima. |
| Linhas mortas / resumable (remain-on-exit, offer, residue) | **PARCIAL** | `packages/engine/src/tmux/TmuxService.ts:755–770`; `packages/engine/src/resume/planResume.ts:38–54`; `packages/engine/src/agents/stoppedTemporaryResidue.ts:1–11, 40–65`; `packages/engine/src/workspace/Workspace.ts:6941–6947` | Não existe “sleep”. Há pane morto inspectável, Temporary fork/clean-exit até dismiss, offer de resume, e auto-collect de residue sem worktree. `t-01a425` done (linhas mortas pós-crash). Conceito slept: sem cartão. |
| Guarda mid-turn em resume/restart | **PARCIAL** | `packages/engine/src/agents/AgentManager.ts:206–234, 4430–4439, 4918–4923` | Recusa ↻ / Resume all / restart autenticado. Engine `onListenerReady` → rebind **não** passa por essa guarda no mesmo sentido: troca o processo de sobrevivente wired. `t-a281e7` done, `t-83d04e` done. Resto do engine: sem cartão. |
| Agent Pane (camada 2) após reload | **AUSENTE** | `apps/vscode-extension/src/webview/AgentPanePanel.ts:112–117`; serializer em `apps/vscode-extension/src/extension.ts:3163` | O serializer existe e **descarta** o painel de propósito (“MVP: do not auto-reattach”). Sem cartão; `t-9e5739` é mosaic. |
| Fila de notices após restart do engine | **PRONTO** | `packages/engine/src/workspace/Workspace.ts:6787–6791` (`reconstituteNoticeQueue`) | — `t-b47fb2` done. |
| Work-on-record em `session:new` | **PRONTO** | `packages/engine/src/agents/sessionWorkRecord.ts:1–21`; `packages/engine/src/agents/assignmentSelection.ts:1–12` | — `t-e3aaae` done. Não restaura a conversa; restaura *o que* e *onde*. |
| Continuity, handoff, board, pins, activity logs | **PRONTO** | arquivos sob `.tachyon/` (disco do workspace); `packages/engine/src/agents/primer.ts:78` (continuity sobrevive compact/clear/restart) | Independente de tmux. Não é Session Restore de pane. |
| Pipeline runs | **PRONTO** | `packages/engine/src/pipeline/PipelineManager.ts:115–122`; `packages/engine/src/workspace/Workspace.ts:6847` | Nós que sobreviveram no tmux continuam `complete_node`. |
| Engine fora da janela (systemd --user) | **PRONTO** | `apps/vscode-extension/src/engine-service/engineCurrency.ts:5–8`; `packages/engine/src/engine-service/engineSupervisor.ts:459–473`; `packages/engine/src/engine-service/engineService.ts:301–305` | Unidade transiente, `Linger=no`. Depois de reboot o engine **não** volta sozinho: volta quando um shell o lança. Isso é o produto, não um furo escondido. |

**Contagem desta tabela: 12 PRONTO, 8 PARCIAL, 3 AUSENTE.**

---

## 2. Três níveis de reinício, medidos em separado

O cartão trata “restart” como uma coisa. Não é. O engine é serviço systemd; a janela é um
cliente. Comentário no próprio `Workspace._create`: *“A Workspace is created only by a new
persistent-engine incarnation. Shell attach/reload never reaches this path.”*
(`packages/engine/src/workspace/Workspace.ts:2948–2949`).

### Reload da janela do VS Code

O shell some e reattach no socket de controle (`packages/engine/src/engine-service/controlServer.ts:111, 185–215`). O processo do engine **não** roda `Workspace.start()` de novo. Consequência:

| sobrevive | some |
|---|---|
| engine em memória (incluindo estado velho — o caso que o spawner viu hoje) | webviews da extensão; Agent Pane é descartado no deserialize |
| tmux server + panes + processos dos runtimes | cliente tmux da camada 1 (reattach via `restoreOpen` / `replay` do intent durável) |
| ledger, ownership, transcripts, worktrees, board | foco do Agent Pane |

`planResume` nem entra. `onListenerReady` / bump de generation **não** dispara. Processos mid-turn
continuam. Tabs camada 1 voltam se o intent ainda está no `DaemonStateStore`.

Não recarreguei a janela nesta sessão. O caminho de código é o de attach, não o de `start()`.
`t-5fc17d` done mede que o harness headless do Dev Host **não** sobrevive a `Developer: Reload
Window` — outro produto, outro checkout.

### Restart do engine

Unidade transiente, `KillMode=control-group`. Sem o scope de `t-3da510`, isso matava o server
tmux. Medido agora: o scope tmux tem `ActiveEnterTimestamp` 17/08 21:47 e o engine 19/08 12:06.
O pane `claude` é de 17/08 21:47. O server **não** morre com o engine.

O que o engine novo faz, em ordem:

1. `workspace.start()` redescobre sessões vivas → `reattach` (`planResume.ts:44–45`).
2. Reconstitui a fila de notices; rehidrata Temporary/lineage; reprojecta worktrees.
3. Auto-resume só do que **não** está vivo.
4. Bridge `onListenerReady` bumpa generation e, na política default `auto`, faz stop→resume dos
   wired survivors (`clientRebind.ts:327–351`).

Passo 4 é o corte. `t-83d04e` mediu panes sobreviventes e processos grok novos com `-r <id>`
em laço, 3 s de intervalo, `turn_ended cancelled / mid_turn_abort`. `t-a281e7` fechou ↻ e Resume
all; o restart do engine ainda passa pelo rebind. Resume restaura a **conversa**, nunca o **turno**.

Scrollback do pane, se o caminho for `respawn-pane -k`, fica. Conversação no runtime volta via
`--resume`/`-r`/`codex resume`. Turno em voo não.

### Reboot do host

Não rebootei. Inferência fechada por mecanismo, não por palpite:

- socket em `/tmp/tmux-<uid>/` (`TmuxService.ts:462–469`) — `/tmp` não sobrevive;
- engine é unidade **transiente** em `/run/user/1000/systemd/transient/` — some no boot;
- `Linger=no` — user systemd não permanece sem sessão de login;
- disco `.tachyon/` permanece (ledger, ownership, pane-transcripts, worktrees, board, continuity).

No próximo `start()`: zero sessões tmux → `auto-resume` dos declared+autostart, `offer` do resto,
autostart fresco de quem não tem transcript. Scrollback do pane não volta. Snapshot em
`pane-transcripts/` fica no disco, sem ser pintado. Processos mortos. Worktrees no git continuam.

---

## 3. IDs de sessão do provedor, por runtime

`t-cdb013` (`docs/research/t-cdb013-fala-parcial.md`) já mediu onde a fala parcial vive. Não
remeço isso. Abaixo é só identidade de sessão — o que o Tachyon captura e onde guarda.

### Claude — captura completa e usada

1. Spawn: name-mint `-n <nome>` (`adapters.ts:247–259`).
2. Disk: transcript `~/.claude/projects/<cwd-encoded>/<uuid>.jsonl` (ou `CLAUDE_CONFIG_DIR` de harness); uuid via `customTitle` (`resolvers.ts:353–367`).
3. Hook SessionStart: uma linha em `.tachyon/activity/session-owners.jsonl` com `sessionId` + `transcriptPath` (`sessionOwners.ts:7–12, 457–502`). Fontes observadas hoje: `startup`, `resume`, `compact`.
4. Ledger: `sessions.json` → `resume.runtime="claude"`, `resume.sessionId=<uuid>`, `resume.configHome`.
5. Resume: `--resume <uuid>` (`adapters.ts:260`). Ownership ledger ganha da linha estale em cwd compartilhado (`AgentManager.ts:4939–4947`).

`t-58fb60` (done) era exatamente o bug de usar o nome tmux no lugar do uuid.

### Codex — captura completa (CAPTURE, não mint)

1. Spawn: o CLI mint o id; Tachyon não injeta (`adapters.ts:326–330`).
2. Disk: `~/.codex/sessions/**/rollout-<ts>-<uuid>.jsonl`, primeira linha `session_meta.payload.id` + `cwd` (`resolvers.ts:225–251`).
3. Hook SessionStart Codex (`-c hooks.SessionStart=…`): mesmas linhas em `session-owners.jsonl`. 113 das 318 linhas vivas são rollout.
4. Ledger: `resume.runtime="codex"`, `sessionId` capturado no stop/refresh/resume.
5. Resume: `codex resume <id>`.

Não há Codex no `sessions.json` deste instante (nenhuma linha Codex viva no ledger). O mecanismo
está no código e o ownership ledger o testemunha.

### Grok — id mintado no ledger, ownership ledger cego

1. Spawn: Tachyon mint UUID e passa `-s <id>` (`adapters.ts:300–304`, `AgentManager.ts:3473–3479`).
2. Disk: `$GROK_HOME/sessions/<encodeURIComponent(cwd)>/<id>/` com `chat_history.jsonl` **e** `updates.jsonl`/`summary.json` (`adapters.ts:63–67, 242–245, 310–312`). `t-cdb013` mede `params.sessionId` em cada `session/update`.
3. Hook: `GROK_HOME/hooks/session-start.json` **está escrito** e chama `session-owner-record.cjs` (medido neste agente, 13:48).
4. Ledger Tachyon: `sessions.json` tem os três grok vivos, todos com UUID.
5. `session-owners.jsonl`: **zero grok** em 318 linhas / 12 agentes. A ausência no ledger de ownership não é ausência de evento — é ausência de registro (`CONSTRAINTS` do brief, confirmado).
6. `resolveCurrentSession("grok")` devolve `null` (`resolvers.ts:394–395`). Um `/clear` in-TUI no Grok não é seguido por disk-scan. `refreshOwnership` só lê `ownedSession` para Claude (`AgentManager.ts:3510`).

Resume: `-r <id>` restaura conversa, não turno (`AgentManager.ts:206–215`, e `t-83d04e`).

Gemini/Antigravity: o cartão original pedia. Há adapters (`mintsId` gemini; CAPTURE antigravity,
`resolvers.ts:318–328`). Sem amostra viva neste workspace. Não invento captura.

---

## 4. Cartões para cada AUSENTE / PARCIAL

Não abri cartão nenhum.

| lacuna | cartão | status |
|---|---|---|
| Worktrees: checkout sim, aba de worktree não | `t-a8f1fd` | triaged (ciclo de vida, não restore de UX) |
| Tabs sim, splits/mosaic não | `t-9e5739` | triaged |
| Restore de apps entre grupos de editor (VS Code) | `t-a03fb6` | done |
| Processos no reload de janela | — coberto pelo engine persistente; `t-7da04c` | done (reload-restore CORE) |
| Processos no restart do engine (rebind corta turno) | `t-83d04e`, `t-a281e7` | ambos done; **resto da porta engine sem cartão** |
| tmux no cgroup do engine | `t-3da510` | done |
| Scrollback do pane vivo | `t-4d2630` | done |
| Snapshot de scrollback reinyetado após morte do host | **sem cartão** | — |
| Transcript durável (evidência) | `t-6a6a00` | done |
| Foco de Agent Pane / agente focado | **sem cartão** | `t-9e5739` não é isto |
| Agent Pane descartado no deserialize | **sem cartão** | — |
| Session ID Claude uuid vs nome tmux | `t-58fb60` | done |
| Fala parcial / `updates.jsonl` não ingerido | `t-cdb013` | triaged |
| Grok ausente de `session-owners.jsonl` | **sem cartão** | — |
| Linhas mortas pós-crash | `t-01a425` | done |
| Slept (não existe o conceito) | **sem cartão** | — |
| Dev Host vs Reload Window | `t-5fc17d` | done |
| Linhagem gated no reload | `t-bae303` | done |
| Stop vs crash no reload | `t-9d76b1` | done |
| `/exit` no composer após reload/rebind | `t-67a565`, `t-328cc3` | ambos done |

---

## 5. O que o Tachyon tem e aquela lista não tem

O cartão olhou para fora. Por dentro, hoje:

- **Server tmux dedicado**, config-less, fora do cgroup do engine, `remain-on-exit` + `exit-empty off`. O daemon de outro produto segura PTYs; o Tachyon segura **sessões tmux** e um engine systemd. São dois substratos, não o mesmo.
- **Três destinos de resume** (`reattach` / `auto-resume` / `offer`) em vez de um “reabre tudo”.
- **Ledger de instância** com Temporary rehidratável, fork, pipeline, contrato, delegator, `lifecycle: stopped|clean-exited`, `bridgeClient.boundGeneration`.
- **Ownership ledger positivo** para `/clear` em cwd compartilhado (Claude/Codex).
- **Work-on-record** quando a conversa é jogada fora (`session:new`).
- **Fila de notices reconstituída** no restart do engine.
- **Continuity / handoff / board / pins / activity JSONL** — estado de orquestração no disco, independente de pane.
- **Guarda mid-turn** nas portas que um humano ou um agente aperta. (A porta do engine ainda não.)
- **Pane transcript** como evidência de 1 MiB rotacionada, não como buffer de UI.

Isso é o moat que o cartão perguntava (“onde já é melhor por tmux”). É real. Não cobre foco, mosaic, nem scrollback depois que `/tmp` morre.

---

## 6. O que não deu para medir

- **Reload real da janela nesta sessão.** O caminho de código é attach-only; não disparei `Developer: Reload Window` contra a frota de produção.
- **Reboot real do host.** A conclusão de “tudo em `/tmp` e unidade transiente some” é de mecanismo (`Linger=no`, socket em `/tmp`, unit em `/run/user/…/transient/`), não de um reboot que eu tenha causado.
- **Por que o SessionStart do Grok não appenda** em `session-owners.jsonl` apesar do hook instalado. Não instrumentei o runtime no `startup`. Pode ser matcher, payload, ou o recorder recusando a forma grok — não sei.
- **Token a token** de fala cortada. `t-cdb013` já delimitou isso; a amostra original de nove sessões Grok não existe mais.
- **Gemini / Antigravity** em disco neste workspace: adapters sim, amostra viva não.
- **Extension reload vs window reload** como quarto nível. O brief pediu três (janela, engine, host). O cartão original misturava “extension reload”; o `start()` do engine não corre em nenhum dos dois reloads de extensão, só em encarnação nova. Não separei um quarto experimento.
- **Estado velho em memória do engine após reload de janela** — o spawner relatou um caso concreto hoje; eu não reproduzi, só confirmei que o processo do engine (12:06) é independente da janela e que `Workspace.start()` não reentra no attach.

---

## Método

Código no worktree `restauragrok` (`2387f008`). Ledgers e systemd do workspace de produção
`/home/goat/tachyon`. Referência: clone em `/home/goat/.cache/tachyon/reference/orca`, doc pública
de Session Restore só para nomear os itens do cartão. Nada do clone foi copiado para este
repositório.
