# 514 — user-apps-zip-install — notes

_Created 2026-08-21._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Revisão adversarial — t-535eaa

_Medida em 2026-08-21 sobre `8d9d09cab7f5a72b5c082ab5feb405e3571c81d9`._

### Veredito global

**Precisa de correção pontual antes de virar código.** A tese de produto resiste: são mesmo zero declarações `views` nos 17 plugins externos e há só um consumidor instalado, o Terrarium. A separação “plugin não desenha / app local desenha” também é coerente. O contrato e o plano, porém, não fecham o caminho executável: a identidade existente do host não satisfaz acesso universal às ferramentas do Bridge, não há protocolo completo para instalar e projetar apps no launcher, a rota rejeita os novos IDs, a persistência recusa `app:<id>` e a lista de remoção deixa consumidores relevantes de `views` para trás.

### Achados

#### 1. O critério de acesso universal ao Bridge é falso com a identidade que já existe

**ACHADO —** O caller que o host consegue obter hoje é `external`. Ele pode chamar ferramentas caller-neutras, inclusive `list_agents`, e não sofre o escopo de lifecycle dos agentes; isso não equivale a “nenhuma ferramenta é negada”. Há ferramentas que exigem `caller.kind === "agent"`, ferramentas que precisam resolver um nome de agente e uma host action que nega explicitamente callers externos.

**MEDIDA —** `packages/bridge/src/callerIdentity.ts:318-320` resolve o token externo como `{ kind: "external" }`; `packages/bridge/src/tools/shared.ts:485-498` aplica `lifecycleScopeGuard` apenas a agentes, coerente com `packages/bridge/src/lifecycleScope.ts:17-21`. Em contraste, há 11 guardas explícitos `caller.kind !== "agent" || !caller.name` em `human-approvals.ts`, `tasks.ts` e `fleet.ts`; `packages/engine/src/host-action/policy.ts:58-71` nega `run_host_action` para caller não agente; e `test/unit/auth.test.ts:284-303` confirma que o token externo lista ferramentas, mas não pode reivindicar identidade de agente. Os quatro arquivos de teste focados passaram, incluindo o caso em que um token externo encerra um agente arbitrário.

**QUEBRA —** Falha o cenário de aceitação “nenhuma ferramenta do Bridge é negada a um app por allowlist, categoria ou escopo”. O exemplo `list_agents` passa, mas não prova o quantificador universal do critério.

**TAMANHO —** A spec muda: ou limita o critério às ferramentas compatíveis com `external`, ou registra deliberadamente uma mudança de semântica de identidade. O plano muda conforme essa decisão; não basta implementar um relay.

#### 2. Falta o caminho host–daemon–webview que torna instalação e catálogo dinâmico possíveis

**ACHADO —** T8 edita a tela, mas não define a mensagem de upload, o seletor de arquivo, o staging do zip nem a operação do daemon. T9 manda concatenar linhas do catálogo dentro do bundle do webview, que não lê `.tachyon/apps` e hoje não recebe apps do host.

**MEDIDA —** `packages/webview-ui/src/webview/plugins/messages.ts:102-105`, `main.tsx:96-123` e `apps/vscode-extension/src/webview/PluginsPanel.ts:84-115,324-390` têm somente as ações de plugin. `WorkspaceClient` já oferece `stagePayload`, mas `packages/engine/src/runtime-api/extensionOperations.ts` e `packages/engine/src/engine-service/extensionOperationService.ts` não têm operação de app. No launcher, `packages/webview-ui/src/webview/sidebar/sectionNav.ts:67-95` constrói `LAUNCHER_ORDER` e `CONTROL_SECTION_NAV` estaticamente; `sidebar/messages.ts:24-65`, `SidebarPrototype.ts:223-226` e `sidebar/main.tsx:54-68` não transportam catálogo de apps. Nenhum desses contratos aparece em “Files touched”.

**QUEBRA —** O usuário não consegue selecionar e instalar o zip; mesmo que arquivos fossem criados por outro meio, o app não aparece automaticamente no launcher e um app quebrado não pode ser omitido a partir do catálogo real do workspace.

