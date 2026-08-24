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
