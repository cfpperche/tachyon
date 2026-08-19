# Classificação da maquinaria de hash

Etapa 2 de `t-7c8898`. A unidade de contagem é o sítio numerado no inventário
`docs/research/maquinaria-de-hash-inventario.md`; não é uma nova varredura. Cada
sítio aparece uma vez abaixo. `INDISPENSÁVEL` quer dizer identidade, endereço,
CAS/correção ou prova necessária para a operação que o próprio produto oferece.
`SEGURANÇA-NÃO-PEDIDA` quer dizer que o hash só fecha a porta contra bytes ou
atores não autorizados; não foi medido um atacante e o dono disse para não
inventar essa regra. `PEDIDO-EXPLÍCITO` é a exceção da atestação: o dono pediu
que a palavra do agente não fosse aceita como prova.

Os números `I01`–`I117` são os números mecânicos do inventário. Em cada lista,
`calculado → comparação/uso` conserva o ponto de cálculo e o ponto em que a
decisão acontece.

## 1. Bytes de bundle do engine — 3 sítios

Sítios: `I01` `packages/engine/src/engine-service/engineBundleStore.ts:506-521` → `:327,403,465`; `I03` `packages/engine/src/engine-service/stagedPayloadStore.ts:41` → `:85-87`; `I71` `packages/engine/src/engine-service/protocol.ts:1762` → `engineBundleStore.ts:289,327,366,403,451,465`.

1. **Hash e objeto.** SHA-256 dos bytes do bundle e do payload staged; o
   manifesto fornece os valores esperados.
2. **Falha.** Recusa (`SOURCE_HASH_MISMATCH`, `STAGED_HASH_MISMATCH`,
   `RUNTIME_HASH_MISMATCH`, `PAYLOAD_HASH` ou divergência de arquivo).
3. **Contra quem.** Contra bytes errados, corrompidos ou substituídos no
   armazenamento/provisionamento; não há ator adversário medido.
4. **Se sair.** O engine ainda pode ser iniciado, mas uma versão quebrada ou
   diferente pode ser executada. Isso é uma barreira de integridade, não o
   endereço/identidade que escolhe o engine.
5. **Custo.** Nenhum custo registrado.
6. **Veredito.** `SEGURANÇA-NÃO-PEDIDA`: sem um atacante medido, só sobra o
   cadeado contra bytes que poderiam ser aceitos.

## 2. Identidade do manifesto do engine — 1 sítio

Sítio: `I02` `packages/engine/src/engine-service/engineBundleStore.ts:506-521` → `:289,451`.

1. **Hash e objeto.** Hash do manifesto/identidade declarada do bundle.
2. **Falha.** Recusa (`STAGED_MANIFEST_MISMATCH` ou
   `RUNTIME_MANIFEST_MISMATCH`).
3. **Contra quem.** Contra a seleção de um manifesto diferente do bundle que
   o supervisor precisa adotar; não depende de um atacante.
4. **Se sair.** A identidade da encarnação do engine fica ambígua e staging,
   runtime e supervisor podem falar de bundles diferentes.
5. **Custo.** Nenhum custo registrado.
6. **Veredito.** `INDISPENSÁVEL`: aqui o digest é identidade/correção do
   objeto operacional, não apenas um bloqueio de segurança.

## 3. Binários e dados provisionados — 11 sítios

Sítios: `I04`, `I05`, `I06`, `I07` `apps/vscode-extension/src/plugins/toolProvisioning.ts:203-204` → `:211-219,249-256,261-270,308-314`; `I08`, `I09`, `I10` `toolProvisioning.ts:324-337` → `:360-367,375-382,423-428`; `I11` `toolProvisioning.ts:203-204` → `:596-605`; `I12` `toolProvisioning.ts:203-204` → `:791-800`; `I13` `apps/vscode-extension/src/plugins/dataLauncher.ts:66-82` → `:125-127`; `I14` `apps/vscode-extension/src/plugins/toolLauncher.ts:106-122` → `:176-180`.

1. **Hash e objeto.** SHA-256 do arquivo baixado, fonte, destino, executável
   extraído, binário existente e bytes abertos pelo launcher.
2. **Falha.** Recusa (`SHA_MISMATCH`, `BIN_SHA_MISMATCH`, `INSTALL_COLLISION`,
   `REHASH_MISMATCH`, `HASH_NOT_ALLOWED`); em alguns casos remove o destino.
3. **Contra quem.** Contra download, instalação ou execução de bytes não
   aprovados; nenhum atacante foi medido.
4. **Se sair.** A ferramenta ainda pode executar, mas o produto deixa de saber
   se está executando o binário que o manifesto trouxe. A funcionalidade básica
   não depende do digest; depende dele a barreira de integridade.
5. **Custo.** Nenhum custo registrado.
6. **Veredito.** `SEGURANÇA-NÃO-PEDIDA`.

