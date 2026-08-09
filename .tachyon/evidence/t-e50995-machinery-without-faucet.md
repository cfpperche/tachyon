# Auditoria “maquinaria completa sem torneira” — t-e50995

## Resultado

- Árvore-base: `ec4634e4f51e1133809c49e0458df77fa654ca17` (`HEAD` antes deste relatório).
- Universo: 785 arquivos TypeScript/JavaScript em `src/` e 793 em `test/`.
- Candidatos julgados: **145**; torneiras realmente faltando: **5**.
- Exemplar conhecido `createCandidate` (`t-75ce10`) foi usado apenas como controle e está fora desta lista.

## Método e limites

1. Extraí valores exportados de `src/**/*.{ts,tsx,js,jsx}` pela AST do TypeScript.
2. Conteio referências semânticas (ignorando definição, import e re-export) em `src/` e `test/`; retive `test > 0` e `src = 0`.
3. Rodei o scanner de reachability dos 18 entrypoints de `esbuild.mjs` (knip: 83 arquivos e 1.760 exports/tipos brutos) como sinal independente.
4. Construí os bundles e procurei cada nome literal em `dist/engine/engine-daemon.cjs` e `dist/extension.js`. “Não” é evidência forte, não prova: minificação, concatenação, template strings, propriedade computada, reflexão e nomes transportados como string podem ocultar a chegada.
5. Inspecionei manualmente os candidatos de maior custo e seus caminhos vizinhos. “Chamadores” abaixo significa referências semânticas após remover definição/import/re-export; não é contagem de linhas de grep.

## Lista julgada (ordenada pelo custo da mentira)

