# Design Mode F6 — medição de segurança (`t-2136b6`)

| Campo | Valor |
|---|---|
| Task | `t-2136b6` — item F6 da SDD 488 |
| Árvore medida | `abbc6589` (worktree `dmsecurity`) |
| Data | 2026-08-12 |
| Modo | Medição e relatório. Nenhum `src/` editado. Nada desligado. |
| Eixos | `eval`, token, Trusted Types, click |

A spec pedia esta revisão desde o começo (`docs/specs/488-ide-browser-design-mode/spec.md` F6: *Prototype trust model is local-dev*). Uma passagem anterior existe em `docs/specs/488-ide-browser-design-mode/review-security-f6.md` (2026-08-05, árvore `f9beca91`). Esta é uma re-medição no ponto de uso de hoje — sessão correlacionada (`t-849f52`), ingest de atenção por hook (`t-6b3a0d`), layout dos painéis, entrega honesta de mensagem — não uma cópia daquela.

A regra do dono que enquadra o relatório: não inventar regra de segurança; separar o que é assim hoje do que seria problema noutro cenário; máquina de usuário único hoje.

---

## Veredito

**Nada grave.** Não há caminho medido em que texto da página volte como JavaScript avaliado. Os quatro eixos fazem o que o produto já documentou que fazem. A decisão de política — se algum dia isto deixa de ser local-dev — fica com o dono; esta task não a toma.

O caso mais interessante (página fala no mesmo canal que o overlay) é o desenho do inject, não um bypass. Está escrito em `notes.md` (*Do not block dogfood on SpaceX-grade security*) e na própria F6 (*local-dev*). Não é achado novo.

---

## eval

### O que o produto avalia na página

Toda avaliação passa por `IdeBrowserCdpSession.evaluate` → `Runtime.evaluate` no documento vivo (`src/webview/ide-browser-bridge/cdpSession.ts:462-481`). `evaluateInPage` é o mesmo método; o comentário no sítio diz que Design Mode não isola o DOM num iframe.

Portas que chegam lá:

| Porta | O que entra na `expression` | Quem escreve |
|---|---|---|
| HTTP `POST /eval` | `decoded.body.expression`, só “string não vazia” | Quem tem o token do host |
| MCP `ide_browser_eval` | mesma rota; schema cap 50 000 chars | Agente autenticado no Bridge |
| HTTP `POST /click` | template host com `JSON.stringify(selector)` | Quem tem o token do host |
| Inject / re-inject | string montada por `buildDesignModeInjectExpression` | Host (nome do binding + tokens de tema) |
| Push de chat | `window.__tachyonDmChatPush(${JSON.stringify(payload)})` | Host; payload pode carregar texto de pick |
| Probe / presence / fila / URL | literais do host (`"1"`, `location.href`, drain de `__tachyonDmQueue`) | Host |

Prova no ponto de uso:

- Handler HTTP de eval: `manager.ts:93-98` chama `this.cdp.evaluateInPage(expression)` sem reescrever a expressão.
- Decode HTTP: `src/ide-browser/protocol.ts:184-187` — `if (!expression)` 400; **sem teto de tamanho**.
- Tool: `src/bridge/tools/ide-browser.ts:105-125` — *“Evaluate JavaScript in the Integrated Browser page (DevTools-equivalent)”*, `z.string().min(1).max(50_000)`. Sempre-registrada quando `ideBrowserRequest` está ligado; offline falha fechado. Comentário no sítio (`ide-browser.ts:8-12`) documenta essa escolha.
- Click: `manager.ts:123-128` — `document.querySelector(${JSON.stringify(selector)})`. O seletor não quebra o literal.
- Inject: `cdpSession.ts:782-789` avalia a expressão do host. `bindingName` entra via `JSON.stringify` (`designModeInject.ts:64`).
- Push: `cdpSession.ts:483-498` — `JSON.stringify(payload)` interpolado. Quebra de string JS por conteúdo de página não cabe aqui.

### O caso perigoso que a task nomeia

*Conteúdo da página voltando como código.* Não medido.

- Pick captura `outerHTML` / `innerText` (`designModeInject.ts:99-100`) e posta JSON. O host monta um envelope (`pick.ts:154-184`); **não** avalia o HTML.
- A fila da página é drenada como `string[]` e parseada como JSON de mensagem (`cdpSession.ts:764-775`), não como `eval`.
- Snapshot lê AX names ou `{title, url, innerText}` (`cdpSession.ts:803-824`) e devolve o resultado ao agente. Não reentra como expressão.
- O único interpolar de dado de página numa `Runtime.evaluate` é o push de chat, e vai por `JSON.stringify`.

