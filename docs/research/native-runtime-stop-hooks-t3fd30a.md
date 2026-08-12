# Hooks nativos como sinal de atenção (`t-3fd30a`)

**Medição:** 2026-08-12. **Escopo:** desenho; nenhuma mudança de comportamento.

## Resultado primeiro: `Stop` não foi descartado pelo runtime

O filtro em `HarnessManager.writeGrokProjectedHooks` não mata a ideia. Ele descarta
`SessionStart` e `Stop` somente da **projeção de hooks de plugins** porque esses dois nomes já
são o canal de ciclo de vida do Tachyon. Em Claude/Grok, `buildOwnershipSettings` constrói esse
canal; em Codex, `renderCodexProjectedHookConfig` explica a restrição adicional: um segundo
`-c hooks.Stop=...` substituiria o primeiro em vez de somar, desligando silenciosamente o hook
de persistência. Permitir que uma mudança de policy projetasse `Stop` também poderia duplicar o
recorder. Por isso o filtro protege propriedade/continuidade; ele não indica que `Stop` não
dispare.

Há prova já em produção de que o caminho dispara: quando silent persistence está elegível,
Claude e Codex recebem um `Stop` que executa `PERSISTENCE_STOP_RECORDER_SOURCE`; Grok recebe o
mesmo grupo em `$GROK_HOME/hooks/stop.json`, separado de `projected.json`. Portanto o primeiro
parágrafo não mata a proposta: ele diz que um ingest de atenção deve entrar no grupo de ciclo de
vida **Tachyon-owned**, nunca como mais um hook projetado por plugin.

## Matriz medida por runtime

`Medido` abaixo quer dizer que a versão instalada e seu artefato local (guia, tipos ou fonte
distribuída) foram lidos nesta árvore. `?` não é inferido de um runtime vizinho. “Espera” significa
um sinal nativo de que o runtime está aguardando ação humana; fim normal de turno implica espera
por novo prompt, mas não distingue sozinho uma caixa de permissão.

| Runtime | Versão instalada | Fim do turno | Espera pelo humano | Evidência | Forma de recepção |
|---|---:|---|---|---|---|
| Claude Code | 2.1.228 | `Stop` (conclusão normal; `StopFailure` é a saída por erro) | `Stop` = espera pelo próximo prompt; `Notification(permission_prompt)` = permissão; `Notification(idle_prompt)` é aviso tardio, não a borda inicial | **Medido no Tachyon:** o recorder `Stop` já dispara; lista de eventos do adapter e settings materializado | Hook `command` por `--settings`; também suporta hook HTTP nativo, mas o canal já usado aqui é command |
| Codex | 0.146.1 | `Stop` | `Stop` = espera pelo próximo prompt; evento específico de prompt de permissão: **?** | **Medido no Tachyon:** spec 315 e recorder em `-c hooks.Stop=...`; adapter aceita `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop` | Hook `command` por overrides `-c`; sujeito ao trust review, já tratado no lançamento canônico |
| Grok | 1.0.3 (`1a29d5bc12`) | `Stop` somente em conclusão genuína; não em interrupção. `StopFailure` para erro | `Stop` = espera pelo próximo prompt; `Notification(permission_prompt)` = permissão; `Notification(idle_prompt)` é tardio | **Medido:** guia instalado `~/.grok/docs/user-guide/10-hooks.md` e materialização Tachyon | Hook `command` ou `http`; global/private-home é always-trusted |
| Pi | 0.80.10 | `agent_settled` é a borda mais exata; `agent_end` termina um prompt, mas pode ser seguido por reentrada imediata; `turn_end` ocorre em cada resposta/model turn | `agent_settled` = loop realmente sem trabalho pendente e esperando; prompt/approval específico: **?** | **Medido:** tipos e `agent-session.js` instalados expõem `agent_settled`, `agent_end`, `turn_end`, `input`; documentação da extensão confirma a sequência | Extensão Pi (`pi.on(...)`), não hook shell declarativo; Tachyon já injeta uma extensão imutável para Bridge |
| OpenCode | 1.18.16 | `session.idle` | `session.idle` = sessão sem execução e esperando; prompt/approval específico: **?** | **Medido parcialmente:** binário instalado e API oficial de plugins declara `session.idle`; o binário empacotado não oferece artefato legível para medir uma distinção de permissão | Plugin JavaScript recebe o event bus; não foi medido um hook command equivalente |
| Hermes | 0.18.2 (`2026.7.7.2`, upstream `2a25d53e`) | `post_llm_call` após loop bem-sucedido; `on_session_end` ao fim de cada `run_conversation` e também na saída do CLI | Espera exata por novo prompt: **?**; approval específico: **?** | **Medido:** checkout instalado e documentação de plugins; `post_llm_call` não cobre turnos falhos e `on_session_end` mistura fim de chamada com saída | Plugin Python (`register_hook`); não há hoje projeção Tachyon desse plugin no harness |

