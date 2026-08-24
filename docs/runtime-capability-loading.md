# Por onde cada runtime carrega skills, hooks e MCP

Documento vivo, **um runtime por seção**, e cada linha é uma medição com data e versão — não
documentação lida. O instrumento importa tanto quanto o resultado, então ele está escrito junto.

Existe porque o sistema de plugins ficou complicado tentando entregar capacidade a quatro runtimes
sem que estivesse escrito, num lugar só, **o que cada um faz sozinho**.

Três perguntas por runtime, **e as três respondidas para cada capacidade** — skills, hooks e MCP:

1. **De onde ele carrega sem que ninguém peça** (a descoberta — o que contamina).
2. **Como se nega isso** (a porta de negar).
3. **Como se entrega uma coisa específica** (a porta explícita — o que concede).

Uma capacidade não medida é uma linha em branco na tabela, nunca uma omissão silenciosa: a primeira
versão da seção do Grok saiu sem hooks e o dono percebeu antes de mim.

---

## Claude Code 2.1.241 — medido em 2026-08-24

**Instrumento:** `claude --debug --debug-file <novo> -p hi` com `ANTHROPIC_API_KEY` inválida. O log de
descoberta sai **antes** da autenticação, então a medição não custa chamada. Para hooks, o log não
serve (um "0 hooks in registry" numa sessão que não usou ferramenta não prova nada): o instrumento é um
hook de `SessionStart` que dá `touch` num arquivo, e a evidência é o arquivo aparecer.

> **Armadilha de método, paga na primeira tentativa:** `--debug-file` **acrescenta** ao arquivo. Reusar
> o mesmo log entre braços faz um `grep | head` ler a linha do braço anterior. Arquivo novo por braço.

### 1. O que ele carrega sozinho

| capacidade | de onde | `CLAUDE_CONFIG_DIR` privado resolve? |
|---|---|---|
| **skills** | `managed=/etc/claude-code/.claude/skills`, `user=$CLAUDE_CONFIG_DIR/skills`, `project=<cwd>/.claude/skills` | **não** — move só o `user`; o `project` continua entrando |
| **hooks** | `settings.json` do `user` **e** `<cwd>/.claude/settings.json` | **não** — os dois disparam |
| **MCP** | `<cwd>/.mcp.json` | **não** — o servidor do projeto conecta |

Medição: `Loaded 2 unique skills (… user: 1, project: 1 …)`, os dois marcadores de hook criados, e
`MCP server "srv-do-projeto": Starting connection`.

### 2. As portas de negar

| flag | skills do projeto | hooks do projeto | MCP do projeto | OAuth sobrevive? |
|---|---|---|---|---|
| **`--setting-sources user`** | **não entra** | **não entra** | **não entra** | **sim** |
| `--strict-mcp-config` | entra | entra | não entra | sim |
| `--bare` | não entra | não entra | não entra | **NÃO** |
| `--safe-mode` | não entra | não entra | não entra | ? (nega tudo, inclusive o concedido) |
| `--disable-slash-commands` | entra | entra | entra | sim |

**`--setting-sources user` é a porta.** Ela fecha o projeto inteiro — as três capacidades — e não mexe
na autenticação. `--strict-mcp-config` fecha só o MCP e é redundante ao lado dela, mas não custa nada.

`--disable-slash-commands` **não** é porta de negar descoberta, apesar do `--help` dizer "Disable all
skills": as skills continuam carregadas. Ele desliga a invocação por `/nome`, não a leitura.

> **Correção registrada, e ela tem duas camadas.** A primeira versão desta seção dizia que só `--bare`
> fechava a descoberta, e que por isso o Claude Code só se isolava por geografia. Errado nas duas
> pontas:
>
> 1. `--setting-sources user` fecha, e eu não a conhecia. Achei-a lendo o `argv` de um agente Tachyon
>    vivo — o produto já passava a flag certa enquanto eu media o mundo sem ela.
> 2. **O repositório também já sabia.** `docs/runtimes/parity.md` §3 (supressão de lane nativa, SDD 490
>    Fatia C) registra `--setting-sources user` medido na 2.1.222, e registra que `--bare` recusa OAuth
>    — as duas coisas que eu remedi do zero. Aquela medição era sobre a superfície de INSTRUÇÕES
>    (`CLAUDE.md`); esta estende a mesma flag para skills, hooks e MCP. A extensão valia a medição; a
>    descoberta da flag não precisava.
>
> Ler o que o produto FAZ e o que o repositório JÁ MEDIU, antes de concluir o que o runtime PODE,
> teria poupado a conclusão errada e metade do trabalho.