### É assim hoje

Eval na página autenticada é a superfície DevTools que a spec descreveu. Qualquer agente Bridge com o catálogo `ide_browser_*` chama. Design Mode OFF não desliga isso — o comentário de always-register diz porquê. HTTP `/eval` não herda o teto de 50 KB da tool. `Page.navigate` do agente (`cdpSession.ts:439-442`) **não** passa por `normalizeIdeBrowserHomeUrl` (que recusa `javascript:`/`data:`/`file:`/`vbscript:`/`blob:` em `homeUrl.ts:30-31`). Isso é assimetria de política no home URL, não um eval de conteúdo da página.

A linha `Human: ${input.text}` (`designModeChat.ts:452`) trata o texto de `chat.send` como fala humana. Esse texto chega pelo binding/fila (ver click / canal página→host). Não é eval; é o canal de prompt.

### Seria problema se

- Um processo same-uid lesse o arquivo de instância e postasse `/eval` sem passar pelo MCP — o teto de 50 KB não existe nessa porta. Hoje a máquina é de um usuário; loopback + arquivo `0600` não é fronteira contra o próprio uid. Observação de futuro, não defeito de hoje.
- `javascript:` no `/navigate` do agente fosse aceito pelo Chromium da aba. Não medi o comportamento do Chromium. A assimetria home-vs-agente está no código independentemente disso.
- Página hostil, com Design Mode ON, forjasse `chat.send` e o agente obedecesse *e depois* chamasse `ide_browser_eval`. Isso é o canal do overlay (abaixo), não “HTML da página virou `expression`”.

---

## token

Há **duas** credenciais, trabalhos diferentes. Não são o mesmo segredo.

### 1. Token do host loopback (IDE Browser)

| Propriedade | Sítio |
|---|---|
| Mint | `crypto.randomBytes(16).toString("hex")` — 128 bit (`hostServer.ts:92`) |
| Bind | `listen(0, "127.0.0.1")` (`hostServer.ts:98`) |
| Check | **toda** rota, inclusive `/status`: header `x-tachyon-ide-browser-token` `===` o valor em memória (`hostServer.ts:125-143`; constante em `protocol.ts:41`) |
| Persist | `~/.tachyon/ide-browser-instances/<workspaceHash>-<instanceId>.json`, dir `0700`, arquivo `0600` (`hostServer.ts:218-254`) |
| Cliente oficial | engine lê o arquivo e manda o header (`src/ide-browser/client.ts:167-169`) |
| Match de workspace | raiz **exata**; *“Parent/child fallback is deliberately absent”* (`client.ts:85-87`) |

O token viaja em claro no JSON de descoberta. Comparação é `===`, não tempo-constante. O Bridge, para o *outro* token, compara em tempo constante (`src/bridge/token.ts:46-52`). Dois desenhos, duas funções.

O que o token autoriza: dirigir a aba Integrated Browser (eval / click / navigate / snapshot / screenshot / chat-reply). Não identifica um agente. O comentário em `notes.md` (*Two bridges are intentional… Agents never connect to the shell HTTP API directly*) é convenção do caminho oficial, não um cadeado no arquivo.

### 2. Bearer do agente (atenção / Bridge)

`runtime_status_publish` (`src/bridge/tools/runtime-status.ts:5-21`):

- exige `caller.kind === "agent"` com nome;
- recusa `credentialState !== "live"` — sessão anterior não mexe na atual (teste em `test/unit/runtimeStatusAttention.test.ts:47-55`);
- o `runtime` do argumento só passa no schema (`claude` / `codex` / `grok`); o agente publicado é `caller.name`, não um nome inventado no body;
- efeito: `AttentionMonitor.publishRuntimeStatus` põe a atenção em `idle` (`AttentionMonitor.ts:243-251`). Não para processo, não avalia página, não clica.

O hook nativo materializado (`src/activity/sessionOwners.ts:755-773`) lê `TACHYON_AGENT_BRIDGE_URL` + `TACHYON_AGENT_BRIDGE_TOKEN` do spawn, faz MCP initialize, chama a tool. Comentário no sítio: *Authentication and agent identity come from the current spawn's environment; the Bridge rejects superseded credentials.*

