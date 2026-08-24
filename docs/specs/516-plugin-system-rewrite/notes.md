# 516 — notes

## Fatia 0 — as duas medições (2026-08-24)

Ambas feitas **sem gastar uma chamada de API**: o log de descoberta do claude sai antes da
autenticação, então uma chave inválida basta para lê-lo.

### T1 — o claude É contaminado pelo projeto, mesmo com a home privada

Instrumento: `claude --debug --debug-file <log> -p hi`, com `CLAUDE_CONFIG_DIR` apontando para uma
home privada e uma skill plantada em `<cwd>/.claude/skills/intrusa`. Claude Code 2.1.241.

```
Loading skills from: managed=/etc/claude-code/.claude/skills,
                     user=<CLAUDE_CONFIG_DIR>/skills,
                     project=[<cwd>/.claude/skills]
Loaded 2 unique skills (2 unconditional, managed: 0, user: 1, project: 1, additional: 0)
```

`project: 1` é a `intrusa`. **Redirecionar `CLAUDE_CONFIG_DIR` não fecha a descoberta do projeto** —
exatamente o mesmo achado que a t-26f508 fez no grok, agora no claude.

**Instrumento descartado antes desse:** `claude plugin list` respondeu "No plugins installed" tanto
para a skill do projeto quanto para a da home privada. Se eu tivesse concluído dali, teria concluído
o oposto do verdadeiro a partir de uma resposta vazia que não media nada — `plugin list` não cobre
skills descobertas por diretório.

### T1b — o claude TEM a porta de negar tudo, e ela custa a autenticação

Com `--bare`:

```
[reduced mode] Skipping skill dir discovery
getSkills returning: 0 skill dir commands, 0 plugin skills, 40 bundled skills
```

Funciona. Mas `--bare` também impõe: *"Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper
via --settings (OAuth and keychain are never read)"*. Agente de assinatura não sobe assim.

E não existe controle fino: `--disable-slash-commands` desliga **todas** as skills, `--safe-mode`
desliga tudo. Ou seja, toda porta de negar do claude também mata o que FOI concedido.

**Consequência de desenho:** para o claude, o único fechamento viável da direção de entrada é **não
compartilhar o `cwd`** — o agente em worktree próprio. Não há mecanismo por item.

### T2 — o `pi` é o modelo, e ele diz isso nas próprias flags

```
--no-extensions, -ne     Disable extension discovery (explicit -e paths still work)
--no-skills, -ns         --no-prompt-templates, -np      --no-themes
--extension, -e <path>   --skill <path>   --prompt-template <path>   --theme <path>
--no-context-files, -nc  Disable AGENTS.md and CLAUDE.md discovery and loading
--no-approve, -na        Ignore project-local files for this run
```

"Negar a descoberta, aceitar o caminho explícito" é literalmente a semântica documentada de `-ne`. O
pi ainda vai além do que a spec pedia: `--no-context-files` e `--no-approve` fecham AGENTS.md,
CLAUDE.md e arquivos locais do projeto.

Detalhe medido: **não existe `--package <path>`**. Pacotes entram por `pi install`, e o código atual
da Tachyon passa `--extension` para a família `packages` (o `else` final da cadeia de flags). O
primeiro plugin que trouxer `packages/` vai descobrir se isso está certo.

## A tabela final do isolamento, com o que cada medição custou

| runtime | entrada (o projeto contamina?) | como fecha | medido |
|---|---|---|---|
| **pi** | sim, por descoberta | `--no-*` + caminho explícito | 0.84.2, hoje |
| **grok** | sim (`.claude/skills` do projeto é listado) | `[compat.*] = false` | 0.2.112, t-26f508 |
| **codex** | sim (`<cwd>/.agents/skills`, `~/.agents/skills`) | `[[skills.config]] enabled=false` por path | 0.149.0, t-ef3c1f |
| **claude** | **sim** (`project=[<cwd>/.claude/skills]`) | **não há mecanismo por item** — só o `cwd` privado | 2.1.241, hoje |

Dois runtimes fecham por configuração, um fecha por argv, e um só fecha por geografia.

## Fatias 1–3 — o que a implementação encontrou

**Um erro meu, pego antes de virar bug de produção.** A primeira versão de `grantable.ts` calculava o
próprio hash da árvore para preencher o `sha256` da reference. Isso teria produzido concessões que a
autorização recusa no launch por `digest-mismatch` — plugin instalado, concedido, e nunca entregue,
com a mensagem apontando para o lugar errado. O número que vale é o de
`inspectCapabilitySourceAtRoot`, porque é ele que o launch recalcula. Trocado, e há um teste que
compara os dois lado a lado exatamente para que ninguém reinvente esse número.