## 4. Árvore de payload e commit de plugin — 3 sítios

Sítios: `I15` `apps/vscode-extension/src/plugins/fetcher.ts:94-107` → `:246-250`; `I16` `apps/vscode-extension/src/plugins/engine.ts:246-295` → `:1578-1581`; `I102` `fetcher.ts:274-277` → `:276-277`.

1. **Hash e objeto.** SHA-256 da árvore baixada e SHA do commit Git resolvido.
2. **Falha.** Cache é removido e refetch é tentado; persistência recusa a
   instalação/fetch.
3. **Contra quem.** Contra uma árvore/commit diferente do conteúdo consentido;
   nenhum ator externo foi medido.
4. **Se sair.** O plugin ainda poderia ser instalado, porém o consentimento
   poderia cobrir bytes diferentes. O fetch não perde sua mecânica, perde a
   garantia de conteúdo aprovado.
5. **Custo.** Nenhum custo registrado.
6. **Veredito.** `SEGURANÇA-NÃO-PEDIDA`.

## 5. Fingerprint do plano de instalação/remoção — 2 sítios

Sítios: `I99` `apps/vscode-extension/src/plugins/engine.ts:914` → `:1470-1472,2653-2655`; `I100` `engine.ts:1960` → `:2065-2066`.

1. **Hash e objeto.** Fingerprint do plano completo de instalação ou remoção,
   incluindo payload e alvos.
2. **Falha.** Recusa a aplicação e pede novo consentimento humano.
3. **Contra quem.** Contra o agente/processo que tenta aplicar um plano diferente
   daquele que foi mostrado; nenhum atacante foi medido.
4. **Se sair.** A instalação/remoção continua funcionando, mas deixa de haver
   vínculo entre a aprovação e o plano efetivamente aplicado.
5. **Custo.** Nenhum custo registrado.
6. **Veredito.** `SEGURANÇA-NÃO-PEDIDA`: é o cadeado de aprovação de conteúdo.

## 6. Integridade do registro e manifesto de git hooks — 2 sítios

Sítios: `I17` `apps/vscode-extension/src/plugins/gitHookRegistry.ts:154` → script gerado `:186-193`; `I18` `gitHookRegistry.ts:258` → `:320`.

1. **Hash e objeto.** `I17` sela as linhas do manifesto de execução; `I18`
   sela `{generation, events}` do snapshot JSON.
2. **Falha.** Dispatcher falha fechado com `integrity mismatch`; snapshot
   corrompido lança erro. A comparação de `I18` existe em `readSnapshot():320`.
3. **Contra quem.** Contra edição/substituição do estado ou do manifesto de
   hooks; nenhum ator adversário foi medido.
4. **Se sair.** Hooks ainda podem rodar, mas um dispatcher/registro alterado
   seria aceito.
5. **Custo.** Nenhum custo registrado.
6. **Veredito.** `SEGURANÇA-NÃO-PEDIDA`. O inventário marcou `I18` como
   DUVIDOSO, mas o próprio arquivo compara o digest; a resolução correta é
   `validacao de verdade`.

## 7. Identidades content-addressed de hooks e sessões — 3 sítios

Sítios: `I19` `gitHookRegistry.ts:284-286` → nome `leaves/<hash>`; `I23` `apps/vscode-extension/src/plugins/toolLauncher.ts:269` → `externalTools/registry.ts`; `I117` `apps/vscode-extension/src/plugins/engine.ts:522` → leaf referenciada.

1. **Hash e objeto.** `I19`/`I117` são SHA-256 do conteúdo de leaf, usado como
   nome e deduplicação; `I23` é um ID curto derivado de agente/plugin/ferramenta.
2. **Falha.** Não há recusa por comparação do digest; a operação usa o caminho
   ou ID produzido.
3. **Contra quem.** Não protege contra ator; identifica bytes/sessão para o
   próprio produto.
4. **Se sair.** Perde-se o endereço estável, a deduplicação ou a correlação de
   sessão; não se remove uma barreira de autorização.
5. **Custo.** Nenhum custo registrado.
6. **Veredito.** `INDISPENSÁVEL`. `I19`, `I23` e `I117` resolvem DUVIDOSO como
   `identidade/cache`, não como validação de segurança.

## 8. Hashes dos shims e validadores materializados — 3 sítios

Sítios: `I20` `apps/vscode-extension/src/plugins/externalTool.ts:281` → `toolProvisionRun.ts:203-209`; `I21` `dataLauncher.ts:176-177` → `toolProvisionRun.ts:462,556-557`; `I22` `toolLauncher.ts:371-372` → `toolProvisionRun.ts:155,203-219,255,345`.

1. **Hash e objeto.** SHA-256 do shell shim e do bundle validator copiados para
   `_tachyon-external`, `_tachyon-data` e `_tachyon-tool`.
