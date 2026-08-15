# 508 — paridade-verificavel — notes

_Created 2026-08-15._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- 2026-08-15, fatia 1: the declaration lives in `packages/engine/src/runtime/parity.ts` and starts
  with `session-hooks` and `headless-probe` for only Claude, Codex, and Grok. Both are `wired` for all
  three runtimes on the current product tree.
- `Workspace.silentPersistenceHooksDesired` decides eligibility, self-managed-session exclusion, and
  runtime support. Only the third question is parity. Its runtime decision was extracted once as
  `runtimeUsesSilentPersistenceHooks`; the private Workspace method calls it, and the parity test
  calls the same product decision. This avoids exposing or reimplementing the broader Workspace gate.
- Headless probe is derived from both production doors named by parity row 13: the adapter map used
  by Workspace and the Bridge `probe_agent` input schema. The declaration is `wired` only when both
  accept the runtime.

## Deviations

- Permission inject (candidate row 9) was not included. The production seam
  `AgentManager.applyAgentPermissionProjection` is a command transformation whose answer depends on
  authored projection, delegated lineage, and existing command flags. It has no callable per-runtime
  support verdict, and interpreting an unchanged command as unsupported would falsely classify
  Claude, whose posture may already be present in the launch command. This is non-derivable in the
  slice-1 sense and belongs in the slice-2 classification rather than a false unit derivation.

## Tradeoffs

- The runtime validator duplicates no product verdicts: it validates declaration shape and evidence
  only. TypeScript `satisfies` rejects malformed authored cells at compile time; the runtime validator
  also catches malformed data that crossed a cast or serialization boundary.

## Red-proof log

- Session hooks: temporarily removed `|| runtime === "grok"` from
  `runtimeUsesSilentPersistenceHooks`. Focused Vitest exited 1 with
  `session-hooks/grok: product=not-wired, declaration=wired`.
- Headless probe: temporarily removed `["grok", grokAdapter]` from the production adapter registry.
  Focused Vitest exited 1 with `headless-probe/grok: product=not-wired, declaration=wired`.
- Completeness: temporarily removed the `session-hooks/grok` declaration cell (and used an explicit
  unsafe cast solely to get the malformed fixture through transpilation). Focused Vitest exited 1
  with `session-hooks/grok: missing parity cell`; the axis test also named absent `grok`.
- `cannot` evidence: temporarily authored `{ verdict: "cannot" }` for `session-hooks/grok` through
  the same deliberate unsafe cast. Focused Vitest exited 1 with
  `session-hooks/grok: cannot requires a written reason`.
- `measured` evidence: temporarily authored `{ verdict: "measured" }` for `session-hooks/grok`.
  Focused Vitest exited 1 naming both missing fields: `runtimeVersion` and `measuredAt as YYYY-MM-DD`.
- Every mutation above was restored; the focused suite then returned green.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Fatia 2 — classificação das 22 dimensões

Classificação feita em 2026-08-15 para **Claude, Codex e Grok somente**. A classe responde qual
prova é necessária para sustentar o significado completo da linha, não se existe um arquivo cujo
nome se parece com a capacidade:

- `derivable`: o produto já toma o veredito numa porta chamável e uma prova pode comparar a tabela
  com essa decisão sem executar o CLI;
- `measured`: parte essencial da afirmação é comportamento do binário real (saída, consumo de
  configuração, persistência ou interação), portanto fixtures só provam o leitor, não a capacidade;
- `cannot`: pelo menos um runtime no escopo não oferece a alavanca nativa necessária, ou uma
  subdimensão obrigatória não pode ser acoplada honestamente hoje.

