# Inbox sweep — bloco A (plugins)

**Task:** `t-1cacae`  
**Árvore:** `34a2887b` (`b4e7195e23c5bcd715137936935b057f83b10662`) — `origin/main` neste checkout  
**Agente:** sweepA · 2026-08-16  
**Regra:** conferir, não reescrever cartão, não mudar status, não implementar.

Três perguntas por cartão: o caminho citado ainda existe? o problema ainda acontece? alguma entrega posterior já resolveu, no todo ou em parte?  
Vereditos: **VALE COMO ESTA** · **PRECISA REESCREVER** · **NAO FAZ MAIS SENTIDO**.

Os três `t-54cdb*` foram lidos pelas notas de 2026-08-16 *antes* do corpo. `t-54cdb2` entregou em `ee7d3450` / `0a63a559` e está **done** — não reaberto.

---

## Tabela

| id | veredito | motivo |
|---|---|---|
| `t-657d39` | VALE COMO ESTA | Terrarium ainda é o MVP `0.1.0` (`github:cfpperche/terrarium@main`); `ui/index.html` ainda diz Mundinho; produção (arte, atenção, HUD, empacotar) não entrou. |
| `t-8c0a7d` | VALE COMO ESTA | Cauda v2 ainda no mesmo lugar: só `focusAgent`, `connect-src 'none'`, `fleet` só `summary`, sem SDK nem auditoria. |
| `t-a11be4` | VALE COMO ESTA | Gap de serviço/daemon ainda zero no engine; a decisão v1 (não construir agora) continua de pé. |
| `t-4aac93` | VALE COMO ESTA | Os três gaps do v1 ainda são literais: `openSurface` cai em `surfaces[0]`, sidebar só a primeira, Plugins View sem botão Abrir. |
| `t-54cdb1` | PRECISA REESCREVER | Dest já existe no plano/fingerprint/apply; o corpo ainda pede “introduzir o conceito”. Resta o contrato público do install (a Plugins View nunca passa dest). |
| `t-54cdb3` | PRECISA REESCREVER | Sem seletor de destino na Plugins View. O corpo trata grant+scope como fronteira nova; o grant já existe no Agent Studio. A UI consente DESTINO. |
| `t-54cdb4` | PRECISA REESCREVER | `target.scope` e o merge entre dests já existem; `remove`/`update` ainda são cegos a dest e o corpo escreve como se a identidade ainda não tivesse nascido. |

Nenhum dos sete é **NAO FAZ MAIS SENTIDO**. Nenhum foi grande demais para julgar.

---

## Medição

### `t-657d39` — Terrarium MVP → produção

Caminhos: spec 349 existe (`docs/specs/349-plugin-ui-surfaces/spec.md`, v1 shipped). O plugin no lock do primário é `terrarium` `0.1.0`, fonte `github:cfpperche/terrarium@main` @ `19c432f0`. Manifesto: uma view `editor`, `fleet: "summary"`, `actions: ["focusAgent"]`. Residual pedido no corpo — *Mundinho → Terrarium* — ainda está no payload instalado: `ui/index.html:6` (`<title>Mundinho</title>`), `:122–123` (`aria-label="Mundinho"`, `<h1>Mundinho</h1>`), `:187` (`window.__mundinhoState`).

Nada neste repositório implementou arte/atenção/assento/HUD/empacotar. As deps `t-8c0a7d` e `t-4aac93` continuam inbox. O cartão descreve evolução de produto com decisões ainda abertas; isso ainda é o estado.

### `t-8c0a7d` — Plugin-UI v2

O caminho citado (`src/plugins/ui/broker.ts`) **moveu** no monorepo (`3fde3b05`) para `apps/vscode-extension/src/plugins/ui/broker.ts`. O conteúdo que o corpo nomeia não mudou:

- `PLUGIN_UI_ACTIONS = ["focusAgent"]` (`broker.ts:4`); `:121` ainda recusa o resto.
- CSP do iframe: `connect-src 'none'` (`packages/shared/src/webview/shared/untrustedSrcdoc.ts:22`; `test/unit/pluginHostRelay.test.ts:15`).
- Escopo de dado: `VIEW_FLEET_SCOPES = ["summary"]` (`packages/engine/src/plugins/manifest.ts:192`). Sem `fleet:agents`.
- Sem SDK/shim de autor (o host ainda é o relay `postMessage` em `packages/webview-ui/src/webview/plugin-host/relay.ts`).
- Sem log de auditoria por plugin/ação no broker.

A regra que atravessa (API controlada: projeção + broker + consent) segue. A cauda não foi puxada; o texto ainda a descreve. A citação de caminho é o único envelhecimento, e não muda o problema.

### `t-a11be4` — Plugin service lifecycle

Grep por `daemon` / `healthcheck` / `ensureRunning` / `startOnInstall` em `packages/engine/src/plugins` e `apps/vscode-extension/src/plugins` = zero. Capacidades continuam headless sob demanda (skills, tools, MCP, views). Blender aparece hoje em spec 338 como *app a lançar*, não como consumidor de um service-manager de plugin. A decisão v1 do pin (não construir a primitiva agora; o addon Godot/Blender fica com o servidor) não foi revertida nem satisfeita. O cartão é “avaliar se a demanda justifica”; essa pergunta ainda está em aberto.

