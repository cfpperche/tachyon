# Inventário: as 68 ações de `EXTENSION_COMMAND_ACTIONS` contra o critério do gesto humano

`t-dd27f1`. Levantamento e medição — **não** é conserto, e não propõe arquitetura. O dono tem três
opções na mesa (isolar agentes por uid/sandbox; tirar a decisão da máquina; parar de afirmar o que
não se prova); este documento existe para dizer o **tamanho** do problema, não para escolher a saída.

Complementa `docs/research/control-socket-caller-identity.md`, que mediu a camada de baixo — por que o
daemon não sabe quem chamou. Este documento mede a camada de cima: **o que** o chamador desconhecido
alcança, ação por ação.

## O critério que está sendo aplicado

Corrigido na t-6edd70 (journal `j-d211899f3c5c`), depois de a formulação anterior ter dado um falso
negativo:

> Não é *"a ação de decisão está fora da lista"*. É: **nenhuma ação nomeada produz o efeito sem o
> gesto humano.**

O contraexemplo que originou a correção: não existe nenhuma ação `savedAgent.*` na lista — e o
**efeito** de aprovar uma proposta de Saved Agent viaja como `agent-profile.saved-agent-create-v2`,
que está na lista. A ausência da palavra "approve" não protegeu nada.

Por isso a coluna de efeito deste inventário foi preenchida **seguindo o handler**, e nunca lendo o
nome da ação. Onde nome e efeito discordam, a discordância está anotada — é o achado mais valioso da
linha.

## Como ler as marcas

| Marca | Significa |
| --- | --- |
| **REPRODUZIDO** | Um falante CRU do control socket executou a ação contra o daemon de produção e o efeito durável foi lido de volta do disco. Teste nomeado na linha. |
| **LIDO** | Leitura do handler até o efeito durável. Não reproduzido. Pode estar errado, e a forma de descobrir é reproduzir. |

**Veredito** = "esse efeito deveria exigir gesto humano?", respondido em três valores: **SIM**, **NÃO**,
**DUVIDOSO**. Para cada DUVIDOSO a linha diz o que decidiria.

**Outra porta** = por onde mais um agente já alcança o mesmo efeito hoje, sem passar por esta ação.
Esta coluna é o que transforma a contagem em tamanho: uma ação com `write_tachyon_config` ao lado não
é uma capacidade nova, é a mesma autoridade por outro corredor. As portas citadas foram enumeradas a
partir das **113 ferramentas** registradas em `src/bridge/tools.ts` (a superfície sancionada de
agente) e do sistema de arquivos do workspace, que todo agente escreve.

## Contagem final

| Veredito | Ações | |
| --- | ---: | --- |
| **SIM** — o efeito deveria exigir gesto humano | **28** | de 68 |
| **DUVIDOSO** | **19** | de 68 |
| **NÃO** | **21** | de 68 |

Das 28 **SIM**:

- **8 REPRODUZIDAS** por falante cru do socket contra o daemon de produção: `approval.resolve`,
  `agent-profile.saved-agent-create-v2`, `agent-profile.studio-commit` (t-6edd70);
  `agent-profile.studio-lifecycle`, `proposal.approve`, `agent-profile.authorize-skill`,
  `config.companion.allowedHosts`, e `proposal.create` como elo da cadeia (t-dd27f1). As outras 20 são
  **LIDAS**.
- **26 têm outra porta** já aberta ao agente (arquivo do workspace ou ferramenta da Bridge). Só **2**
  — `proposal.approve` e `proposal.reject` — dependem exclusivamente do nome estar na lista.

Esse último número é a medida que interessa: **tirar as 28 da lista fecharia 2 efeitos.**

## A tabela

Handlers em `src/engine-service/extensionOperationService.ts` (`executeExtensionCommand`, l. 261-665);
esquemas em `src/runtime-api/extensionOperations.ts`.

