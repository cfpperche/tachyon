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
