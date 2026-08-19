# Superfície morta ainda oferecida pelo produto

Levantamento do cartão `t-ee3d5d`, medido na árvore em 2026-08-19. O critério foi consumidor em código de produção, não ocorrência em `tachyon.yml` deste repositório. A ordem abaixo começa pelo que o editor oferece sem deixar claro que a forma não funciona.

## Resultado

| Superfície | Onde é definida | 1. Alguém lê? | 2. Se ninguém lê, alguém ainda recomenda? | 3. Há caminho novo? Está documentado? | Cartão existente |
|---|---|---|---|---|---|
| `x-removed-agents.<nome>` | `apps/vscode-extension/tachyon.schema.json:9-327` | **Ninguém em produção.** `KNOWN_TOP_LEVEL_KEYS` não contém `x-removed-agents` (`packages/engine/src/config/loadConfig.ts:631`); o carregador de perfis remove somente `agents:` antes do parser (`packages/engine/src/config/agentProfileConfigLoader.ts:70-75,183-198`). | **Sim: o schema é ligado ao autocomplete/validação de `tachyon.yml` por `apps/vscode-extension/package.json:663-670`.** O prefixo `x-` não o torna invisível para JSON Schema. Um usuário pode receber essa chave como propriedade válida, mas o parser a descarta como desconhecida. **DEFEITO — recomendação ativa sem leitor.** | Sim: `.tachyon/agents/<nome>/agent.yml`. Está documentado em `docs/architecture/agent-profiles.md:3-14`. | `t-e050fd` (origem da migração); `t-ae221c` (roster no diretório). O nome auxiliar foi mantido no conserto, mas a medição mostra que ele continua exposto. |
| Campos de agente dentro de `terminals.<nome>`: `kind`, `instructions`, `worktree`, `branch`, `baseRef`, `worktreeSetup`, `harness`, `isolate`, `subagents` | A propriedade `terminals` reutiliza `$ref` de `x-removed-agents` em `apps/vscode-extension/tachyon.schema.json:329-337`. | **Ninguém no leitor de terminal.** `parseTerminalDeclaration` aceita somente `cmd`, `cwd`, `env`, `autostart`, `watch`, `attention`, `restart` (`packages/engine/src/config/loadConfig.ts:1083-1094`); os demais são descartados com mensagem para criar agente. | **Sim: o schema os apresenta como válidos dentro de um terminal.** O usuário pode preencher, por exemplo, `terminals.dev.worktree: true`, e o parser descarta a chave. **DEFEITO — contrato do editor promete campos que a porta recusa.** | Há um caminho novo para terminais: `.tachyon/terminals/<nome>.yml` (`packages/engine/src/config/terminalDeclarations.ts:6-18`), mas não encontrei documentação durável que explique esse caminho; `docs/architecture/agent-profiles.md:12-14` ainda fala apenas do bloco `terminals:`. | `t-bc8eed` (migração para diretório); `t-32db3b` (terminal perdeu campos de agente). |
| `layouts:` | `apps/vscode-extension/tachyon.schema.json:339-343`; chave preservada em `KNOWN_TOP_LEVEL_KEYS`; comentário do parser em `packages/engine/src/config/loadConfig.ts:1246`. | **Ninguém.** O parser reconhece a chave apenas para não rejeitá-la e não cria `config.layouts`. | **Sim, de forma residual:** o schema oferece autocomplete, embora marque a propriedade como `deprecated` e diga que é ignorada. É uma oferta morta, mas não uma recomendação sem ressalva. **DEFEITO de superfície exposta; dano menor.** | Não há caminho Tachyon novo; o schema aponta para os grupos nativos do VS Code. A retirada está registrada em `docs/specs/234-tachyon-retire-layouts/plan.md`, mas não em uma documentação corrente de uso. | Nenhum cartão de limpeza específico localizado no Board; a origem é a especificação de retirada 234. |
| `settings.layout` | `apps/vscode-extension/tachyon.schema.json:384-387`; `KNOWN_SETTINGS_KEYS` ainda o enumera (`packages/engine/src/config/loadConfig.ts:633-639`). | **Ninguém.** `parseConfig` não lê `raw.settings.layout`; há somente o comentário de compatibilidade em `packages/engine/src/config/loadConfig.ts:1345`. | **Sim, de forma residual:** autocomplete/schema ainda o oferecem como `deprecated`, embora o descrevam como ignorado. **DEFEITO de superfície exposta; dano menor.** | Não há caminho Tachyon novo; a substituição indicada é grupo de editores nativo do VS Code. A retirada está registrada no plano da spec 234, não em documentação corrente de configuração. | Nenhum cartão de limpeza específico localizado no Board; origem na spec 234. |
| `settings.persistence` / `silentHooks` | `apps/vscode-extension/tachyon.schema.json:749-756`; `KNOWN_SETTINGS_KEYS` o mantém; o parser só emite aviso em `packages/engine/src/config/loadConfig.ts:1752-1756`. | **Ninguém.** Hooks silenciosos são sempre habilitados para agentes Claude/Codex elegíveis; a chave não altera o estado. | **Sim: o schema ainda a oferece e a mensagem de erro a nomeia**, embora diga “OBSOLETE” e mande remover. **DEFEITO de superfície exposta, não recomendação positiva.** | Não há chave substituta: o comportamento é automático. O próprio schema e a mensagem documentam a remoção, mas não existe uma página de configuração corrente. | `t-7bcba6` (remoção da configuração de lembretes de persistência). |
| `settings.gitDelivery` | `apps/vscode-extension/tachyon.schema.json:596-620`; aviso residual em `packages/engine/src/config/loadConfig.ts:1808-1821`. | **Ninguém.** Os únicos consumidores que a autorização alcançava (`git_delivery_integrate`, `git_delivery_prune`, `delivery_salvage`) foram removidos; o parser apenas avisa. | **Sim: schema e mensagem ainda aceitam/nomeiam a chave**, com `deprecated`/“RETIRED”. **DEFEITO de superfície exposta; dano menor porque o texto manda remover.** | Não há substituto configurável. O mecanismo remanescente é worktree + tarefas + gate, documentado na decisão de retirada do Delivery (`t-e88c8a`); não há caminho de configuração equivalente. | `t-e88c8a` (retirada da máquina); `t-17d885` (principals órfãos). |
| `settings.delivery` | `apps/vscode-extension/tachyon.schema.json:663-666`; aviso residual em `packages/engine/src/config/loadConfig.ts:1823-1830`. | **Ninguém.** O subsistema Delivery foi retirado; a chave não é armazenada em `config.settings`. | **Sim: o schema ainda a publica e o parser ainda emite mensagem de compatibilidade**, dizendo que é ignorada. **DEFEITO de superfície exposta; dano menor.** | Não há substituto configurável; a decisão é mecanismo-only (spawn, worktree, tarefas e verify). A retirada está registrada em `t-e88c8a`, mas não há uma chave nova a documentar. | `t-e88c8a`; `t-85f251` (lifecycle legado de Delivery). |
| `sidebar` em `~/.tachyon/settings.json` | `packages/shared/src/config/globalSettingsDocument.ts:103-109`. | **Ninguém.** `parseGlobalSettings` ignora silenciosamente a chave; o documento resolvido só possui `activity`, `agentPane`, `gitPath` e `font` (`:52-59,181-189`). | **Não encontrei recomendação atual** em README, runbooks, schema ou código de UI. A spec abandonada é apenas histórico. **Limpeza barata, não defeito pelo critério de recomendação.** | Não há override pessoal vivo; a sidebar usa o template padrão. O antigo override aparece apenas na spec abandonada 479. | Relacionados: `t-601051` (override pessoal encerrado), `t-aaad95` (autoridade única do settings). Nenhum cartão específico para este resíduo no JSON global. |
| `lifecycle.watch` no perfil canônico | `packages/engine/src/config/agentProfileSchema.ts:133-149`. | **Leitura de compatibilidade apenas.** `projectCanonicalAgentProfile` lê para emitir aviso e descarta (`packages/engine/src/config/agentProfileProjection.ts:873-884`); nenhum runtime reinicia um agente canônico por esse campo. | **Não.** Agent Studio não o escreve; `docs/architecture/agent-vs-terminal.md:57` diz que watch é de Terminal. **Limpeza barata, não defeito pelo critério de recomendação.** | Sim: `watch` continua vivo no perfil de terminal (`terminals`/`.tachyon/terminals/<nome>.yml`). A documentação explica a separação, mas não a forma completa do arquivo novo. | `t-bd14d8` (watch é capacidade de Terminal, não de Agent). |

