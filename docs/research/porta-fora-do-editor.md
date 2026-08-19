# Porta fora do editor

Medição feita em 2026-08-19 sobre `packages/engine/src/runtime-api/extensionOperations.ts` e o
Bridge deste checkout. Esta rodada não constrói uma porta nem move lógica.

## Resultado em números

- **82 operações** na camada: **27 queries** e **55 commands**.
- **78** têm semântica que um segundo app deveria poder chamar.
- **4** são legitimamente específicas da Interface/editor no desenho atual.
- O Bridge registra **111 ferramentas MCP**, mas nenhuma delas importa ou despacha
  `ExtensionQueryV1`/`ExtensionCommandV1`.

Há uma correção importante na premissa inicial: a camada não é importada somente por
`internalSeams.ts` e `WorkspaceExtensionTarget.ts`. A busca de importações encontrou cinco
consumidores no `apps/vscode-extension` (`extension.ts`, `internalSeams.ts`,
`ClientWorkspaceStudioTarget.ts`, `WorkspaceClient.ts` e `WorkspaceExtensionTarget.ts`) e cinco
consumidores internos do engine (serviço, protocolo, servidor de controle, broker de UI e host do
daemon). Nenhum consumidor foi encontrado em `packages/bridge`.

## Operações que um segundo app precisaria chamar (78)

Estas são operações de estado, consulta, coordenação ou manutenção do Tachyon; nada nelas exige
um editor VS Code para produzir o efeito. O caminho proposto para elas é uma operação própria no
Bridge, com schema e política de caller explícitos (não um `extension.invoke` genérico).

### Queries (27)

- `agents.list` — lê o roster e o estado das entradas gerenciadas.
- `attention.list` — expõe estado de atenção e ocupação monitorados dos agentes.
- `pins.list` — lê o checklist compartilhado do projeto.
- `schedules.list` — lê os agendamentos ativos.
- `proposals.list` — lê propostas de agendamento pendentes.
- `doctor.report` — produz diagnóstico do workspace e dos serviços locais.
- `bridge.token` — fornece o credential/token necessário para um cliente externo autenticado.
- `companion.pair-code` — inicia o pareamento de um cliente Companion.
- `companion.status` — consulta pareamento, dispositivos e gates do Companion.
- `agent.inspect` — consulta a definição e o estado operacional de um agente.
- `agent.session-inspection` — consulta o runtime efetivamente entregue a um agente.
- `agent.fork-preview` — calcula o plano de fork antes de criar a nova sessão.
- `prompt.catalog` — lê templates versionados e seus hashes para injeção segura.
- `worktree.review` — calcula a revisão de um worktree por agente, run ou id registrado.
- `worktrees.list` — lista worktrees do ledger e do registro gerenciado.
- `worktrees.classified` — lista worktrees com classificação de higiene fail-closed.
- `pipeline.inspect` — inspeciona definição ou execução de pipeline.
- `agent.wait` — espera uma transição observável de um agente.
- `agent-profile.studio-inspect` — lê o perfil persistido de um agente.
- `agent-profile.studio-bundle-export` — exporta um bundle portátil de perfil com revisão e hash.
- `agent-profile.studio-ownership` — lê a propriedade declarada de um perfil.
- `agent-profile.forget-plan` — calcula o plano e os pré-requisitos de remoção de um perfil.
- `agent-profile.authorizable-capabilities` — lista capacidades que podem ser autorizadas para um agente.
- `secrets.inventory` — lista os identificadores/provedores presentes no cofre da máquina.
- `tmux.snapshot` — consulta as sessões e panes Tachyon existentes.
- `tmux.health` — diagnostica o servidor tmux e seus processos.
- `tmux.capture` — lê uma captura limitada de uma pane Tachyon.

### Commands (51)

