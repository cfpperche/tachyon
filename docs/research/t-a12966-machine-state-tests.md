# t-a12966 — quais tests afirmam sobre a MÁQUINA, e o que foi feito com cada um

Varredura medida em 2026-08-09 no worktree de agente `machinestate`.

## 1. Contagem, não estimativa

| Suíte | Arquivos | Tests |
| --- | ---: | ---: |
| `test/unit/` + `test/integration/` (o gate `npm test`) | 715 | 8118 |
| `test/browser/` (`npm run test:browser`) | 38 | 155 |
| **Total varrido** | **753** | **8273** |

Tests que dependiam de estado de máquina, por classe (detalhe caso a caso na seção 4):

| Classe de estado | Tests | Antes | Depois |
| --- | ---: | --- | --- |
| Credencial de runtime (claude/codex) como substrato | 54 | pulavam onde a máquina não tinha login | **injetado** — rodam sempre |
| Credencial de runtime (claude) travando o subject | 4 | **vermelho** em worktree de agente | **injetado** — rodam sempre |
| Declarados como claude, presos de fato ao opencode | 12 | pulavam pelo motivo ERRADO | reclassificados (§4) |
| Credencial + binário opencode (preflight EXECUTA o runtime) | 24 | pulavam declarando | pulam declarando |
| Binário de runtime instalado (codex/claude/grok) | 8 | 1 vermelho, 7 pulavam MUDOS | **declarado** — pulam dizendo o quê |
| Sessão systemd do usuário | 2 | **vermelho** sem user bus | **declarado** |
| Artefato de build tomado por estado de máquina | 3 | pulavam MUDOS **em todo gate** | **corrigido** — voltaram a rodar |
| Servidor tmux real | 14 | pulam (guard de coleção) | inalterado, documentado |
| git / sh / unzip / echo / fixture https | 139 | pulam (guard de coleção) | inalterado, documentado |
| Chrome do sistema (suíte de browser inteira) | 155 | falha alto e claro | inalterado, documentado |

## 2. Os dois laboratórios

Um agente não consegue apagar a máquina em que roda, então o estado foi removido em camadas e as duas
camadas foram medidas separadamente. Isso importa: o laboratório estrito acusa coisas que um worktree
de agente real NÃO sofre, e reportar as duas listas como uma só seria inflar o resultado.

- **LAB A (estrito)** — `env -i PATH=<node>,/usr/bin,/bin HOME=<tmp vazio>`: sem credencial, sem
  `$HOME` real, sem `CLAUDE_CONFIG_DIR`, sem `XDG_RUNTIME_DIR`, sem locale.
- **LAB B (fiel)** — `env -u CLAUDE_CONFIG_DIR HOME=<tmp vazio>` dentro do pane do agente: sem
  credencial, sem `$HOME` real, sem `.tachyon/` populado; binários instalados, servidor tmux vivo,
  relógio real, locale UTF-8. **É este o "worktree limpo sem estado de máquina" do critério de pronto.**

Medições:

| Execução | Resultado |
| --- | --- |
| LAB A, antes | 9 falhas em 5 arquivos |
| LAB B, antes | 4 falhas em 1 arquivo (`crashRestartMemory`), 98 pulados |
| LAB B, depois | **0 falhas, 8118 tests em 715 arquivos, 41 pulados — 0 deles sem motivo declarado** (eram 98 pulados, dos quais 8 mudos) |
| `test/browser` LAB B | 154 passaram, 1 falha = flake de contenção conhecido (§6) |

O critério de pronto foi PROVADO, não afirmado: `npm run verify:full:quiet` no LAB B, sobre a árvore
entregue (já com o `main` integrado), sem nenhum estado preparado à mão —

```
$ env -u CLAUDE_CONFIG_DIR HOME=$(mktemp -d) npm run verify:full:quiet
verify:full:quiet passed
Files: 716 passed (716)
Tests: 8085 passed | 41 skipped (8126)
Coverage unavailable (native test skips):
- 1: no grok credential at <HOME>/.grok/auth.json (recover with `grok login`)
- 36: optional opencode credential unavailable
- 4: PROBE_LIVE_SMOKE=1 not set (a real model call costs money)
155 browser tests (2 changes under 22 browser-suite roots)
```

Três coisas para ler aí: nenhuma linha `Skipped with NO declared reason` (§5) — todo pulo diz o que
faltou; a suíte de browser rodou nessa mesma execução, verde, porque o merge do `main` tocou
`src/webview/`; e os 41 pulos são só as três dependências que uma fixture não consegue fornecer.
(O total sobe de 8118 para 8126 e de 715 para 716 arquivos por causa do `main` integrado ao final —
a varredura por classe acima foi medida antes desse merge.)

## 3. A reprodução exata do caso que abriu a task

O agente `adescan` recebeu quatro vermelhos em `crashRestartMemory.test.ts` tendo escrito só markdown.
No LAB A a falha reproduz idêntica:

