# t-5a364d — auditoria de resíduos da monorepoização

**Árvore medida:** `1108893f12520449c5f37d8aff453397e8c3951e`  
**Data:** 2026-08-14  
**Escopo:** estado atual, depois das seis fatias da SDD 506 e das cinco extrações já integradas da fronteira bridge/engine. Esta task só mede e abre cartões; não corrige os achados.

## Resposta curta

Há quatro grupos de resíduo confirmados, em ordem de dano:

1. o manifesto da extensão conserva **22 scripts** com caminhos relativos ao layout antigo e uma porta npm real já falha (`t-7d7e33`);
2. **82 arquivos de teste / 113 ocorrências** ainda atravessam `packages/*/src` pelo contorno relativo que deixou de ser necessário (`t-1773f2`);
3. **um asset de produto** continua sem ownership de workspace, `src/config/tachyon.schema.json` (`t-7a3e43`);
4. **cinco arquivos de código vivo** indicam endereços pré-monorepo em comentários (`t-7bd5a3`).

Não encontrei guarda nova sem alvo nem entrada nova de allowlist que case zero arquivos. Os casos conhecidos dessas duas classes foram corrigidos antes desta medição e continuam fail-closed hoje.

## Método e contagens por categoria

| categoria | critério verificável nesta árvore | encontrados |
|---|---|---:|
| Config apontando para o passado | Para cada caminho explícito em `scripts` dos manifests e em config de build/TypeScript/VS Code, resolver a partir do `cwd` da porta que o consome; confirmar candidato executando uma porta read-only quando possível. Caminhos do esbuild foram resolvidos contra seu `absWorkingDir`, não contra a raiz por suposição. | **1 grupo**, 22 entradas quebradas |
| Exceção obsoleta | Analisar imports/exports/`import()` literais via AST e re-resolver o equivalente nominal; em allowlists, exigir que cada entrada case pelo menos um arquivo atual. Uma ocorrência só conta quando a razão que exigia a exceção não existe mais. | **1 grupo**, 113 ocorrências em 82 arquivos |
| Arquivo sem dono | Partir dos arquivos não-TS restantes em `src/`, seguir consumidores de build/manifest/teste e excluir os 25 TS/TSX e shims já classificados em `t-31bedf`. “Sem dono” aqui significa produto alcançável que ficou fora dos workspaces que hoje possuem o produto. | **1 arquivo** |
| Referência morta em prosa | Em comentários de `src/`, `packages/` e `apps/`, selecionar apenas frases que apresentam um caminho como endereço atual; testar existência e localizar o destino atual. Narrativa explicitamente histórica e docs de pesquisa datados não contam. | **5 arquivos**, 6 menções |
| Guarda sem alvo | Inspecionar os scanners alterados pela SDD 506, seus diretórios calculados e a reação a conjunto vazio; construir antes dos testes condicionais e observar se os cinco checks conhecidos executam ou ficam pending. | **0 novos** |
| Conceito duplicado | Comparar definições/configurações repetidas nos manifests e procurar, por AST, os símbolos ainda importados de `bridge` depois das extrações; duplicação só conta se duas fontes atuais governam o mesmo comportamento, não por basename igual. | **1** (a tabela de scripts duplicada, já contada no primeiro achado) |

As categorias não somam cartões porque “config apontando para o passado” e “conceito duplicado” descrevem o mesmo defeito do manifesto, não dois consertos independentes.

## Achados, ordenados por dano

### 1. O manifesto movido preserva lifecycle scripts da raiz (`t-7d7e33`)

`apps/vscode-extension/package.json` ainda contém a tabela de scripts copiada do antigo manifesto raiz. Resolvidos a partir do `cwd` normal de um npm workspace, **22 scripts** referenciam `scripts/`, `packages/`, tsconfigs ou config Vitest que não existem sob `apps/vscode-extension`.

Confirmação pela porta real:

```text
$ npm run -w tachyon check:webview-tokens
Error: Cannot find module '.../apps/vscode-extension/scripts/check-webview-tokens.mjs'
exit 1
```

O dano não é cosmético: `vscode:prepublish` encadeia `package:assert`, que por sua vez aponta ao `scripts/prepare-package.mjs` inexistente nesse `cwd`. Um empacotamento iniciado pela lifecycle padrão pode morrer antes de auditar o artefato. É também o conceito duplicado encontrado: raiz e app têm 27 chaves de scripts, 26 valores iguais e uma divergência (`plugin:validate`), portanto há duas fontes aparentes para a mesma lifecycle.

### 2. O contorno de resolução virou bypass permanente da porta de pacote (`t-1773f2`)

Uma travessia AST de todos os arquivos em `test/` contou imports, exports e `import()` cujo literal alcança `../../packages/{engine,shared,webview-ui}/src/...`:

| pacote | ocorrências |
|---|---:|
| engine | 16 |
| shared | 1 |
| webview-ui | 96 |
| **total** | **113 em 82 arquivos** |

Depois do `npm install` requerido nesta worktree, `node_modules/@tachyon/*` são links locais. Convertendo apenas os literais em memória para o subpath nominal equivalente, há **69 subpaths únicos e `import.meta.resolve` resolve 69/69 nesta worktree**. Logo o contorno criado para o `node_modules` compartilhado não é mais necessário hoje.