- `agent.spawn` — cria uma entrada/processo gerenciado e, quando pedido, seu worktree.
- `pin.create` — cria um item do checklist compartilhado.
- `proposal.create` — registra uma proposta de agendamento.
- `proposal.approve` — aprova uma proposta de agendamento.
- `proposal.reject` — rejeita uma proposta de agendamento.
- `approval.resolve` — resolve uma aprovação pendente e entrega o resultado ao requester.
- `config.agent.clone` — clona uma definição de agente/perfil.
- `config.notifications.idleAfterMinutes` — grava a janela de notificação de ociosidade.
- `config.agent.rename` — renomeia uma entrada persistida.
- `config.agent.delete` — remove definição e, conforme a confirmação, worktree do agente.
- `config.agent.promote` — promove uma entrada para uma declaração persistida.
- `config.companion.tabTools` — grava o gate de ferramentas de abas do Companion.
- `config.companion.allowedHosts` — grava a allowlist de hosts do Companion.
- `config.ideBrowser.enabled` — grava o gate do navegador integrado.
- `agent.fork` — cria um fork de agente a partir do plano calculado.
- `agent.continue-task` — inicia a continuação de uma tarefa em outra sessão/runtime.
- `worktree.remove` — remove o worktree associado a um agente.
- `worktree.delete-branch` — remove uma branch explicitamente selecionada.
- `worktree.forget-record` — esquece um registro de worktree pelo id.
- `worktree.remove-managed` — remove um worktree gerenciado após revalidar higiene e ownership.
- `worktree.release-lock` — libera o quarantine/lock de um worktree sem apagá-lo.
- `agent.resume-all` — retoma as sessões oferecidas pelo workspace.
- `workspace.stop-all` — interrompe todas as entradas em execução.
- `pipeline.start` — inicia uma execução de pipeline.
- `pipeline.approve` — aprova um node de pipeline.
- `pipeline.reject` — rejeita um node de pipeline.
- `pipeline.cancel` — cancela uma execução de pipeline.
- `pipeline.rerun` — reexecuta um pipeline a partir de um node.
- `pipeline.dismiss` — descarta a projeção de uma execução.
- `pipeline.apply-input` — aplica o input persistido a uma execução ainda iniciável.
- `pipeline.delete` — remove a definição de pipeline.
- `bridge.restart` — reinicia o servidor Bridge do workspace.
- `bridge.stop` — para o servidor Bridge do workspace.
- `bridge.refresh-tools` — força a redescoberta do catálogo MCP após mudança de ferramentas.
- `config.health` — lê a saúde/configuração efetiva para diagnóstico externo.
- `companion.unpair` — revoga uma sessão/dispositivo Companion.
- `handoff.note` — registra uma nota durável de handoff do projeto.
- `prompt.inject` — injeta um template verificado em uma sessão de agente.
- `runtime-ops.provider.configure` — grava consentimento/estado de observabilidade de provider.
- `runtime-config.mark-pending` — marca configuração de runtime pendente para os agentes afetados.
- `tmux.kill` — mata uma pane/sessão depois de validar sua identidade.
- `tmux.recover` — recupera o servidor tmux conforme a autoridade local.
- `agent-profile.studio-commit` — persiste uma mutação de perfil.
- `agent-profile.studio-lifecycle` — aplica uma mutação de lifecycle do perfil.
- `agent-profile.studio-bundle-clone` — clona um bundle de perfil validando revisão.
- `agent-profile.studio-bundle-import` — importa um bundle de perfil staged.
- `agent-profile.saved-agent-create` — cria um Saved Agent e registra seu owner na mesma transação.
- `agent-profile.saved-agent-create-v2` — cria um Saved Agent com o grant estreito da versão 2.
- `agent-profile.authorize-skill` — autoriza uma skill para um perfil.
- `agent-profile.authorize-plugin` — autoriza um plugin para um perfil.
- `secret.set` — grava uma credencial no cofre da máquina.

## Operações legitimamente do editor (4)

Estas quatro têm efeito de Interface/host que não é uma capacidade de domínio necessária a um
segundo app. Elas devem continuar tendo a porta VS Code; se o produto futuramente oferecer uma
Interface diferente, ela pode criar sua própria adaptação, sem chamar a camada de operações do
editor.

- `worktree.land` — a própria fonte o declara “Interface-only by construction”: é o land governado
  iniciado pelo usuário na Worktrees tab, e a política atual exclui o Bridge para impedir um caller
  de agente de avançar o trunk.