### É assim hoje

Token de host = higiene de transporte no loopback do mesmo uid. Bearer de agente = identidade Bridge. O ingest de atenção que landou hoje usa o segundo, não o primeiro. Same-uid consegue ler os dois (arquivo `0600` / env do processo). Isso é o modelo de um usuário.

### Seria problema se

A máquina passasse a ser multiusuário, ou um processo same-uid fosse tratado como adversário. Aí loopback + arquivo em `$HOME` deixam de ser fronteira — o dono já enquadrou isso como observação de futuro. Um bearer de agente vazado abre o catálogo Bridge daquele agente (incluindo `ide_browser_*`), não só o ingest de `stopped`. Um token de host vazado dirige a aba sem passar pelo MCP.

---

## Trusted Types

### O que o inject faz

Comentário no sítio (`designModeInject.ts:118-121`): Chromium Trusted Types bloqueia `innerHTML` nu; o produto prefere `createPolicy` e cai para árvore DOM.

```122:145:src/webview/ide-browser-bridge/designModeInject.ts
  const setNodeHtml = (node, html) => {
    try {
      const tt = window.trustedTypes;
      if (tt && typeof tt.createPolicy === 'function') {
        // ...
            policy = tt.createPolicy('tachyon-dm', { createHTML: (s) => s });
        // ...
        node.innerHTML = policy.createHTML(html);
```

A política é identidade: o HTML do host passa. `setNodeHtml` tem **um** call site (`designModeInject.ts:905`) e recebe `markup` — template estático do overlay, sem interpolar DOM da página. Se a política é recusada, o fallback é `h()` / `svgEl()` / `createElement` (a partir de `:906`).

CSS do tema vai por `styleEl.textContent` (`:899-902`), nunca por TrustedHTML.

Strings que vêm da página ou do agente entram por `textContent`:

- bolha de chat: `:1065`, `:1070`
- HTML do pick no card: `:1585` — `(payload.html || '').slice(0, 1200)` como texto
- tag / meta / styles / status: `:1575-1589`

Não há segundo `innerHTML` no inject.

Se o inject falha no meio com TrustedHTML, `setDesignMode` **não** marca ON (`cdpSession.ts:565-577`) e a mensagem ao operador fala em CSP / Trusted Types.

### É assim hoje

Trusted Types no produto é **compatibilidade de install**, não fronteira página→host. A política identidade existe para o chrome montar em site com `require-trusted-types-for`. O card e o chat não montam HTML da página.

### Seria problema se

Alguém passasse `payload.html` (ou texto de agente) para `setNodeHtml`. Esse caminho não existe hoje. Um site que negue `createPolicy` cai no fallback DOM; um site que bloqueie também o fallback impede o overlay — o status bar não mente ON. Não medi um site TT-strict ao vivo.

---

## click

### Encoding

`manager.ts:123-128` (acima). O seletor não escapa do literal. Click é `el.click()` no documento da sessão CDP. Mais fraco que eval: quem avalia já clica.

Tool cap 1000 chars (`ide-browser.ts:135`). HTTP `/click` só exige string não vazia (`protocol.ts:190-193`).

### O que impede o clique de cair noutra página

Não é um allowlist de origem. É correlação de **qual sessão debug** o produto adotou.

`BrowserSessionController` (`browserSession.ts:7-9, 280-357`):

1. Cada launch gera `launchId = randomUUID()` e põe `tachyonIdeBrowserLaunchId` na config do pai `editor-browser`.
2. Adota só o filho CDP **direto** daquele pai.
3. Filho substituto sob o mesmo pai (ads, safeframes — floresta medida em globo.com, `notes.md` t-1c8195) é logado e **não** auto-anexado (`browserSession.ts:94-101`; teste `test/unit/browserSessionEndTrigger.test.ts:213-223`).
4. Filho de outro controller não é adotado (`:225-243`). Reset de um controller não mata a sessão do outro (`:246-256`).

Depois de anexar, `pageSessionId` de CDP (`cdpSession.ts:355-383, 415-426`) manda `Runtime.evaluate` / `Page.navigate` para aquele page target. `reattachPageTarget` prefere o primeiro target `http(s)` daquele debug session.

Click/eval/navigate batem **nessa** aba. A URL de dentro da aba é a que o humano (ou um `ide_browser_navigate`) pôs lá. Design Mode OFF não bloqueia o click — mesma escolha always-register.

