# Inventário: onde runtime e provedor estão fundidos no produto

`t-862ccc`, etapa única. Decisão que este número decide: o dono quer separar runtime de provedor no
Runtime Ops — **refatoração completa ou N pontos cirúrgicos**. Este documento não muda código; mede.

Método: varredura multi-ângulo (comandos no fim) → candidatos → **cada sítio confirmado por
leitura de fonte no ponto de uso**, nunca por busca de texto. A unidade é a FAMÍLIA, não o arquivo.

Contagem mecânica: **33 sítios em 7 famílias**. Duas famílias quebram HOJE (uma já medida e
parcialmente mitigada); cinco são honestas-declaradas, cosméticas ou só-na-teoria.

## As famílias

### F1. O universo de provedor É a lista de runtimes — a raiz tipada

| Sítio | O que faz |
|---|---|
| `packages/engine/src/runtimeObservability/types.ts:3` | `RuntimeObservationProviderV1 = "codex" \| "claude" \| "grok"` — ids de runtime como ids de provedor |
| `packages/engine/src/runtimeObservability/preferences.ts:10` | `PROVIDERS` — a mesma tríade; grants de observação indexados por ela |
| `packages/engine/src/runtimeOps/types.ts:146` | `RUNTIME_OPS_PROVIDERS_V2` — a mesma tríade no contrato do painel |
| `packages/engine/src/runtimeOps/providerProjection.ts:42-52` | itera a tríade para projetar a capacidade |
| `packages/engine/src/runtimeOps/runtimeCondition.ts:217-234` | o conjunto de runtimes do relatório = união de registros de RUNTIME + chaves de canais; `byProvider.get(runtime)` casa runtime↔provedor direto |
| `packages/engine/src/engine-service/stateMigration.ts:525-539` | migra `accountScopeKey`/`sources` por essa mesma tríade |

**Quebra hoje:** um quarto provedor (Z.ai) não tem slot no enum — não pode ser nomeado em preferência,
escopo, fato ou envelope. Toda família abaixo herda esta impossibilidade. **Só na teoria:** nada
quebra para os três runtimes em endpoint da vendor.

### F2. Escopo de conta ÚNICO por runtime — arquivo e leitura

| Sítio | O que faz |
|---|---|
| `packages/engine/src/runtimeObservability/claudeStatusLineCapture.ts:87-89` | `materialize()` lê `preferences.get("claude")` LITERAL: TODO spawn claude-adapter ganha relay+captura no escopo da conta preferida do "claude" |
| `claudeStatusLineCapture.ts:128-131` | o marcador `capture-enabled.json` carrega UM `accountScopeKey` para o diretório inteiro (medido: `ps_6598b7a9…`, a conta Anthropic) |
| `claudeStatusLineCapture.ts:143-178` | `readCapture` varre o escopo e fica com o capture **mais novo com `rate_limits`**, sem perguntar qual sessão/backend o produziu; recusa se o marcador ≠ escopo da preferência (linha 148) |
| `claudeStatusLineSource.ts:82` | `provider = "claude"` — o fato é publicado como conta do provedor "claude" |
| `claudeStatusLineSource.ts:331-346` (`projectStatusLineCapture`) | `rate_limits` ausente/nulo → `not-observed`; presente → quota da "conta" |
| `packages/engine/src/runtimeObservability/service.ts:89` | mapa de fontes indexado por `source.provider` (runtime id) |

**Quebra hoje (medido em `t-1e9a07`/`t-78f461`):** (a) a sessão Z.ai é arquivada dentro do escopo
da conta Anthropic que ela não consome — o capturado vaza para o lado do arquivo; (b) o eixo de quota
do runtime é "a sessão claude-adapter que mais recentemente renderizou `rate_limits` neste host" —
com a sessão do dono viva, o número é da conta Anthropic; sem ela, o capture vazio da sessão Z.ai
dá `not-observed` e o EIXO INVERTE de significado conforme quem renderizou por último. O `t-78f461`
fechou a atribuição na PORTA (runtime_condition para o runtime próprio do chamador); o modelo de
dados por trás continua fundido. **Só na teoria:** duas contas Anthropic no mesmo host colidiriam no
mesmo escopo único.

### F3. Atribuição por runtime nas portas de leitura

| Sítio | O que faz |
|---|---|
| `packages/bridge/src/tools/fleet.ts` (runtime_condition) | pós-`t-78f461`: recusa por nome para o runtime PRÓPRIO do chamador; o eixo CANAL continua dizendo "claude tem canal" (verdade da conta, não do chamador); outros runtimes mantêm os números (delegação) |
| `packages/engine/src/workspace/RuntimeSlackMonitor.ts:88-129,175-177` | campainha de slack chaveada por runtime: "Delegation to 'claude' is no longer quota-blocked" — um coordenador que delegar a um filho de runtime emprestado julga a cota pela conta Anthropic |
| `packages/webview-ui/src/webview/runtime-ops/App.tsx:546-552` | cartões de provedor rotulados "Claude"/"Codex"/"Grok" — nome de runtime como rótulo de provedor |
| `App.tsx:112-119` | o painel DECLARA "Account-wide quota… not attributed to a runtime, workspace, or agent" — honesto; o rótulo é que funde |
| `packages/engine/src/runtimeOps/model.ts:136-207` + `types.ts:128-143` | agentes aninhados sob `RuntimeOpsRuntimeV1`; nenhum campo de provedor — implícito |