2. **Falha.** O lockfile deixa de ser reutilizável e o materializer é executado
   novamente; divergência do validator é recusada.
3. **Contra quem.** Contra drift acidental do materializado; não há ator
   adversário medido.
4. **Se sair.** A ferramenta ainda pode ser materializada, mas o produto perde
   a correção do reuso e pode lançar um shim/validator diferente do lockfile.
5. **Custo.** Nenhum custo registrado.
6. **Veredito.** `INDISPENSÁVEL` por correção de cache/lockfile, não por
   segurança. Os três DUVIDOSO são `validacao de verdade` em outro módulo.

## 9. Fingerprints de hook anterior e template — 2 sítios

Sítios: `I103` `apps/vscode-extension/src/plugins/gitHookState.ts:56` → fingerprint do plano em `engine.ts:870`; `I116` `gitHookRegistry.ts:232-234` → teste/fingerprint do template.

1. **Hash e objeto.** `I103` é o conteúdo do hook anterior, incorporado ao
   plano para que uma mudança peça novo consentimento; `I116` é o conteúdo dos
   dispatchers, sem a linha de versão, usado para detectar mudança sem bump.
2. **Falha.** Plano muda/requer novo consentimento; template sem bump falha a
   suíte. Não é uma recusa de runtime contra o agente.
3. **Contra quem.** Contra mudança acidental entre preview/apply e contra teste
   desatualizado; nenhum atacante medido.
4. **Se sair.** Pode-se aplicar sobre hook diferente ou alterar comportamento
   sem atualizar a versão/teste; a execução do hook em si continua possível.
5. **Custo.** Nenhum custo registrado.
6. **Veredito.** `INDISPENSÁVEL` para correção do fluxo. Ambos os DUVIDOSO são
   `validacao de verdade`.

## 10. Política de host, aprovação e identidade do caller — 8 sítios

Sítios: `I24` `packages/engine/src/host-action/externalPolicy.ts:21,25,41-43` → `:21,25,42`; `I25` `host-action/capability.ts:43-45,67,74-75` → `broker.ts:71,97,185-188`; `I26` `approvals/approvalRequest.ts:214` → `:219`; `I27` `approvalRequest.ts:298` → `:449-454`; `I46` `agents/formation/humanLanes.ts:70-81` → `:81-86`; `I53` `packages/bridge/src/callerIdentity.ts:330-331` → `:332-335`; `I54` `packages/bridge/src/token.ts:49-50` → `:51-53`; `I115` `callerIdentity.ts:135-137` → `:176-178,233-240`.

1. **Hash e objeto.** Digests de política/descritor/argumentos/decisão e
   HMAC-SHA256 ou SHA-256 de tokens de caller.
2. **Falha.** Decisão, aprovação ou token é recusado; MAC inválido recusa a
   supressão humana; caller fora do escopo não passa.
3. **Contra quem.** Contra agente que se apresente como outro caller ou tente
   alterar uma autorização/decisão. O projeto tem apenas usuários próprios; não
   há atacante medido.
4. **Se sair.** A ação pode continuar no caminho nominal, mas o limite de
   autorização, escopo e aprovação desaparece. O que se perde é o cadeado, não
   a identidade operacional da ação.
5. **Custo.** Nenhum custo registrado.
6. **Veredito.** `SEGURANÇA-NÃO-PEDIDA`. Os tokens podem ser úteis à ponte, mas
   o hash/HMAC em si existe para rejeitar um caller não autorizado.

## 11. CAS de perfil, documentos e ciclo de vida — 15 sítios

Sítios: `I28` `agentProfileReader.ts:290` → `:369,442`; `I29` `agents/persistentInstructions.ts:40,55` → `:93-100`; `I30` `agentProfileTransactions.ts:272-276` → `:314-320`; `I31` `agentProfileOwnership.ts:21-22` → `:102-110`; `I32` `YamlConfigEditor.ts:505` → `:519-523`; `I33` `agentInstructionsWrite.ts:24,61-68` → `agentProfileLifecycle.ts:376-405`; `I34` `agentWorkspaceCommandWrite.ts:25,56-64` → `agentProfileLifecycle.ts:376-405`; `I35` `agentProfileLifecycle.ts:212,378` → `:404,444,487,499`; `I36` `agentProfileLifecycle.ts:212,228-232` → `:645,752-783,991-998`; `I37` `agentProfileForget.ts:124` → `:276,301`; `I38` `agentProfileRename.ts:98` → `:249,279`; `I39` `agentProfileBundle.ts:80` → schema/canonical parse `:101-133`; `I40` `configDiscards.ts:45` → `Workspace.ts:5116-5127`; `I41` `codexNativeConfigProjection.ts:70` → `:174,192`; `I67` `agentProfileBundle.ts:80` → schema `:41-46`.