| # | Dimensão | Classe | Critério exato |
|---:|---|---|---|
| 1 | Brief / instructions | `derivable` | `runtimePromptAdapter(command)` / `instructionsDeliverable(cmd)` escolhem o canal de abertura e `composeCommand` materializa o brief em fresh/restart. A linha exige oferta automática pelo canal, não prova de que o modelo obedeceu ao texto. |
| 2 | Bridge MCP | `measured` | `withRuntimeBridge` e os materializadores produzem argv/config para as quatro portas, mas “o agente alcança o Bridge” também depende de cada CLI consumir aquela forma nativa e listar/chamar o servidor. Inspecionar os bytes gerados prova a projeção, não o alcance real. |
| 3 | Attention | `measured` | O classificador e `runtimeProfile.composer` são chamáveis, porém a linha afirma estados emitidos pela TUI real e identidade de throttle. Uma fixture derivada dos mesmos padrões provaria somente o parser; a estabilidade da região/composição e dos sinais vem de captura do CLI. |
| 4 | Resume | `derivable` | `adapterForRuntime(runtime)?.resumeCommand` é a decisão de produto que reconstrói o comando; para os três runtimes há adapter e o teste pode comparar presença e forma sem repetir uma allowlist. A linha define reconstrução do comando, não sucesso semântico de uma conversa real. |
| 5 | Fork | `cannot` — **Codex** | `forkable(adapter)` deriva Claude/Grok de `forkCommand`, mas o adapter Codex não tem `forkCommand` porque o CLI não oferece branch nativo preservando a origem. Não existe função a acoplar para Codex; simular cópia de transcript não satisfaz a definição. |
| 6 | Harness / private home | `derivable` | `harnessable(adapter)` e `HarnessManager` decidem e materializam home, env, auth e estado privados para os três. A propriedade observável é o plano/árvore de arquivos produzido e pode ser inspecionada com homes temporários; não depende de resposta do modelo. |
| 7 | Graceful stop | `measured` | `gracefulStopForCommand` deriva as teclas, mas a linha exige que a sequência realmente encerre o processo limpo. Menus, composer ocupado e códigos de saída são comportamento temporal da TUI; somente o dogfood `stop-exit-codes` prova entrega e exit 0. |
| 8 | Activity ingest | `measured` | `createNormalizer(runtime, sourcePath)` seleciona leitores para os três e fixtures provam a normalização, mas a afirmação inclui o CLI real escrever duravelmente o store/formato observado. Um leitor verde não prova que a versão instalada ainda produz esses eventos. |
| 9 | Permission inject | `measured` | `AgentManager.applyAgentPermissionProjection` é transformação de comando dependente de projeção autorada, linhagem delegada e flags já presentes; não há veredito chamável de suporte por runtime. Comando inalterado classificaria Claude falsamente, pois sua postura pode já estar no launch. É preciso observar a postura efetiva do CLI. |
| 10 | Label / profile | `derivable` | `runtimeProfile(runtime)` retorna a declaração tipada usada pela UI/governança. Presença de isolation, graceful stop, label/composer/permissions/aliases pode ser validada diretamente contra a tabela, sem executar o runtime. |
| 11 | Restart | `derivable` | `AgentManager.restart` é a única porta: relê a mesma definição, escolhe new/resume e percorre novamente a construção de spawn/Bridge. Não existe decisão diferente por runtime além dos adapters chamáveis que essa porta usa. |
| 12 | Native configuration parity | `measured` | Os projetores Claude/Codex/Grok são chamáveis e provam source/treatment/refresh e bytes materializados, mas a linha diz que cada comportamento nativo medido é preservado ou excluído. Só o binário revela se uma chave continua sendo lida e produzindo o efeito; key presente em arquivo não prova consumo. |
| 13 | Headless probe | `derivable` | Já provado na fatia 1: o veredito é a conjunção de `headlessProbeAdapters().has(runtime)` e `PROBE_RUNTIME_SCHEMA.safeParse(runtime)`. Remover Grok do registry deixou o teste vermelho sem repetir a lista na prova. |
| 14 | Runtime Config (Control) | `derivable` | `inspect*RuntimeConfig` / `apply*RuntimeConfigChange` são as portas reais de Claude/Codex/Grok e retornam os documentos e operações compatíveis que alimentam o selector. A classificação cobre o adapter e o subconjunto que o produto permite, não redescobre a semântica histórica de cada chave. |
| 15 | Runtime-managed native memory | `measured` | `nativeMemoryCapability(adapter)` expõe o registro, mas o próprio registro separa `declared`, `verified` e `refuted`. Disable/enable/injection/mutation/isolation/lifecycle são efeitos do modelo/store real; comparar o registro consigo mesmo seria tautologia. |
| 16 | Auth-required detection | `measured` | `classifyAuthRequired` consome os matchers de `RUNTIME_AUTH_PROFILES`, mas a distinção de auth contra quota/rede/permissão e o fato de o sinal ser turn-attached vêm de execuções reais. Fixtures verbatim provam o matcher, não que o CLI atual ainda emite o sinal correto. |
| 17 | Temporary Agent (`spawn_agent`) | `derivable` | `isSupportedAgentRuntime` / `SUPPORTED_AGENT_RUNTIMES` declaram admissão e mecanismos; o teste precedente já deriva resume de `adapterForRuntime`, brief de `runtimePromptAdapter` e Bridge da declaração, fazendo mudança de catálogo divergir. É exatamente o molde não-tautológico citado pela SDD. |
| 18 | Internal checklist telemetry | `measured` | A linha descreve eventos/arquivos estruturados nativos e correlação/proveniência, hoje não integrados para os três. Nenhuma função de produto decide suporte; nomes como `plan`/`todo` não provam que o CLI emite nem correlaciona a estrutura. |
| 19 | Design Mode chat reply | `measured` | O schema e `formatDmChatPrompt` são chamáveis, mas `✓` exige o runtime listar a ferramenta, o modelo chamá-la e o turno emitido pelo host chegar ao painel. Esse bind-and-land atravessa modelo/Bridge/UI e a própria definição exige dogfood vivo datado. |
| 20 | Auth status probe (pre-launch) | `measured` | Para os três, a matriz afirma comandos locais medidos em home autenticada e vazia que **não são consumidos** por `RUNTIME_AUTH_PREFLIGHT`. Não há decisão de produto a derivar; existência de credencial/exit code é explicitamente uma falsa aproximação. |
| 21 | Native login surface | `measured` | `RUNTIME_LOGIN` deriva comando e abre o `LoginRunner`, mas `surface`, necessidade de PTY/paste-back/device-code e ausência de saída em pipe são fatos do CLI. A linha exige versão e execução real da UI de login, não só uma entrada no registro. |
| 22 | Write confinement / discovery root | `cannot` — **Claude, Codex e Grok** | A subdimensão obrigatória discovery root não pode ser acoplada em nenhum dos três: cada CLI fixa descoberta de CWD até repo-root sem override portátil. A metade write-confinement também é apenas medida e parcial: Claude não cobre Edit/Write sob bypass, Codex deixa tmp gravável por default e Grok built-in avisa e continua se o sandbox falha; Tachyon não consome nenhuma. Um booleano derivado esconderia esses buracos. |