**`pi-prompt` e `pi-theme` não pedem grant, e isso é desenho e não buraco.** O enum de
`capabilityGrants` lista `["skill","mcp","hook","pi-extension","pi-package"]` e omite os dois — o que
parecia uma lacuna. Não é: `addPi(..., "prompts", undefined, ...)` passa `undefined` como kind de
grant de propósito. `extensions` e `packages` são CÓDIGO que passa a rodar dentro do agente e por
isso são custodiados; `prompts` é um `.md` e `theme` é um JSON, validados pela forma e entregues como
dado. `grantable.ts` só relata essa divisão em vez de ter uma segunda opinião sobre ela.

**A entrega não foi reescrita, e não devia ser.** O `HarnessManager` já materializa cada capacidade
pelo mecanismo do runtime. O que faltava era o mapa: para um plugin instalado, quais entradas de
`references` um perfil precisaria carregar. `grantable.ts` é esse mapa — 90 linhas, nenhum motor.

**Contagem parcial:** manifest 210, catalog 90, install 130, viewModel 105, grantable 90 = **625
linhas**, contra 13.584 do sistema antigo. Falta a UI e o apagamento.

## Dogfood

`scripts/dogfood/plugin-system-v2.ts`, com o `sdd` real empacotado do fonte intocado:

```
ok — sdd 2.0.0 instalado, servindo [claude,codex,grok,pi]
ok — nenhum dos três diretórios de runtime foi criado
ok — sem lockfile: .tachyon contém só [plugins]
     o card diz: 1 skill, 1 prompt
ok — 2 capacidade(s) concedível(is), digest conferido contra a custódia
ok — prompts/ chega ao pi e a mais ninguém; skills/ chega aos quatro
ok — desinstalar apagou a pasta e nada mais precisou ser consultado
```

## T8 — a UI, e três coisas que a reescrita revelou

O painel foi de **1.117 para 356 linhas**, e o webview perdeu a gaveta de consentimento, o filtro, a
ordenação e o temporizador de 3 segundos. Nenhum deles sobrevive a "não há origem remota" e "instalar
não escreve": não há frescor a reconsultar, não há colisão a decidir, e uma lista de três plugins não
precisa de filtro.

### Uma regressão que eu ia entregar, e o teste que a pegou

Meu `remove` novo apagava a pasta e pronto. O teste do painel antigo dizia, no nome, o que faltava:
*"a successful remove revokes profile grants BEFORE deleting the payload"* (t-b1940c). Sem isso, um
agente com concessão para o plugin removido seria recusado no launch por `missing-reference` — estado
que o humano não pediu e não sabe desfazer. A ordem foi restaurada inteira, junto com a regra de que
uma revogação que **não completa** recusa a remoção: o plugin continua instalado, que é o estado do
qual ainda se pode sair.

Se eu tivesse apagado esse teste junto com o sistema antigo — que era a tentação, já que ele estava
escrito contra a gaveta de consentimento —, teria apagado a única coisa que documentava a ordem.

### Um teste que passava por coincidência

`controlStringsReachability` exige que toda string do catálogo seja referenciada como `.<chave>` num
app. A chave `openConfig` passava porque o App de plugins tinha um `dispatch.openConfig` — uma ação
sem nenhuma relação com a string "Open workspace settings". Apagado o App, a chave ficou órfã e o
teste finalmente disse a verdade: **nenhum app jamais renderizou aquela string.** Removida do catálogo,
do tipo e da fixture.

### Uma regra que reprovou um arquivo do lado certo

`workspacePresentationBoundary` exige que um painel seja tipado contra um seam de apresentação. O
`WorkspacePluginProfileTarget` **é** um (`extends WorkspaceGitPresentationTarget`), mas não estava na
alternância do regex — o painel antigo passava porque importava TAMBÉM o `GitPresentationTarget`.
Quando a reescrita deixou de precisar do segundo, a regra reprovou um arquivo que sempre esteve do
lado certo da fronteira. `PluginProfile` entrou na lista.

### E um número que dizia o contrário do nome do teste

`"PluginsApp still owns exactly one .ck-plugins-root"` afirmava `toBe(2)`, porque o App antigo abria
uma raiz no ramo de carregamento e outra no ramo carregado. O novo tem uma raiz só e decide o conteúdo
dentro dela. O número virou 1, e agora diz o que o nome sempre disse.

## Fatia 4 — o apagamento, e o que ele custou de verdade