- `notice.deliver` — é um wake host-only via `Workspace.deliverNotice`; expô-lo a um agente/cliente
  externo permitiria tocar a pane de qualquer pessoa.
- `terminal.open` — abre/revela uma apresentação de terminal do VS Code para uma sessão tmux.
- `terminal.close` — fecha a apresentação de terminal do VS Code; o efeito visual não é domínio do
  engine.

Os exemplos de abrir diff ou focar uma aba não aparecem nesta camada: são operações nativas da
apresentação VS Code em outros módulos, portanto não foram artificialmente incluídos na contagem.

## Bridge contra CLI

**Veredito: Bridge primeiro; não criar CLI nesta rodada.** A medição pesa a favor do Bridge: ele já
é um servidor MCP engine-owned em `/mcp`, autentica Bearer por token de agente ou `externalToken`,
é injetado nos agentes, e já registra 111 ferramentas; um CLI novo acrescentaria um segundo
transporte e uma segunda superfície de autenticação para o mesmo workspace.

O que falta no Bridge não é transporte: falta exposição explícita das operações reutilizáveis. O
Bridge deve ganhar ferramentas MCP por capacidade, cada uma chamando a autoridade do engine com o
schema correspondente, caller/actor policy correspondente e envelope de resultado correspondente.
As quatro operações editor-only ficam fora do catálogo. Não recomendo expor um `extension.invoke`
genérico: ele reintroduziria o nome do consumidor, misturaria operações de Interface com operações
de domínio e tornaria a política de autorização indistinta.

O Bridge já tem equivalentes de domínio para parte da superfície (por exemplo `list_agents`,
`create_pin`, `list_schedules`, `remove_worktree` e `spawn_agent`). Isso confirma que o caminho
MCP é viável, mas também mostra que a proposta deve primeiro mapear/reusar esses contratos em vez
de duplicá-los com outro nome. Para as operações ainda sem equivalente — o caso imediato é
`secret.set`/`secrets.inventory` — a lacuna é uma ferramenta MCP explícita, não uma CLI.

## Nome proposto para a camada

`workspaceOperations`, com os tipos `WorkspaceQueryV1` e `WorkspaceCommandV1`.

O nome descreve a autoridade/escopo do que a camada faz e não o cliente que hoje a consome. Ele
também deixa espaço para VS Code, Bridge e um futuro segundo app serem adaptadores; a separação
entre operação reutilizável e operação de Interface deve ficar na política/registro, não no nome
`extension`.

## O que não deu para medir

- Não há um segundo app real neste checkout para medir latência, ergonomia ou fluxo de autenticação
  ponta a ponta.
- A busca estática mede registros e importações, não chamadas em runtime; não medi frequência de
  uso nem quais operações são efetivamente exercitadas em produção.
- Não medi equivalência semântica completa entre cada ação e as ferramentas Bridge já existentes;
  os exemplos acima são correspondências evidentes no código, não uma prova de identidade de
  contrato.
- Não medi a política de autorização que o dono quer para cada operação quando chamada por um
  cliente externo (humano, agente ou outro serviço); isso é decisão de desenho posterior.
- Não há CLI em `packages/`, mas também não medi um protótipo de custo de manutenção de CLI — o
  veredito CLI/Bridge usa o transporte autenticado já existente e o risco medido de duplicar
  superfícies, não uma preferência estética.

## Evidência consultada

- `packages/engine/src/runtime-api/extensionOperations.ts:31-80`: os 27 query actions e 55 command
  actions declarados.
- `packages/engine/src/engine-service/extensionOperationService.ts:67-650`: dispatch e efeitos
  das operações, incluindo as marcações explícitas de Interface-only e host-only.
- `packages/bridge/src/Bridge.ts:87-145,286-356,463-472`: servidor MCP engine-owned, autenticação
  Bearer/`externalToken` e registro de ferramentas por sessão.
- `packages/bridge/src/tools.ts:1-66` e `packages/bridge/src/tools/**/*.ts`: 111 chamadas
  `registerTool`, sem import de `runtime-api/extensionOperations`.
- `apps/vscode-extension/src/shell/WorkspaceExtensionTarget.ts:1-31`: o adaptador que hoje expõe
  query/invoke da camada ao shell VS Code.