**TAMANHO —** O plano muda: precisa explicitar a operação de instalação e a projeção do catálogo pelo engine/host até as duas webviews, incluindo atualização após instalar ou remover. A spec não precisa mudar neste ponto.

#### 3. O clique em `app:<id>` cai no System, não em um painel de app

**ACHADO —** A grade envia todo ladrilho pelo evento `openControl`, mas o host só aceita IDs presentes no conjunto fixo `COCKPIT_SECTION_IDS`. Alargar apenas a união TypeScript para ``app:${string}`` não altera esse conjunto em runtime.

**MEDIDA —** `packages/webview-ui/src/webview/sidebar/App.tsx:2086` envia o clique; `apps/vscode-extension/src/webview/SidebarPrototype.ts:316-323` chama `isSectionId` e, quando ele falha, executa o fallback sem seção; `apps/vscode-extension/src/sections/resolveSection.ts:5-17` deriva a validação de `COCKPIT_SECTION_IDS`; `apps/vscode-extension/src/extension.ts:3548-3636` termina no System quando não resolve uma seção conhecida.

**QUEBRA —** Falham os cenários “clicar no app abre o painel”, “clicar de novo revela o mesmo painel” e “dois workspaces não compartilham instância”, antes mesmo de `SectionPanelManager` receber o pedido.

**TAMANHO —** O plano muda: precisa nomear a porta de roteamento dinâmica e a integração que entrega o app resolvido ao gerenciador de painel. A spec não precisa mudar.

#### 4. O ID escolhido para apps não passa pelo validador da ordem persistida

**ACHADO —** O plano escolhe `app:<id>`, mas o formato persistido do launcher aceita apenas `/^[a-z][a-z0-9-]*$/`; dois-pontos são inválidos.

**MEDIDA —** A decisão está em `plan.md:21`. `packages/webview-ui/src/sidebar/launcherOrder.ts:22-38` rejeita qualquer ordem customizada com token fora desse regex; `apps/vscode-extension/src/webview/SidebarPrototype.ts:267-284` aplica o guard no host. A UI faz update otimista em `packages/webview-ui/src/webview/sidebar/App.tsx:1674-1677`, então a ordem pode parecer correta na sessão e ainda assim não ser salva.

**QUEBRA —** Falha a aceitação de reordenar apps por drag/teclado e gravar a ordem; após recarregar, a preferência se perde. O comportamento após desinstalar também não chega a operar sobre uma preferência válida.

**TAMANHO —** O plano muda: precisa compatibilizar o namespace escolhido com o formato persistido e cobrir o round-trip em teste. A spec não precisa mudar.

#### 5. A remoção de `views` não está fechada pela lista de arquivos e pelos testes propostos

**ACHADO —** A lista trata declaração, broker, relay e srcdoc, mas omite consumidores de `views` na instalação, no lockfile, na UI/consentimento e nas contribuições do VS Code. Remover apenas o tipo do manifest quebra o build; mantê-los deixa a antiga tela de plugin parcialmente viva.

**MEDIDA —** Além de `packages/engine/src/plugins/manifest.ts:189-213,946-1008`, há uso em `apps/vscode-extension/src/plugins/engine.ts:381,449,480,1117`, target `kind: "view"` em `packages/engine/src/plugins/lockfile.ts:23-25,428,442,530`, leitura em `apps/vscode-extension/src/plugins/ui/host.ts:335-366`, consentimento/abertura em `apps/vscode-extension/src/webview/PluginsPanel.ts:365-380,694-716`, modelos de consentimento no host e webview, e contribuições `openPluginSurface`/`tachyonPluginSurfaces` em `apps/vscode-extension/package.json:325-327,459-463` com wiring em `extension.ts:1678-1693,3418,4000`. R4 cita só dois arquivos de teste.

**QUEBRA —** Não se demonstra o requisito de que plugin perde a capacidade de desenhar tela nem a remoção completa da 349; a implementação pode parar em erro de compilação ou deixar superfície morta e target de lockfile aceito.

**TAMANHO —** O plano muda: “Files touched”, a sequência de remoção e a cobertura de regressão precisam incluir todos os consumidores do contrato. A spec não precisa mudar.

