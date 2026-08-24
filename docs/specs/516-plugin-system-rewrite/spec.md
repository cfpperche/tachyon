# 516 — plugin-system-rewrite

**Status:** shipped
**Owner:** cfpperche
**Created:** 2026-08-23

## Problema

O sistema de plugins tem **13.584 linhas** e faz muito mais do que o uso pede. Medido no catálogo
real de 17 plugins (`cfpperche/tachyon-plugins`):

| o que o manifesto declara | quantos dos 17 usam | o que custa |
|---|---|---|
| skills (payload, por convenção) | **17** | ~0 |
| `docsUrl` | 17 | uma string |
| `externalTools` (declara + detecta) | 8 | 282 linhas |
| `tools` — **Tachyon baixa e instala binário** | **3** | ~2.000 linhas |
| `data` — Tachyon baixa artefato | 2 | ~250 linhas |
| `blocks` (onde ficam os hooks nativos) | 2 | — |
| `gitHooks` | 2 | 419 linhas — **fora da v1** |
| `config` | 2 | — |
| `dependencies` | 2 | — |

A capacidade mais cara serve 3 plugins. Toda a porta de git — resolver endereço, clonar em tag
fixada, conferir checksum, calcular impressão digital de payload, checar atualização — serve uma
forma de instalar que o produto já substituiu por zip em apps (spec 514) e em plugins (spec 515).

E há três defeitos de desenho, não de implementação:

**1. Instalar contaminava o projeto.** Até a spec 515, instalar escrevia as skills em
`.claude/skills`, `.agents/skills` e `.grok/skills` para todo mundo, o que tornava a concessão por
agente decorativa. A 515 corrigiu o sentido de saída; o de **entrada** continua aberto por runtime.

**2. O lockfile existe para lembrar o que a instalação mesclou em arquivos compartilhados do
workspace.** Se nada é mesclado no workspace, ele não tem função — e com ele saem colisão
Keep/Replace, `createdAncestors`, guarda de fingerprint TOCTOU e o registro de aplicação.

**3. Nenhum plugin alcança o `pi`.** `SUPPORTED_RUNTIMES` do manifesto é `["claude","codex","grok"]`,
mas a projeção de capacidade entrega ao pi `extensions`, `prompts`, `themes` e `packages` desde o
MVP. O pi é atendível por concessão manual e inalcançável por plugin.

## A lei do sistema novo

> **O agente recebe exatamente o que foi concedido.** Nada que o plugin traz escapa para o projeto,
> e nada que está no projeto entra no agente sem ter sido concedido.

Na v1 essa lei não tem exceção. O único lugar onde um plugin escrevia fora da home de um agente eram
os git hooks — e eles saem da v1 para voltar depois como **outro tipo de sistema**, porque é o que
são: uma contribuição ao repositório, que dispara para qualquer ator, e não uma capacidade de um
agente. Misturar as duas coisas num manifesto só era conveniente.

O isolamento é de mão dupla, e o segundo sentido é o que estava faltando ser dito. Ele não é
invenção desta spec — é a generalização de três correções que já existem, medidas:

| runtime | como o projeto contamina o agente | o mecanismo que já existe |
|---|---|---|
| **pi** | descobre recursos do ambiente | `--no-extensions --no-skills --no-prompt-templates --no-themes`, e cada concedido entra por `--skill <caminho>` |
| **grok** | `GROK_HOME` redirecionado **não** basta: medido na 0.2.112, um `.claude/skills/*` do projeto continua sendo listado | bloco `[compat.*] = false` (t-26f508) |
| **codex** | descobre de `<cwd>/.agents/skills` e `~/.agents/skills` | `[[skills.config]] enabled=false` por path, medido na 0.149.0 (t-ef3c1f) |
| **claude** | `CLAUDE_CONFIG_DIR` privado isola auth/settings/plugins/transcripts, mas **não** a descoberta: medido na 2.1.241, `project=[<cwd>/.claude/skills]` é enumerado e carregado | **não há mecanismo por item** — `--bare` fecha tudo mas exige `ANTHROPIC_API_KEY` (sem OAuth), e `--disable-slash-commands` mata também o que foi concedido |

O `pi` é o modelo: **negar tudo, passar o concedido por caminho explícito** — e é a semântica
documentada da própria flag (`-ne`: *"Disable extension discovery (explicit -e paths still work)"*).

Onde o runtime oferece essa porta, é ela que se usa. Onde oferece supressão por item (codex), é ela.
Onde não oferece nem uma nem outra — **o claude** — resta a geografia: um agente cujo `cwd` é o
próprio worktree não tem projeto compartilhado para ser contaminado por. Três mecanismos diferentes
para uma lei só, porque a descoberta é do runtime e fingir simetria esconderia qual deles garante o
quê.

