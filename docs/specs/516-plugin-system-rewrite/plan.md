# 516 — plugin-system-rewrite — plan

_Da `spec.md`, 2026-08-23. A abordagem, não os passos._

## Approach

Reescrever ao lado, não evoluir. O sistema antigo fica intacto e funcionando até o novo instalar o
`sdd` e entregá-lo aos quatro runtimes; então o antigo sai de uma vez. Evoluir 13.600 linhas para
~3.000 é a mesma reescrita, só que sem poder comparar as duas enquanto se duvida.

Três movimentos.

**1. O manifesto encolhe e a convenção assume.** Seis campos, e o payload diz o resto por onde os
arquivos estão. `blocks` existe hoje só para declarar onde fica a pasta de hooks — convenção mata o
campo. O mesmo vale para skills, que já eram convenção.

**2. A concessão vira o único vocabulário.** Hoje há dois registros do que existe: o que a instalação
escreveu (lockfile) e o que o agente recebeu (`agent.yml`). Com a instalação não escrevendo nada fora
de `.tachyon/plugins/<nome>/`, o primeiro perde a função. O disco passa a ser o registro.

**3. O isolamento vira lei, por runtime, com o mecanismo que cada um oferece.** O `pi` mostra a forma
certa e já a implementa.

## Key decisions

- **O `pi` é o modelo, e isso foi medido, não escolhido por gosto.** Ele nega tudo por argv
  (`--no-extensions --no-skills --no-prompt-templates --no-themes`) e recebe cada concedido por
  caminho explícito (`--skill <path>`, `--extension <path>`, …), a partir de uma área privada sob a
  home (`.tachyon-resources/<kind>/<name>`). Não há nada a suprimir por nome, nada a mesclar, nada a
  lembrar entre um launch e o próximo. Onde um runtime não oferece essa porta, cai-se no par
  materializar+suprimir — que é o que codex e grok já fazem. Rejeitado inventar um mecanismo próprio
  e uniforme: a uniformidade seria nossa, a descoberta é do runtime, e um adaptador que finge
  simetria esconde qual runtime realmente garante o quê.

- **Não existe lockfile.** Ele registrava o que a instalação mesclou em arquivos compartilhados do
  workspace — a única informação que não se deriva do disco. Sem essas escritas, `.tachyon/plugins/`
  é o catálogo: cada pasta tem seu manifesto, e desinstalar é apagar a pasta. Rejeitado manter um
  catálogo "leve": um índice que duplica o que o disco já diz é uma segunda verdade a manter em
  sincronia, e o incidente que a 515 mediu neste workspace foi exatamente isso — o registro afirmava
  seis diretórios de skill, o disco tinha um.

- **`runtimes` é opcional, e a ausência significa "todos que conseguem consumir o que este payload
  traz".** Um plugin só com `skills/` serve os quatro; um com `hooks/claude/` serve claude. Declarar
  passa a ser um estreitamento deliberado do autor ("esta skill é escrita no idioma do codex"), não
  cerimônia obrigatória. Rejeitado derivar sempre: o autor às vezes sabe algo que o payload não diz.

- **Baixar binário sai; declarar dependência externa fica.** `tools` serve 3 dos 17 e custa ~2.000
  linhas; `externalTools` serve 8 e custa 282, porque só detecta e informa. O novo `requires` é o
  segundo, com nome mais curto. Rejeitado manter os dois "por enquanto": manter é o custo, não a
  decisão de apagar.

- **Git hooks saem da v1 inteiros, e voltam como outro sistema.** Eles eram a única exceção à lei do
  isolamento, e a exceção existia porque um git hook que não está no repositório não é um git hook.
  Mas isso é a descrição de uma coisa DIFERENTE: uma contribuição ao repositório, que dispara para
  qualquer ator — humano, agente, CI — e não uma capacidade concedida a um agente. Estavam no mesmo
  manifesto por conveniência, não por parentesco. Rejeitado mantê-los "porque já funcionam": carregar
  419 linhas de registro, dispatcher gerado, ownership de `core.hooksPath` e trava de repositório
  dentro de um sistema cuja lei é "nada sai da home do agente" custaria a lei inteira, para servir
  dois plugins que o dono já concordou em migrar depois. O código sai com o resto; o git guarda cada
  byte, e o sistema futuro lê `gitHookRegistry.ts` no histórico como referência em vez de herdá-lo.

