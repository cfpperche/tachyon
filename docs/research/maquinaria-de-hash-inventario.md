# Inventário mecânico de maquinaria de hash

Etapa 1 de `t-7c8898`: a tabela abaixo registra sítios encontrados por varredura de padrões. Não há classificação de necessidade ou segurança nesta etapa.

| Hash calculado (arquivo:linha) | Comparação (arquivo:linha) | Sobre o que | Falha hoje | Marca |
|---|---|---|---|---|
| `packages/engine/src/engine-service/engineBundleStore.ts:506-521` (`sha256File`) | `packages/engine/src/engine-service/engineBundleStore.ts:327`, `403`, `465` | bytes de arquivos do bundle | recusa (`SOURCE_HASH_MISMATCH`, `STAGED_HASH_MISMATCH`, `RUNTIME_HASH_MISMATCH`) |  |
| `packages/engine/src/engine-service/engineBundleStore.ts:506-521` (`sha256File`) | `packages/engine/src/engine-service/engineBundleStore.ts:289`, `451` | manifesto e identidade do bundle | recusa (`STAGED_MANIFEST_MISMATCH`, `RUNTIME_MANIFEST_MISMATCH`) |  |
| `packages/engine/src/engine-service/stagedPayloadStore.ts:41` | `packages/engine/src/engine-service/stagedPayloadStore.ts:85-87` | payload binário encenado | recusa (`PAYLOAD_HASH`) |  |
| `apps/vscode-extension/src/plugins/toolProvisioning.ts:203-204` (`sha256File`) | `apps/vscode-extension/src/plugins/toolProvisioning.ts:211-219` | bytes do artefato baixado | recusa (`UNREADABLE` ou `SHA_MISMATCH`) |  |
| `apps/vscode-extension/src/plugins/toolProvisioning.ts:203-204` (`sha256File`) | `apps/vscode-extension/src/plugins/toolProvisioning.ts:249-256` | binário fonte para instalação | recusa (`BIN_SHA_MISMATCH`) |  |
| `apps/vscode-extension/src/plugins/toolProvisioning.ts:203-204` (`sha256File`) | `apps/vscode-extension/src/plugins/toolProvisioning.ts:261-270` | binário já instalado | recusa (`INSTALL_COLLISION`) ou reutilização |  |
| `apps/vscode-extension/src/plugins/toolProvisioning.ts:203-204` (`sha256File`) | `apps/vscode-extension/src/plugins/toolProvisioning.ts:308-314` | binário colocado no destino | recusa (`REHASH_MISMATCH`) e remoção |  |
| `apps/vscode-extension/src/plugins/toolProvisioning.ts:324-337` (`sha256FileStreaming`) | `apps/vscode-extension/src/plugins/toolProvisioning.ts:360-367` | bytes do dado fonte | recusa (`BIN_SHA_MISMATCH`) |  |
| `apps/vscode-extension/src/plugins/toolProvisioning.ts:324-337` (`sha256FileStreaming`) | `apps/vscode-extension/src/plugins/toolProvisioning.ts:375-382` | dado já instalado | recusa (`INSTALL_COLLISION`) |  |
| `apps/vscode-extension/src/plugins/toolProvisioning.ts:324-337` (`sha256FileStreaming`) | `apps/vscode-extension/src/plugins/toolProvisioning.ts:423-428` | dado colocado no destino | recusa (`REHASH_MISMATCH`) e remoção |  |
| `apps/vscode-extension/src/plugins/toolProvisioning.ts:203-204` (`sha256File`) | `apps/vscode-extension/src/plugins/toolProvisioning.ts:596-605` | executável extraído do arquivo | recusa (`BIN_SHA_MISMATCH`) e remoção |  |
| `apps/vscode-extension/src/plugins/toolProvisioning.ts:203-204` (`sha256File`) | `apps/vscode-extension/src/plugins/toolProvisioning.ts:791-800` | binário existente no host | recusa (`HASH_NOT_ALLOWED`) |  |
| `apps/vscode-extension/src/plugins/dataLauncher.ts:66-82` (`hashFd`) | `apps/vscode-extension/src/plugins/dataLauncher.ts:125-127` | bytes do dado provisionado | recusa (`HASH_MISMATCH`) |  |
| `apps/vscode-extension/src/plugins/toolLauncher.ts:106-122` (`hashFd`) | `apps/vscode-extension/src/plugins/toolLauncher.ts:176-180` | bytes do executável lançado | recusa (`HASH_MISMATCH`) |  |
| `apps/vscode-extension/src/plugins/fetcher.ts:94-107` (`hashTree`) | `apps/vscode-extension/src/plugins/fetcher.ts:246-250` | árvore de payload do plugin | remove cache e refaz fetch; falha depois se persistir |  |
| `apps/vscode-extension/src/plugins/engine.ts:246-295` (`preflightPayload`) | `apps/vscode-extension/src/plugins/engine.ts:1578-1581` | árvore de payload do plugin | recusa instalação e exige novo consentimento |  |
| `apps/vscode-extension/src/plugins/gitHookRegistry.ts:154` (`buildExecutionManifest`) | `apps/vscode-extension/src/plugins/gitHookRegistry.ts:186-193` (script gerado) | linhas do manifesto de execução | recusa (`integrity mismatch`) |  |
| `apps/vscode-extension/src/plugins/gitHookRegistry.ts:258` (`snapshotIntegrity`) | não comparado neste arquivo | geração e eventos do registro de hooks | nada | DUVIDOSO |
| `apps/vscode-extension/src/plugins/gitHookRegistry.ts:284-286` (`putLeaf`) | não comparado neste arquivo | conteúdo de leaf de hook | nada | DUVIDOSO |
| `apps/vscode-extension/src/plugins/externalTool.ts:281` | não comparado neste arquivo | shim e validador externo | nada | DUVIDOSO |
| `apps/vscode-extension/src/plugins/dataLauncher.ts:176-177` | não comparado neste arquivo | shim e validador de dados | nada | DUVIDOSO |
| `apps/vscode-extension/src/plugins/toolLauncher.ts:371-372` | não comparado neste arquivo | shim e validador de ferramenta | nada | DUVIDOSO |
| `apps/vscode-extension/src/plugins/toolLauncher.ts:269` | não comparado neste arquivo | identidade curta da sessão | nada | DUVIDOSO |
| `packages/engine/src/host-action/externalPolicy.ts:21`, `25`, `41-43` via `sha256` | `packages/engine/src/host-action/externalPolicy.ts:21`, `25`, `42` | política externa serializada | restaura ou recusa (`POLICY_HASH_MISMATCH`) |  |
| `packages/engine/src/host-action/capability.ts:43-45`, `67`, `74-75` | `packages/engine/src/host-action/broker.ts:71`, `97`, `185-188` | descritor e argumentos da ação | recusa decisão inválida |  |
| `packages/engine/src/approvals/approvalRequest.ts:214` | `packages/engine/src/approvals/approvalRequest.ts:219` | payload de pedido de aprovação | resultado falso/recusa do pedido |  |
| `packages/engine/src/approvals/approvalRequest.ts:298` | `packages/engine/src/approvals/approvalRequest.ts:449-454` | campos canônicos da decisão | recusa (registro corrupto) |  |
| `packages/engine/src/config/agentProfileReader.ts:290` | `packages/engine/src/config/agentProfileReader.ts:369`, `442` | bytes de perfil e referência | recusa por divergência de bytes |  |
| `packages/engine/src/agents/persistentInstructions.ts:40`, `55` | `packages/engine/src/agents/persistentInstructions.ts:93-100` | bytes de instruções persistentes | recusa (`instructions/cas`) |  |
| `packages/engine/src/config/agentProfileTransactions.ts:272-276` | `packages/engine/src/config/agentProfileTransactions.ts:314-320` | bytes do perfil canônico | recusa (`changed outside transaction`) |  |
| `packages/engine/src/config/agentProfileOwnership.ts:21-22` | `packages/engine/src/config/agentProfileOwnership.ts:102-110` | texto do perfil de ownership | recusa por CAS |  |
| `packages/engine/src/config/YamlConfigEditor.ts:505` | `packages/engine/src/config/YamlConfigEditor.ts:519-523` | valor textual da configuração | recusa (`value changed`) |  |
| `packages/engine/src/config/agentInstructionsWrite.ts:24`, `61-68` | `packages/engine/src/config/agentProfileLifecycle.ts:376-405` | arquivo de instruções gerado | recusa por digest divergente |  |
| `packages/engine/src/config/agentWorkspaceCommandWrite.ts:25`, `56-64` | `packages/engine/src/config/agentProfileLifecycle.ts:376-405` | arquivo de setup do worktree | recusa por digest divergente |  |
| `packages/engine/src/config/agentProfileLifecycle.ts:212`, `378` | `packages/engine/src/config/agentProfileLifecycle.ts:404`, `444`, `487`, `499` | artefatos e backups do ciclo de perfil | recusa/rollback por digest divergente |  |
| `packages/engine/src/config/agentProfileLifecycle.ts:212`, `228-232` | `packages/engine/src/config/agentProfileLifecycle.ts:645`, `752-783`, `991-998` | perfil e autoridade de formação | recusa/recuperação por divergência |  |
| `packages/engine/src/config/agentProfileForget.ts:124` | não comparado neste arquivo | payload de remoção de perfil | nada | DUVIDOSO |
| `packages/engine/src/config/agentProfileRename.ts:98` | não comparado neste arquivo | payload de renomeação de perfil | nada | DUVIDOSO |
| `packages/engine/src/config/agentProfileBundle.ts:80` | não comparado neste arquivo | bundle serializado de perfil | nada | DUVIDOSO |
| `packages/engine/src/config/configDiscards.ts:45` | `packages/engine/src/workspace/Workspace.ts:5116-5127` | linhas descartadas da configuração | descarta a dispensa divergente |  |
| `packages/engine/src/config/codexNativeConfigProjection.ts:70` | `packages/engine/src/config/codexNativeConfigProjection.ts:174`, `192` | texto TOML da configuração Codex | recusa se revisão mudou |  |
| `packages/engine/src/config/agentProfileGrants.ts:62-64` | `packages/bridge/src/tools/fleet.ts:767`, `915` (valor carregado como base) | bytes dos grants do perfil | recusa de proposta por base divergente | DUVIDOSO |
| `packages/engine/src/config/agentProfileProjection.ts:135-153`, `230-242` | `packages/engine/src/agents/formation/humanLanes.ts:111-143` | contratos de renderização/inspector | recusa (`renderer contract mismatch`) |  |
| `packages/engine/src/agents/formation/domain.ts:26` | `packages/engine/src/agents/formation/humanLanes.ts:55` | domínio canônico da formação | recusa (`invalid lanes`) |  |
| `packages/engine/src/agents/formation/objectStore.ts:17`, `58`, `71` | `packages/engine/src/agents/formation/objectStore.ts:132`, `packages/engine/src/agents/formation/authorityStore.ts:1040` | bytes dos objetos da formação | recusa por colisão ou digest divergente |  |
| `packages/engine/src/agents/formation/humanLanes.ts:70-81` (HMAC-SHA256) | `packages/engine/src/agents/formation/humanLanes.ts:81-86` | payload de supressão humana | recusa por MAC inválido |  |
| `packages/engine/src/activity/logStore.ts:75` | `packages/engine/src/activity/logStore.ts:99-143` | arquivos de log da transação | recusa da transação |  |
| `packages/engine/src/resume/SessionLedger.ts:88` | `packages/engine/src/resume/SessionLedger.ts:95-101` | registro de sessão serializado | recusa da remoção exata |  |
| `packages/engine/src/tasks/TaskDetailStore.ts:47` | `packages/engine/src/tasks/studioModel.ts:35` | corpo de detalhe da tarefa | recarrega ou não carrega sidecar |  |
| `packages/engine/src/tasks/TaskPrototypeStore.ts:85` | `packages/engine/src/tasks/TaskPrototypeStore.ts:229` | HTML do protótipo | recusa/descarta por hash divergente |  |
| `packages/engine/src/engine-service/extensionOperationService.ts:205`, `318` | `packages/engine/src/engine-service/extensionOperationService.ts:319` | corpo de template de operação | recusa (`expectedSha256`) |  |
| `packages/engine/src/engine-service/stateMigration.ts:252` | `packages/engine/src/engine-service/stateMigration.ts:199` | migração canônica de estado | recusa por fingerprint divergente |  |
| `packages/bridge/src/callerIdentity.ts:330-331` | `packages/bridge/src/callerIdentity.ts:332-335` | token de identidade do caller | recusa de identidade |  |
| `packages/bridge/src/token.ts:49-50` | `packages/bridge/src/token.ts:51-53` | token de autenticação | recusa de token |  |
| `scripts/verify-record.mjs:61` (`verifierFingerprint`) | `packages/shared/verify-record-validity.cjs:23-24` | ambiente e comando de verificação | reutilização recusada |  |
| `scripts/verify-record.mjs:84-85` (`git rev-parse HEAD^{tree}`) | `scripts/verify-record.mjs:176-189`, `266-272` | árvore Git verificada | não cria registro ou não reutiliza prova |  |
| `packages/shared/dependency-lockfile-validity.cjs:19-29` | `scripts/verify-record.mjs:138-142` | conjunto de lockfiles e bytes | registro não criado por divergência |  |
| `scripts/ship-boundary.mjs:55` | `scripts/ship-boundary.mjs:56` | bytes de arquivos do engine | aviso de violação de empacotamento |  |
| `scripts/vsix-artifact.mjs:29-30` (`sha256`) | `scripts/vsix-artifact.mjs:67` | bytes dos arquivos `dist` no VSIX | aviso/problemas do artefato |  |
| `scripts/vsix-artifact.mjs:29-30` (`sha256`) | `scripts/vsix-artifact.mjs:82-83` | bytes dos arquivos do manifesto engine | aviso/problemas do artefato |  |
| `scripts/runtime-observability-reference.mjs:142` | `scripts/runtime-observability-reference.mjs:143` | bytes de arquivo fixture | recusa (`fixture hash mismatch`) |  |
| `apps/vscode-extension/src/extension.ts:171-176` | `apps/vscode-extension/src/provenance/verify.ts:52-70` | bytes dos arquivos `dist` instalados | aviso (`dist-mismatch`) |  |
| `scripts/record-provenance.mjs:29-30`, `71`, `173` | `scripts/vsix-artifact.mjs:67`, `82-83` | bytes do bundle e do VSIX | aviso/problemas do artefato |  |
| `packages/engine/src/config/agentCapabilitySource.ts:203-215` | `packages/engine/src/config/agentCapabilitySource.ts:272-275` | arquivo ou árvore de capability | recusa (`profile/digest-mismatch`) |  |
| `packages/engine/src/config/agentSkillAuthorizationService.ts:107-112` | `packages/engine/src/config/agentSkillAuthorization.ts:228-249` | árvore do skill autorizado | estado `digest-changed` ou stale |  |
| `packages/engine/src/agents/AgentManager.ts:1200-1204` | não comparado neste arquivo | snapshot de skills delegadas | nada | DUVIDOSO |
| `packages/engine/src/config/agentProfileBundle.ts:80` | `packages/engine/src/config/agentProfileBundle.ts:42-46` | texto de documento do bundle | recusa de schema (`does not match text`) |  |
| `packages/engine/src/engine-service/commandIdentity.ts:6-9` | `packages/engine/src/engine-service/controlServer.ts:296-301` | comando canônico da operação | recusa (`OPERATION_ID_CONFLICT`) |  |
| `packages/engine/src/engine-service/controlServer.ts:498-506` | `packages/engine/src/engine-service/controlServer.ts:197-204` | identidade e capacidades do shell | recusa (`SHELL_ID_CONFLICT`) |  |
| `apps/vscode-extension/src/shell/WorkspaceClient.ts:665` | `packages/engine/src/engine-service/controlServer.ts:498-506` | configurações do shell | recusa quando fingerprint muda | DUVIDOSO |
| `packages/engine/src/engine-service/protocol.ts:1762` | `packages/engine/src/engine-service/engineBundleStore.ts:289`, `327`, `366`, `403`, `451`, `465` | manifesto e arquivos do bundle | recusa de bundle/arquivo divergente |  |
| `packages/engine/src/engine-service/engineSupervisor.ts:324` | `packages/engine/src/engine-service/engineSupervisor.ts:1016`, `1191` | caminho e socket do workspace | recusa de identidade/adopção de engine |  |
| `packages/engine/src/tmux/TmuxService.ts:343` | `packages/engine/src/engine-service/controlServer.ts:150`, `187`, `packages/engine/src/engine-service/engineSupervisor.ts:1016` | caminho do workspace | recusa de workspace incorreto |  |
| `apps/vscode-extension/src/webview/ide-browser-bridge/hostServer.ts:207` | não comparado neste arquivo | caminho do workspace do browser | nada | DUVIDOSO |
| `packages/engine/src/agents/formation/humanLanes.ts:17-20`, `55`, `90`, `94` | `packages/engine/src/agents/formation/humanLanes.ts:90`, `94` | vetor de lanes e receipt | recusa/receipt inválido |  |
| `packages/engine/src/runtimeObservability/claudeStatusLineCapture.ts:109-117` | não comparado neste arquivo | caminho do workspace do relay | nada | DUVIDOSO |
| `packages/engine/src/handoff/ProjectHandoffStore.ts:96` | `packages/engine/src/handoff/ProjectHandoffStore.ts:295-298` | corpo de handoff | recusa (`cas_mismatch`) |  |
| `packages/engine/src/runtimeOps/workspaceLabels.ts:76` | não comparado neste arquivo | chave opaca do workspace | nada | DUVIDOSO |
| `packages/engine/src/richDoc/AttachmentStore.ts:176` | não comparado neste arquivo | bytes de anexo de documento | nada | DUVIDOSO |
| `packages/engine/src/activity/logStore.ts:305` | não comparado neste arquivo | bytes de blob de atividade | nada | DUVIDOSO |
| `packages/engine/src/worktree/managedWorktree.ts:93` | não comparado neste arquivo | tipo e chave do worktree | nada | DUVIDOSO |
| `packages/engine/src/externalTools/registry.ts:14` | não comparado neste arquivo | chave do registro de ferramenta | nada | DUVIDOSO |
| `packages/engine/src/engine-service/engineSupervisor.ts:800` | não comparado neste arquivo | marcador de preflight de upgrade | nada | DUVIDOSO |
| `scripts/vsix-smoke.mjs:364` | não comparado neste script | caminho real e socket do workspace | nada | DUVIDOSO |
| `scripts/dev-host/stop-bridge.mjs:103` | `scripts/dev-host/stop-bridge.mjs:225`, `243` | caminho canônico do workspace | recusa se descriptor não coincide |  |
| `scripts/dev-host/pointer.mjs:57` | não comparado neste arquivo | caminho do checkout | nada | DUVIDOSO |
| `scripts/dev-host/headless-settings-recovery.js:58` | não comparado neste arquivo | caminho do arquivo settings | nada | DUVIDOSO |
| `scripts/dogfood/pi-native-fork.mjs:97`, `108` | `scripts/dogfood/pi-native-fork.mjs:109` | bytes da sessão origem | recusa do dogfood |  |
| `scripts/dogfood/claude-bypass-optin.ts:44` | `scripts/dogfood/claude-bypass-optin.ts:69` (autoridade) | bytes do perfil de teste | não comparado neste script | DUVIDOSO |
| `scripts/dogfood/native-config-sources.ts:43` | `scripts/dogfood/native-config-sources.ts:60` (autoridade) | bytes do perfil de teste | não comparado neste script | DUVIDOSO |
| `scripts/dogfood/codex-danger-optin.ts:43` | `scripts/dogfood/codex-danger-optin.ts:71` (autoridade) | bytes do perfil de teste | não comparado neste script | DUVIDOSO |
| `scripts/dogfood/claude-canonical-create.ts:57` | não comparado neste script | valor canônico do perfil de teste | nada | DUVIDOSO |
| `scripts/dogfood/runtime-remeasure.ts:99` | não comparado neste script | bytes de arquivo medido | nada | DUVIDOSO |
| `scripts/research/poc-tui-canal-codex.mjs:516` | não comparado neste script | bytes de arquivos do canal | nada | DUVIDOSO |
| `scripts/dogfood/grok-attention-midturn.ts:52` | `scripts/dogfood/grok-attention-midturn.ts:229` | bytes do arquivo de autenticação | falha do dogfood se mudou |  |
| `scripts/dogfood/persistent-engine-runner.ts:531`, `601` | não comparado neste script | bundle quebrado e auditoria bridge | nada neste cálculo | DUVIDOSO |
| `apps/vscode-extension/src/runtimeConfig/claudeInventory.ts:37` | `apps/vscode-extension/src/runtimeConfig/claudeInventory.ts:231-234` | texto da configuração Claude | recusa da gravação |  |
| `apps/vscode-extension/src/runtimeConfig/grokInventory.ts:122` | `apps/vscode-extension/src/runtimeConfig/grokInventory.ts:510-514`, `545-547` | texto da configuração Grok | recusa da gravação |  |
| `apps/vscode-extension/src/plugins/engine.ts:914` (`fingerprintOf`) | `apps/vscode-extension/src/plugins/engine.ts:1470-1472`, `2653-2655` | plano de instalação do plugin | recusa e pede novo consentimento |  |
| `apps/vscode-extension/src/plugins/engine.ts:1960` (`removeFingerprint`) | `apps/vscode-extension/src/plugins/engine.ts:2065-2066` | plano de remoção do plugin | recusa e pede novo consentimento |  |
| `apps/vscode-extension/src/plugins/fetcher.ts:72` (`remoteHash`) | não comparado neste arquivo | URL remota do plugin | nada | DUVIDOSO |
| `apps/vscode-extension/src/plugins/fetcher.ts:274-277` (SHA de commit Git) | `apps/vscode-extension/src/plugins/fetcher.ts:276-277` | commit resolvido do repositório | erro de fetch/recusa |  |
| `apps/vscode-extension/src/plugins/gitHookState.ts:56` | não comparado neste arquivo | bytes do hook anterior | nada | DUVIDOSO |
| `packages/engine/src/config/agentProfileResolver.ts:343` | `packages/engine/src/config/agentProfileResolver.ts:520-527`, `886-889` | referência e grant de capability | withholding/diagnóstico |  |
| `packages/engine/src/agents/savedAgentProposal.ts:269-272` | `packages/engine/src/agents/savedAgentProposalStore.ts:152-160` | proposta de Saved Agent | recusa (`saved_agent_proposal_tampered`) |  |
| `packages/engine/src/agents/savedAgentRemovalProposal.ts:89-92` | `packages/engine/src/agents/savedAgentRemovalProposalStore.ts:119-127` | proposta de remoção de Saved Agent | recusa (`saved_agent_removal_proposal_tampered`) |  |
| `packages/engine/src/config/agentProfileGrants.ts:62-64` | `packages/engine/src/agents/savedAgentProposal.ts:396-404`, `packages/engine/src/agents/savedAgentRemovalProposal.ts:171-178` | bytes da configuração de roster | proposta inválida/novo digest |  |
| `packages/engine/src/config/agentProfileSchema.ts:71-75` | não há comparação de bytes; regex/schema | digest declarado em referência pinned | recusa de schema | DUVIDOSO |
| `packages/engine/src/plugins/manifest.ts:384-390`, `460` | não há comparação com bytes; regex/schema | digest declarado de artefato | recusa de manifesto | DUVIDOSO |
| `packages/engine/src/plugins/lockfile.ts:19`, `210-239`, `310-311` | não há comparação com bytes; regex/schema | digest declarado no lockfile | recusa de lockfile | DUVIDOSO |
| `packages/engine/src/agents/promptLayers.ts:62`, `77-82` | não comparado neste arquivo | texto de instruções renderizado | nada | DUVIDOSO |
| `packages/engine/src/sessionContinuation/focusedHandoff.ts:101` | não comparado neste arquivo | markdown do handoff focado | nada | DUVIDOSO |
| `packages/engine/src/host-action/audit.ts:79` | `packages/engine/src/host-action/audit.ts:135-136` (somente formato) | evento de auditoria encadeado | registro ignorado se inválido | DUVIDOSO |
| `packages/engine/src/harness/HarnessManager.ts:2203-2217` | não comparado neste arquivo | material de identidade do harness | nada | DUVIDOSO |
| `packages/bridge/src/callerIdentity.ts:135-137` (HMAC-SHA256) | `packages/bridge/src/callerIdentity.ts:176-178`, `233-240` | token de agente e escopo | token rejeitado ou fora de escopo |  |
| `apps/vscode-extension/src/plugins/gitHookRegistry.ts:232-234` | não comparado neste arquivo | templates de dispatcher de hook | nada | DUVIDOSO |
| `apps/vscode-extension/src/plugins/engine.ts:522` | não comparado diretamente neste arquivo | bytes de leaf de git hook | nada | DUVIDOSO |