| # | Ação | Efeito durável (seguido até o disco/processo) | Exige humano? | Marca | Outra porta do agente |
| ---: | --- | --- | :---: | :---: | --- |
| 1 | `pipeline.seed` | Grava um run de pipeline **fabricado** no store de runs, com nós marcados `done` / `awaiting-approval` como se tivessem executado. | DUVIDOSO — decide: se estado de run é lido por humano como evidência do que aconteceu, forjá-lo é ato humano. | LIDO | nenhuma nomeada |
| 2 | `agent.spawn` | Processo vivo + registro no ledger. `options` carrega `cmd`, `cwd`, `parent`, `instructions`, `worktree` **sem** o contrato de delegação, sem a allowlist de runtime LLM e sem as regras de claim que `spawn_agent` impõe (tools.ts:1596-1630). | DUVIDOSO — o efeito não é novo; as guardas puladas são. Decide: as guardas do `spawn_agent` são política de produto ou só ergonomia? | LIDO | `spawn_agent`, `spawn_terminal` |
| 3 | `pin.create` | Pin durável em `.tachyon/pins.json`. Autor vem do payload (`by`), não do chamador. | NÃO (efeito) — mas a autoria é autodeclarada aqui, e resolvida do chamador em `create_pin`. | LIDO | `create_pin` |
| 4 | `command.run` | Executa um comando declarado (processo). | NÃO | LIDO | `run_command` |
| 5 | `command.tick` | Dispara os comandos vencidos do scheduler. | NÃO — agregação de (4). | LIDO | `run_command` |
| 6 | `runbook.run` | Executa um runbook declarado (multi-passo). | NÃO | LIDO | `run_runbook` |
| 7 | `proposal.create` | Proposta de schedule pendente. **`by` vem do payload** — e é exatamente o nome que `approveProposal` consulta para o grant. | NÃO (efeito) / **SIM (atribuição)** — o proponente é autodeclarado. | **REPRODUZIDO** (`namedActionHumanGateReachability`, teste 1) | `propose_schedule` (atribui pelo chamador) |
| 8 | `proposal.approve` | Escreve o schedule em `tachyon.yml` e ativa o scheduler → **execução autônoma recorrente**. Gate: `grants.proposeSavedAgent` do proponente (Workspace.ts:6156-6159). | **SIM** | **REPRODUZIDO** (teste 1 — e o grant que o gate lê foi escrito pelo mesmo falante, via #62) | **nenhuma** |
| 9 | `proposal.reject` | Remove a proposta pendente. | **SIM** — é a outra metade da decisão; um agente enterra a proposta antes de o humano ver. | LIDO | **nenhuma** |
| 10 | `approval.resolve` | Registro em `.tachyon/approvals/<id>.json` vira `resolved` + linha no ledger `.tachyon/approvals.jsonl`. Ambos gravam `resolvedBy: "vscode"` — constante do servidor. | **SIM** | **REPRODUZIDO** (`approvalResolveSocketReachability`, t-6edd70) | escrita direta no arquivo do registro (ver "Segunda porta", abaixo) |
| 11 | `config.agent.clone` | Novo agente no roster / novo perfil canônico clonado. | DUVIDOSO — decide: autoria de roster é ato humano? Hoje não é, por desenho. | LIDO | `write_tachyon_config`; `.tachyon/agents/<a>/agent.yml` |
| 12 | `config.notifications.idleAfterMinutes` | `settings.notifications.idleAfterMinutes` em `tachyon.yml`. | NÃO — preferência de notificação. | LIDO | `write_tachyon_config` |
| 13 | `config.agent.rename` | Renomeia o agente e move o perfil canônico em transação. | DUVIDOSO — decide: renomear é editar identidade ou etiqueta? | LIDO | `write_tachyon_config` (parcial — a transação de perfil não) |
| 14 | `config.agent.delete` | Cascata: para a sessão, remove o worktree, apaga a entrada e **executa o Forget canônico do perfil**. | DUVIDOSO — as peças já são do agente (`dismiss_agent`, `remove_worktree`), mas Forget é porta governada no Agent Studio. Decide: Forget é decisão humana ou higiene? | LIDO | `dismiss_agent` + `remove_worktree` |
| 15 | `config.agent.promote` | Instância Temporary vira entrada `terminals:` durável em `tachyon.yml`; ledger passa a `saved`. | DUVIDOSO — persistir uma instância é decisão de roster; recusas já limitam (só terminal, sem worktree). | LIDO | `write_tachyon_config` |
| 16 | `config.command.delete` | Remove um comando de `tachyon.yml`. | NÃO | LIDO | `write_tachyon_config` |
| 17 | `config.runbook.delete` | Remove um runbook de `tachyon.yml` (recusa se estiver rodando). | NÃO | LIDO | `write_tachyon_config` |
| 18 | `config.companion.tabTools` | Liga `settings.companion.tabTools` → habilita as ferramentas `user_browser_*` da frota **sobre as abas reais do navegador do humano**. | **SIM** — concede à frota uma capacidade sobre a máquina/sessões do humano. | LIDO (a irmã #19 foi reproduzida) | `write_tachyon_config` |
| 19 | `config.companion.allowedHosts` | Escreve `settings.companion.allowedHosts` — a allowlist que **limita** `user_browser_*`. | **SIM** — é a guarda que a documentação de agente descreve como "human-owned config, which you cannot widen". | **REPRODUZIDO** (teste 3) | `write_tachyon_config` |
| 20 | `agent.fork` | Novo agente com o snapshot de continuidade do original (`snapshotContinuityForFork`) + registro de lifecycle. | DUVIDOSO — decide: duplicar um agente com o contexto de outro é criação de identidade ou cópia de processo? Nenhuma ferramenta da Bridge faz fork. | LIDO | nenhuma nomeada (`spawn_agent` cria, não forka) |
| 21 | `agent.continue-task` | Spawna o agente destino com handoff focado. | NÃO | LIDO | `continue_task` |
| 22 | `worktree.remove` | Remove o worktree do agente. | NÃO | LIDO | `remove_worktree` |
| 23 | `worktree.delete-branch` | `git branch -D` do branch nomeado. | DUVIDOSO — pode destruir trabalho não contido em `main`. Decide: perda de commits é higiene ou ato humano? | LIDO | `reconcile_worktree_hygiene`, `remove_worktree` |
| 24 | `worktree.forget-record` | Remove a entrada do registro de worktrees, **gravando `actor: { kind: "human" }`** (l. 493). | DUVIDOSO (efeito) / **SIM (atribuição)** — grava um ator humano que não agiu. | LIDO | `unregister_worktree` (atribui ao agente) |
| 25 | `worktree.remove-managed` | Remove o worktree classificado (+ branch opcional), **gravando `actor: { kind: "human" }`** (l. 531). Recusa worktree de agente com dono presente. | DUVIDOSO (efeito) / **SIM (atribuição)** | LIDO | `remove_worktree`, `reconcile_worktree_hygiene` |
| 26 | `agent.verify` | Roda o gate de verify no worktree do agente e **grava a atestação**. | NÃO — é o mesmo comando que o agente já dispara. | LIDO | `verify_agent` |
| 27 | `agent.reanchor` | Digita o lembrete de papel na pane do agente. | NÃO | LIDO | `reanchor_agent` |
| 28 | `agent.inject-continuity` | Injeta o brief de continuidade **na pane de outro agente**, com `origin: "ui"`. | **SIM** — `write_input` é escopado por linhagem por decisão explícita (t-bec361: "typing into someone else's terminal is a command gesture, not a message"); esta porta não é. | LIDO | `set_continuity` escreve o brief; a **injeção** só por `write_input`, que é escopado |
| 29 | `agent.resume-all` | Retoma **toda** a frota retomável (spawna processos). | DUVIDOSO — agregação; decide: ressuscitar a frota inteira de uma vez é operação de dono? | LIDO | `restart_agent` (por agente) |
| 30 | `workspace.stop-all` | Mata todos os agentes, comandos e runbooks. | DUVIDOSO — agregação de `kill_agent`; nenhuma autoridade nova, mas para a frota inteira. | LIDO | `kill_agent` (por agente) |
| 31 | `pipeline.start` | Inicia um run de pipeline: worktree do run + spawn dos nós. | DUVIDOSO — decide: iniciar um pipeline é executar trabalho declarado (não) ou comprometer a frota (sim)? | LIDO | `spawn_agent` (peça a peça) |
| 32 | `pipeline.approve` | Libera um nó cujo `gate: "approve"` **é** o ponto de revisão humana do pipeline (`PipelineManager.ts:182-187`). | **SIM** | LIDO | nenhuma nomeada (`complete_node` sinaliza conclusão, autenticado por nonce do nó — não é o gate) |
| 33 | `pipeline.reject` | A outra metade do mesmo gate. | **SIM** | LIDO | nenhuma nomeada |
| 34 | `pipeline.cancel` | Cancela o run em andamento. | DUVIDOSO — interrompe trabalho de terceiros. | LIDO | `kill_agent` (por nó) |
| 35 | `pipeline.rerun` | Reexecuta a partir de um nó. | NÃO | LIDO | `spawn_agent` |
| 36 | `pipeline.dismiss` | Descarta o registro do run. | NÃO | LIDO | escrita de arquivo |
| 37 | `pipeline.apply-input` | Lê o arquivo de input do run para dentro do run. | NÃO | LIDO | escrita de arquivo |
| 38 | `pipeline.delete` | `fs.rmSync` da definição do pipeline. | NÃO — o agente já apaga arquivos. | LIDO | escrita de arquivo |
| 39 | `bridge.restart` | Derruba e recria o listener da Bridge; a porta pode mudar e **todos os runtimes registrados precisam reconectar**. | DUVIDOSO — decide: interromper o canal de toda a frota é operação de dono? | LIDO | nenhuma nomeada |
| 40 | `bridge.stop` | Desliga a Bridge. | **SIM** — desliga o canal por onde passa toda a governança de agente, **inclusive `request_human_approval`**. Um agente pode remover o próprio mecanismo de escalada ao humano. | LIDO | nenhuma nomeada |
| 41 | `bridge.refresh-tools` | Força reemissão da lista de tools MCP. | NÃO | LIDO | nenhuma nomeada |
| 42 | `config.health` | Recarrega config e devolve relatório — **e, quando há falha de config, SPAWNA um agente do LKG** (`configHealth`, l. 763). | NÃO (o spawn já é do agente) — **mas o nome e o efeito discordam**: uma ação chamada "health", classificada como comando, cria um processo. | LIDO | `spawn_agent` |
| 43 | `companion.unpair` | Revoga à força as sessões de dispositivo Companion e derruba os clientes vivos. | DUVIDOSO — nega ao humano um canal que ele usa para decidir. Decide: negar a superfície humana conta como produzir efeito humano? | LIDO | nenhuma nomeada |
| 44 | `handoff.note` | Anexa nota ao handoff compartilhado do projeto **com `agent: "tachyon"` fixo** (l. 657-662). | NÃO (efeito) / **SIM (atribuição)** — a nota do agente é assinada como se fosse do produto. | LIDO | `append_project_handoff_note` (atribui ao chamador) |
| 45 | `prompt.inject` | Digita um template na pane de outro agente e, com `submit: true`, **envia**. | **SIM** — mesma razão de #28: `write_input` é escopado por linhagem e recusa destinatário ocupado; esta porta checa `attention`, mas não checa quem chamou. | LIDO | `write_input` (escopado por linhagem) |
| 46 | `runtime-ops.provider.configure` | Grava a preferência de observação do provider com **`consent: "explicit-user"`** (l. 645-647). O leitor a jusante recusa qualquer coisa que não seja esse valor. | **SIM** — grava consentimento humano explícito que nenhum humano deu. | LIDO | nenhuma nomeada |
| 47 | `runtime-config.mark-pending` | Marca os agentes vivos como tendo config de runtime pendente. | DUVIDOSO — sinalização; decide se induzir relaunch de terceiros conta. | LIDO | nenhuma nomeada |
| 48 | `soul.profile.create` | Cria a SOUL canônica do agente (`.tachyon/agents/<a>/SOUL.md`). | **SIM** — identidade durável (t-93ac7f). | LIDO | o arquivo (`agentSoulPath`) |
| 49 | `soul.profile.import` | Importa bytes de SOUL de um payload staged. **O staging é do CLIENTE** (`WorkspaceClient.stagePayload` escreve o arquivo 0600 no runtime dir): um falante same-uid escreve o payload ele mesmo. | **SIM** | LIDO | o arquivo |
| 50 | `soul.profile.replace` | Substitui a SOUL (com `expectedDigest`). Mesmo transporte de payload. | **SIM** | LIDO | o arquivo |
| 51 | `soul.profile.adopt` | Adota a SOUL pendente pelo digest. | **SIM** | LIDO | o arquivo |
| 52 | `soul.profile.enable` | Liga a SOUL para o agente. | **SIM** | LIDO | o arquivo / `write_tachyon_config` |
| 53 | `soul.profile.disable` | Desliga a SOUL. | **SIM** | LIDO | o arquivo / `write_tachyon_config` |
| 54 | `soul.profile.delete` | Apaga a SOUL canônica. | **SIM** | LIDO | o arquivo |
| 55 | `evolution.approve` | **Promove** o candidato pendente para o perfil ativo do agente (learning ou skill), `activeVersion + 1`. A descrição de `submit_evolution_review` diz textualmente: *"remain inert until a human approves them in Agent Studio"*. | **SIM** — o agente propõe pela porta sancionada e aprova por esta; o laço de auto-modificação fecha inteiro dentro do agente. | LIDO — **não reproduzido**, ver "O que não medi" | arquivos sob `.tachyon/agents/<a>/evolution/`, ligados por HMAC de custódia do host (única família da lista com binding criptográfico) |
| 56 | `evolution.reject` | Rejeita o candidato pendente. | **SIM** — a outra metade. | LIDO | idem |
| 57 | `tmux.kill` | Mata a sessão tmux (identidade da pane confirmada antes). | NÃO | LIDO | `kill_agent` |
| 58 | `tmux.recover` | Recupera o servidor tmux travado. | NÃO | LIDO | nenhuma nomeada |
| 59 | `terminal.open` | Abre um terminal no VS Code do humano, anexado à sessão. | DUVIDOSO — efeito na tela do humano, não durável. | LIDO | nenhuma nomeada |
| 60 | `terminal.close` | Fecha esse terminal. | DUVIDOSO | LIDO | nenhuma nomeada |
| 61 | `agent-profile.studio-commit` | Commita o perfil canônico do agente: runtime, papel, cwd, lifecycle, worktree, isolamento. | **SIM** — é a forma governada de editar identidade e capacidade. | **REPRODUZIDO** (t-6edd70, e usada como elo nos testes 1 e 2 da t-dd27f1) | `.tachyon/agents/<a>/agent.yml` — o próprio código chama isso de *"precisamente a porta ungoverned que a feature inteira existe para fechar"* (agentProfileStudio.ts:190-191) |
| 62 | `agent-profile.studio-lifecycle` | Cinco operações: `set-enabled`, `rename`, `forget`, `set-subagents` e **`set-propose-saved-agent-grant`** — a concessão da autoridade que gateia `propose_saved_agent` e `proposal.approve`. | **SIM** | **REPRODUZIDO** (teste 1: o agente concede a si mesmo) | o mesmo arquivo de perfil |
| 63 | `agent-profile.studio-bundle-clone` | Clona um bundle de perfil inteiro para um agente novo; devolve `requiresReauthorization`. | **SIM** — cria agente com capacidades derivadas. | LIDO | o arquivo de perfil |
| 64 | `agent-profile.studio-bundle-import` | Cria um agente a partir de bytes de bundle **externos** (payload staged, mesmo transporte de #49). | **SIM** — origem externa, capacidades embutidas. | LIDO | o arquivo de perfil |
| 65 | `agent-profile.saved-agent-create` | Cria um Saved Agent e grava o dono na MESMA transação (v1). | **SIM** | LIDO (a v2 foi reproduzida) | `write_tachyon_config` + arquivo de perfil |
| 66 | `agent-profile.saved-agent-create-v2` | v1 + `owner` opcional + `grants.proposeSavedAgent`. **É o EFEITO de aprovar uma proposta de Saved Agent** (`commitSavedAgentProposal`, extension.ts:1464 → `ClientWorkspaceStudioTarget:202-221`). | **SIM** | **REPRODUZIDO** (t-6edd70) | `write_tachyon_config` + arquivo de perfil |
| 67 | `agent-profile.authorize-skill` | Autoriza uma Agent Skill no perfil canônico e a seleciona. O comentário do handler diz: *"clicking Authorize IS the host authorization"* (Workspace.ts:5509-5518). | **SIM** — o clique é uma ação nomeada. | **REPRODUZIDO** (teste 2) | o arquivo de perfil |
| 68 | `agent-profile.authorize-plugin` | O mesmo, para um plugin inteiro. | **SIM** | LIDO (a irmã #67 foi reproduzida) | o arquivo de perfil |

## Quatro coisas que a tabela não mostra sozinha

### 1. Nome e efeito discordam em três lugares

O brief avisou que essa discordância é o achado mais valioso de uma linha, porque foi assim que a
contagem anterior errou. Três casos:

- **`agent-profile.saved-agent-create-v2`** (#66) — o já conhecido. Nome de criação, efeito de
  aprovação.
- **`config.health`** (#42) — nome de diagnóstico, classificada como **comando**, e o handler
  **spawna um agente** quando a config está quebrada (`configHealth`, l. 756-774). Quem auditar a
  lista procurando "o que cria processo" não vai olhar aqui.
- **`proposal.create`** (#7) — parece inócua ao lado de `proposal.approve`, e é ela que fixa o campo
  `by` que o gate de aprovação vai consultar. O proponente é escolhido pelo payload.

### 2. Seis lugares gravam um ator que ninguém provou

Não é um bug repetido; é a mesma decisão de desenho aparecendo onde quer que uma superfície precise
declarar quem agiu, sem ter como saber:

| Onde | O que grava |
| --- | --- |
| `approval.resolve` → registro + `.tachyon/approvals.jsonl` | `resolvedBy: "vscode"` |
| Companion `POST /companion/v1/approvals/resolve` (t-de7df4) | `resolvedBy: "companion"` |
| `worktree.forget-record` | `actor: { kind: "human" }` |
| `worktree.remove-managed` | `actor: { kind: "human" }` |
| `runtime-ops.provider.configure` | `consent: "explicit-user"` |
| `handoff.note` | `agent: "tachyon"` |

O repositório já sabe metade disso. `Workspace.ts:6649-6652` diz, sobre o principal de formação:

> `kind: "human"` here asserts *which surface acted*, and this repository has no way to assert more
> than that. Writing a person's name in would claim a witness that does not exist.

A medição da t-6edd70 aperta a frase um passo: **a superfície também não está provada.** O falante cru
attacha com `shell.id` e `version` inteiramente autodeclarados, e o daemon valida forma, nunca
proveniência. Então "qual superfície agiu" é tão afirmado-sem-prova quanto "quem agiu".

Isto importa para a opção (3) do dono — *parar de afirmar o que não se prova*. A t-de7df4 já a
esticou de um literal para dois. São **seis**, e a regra tem de valer para o sétimo.

### 3. A segunda porta: em 26 das 28, tirar da lista não fecha o efeito

`write_tachyon_config` é uma ferramenta **registrada da Bridge** (tools.ts:3898) que valida e grava o
`tachyon.yml` inteiro. `.tachyon/agents/<a>/agent.yml`, `SOUL.md` e os registros de aprovação são
arquivos comuns do workspace, e todo agente escreve arquivos. As duas únicas linhas SIM sem segunda
porta são `proposal.approve` e `proposal.reject`.

E há uma porta que **não é ação nomeada nenhuma**, medida aqui pela primeira vez:

O registro de aprovação declara um recibo à prova de adulteração —
`approvalRequest.ts:108-110`: *"tamper-evident receipt. The host-side resolver re-validates this on
load so a mutated file is rejected, never silently honored."* O `payloadHash` é um SHA-256 sobre o
`payload` **autorado pela criança** (`computePayloadHash`, l. 149-156). `status` e `resolution` ficam
**fora** dele. Medido (`namedActionHumanGateReachability`, teste 4): editando o JSON à mão para
`status: "resolved"` + `resolution.resolvedBy: "vscode"`, o **leitor de produção**
(`readApprovalRequest` — por onde passa `get_approval_status` e todo consumidor a jusante) aceita, e
o `payloadHash` continua batendo, porque o payload não foi tocado.

É a forma exata que `docs/project-guidance.md` descreve em `t-e73e54`: um comentário afirmando uma
propriedade que a checagem ao lado não cobre. Aberto como task separada.

**Atualização 2026-08-05 (t-65e80b), sobre a metade do LEITOR — a medição acima fica como está.** A
decisão passou a ter selo próprio (`decisionSeal`, sobre `status`/`resolution`/`cancellation`,
recalculado na porta única de escrita) e `readApprovalRequest` recusa um registro cujos bytes de
decisão mudaram depois de selados. **A porta continua aberta**: a escrita não é impedida, e o teste 4
segue medindo o arquivo forjado em disco — o que mudou é que o leitor de produção não o entrega mais
como verdade. O selo prova bytes, nunca autor, e um registro sem selo é anterior à mudança, não
adulterado. Fechar a porta continua sendo t-5313dc; rebaixar o selo apagando seus dois campos é o
limite medido em t-f85a02.

### 4. A superfície do fio é maior que estas 68 ações

A t-6edd70 mediu que o daemon só decodifica os 19 métodos de `WorkspaceCommandMethodV1` e os nomes de
`EXTENSION_COMMAND_ACTIONS` — e essa medição foi lida como "só as ações importam". Ela prova que um
método **não listado** é recusado; não que os 19 listados sejam inofensivos. Eles incluem
`agent.input` (digitar em qualquer pane), `agent.kill`, `agent.stop`, `studio.submit`, `sidebar.mutate`,
`task.update` e `pin.studio.apply`. Fora do escopo desta tabela por instrução do brief; anotado para
que a próxima contagem não repita o erro de contar uma lista e concluir sobre a superfície inteira.

## O que não medi, e por quê

- **60 das 68 linhas são LIDO.** Leitura de handler até o efeito durável, sem reprodução. A instrução
  era amostrar antes de afirmar; a amostra são as 8 reproduzidas.
- **`evolution.approve` / `evolution.reject` (#55, #56) são as SIM mais graves que ficaram sem
  reprodução.** Reproduzir exige semear um candidato pendente no `EvolutionStore`, cujos arquivos são
  ligados por um HMAC de custódia do host (`authorityIntegrityKey`, vindo do SecretStorage via
  `loadOrCreateHmacKey`). Um candidato semeado à mão provavelmente seria recusado por integridade — e
  uma recusa dessas mediria o meu fixture, não o produto. É a lacuna que eu fecharia primeiro.
  Observação que **não** medi e declaro como não medida: a t-93ac7f já mediu que SecretStorage é
  material same-uid, o que sugere que esse HMAC também não é fronteira contra um agente. Não
  reproduzi, e ninguém deveria construir sobre isso sem reproduzir.
- **`config.companion.tabTools` (#18)** foi lida, não reproduzida; a irmã `allowedHosts` (#19), que
  passa pelo mesmo `configMutation` + `setCompanion*`, foi reproduzida.
- **Nenhuma linha de código de produto foi tocada.** Este levantamento entrega uma tabela e um
  arquivo de teste de caracterização.

## Onde estão as reproduções

| Arquivo | Ações medidas |
| --- | --- |
| `test/unit/approvalResolveSocketReachability.test.ts` (t-6edd70, na `main`) | `approval.resolve`, `agent-profile.studio-commit`, `agent-profile.saved-agent-create-v2` |
| `test/unit/companionPairApprovalReachability.test.ts` (t-de7df4, na `main`) | a segunda porta de resolução, via `companion.pair-code` (query) + HTTP |
| `test/unit/namedActionHumanGateReachability.test.ts` (t-dd27f1, este trabalho) | `agent-profile.studio-lifecycle`, `proposal.create`, `proposal.approve`, `agent-profile.authorize-skill`, `config.companion.allowedHosts`, e a porta de arquivo do registro de aprovação |

Todos são **testes de caracterização**: fixam o defeito como comportamento de hoje. No dia do
conserto, as asserções marcadas `DEFECT` invertem, e é o vermelho delas que prova que o conserto
tocou a porta medida e não outra.