**21.605 linhas removidas, 184 adicionadas.** O sistema de plugins inteiro — código de produto, testes,
fixtures e três entrypoints empacotados — contra **1.444 linhas** do novo (motor + painel + webview).

### O plano subestimou: três módulos do HARNESS liam o lockfile

Não eram resíduo do sistema antigo; eram features construídas em cima da premissa "instalar mescla
coisas no projeto e o lockfile registra o que é nosso".

**`agentHookProjection` (298 linhas, 6 consumidores).** Um workspace podia classificar o hook de um
plugin como `enforcement` e fazê-lo alcançar um agente isolado. Eu abri uma pergunta ao dono sobre
apagar ou religar — e a pergunta estava errada. Ele já tinha respondido: *hook é capacidade de runtime,
igual a skill; chega ao agente porque aquele agente recebeu, e vai para a home dele.* A engenhoca
existia para resolver "o plugin escreveu um hook no projeto, e agora preciso de uma regra especial
para ele alcançar um agente isolado" — um problema que o sistema novo torna **impossível**. Saiu com
`settings.agentHookProjection`, o schema publicado, e os 750 casos de `secretsGuardLayer2Projection`.

**`projectedInputs` (313 linhas).** Respondia "o Tachyon pôs isto aqui?" sobre caminhos do workspace,
para que a checagem de entradas ambientes do Grok deixasse passar o que o próprio produto tinha
escrito. Sem escrita, a checagem encolheu para "existe? então bloqueia" — **mais simples e mais
estrita**, que é a direção certa para uma regra cujo propósito é o agente não ser contaminado.

**`worktreeProjection`** só listava o lockfile entre os caminhos que uma worktree nunca projeta. Sem
lockfile não há segunda cópia possível para divergir.

### E `agentDest` encolheu 454 → 73

Todos os seus exports, menos um, eram usados **só pelo próprio teste**: o motor antigo era o único
consumidor real. Sobrou `restoreWorkspaceSkillDest`, que é a entrega ao codex.

### O que ficou de fora do apagamento, e por quê

- **`mcpServer.ts` (52 linhas)** — o tipo `McpServer` e a substituição de `${PLUGIN_ROOT}`, que os
  adaptadores de claude e codex ainda usam. É o que sobrou de um módulo de 417 linhas cujo resto
  sustentava mesclar servidores no `.mcp.json` do projeto.
- **`pluginValidateEntry`** — reescrito para o parser novo. Um autor confere o pacote com O carregador
  de verdade, e agora a validação olha o payload além do manifesto: um pacote que não traz nada não
  entrega a ninguém, e o autor tem de saber antes de publicar.

### Três testes que passavam por acidente do sistema antigo

Já registrados no T8 (a string `openConfig` alcançada por um `dispatch` sem relação, a fronteira de
apresentação que reprovava um arquivo do lado certo, e o `toBe(2)` que contradizia o nome do teste).
A fatia 4 acrescentou um quarto: `webviewPreviewPluginsFixture` comparava contra um JSON capturado com
seis estados de frescor. Sem origem remota não há frescor — a fixture virou três estados escritos à
mão, e o teste passou a segurar a FORMA em vez da captura.

## O buraco que a fatia 4 deixou, e que o compilador não podia ver (0.93.60)

Instalado o 0.93.59, o `sdd` entrou pela porta nova e nenhum diretório de runtime foi criado — a lei
valeu. Mas o **Agent Studio dizia "No Tachyon plugins are installed in this workspace"** com o plugin
instalado na tela ao lado.

Causa: `agentCapabilityCandidates.ts` lia `.tachyon/plugins.lock.json` por **caminho literal e
`JSON.parse`**, sem importar o módulo do lockfile. Apagar o módulo deixou o `tsc` verde e a função
retornando lista vazia para sempre.

**O apagamento foi verificado por quem não conseguia ver a coisa que sobrou.** É a lição do dia, e a
correção tem duas partes: a função passou a ler o catálogo (via `readCatalog` + `grantableReferences`,
a MESMA fonte que a concessão usa), e `noLockfileByPath.test.ts` virou o guarda — uma busca pelo nome
do arquivo em código, que é o tamanho certo do problema.

O guarda achou sozinho uma terceira sobra que eu não tinha visto: o `.gitignore` que o produto escreve
ainda reabria `!.tachyon/plugins.lock.json`, descrito como "receita de re-hidratação de um clone". Não
há receita porque não há transação — um plugin é uma pasta, e um clone que quer o plugin instala o zip.

### E um segundo silêncio, no mesmo lugar