**Quebra hoje:** nenhuma porta além da já consertada entrega número a agente. **Vira real quando:**
um coordenador delegar a filho de runtime emprestado guiado pela campainha de slack — o monitor
acorda agentes **sem pai** (`RuntimeSlackMonitor.coordinators()`, `!entry.parent`), então glm (que
tem pai) nunca a recebe; o risco é o coordenador ler "claude tem folga" como folga de QUALQUER
filho claude-adapter. **Feio, não quebrado:** rótulo "Claude" para a conta.

### F4. Rótulos e aliases de modelo por runtime

| Sítio | O que faz |
|---|---|
| `packages/shared/src/runtime/runtimeProfile.ts:235-252` | `defaultModel: "Claude default"`, `source: declared, verified: false` — a nota do próprio código admite o fallback |
| `runtimeProfile.ts:240-248,353,492,542` | tabelas de aliases só conhecem claude/codex/grok/hermes |
| `runtimeProfile.ts:600-613` | `titleModelId` caixa título genérico — por isso "Glm 5.3" em vez de "GLM 5.3" |
| `packages/engine/src/sidebar/agentModel.ts:114-117,170-173,215-231` | `labelModel(runtime, id)` — aliases e precedência observed>declared>profile (spec 378; o latch salvou o caso GLM) |
| `packages/engine/src/runtimeOps/types.ts:38-53` | `RuntimeOpsModelLabel` — união FECHADA de rótulos claude/codex/grok |
| `packages/engine/src/runtimeOps/model.ts:297-320` | `normalizeModelLabel` casa a união fechada — a coluna declarada do Runtime Ops não CONSEGUE dizer GLM (cai em unavailable); a observada mostra o id cru |

**Quebra hoje (medido):** cosmeticamente — "Glm 5.3" (casamento de caixa) na sidebar; "Claude
default" na coluna declarada do painel para um agente GLM (fallback declarado, sem número errado).
Nenhum estado falso de MODELO é exibido desde o latch da spec 378. **Feio, não quebrado.**

### F5. O campo `runtime.provider` do perfil: existe, só o codex materializa

| Sítio | O que faz |
|---|---|
| `packages/engine/src/config/agentProfileSchema.ts:102` | `provider: boundedText(512).optional()` — campo vivo no schema |
| `packages/engine/src/config/claudeNativeConfigProjection.ts:192-194` | RECUSA: "Claude provider has no measured canonical materialization" |
| `packages/engine/src/config/grokNativeConfigProjection.ts:264-266` | RECUSA: o mesmo para grok |
| `packages/engine/src/harness/HarnessManager.ts:2692` | codex: `["model_provider", selectors.provider]` — a ÚNICA escrita viva |
| `packages/shared/src/config/agentProfileStudio.ts:149,161` | Agent Studio edita o campo |
| `packages/engine/src/config/agentProfileResolver.ts:136,313` + `agentNativeConfigPolicy.ts:320` | campos resolvidos e projetados |

**Quebra hoje:** nenhuma — as recusas são declaradas e honestas. **Feio e perigoso por vocábulo:**
o `provider` do perfil significa ROTEAMENTO de modelo (codex `model_provider`), enquanto o
`provider` da observabilidade significa CONTA — a mesma palavra com dois conceitos; `t-7c8898`
chamaria isso de família a não crescer.

### F6. A derivação do `t-78f461` (deste autor)

| Sítio | O que faz |
|---|---|
| `packages/engine/src/runtimeOps/runtimeCondition.ts` (`callerProviderOfEnvironment`) | deriva provedor do chamador pelo `ANTHROPIC_BASE_URL`; **claude-only** — runtime emprestado de codex/grok não tem derivação medida |

**Quebra hoje:** nenhuma além da própria limitação documentada. Listada por honestidade: o conserto
da atribuição cobre o único caso emprestado medido.

### F7. Classificações que assumem a vendor

| Sítio | O que faz |
|---|---|
| `claudeStatusLineSource.ts:312-322` | `classifyAuthStatus` lê `claude auth status --json` (`loggedIn`) — sem medição do que isso responde contra endpoint Z.ai |
| `packages/shared/src/attention/patterns.ts:92` + `runtimeOps/model.ts:276-285` | throttle lido do TEXTO do painel (`parseRateLimitInfo`) e normalizado como `claude\|codex\|opencode` — texto de throttle da Z.ai pode não casar padrão |

**Só na teoria** (nada medido): nenhuma destas portas foi exercitada contra backend emprestado.