### Contagem e sinal do desenho

- `derivable`: **8/22** — linhas 1, 4, 6, 10, 11, 13, 14 e 17.
- `measured`: **12/22** — linhas 2, 3, 7, 8, 9, 12, 15, 16, 18, 19, 20 e 21.
- `cannot`: **2/22** — linha 5 para Codex; linha 22 para Claude, Codex e Grok na discovery root.

**Sinal contra o desenho: confirmado.** `measured` é 12 de 22 (54,5%), portanto mais da metade.
A tabela tipada ainda impede célula vazia e cobra versão/data, mas não pode tornar essas doze
alegações verificáveis por unitário. Se as fatias 4/5 não trouxerem dogfood reproduzível e lastro
renovável, o instrumento vira prosa TypeScript para a maioria das dimensões — exatamente o risco
nomeado em `plan.md` D5.

### Seam fora de escopo encontrado

`session-ownership hooks` da lista da linha 66 já virou `session-hooks` na fatia 1. Os demais seams
daquela lista não foram promovidos nem classificados aqui; pertencem à fatia 5.

## Fatia 5 — as costuras deixam de ser promessa sem prazo

Decisão tomada em **2026-08-15**, limitada a Claude, Codex e Grok.

### Critério de promoção

Uma costura merece dimensão quando expressa um resultado de produto estável e comparável entre
runtimes, cuja presença/ausência pode afetar o usuário ou a validade de uma evidência e pode divergir
sem que uma dimensão existente fique necessariamente vermelha. Ela continua fora quando é apenas a
estratégia nativa usada para cumprir uma dimensão existente, quando duplicaria exatamente a mesma
falha, ou quando é uma regra condicional cuja ausência significa “não se aplica” e não falta de
capacidade. Em ambos os casos a decisão recebe data; nenhum item volta a ser backlog sem relógio.

### Decisão por costura