1. **Hash e objeto.** SHA-256/CAS de perfil, instruções, setup, ownership,
   TOML, snapshots, artefatos e documentos do bundle; `I39/I67` também
   verificam documento contra o texto canônico.
2. **Falha.** Recusa a escrita/ativação, faz rollback ou descarta a operação
   divergente. No bundle, JSON não canônico ou `sha256` que não bate com o
   texto é recusado.
3. **Contra quem.** Contra Interface, Agent e Tachyon chegando por create,
   restart, resume, rename/forget ou recuperação e encontrando uma edição
   concorrente/stale; não requer atacante.
4. **Se sair.** Uma alteração pode sobrescrever outra, deixar ownership e
   autoridade desencontrados ou reativar bytes antigos. Quebra a correção do
   ciclo de perfil, não apenas um cadeado.
5. **Custo.** `t-204313`: `mode: pinned` em instruções acusou arquivo errado,
   bloqueou Agent Studio e deixou alerta após o conserto. É o único custo
   concreto registrado.
6. **Veredito.** `INDISPENSÁVEL` para correção/CAS. `I37`, `I38`, `I39` e
   `I67` eram DUVIDOSO e foram resolvidos como `validacao de verdade`.

## 12. Contratos e objetos da formação — 4 sítios

Sítios: `I43` `agentProfileProjection.ts:135-153,230-242` → `formation/humanLanes.ts:111-143`; `I44` `formation/domain.ts:26` → `humanLanes.ts:55`; `I45` `formation/objectStore.ts:17,58,71` → `:132` e `authorityStore.ts:1040`; `I75` `formation/humanLanes.ts:17-20,55,90,94` → `:90,94`.

1. **Hash e objeto.** Digest de contrato renderer/inspector, domínio canônico,
   objetos da formação e vetor/receipt de lanes.
2. **Falha.** Formação inválida, colisão ou receipt inválido é recusado.
3. **Contra quem.** Contra estado de formação desatualizado entre Interface,
   Agent e Tachyon; não há atacante medido.
4. **Se sair.** A formação pode ser aplicada ao domínio errado ou o receipt
   pode ser associado à geração errada; quebra a correção da formação.
5. **Custo.** Nenhum custo registrado.
6. **Veredito.** `INDISPENSÁVEL`.

## 13. CAS de estado persistente — 7 sítios

Sítios: `I47` `activity/logStore.ts:75` → `:99-143`; `I48` `resume/SessionLedger.ts:88` → `:95-101`; `I49` `tasks/TaskDetailStore.ts:47` → `tasks/studioModel.ts:35`; `I50` `TaskPrototypeStore.ts:85` → `:229`; `I51` `extensionOperationService.ts:205,318` → `:319`; `I52` `stateMigration.ts:252` → `:199`; `I77` `handoff/ProjectHandoffStore.ts:96` → `:295-298`.

1. **Hash e objeto.** CAS/fingerprint do log transacional, ledger de sessão,
   sidecar de tarefa, HTML de protótipo, template, migração e handoff.
2. **Falha.** Transação, remoção, carregamento, migração ou handoff é recusado,
   recarregado ou descartado.
3. **Contra quem.** Contra Interface, Agent e Tachyon concorrendo ou retomando
   estado após crash; não contra um atacante.
4. **Se sair.** O estado errado pode ser removido, migrado ou reapresentado como
   atual; quebra a correção e a recuperação.
5. **Custo.** Nenhum custo registrado.
6. **Veredito.** `INDISPENSÁVEL`.

## 14. Atestação da árvore verificada — 3 sítios

Sítios: `I55` `scripts/verify-record.mjs:61` → `packages/shared/verify-record-validity.cjs:23-24`; `I56` `verify-record.mjs:84-85` → `:176-189,266-272`; `I57` `dependency-lockfile-validity.cjs:19-29` → `verify-record.mjs:138-142`.

1. **Hash e objeto.** Fingerprint do verificador/comando, `HEAD^{tree}` e
   conjunto/bytes dos lockfiles que formam a prova.
2. **Falha.** A atestação não é criada ou não é reutilizada; o gate precisa
   rodar de novo.
3. **Contra quem.** Contra o auto-relato de um agente: o coordenador não aceita
   “passei” sem uma prova vinculada à árvore exata. Esse ator/trigger foi
   explicitamente nomeado pelo dono.
4. **Se sair.** Não quebra o código do produto, mas quebra a única prova de que
   a árvore entregue foi verificada; a decisão de entrega volta a depender de
   palavra.
5. **Custo.** Nenhum custo negativo; o mecanismo existe para pagar a prova que
   o dono pediu.
6. **Veredito.** `PEDIDO-EXPLÍCITO`, não `SEGURANÇA-NÃO-PEDIDA`.

