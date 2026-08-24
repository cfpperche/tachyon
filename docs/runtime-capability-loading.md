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

**Instrumento, e ele deu trabalho.** Pi recusa antes de carregar recursos quando não autenticado, então
não há leitura de graça como no Claude. Pior: **perguntar ao modelo quais skills ele tem é um
instrumento ruim** — com ferramentas ligadas ele vai LER O DIRETÓRIO e reportar o que achou no disco,
não o que está carregado. Foi o que aconteceu num braço, e o resultado contraditório (com a porta
FECHADA ele listou MAIS skills) foi o que denunciou o método.

O que funcionou foi um **marcador de comportamento**: um `AGENTS.md` no projeto dizendo "sempre diga
PROJETO-AGENTS". Se a instrução chega, a resposta carrega a palavra. Não depende de introspecção nem
de o modelo ser honesto sobre si.

`--no-tools` também não serve para medir skills aqui: em pi elas **são ferramentas**, então desligar as
ferramentas desliga as skills junto e todo braço responde "nenhuma".

### 1. O que ele carrega sozinho

| capacidade | de onde | o projeto entra? |
|---|---|---|
| **skills** | `<cwd>/.pi/skills` | **sim** — e **só a raiz dele**: `.claude/skills` e `.agents/skills` do projeto **não** entram |
| **arquivos de contexto** | `AGENTS.md` / `CLAUDE.md` do projeto | **sim** (marcador confirmou) |
| **MCP** | — | **não existe nativo.** A doc do próprio pi: *"It intentionally does not include built-in MCP, sub-agents, permission popups, plan mode, to-dos, or background bash. You can build or install those workflows as extensions or packages"* |
| **hooks** | — | **não são arquivos descobertos.** Existem como pontos de extensão em código (`session_start`, transformadores de exibição), dentro de uma extensão — não um diretório que ele varre |

Pi é o **oposto do Grok** na descoberta: lê só a própria raiz, e não vai à casa de ninguém.

### 2. As portas de negar

| flag | o que fecha | medido |
|---|---|---|
| **`--no-context-files` / `-nc`** | `AGENTS.md` e `CLAUDE.md` do projeto | **sim** — o marcador some da resposta |
| `--no-approve` / `-na` | "Ignore project-local files for this run" | **NÃO fecha os arquivos de contexto** — o marcador continua aparecendo. O que ele fecha exatamente ficou **não medido** |
| `--no-skills` / `-ns` | descoberta de skills | declarado no `--help`; **não medido** |
| `--no-extensions` / `-ne` | descoberta de extensões (`-e` explícito continua valendo) | declarado; **não medido** |
| `--no-prompt-templates`, `--no-themes` | as duas famílias | declarados; **não medidos** |

> **Duas linhas em branco de propósito.** `-ns`/`-ne` são as portas que o desenho do Tachyon depende, e
> eu não as medi: cada braço custa uma chamada, o pi do autor está numa cota emprestada, e um `--help`
> não é medição. Ficam declaradas como declaração, não como fato.

### 3. As portas explícitas

| flag | entrega |
|---|---|
| `--skill <path>` | um arquivo ou diretório de skill |
| `--extension, -e <path>` | uma extensão (`-ne` não a bloqueia — a semântica está no próprio `--help`: *"explicit -e paths still work"*) |
| `--prompt-template <path>` | um template |
| `--theme <path>` | um tema |

**Não existe `--package <path>`.** Pacotes entram por `pi install`, e o código do Tachyon hoje passa
`--extension` para a família `packages` (cai no `else` final da cadeia de flags). O primeiro plugin que
trouxer `packages/` vai descobrir se isso está certo.

### 4. Por que o pi é o modelo que os outros deviam seguir

`-ne` está documentado como *"Disable extension discovery (**explicit -e paths still work**)"*. É a lei
inteira do isolamento numa linha de `--help`, escrita pelo próprio runtime: **negar a descoberta,
aceitar o caminho explícito.** Nenhum dos outros três diz isso tão claramente, e dois deles não fazem.


## Codex — a fazer