| Costura | Decisão em 2026-08-15 | Veredito / motivo |
|---|---|---|
| Session ownership hooks | dimensão `session-hooks` (fatia 1) | Projeção Claude/Codex/Grok `wired`, derivada por `runtimeUsesSilentPersistenceHooks`; runtime Claude/Codex/Grok `unmeasured` até a fatia de medição registrar versão e data. |
| Session-id strategy (mint vs capture) | continua fora | É protocolo nativo por trás de Resume: Claude/Grok mintam, Codex captura. A capacidade comparável é reconstruir a conversa, já coberta pela linha 4; exigir mecanismo idêntico contrariaria o princípio da matriz. |
| Deterministic `transcriptPath` | continua fora | É um locator interno consumido por Resume/Activity. Se deixa de resolver, as linhas 4/8 falham; promovê-lo contaria o mesmo defeito duas vezes sem criar resultado novo para o usuário. |
| Model-label normalization | continua fora | Row 10 já inclui aliases de modelo usados pelos peers. IDs observados desconhecidos usam fallback aberto, validado e honesto; quantidade de aliases é política de apresentação, não uma capacidade autônoma. |
| Live/observed model provenance | dimensão `observed-model-provenance` | Projeção Claude/Codex/Grok `wired`, derivada pelo registry de normalizers usado pelo Activity; runtime dos três `unmeasured`. Isso é distinto do label declarado da row 10. |
| Probe effective-model proof | dimensão `probe-model-proof` | Projeção Claude/Codex/Grok `wired`, derivada de `reportsEffectiveModel` + `modelEvidence` no adapter registrado; runtime dos três `unmeasured`, preservando a futura distinção provider-usage/session-record. |
| Composer suggestion vs human draft | continua fora | É uma regra condicional de Attention: Claude/Codex renderizam suggestion SGR-dim e declaram `ansiEmptyContentStyle: all-dim`; Grok não renderiza suggestion, então não declarar a exceção protege drafts reais. Ausência em Grok não é lacuna. |
| Cross-runtime task continuation | dimensão `cross-runtime-task-continuation` | Projeção Claude/Codex/Grok `wired`, derivada de admissão como Agent + canal de brief; runtime dos três `unmeasured`. O mecanismo host-side continua distinto de native resume. |

As cinco dimensões hoje declaradas são, portanto: as duas da fatia 1 mais as três promovidas nesta
fatia. Nenhuma das quatro costuras mantidas fora permanece sem motivo ou sem a data de 2026-08-15.

## Fatia 3 — projeção e runtime deixam de disputar uma célula

Decisão do dono em **2026-08-15**: cada célula passa a carregar dois fatos independentes.
`projection` aceita somente `wired` (quando comparado com a porta real do produto) ou `cannot` com
motivo; `runtime` aceita `measured` com versão/data, `cannot` com motivo, ou `unmeasured` explícito.
`wired` é recusado no lado runtime, impedindo que ausência de medição se vista de sucesso.

A fatia 5 havia sido executada antes desta decisão. Seus documentos foram preservados, mas suas nove
células `wired` sem derivação não foram: as três novas dimensões agora derivam a projeção por portas
reais e declaram o runtime honestamente `unmeasured`. Assim a reordenação não transforma história em
tautologia.

### Provas de vermelho da célula dupla

Todas foram mutações temporárias na declaração/produto real, executadas com
`npx vitest run test/unit/runtimeParity.test.ts`, e restauradas em seguida:

- removido `runtime` de `session-hooks/grok` (cast inseguro apenas para deixar o mutante compilar):
  exit 1, `session-hooks/grok/runtime: missing parity fact`; a fixture permanente também remove
  `projection` e exige o diagnóstico irmão;
- trocada a projeção por `{ verdict: "cannot" }`: exit 1,
  `session-hooks/grok/projection: cannot requires a written reason`;
- trocado runtime por `{ verdict: "measured" }`: exit 1, exigindo `runtimeVersion` e
  `measuredAt as YYYY-MM-DD`;
- trocado runtime por `{ verdict: "wired" }`: exit 1,
  `must be measured, cannot, or explicitly unmeasured; wired is projection-only`;
- removido Grok de `runtimeUsesSilentPersistenceHooks`: exit 1,
  `session-hooks/grok: product=not-wired, declaration=wired`;
- removido o adapter Grok de `headlessProbeAdapters`: exit 1,
  `headless-probe/grok: product=not-wired, declaration=wired` (e a dimensão de prova de modelo
  também ficou vermelha, confirmando que ambas leem o mesmo registry de produção).