Conclusão de cobertura: há uma borda utilizável em todos os seis runtimes instalados, mas somente
Claude, Codex e Grok já têm um **canal de hook gerenciado pelo Tachyon**. Pi tem a melhor borda
(`agent_settled`) e um ponto de extensão já injetado pelo produto. OpenCode e Hermes exigiriam
integração com o plugin nativo, não uma cópia do formato Claude. Em Hermes, a borda de espera ainda
fica `?`: `post_llm_call` perde falhas e `on_session_end` tem semântica mais larga.

## Caminho de volta ao produto

O produto já possui quase todas as peças, mas não existe hoje uma porta que converta um evento de
runtime em `AgentAttention`:

1. O processo canônico já recebe `TACHYON_AGENT_NAME`, `TACHYON_AGENT_BRIDGE_URL` e seu bearer
   por agente. O Bridge já serve MCP autenticado em `/mcp` e resolve a identidade pelo bearer.
2. Hooks Claude/Codex/Grok já executam comandos materializados pelo Tachyon. Pi já carrega a
   extensão imutável que implementa o Bridge. Logo, identidade e transporte autenticado não precisam
   ser reinventados.
3. `notify_agent` e `.tachyon/doorbells.jsonl` não servem como ingest: são comunicação de um agente
   para outro e significam “o autor declarou entrega”, não “o runtime encerrou qualquer turno”. Usá-los
   misturaria telemetria com uma ação humana/agentic e poderia acordar destinatários indevidamente.
4. O log de activity também não é a autoridade adequada: normalizadores leem transcritos depois do
   fato, não todos os eventos nativos, e não oferecem uma borda autenticada de estado ao monitor.

A menor peça nova seria uma operação Bridge autenticada, por exemplo `runtime_status.publish`, com
payload limitado a `{event, runtime, sessionId?, ts?}`. Ela reaproveitaria o `/mcp`, bearer, identidade
resolvida e registro do agente; a extensão/hook chamaria a operação e o Workspace entregaria o evento
ao monitor. Para hooks shell, o comando materializado deve usar um pequeno cliente Tachyon (ou uma
invocação MCP bem formada); um endpoint HTTP paralelo sem necessidade duplicaria autenticação,
roteamento e lifecycle já existentes. Persistência curta do último evento/seq seria útil para restart
do host, mas **não** é a doorbell e não deve transformar uma borda antiga em prova de liveness atual.

### Atores × gatilhos que precisam da mesma semântica

| Ator | Gatilho | Resultado esperado |
|---|---|---|
| Interface | humano submete prompt | runtime emite início (`UserPromptSubmit`, `agent_start` etc.); estado vira `working` |
| Agent | Bridge injeta/submete prompt | mesma borda nativa de início; não criar uma segunda regra por origem do prompt |
| Tachyon | spawn, restart, resume, fork | instalar/injetar o canal antes do primeiro turno e amarrar evento à instância atual, não apenas ao nome persistente |
| Runtime | conclusão, falha, interrupção, crash | conclusão exata vira espera; falha/interrupção usam evento próprio quando houver; crash sem evento cai no fallback |

O identificador da instância é load-bearing: um `Stop` atrasado da sessão anterior não pode marcar a
sessão recém-reiniciada como ociosa. `SessionStart`/ownership já oferece a matéria-prima, mas o desenho
de implementação deve ligar cada publicação ao spawn/session atual e rejeitar eventos órfãos.