## Quebrado hoje × feio × teoria — as listas separadas

- **QUEBRADO hoje:** F2 inteira (arquivamento e leitura por escopo único — medido) e, dentro de F3,
  o que o `t-78f461` já fechou na porta da tool; a campainha de slack é o único sítio F3 que pode
  entregar número a agente e segue aberto (vira real só com delegação a filho emprestado).
- **FEIO, não quebrado:** rótulo "Claude" como provedor no painel (F3), "Glm 5.3"/"Claude default"
  (F4), vocábulo duplo de `provider` (F5), enum-tríade como universo (F1 — feio ENQUANTO não há
  quarto provedor a nomear).
- **SÓ NA TEORIA:** duas contas Anthropic num host (F2), throttle/auth da Z.ai (F7), runtime
  emprestado de codex/grok (F6).

## Recomendação de escopo, com a conta na mão

33 sítios, 7 famílias; **2 famílias carregam a quebra de hoje**, e uma delas já tem a porta
consertada (`t-78f461`). Refatoração completa — provedor como entidade de primeira classe,
escopos por provedor, registro de provedores — reescreve as 7 famílias para consertar 2, e a raiz
tipada (F1) multiplica o custo por cada envelope, fato, preferência e migração que a atravessa.
É o `t-7c8898` de novo: a contagem vira decisão.

**Recomendado: 3 pontos cirúrgicos + 1 alargamento de tipo mínimo, na ordem:**

1. **F2/arquivo** — cunhar o escopo de captura POR PROVEDOR no `materialize()`: o mesmo sinal do
   `t-78f461` (`ANTHROPIC_BASE_URL` do lançamento) decide se a sessão arquiva no escopo da conta
   preferida ou num escopo próprio do provedor estrangeiro. Mata o vazamento na ORIGEM; a leitura
   "mais novo válido" passa a ser intra-escopo por construção. Depende do (4).
2. **F3/slack** — uma linha: nomear a CONTA na campainha ("the provider account backing 'claude'
   has slack") para que a frase não seja lida como capacidade de qualquer filho claude-adapter.
3. **F4/aliases** — trivial: aliases `glm-5.3`/`glm-4.7` (ou siglas maiúsculas no `titleModelId`).
4. **F1 mínimo** — onde a tríade é só LISTA DE RÓTULOS (preferências e escopo de captura), aceitar
   chave string com validação `SAFE_*` em vez de enum fechado; o enum permanece como o conjunto
   CONHECIDO, não como o conjunto POSSÍVEL. Onde a tríade é contrato de painel (V2), fica como está
   até existir quarta conta a exibir.

**Não abrir agora:** F5 (as recusas declaradas são o estado honesto; mudar o vocábulo é decisão de
dono, não defeito), F7 (medir `claude auth status` e throttle contra a Z.ai ANTES de tocar), e a
união fechada `RuntimeOpsModelLabel` (a coluna declarada é declared-only por especificação — a
observada já mostra o id cru).

## Comandos de varredura executados

```sh
grep -rn 'RuntimeObservationProviderV1|ProviderObservationProvider' packages/engine/src/runtimeObservability/types.ts
grep -rn 'provider = "|provider: "' packages/engine/src/runtimeObservability/*.ts
grep -rn 'accountScopeKey|ps_' packages/engine/src apps/vscode-extension/src --include='*.ts' -l
grep -rn 'modelLabelForRuntime|defaultModel' packages apps --include='*.ts' --include='*.tsx'
grep -rn 'runtime\.provider|model_provider' packages apps --include='*.ts'
grep -rn 'claude-status-line|capture-wrapper|statusLine' packages/engine/src --include='*.ts' -l
grep -n 'describeChannels|ProviderObservationSource' packages/engine/src/runtimeObservability/service.ts
grep -rn 'Delegation to|ThrottleRuntime' packages/engine/src/workspace/RuntimeSlackMonitor.ts
grep -rn 'provider' packages/webview-ui/src/webview/runtime-ops/App.tsx
grep -rn 'rateLimit' packages/shared/src/attention/*.ts packages/engine/src/attention/*.ts
grep -n 'Provider' packages/engine/src/runtimeObservability/types.ts
```

Cada candidato da varredura foi aberto e lido no ponto de uso antes de entrar numa família.

## Onde eu não procurei / não medi

- Não medi `claude auth status --json` contra o endpoint Z.ai (F7 permanece teoria).
- Não medi texto de throttle da Z.ai em painel real.
- Não inspecionei o Agent Studio RENDERIZADO — só sua fonte (`agentProfileStudio.ts`); o cartão
  diz o que cada tela declara, e a declaração do Studio está na lida de fonte, não em tela.
- Não varri `scripts/dogfood` sítio a sítio: os dogfoods espelham o produto e não criam fusão
  própria; um (`runtimeopsapp`) exercita o painel e foi coberto pela leitura da projeção.
- Runtime emprestado de codex/grok não existe nesta máquina — F6 declara a lacuna em vez de assumir.