### O que não entrou como achado

- `terminals:` não foi classificado como morto: `loadProfileAwareConfig` lê o bloco (`packages/engine/src/config/agentProfileConfigLoader.ts:187-198`) e `parseConfig` constrói entradas de terminal (`packages/engine/src/config/loadConfig.ts:1216-1243`). Ele é legado, mas ainda tem consumidor; isso é diferente de não ser usado pelo nosso `tachyon.yml`.
- `schedules:` não foi classificado como morto: `parseConfig` valida e monta `ScheduleDef` (`packages/engine/src/config/loadConfig.ts:1248-1305`) e a extensão tem Studio/ações de schedule.
- `isolate: transcript` não foi classificado como morto: a porta de autoria foi removida, mas ainda existe leitura de compatibilidade e consumidores de isolamento em runtime. O cartão `t-51fed6` mede precisamente essa distinção.
- Os comandos declarados em `apps/vscode-extension/package.json` foram comparados com as strings em `apps/vscode-extension/src` e `packages/webview-ui/src`; não apareceu comando sem ocorrência de registro/uso. Os registros indiretos (`DESIGN_CMD`, `OPEN_CMD`) foram conferidos por nome.

## Contagem

Foram examinados **1.626 cartões do Board** e **9 superfícies** na tabela.