## 15. Correção de empacotamento e proveniência — 4 sítios

Sítios: `I58` `scripts/ship-boundary.mjs:55` → `:56`; `I59` `scripts/vsix-artifact.mjs:29-30` → `:67`; `I60` `vsix-artifact.mjs:29-30` → `:82-83`; `I63` `record-provenance.mjs:29-30,71,173` → `vsix-artifact.mjs:67,82-83`.

1. **Hash e objeto.** Bytes do engine, `dist`, manifesto e bundle/VSIX que o
   processo de release pretende entregar.
2. **Falha.** O boundary/artifact reporta aviso ou problema de empacotamento;
   não é uma recusa de agente em runtime.
3. **Contra quem.** Contra o próprio processo de build que poderia publicar um
   pacote diferente do que foi produzido; nenhum atacante medido.
4. **Se sair.** O VSIX ainda pode ser montado, mas deixa de haver correção
   verificável entre fonte, bundle, `dist` e artefato.
5. **Custo.** Nenhum custo registrado.
6. **Veredito.** `INDISPENSÁVEL` para correção do artefato de release, não como
   segurança de usuário.

## 16. Fixtures de observabilidade/proveniência instalados — 2 sítios

Sítios: `I61` `scripts/runtime-observability-reference.mjs:142` → `:143`; `I62` `apps/vscode-extension/src/extension.ts:171-176` → `apps/vscode-extension/src/provenance/verify.ts:52-70`.

1. **Hash e objeto.** Fixture e arquivos `dist` instalados.
2. **Falha.** Fixture recusa com `fixture hash mismatch`; `dist` gera aviso
   `dist-mismatch`.
3. **Contra quem.** Contra a medição/proveniência executada sobre arquivo que
   não é o fixture ou build esperado; não há atacante medido.
4. **Se sair.** Dogfood/proveniência podem relatar uma execução diferente sem
   sinal; o produto principal continua iniciável.
5. **Custo.** Nenhum custo registrado.
6. **Veredito.** `INDISPENSÁVEL` para correção da medição. `I61/I62` eram
   `DUVIDOSO`? Não: a tabela já registrava comparação; a família apenas os
   separa pela consequência diferente de `I58-I60/I63`.

## 17. Capability e skill autorizados — 4 sítios

Sítios: `I64` `agentCapabilitySource.ts:203-215` → `:272-275`; `I65` `agentSkillAuthorizationService.ts:107-112` → `agentSkillAuthorization.ts:228-249`; `I66` `AgentManager.ts:1200-1204` → snapshot carregado na delegação; `I104` `agentProfileResolver.ts:343` → `:520-527,886-889`.

1. **Hash e objeto.** Árvore/arquivo de capability, árvore de skill autorizada
   e snapshot de skills delegadas.
2. **Falha.** Estado fica `digest-changed`/stale, capability é withheld ou
   projeção é recusada/diagnosticada.
3. **Contra quem.** Contra conteúdo não aprovado chegando ao agente; o único
   ator efetivo hoje é um agente nosso sob ordem do dono. Não há atacante
   externo medido.
4. **Se sair.** A skill pode continuar executando, porém a autorização humana
   deixa de estar ligada aos bytes entregues; identidade da capability se perde.
5. **Custo.** Nenhum custo registrado.
6. **Veredito.** `SEGURANÇA-NÃO-PEDIDA`. `I66` é o DUVIDOSO resolvido como
   `identidade` do snapshot, mas sua presença no gate serve à mesma proteção.

## 18. Base de propostas de Saved Agent — 4 sítios

Sítios: `I42` `agentProfileGrants.ts:62-64` → `bridge/tools/fleet.ts:767,915`; `I105` `savedAgentProposal.ts:269-272` → `savedAgentProposalStore.ts:152-160`; `I106` `savedAgentRemovalProposal.ts:89-92` → `savedAgentRemovalProposalStore.ts:119-127`; `I107` `agentProfileGrants.ts:62-64` → `savedAgentProposal.ts:396-404` e `savedAgentRemovalProposal.ts:171-178`.

1. **Hash e objeto.** SHA-256 da configuração/roster base e do payload de
   criação/remoção que o humano verá.
2. **Falha.** Proposta é marcada tampered, inválida ou precisa de novo digest;
   não é aplicada.
3. **Contra quem.** Contra um agente que altere a proposta ou a configuração
   entre a apresentação e a aprovação. É o agente nosso sob ordem do dono;
   nenhum atacante externo foi medido.
4. **Se sair.** O Saved Agent ainda pode ser criado/removido, mas a aprovação
   pode operar sobre outro roster.
5. **Custo.** Nenhum custo registrado.
6. **Veredito.** `SEGURANÇA-NÃO-PEDIDA`. `I42` é `validacao de verdade` (base
   é comparada), não um hash sem uso.