## Acceptance criteria

- [x] **Scenario: instalar um plugin não toca no projeto**
  - **Given** um workspace sem `.claude`, `.agents`, `.grok`
  - **When** eu instalo um plugin por zip
  - **Then** nenhum desses diretórios é criado, o payload fica em `.tachyon/plugins/<nome>/`, e não
    existe nenhum outro arquivo de registro

  → dogfood `plugin-system-v2`: "nenhum dos três diretórios de runtime foi criado" e ".tachyon contém só [plugins]"
- [x] **Scenario: desinstalar é apagar a pasta**
  - **Given** um plugin instalado
  - **When** eu removo
  - **Then** `.tachyon/plugins/<nome>/` deixa de existir, e nada mais precisou ser consultado para
    saber o que remover

  → dogfood: "desinstalar apagou a pasta e nada mais precisou ser consultado"
- [x] **Scenario: um plugin alcança o pi**
  - **Given** um plugin cujo payload traz `prompts/` e `skills/`
  - **When** eu concedo ao agente pi
  - **Then** ambos chegam por caminho explícito na home dele, e nada mais do ambiente chega

  → dogfood: "prompts/ chega ao pi e a mais ninguém; skills/ chega aos quatro" + unit "SDD 428". SEM prova em agente pi vivo — ver `tasks.md`
- [x] **Scenario: o projeto não contamina o agente**
  - **Given** uma skill escrita à mão em `<workspace>/.agents/skills/intrusa`
  - **When** um agente codex sem concessão para ela sobe
  - **Then** ela é desligada pelo CAMINHO, descoberto no launch — não por uma lista de nomes
    conhecidos — e o agente não a vê

  → unit "516: um agente SEM CONCESSÃO NENHUMA suprime toda skill solta no projeto", rodado também com nomes inexistentes no produto para provar que não há lista
- [x] **Scenario: o claude em worktree não vê a skill do projeto compartilhado**
  - **Given** a mesma skill intrusa no checkout compartilhado
  - **When** um agente claude com worktree próprio sobe
  - **Then** o `project=` que ele enumera é o worktree dele, e a intrusa não está lá

  → medido no agente vivo do autor com `--debug-file` (log novo por braço)
- [x] **Scenario: o que foi concedido chega inteiro**
  - **Given** um agente com concessão de uma skill de plugin, em cada um dos quatro runtimes
  - **When** ele sobe
  - **Then** a skill está legível na home dele, e o digest confere com o que a concessão atesta

  → medido em 2026-08-24 nos três agentes vivos (claude, codex, grok), `diff -rq` limpo nos três
- [x] O manifesto tem no máximo seis campos, e o resto do payload é convenção de diretório
  → seis: `name`, `version`, `description`, `docs?`, `runtimes?`, `requires?`
- [x] Não existe lockfile de plugins
  → guardado por `test/unit/noLockfileByPath.test.ts`
- [x] Não existe caminho de código que baixe binário ou artefato declarado por um plugin
  → grep por `https://`/`git clone`/`fetch(` em código de plugin: vazio
- [x] Não existe caminho de código que resolva endereço de git para instalar um plugin
  → idem
- [x] Nenhum caminho de código de plugin escreve fora de `.tachyon/plugins/` e da home de um agente
  → as únicas escritas são o catálogo e `materialize*Home`
- [x] O sistema antigo foi apagado, não desativado

## Non-goals

- **Migrar os 17 plugins.** O repositório `cfpperche/tachyon-plugins` fica intocado. O sistema novo
  nasce com **um** plugin reescrito (`sdd`); os outros migram um a um, quando forem precisos, com o
  caso concreto na mão em vez de um mutirão às cegas.
- **Endurecer segurança.** A decisão do dono é explícita: simples primeiro, segurança conforme a
  necessidade aparecer. Esta spec REDUZ garantias em um ponto nomeado (abaixo) e não adiciona
  nenhuma.
- **Provisionar binário.** Sai. Quando o `agent-browser` for preciso, decide-se ali entre declarar a
  dependência externa ou trazer a maquinaria de volta com o uso na frente.
- **Checar atualização.** Sem origem remota, não há o que re-resolver.
- **A porta de exportação para o workspace** (o `Apply` da 515). O sistema novo não a tem.
- **Git hooks.** Saem da v1 inteiros — manifesto, registro, dispatcher. Voltam depois como um sistema
  próprio, com o vocabulário de quem contribui para um repositório em vez do de quem estende um
  agente. Os dois plugins que os usam (`secrets-guard`, `verify-gate`) ficam sem instalar até lá,
  como os outros quinze.