O teste focado voltou a verde depois da restauração. As três dimensões da fatia 5 não são “sim
trivial para três”: observed provenance lê o registry real do Activity; probe proof lê as flags de
prova/evidence do adapter registrado; task continuation combina admissão real de Agent e entrega de
brief. Cada uma pode divergir quando uma dessas portas muda.

## Fatia 4 — metade de runtime, 2026-08-15

`unmeasured` sem `needed` é recusado pelo validador (mesma natureza de `cannot` sem motivo).
Prova de vermelho, nova: `{ verdict: "unmeasured" }` em `session-hooks/grok/runtime` →
`session-hooks/grok/runtime: unmeasured requires needed`. A prova de `measured` sem versão/data
foi reexecutada no mesmo arquivo (`test/unit/runtimeParity.test.ts`) e continua vermelha.

Método: canário opaco no canal candidato; controle positivo e negativo declarados; binário
autenticado em `/home/goat/.{claude,codex,grok}` (o HOME isolado do agente não tem credencial);
versão e data em toda célula `measured`.

### Contagem

Sobre as 15 células do cartão (5×3):

| estado | células |
|---|---:|
| `measured` | **12** |
| `cannot` | **0** |
| `unmeasured` + `needed` | **3** |

Enquanto esta fatia media, `main` acrescentou `persistent-instructions-launch` (t-d3ace4): Claude
`cannot` (compact automático falhou), Codex e Grok `measured` 2026-08-15. A tabela passou a 18
células. Não é sinal contra o desenho das 15: a maioria tem lastro de binário. As 3 restantes
nomeiam o canal que faltou, não um backlog mudo.

### session-hooks

- **claude 2.1.233** `measured`. `+` `--settings` com Stop command `printf HOOK_CANARY_4VJ8P2 > file`;
  após `claude -p "Reply with the single word ok." --permission-mode dontAsk --no-chrome --no-session-persistence`
  o arquivo existia. `−` a mesma invocação sem `--settings`; o arquivo não existia.
- **grok 1.0.4** `measured`. `+` `$GROK_HOME/hooks/stop.json` (auth.json ligado ao home real) escreveu
  o canário após um `-p --output-format json` com `stopReason: end_turn`. `−` home equivalente sem
  `stop.json`; o canário não existia.
- **codex 0.147.0** `unmeasured`. `codex exec -c hooks.Stop=…` (read-only e workspace-write) completou
  o turno e **não** disparou Stop. O canal do produto é o TUI/`-c` no spawn, não `exec`.

### headless-probe

Adapter argv de produção, sessão autenticada.

- **claude 2.1.233** `measured`. `+` `--output-format json --safe-mode --no-session-persistence --tools "" --permission-mode plan`: envelope `type:"result"`, `reason=ok`, lastMessage `HP_CANARY_7KQ2M9`. `−` sem `--output-format json`: stdout é o token cru, `extractClaudeResult` = null.
- **grok 1.0.4** `measured`. `+` `-p --output-format json --no-memory --no-subagents --tools "" --permission-mode plan`: JSON com `text`, `reason=ok`, canário. `−` sem `--output-format json`: texto cru, sem objeto `{text}`.
- **codex 0.147.0** `measured`. `+` `codex exec --json --output-last-message …` com stdin fechado: `thread.started`, artifact `HP_CANARY_7KQ2M9`, `reason=ok`. `−` sem `--json`: texto cru, sem `thread.started`. (`execFile` sem stdin=ignore fica pendurado em "Reading additional input from stdin".)

### probe-model-proof

Mesmas corridas. Chave inventada `tachyonInventedModel_ZZ9` ausente em todos.

- **claude** `measured`. `modelUsage` keys: `claude-haiku-4-5-20251001`, `claude-opus-5[1m]` (evidence `provider-usage`).
- **grok** `measured`. `modelUsage` key: `grok-4.6-build` (evidence `provider-usage`).
- **codex** `measured`. rollout `turn_context.payload.model` = `gpt-5.6-sol` via `thread_id` (evidence `session-record`).

### observed-model-provenance

- **codex** `measured`. O rollout que o Activity lê é o mesmo arquivo de onde o adapter tirou
  `gpt-5.6-sol`; a chave inventada não aparece.