## 19. Sintaxe de digest em referências, manifestos e lockfiles — 3 sítios

Sítios: `I108` `agentProfileSchema.ts:71-75` → superRefine/schema; `I109` `plugins/manifest.ts:384-390,460` → `validSha256`; `I110` `plugins/lockfile.ts:19,210-239,310-311` → validação do lockfile e uso em `toolProvisionRun`.

1. **Hash e objeto.** Digest declarado em referência pinned, artefato de plugin
   e lockfile; o ponto local valida formato, e o consumidor compara bytes.
2. **Falha.** Schema/manifesto/lockfile é recusado; nos consumidores, digest
   divergente impede reuso ou instalação.
3. **Contra quem.** Contra conteúdo declarado como aprovado que não corresponde
   ao conteúdo efetivo; nenhum atacante medido.
4. **Se sair.** A configuração continua parseável, mas o downstream perde sua
   referência correta e pode instalar/usar bytes diferentes.
5. **Custo.** Nenhum custo registrado.
6. **Veredito.** `SEGURANÇA-NÃO-PEDIDA`. Os três DUVIDOSO são `validacao de
   verdade` distribuída: a linha local só faz regex, mas a validação de bytes
   ocorre na porta seguinte.

## 20. Identidades de engine, workspace, shell e harness — 16 sítios

Sítios: `I68` `engine-service/commandIdentity.ts:6-9` → `controlServer.ts:296-301`; `I69` `controlServer.ts:498-506` → `:197-204`; `I70` `apps/vscode-extension/src/shell/WorkspaceClient.ts:665` → `controlServer.ts:498-506`; `I72` `engineSupervisor.ts:324` → `:1016,1191`; `I73` `tmux/TmuxService.ts:343` → `controlServer.ts:150,187`/`engineSupervisor.ts:1016`; `I74` `ide-browser-bridge/hostServer.ts:207` → nome de instância; `I76` `claudeStatusLineCapture.ts:109-117` → nome de relay; `I78` `runtimeOps/workspaceLabels.ts:76` → chave opaca; `I81` `worktree/managedWorktree.ts:93` → ID de worktree; `I82` `externalTools/registry.ts:14` → ID de sessão; `I83` `engineSupervisor.ts:800` → preflight attach; `I84` `scripts/vsix-smoke.mjs:364` → `engineWorkspaceKey`; `I85` `scripts/dev-host/stop-bridge.mjs:103` → `:225,243`; `I86` `scripts/dev-host/pointer.mjs:57` → diretório tmux; `I87` `headless-settings-recovery.js:58` → arquivo settings; `I114` `harness/HarnessManager.ts:2203-2217` → diretório de recursos Pi.

1. **Hash e objeto.** Digests curtos de caminho real, workspace, socket/tmux,
   settings, sessão, worktree e árvore de recursos; vários são `wsHash`,
   `isolatedEngineKey` ou IDs opacos.
2. **Falha.** Há recusa de attach/adoption/shell/workspace incorreto; nos
   demais, o digest apenas produz o nome/endereço isolado.
3. **Contra quem.** Não protege contra ator; separa instâncias, workspaces e
   encarnações para que Interface, Agent e Tachyon não cruzem seus endereços.
4. **Se sair.** Quebra identidade/roteamento: socket, cache, relay, harness ou
   worktree podem colidir ou ser associados ao workspace errado.
5. **Custo.** Nenhum custo registrado.
6. **Veredito.** `INDISPENSÁVEL`. `I70`, `I74`, `I76`, `I78`, `I81`–`I87` e
   `I114` eram DUVIDOSO e foram resolvidos como `identidade/cache`.

## 21. Blobs content-addressed — 2 sítios

Sítios: `I79` `richDoc/AttachmentStore.ts:176` → `blobRef`/arquivo; `I80` `activity/logStore.ts:305` → `blobRef`/arquivo.

1. **Hash e objeto.** SHA-256 dos bytes de anexo e blob de atividade, usado como
   nome, referência e deduplicação.
2. **Falha.** Não existe comparação de autenticidade; o mesmo conteúdo apenas
   deixa de compartilhar o mesmo arquivo se o endereço for removido.
3. **Contra quem.** Contra nenhum ator; é endereçamento/caching local.
4. **Se sair.** Leitura por `blobRef` e deduplicação quebram ou exigem outro
   endereço; não afrouxa autorização.
5. **Custo.** Nenhum custo registrado.
6. **Veredito.** `INDISPENSÁVEL`. `I79/I80` eram DUVIDOSO, resolvidos como
   `cache/identidade`, e explicitamente não são validação de segurança.

## 22. Hashes de fixtures e perfis nos dogfoods — 11 sítios

