# Sandbox contra git worktree, e política para agente que não coopera

_Task `t-730812`, pesquisa web 2026-08-12. “LIDA” abaixo é página aberta nesta rodada,
com data da fonte. “JÁ MEDIDO” aponta evidência nossa anterior, não reexecutada aqui.
Nada disto foi implementado. Não é proposta de lançamento._

## Veredito primeiro

**A pergunta 1 tem resposta: o conflito sandbox × worktree já foi resolvido, por três
caminhos distintos, e o Codex — o runtime que nós desligamos — ainda não tem porta
oficial.** O erro medido no `AgentManager.ts` (`Unable to create
'<repo>/.git/worktrees/<agent>/index.lock': Read-only file system`) é o mesmo que o
ecossistema Codex reporta desde novembro de 2025. Quem resolveu não foi a OpenAI.

1. **Claude Code documenta a solução no produto.** Quando o cwd é um linked worktree, o
   sandbox permite escrita no `.git` partilhado do repositório principal e continua a
   negar `hooks/` e `config`. A issue que descrevia exactamente o nosso `index.lock`
   (anthropics/claude-code#26262, 2026-02-17) está fechada.
2. **Gobby aplica o mesmo princípio no daemon:** torna graváveis
   `git rev-parse --git-dir` e `--git-common-dir`. Contrato verificado por eles em
   2026-05-19, com teste de worktree ligado.
3. **No Codex, um operador documentou um truque e outro produto abandonou o worktree.**
   gallon.me (2026-07-22) verificou commit sob `workspace-write` no Codex 0.144.6
   apontando `writable_roots` para o caminho *exacto* do gitdir (e do common-dir, no
   linked worktree). Multica (PR #5575, merged 2026-07-17) tentou alargar a raiz
   gravável, concluiu que o Codex remonta o gitdir como só-leitura, e passou a clonar
   com `.git` local à tarefa.

**Não há toggle oficial `allow_git_writes` no Codex.** Issues abertas até junho de 2026
pedem exactamente isso. `--add-dir` / `writable_roots` no *ancestral* `.git` não chega:
o sandbox remonta `<repo>/.git/worktrees/<nome>` como `ro` por cima. Bind-mount e
`GIT_DIR`/`--git-dir` para puxar o gitdir para dentro do cwd **não apareceram como
relato de quem resolveu**.

**A pergunta 2 é o resto.** Quando o runtime não pede permissão nem expõe hook, o que
existe hoje ou é proxy do canal MCP (não vê o Bash nativo), ou é motor de política no
loop do agente (não vê o syscall), ou é isolamento de processo/contentor (vê o
syscall, não vê a intenção). A tabela abaixo marca o buraco de cada um. Dois
orquestradores maiores que nós (Paseo, Orca) já tinham falhado o interceptor
pré-tool; isso continua verdade e não muda com esta pesquisa.

---

## O que já era nosso (não é descoberta desta rodada)

JÁ MEDIDO em `docs/research/t-c88c94-acp-injection.md`: 4 de 6 runtimes (Grok,
OpenCode, Codex, pi) executaram uma escrita sem `session/request_permission`. Claude e
Hermes pediram.

JÁ MEDIDO em `docs/research/t-1cb3f8-paseo-chat.md`: o “Auto Accept” do Paseo só
responde a um pedido que chegou. Não há interceptor anterior à tool.

JÁ MEDIDO no comentário de `src/agents/AgentManager.ts` (t-aaa2c6, Codex 0.146.0): sob
`workspace-write`, `git add` numa worktree Tachyon falha no `index.lock` porque o
gitdir vive fora do cwd. Com `approval_policy = "never"` isso vira falha dura, e por
isso o lançamento delegado usa `danger-full-access`.

Esta pesquisa não reabre essas medições. Pergunta se alguém, lá fora, já fez o sandbox
e o worktree coexistirem — porque isso reactivaria uma porta que o Codex já tem.

---

## Pergunta 1 — quem resolveu sandbox × git worktree

### 1. Claude Code: permitir o `.git` partilhado, negar hooks e config

LIDA, documentação oficial, 2026-08-12:
<https://code.claude.com/docs/en/sandboxing>

> “Git worktrees: when the working directory is a linked git worktree, the sandbox
> also allows writes to the main repository's shared `.git` directory so commands
> such as `git commit` can update refs and the index. Writes to `hooks/` and
> `config` inside that directory remain denied.”

A mesma afirmação está na página de worktrees
(<https://code.claude.com/docs/en/worktrees>): git no worktree escreve no `.git`
partilhado, e o sandboxing permite essas escritas. Isto é o caminho “permitir o `.git`
do repositório principal na política”, com a ressalva de segurança que o Codex também
cita (hooks graváveis executam *fora* do sandbox na próxima invocação humana).

A issue que descrevia o nosso defeito está fechada.

LIDA, anthropics/claude-code#26262, aberta 2026-02-17, estado Closed:
<https://github.com/anthropics/claude-code/issues/26262>

O relatório original:

- sandbox restringe escrita ao cwd;
- worktree (clone normal *e* bare) precisa de escrever git internals **fora** do cwd;
- `git add` / `commit` / `push` falham com `Unable to create '.../index.lock':
  Read-only file system`;
- `excludedCommands: ["git"]` não chega: a restrição de filesystem continua a
  aplicar-se às escritas internas do git;
- a chave inventada `sandbox.filesystem.write.additionalAllow` não existia.

A sugestão do reporter era exactamente a que o produto agora documenta: resolver
`git rev-parse --git-common-dir` e permitir escrita ali. Não li o patch interno
(Claude Code não publica o runtime), mas a combinação issue fechada + docs oficiais
que descrevem o comportamento é o relato de resolução mais forte desta pesquisa.

Limite do que isto cobre: o sandbox do Claude aplica-se ao Bash e aos filhos, não a
todas as tools. Edit/Write continuam no sistema de permissões. Um agente em
`bypassPermissions` ou com `dangerouslyDisableSandbox` sai da fronteira. A
documentação diz isso explicitamente.

### 2. Gobby: o daemon torna git-dir e git-common-dir graváveis

LIDA, guia interno, última verificação 2026-05-19:
<https://github.com/GobbyAI/gobby/blob/main/docs/guides/sandbox-compatibility.md>

Contrato actual:

> “Linked worktree Git metadata directories from `git rev-parse --git-dir` and
> `--git-common-dir` are writable so sandboxed agents can commit from worktree
> isolation.”

Há teste dedicado (`tests/agents/test_sandbox.py`) para “linked-worktree Git metadata
write access”. O daemon traduz isso por runtime: Claude recebe JSON de sandbox;
Codex recebe `--sandbox` + `--add-dir` para caminhos extra; Gemini/Qwen recebem
`--include-directories` no Seatbelt.

Isto é o mesmo desenho que o Claude documenta, aplicado a vários runtimes. Não
verifiquei o teste a correr. Vale como relato de quem implementou e testou o caminho
`git-dir` + `git-common-dir`, não como prova de que o `--add-dir` do Codex ainda
honra esses caminhos nas versões posteriores (ver §3 e §4).

### 3. Codex CLI: o truque do caminho exacto, sem toggle oficial

O Codex *protege* `.git` de propósito. LIDA, gallon.me, 2026-07-22:
<https://gallon.me/letting-codex-agents-commit-making-git-writable-in-the-workspace-write-sandbox.html>

No Linux, o bubblewrap monta as raízes graváveis em leitura-escrita e **volta a
aplicar `.git` (mais `.codex` e `.agents`) como só-leitura por cima**. Razão
declarada: um `.git/hooks` gravável planta um hook que corre *fora* do sandbox na
próxima vez que o humano invoca git. Não existe `allow_git_writes` no código. As
issues que pedem o toggle (#15505, #12280, #14338) não tinham resposta de maintainer
nessa data.

O que **não** funciona, medido pelo autor e pelas issues:

| Tentativa | Resultado | Fonte |
|---|---|---|
| Meter a raiz do repo em `writable_roots` | o carveout de `.git` aplica-se por raiz gravável | gallon.me; openai/codex#15505 (2026-03-23) |
| `--add-dir` no `.git` do repo principal | o resumo do sandbox *mostra* o `.git` como gravável, mas `git add` no worktree falha no `index.lock` | openai/codex#23661 (2026-05-20), testado 0.125–0.132 |
| perfil com `"/path/to/repo/.git" = "write"` | `findmnt` mostra `.git` `rw` e `.git/worktrees/<nome>` `ro` | openai/codex#27418 (2026-06-10), Codex 0.139.0 |
| `--add-dir` nas write dirs da linha de comando | o mount só-leitura do gitdir é aplicado *depois* e ganha | openai/codex#14338 (2026-03-11) |

O que **funcionou**, verificado pelo autor no Codex 0.144.6, Linux, commit
confirmado em `git log` (não só no auto-relato do agente): apontar
`writable_roots` para o caminho *exacto* do `.git`. A função
`append_default_read_only_path_if_no_explicit_rule` (citada de
`codex-rs/protocol/src/permissions.rs`) salta o carveout se já existir uma regra
explícita para aquele path.

No linked worktree são **dois** caminhos:

```
git rev-parse --absolute-git-dir          # .../.git/worktrees/<nome>
git rev-parse --path-format=absolute --git-common-dir   # .../.git
```

Um repo simples precisa só do primeiro. Um worktree precisa dos dois: o commit
escreve objectos e refs no common-dir. O autor testou os dois casos.

Caveats que o próprio artigo marca, e que importam:

- comportamento **não documentado**; um release futuro pode reproteger `.git`
  incondicionalmente;
- remove uma protecção real (hooks graváveis), não contorna um bug;
- a alternativa bruta é `danger-full-access`, que troca o sandbox inteiro por um
  directório.

Tachyon corre Codex 0.146.x. Esta pesquisa **não** reexecutou o truque nessa
versão. Entre 0.144.6 (artigo) e 0.146 não encontrei changelog oficial a fechar as
issues do gitdir. As issues 19786 (2026-04-26), 21869 (2026-05-08), 23661 e 27418
continuavam abertas quando as li. 21869 é mais grave que o `index.lock`: com
`network_access = true`, `git push` actualiza o remoto e *depois* falha a gravar
`refs/remotes/origin/*.lock`, saindo com código 0 — o efeito irreversível acontece
antes da escrita local protegida.

A documentação oficial do sandbox do Codex
(<https://learn.chatgpt.com/docs/sandboxing>, LIDA 2026-08-12) descreve
`workspace-write`, `writable_roots` e as políticas de aprovação. **Não menciona o
carveout de `.git`, nem worktrees, nem qualquer forma suportada de tornar o gitdir
gravável.**

A app desktop/cloud do Codex usa worktrees (`$CODEX_HOME/worktrees`) e “handles the
Git operations” (<https://learn.chatgpt.com/docs/environments/git-worktrees>). Isso
é outro ambiente: o produto faz o git *por* o agente, não o agente a fazer git
dentro de `workspace-write`. Não conta como resolução do conflito CLI.

Relatos que usam worktree + `workspace-write` sem documentar um `git add`
bem-sucedido (Firecrawl 2026-06-08, Steve Kinney 2026-06-04) não entram como
“resolvido”.

### 4. Multica: desistir do worktree e clonar

LIDA, issue #2925, 2026-05-20, fechada pelo PR #5575:
<https://github.com/multica-ai/multica/issues/2925>

Mesmo erro, mesmo runtime (Codex 0.131.0, `sandbox_mode = "workspace-write"`,
`approval_policy = "never"`). O checkout do Multica criava um worktree cujo gitdir
ficava no cache partilhado do daemon, fora da raiz gravável da tarefa. Ficheiros
editavam-se; `git add` / `commit` / `branch` falhavam.

LIDA, PR #5575, merged 2026-07-17:
<https://github.com/multica-ai/multica/pull/5575>

A decisão explícita:

> “Codex `workspace-write` deliberately reapplies `.git` and resolved
> linked-worktree gitdirs as read-only. Adding the shared cache as a writable
> root, as proposed in #2936, therefore does not restore Git writes and would
> widen the sandbox around cross-task state.”

Solução enviada: **modo de metadata Git isolada** só para Codex Linux. Clone local
sob o workdir da tarefa, `.git` da tarefa, `origin` apontado ao URL real. O cache
partilhado `.repos` fica só-leitura. Worktrees ligados pré-fix são migrados.

Isto é o caminho “clonar em vez de worktree”, com relato de produção e merge.
Custa disco e deixa de partilhar objectos/refs em tempo real. O PR seguinte
(#6449, 2026-08-05; fix #6565) mostrou que o modo isolado estava seleccionado só
por `GOOS == linux`: no Windows elevated sandbox o mesmo layout de worktree
voltou a falhar o `index.lock` no Codex 0.146.0. Outro PR (#6233) chegou a
propor `danger-full-access` como default Linux — o mesmo atalho que nós já
tomámos, por outra porta.

### O que não apareceu como relato de resolução

- **`GIT_DIR` / `--git-dir` para trazer o gitdir para dentro do cwd gravável.**
  Ninguém descreveu isto a funcionar sob sandbox de agente. O Claude Code, pelo
  contrário, *bloqueia* `git -C`, `--git-dir`, `GIT_DIR` e `GIT_WORK_TREE` que
  redireccionem para o checkout principal (docs de worktrees, LIDA 2026-08-12) —
  trata o redirect como fuga, não como cura.
- **Bind-mount do `.git` para dentro da worktree.** Sem relato.
- **Landlock / seccomp sozinhos a “entenderem” worktree.** O Codex já usa esses
  primitivos e mesmo assim remonta o gitdir. O primitive não resolve o conflito;
  a política de paths é que resolve.

### Quadro da pergunta 1

| Quem | Quando | Como | Relato de resolução? | O que não cobre |
|---|---|---|---|---|
| Claude Code | docs actuais 2026-08-12; issue #26262 de 2026-02-17 fechada | sandbox permite escrita no `.git` partilhado do linked worktree; nega `hooks/` e `config` | **Sim, no produto** | só Bash/filhos; Edit/Write e `dangerouslyDisableSandbox` saem |
| Gobby | contrato verificado 2026-05-19 | daemon grava `git-dir` + `git-common-dir` e traduz por runtime | **Sim, no contrato e no teste deles** | não provei contra Codex 0.146; Gemini/Qwen web-chat nem sequer levam Seatbelt completo |
| gallon.me / Codex CLI | 2026-07-22, Codex 0.144.6 | `writable_roots` no path *exacto* do gitdir (+ common-dir) | **Sim, commit verificado pelo autor** | undocumented; hooks passam a ser graváveis; não reexecutado em 0.146 |
| Multica | PR #5575 merged 2026-07-17 | abandonar worktree; clone com `.git` local à tarefa | **Sim, merge em produção** | não reutiliza worktree; Windows ficou de fora até #6565; partilha de objectos acaba |
| OpenAI Codex CLI | issues 2025-11 → 2026-06 ainda abertas | — | **Não.** Sem toggle oficial | `workspace-write` continua a romper git no worktree |
| Paseo / Orca | JÁ MEDIDO | — | **Não** (outra pergunta, mas confirma o padrão) | sem interceptor pré-tool |

**Resposta curta da pergunta 1:** alguém resolveu. O fornecedor do runtime que nós
desligámos não. Os dois desenhos que reactivam `workspace-write` sem largar o
worktree são (a) permitir o gitdir/common-dir e continuar a negar hooks/config, e
(b) nomear esses dois paths exactos na política de escrita do Codex. O terceiro
desenho desiste do worktree.

---

## Pergunta 2 — impor política a agente que não coopera

Premissa: o runtime não pede permissão e não corre hook. O agente tem Bash (ou
equivalente) nativo. Qualquer mecanismo que só veja um canal tem de declarar o
que esse canal não transporta.

### Tabela

| Mecanismo | Quem usa, com data | Custo | O que **não** pega |
|---|---|---|---|
| **Proxy / gateway MCP** | MCP Guardian (EQTY Lab, repo activo, anúncio 2025-02-21); Solo agentgateway (contribuição LF 2025-08-25; Enterprise 2025-10-15); Microsoft MCP Gateway (docs LIDA 2026-08-12) | um hop extra; identidade e política por tool MCP; no gateway da Microsoft, pods e sessão | **Não vê a tool Bash/Edit/Write do próprio agente.** Só o que passa por MCP. Um agente que `curl` ou `rm` pelo shell nativo atravessa. O Guardian diz-o na arquitectura: senta-se “between the LLM host and MCP servers”. |
| **Regex / denylist no builtin bash do orquestrador** | Microsoft MCP Gateway, `builtin:bash` (docs LIDA 2026-08-12) | barato; 30s/120s timeout, caps de I/O | **Eles próprios escrevem: “defense-in-depth, not a sandbox.”** Não pega encoding, interpreters, nem o Bash do runtime de coding. Recomendam substituir por pod/gVisor/firejail em multi-tenant. |
| **Pedido ACP / hook pré-tool do runtime** | Claude e Hermes pedem (JÁ MEDIDO t-c88c94); Paseo só responde se o pedido chegar (JÁ MEDIDO t-1cb3f8); Grok anuncia hooks no handshake mas a sonda escreveu sem pedir | zero infra extra se o runtime cooperar | **Não pega runtime que não chama.** Grok, OpenCode, Codex e pi executaram sem `session/request_permission`. Um handler nosso nesse método é observador, não portão. |
| **Motor de política / guardrail no loop do agente** | LlamaFirewall (Meta, paper/anúncio 2025-04-29 / 2025-05-06): PromptGuard 2 + AlignmentCheck + CodeShield; Invariant Guardrails (2025-04-17), depois Snyk (aquisição anunciada 2025-06-24); NeMo Guardrails | latência de um classificador por passo; precisa de ver o thought/tool call | **Não pega o que não passa pelo loop.** Se o runtime executa Bash sem emitir o tool call ao motor, o motor não decide. Também não pega syscall de um filho que o modelo já autorizou. É política de *intenção*, não de *efeito*. |
| **Scanner MCP (estático)** | Invariant MCP-Scan (2025-04-11); Snyk Agent Scan (fork/continuação, LIDA 2026-08-12) | scan de configs e descrições de tools | **Não é enforcement em runtime.** Não pega a invocação. Não pega Bash. Detecta tool poisoning / rug-pull na instalação. |
| **Wrapper do binário / sandbox de processo** (Seatbelt, bubblewrap, Landlock, seccomp) | Codex CLI (Seatbelt / bwrap+Landlock+seccomp); Claude Code `/sandbox` (Seatbelt / bwrap); `@anthropic-ai/sandbox-runtime` (`srt`, research preview, README LIDA 2026-08-12); Sandlock (Landlock+seccomp, 2026-03-14); Guillaume A envolveu o OpenCode inteiro em `srt` (2026-07-21), inclusive worktrees do Superset | um perfil por agente; no Linux, `bwrap`+`socat`; no Ubuntu 24.04, AppArmor de userns; Unix sockets no Linux são tudo-ou-nada (seccomp não lê o path) | **Não pega o que o perfil deixar gravável.** Se o gitdir não está na allow-list, volta a pergunta 1. Se `.` está na allow-list, o agente escreve tudo no worktree — incluindo um hook se o `.git` também estiver. **Não pega processo que o runtime lance *fora* do wrapper** (unsandboxed retry, `excludedCommands`, `dangerouslyDisableSandbox`). O `srt` documenta: domínio `github.com` permitido deixa fazer push para qualquer repo; `allowUnixSockets` para o socket do Docker é o host. |
| **Contentor / gVisor / microVM** | E2B (Firecracker, produção; comparativos 2026-06-12 / 2026-08-04); Daytona (Docker, Kata opcional); Modal (gVisor); Claude.ai usa gVisor (Willison citando Anthropic, 2026-05-30); Cowork usa VM (Virtualization.framework / HCS) | frio 100–800 ms; imagem/toolchain; persistência e credenciais são o custo real | **Não pega política *dentro* do guest.** O agente não-cooperativo tem o guest inteiro. Isola o *host*, não decide `git push` vs `git status`. Sem filesystem extra no guest, o conflito worktree × sandbox **nem sequer aparece** — e o host também não é tocado. Não serve se o agente tem de viver no checkout do dono. |
| **Hooks / skills / config.toml do runtime** | JÁ MEDIDO no journal da t-4d6e88 (não reaberto): o adapter Codex sobe `codex app-server` sem argumentos; `config.toml` e `hooks.json` do utilizador não são o caminho que o adapter executa | barato quando o runtime honra | **Não pega adapter que não os carrega.** Não pega agente que ignora o hook. Não é não-cooperativo: depende do runtime cooperar no lançamento. |

### Leituras que fixam os buracos

LIDA, MCP Guardian README:
<https://github.com/eqtylab/mcp-guardian> — proxy entre o host LLM e os servidores
MCP. Aprova/nega mensagens MCP. Automated scans “Coming Soon”. Canal: MCP.

LIDA, Microsoft MCP Gateway:
<https://microsoft.github.io/mcp-gateway/> — o `builtin:bash` corre *no pod do
gateway*, com denylist regex, e o texto oficial pede sandbox a sério para
produção. Canal: a tool builtin deles, não o Bash do Claude/Codex/Grok.

LIDA, `srt` README:
<https://github.com/anthropic-experimental/sandbox-runtime> — envolve *qualquer*
processo (exemplos: `curl`, MCP filesystem, o próprio agente). Enforcement OS.
Limitações publicadas: proxy por variáveis de ambiente no Linux (quem as ignora
fica sem rede, não escapa — mas também não é inspecção de payload); sockets Unix
no Linux não são filtráveis por path; writes a `.git/hooks` e `.git/config` estão
na deny-list obrigatória do `srt`, o que **reintroduz** o conflito da pergunta 1
se alguém envolver o Codex com o default do `srt` sem abrir o gitdir.

LIDA, Guillaume A, 2026-07-21:
<https://blog.guillaumea.fr/post/sandboxing-opencode-ai-agents-bubblewrap-srt/>
— OpenCode “ships without any form of sandbox”; envolveu o binário com `srt`;
permitiu explicitamente `~/.superset/worktrees` na allow-list de escrita. Relato
de quem impôs política a um runtime que não pede. Buraco que ele mede: no Linux,
`allowAllUnixSockets: true` (preciso para o nix-daemon) abre Docker socket,
ssh-agent, gpg-agent.

LIDA, LlamaFirewall:
<https://ai.meta.com/research/publications/llamafirewall-an-open-source-guardrail-system-for-building-secure-ai-agents/>
(2025-04-29) — “final layer of defense” no loop: prompt, chain-of-thought, código
gerado. Não afirma enforcement de syscall.

### O padrão que se repete

Há dois sítios onde a política pode sentar-se, e quase todos os produtos
escolhemos um:

- **Antes da tool, no protocolo** (MCP, ACP, hook). Barato, semântico, cego ao
  que o processo faz depois — e cego ao que o processo faz *sem* chamar o
  protocolo. É o buraco que o Paseo e o Orca deixaram aberto, e que 4 de 6
  runtimes nossos atravessam.
- **Depois da tool, no kernel** (bwrap, Seatbelt, Landlock, contentor). Cego à
  intenção, cego ao canal, vê o efeito. É o sítio onde a pergunta 1 vive: a
  política de paths ou deixa o gitdir de fora (worktree parte) ou o deixa
  entrar (hooks passam a ser o risco).

Ninguém que eu tenha lido impõe as duas camadas *e* documenta o gitdir de
worktree ao mesmo tempo, excepto o Claude Code (kernel no Bash + excepção
explícita de `.git` + deny de hooks/config) e, no papel, o Gobby. O `srt` faz a
camada kernel e *nega* hooks/config por default — o que é a posição do Codex, e
o motivo pelo qual o worktree parte.

---

## O que esta pesquisa não é

Não mede o truque do gallon.me no Codex 0.146.x desta máquina. Não propõe mudar
o lançamento, o `AgentManager`, nem o `tachyon.yml`. Não inventa regra de
segurança. A decisão de reactivar `workspace-write`, de clonar em vez de
worktree, ou de envolver o processo num `srt`, é do dono.

Fontes sem data ou sem URL não entraram. “Não achei ninguém que resolvesse o
Codex oficialmente” é parte da resposta, não um vazio a preencher.

## Fontes

| Data | O quê | URL |
|---|---|---|
| 2025-02-21 | MCP Guardian, anúncio EQTY Lab | https://www.eqtylab.io/blog/securing-model-context-protocol |
| 2025-04-11 | Invariant MCP-Scan | https://invariantlabs.ai/blog/introducing-mcp-scan |
| 2025-04-17 | Invariant Guardrails | https://invariantlabs.ai/blog |
| 2025-04-29 | LlamaFirewall | https://ai.meta.com/research/publications/llamafirewall-an-open-source-guardrail-system-for-building-secure-ai-agents/ |
| 2025-06-24 | Snyk adquire Invariant | https://labs.snyk.io/resources/snyk-labs-invariant-labs/ |
| 2025-08-25 | Solo contribui agentgateway à LF | https://agentgateway.dev/blog/2025-08-25-solo-contributes-agentgateway-to-lf/ |
| 2025-10-15 | Solo Enterprise for agentgateway | https://www.solo.io/blog/introducing-solo-enterprise-for-agentgateway |
| 2025-11-21 | openai/codex#7071 `.git/index.lock` | https://github.com/openai/codex/issues/7071 |
| 2026-02-17 | anthropics/claude-code#26262 worktree + sandbox (Closed) | https://github.com/anthropics/claude-code/issues/26262 |
| 2026-02-19 | openai/codex#12280 pedido de `.git` gravável | https://github.com/openai/codex/issues/12280 |
| 2026-03-11 | openai/codex#14338 `--add-dir` perde para o mount RO | https://github.com/openai/codex/issues/14338 |
| 2026-03-14 | Sandlock (Landlock+seccomp) | https://multikernel.io/2026/03/14/introducing-sandlock/ |
| 2026-03-23 | openai/codex#15505 `.git` RO mesmo com writable_roots | https://github.com/openai/codex/issues/15505 |
| 2026-04-26 | openai/codex#19786 gitdir de worktree remontado RO | https://github.com/openai/codex/issues/19786 |
| 2026-05-08 | openai/codex#21869 push remoto antes do lock local | https://github.com/openai/codex/issues/21869 |
| 2026-05-19 | Gobby sandbox-compatibility (git-dir + common-dir) | https://github.com/GobbyAI/gobby/blob/main/docs/guides/sandbox-compatibility.md |
| 2026-05-20 | openai/codex#23661 `--add-dir .git` não chega no worktree | https://github.com/openai/codex/issues/23661 |
| 2026-05-20 | multica-ai/multica#2925 mesmo erro no Codex | https://github.com/multica-ai/multica/issues/2925 |
| 2026-05-30 | Willison / Anthropic: gVisor, Seatbelt, VM | https://simonwillison.net/2026/May/30/how-we-contain-claude/ |
| 2026-06-10 | openai/codex#27418 `.git` rw, `worktrees/<nome>` ro | https://github.com/openai/codex/issues/27418 |
| 2026-06-12 | comparativo E2B / Daytona / microVM | https://northflank.com/blog/daytona-vs-e2b-ai-code-execution-sandboxes |
| 2026-07-17 | multica-ai/multica#5575 clone isolado (merged) | https://github.com/multica-ai/multica/pull/5575 |
| 2026-07-21 | Guillaume A: OpenCode inteiro sob `srt` | https://blog.guillaumea.fr/post/sandboxing-opencode-ai-agents-bubblewrap-srt/ |
| 2026-07-22 | gallon.me: writable_roots no path exacto, Codex 0.144.6 | https://gallon.me/letting-codex-agents-commit-making-git-writable-in-the-workspace-write-sandbox.html |
| 2026-08-04 | comparativo medido E2B vs Daytona | https://blog.logrocket.com/comparing-ai-agent-sandbox-platforms-e2b-modal-daytona-and-more/ |
| 2026-08-05 | multica-ai/multica#6449 Windows ainda no worktree RO | https://github.com/multica-ai/multica/issues/6449 |
| 2026-08-12 | Claude Code sandboxing (excepção worktree) | https://code.claude.com/docs/en/sandboxing |
| 2026-08-12 | Claude Code worktrees | https://code.claude.com/docs/en/worktrees |
| 2026-08-12 | Codex sandboxing oficial (sem menção a `.git`/worktree) | https://learn.chatgpt.com/docs/sandboxing |
| 2026-08-12 | `srt` README | https://github.com/anthropic-experimental/sandbox-runtime |
| 2026-08-12 | Microsoft MCP Gateway | https://microsoft.github.io/mcp-gateway/ |
| 2026-08-12 | MCP Guardian README | https://github.com/eqtylab/mcp-guardian |
| — | JÁ MEDIDO: 4/6 sem pedido ACP | `docs/research/t-c88c94-acp-injection.md` |
| — | JÁ MEDIDO: Paseo Auto Accept | `docs/research/t-1cb3f8-paseo-chat.md` |