### 3. As portas explícitas

| flag | entrega | observação |
|---|---|---|
| `--plugin-dir <dir>` | as skills de um diretório de plugin | funciona até sob `--bare` |
| `--mcp-config <arquivo>` | servidores MCP | com `--strict-mcp-config`, são os únicos |
| `--settings <arquivo>` | hooks | soma-se aos descobertos, salvo negação |

**É o mesmo modelo do `pi`:** negar a descoberta, passar o concedido por caminho explícito.

### 4. `--bare` existe, e não serve — medido

`--bare` fecha tudo, mas **recusa OAuth**. Com a mesma credencial projetada na home privada:

| | resultado |
|---|---|
| `--bare` | `Not logged in · Please run /login` |
| sem `--bare` | `ok` |

Um agente que roda na assinatura do operador não sobe com `--bare`. Como `--setting-sources user`
entrega o mesmo isolamento sem esse preço, `--bare` não tem uso aqui.

### 5. O que o Tachyon já faz — lido do `argv` de um agente vivo

```
claude --resume <id>
  --setting-sources user
  --settings   <harness>/settings.json
  --mcp-config <harness>/mcp.json  --strict-mcp-config
  --mcp-config <bridge>/claude.json
  --settings   <spawn-settings>/claude.json
```

Nega o projeto por `--setting-sources user`, e entrega o concedido por `--settings`/`--mcp-config`. As
skills chegam pelo terceiro caminho: materializadas em `$CLAUDE_CONFIG_DIR/skills`, que é a raiz `user`
— por isso a contagem de um agente com uma skill concedida é `user: 1, project: 0`.

**Consequência para o desenho:** um agente Claude no `cwd` COMPARTILHADO já é tão isolado quanto um em
worktree, no que diz respeito a skills, hooks e MCP. A diferença entre os dois não é de carregamento de
capacidade — é de sistema de arquivos e de git (quem pode escrever onde, e em qual branch).

### 6. O achado que simplifica

**O payload de um plugin Tachyon já é um diretório de plugin do Claude Code.** Sem adaptação nenhuma:

```
.tachyon/plugins/sdd/
  skills/sdd/SKILL.md      ← é isto que o --plugin-dir lê
  prompts/nova-spec/
  tachyon-plugin.json      ← ignorado por ele
```

`claude --plugin-dir .tachyon/plugins/sdd` → `Loaded inline plugin from path: sdd`.

Entregar uma skill de plugin ao Claude Code, portanto, **não precisa de materialização** — nem link,
nem cópia, nem diretório. É um argumento apontando para o payload que já está no disco. Hoje o produto
materializa em `$CLAUDE_CONFIG_DIR/skills`; passar `--plugin-dir` seria uma escrita a menos e um
digest-no-caminho-de-descoberta a menos.

---

## Grok 1.0.5 — medido em 2026-08-24

**Instrumento:** `grok inspect` lista o que ele descobre, com a fonte de cada item — muito melhor que
log. Mas ele **lista o que existe, não o que roda**: um item pode aparecer e nunca ser carregado. Para
MCP o instrumento decisivo é `grok mcp doctor`, que tenta iniciar cada servidor e diz por que falhou.

> **Armadilha paga aqui:** `grok inspect` e `grok mcp list` DISCORDAM sobre os servidores de
> `.mcp.json` — o primeiro lista, o segundo não. Nenhum dos dois responde a `[compat.claude] mcps`.
> Passei disso para o `doctor` em vez de escolher a leitura que me convinha; a resposta estava numa
> terceira palavra que nenhum dos dois dizia (`folder untrusted`).

### 1. O que ele carrega sozinho

| capacidade | de onde | o projeto entra? |
|---|---|---|
| **skills** | `$GROK_HOME/skills` **e TRÊS raízes de projeto**: `<cwd>/.grok/skills`, `<cwd>/.agents/skills` (a do codex) e `<cwd>/.claude/skills` (a do claude) | **sim** |
| **MCP** | `<cwd>/.grok/config.toml` **e `<cwd>/.mcp.json`** (o arquivo do claude) | **sim**, com a pasta confiável |
| **hooks** | `$GROK_HOME/hooks/*.json` | **não** |

`GROK_HOME` privado **não fecha** skills nem MCP — confirma na 1.0.5 o que a t-26f508 mediu na 0.2.112.
Grok é o runtime que lê mais casa alheia: descobre skills e MCP pelas raízes dos outros dois.

**Hooks são a exceção, e vão no sentido contrário.** Medido com um hook de `SessionStart` que dá
`touch` num arquivo, em três lugares ao mesmo tempo:

| onde | disparou? |
|---|---|
| `$GROK_HOME/hooks/*.json` | **sim** |
| `<cwd>/.grok/hooks/*.json` | **não** — mesmo com a pasta confiável |
| `<cwd>/.claude/settings.json` | **não** — ele lê skills e MCP do claude, hooks não |

O hook de projeto fica pulado até um `/hooks-trust` explícito, que é uma confiança SEPARADA da
confiança de pasta (esta última o Tachyon semeia; a de hooks não). Ou seja: **para hooks, o Grok já
nasce fechado** — e é o único dos três nesse estado.

> Custo desta medição: uma chamada mínima ao Grok. Ele recusa antes de disparar `SessionStart` quando
> não autenticado, então — diferente do Claude, onde a descoberta acontece antes da autenticação — não
> havia como medir de graça.

### 2. As portas de negar

| porta | skills do projeto | MCP do projeto | hooks do projeto |
|---|---|---|---|
| **`[skills] ignore = [<raízes>]`** | **somem** (4 itens → 1) | não fecha | — |
| `[compat.<runtime>] skills = false` | marca `[disabled]`, **continua listada**; e não cobre `.agents/skills` | — | — |
| `[compat.claude] mcps = false` | — | **não fecha** (medido: sem efeito nas três leituras) | — |
| **`disabled_mcp_servers = [<nomes>]`** | — | **fecha** — `✗ disabled in config`, não inicia | — |
| **retirar a confiança da pasta** | — | **fecha tudo de projeto** | — |
| **nada a fazer** | — | — | **já fechado** — pulado até `/hooks-trust` |

`[skills].ignore` é uma lista de **caminhos**; `disabled_mcp_servers` é uma lista de **nomes**. A
segunda exige saber o nome antes, o que significa descobrir primeiro — não é negar por padrão.

### 3. O portão que decide MCP é a CONFIANÇA da pasta, e o Tachyon a concede

Sem confiança, nenhum servidor de projeto inicia. Com ela, os dois iniciam — medido no `doctor`:

```
Project trusted: no   → ✗ folder untrusted (repo-local server not started)
Project trusted: yes  → ✓ command found  ✓ server started
```

O Tachyon **semeia** essa confiança (`seedGrokTrustedFolders`, `trusted_folders.toml`), e por boa
razão: sem ela o spawn trava num "Do you trust the contents of this directory?" interativo.

**Consequência, e é um buraco:** a config que o Tachyon gera hoje fecha as skills do projeto
(`[skills].ignore` nas duas raízes que ele conhece) e **não fecha os servidores MCP do projeto**. Um
`.mcp.json` ou um `.grok/config.toml` no checkout compartilhado dá a todo agente Grok um servidor MCP
que ninguém concedeu — e um servidor MCP é capacidade executável, não texto.

### 4. O que a config gerada cobre, e o que falta

Lido de um `config.toml` real que o Tachyon escreveu:

```toml
[skills]
ignore = ["<ws>/.agents/skills", "<ws>/.grok/skills"]   # falta "<ws>/.claude/skills"
[memory] enabled = false
[compat.cursor] / [compat.claude]  ... = false
[mcp_servers.tachyon_bridge] ...
```

Duas lacunas medidas, ambas pequenas de fechar (hooks não é uma delas — já nasce fechado):

1. **`<cwd>/.claude/skills` não está no `ignore`.** Hoje ela cai no `[compat.claude] skills = false`,
   que marca `[disabled]` em vez de remover — e "disabled" é uma palavra do runtime, não uma garantia
   que eu medi valer no turno.
2. **Nenhuma porta fecha o MCP do projeto.** Fechar exige `disabled_mcp_servers` com os nomes lidos do
   `.mcp.json`/`.grok/config.toml` do projeto — descobrir para negar, que é o mesmo formato feio da
   supressão por path do codex.

### 5. As portas explícitas

O Grok **não tem** um `--plugin-dir` nem um `--mcp-config`. O que existe é a home privada: skills
concedidas são reconstruídas em `$GROK_HOME/skills` e servidores concedidos entram no `config.toml`
gerado. É materialização, não passagem por argumento — o oposto do Claude Code e do pi.


## Pi 0.84.3 — medido em 2026-08-24

### Aviso de método: um instrumento que falhou, e como se soube

Perguntar ao modelo o que ele tem carregado **não mede nada em pi**, e isto foi provado em vez de
suposto:

- com ferramentas ligadas, ele **lê o diretório** e reporta o disco. Denunciado por um resultado
  absurdo: com a porta FECHADA ele listou MAIS skills que com ela aberta.