## Mudança proposta para a dimensão 3

Hoje a matriz diz literalmente que o monitor classifica tudo “from the pane”. Com ingest nativo,
a definição honesta seria:

> **Attention:** bordas nativas autenticadas classificam início e fim/espera quando o runtime as
> oferece; o pane/CPU permanece fallback de liveness, prompts não cobertos, throttle e runtimes sem
> integração medida.

Quando uma integração estiver medida por runtime, podem sair daquele runtime:

- o `silenceSec = 8` como detector primário de fim de turno (permanece como timeout/fallback de
  ausência de evento);
- frases de conclusão/espera usadas apenas para adivinhar a borda que `Stop`/`agent_settled` informa;
- padrões extras ensinados pelo humano para essa mesma finalidade. Padrões de `throttle`, auth e
  prompts de permissão sem evento nativo continuam necessários.

O ganho também fecha uma inferência conhecida do Design Mode (`t-b09d9c`): ele precisou provar início
de turno para não aceitar o fim do turno anterior dentro de dez segundos. Um evento nativo, sequenciado
por instância/turno, daria exatamente a borda de fim que aquele fluxo teve de inferir.

## Onde o evento não cobre

- **Agente wedged:** processo vivo travado, deadlock, request de rede sem retorno ou modelo pensando
  para sempre não emite `Stop`. Pane, CPU, heartbeat e limite temporal continuam sendo o fallback que
  detecta ausência de progresso. Hooks melhoram correção de borda; não são watchdog.
- **Crash/kill:** um processo morto não consegue postar a última borda. O lifecycle do processo deve
  vencer qualquer último status persistido.
- **Hook perdido:** timeout, trust recusado, config sobrescrita ou falha do cliente deixa um buraco.
  A ausência deve degradar para inferência, nunca declarar `idle` por silêncio do canal.
- **Permissão e perguntas intermediárias:** `Stop` marca fim normal, não toda UI que espera o humano.
  Claude/Grok têm `Notification(permission_prompt)`; nos outros runtimes a célula continua `?` até
  medição. O composer/pane segue necessário.
- **Throttle/auth:** nenhum evento comum medido substitui os sinais atuais. Grok `StopFailure` expõe
  classes de erro, mas isso não autoriza generalizar para os demais.
- **Subagentes:** `SubagentStop`/eventos equivalentes descrevem filhos internos, não o pane principal.
  Misturá-los com `Stop` produziria falso idle enquanto o agente pai continua trabalhando.
- **Eventos fora de ordem:** comandos assíncronos e restart podem entregar atrasado. Sequência e
  identidade da instância são requisitos, não refinamentos opcionais.

Portanto a recomendação é **fundir sinais, não substituir o AttentionMonitor**: evento nativo tem
precedência para bordas que ele afirma; lifecycle do processo e sinais explícitos de erro têm
precedência sobre status persistido; leitura de pane/CPU cobre ausência, prompts e wedged. Só depois
de cada runtime provar seu canal em fail-before/pass-after a respectiva heurística pode ser removida.

## Fontes lidas

- Código local: `src/harness/HarnessManager.ts`, `src/activity/sessionOwners.ts`,
  `src/plugins/adapters/{claude,codex,grok}.ts`, `src/bridge/Bridge.ts`,
  `src/workspace/Workspace.ts`, `src/attention/AttentionMonitor.ts`.
- Matriz: `docs/runtimes/parity.md`, dimensão 3 e linhas por runtime.
- Artefatos instalados: `~/.grok/docs/user-guide/10-hooks.md`; Pi
  `dist/core/agent-session.js` e `dist/core/extensions/types.d.ts`; Hermes checkout
  `docs/observability/README.md`, `agent/conversation_loop.py` e documentação de plugins.
- Referências upstream consultadas: documentação de extensões do Pi, plugins do OpenCode,
  hooks do Claude Code e plugins do Hermes. Codex foi atestado pelo próprio código/teste local do
  Tachyon que já instala e executa seu `Stop`, sem generalizar documentação de terceiros.