Sítios: `I88` `scripts/dogfood/pi-native-fork.mjs:97,108` → `:109`; `I89` `claude-bypass-optin.ts:44` → autoridade em `:69`; `I90` `native-config-sources.ts:43` → autoridade em `:60`; `I91` `codex-danger-optin.ts:43` → autoridade em `:71`; `I92` `claude-canonical-create.ts:57` → autoridade/memória do perfil; `I93` `runtime-remeasure.ts:99` → relatório de medição; `I94` `scripts/research/poc-tui-canal-codex.mjs:516` → relatório; `I95` `grok-attention-midturn.ts:52` → `:229`; `I96` `persistent-engine-runner.ts:531,601` → manifesto/auditoria; `I97` `runtimeConfig/claudeInventory.ts:37` → `:231-234`; `I98` `runtimeConfig/grokInventory.ts:122` → `:510-514,545-547`.

1. **Hash e objeto.** Sessão de fork, bytes de perfil/autoridade, arquivos de
   configuração medidos, autenticação e bundles de dogfood.
2. **Falha.** Dogfood recusa, não roda a asserção, ou registra mudança; nos
   inventários de runtime a gravação é recusada quando o digest muda.
3. **Contra quem.** Contra o próprio teste/medição continuar afirmando algo
   sobre bytes diferentes; não há ator adversário.
4. **Se sair.** O produto de produção não necessariamente para, mas o dogfood
   pode passar ou medir a coisa errada; perde-se correção do experimento.
5. **Custo.** Nenhum custo registrado.
6. **Veredito.** `INDISPENSÁVEL` para a correção dos testes e medições. `I89`–
   `I92` eram DUVIDOSO `validacao de verdade`; `I93/I94` são `sobra` de
   relatório (calculam e imprimem, sem gate); `I96` é validação do bundle mais
   observação de auditoria.

## 23. Fingerprint de prompt e handoff — 2 sítios

Sítios: `I111` `packages/engine/src/agents/promptLayers.ts:62,77-82` → manifesto do prompt; `I112` `sessionContinuation/focusedHandoff.ts:101` → packet retornado em `:117`.

1. **Hash e objeto.** SHA-256 do texto de instruções renderizado e do markdown
   do handoff focado.
2. **Falha.** Não há recusa nem comparação neste caminho; o digest é devolvido
   como metadado do manifesto/packet.
3. **Contra quem.** Contra nenhum ator; informa qual conteúdo foi renderizado
   para um leitor/consumidor posterior.
4. **Se sair.** O prompt e o handoff ainda são produzidos, mas deixam de ter
   identidade de bytes para diagnóstico/continuação.
5. **Custo.** Nenhum custo registrado.
6. **Veredito.** `INDISPENSÁVEL` como identidade observável, não como
   segurança. `I111/I112` eram DUVIDOSO resolvidos como `identidade`, não
   `validacao`.

## 24. Hash chain de auditoria sem verificação da cadeia — 1 sítio

Sítio: `I113` `packages/engine/src/host-action/audit.ts:79` → leitura em `:135-136`.

1. **Hash e objeto.** SHA-256 de cada evento com `previous_hash`; o sink grava
   a cadeia, mas no reload só verifica se o último campo tem formato de 64 hex.
2. **Falha.** Registro malformado é ignorado; uma cadeia adulterada porém com
   digest sintaticamente válido não é recusada neste ponto.
3. **Contra quem.** Pretende proteger contra edição de auditoria, mas não há
   ator medido e não há comparação criptográfica efetiva no leitor.
4. **Se sair.** A auditoria ainda registra eventos; perde-se apenas a aparência
   de encadeamento. A cadeia atual não é prova porque não é validada.
5. **Custo.** Nenhum custo registrado.
6. **Veredito.** `SEGURANÇA-NÃO-PEDIDA`; DUVIDOSO resolvido como `sobra`/hash
   calculado sem validação de verdade.

## 25. Hash da URL remota como diretório de cache — 1 sítio

Sítio: `I101` `apps/vscode-extension/src/plugins/fetcher.ts:72` → `:73`.

1. **Hash e objeto.** Prefixo SHA-256 truncado da URL remota, no caminho
   `<cacheRoot>/<remoteHash>/<commit>`.
2. **Falha.** Não há comparação nem recusa; apenas muda o diretório de cache.
3. **Contra quem.** Contra nenhum ator; é isolamento/endereçamento de cache.
4. **Se sair.** O cache ainda pode funcionar com a URL literal ou outro mapa,
   mas este endereço e sua separação desaparecem.
5. **Custo.** Nenhum custo registrado.
6. **Veredito.** `INDISPENSÁVEL` como `cache/identidade`, não como segurança.

## Conta fechada