## A garantia que se perde, dita com todas as letras

O `tools` do `agent-browser` carrega um `launchPolicy` — `scrubEnv`, `denyArgs`, `mode: force` — e é
ele que faz `allowedDomains` ser realmente do humano e não negociável pelo agente. Sem
provisionamento, o binário passa a ser o do operador, no PATH dele, e o que resta afirmando a
política é o texto da skill. É redução de garantia, não de conveniência, e está aqui para ser
escolha e não surpresa.

  → 21.605 linhas removidas em 9b3f2c4e
## Closure

**Closure:** entregue nas versões 0.93.56 → 0.93.62. O sistema antigo foi **apagado** (21.605 linhas,
commit `9b3f2c4e`) e o novo ocupa cerca de 1.400. Um plugin passou a ser uma pasta em
`.tachyon/plugins/<nome>/` com um manifesto de seis campos; **não há lockfile** — o disco é o
registro, e `test/unit/noLockfileByPath.test.ts` é o guarda que impede o lockfile de voltar por um
caminho literal invisível ao compilador (foi assim que ele sobreviveu à primeira remoção).

A lei da spec — *o agente recebe exatamente o que foi concedido; nada do plugin escapa para o
projeto, e nada do projeto entra no agente sem ter sido concedido* — está medida nos dois sentidos
nos agentes vivos do autor em 2026-08-24: o `sdd` concedido a claude, codex e grok chegou
**byte-idêntico** em cada home privada, e a `intrusa` escrita à mão no checkout **não** chegou a
quem não a recebeu.

Três coisas que o caminho ensinou e que valem mais que o código:

1. **O isolamento estava invertido.** A supressão vivia dentro de um `if (capabilities)`: quem não
   tinha concessão nenhuma não ganhava supressão nenhuma e enxergava o projeto inteiro. Quem foi
   concedido de MENOS ficava isolado de MENOS. Corrigido com `EMPTY_CAPABILITY_PROJECTION` na
   0.93.61.
2. **Listar não é entregar.** `grok inspect` mostra `.claude/skills` como `[disabled]`, o que me fez
   declarar um buraco que não existia; com controle positivo, `[compat.claude] skills = false` fecha
   de verdade. Um instrumento que fala sobre a intenção do runtime não substitui um que observa o
   que o agente recebeu.
3. **Autorrelato de modelo é instrumento ruim.** No pi, com as portas FECHADAS ele listou MAIS
   skills que com elas abertas, e um controle positivo (`--skill` explícito) falhou. A linha ficou
   **em branco** no mapa em vez de virar um fato inventado.

**O fechamento achou um bug que a spec inteira não tinha achado**, e vale mais que o fechamento. O
drift-check, rodado com as checagens pagas, acusou "hooks do codex não disparam". Investiguei o
INSTRUMENTO primeiro e ele estava mesmo errado — apendava o hook no fim de um `config.toml` que já
tinha `[[skills.config]]`, e em TOML toda chave depois de um cabeçalho pertence àquela tabela.
Corrigido o check, o hook disparou. Só que a MESMA regra condenava o produto por outro caminho:
`appendCodexHooksConfig` também apendava no fim, e no fim sempre havia o `[projects."<ws>"]` do
trust. Medido com `codex exec` real nos dois braços, na home escrita pelo produto, variando só a
posição da linha: **antes da tabela dispara, depois não**. Ou seja, hook concedido a agente codex
nunca funcionou — o runtime sobe, não reclama, e o hook não existe. Corrigido para inserir antes do
primeiro cabeçalho, guardado por um caso de unidade, e registrado em
`docs/runtime-capability-loading.md`. O instrumento errado foi o que revelou o produto errado.

O que ficou de fora, dito com nome: **nenhum agente pi vivo já recebeu um plugin** — a entrega ao pi
está provada em unit e em dogfood, no código que roda de verdade, mas não existe agente pi neste
workspace para fechar o círculo. Git hooks saíram inteiros da v1. Os dezessete plugins antigos
continuam no repo, intocados, para migrarem quando forem precisos — não foram apagados.

O mapa de como cada runtime carrega skills, hooks e MCPs virou documento
(`docs/runtime-capability-loading.md`) e, mais importante, virou **executável**:
`scripts/dogfood/runtime-drift.ts` re-mede 12 fatos e falha quando um runtime muda de ideia. O
desenho antigo assumia que `$CODEX_HOME/skills` não era lido; entre 0.146.1 e 0.149.0 passou a ser.
Foi isso que motivou o drift-check: a premissa envelheceu em silêncio.