```
HarnessUnavailableError: isolated harness for 'worker': no credentials at <HOME>/.claude/.credentials.json
  — run claude /login first (a redirected config home starts logged out)
  ❯ HarnessManager.materializeHome → AgentManager.spawnCore
```

Causa: a fixture declara um Saved Agent no runtime `claude`; ao spawnar, o `Workspace` materializa o
harness isolado, e o materializador **recusa** sem uma credencial real para linkar. O `Workspace`
resolve a origem com `realConfigHome()`, que lê `process.env.CLAUDE_CONFIG_DIR` e cai em `~/.claude`.
No pane de um agente essa variável aponta para `.tachyon/harness/<agente>` — um home privado que pode
não ter `.credentials.json`. Daí o eixo espelhado da t-3ab4b6: **verde no primário, vermelho no
worktree**, com o test respondendo "esta máquina está logada?" em vez de "um crash custa a memória do
agente?".

Nada ali lança um claude real: o canal tmux é fake-exec e a asserção lê a linha de comando. Logo a
credencial é **cenário**, e o veredito é injetar.

## 4. Veredito caso a caso

`injeta` = o estado só monta cenário, entra por uma porta que produção lê.
`declara-e-pula` = o valor do test É o real; pula dizendo qual dependência faltou.
`inalterado` = medido, classificado, deixado como está — com o motivo.

| Arquivo | Tests no arquivo | Dependentes de máquina | Dependência | Veredito | Motivo |
| --- | ---: | ---: | --- | --- | --- |
| `test/unit/crashRestartMemory.test.ts` | 5 | 4 | credencial claude | **injeta** | tmux é fake-exec e a asserção lê a linha de comando; a credencial só destrava o materializador. 4 vermelhos → 5 verdes no LAB A. |
| `test/unit/workspaceHeadless.test.ts` | 120 | 31 | credencial claude+codex | **injeta** | mesma substância: harness materializado de verdade, runtime nenhum executado. As 31 saíram de "pendentes" para verdes no LAB B. |
| `test/unit/workspaceHeadless.test.ts` | 120 | 3 | binário opencode | **declara-e-pula** | o preflight do opencode roda `opencode providers list`: arquivo de credencial não substitui o binário. |
| `test/unit/continuityWiring.test.ts` | 19 | 19 | credencial claude+codex | **injeta** | idem. |
| `test/unit/humanDraftHoldsNotice.test.ts` | 14 | 12 | credencial claude **e** binário opencode | **injeta claude + declara opencode** | **classificação estava errada**: a lista declarava `claude`, mas quem trava é o filho `cmd: opencode`. Numa máquina com claude e sem opencode isso ia a VERMELHO, não a pendente. |
| `test/unit/notifyDoorbellDelivery.test.ts` | 9 | 9 | binário opencode | **inalterado (declara)** | já declarado e correto. |
| `test/unit/resumeTokenProof.test.ts` | 2 | 2 | credencial claude | **injeta** | substrato. |
| `test/unit/savedAgentBypassConsent.test.ts` | 1 | 1 | credencial claude | **injeta** | substrato. |
| `test/unit/engineService.test.ts` | 1 | 1 | credencial codex | **injeta** | substrato. (O flake de carga deste arquivo é da t-6d3667 e não foi tocado.) |
| `agentManager`, `cxNoticeBehavior.gen`, `cxPermBehavior.gen`, `ocGhostQBehavior.gen`, `ocEnvCfgBehavior.gen`, `workspaceSurfaceLifecycle` | — | 12 | binário opencode | **inalterado (declara)** | mesma razão do opencode acima. |
| `test/unit/harnessCodexDogfood.test.ts` | 1 | 1 | binário codex | **declara-e-pula** | o valor É o codex real lendo o harness (spec 311). Sem codex era `ENOENT` vermelho; agora pula dizendo `codex CLI not installed`. Este é o CASO 2 do enunciado. |
| `test/unit/probeSmoke.test.ts` | 7 | 6 | binários claude/codex/grok + opt-in `PROBE_LIVE_SMOKE` | **declara-e-pula** | já pulava, mas MUDO (`describe.skipIf`): 6 pendentes sem motivo. Agora cada um diz qual binário faltou, ou que a chamada paga está desligada. |
| `test/unit/devHostLauncher.test.ts` | 16 | 2 | systemd do usuário | **declara-e-pula** | os outros 8 casos injetam `runSystemctl`; estes dois rodam o `cli.sh clean` de verdade. Sem user bus iam a vermelho falando de D-Bus. |
| `test/integration/sessionContinuationGrokDogfood.test.ts` | 1 | 1 | binário+credencial grok, tmux | **declara-e-pula** | pulava mudo; agora o motivo viaja no resultado. O `beforeAll` (que spawna grok real) foi guardado pelo MESMO predicado, resolvido uma vez, para os dois guards não divergirem. |
| `test/unit/webviewAppBudget.test.ts` | 5 | 3 | **artefato de build, e o probe estava podre** | **corrige** | gateava três guardas de budget da SDD 485 em `dist/webview/cockpit.js`, arquivo que a t-5a0c1c apagou: pulavam **em todo gate, numa árvore buildada**, sem dizer nada. Probe agora deriva do manifesto `WEBVIEW_APPS`. As 3 voltaram a rodar e passam. |
| `test/unit/tmux.real.test.ts` | 14 | 14 | binário + servidor tmux (+ **locale**) | **inalterado (declara na coleção)** | ver §6: converter exigiria guardar seis hooks que EXECUTAM tmux, criando um segundo guard capaz de divergir do primeiro. Zero pulos medidos nos dois laboratórios. **Mas ele encontrou um defeito de produto** (t-86f3e6). |
| `pluginGitHook*` (4), `pluginGitRepo`, `pluginEngine`, `pluginFetcher`, `i18nPtbrGate`, `verifyRecord`, `verifyTrunkAudit`, `vsixArtifactAudit`, `pluginTool*`, `pluginData*` | — | 139 em 27 guards | `git` / `sh` / `unzip` / `echo` / fixture https | **inalterado** | mesma forma do tmux: guard de coleção com hooks que executam a dependência. Nenhum deles pulou em nenhum dos dois laboratórios (todas as ferramentas presentes). O risco residual — pular mudo numa máquina sem git — passa a ser VISÍVEL pela linha nova do gate (§5), sem tocar 27 arquivos. |
| `test/unit/enginePackaging.test.ts`, `test/integration/plugin-ui.e2e.test.ts`, `test/unit/pluginDataShim.test.ts` | 4+4+2 | 0 | `dist/` buildado | **inalterado** | NÃO é estado de máquina: `verify:full` builda antes da suíte, então no gate eles sempre rodam. Só ficam vermelhos/pendentes num `npx vitest` cru sem build. |
| `test/browser/**` | 155 | 155 | Chrome do sistema | **inalterado (falha alto)** | a suíte inteira existe para olhar UI renderizada; pular em silêncio seria exatamente a cobertura fantasma que esta task proíbe. A mensagem já nomeia a dependência e o remédio (`PUPPETEER_EXECUTABLE_PATH`). O gate só roda essa suíte quando o diff toca as raízes dela. |