Para o pi, o `prompts/nova-spec` **seria concedido e não aparecia na tela**: o card listava só o que era
`kind: "skill"`. Autorizar concede o plugin inteiro, então mostrar menos do que o botão entrega é o
mesmo tipo de defeito que o código ao redor passa a vida recusando. Agora lista toda capacidade
concedível, e nomeia a família quando não é skill (`nova-spec (prompt)`).

## O card, com o design system aplicado

As classes novas (`.pcard`, `.pcard-head`, `.pdesc`, `.prt`, `.plist`) subiram **sem folha de estilo** —
as antigas tinham outros nomes. Sem gap nenhum, o nome colava na versão (`sddv2.0.0`) e os quatro
runtimes viravam uma palavra só (`claudecodexgrokpi`).

Nada disso aparece numa asserção de DOM: `textContent` já era o texto certo, e a diferença estava só no
espaço. Por isso `pluginCardShots.test.ts` **mede distâncias** além de tirar o retrato — irmãos numa
linha têm de estar separados, e as ações têm de estar do outro lado do card.

A hierarquia é de três níveis, deliberada: QUEM é o plugin (nome + versão), O QUE faz (descrição), O
QUE traz (pastilhas + runtimes). Toda distância é um passo de `--ds-spacing-size*`.

Evidence: `.tachyon/visual-qa/516-plugin-card/` — 880 e 360, mais o estado quebrado.
Verdict: aprovado. Os três níveis leem, os runtimes ficam agrupados e separados das capacidades, e a
única linha colorida é a da ferramenta externa que falta — a única em que o humano precisa agir.

## T13 — o isolamento de ENTRADA estava invertido (0.93.61)

O dono plantou duas skills à mão em `.agents/skills/` do checkout compartilhado e reiniciou um codex
**sem concessão nenhuma**. O `config.toml` que o launch gerou não tinha uma única linha de supressão:
as duas chegavam nele.

**Causa, e ela é o avesso do que devia ser.** O bloco inteiro de isolamento de skill vivia dentro de
`if (capabilities)`, e `Workspace.ts:931` só passa capacidades quando o perfil tem
`profileCapabilities`. Um agente que não autorizou nada não tem projeção → o bloco não roda → nenhuma
linha é escrita → ele enxerga tudo o que estiver solto no projeto.

**Quem foi concedido de MENOS ficava isolado de MENOS.** Zero concessão não é "não tenho nada a
dizer": é a afirmação mais forte que existe — *suprima tudo o que descobrir*. A diferença entre as
duas leituras era um caminho de código que não rodava, e é exatamente o tipo de silêncio que esta spec
existe para acabar.

Corrigido com uma projeção vazia explícita (`EMPTY_CAPABILITY_PROJECTION`) em vez de um `if`. O ramo
do worktree continua exigindo projeção, e isso é deliberado: ali `materializeHome` já varre a árvore
inteira, e reconstruí-la vazia recriaria o diretório que a varredura acabou de remover. A perna que
faltava era a raiz do workspace, que ninguém varre porque não é nossa.

### O que a tela mostrou de certo, no meio disso

O Agent Studio listou a `intrusa` em **workspace skills** (autorizável, não autorizada) e o
`sdd@2.0.0` em **Tachyon plugins**. E não listou a `sdd` que o dono plantou à mão em
`.agents/skills/sdd`: ela é reivindicada pelo plugin de mesmo nome, mesmo com conteúdo divergente —
que é a regra escrita em `agentCapabilityCandidates` desde a t-5498a6 e continua valendo sobre o
catálogo.

### Sobre a prova vermelho/verde

Não consegui o vermelho limpo: guardar só o `HarnessManager` deixa o arquivo sem compilar (a projeção
vazia mora nele), então o teste é PULADO em vez de falhar. O que sustenta o caso é a medição no
workspace do autor — config sem supressão, duas skills plantadas 16 minutos antes do launch — e o
teste passa a defender o comportamento daqui para a frente.

## Dogfood log

### 2026-08-24T18:54:35Z — fail (1/2) — source: tasks.md — commit: bd50438cd5cf0f59cb6845cd7ea0db302910ae58
- `npx vite-node scripts/dogfood/plugin-system-v2.ts` — pass
- `npx vite-node scripts/dogfood/runtime-drift.ts` — fail

### 2026-08-24T19:07:46Z — pass (2/2) — source: tasks.md — commit: bd50438cd5cf0f59cb6845cd7ea0db302910ae58
- `npx vite-node scripts/dogfood/plugin-system-v2.ts` — pass
- `npx vite-node scripts/dogfood/runtime-drift.ts` — pass