O picker da página (`designModeInject.ts:1687-1709`) captura clique só com picker armado e não envia o agente; send é só `chat.send` (`manager.ts:273, 498-501`).

### Canal página → host (o overlay é página)

Com Design Mode ON o host registra `Runtime.addBinding("tachyonDesignModePick")` (`cdpSession.ts:34, 553, 654`) e drena `window.__tachyonDmQueue` a cada 250 ms (`:757-775`). Não há nonce por documento. O overlay chama o mesmo `post()` (`designModeInject.ts:76-81`). `Runtime.bindingCalled` e a fila caem no mesmo `onDesignPick` → `handleDesignPickRaw` → `chat.send` → `sendAgentInput`.

Isso é o desenho: a UI mora na página, então a página fala a língua da UI. Documentado como local-dev. Hybrid D (chrome fora da página) é a direção de arquitetura já escrita; não é política desta task.

### É assim hoje

Clique de agente = DevTools `element.click()` na sessão que **este** controller lançou. Correlação de sessão (`t-849f52`) impede adotar a floresta de frames ou o browser de outro launch. Não impede clicar um botão destrutivo **nessa** aba, se um agente autenticado pedir.

### Seria problema se

- O humano deixasse Design Mode ON numa origem cuja JS não é confiável: essa origem pode `chat.send` como se fosse o overlay. É o mesmo canal, não um segundo.
- O produto anexasse o primeiro `http(s)` target de um debug session que tivesse **várias** páginas. O protótipo é single-tab; `reattach` escolhe o primeiro `https?`. Não medi um caso ao vivo com dois page targets no mesmo child.
- Design Mode OFF fosse lido como “agentes não tocam a aba”. O código não afirma isso. Status bar pinta ON/OFF do overlay (`register.ts`); as tools continuam.

---

## Superfícies de hoje que não mudam os eixos

| Superfície | O que é | Eixo |
|---|---|---|
| Turn id (`designModeChatTurn.ts`, `t-181925`) | Resposta liga ao send; não autentica a página | eval / click: não |
| Entrega honesta (`t-a48926`) | Recibo de `sendAgentInput`; não é fronteira | — |
| Layout dos painéis | CSS / z-index do overlay | TT: markup ainda host-static |
| Speaker de `design_mode_chat_reply` | Prefere `deps.caller`; nome spoofado é ignorado (`ide-browser.ts:211-214`, `manager.ts:810-819`) | já fechado; não reaberto |
| Envelope de pick (`t-a50ab0`) | Continua; teste adversário em `designModePick.test.ts:102-141` | eval: página não vira código |
| Snapshot / `Open page:` / resultado de eval | Chegam ao agente sem o envelope do pick | não é eval; é rótulo de prompt |

---

## O que não foi medido

- Site ao vivo com `require-trusted-types-for 'script'` (Google / GitHub / fixture hostil). O caminho de código está acima; o Chromium real não foi exercido nesta passagem.
- Se `Page.navigate("javascript:…")` ou `data:` no Chromium da Integrated Browser executa, ignora ou navega. A assimetria home-vs-agente está no TypeScript; o efeito no browser não.
- Página hostil chamando `tachyonDesignModePick(...)` de verdade no EDH. O binding é page-world por contrato do CDP; não há motivo no código para achar que falharia. Não é o mesmo que ter gravado o exploit.
- Dois page targets `http(s)` no mesmo child debug session — `reattach` pega o primeiro.
- Companion `user_browser_*` e o plugin agent-browser.
- Multi-janela / multi-root além do match exato de workspace (já fechado o fallback pai/filho).
- Conteúdo de um arquivo de instância real nesta máquina (não abri `~/.tachyon/ide-browser-instances/`).
- Gate `verify:full` — docs only; o brief pede avisar antes de gatear.

---

## Método

Leitura no ponto de uso em `src/webview/ide-browser-bridge/*`, `src/ide-browser/{protocol,client}.ts`, `src/bridge/tools/{ide-browser,runtime-status}.ts`, `src/bridge/token.ts`, `src/attention/AttentionMonitor.ts`, `src/activity/sessionOwners.ts` (hook publisher), testes `designModePick.test.ts`, `runtimeStatusAttention.test.ts`, `browserSessionEndTrigger.test.ts`, spec/notes/review F6 de 2026-08-05. Nenhum `src/` alterado. Nenhum overlay desligado.