## Contagem

Contagem mecânica desta tabela: 117 sítios; 41 marcados `DUVIDOSO`.

## Comandos de varredura executados

```sh
rg --files packages apps scripts .tachyon 2>/dev/null
rg -n -i 'sha256|createHash|digest|checksum|hash|sha1|md5|subtle\.digest' packages apps scripts .tachyon --glob '!tachyon.yml' --glob '!docs/project-guidance.md' 2>/dev/null
rg -l -i 'sha256|createHash|digest|checksum|hash|sha1|md5|subtle\.digest|\bhash\b' packages apps scripts --glob '*.{ts,tsx,js,jsx,mjs,cjs,json,yml,yaml}' | sort
rg -n 'createHash\(|subtle\.digest|sha256sum|\.digest\(' packages apps scripts --glob '*.{ts,tsx,js,jsx,mjs,cjs}'
rg -n -i 'sha256|hash|checksum|digest|sha1|md5' .tachyon --glob '*.yml' --glob '*.yaml' --glob '*.json' --glob '*.toml' 2>/dev/null
find .tachyon/agents -type f -maxdepth 4 -print 2>/dev/null | sort
rg -n -i 'createHash|subtle\.digest|sha256sum|sha1|md5|checksum|\.digest\(' packages apps scripts --glob '*.{ts,tsx,js,jsx,mjs,cjs}' > /tmp/hash-scan-hashcodex.txt
```

## Onde eu não procurei

- Não procurei fora deste checkout/worktree; em particular, não procurei no checkout primário nem no home do usuário. O caminho citado `.tachyon/agents/claude/agent.yml` não existe neste worktree (`find .tachyon/agents` não retornou arquivos).
- Não procurei em `tachyon.yml` nem em `docs/project-guidance.md`, conforme a restrição; o segundo também foi excluído da varredura inicial.
- Não procurei em `src/` na raiz, `tests/`/fixtures de testes fora dos caminhos acima, `dist/`, `build/`, `node_modules/` ou artefatos gerados.
- Não procurei no conteúdo interno de `.git/` (incluindo hooks e refs), nem em arquivos não listados sob `packages/`, `apps/`, `scripts/` e configurações `.tachyon`.
- Sob `.tachyon`, a busca foi limitada a extensões de configuração (`.yml`, `.yaml`, `.json`, `.toml`); estudos, reviews, evidências e documentos Markdown não foram tratados como código de produto.