- com `--no-tools`, todo braço responde "nenhuma" — em pi as skills são ferramentas, então desligar
  ferramentas desliga as skills junto.
- com `-nbt` (só as embutidas desligadas, que é o instrumento certo para não deixar ele ler o disco),
  um **controle positivo falhou**: passei `--skill <caminho>` explícito, que a doc garante carregar
  *"even with --no-skills"*, e o modelo respondeu `skill=nao`.

Um controle positivo que falha invalida o instrumento, não o runtime. Por isso a linha de skills
abaixo está **em branco**, e não preenchida com o que eu teria concluído.

O que funcionou foi **marcador de comportamento** (um `AGENTS.md` mandando dizer uma palavra) e
**marcador de ferramenta** (uma extensão registrando uma ferramenta de nome único, que o modelo
genuinamente enxerga na lista).

### 1. O que ele carrega sozinho

| capacidade | de onde | o projeto entra? |
|---|---|---|
| **extensões** | `~/.pi/agent/extensions/` (global) e `.pi/extensions/` (projeto) | **só com `--approve`** — medido: base `extensao=nao`, com `--approve` `extensao=sim` |
| **arquivos de contexto** | `AGENTS.md` / `CLAUDE.md` do projeto | **sim** — marcador confirmou |
| **skills** | — | **NÃO MEDIDO** (ver aviso acima) |
| **MCP** | — | **não existe nativo.** Doc do próprio pi: *"It intentionally does not include built-in MCP, sub-agents, permission popups, plan mode, to-dos, or background bash. You can build or install those workflows as extensions or packages"* |
| **hooks** | — | **não são arquivos descobertos.** São pontos de extensão em código (`session_start`, transformadores), dentro de uma extensão |

> **Retratação.** A primeira versão desta seção dizia "skills: `<cwd>/.pi/skills` — sim, e só a raiz
> dele; `.claude/skills` e `.agents/skills` não entram". Aquilo veio do braço em que o modelo leu o
> disco, e não se sustenta. A doc do pi diz o contrário em um ponto: `.agents/skills` **de `cwd` e dos
> diretórios ANCESTRAIS** é uma raiz de projeto dele.

### 2. O que a doc do pi declara sobre skills — declaração, não medição

Transcrito de `docs/skills.md` da 0.84.3, para não se perder enquanto não houver instrumento:

- **Global:** `~/.pi/agent/skills/`, `~/.agents/skills/`
- **Projeto (só depois de o projeto ser confiável):** `.pi/skills/`, e `.agents/skills/` em `cwd` **e
  nos ancestrais** até a raiz do repositório
- **Pacotes:** diretórios `skills/` ou `pi.skills` no `package.json`
- **Settings:** array `skills` com arquivos ou diretórios
- **CLI:** `--skill <path>` — *"repeatable, additive even with `--no-skills`"*
- **Negar:** `--no-skills` (caminhos explícitos continuam carregando)
- As pastas de skill do Claude e do Codex **não** são lidas por padrão: a doc ensina a adicioná-las
  manualmente em settings, o que confirma que não entram sozinhas

### 3. As portas de negar

| flag | o que fecha | medido |
|---|---|---|
| **`--no-context-files` / `-nc`** | `AGENTS.md` e `CLAUDE.md` do projeto | **sim** — o marcador some |
| `--no-approve` / `-na` | "Ignore project-local files for this run" | **NÃO fecha os arquivos de contexto** — o marcador continua. O que ele fecha exatamente: não medido |
| **ausência de `--approve`** | extensões do projeto | **sim** — o padrão já é fechado |
| `--no-skills`, `--no-extensions`, `--no-prompt-templates`, `--no-themes` | as famílias | declarados no `--help`; **não medidos** |

### 4. As portas explícitas

`--skill <path>`, `--extension/-e <path>`, `--prompt-template <path>`, `--theme <path>`.

**Não existe `--package <path>`.** Pacotes entram por `pi install`, e o Tachyon hoje passa
`--extension` para a família `packages` (o `else` final da cadeia de flags). O primeiro plugin que
trouxer `packages/` vai descobrir se isso está certo.

### 5. Por que o pi continua sendo o modelo, mesmo com metade não medida

`-ne` está documentado como *"Disable extension discovery (**explicit -e paths still work**)"*, e
`--skill` como *"additive even with `--no-skills`"*. É a lei do isolamento escrita duas vezes pelo
próprio runtime: **negar a descoberta, aceitar o caminho explícito.** E o padrão de extensões já nasce
fechado — medido —, que é a postura que os outros três não têm.

## Codex — a fazer