## 5. O pulo ficou observável na saída do gate

Antes, `scripts/verify-full.mjs` só sabia imprimir motivo para UMA família de pulos (credencial
opcional, t-eccb00). Todo o resto aparecia como um número: `Tests: … | 20 skipped`.

Duas mudanças, ambas advisory — nenhuma pode transformar verde em vermelho:

1. `summarizeUnavailableCoverage` passou a ler também o motivo genérico
   (`task.meta.machineDependencyUnavailable`), que `test/helpers/machineDependency.ts` escreve via
   `context.skip(reason)`. Um pulo declarado agora chega ao resumo com o texto que o autor escreveu.
2. `summarizeUndeclaredSkips` (novo) conta os pulos que **não** declararam nada e nomeia os arquivos:

```
Skipped with NO declared reason (3 test(s) — coverage that did not run):
- 3: test/unit/webviewAppBudget.test.ts
```

Foi exatamente essa linha que teria acusado o `cockpit.js` podre no dia em que ele apodreceu. Depois
das correções, o LAB B fecha com **0 pulos sem motivo declarado**.

## 6. Achados que não são desta task (viraram Task)

- **t-86f3e6 — locale não-UTF-8 quebra a leitura de panes do `TmuxService`.** Sonda direta: com
  `LANG` vazio, `C` ou `POSIX`, o tmux troca o TAB por `_` na saída de `-F`; com `C.UTF-8` ou
  `en_US.UTF-8` o TAB sobrevive. `TmuxService` faz `split("\t")` em dois lugares (`sessionStates`,
  `serverSnapshot`), então nesse locale o produto devolve `dead:false, pid:0` para todo pane — pane
  morto nunca detectado, `restart: on-crash` nunca dispara, e nada avisa. Os 3 vermelhos do
  `tmux.real` no LAB A eram isso. **O test não foi silenciado de propósito**: ele é hoje o único
  sinal desse defeito, e um skip declarado o esconderia.
- **t-205b05 — o flake de contenção do `pinPreviewImageRender` voltou.** Falha na suíte de browser
  cheia, passa sozinho em 445ms no mesmo ambiente. A t-1c745f já tinha diagnosticado a corrida e
  mitigado com um laço de 15s; é o laço que estourou.
- O flake de carga do `engineService.test.ts` continua com dono (t-6d3667) e não foi perseguido.

## 7. Como reproduzir

```bash
# o laboratório fiel: worktree limpo, nenhum estado de máquina preparado à mão
LB=$(mktemp -d)
env -u CLAUDE_CONFIG_DIR HOME=$LB npm run verify:full:quiet
env -u CLAUDE_CONFIG_DIR HOME=$LB npm run test:browser

# o laboratório estrito (também derruba locale e systemd — leia a §2 antes de acusar um vermelho)
env -i PATH=$(dirname $(which node)):/usr/bin:/bin HOME=$(mktemp -d) npx vitest run
```