- **claude / grok** `unmeasured`. O JSON de probe prova `modelUsage` no stdout do headless, não o
  ficheiro que o normalizer de Activity lê numa sessão persistida.

### cross-runtime-task-continuation

`measured` nos três pela metade de runtime que existe: o canal de brief do destino. Evidência
`docs/research/t-a68138-system-prompt-compact.md`, mesma máquina, mesmas versões, 2026-08-15,
controles +/− (canário só pelo canal; sessão sem o canal devolve `ABSENT`; compact real). Não
mede o orquestrador host `continue_task` — isso é a metade de projeção, já `wired`.

## Fatia 6 — a prosa deixa de contradizer a tabela em silêncio

2026-08-15, `t-904b2a`. A `parity.md` não foi reescrita. Ganhou: ponteiro para
`packages/engine/src/runtime/parity.ts` como fonte verificável; as três naturezas
(célula / narrativa-com-motivo / leftover); uma tabela de atestação das 23 linhas
e das 4 dimensões tipadas que não são linha numerada.

### Inventário

- Célula tipada: `headless-probe` (row 13), `persistent-instructions-launch` (row 23),
  `session-hooks`, `observed-model-provenance`, `probe-model-proof`,
  `cross-runtime-task-continuation`.
- Narrativa com motivo da fatia 2: rows 1–12, 14–22 (16 linhas). Soul herda o motivo
  da row 1 (mesmo `runtimePromptAdapter`).
- Costuras fora da tabela: já tinham motivo e data na fatia 5.

### Desacordos prosa × tabela — a tabela NÃO foi tocada

1. **`observed-model-provenance`.** A prosa do seam ainda diz que o runtime dos três
   permanece `unmeasured`. A tabela tem Codex `measured` 0.147.0 / 2026-08-15; Claude e
   Grok `unmeasured` com `needed`.
2. **`cross-runtime-task-continuation`.** A prosa do seam ainda diz runtime
   `unmeasured`. A tabela tem os três `measured` 2026-08-15 (metade brief do destino).

Row 23 Claude `~` na matriz vs `cannot` na metade runtime da tabela **não** é
desacordo: a nota ᵖ já traduz `cannot` de compact automático no mark combinado `~`.

### Terceiro tipo (achado principal)

Afirmações sobre claude/codex/grok sem célula e sem motivo da fatia 2 — classificadas em
`t-f293c7`, 2026-08-15. **Nenhuma virou dimensão.**

| Afirmação | Classe | Critério exato (não "é difícil") |
|---|---|---|
| Native lane suppression (§3.1) | **não derivável** — permanece narrativa | A porta de produto `createFormationLifecycleHost` liga `verifyNativeSuppression: () => false` para todo adapter. `isNativeSuppressionConfirmed` vive em `test/helpers/nativeLaneSuppression.ts` e só o próprio teste a importa; ela lê um campo `evidence` escrito à mão, então derivá-la compararia o registro consigo mesmo (a tautologia da row 15). `packages/engine/src/runtime/nativeLaneSuppression.ts` não existe. Memory disable já é a row 15; o gate combinado é uma conjunção que o host não consulta. |
| Model preflight (§3.2) | **cannot** no Claude; **measured** em Codex/Grok | `ClaudeLaunchPreflight.check` nunca marca `supported` a partir de catálogo: o CLI não oferece comando de catálogo account-aware, e uma lista no Tachyon envelhece nos dois sentidos. `CodexLaunchPreflight` / `GrokLaunchPreflight` executam `codex debug models` / `grok models`; um unitário que stubasse `check()` provaria o stub. |
| Post-launch readiness (§3.2) | **measured** nos três | `GenericLaunchReadiness` / `CodexLaunchReadiness` classificam texto do pane contra `MODEL_REJECTED_RE`, que só cresce com frase capturada (`t-d501fc`). Fixture que casa o regex prova o leitor, não que o CLI de hoje ainda emite essas palavras (o mesmo motivo da row 16). |

Não há um booleano por runtime para promover. "Adapter registado" marcaria Claude como wired para um catálogo que ele não tem — o falso positivo que a fatia 1 recusou em permission inject. Duas dimensões novas cresceriam uma tabela já maioritariamente `measured` (D5). Motivo e data estão em `docs/runtimes/parity.md` leftovers.