#### 6. R2 continua sendo uma decisão delegada apesar de a spec declarar zero perguntas abertas

**ACHADO —** O plano deixa ao owner decidir a regra de contenção de caminhos do zip e T3 manda “aplicar a decisão”, mas a decisão não foi registrada.

**MEDIDA —** `plan.md:78-80` apresenta alternativas sem escolher; `tasks.md:13` depende da escolha; `spec.md:116-127` declara “Nenhuma” pergunta aberta.

**QUEBRA —** T3 não é uma instrução determinística: duas implementações compatíveis com o plano podem aceitar entradas diferentes para o mesmo zip.

**TAMANHO —** O plano muda: registre a escolha antes da implementação. Se a escolha alterar o comportamento observável já prometido, a spec também muda; caso contrário, não.

### Resposta a R1

O host **não tem hoje um método genérico de produção para chamar qualquer ferramenta do Bridge**. `apps/vscode-extension/src/shell/WorkspaceClient.ts:67-91` expõe operações do engine e `bridgeUrl`, mas não `callTool`. O Bridge já é dono do `McpServer` (`packages/bridge/src/Bridge.ts:463-473`, composto por `packages/bridge/src/daemonMain.ts:1-16`), o engine já expõe `bridge.token` (`packages/engine/src/runtime-api/extensionOperations.ts:31-44,112`) e o pacote da extensão já depende do SDK e contém um cliente MCP separado em `pi-bridge-extension/index.ts:101-104`. Portanto, não é necessário inventar outro protocolo de daemon, mas precisa nascer um cliente/relay fino no host principal.

Esse cliente autenticará como **`external`**, não como agente. Para lifecycle isso é intencionalmente irrestrito: o guard só escopa agentes e o teste cobre o encerramento de qualquer agente por token externo. Para o universo inteiro de ferramentas, porém, `external` não basta: as 11 guardas agent-only, a resolução de ator e `run_host_action` continuam negando chamadas. A resposta mensurada é, portanto: `list_agents` e outras ferramentas caller-neutras funcionam; “qualquer ferramenta” não funciona sem mudar o contrato ou a semântica de identidade.

### Conferido e correto

- **Contagem real:** 17 manifests em `/home/goat/tachyon-plugins`, zero com `views`. Na instalação local há 15 manifests e exatamente um com `views`: Terrarium. O lock aponta esse consumidor para `github:cfpperche/terrarium@main`; os outros manifests com `views` no repositório são fixtures de teste, não consumidores externos.
- **Tese de produto:** separar plugin de coordenação e app local de UI continua consistente com o inventário; não apareceu segundo consumidor que force compatibilidade.
- **Remoções isoladas:** `PLUGIN_UI_ACTIONS` é restrito ao broker/host de plugin; o modo srcdoc `"plugin"` é usado pelo relay de plugin; `VIEW_FLEET_SCOPES` pertence ao parser de `views`. Os modos de protótipo do srcdoc e o arquivo de relay, que pode ser reaproveitado, não devem ser apagados em bloco.
- **Invariante do launcher:** `COCKPIT_SECTION_ORDER` está vazio e a checagem de `sectionNav.ts:116-120` é vacuamente satisfeita; apps realmente não precisam virar seções Control. Isso não elimina as lacunas de transporte e roteamento acima.
- **Reuso de painel:** `SectionPanelManager.ts:203-235,371-379` já oferece chave por view+projeto e reveal da instância existente. A premissa de reuso é válida, desde que a rota dinâmica e o carregamento de conteúdo sejam conectados.
- **Colisão:** prefixar o ID diferencia apps de IDs builtin por construção. A decisão só precisa ser reconciliada com o validador de persistência.
- **Cenários:** os cenários de instalação, catálogo, abertura/reveal, isolamento entre workspaces, reordenação, remoção e plugin sem tela são observáveis. A exceção é o critério universal do Bridge, que contradiz a política e os guards atuais em vez de apenas carecer de teste.


## Achado de revisão de segurança externa — 2026-08-21