- **7 são DEFEITO** pelo critério “ainda recomenda/oferece”: `x-removed-agents`, os campos de agente sob `terminals`, `layouts`, `settings.layout`, `settings.persistence`, `settings.gitDelivery` e `settings.delivery`. Os dois primeiros são os mais perigosos porque parecem configurações funcionais; os cinco últimos já dizem “deprecated/retired/ignored”, mas continuam publicados no schema/autocomplete e mantêm o caminho morto como contrato conhecido.
- **2 são limpeza barata, não defeito de recomendação:** `~/.tachyon/settings.json:sidebar` e `agent.yml:lifecycle.watch`. Ambos têm leitor de compatibilidade/diagnóstico, mas não encontrei alguém recomendando-os hoje.
- A tabela cita cartões existentes quando encontrados. Não criei cartões nem removi nada: cada remoção deve virar decisão/cartão próprio.

## Comandos de varredura reproduzíveis

```bash
# estado e arquivos relevantes
git status --short --branch
rg --files | rg 'loadConfig|config.*(ts|js)$|settings.*(ts|js)$'

# schema, parser, perfis, terminais e settings
rg -n 'x-removed-agents|KNOWN_TOP_LEVEL_KEYS|KNOWN_SETTINGS_KEYS|KNOWN_AGENT_ENTRY_KEYS|raw\.settings|raw\.agents|raw\.terminals|layouts|gitDelivery|delivery|persistence|isolate' \
  apps/vscode-extension/tachyon.schema.json apps/vscode-extension/package.json \
  packages/engine/src/config packages/shared/src/config

# consumidores e recomendações fora de definições/testes
rg -n 'terminals|terminal\.yml|agent\.yml|settings\.json|lifecycle\.watch|settings\.layout|settings\.gitDelivery|settings\.delivery|settings\.persistence|isolate:' \
  README.md docs apps packages --glob '!docs/specs/**' --glob '!docs/research/**' \
  --glob '!node_modules/**' --glob '!*.map'

# comandos declarados na extensão
node - <<'NODE'
const fs = require('fs'), path = require('path');
const pkg = require('./apps/vscode-extension/package.json');
function files(dir) { let out=[]; for (const e of fs.readdirSync(dir,{withFileTypes:true})) {
  const p=path.join(dir,e.name); if (e.name==='node_modules'||e.name==='dist') continue;
  if (e.isDirectory()) out=out.concat(files(p)); else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) out.push(p);
} return out; }
const source = files('apps/vscode-extension/src').concat(files('packages/webview-ui/src'))
  .map(f => fs.readFileSync(f,'utf8')).join('\n');
for (const {command} of pkg.contributes.commands) if (!source.includes(command)) console.log(command);
NODE

# Board sweep: request all pages (500 is the API page size)
# via Bridge list_tasks(fields=compact, limit=500, offset=0/500/1000/1500),
# then inspect candidate cards with get_task(journal=all).
```

## Onde eu não procurei

- Não li o `~/.tachyon/settings.json` real da máquina nem homes fora deste checkout; medi o leitor versionado do repositório, não o estado pessoal do host.
- Não inspecionei VSIX empacotado, `dist/`, `node_modules/` ou caches gerados; são artefatos, não fontes de recomendação persistente.
- Não fiz uma varredura de documentação externa, Marketplace, issues/PRs remotos ou documentação dos runtimes Claude/Codex/Grok.
- Não percorri cada arquivo histórico de `docs/specs/` como recomendação de produto; tratei specs fechadas como evidência histórica, salvo quando a tabela cita uma retirada.
- Não validei o comportamento visual do autocomplete no VS Code/Monaco com um browser; inferi a oferta a partir do vínculo `yamlValidation` + propriedades JSON Schema. A existência da propriedade no schema é medida; a ordem exata das sugestões não foi medida.
- Não medi comandos registrados apenas por constantes contra uma instância viva da extensão; fiz o vínculo estático dos nomes e marquei os registros indiretos manualmente.
- Não tratei ocorrências em `test/` como consumidores: fixtures antigas são evidência de dívida de teste, não uma porta que um usuário consegue usar.
