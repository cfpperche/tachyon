# Runbook — criar, atualizar e instalar um plugin

_Reescrito em 2026-08-24 para o sistema da spec 516. A versão anterior (de 2026-08-09) descrevia o
sistema antigo — tags de git, `plugins.lock.json`, `github:owner/repo@v2.4.0#path=nome` — e nada
daquilo existe. O git guarda o texto antigo._

Cobre o repositório **`cfpperche/tachyon-plugins`** (checkout local em `/home/goat/tachyon-plugins`) e
como o Tachyon consome um plugin hoje.

## O que é um plugin

Uma pasta. Ela tem um manifesto de seis campos e o resto é **convenção de diretório**:

```
meu-plugin/
  tachyon-plugin.json
  skills/<nome>/SKILL.md      os quatro runtimes
  extensions/<nome>/          pi   (index.ts | index.js na raiz)
  prompts/<nome>/             pi
  themes/<nome>/              pi
  packages/<nome>/            pi
  hooks/<runtime>/            claude, codex, grok
  mcp.json                    servidores MCP
  config/                     arquivo que o humano edita
```

```json
{
  "name": "sdd",
  "version": "2.0.0",
  "description": "spec-driven development: intent before code, in living documents",
  "docs": "https://github.com/cfpperche/tachyon-plugins",
  "runtimes": ["claude", "codex"],
  "requires": ["ffmpeg"]
}
```

`name`, `version` e `description` são obrigatórios. Os outros três não:

- **`docs`** vira o botão Docs do card.
- **`runtimes`** é um ESTREITAMENTO. Ausente significa "todos os que conseguem consumir o que este
  payload traz" — um plugin só com `skills/` serve os quatro. Declarar só faz sentido quando o autor
  sabe algo que o payload não diz ("esta skill é escrita no idioma do codex").
- **`requires`** são ferramentas externas que precisam existir no `PATH`. O Tachyon **detecta e
  informa**; nunca instala. O card mostra qual falta.

Um campo do formato antigo (`tools`, `data`, `blocks`, `externalTools`, `dependencies`, `docsUrl`,
`config`, `gitHooks`) faz o plugin ser **recusado pelo nome do campo**, com o que fazer no lugar.

## Antes de publicar: valide com o carregador de verdade

```sh
node <extensão>/dist/plugin-validate.cjs /home/goat/tachyon-plugins/sdd
```

```
ok  sdd@2.0.0  serves [claude, codex, grok, pi]  carries skill:sdd, prompt:nova-spec  (…)
```

Ele chama `loadPlugin`, a MESMA função que a instalação chama — não uma cópia do schema. É o que
impede um pacote de ser publicado num formato que o Tachyon recusa: o `verify-gate` 1.0.0 subiu
ininstalável exatamente por não haver essa checagem.

Um pacote que não traz nenhuma capacidade é recusado aqui, e não depois: publicar o silêncio é pior
que não publicar.

## Publicar = empacotar um zip

Não há tag a cortar, nem endereço a resolver, nem checksum a conferir. A instalação é por arquivo:

```sh
cd /home/goat/tachyon-plugins
zip -r ~/Downloads/sdd-2.0.0.zip sdd -x '*/.git/*'
```

O manifesto pode estar **na raiz** do arquivo ou dentro de **uma única pasta** — que é o que todo
"baixe esta release" produz. Duas pastas com manifesto é recusado pelos dois nomes, nunca adivinhado.

## Instalar

Aba **Plugins** → **Install from zip**. O seletor abre nos `.zip` que estão por perto (o projeto,
`~/Downloads`, `~/Desktop`, `/tmp`) e navega dali; o **Browse…** ao lado entrega ao diálogo do sistema
quando você prefere clicar.

Um `.zip` que é um pacote de APP não aparece na lista: a varredura lê o diretório central do arquivo
e classifica pelo manifesto que ele carrega. Um arquivo que não deu para ler continua sendo oferecido
— recusa de leitura não é evidência sobre o conteúdo.

O que a instalação faz: descompacta em `.tachyon/plugins/<nome>/`. **Só isso.** Ela não cria
`.claude/skills`, `.agents/skills` nem `.grok/skills`, não escreve no `settings.json` do seu projeto,
não mexe no `.mcp.json` e não deixa arquivo de registro nenhum. O diretório É o registro.

Reinstalar substitui o diretório inteiro (a troca é atômica: nunca existe uma janela em que o plugin
não existe). Desinstalar apaga a pasta — e **revoga antes** as concessões que apontam para ela, porque
apagar primeiro deixaria agentes com concessão para um payload que não existe mais.

## Injetar num agente

Instalar não dá o plugin a ninguém. Isso é uma segunda decisão, por agente:

**Agent Studio → o agente → Tachyon plugins → Authorize.**

Autorizar concede **tudo** o que o plugin expõe para aquele runtime. Um plugin que traz algo que
nenhuma concessão carrega hoje (um hook nativo, um servidor MCP) é recusado **inteiro**, com o motivo
— conceder metade reportaria sucesso enquanto metade nunca chega.

A concessão é fixada no digest do payload. Se o payload mudar depois, o launch **recusa pelo nome** em
vez de entregar outra coisa, e o card mostra `autorizado em 2.0.0, agora 2.1.0`.

O que um agente vivo recebeu não muda: ele fica com a cópia com que nasceu até o próximo launch.

## Migrar um plugin do formato antigo

Um por vez, quando precisar dele. O repositório fica intocado até lá.

1. `docsUrl` → `docs`; `externalTools` → `requires` (só os nomes).
2. `blocks: {claude: "claude/"}` → mova a pasta para `hooks/claude/`.
3. `config: {file: "…"}` → mova para `config/`.
4. `tools` (binário baixado) → declare a ferramenta em `requires`. **Isto reduz uma garantia**: o
   invólucro que fazia a lista de domínios do `agent-browser` ser inegociável pelo agente vinha do
   provisionamento. Sem ele, o que afirma a política é o texto da skill.
5. `data` → traga o arquivo no payload, ou declare a ferramenta que o baixa.
6. `dependencies` → diga na `description` o que precisa ser instalado antes.
7. `gitHooks` → **fora da v1.** Voltam como um sistema próprio, porque é o que são: contribuição ao
   repositório, que dispara para qualquer ator, e não capacidade de um agente.

Valide, empacote, instale.