- **A porta de exportação para o workspace (o `Apply` da 515) não é portada.** ~250 linhas com o
  registro que a acompanha, escrita ontem, nunca usada. Rejeitado portá-la "porque acabou de ser
  feita": o custo afundado é do commit, não do sistema novo. Se um dia uma ferramenta de fora
  precisar ver a skill no projeto, ela volta com o caso concreto na mão.

## O manifesto novo

```json
{
  "name": "sdd",
  "version": "2.0.0",
  "description": "spec-driven development",
  "docs": "https://…",
  "runtimes": ["claude", "codex", "grok", "pi"],
  "requires": ["ffmpeg"]
}
```

`name`, `version`, `description` obrigatórios. `docs`, `runtimes`, `requires` opcionais.

## O payload, por convenção

```
skills/<nome>/SKILL.md        os quatro runtimes
extensions/<nome>/            pi          (index.ts | index.js na raiz)
prompts/<nome>/               pi
themes/<nome>/                pi
packages/<nome>/              pi
hooks/<runtime>/              claude, codex, grok
mcp.json                      servidores MCP
githooks/<evento>             a única coisa que toca o repositório
config/                       arquivo que o humano edita
```

O tipo implica quem consegue consumir. Um payload com `extensions/` e um `runtimes: ["claude"]`
declarado é um erro do autor, e é recusado pelo nome no load.

## Files touched

**Novo** — `packages/engine/src/plugins2/` (nome de trabalho; vira `plugins/` quando o antigo sair)

| caminho | o quê |
|---|---|
| `manifest.ts` | seis campos + a leitura do payload por convenção (~200 linhas, contra 1.087) |
| `install.ts` | descompactar em `.tachyon/plugins/<nome>/`, e apagar a pasta para remover |
| `catalog.ts` | ler `.tachyon/plugins/` — o disco como catálogo |
| `deliver.ts` | o que uma concessão materializa, por runtime, usando o mecanismo de cada um |

**Apagado ao final da última fatia** — `apps/vscode-extension/src/plugins/*` (engine.ts 2.732,
toolProvisioning 801, toolProvisionRun 567, gitHookRegistry 419, toolLauncher 370, fetcher 300,
externalTool 282, consentViewModel 280, appliedState 257, source 235, dataLauncher 179, toolPlatform
177, gitRepo 120, mcpConfig 99, toolPlan 92), `packages/engine/src/plugins/{manifest,lockfile}.ts`.

**Alterado** — `PluginsPanel.ts` e o webview de Plugins encolhem para: listar, instalar por zip,
remover, abrir docs. `packages/engine/src/plugins/agentDest.ts` perde `WORKSPACE_DESTS` e fica só com
a parte de home de agente.

## Risks & unknowns

**R1 — `<cwd>/.claude/skills` sob `CLAUDE_CONFIG_DIR` redirecionado: não medido.** Se o claude
descobrir skills do projeto mesmo com a home privada, falta um mecanismo de supressão para ele e o
segundo sentido do isolamento fica incompleto num dos quatro. **Medir antes de escrever a lei na
spec** — é a primeira tarefa da fatia 1, e o resultado muda o texto, não só o código.

**R2 — O `pi` nunca recebeu um plugin.** A projeção sabe entregar suas quatro famílias, mas nenhum
plugin jamais as produziu. O primeiro plugin que trouxer `prompts/` é o primeiro teste real desse
caminho, e é razoável que ele quebre em detalhes (nome do recurso, forma do diretório).

**R3 — Os 17 plugins param de instalar.** É esperado e é a decisão do dono: o repositório fica
intocado e cada um migra quando for preciso. O que **não** pode acontecer é o sistema novo aceitar um
manifesto antigo pela metade — recusa pelo nome do campo que não existe mais, dizendo o que fazer.

**R4 — `agent-browser` perde o `launchPolicy`.** Registrado na spec como perda de garantia nomeada.

## Sources consulted

- `packages/engine/src/plugins/manifest.ts:211` (os nove campos de hoje)
- `packages/engine/src/harness/HarnessManager.ts:1461-1466, 1960-1995` (o modelo do pi: negar por
  argv, passar por caminho explícito)
- `packages/engine/src/harness/HarnessManager.ts:962-985` (o bloco de isolamento do grok, medido)
- `packages/engine/src/harness/HarnessManager.ts:1727-1800` (a descoberta e a supressão do codex)
- `packages/engine/src/config/agentProfileResolver.ts:108-126` (a projeção, e as quatro famílias pi)
- `/home/goat/tachyon-plugins/*/tachyon-plugin.json` (o que os 17 realmente declaram)
- specs 514 (apps por zip), 515 (entrega única), t-ef3c1f, t-26f508, t-318d7d