### `t-4aac93` — UX de multi-surface

Caminho citado `src/plugins/ui/host.ts` moveu para `apps/vscode-extension/src/plugins/ui/host.ts`. Os três gaps do corpo ainda são o código:

```94:99:apps/vscode-extension/src/plugins/ui/host.ts
  openSurface(arg?: { pluginId?: string; viewId?: string; wsHash?: string } | string): void {
    const surfaces = this.installedSurfaces().filter((s) => s.surface === "editor");
    const wanted = typeof arg === "string" ? { pluginId: arg } : (arg ?? {});
    const surface =
      surfaces.find((s) => (!wanted.pluginId || s.pluginId === wanted.pluginId) && (!wanted.viewId || s.viewId === wanted.viewId) && (!wanted.wsHash || s.workspace.wsHash === wanted.wsHash)) ??
      surfaces[0];
```

Sidebar: `installedSurfaces().find((s) => s.surface === "sidebar")` (`host.ts:146`) — a primeira, sem tabs. Plugins View: `PluginsDispatch` não tem `openSurface` / Abrir (`packages/webview-ui/src/webview/plugins/App.tsx:19–48`). O comando secundário `tachyon.openPluginSurface` existe (`apps/vscode-extension/src/extension.ts:3671`; `package.json:329`) e cai no mesmo `surfaces[0]`.

### `t-54cdb1` — install por agente (dest)

O que o corpo pede para *introduzir* já está no engine, entregue por `t-54cdb2` (`0a63a559` / `ee7d3450`):

- Tipo canônico `{type:"workspace"|"agent"}` em `packages/engine/src/plugins/installScope.ts:10–12`.
- `previewInstall` / `applyInstall` / fingerprint recebem e rederivam dest (`engine.ts:859–912`, `:959`, `:1173`, `:1467`). Default `workspace`.
- Apply recusa preview de outro dest (`test/unit/pluginAgentDest.test.ts:280`).
- Agente inexistente / `isolate:transcript` falha fechado (`agentDest.ts:267–273`).

O que **não** existe — e é o que sobra — é o contrato público do *install door*:

- `PluginsPanel.ts:467` e `:693` chamam `previewInstall` / `applyInstall` **sem** dest (sempre workspace).
- `ConsentVM` (`packages/webview-ui/src/plugins/consentViewModel.ts:170`) não tem campo de dest.
- Lock do primário: 15 plugins, zero `scope` nos targets.

O grant (`authorizeAgentPlugin`, `packages/engine/src/config/agentSkillAuthorizationService.ts:287`) já existia antes e não é este cartão. O corpo ainda fala como se o primeiro conceito a criar fosse o escopo. Envelheceu o enquadramento, não o problema (a porta de install do produto ainda não expõe dest).

### `t-54cdb3` — consentimento na Plugins View

Nenhum `Scope: agent` / seletor de dest na Plugins View (`packages/webview-ui/src/webview/plugins/App.tsx`; dispatch `install(spec)` só). O Agent Studio já autoriza plugin por agente (`agentStudioDomain.ts:283` → `authorizeAgentPlugin`). Fingerprint já inclui dest+identidade do harness (`engine.ts:909–912`); apply já recusa mismatch (`pluginAgentDest.test.ts:280`, `:321`).

O corpo descreve “fronteira de segurança nova” e um consentimento de *quem pode usar*. Isso é o grant, e ele já existe. O que falta é consentir *onde se escreve* (workspace vs harness do agente), sobre um mecanismo que já falha fechado. Depende de `t-54cdb1` expor dest na porta de install; `t-54cdb2` (done) já deu o destino para o qual apontar.

### `t-54cdb4` — lockfile update/remove/reinstall por scope

Já existe, de `t-54cdb2`:

- `MaterializedTarget.scope?` (`packages/engine/src/plugins/lockfile.ts:46`); ausente = workspace.
- Merge entre dests: dois agentes, um payload, dests distintos (`pluginAgentDest.test.ts:292`).
- `applyInstall` só substitui targets do mesmo dest (`engine.ts:1607`).
- Forget não toca `.tachyon/plugins/` nem o lockfile (cláusula do corpo, alinhada).

Ainda dest-cego — o restante real:

- `previewRemove` / `applyRemove` recebem só `pluginName` (`engine.ts:2023`, `:2052`). `applyRemove` apaga **todos** os skill dests, o payload compartilhado (`:2122`) e a entrada do lock (`:2127`). Não há “tirar o dest de um agente”.
- O teste `:340` cobre remove do dest *único*; não o caso de vários agentes no mesmo plugin (nota de 2026-08-16).
- `previewUpdate` chama `previewInstall` **sem** dest (`engine.ts:2601`) → cai em workspace. `applyUpdate` também não aceita dest (`:2644`). Update de um install agent-scoped promoveria para workspace.

O corpo ainda pede persistir `(plugin, scope)` como se o lock fosse cego. A identidade mínima no *target* já nasceu; o que falta é o lifecycle (remove/update/reinstall) scoped, inclusive não apagar o payload enquanto outro dest apontar para ele.

---

## O que isto não é

Não é triagem. O dono decide se reescreve, despacha ou larga. Nenhum cartão foi editado, nenhum status mudou, nenhum cartão novo foi aberto.