| Símbolo | Definição | test/ | src/ | engine bundle | extension bundle | Veredito |
|---|---|---:|---:|:---:|:---:|---|
| `EvolutionFormationTransactionService` | `src/agents/formation/evolutionTransactions.ts:48` | 2 | 0 | não | não | torneira faltando — transação de promoção com barreira, digest, commit e recuperação existe inteira, mas nenhuma porta de produção instancia o serviço. |
| `SelectedMemoryFormationTransactionService` | `src/agents/formation/memoryTransactions.ts:38` | 3 | 0 | não | não | torneira faltando — promoção de memória selecionada tem custódia, publicação, commit e rollback/recovery, mas somente os testes constroem o serviço. |
| `AppliedStateStore` | `src/plugins/appliedState.ts:180` | 4 | 0 | não | não | torneira faltando — registro durável e atômico de contribuições aplicadas promete autoridade de install/uninstall, porém não há consumidor em produção. |
| `gcAbandonedTransactions` | `src/plugins/toolTransaction.ts:106` | 4 | 0 | não | não | torneira faltando — a recuperação no restart prometida pelo journal de provisionamento nunca é chamada, embora as transações sejam criadas em produção. |
| `verifyNativeMemory` | `src/runtime/nativeMemoryVerifier.ts:163` | 20 | 0 | não | não | torneira faltando — o verificador sandboxado com autorização, proveniência e limpeza existe completo, mas não há caminho de produto que o execute. |
| `internalShareTargets` | `src/activity/activityShare.ts:86` | 2 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `buildActivityView` | `src/activity/activityView.ts:128` | 26 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `normalizeClaude` | `src/activity/claudeNormalizer.ts:250` | 59 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `normalizeCodex` | `src/activity/codexNormalizer.ts:247` | 12 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `normalizeGrok` | `src/activity/grokNormalizer.ts:207` | 4 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `normalizeHermesRows` | `src/activity/hermesNormalizer.ts:193` | 5 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `normalizeOpencode` | `src/activity/opencodeNormalizer.ts:97` | 3 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `normalizePi` | `src/activity/piNormalizer.ts:268` | 5 | 0 | sim | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `prunePersistenceLedger` | `src/activity/sessionOwners.ts:305` | 2 | 0 | sim | sim | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `vscodeReloadWindowDescriptorHash` | `src/agent-vscode/reloadCapability.ts:12` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `gateCmdRuntimeChange` | `src/agents/cmdRuntimeGate.ts:30` | 4 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `FORGET_AGENT_FOOTPRINTS` | `src/agents/forgetAgent.ts:10` | 1 | 0 | sim | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `profileActivationHeadV2FromV1` | `src/agents/formation/domain.ts:350` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `validateFormationSessionTransition` | `src/agents/formation/sessionPolicy.ts:22` | 4 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `readSavedAgentProposalWitness` | `src/agents/savedAgentProposalStore.ts:84` | 6 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `listLiveSavedAgentProposals` | `src/agents/savedAgentProposalStore.ts:215` | 2 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `readSavedAgentRemovalProposalWitness` | `src/agents/savedAgentRemovalProposalStore.ts:69` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `listLiveSavedAgentRemovalProposals` | `src/agents/savedAgentRemovalProposalStore.ts:167` | 4 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `compactionRuntimes` | `src/anchor/compaction.ts:31` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `TAIL_WINDOW` | `src/attention/patterns.ts:29` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `classifyTail` | `src/attention/patterns.ts:42` | 10 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `formatCpuPct` | `src/attention/resourceSample.ts:136` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `formatMemMb` | `src/attention/resourceSample.ts:140` | 3 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `composeApprovalPinDetail` | `src/bridge/approvalRequest.ts:580` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `composeApprovalPinTitle` | `src/bridge/approvalRequest.ts:599` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `AGENT_SUMMARY_CAP` | `src/bridge/notifyAgent.ts:39` | 11 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `PRIMER_LINE_BUDGET` | `src/bridge/primer.ts:39` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `BEFORE_FINISHING_LINE_BUDGET` | `src/bridge/primer.ts:41` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `tokenMatches` | `src/bridge/token.ts:47` | 4 | 0 | sim | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `semanticParity` | `src/cockpit/executionGraphVm.ts:416` | 4 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `parentRoute` | `src/cockpit/route.ts:253` | 11 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `navSection` | `src/cockpit/route.ts:306` | 7 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `isStudioRoute` | `src/cockpit/route.ts:335` | 4 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `refreshPolicy` | `src/cockpit/route.ts:350` | 7 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `formatRoute` | `src/cockpit/route.ts:393` | 5 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `routes` | `src/cockpit/route.ts:418` | 44 | 0 | sim | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `decodePanelState` | `src/cockpit/route.ts:593` | 12 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `makeStudioAdapterFactory` | `src/cockpit/studioRegistry.ts:154` | 4 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `readPortableAgentProfileBundleFile` | `src/config/agentProfileBundle.ts:114` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `parseArgvCommand` | `src/config/argvCommand.ts:5` | 2 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `useGlobalSettingsHome` | `src/config/globalSettings.ts:178` | 3 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `validateTachyonConfigText` | `src/config/loadConfig.ts:2091` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `loadAndRenderProjectGuidance` | `src/config/projectGuidance.ts:277` | 5 | 0 | sim | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `agentStanzaSection` | `src/config/YamlConfigEditor.ts:47` | 5 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `setCompanionLanAccess` | `src/config/YamlConfigEditor.ts:292` | 3 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `replaceAgentStanzaValue` | `src/config/YamlConfigEditor.ts:507` | 2 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `reminderText` | `src/continuity/classifier.ts:103` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `coldStartReminderText` | `src/continuity/classifier.ts:112` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `_resetEngineLogRingForTests` | `src/engine-service/engineLogRing.ts:170` | 1 | 0 | não | não | helper de teste — duplo, fixture ou reset explicitamente destinado ao harness. |
| `attributionFor` | `src/executionGraph/executionIdentity.ts:137` | 8 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `projectForAgent` | `src/executionGraph/executionProjection.ts:266` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `causalChain` | `src/executionGraph/executionProjection.ts:283` | 2 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `deactivate` | `src/extension.ts:4000` | 2 | 0 | não | sim | ponto de extensão deliberado — chamado pelo host/runtime por contrato de entrada, não por referência TypeScript em `src/`. |
| `isHandoffDistillRuntime` | `src/handoff/distill.ts:37` | 3 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `shouldRemindHandoff` | `src/handoff/ProjectHandoffStore.ts:214` | 6 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `harnessMcpPath` | `src/harness/HarnessManager.ts:839` | 8 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `harnessCodexConfigPath` | `src/harness/HarnessManager.ts:844` | 3 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `harnessWiring` | `src/harness/HarnessManager.ts:1337` | 2 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `AgentNoopHostActionPort` | `src/host-action/noopAdapter.ts:4` | 9 | 0 | não | não | helper de teste — duplo, fixture ou reset explicitamente destinado ao harness. |
| `decideHeavyGate` | `src/host/hostResources.ts:116` | 2 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `admitOrFallback` | `src/host/vitestBudget.ts:85` | 2 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `tachyonPiBridge` | `src/pi-bridge-extension/index.ts:68` | 2 | 0 | não | não | ponto de extensão deliberado — chamado pelo host/runtime por contrato de entrada, não por referência TypeScript em `src/`. |
| `PIN_IMAGE_MAX_BYTES` | `src/pins/PinAttachmentStore.ts:17` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `runtimeSupportsSkills` | `src/plugins/engine.ts:597` | 3 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `runtimeSupportsMcp` | `src/plugins/engine.ts:636` | 3 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `dispatcherTemplateFingerprint` | `src/plugins/gitHookRegistry.ts:229` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `gitHookStdinEventsAreAllowlisted` | `src/plugins/gitHookRegistry.ts:241` | 2 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `isSafePluginRoot` | `src/plugins/paths.ts:53` | 6 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `detectHostTool` | `src/plugins/toolProvisioning.ts:766` | 4 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `legacyPluginSurfaceTarget` | `src/plugins/ui/host.ts:49` | 1 | 0 | não | não | helper de teste — duplo, fixture ou reset explicitamente destinado ao harness. |
| `buildAttachShellCommand` | `src/presentation/TmuxAttachClient.ts:73` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `runProbe` | `src/probe/ProbeRunner.ts:135` | 13 | 0 | sim | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `ALL_TERMINATION_REASONS` | `src/probe/taxonomy.ts:37` | 5 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `isOk` | `src/probe/taxonomy.ts:139` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `buildAgentOpencodeJson` | `src/registration/adapters.ts:226` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `RESUME_RUNTIMES` | `src/resume/adapters.ts:423` | 5 | 0 | sim | sim | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `parseExtensionCommandV1` | `src/runtime-api/extensionOperations.ts:331` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `isRuntimeOpsSnapshotV1` | `src/runtime-api/runtimeOpsProjection.ts:275` | 4 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `claudeMemoryStorePath` | `src/runtime/adapters/claudeMemory.ts:60` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `claudePurgePlanArgv` | `src/runtime/adapters/claudeMemory.ts:65` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `parseClaudePurgePlan` | `src/runtime/adapters/claudeMemory.ts:86` | 4 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `claudeMemoryCapability` | `src/runtime/adapters/claudeMemory.ts:107` | 2 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `claudeMemoryVerificationPlan` | `src/runtime/adapters/claudeMemory.ts:133` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `codexFeaturesListArgv` | `src/runtime/adapters/codexMemory.ts:73` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `codexMemoryStorePath` | `src/runtime/adapters/codexMemory.ts:78` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `codexMemoryEffectiveState` | `src/runtime/adapters/codexMemory.ts:107` | 5 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `memoryEnablingKeys` | `src/runtime/adapters/codexMemory.ts:122` | 3 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `codexMemoryVerificationPlan` | `src/runtime/adapters/codexMemory.ts:139` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `codexMemoryCapability` | `src/runtime/adapters/codexMemory.ts:175` | 2 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `GROK_MEMORY_PRECEDENCE` | `src/runtime/adapters/grokMemory.ts:130` | 8 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `GROK_MEMORY_DOCUMENTED_PRECEDENCE` | `src/runtime/adapters/grokMemory.ts:143` | 2 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `grokMemoryVerificationPlan` | `src/runtime/adapters/grokMemory.ts:192` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `grokMemoryCapability` | `src/runtime/adapters/grokMemory.ts:223` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `isBehavioralLaneSuppressionEvidence` | `src/runtime/nativeLaneSuppression.ts:24` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `isNativeSuppressionConfirmed` | `src/runtime/nativeLaneSuppression.ts:265` | 4 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `isBehavioralEvidence` | `src/runtime/nativeMemory.ts:54` | 4 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `resolveMemoryPolicy` | `src/runtime/nativeMemory.ts:476` | 28 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `canExportMemory` | `src/runtime/nativeMemory.ts:598` | 3 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `promoteEvidence` | `src/runtime/nativeMemoryVerifier.ts:346` | 3 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `GrokInspectConfigObservationSource` | `src/runtimeObservability/grokInspectConfigSource.ts:70` | 2 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `buildRuntimeUsageRows` | `src/runtimeUsage/model.ts:80` | 3 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `legacyBoardTarget` | `src/shell/BoardTarget.ts:50` | 5 | 0 | não | não | helper de teste — duplo, fixture ou reset explicitamente destinado ao harness. |
| `FakeWorkspaceClient` | `src/shell/FakeWorkspaceClient.ts:65` | 34 | 0 | não | não | helper de teste — duplo, fixture ou reset explicitamente destinado ao harness. |
| `legacySidebarTarget` | `src/shell/SidebarTarget.ts:60` | 1 | 0 | não | não | helper de teste — duplo, fixture ou reset explicitamente destinado ao harness. |
| `legacyTaskDetailTarget` | `src/shell/TaskDetailTarget.ts:41` | 9 | 0 | não | não | helper de teste — duplo, fixture ou reset explicitamente destinado ao harness. |
| `legacyTaskStudioTarget` | `src/shell/TaskStudioTarget.ts:71` | 17 | 0 | não | não | helper de teste — duplo, fixture ou reset explicitamente destinado ao harness. |
| `describeCardTemplateSource` | `src/sidebar/cardTemplate.ts:600` | 4 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `TASK_DETAIL_SCHEMA_VERSION` | `src/tasks/TaskDetailStore.ts:17` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `resolveClipboardHelper` | `src/tmux/clipboard.ts:34` | 3 | 0 | sim | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `resetServerScopeProbeForTests` | `src/tmux/TmuxService.ts:240` | 3 | 0 | não | não | helper de teste — duplo, fixture ou reset explicitamente destinado ao harness. |
| `recoverWedgedServer` | `src/tmux/TmuxService.ts:570` | 2 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `isCapped` | `src/webview/activity/feedModel.ts:106` | 4 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `computeGrid` | `src/webview/agent-pane/geometry.ts:24` | 3 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `codexNativeConfigChoice` | `src/webview/agent-studio-shell/domain.ts:870` | 2 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `setCodexNativeConfigChoice` | `src/webview/agent-studio-shell/domain.ts:871` | 3 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `PNG_LOGOS` | `src/webview/agent-studio-shell/runtimeLogos.tsx:113` | 2 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `buildApprovalViewModel` | `src/webview/approval/viewModel.ts:38` | 3 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `flagSuggestionsFor` | `src/webview/formLogic.ts:91` | 5 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `suggestName` | `src/webview/formLogic.ts:106` | 3 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `stepResolutions` | `src/webview/formLogic.ts:160` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `inspectDmChatFile` | `src/webview/ide-browser-bridge/designModeChat.ts:174` | 5 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `agentSwitchRetargetsWait` | `src/webview/ide-browser-bridge/designModeChatTurn.ts:77` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `SectionAppFixturePanelManager` | `src/webview/SectionAppFixturePanel.ts:30` | 1 | 0 | não | não | helper de teste — duplo, fixture ou reset explicitamente destinado ao harness. |
| `issueCompanionPairCodeAction` | `src/webview/shared/control/messages.ts:457` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `companionPairOfferMessage` | `src/webview/shared/control/messages.ts:499` | 2 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `loadSectionStylesheet` | `src/webview/shared/lazySectionStyles.ts:18` | 6 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `SHELL_DESIGN_SYSTEM_STYLESHEET` | `src/webview/shared/shell.ts:45` | 2 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `SHELL_PAGE_FRAME_STYLESHEET` | `src/webview/shared/shell.ts:58` | 5 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `parseShellCsp` | `src/webview/shared/shell.ts:164` | 16 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `requiresDiscardConfirmation` | `src/webview/shared/studio/dirtyGating.ts:26` | 3 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `hasBlockingErrors` | `src/webview/shared/studio/errorTaxonomy.ts:40` | 3 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `decideVanishedDraft` | `src/webview/shared/studio/tombstone.ts:50` | 3 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `pinDocPreview` | `src/webview/SidebarPrototype.ts:564` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `postureDeclarationErrors` | `src/webview/surfaces.ts:279` | 6 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `renderGatePage` | `src/webview/ui-gate/gatePage.ts:7` | 2 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `WEBVIEW_APP_REACHABLE_BUDGET_BYTES` | `src/webview/webviewApps.ts:236` | 2 | 0 | não | sim | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `__resetShellDiagnosticLog` | `src/workspace/shellDiagnosticLog.ts:156` | 1 | 0 | não | não | helper de teste — duplo, fixture ou reset explicitamente destinado ao harness. |
| `isUnderManagedBase` | `src/worktree/managedWorktree.ts:72` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `liveFoldersFromRegistry` | `src/worktree/managedWorktree.ts:208` | 3 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |
| `agentWorktreePath` | `src/worktree/ManagedWorktreeService.ts:890` | 1 | 0 | não | não | helper de teste — seam determinístico exportado para teste direto; não contém máquina autônoma de custódia, transação ou recuperação. |