Uma revisão adversarial trazida pelo dono tocou esta spec em dois pontos. Um é decisão dele; o outro é fato de viabilidade que eu não tinha e que muda a tarefa T3.

### Não é achado: "poder equivalente a agente, sem checksum nem prompt"

A revisão sinalizou que a decisão de desenho dá ao app poder equivalente ao de um agente, sem checksum e sem confirmação na reinstalação.

Isso está correto como descrição e não é defeito. É decisão explícita do dono em 2026-08-21, registrada em `spec.md` como non-goal com essas palavras: *"não é adiamento por falta de tempo, é decisão do dono"*. E a revisão a chamou de "sinalizado antes do código existir", que é exatamente o que a seção de non-goals serve para fazer.

Uma nuance medida que vale registrar: o poder do app **não** é equivalente ao de um agente. Doze ferramentas do Bridge exigem `caller.kind === "agent"`, e um app autentica como `external`. Estão nomeadas em `spec.md`. Onze delas têm um agente por sujeito; a décima segunda, `run_host_action`, é default-deny para todo mundo neste workspace.

### É achado: o extrator endurecido cobre só tar.gz

**Confirmado por leitura.** `packages/engine/src/plugins/manifest.ts:61`:

```
export const TOOL_ARCHIVE_TYPES = ["tar.gz", "tgz"] as const;
```

E `:429` recusa explicitamente:

```
`${where}.type: 'zip' is not supported in v1 — use tar.gz/tgz (zip support is deferred)`
```

Esta spec inteira é sobre instalar app **por zip**. O único extrator endurecido do produto não faz zip, e a recusa é deliberada e documentada como diferimento.

**Consequência para a T3.** Ela dizia "descompacta em temporário, valida, move". Isso pressupunha um descompactador. Não existe um que sirva. As opções são três, e nenhuma é óbvia:

| opção | custo |
|---|---|
| escrever extração de zip nova | é código de parsing de formato, a categoria mais fácil de errar |
| reusar o caminho tar.gz e trocar o formato de entrega | contraria o pedido do dono, que disse zip |
| destravar o `zip` diferido do `TOOL_ARCHIVE_TYPES` | herda o endurecimento existente, mas é decisão do spec 265 e não desta |

A terceira parece a certa e é a que eu não posso decidir sozinho, porque o diferimento do zip foi decisão de outra spec. **Vira pergunta para o dono antes de a T3 começar.**


## O destravamento do zip do spec 265 NAO serve — medido em 2026-08-21

O `notes.md` registrava três saídas para o zip, e eu recomendei a terceira: destravar o `zip` diferido do `TOOL_ARCHIVE_TYPES` para herdar o endurecimento existente. O dono autorizou.

**A recomendação estava errada, e o agente da fatia 1 parou antes de escrever código para dizer isso.**

`packages/engine/src/plugins/manifest.ts:65`, conferido por mim:

```
/** When the downloaded artifact is an archive, the single regular file to extract + its own pinned hash. */
export interface ToolArchive {
  type: ToolArchiveType;
  /** the contained POSIX-relative path of the ONE regular file to extract as the executable. */
  innerPath: string;
  /** 64-hex sha256 of the EXTRACTED executable bytes ... */
  binSha256: string;
}
```

O extrator do spec 265 tira **um arquivo regular**, identificado por `innerPath` e pinado por `binSha256`. É extrator de **binário**, não de árvore.

Um app é uma árvore de arquivos sem hash individual. Destravar o `zip` ali:

- não instalaria app nenhum, porque o contrato exige um membro único e um hash por membro;
- **afrouxaria o contrato de tool**, que é outro caso e está protegido de propósito.

### Decisão

A extração de app nasce em `packages/engine/src/apps/`. O spec 265 fica intocado.

Isso **não** é uma segunda forma de descompactar: é a primeira forma de descompactar **árvore**. O 265 descompacta **binário pinado**. Casos diferentes, e o comentário no código diz isso, para ninguém tentar unificá-los depois — nem tentar destravar o zip de novo, como eu tentei.

A contenção de caminho reusa `contained()` do `reviewBinaryCache.ts`, exportando-a se preciso, em vez de copiar.