| Família | Sítios | Veredito |
|---|---:|---|
| Bytes de bundle do engine | 3 | SEGURANÇA-NÃO-PEDIDA |
| Identidade do manifesto do engine | 1 | INDISPENSÁVEL |
| Binários e dados provisionados | 11 | SEGURANÇA-NÃO-PEDIDA |
| Árvore/commit de plugin | 3 | SEGURANÇA-NÃO-PEDIDA |
| Plano de instalação/remoção | 2 | SEGURANÇA-NÃO-PEDIDA |
| Manifesto/snapshot de git hooks | 2 | SEGURANÇA-NÃO-PEDIDA |
| Identidades content-addressed de hooks/sessões | 3 | INDISPENSÁVEL |
| Shims/validadores materializados | 3 | INDISPENSÁVEL |
| Hook anterior/template | 2 | INDISPENSÁVEL |
| Host-action/aprovação/caller | 8 | SEGURANÇA-NÃO-PEDIDA |
| CAS de perfil/documentos | 15 | INDISPENSÁVEL |
| Contratos/objetos da formação | 4 | INDISPENSÁVEL |
| CAS de estado persistente | 7 | INDISPENSÁVEL |
| Atestação da árvore verificada | 3 | PEDIDO-EXPLÍCITO |
| Empacotamento/proveniência | 4 | INDISPENSÁVEL |
| Fixtures/proveniência instalados | 2 | INDISPENSÁVEL |
| Capability/skill autorizados | 4 | SEGURANÇA-NÃO-PEDIDA |
| Base de propostas Saved Agent | 4 | SEGURANÇA-NÃO-PEDIDA |
| Sintaxe/digest de manifestos e lockfiles | 3 | SEGURANÇA-NÃO-PEDIDA |
| Identidade engine/workspace/shell/harness | 16 | INDISPENSÁVEL |
| Blobs content-addressed | 2 | INDISPENSÁVEL |
| Dogfoods | 11 | INDISPENSÁVEL |
| Prompt/handoff | 2 | INDISPENSÁVEL |
| Hash chain de auditoria | 1 | SEGURANÇA-NÃO-PEDIDA |
| URL remota/cache | 1 | INDISPENSÁVEL |
| **Total** | **117** | **14 indispensáveis, 10 de segurança não pedida, 1 pedido explícito** |

Ordenada pelo custo observado: a família de CAS de perfil/documentos vem
primeiro porque inclui o `t-204313`; as demais não têm custo concreto registrado
no cartão/journal. A tabela mantém cada família, inclusive as de um sítio, para
que nenhum outlier seja escondido.

## Os 41 DUVIDOSO resolvidos

| Papel resolvido | Sítios |
|---|---|
| `identidade` | `I23`, `I66`, `I74`, `I76`, `I78`, `I81`, `I82`, `I83`, `I84`, `I111`, `I112`, `I117` |
| `cache` | `I19`, `I79`, `I80`, `I101` |
| `identidade/cache` (um hash faz as duas coisas) | `I86`, `I87`, `I114` |
| `sobra` (calculado/impresso, sem comparação) | `I93`, `I94`, `I113` |
| `validacao de verdade` | `I18`, `I20`, `I21`, `I22`, `I37`, `I38`, `I39`, `I42`, `I70`, `I89`, `I90`, `I91`, `I92`, `I96`, `I103`, `I108`, `I109`, `I110`, `I116` |

Há duas observações de precisão. `I86`, `I87` e `I114` também poderiam ser
chamados apenas de identidade; foram marcados `identidade/cache` porque o
resultado é simultaneamente chave de diretório. `I18` não era realmente “sem
comparação”: `GitHookStore.readSnapshot` compara `snapshotIntegrity` em
`gitHookRegistry.ts:320`. Portanto a classificação corrige a marca mecânica
sem acrescentar um sítio novo.

## O que não deu para medir

- A etapa 1 não procurou no checkout primário/home do usuário, em
  `tachyon.yml`, `docs/project-guidance.md`, `tests`/fixtures fora dos caminhos
  listados, `dist`, `build`, `node_modules` ou conteúdo de `.git`; este
  documento preserva esse limite.
- Não foi executado um experimento removendo hashes. A coluna “se sair” é
  consequência do caminho de código observado, não uma promessa de que toda
  combinação de estados foi exercitada.
- Não foi medido um atacante externo, nem foi encontrado outro usuário do
  projeto. Quando a única defesa é contra bytes/atores não autorizados, o
  relatório registra isso como hipótese sem ator medido, conforme a regra do
  dono.
- O único custo concreto encontrado foi `t-204313` (perfil `mode: pinned` e
  alerta/porta de reparo errados). Não há medida monetária ou de tempo para os
  demais sítios.
- Alguns hashes são produzidos em scripts de dogfood e relatórios. Eles podem
  ser úteis para a evidência do teste, mas `I93`, `I94` e `I113` não demonstram
  que alguém os compareu; por isso não foram apresentados como atestação.