## Leitura dos cinco positivos

1. **EvolutionFormationTransactionService** e **SelectedMemoryFormationTransactionService** são os mais caros: implementam autoridade transacional, digest, publicação em fases, idempotência e recuperação, mas nenhuma é importada/instanciada em produção e ambas somem dos dois bundles.
2. **AppliedStateStore** mantém um registro atômico que deveria impedir materialização sem autoridade e limpar uninstall; somente os testes o instanciam e ele não entra nos bundles.
3. **gcAbandonedTransactions** é explicitamente descrito como “recover-on-restart”, enquanto `ToolTransaction.begin` roda em produção; o GC só aparece na definição e nos testes, e não entra nos bundles.
4. **verifyNativeMemory** contém execução comportamental completa (sandbox, autorização faturável, proveniência, lifecycle e cleanup), mas o adaptador só descreve o plano; não há executor e o símbolo não entra nos bundles.

## Controles contra falsos positivos

- `deactivate` é chamado por reflexão pelo host VS Code; `tachyonPiBridge` é entrypoint do runtime Pi. São pontos de extensão deliberados apesar de zero caller textual.
- Resets `_...ForTests`, `FakeWorkspaceClient`, alvos `legacy*`, fixtures e adaptadores no-op são helpers deliberados.
- Os demais são funções puras, parsers, formatadores, constantes ou seams exportados para teste unitário; podem ser código órfão/refatorável, mas não exibem a promessa downstream de custódia/transação/rollback desta task.
- Onde um nome pudesse chegar por string/reflexão, o bundle literal foi somente segundo sinal; nenhum dos cinco positivos aparece nos dois bundles.