O dano é silencioso: os testes entram diretamente em `src` e deixam de testar `exports`/`typesVersions` e a resolução nominal que consumidores usam. Uma regressão no contrato do pacote pode passar enquanto o teste relativo continua verde.

### 3. O schema é produto, mas ficou na raiz residual (`t-7a3e43`)

`src/config/tachyon.schema.json` não é documentação: `esbuild.mjs:525` o copia para `dist/tachyon.schema.json`, e o manifesto da extensão publica esse arquivo como schema de configuração. Entre os quatro arquivos não-TS sob `src/`, ele é o único asset de produto; os outros três são README/VENDORED dos shims já classificados.

O dano é uma fronteira de ownership falsa. Contagens somente de `.ts`/`.tsx` podem declarar a raiz sem produto, e uma limpeza futura de `src/` pode remover o schema entregue sem que uma fronteira de workspace seja responsável por ele.

### 4. Comentários vivos ainda apontam ao monólito (`t-7bd5a3`)

As seis menções atuais com destino inexistente são:

| comentário | endereço escrito | destino atual |
|---|---|---|
| `src/runtime/nativeLaneSuppression.ts` | `src/agents/formation/lifecycleHost.ts` | `packages/engine/src/agents/formation/lifecycleHost.ts` |
| `packages/shared/src/agents/agentRuntimeAdmission.ts` | `src/resume/adapters.ts` | o contrato foi repartido; não existe mais um arquivo `adapters.ts` |
| `packages/shared/src/richDoc/types.ts` (2×) | `src/pins/types.ts` | `packages/engine/src/pins/types.ts` |
| `apps/vscode-extension/src/runtimeConfig/sourceLock.ts` | `src/locks/processLock.ts` | `packages/engine/src/locks/processLock.ts` |
| `apps/vscode-extension/src/extension.ts` | `src/runtimeOps/openRuntimeOps.ts` | `apps/vscode-extension/src/runtimeOps/openRuntimeOps.ts` |

O dano é de revisão/manutenção: a prosa manda o leitor conferir um endereço inexistente, ocultando a implementação que sustenta a afirmação. Nenhum desses cinco arquivos quebra runtime por causa do comentário.

## Os cinco casos conhecidos no estado de hoje

1. **Schema na raiz — confirmado.** É o achado 3 e tem cartão `t-7a3e43`.
2. **`landDoorHasNoAgentDoor` examinava zero arquivos — refutado hoje.** Ele deriva `@tachyon/engine` do manifesto, varre `bridge`, `host-action` e `agent-vscode`, e envolve cada resultado em `nonEmpty`. O teste focado executou quatro checks, todos verdes; conjunto vazio agora lança erro.
3. **Cinco guardas de build ficavam skipped — refutado hoje.** Depois de `npm run build`, os dois checks de `_tachyon-data` e os três budgets de webview executaram (não ficaram pending): **5/5 passaram**. O probe usa o manifesto de apps, não mais o bundle aposentado `cockpit.js`.
4. **Oito de nove exceções `vscode` não casavam — refutado hoje.** `ROOT_SHELL_ALLOW` contém uma única entrada, `src/webview/`, e ela casa arquivos atuais. O scanner AST falha quando uma entrada casa zero; o teste adversarial dessa condição passou.
5. **80+ testes usam caminho relativo para `packages/*/src` — confirmado e ainda maior pelo critério completo.** São 82 arquivos e 113 ocorrências. Já não precisam do contorno: 69/69 subpaths nominais únicos resolvem localmente. Cartão `t-1773f2`.

## Varreduras vazias e falsos positivos recusados

- **Guarda sem alvo: zero novo.** Os scanners de source usados pelos guardas estruturais agora calculam roots por workspace e usam `nonEmpty`, ou possuem assertiva explícita de apps/fontes. O focused check cobriu a antiga falha do land door e as cinco condições de build.
- **Exceção de `vscode`: zero entrada morta.** A única entrada atual casa; o próprio mecanismo retorna `staleAllowEntries` para uma entrada artificial vazia.
- **`esbuild.mjs` não aponta ao passado em `entryPoints: ["src/engine-service/daemonMain.ts"]`.** O bloco define `absWorkingDir` como o diretório de `packages/engine`; o caminho resolve para arquivo existente. Não é achado.
- **Os 25 TS/TSX em `src/` não foram reabertos.** Permanecem na classificação e dívida de `t-31bedf`; só o schema não-TS, alcançado pelo build, entrou nesta auditoria.
- **Fronteira bridge/engine não tem contagem duplicada atual.** A régua AST atual encontra 38 bindings em 20 imports de nove consumidores. O “69” em `bridge-engine-boundary-t69ae46.md` é uma medição datada da árvore anterior, não uma afirmação do estado atual, e por isso não foi classificado como prosa morta.

## Evidência executada antes do gate final

```text
npm install
  added 639 packages; node_modules local

npm run build
  exit 0

npx vitest run \
  test/unit/landDoorHasNoAgentDoor.test.ts \
  test/unit/vscodeImportBoundaries.test.ts \
  test/unit/pluginDataShim.test.ts \
  test/unit/webviewAppBudget.test.ts --reporter=verbose
  4 files passed; 15 tests passed; 0 pending
```

O gate completo e sua atestação são registrados depois do commit, para que meçam a árvore entregue exata.
