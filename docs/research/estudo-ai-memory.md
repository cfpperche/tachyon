# t-2791f3 — akitaonrails/ai-memory vs continuidade Tachyon

Study only. No product code changed. No adoption proposal.

Repo lido (clone raso em `/tmp/ai-memory-t-2791f3`, fora deste worktree):

| campo | valor |
|---|---|
| origem | `https://github.com/akitaonrails/ai-memory` |
| commit | `b6a99a77765573c6f16872c9eeabc27558f327ce` |
| data do commit | `2026-08-16T14:30:21-03:00` |
| subject | Merge pull request #404 from aguirreSL/issue-402-move-session |
| licença | MIT (Copyright (c) 2026 Fabio Akita) |
| shallow | sim (`git rev-parse --is-shallow-repository` = `true`) |

Escopo de runtime neste estudo: claude, codex, grok. A matriz larga do
projeto (cursor, gemini, opencode, pi, kiro, …) não é nossa.

Pergunta do cartão: **o que ele faz que a continuidade do Tachyon já não
faz?** A forma do mecanismo é a mesma (hook de SessionStart + texto
durável + o próximo agente lê). A diferença, se houver, está no conteúdo
e em como ele é produzido.

## Resposta

Não é "nada". Quatro coisas no caminho de troca de runtime não existem
na continuidade do Tachyon. O resto é o mesmo gesto com outro nome, ou
é um produto de memória ao lado — não continuidade.

| # | o que o ai-memory faz | a continuidade do Tachyon |
|---|---|---|
| 1 | Persiste **excertos do payload do hook** (prompt até 16 KiB, tool até 2 KiB) como observações, sem o agente escrever nada | SessionStart grava **posse** (agente, session id, caminho do transcript). Não persiste texto de prompt/tool como memória |
| 2 | No `SessionEnd` **monta sozinho** um handoff tipado a partir do primeiro e do último prompt; o SessionStart do próximo agente recebe o **corpo** | `set_continuity` e `continue_task` são invocação explícita. SessionStart injeta um **ponteiro de uma linha**, não o brief |
| 3 | O baton é **do projeto** (cwd/workspace). Qualquer runtime que abrir o mesmo projeto consome o slot, sem ser o mesmo nome de agente e sem `continue_task` | Continuity é **por nome de agente**. Um grok novo não lê o brief do claude. Troca de runtime exige `continue_task` (ou o destino ir buscar o handoff de projeto) |
| 4 | Em `ai-memory run`, lê o journal nativo e grava segmentos sanitizados em `raw/workstreams/` | Decisão permanente: não clonar transcrição entre agentes. `continue_task` pode **nomear** um transcript; não o copia |

Busca híbrida (FTS5 + entidade + grafo RRF + vetor opcional), wiki e
consolidação LLM **existem** no ai-memory e **não** existem na
continuidade. Não entram na tabela acima: não são o passo 5 de
`t-c777ac`. O próximo agente *pode* chamá-las; a troca de runtime não
depende delas.

`continue_task` já injeta **conteúdo** no destino (`taskBrief` =
markdown do pacote). Isso é o análogo mais próximo do SessionStart
dele. A diferença é produção e gatilho: lá o SessionEnd fabrica o
baton sozinho e o próximo SessionStart no mesmo projeto o come; aqui
alguém tem de chamar a ferramenta e nomear o destino.

## Como cada lado produz e injeta

### Tachyon — ponteiro, não dump

O fact do primer: continuidade é o que o agente gravou com
`set_continuity`, e é re-injetada ao cruzar compact/clear/restart/nova
sessão (`packages/engine/src/agents/primer.ts:75`).

O que o SessionStart realmente emite, nos três runtimes, é um
ponteiro. O script materializado lê o ficheiro e, se o corpo não é
vazio, escreve uma linha de `additionalContext` a mandar o agente
chamar a ferramenta — nunca o conteúdo:

- handoff de projeto: `packages/engine/src/activity/sessionOwners.ts:628-659`
  (`SESSION_HANDOFF_POINTER_SOURCE` — "never the content")
- continuity: `packages/engine/src/activity/sessionOwners.ts:671-702`
  (`SESSION_CONTINUITY_POINTER_SOURCE` — "intentionally a pointer, not
  a context dump")

Grok recebe o mesmo par (posse sempre; handoff em declared/canonical;
continuity só com `silentPersistence`) em
`packages/engine/src/harness/HarnessManager.ts:3472-3475` e
`3543-3548`.

`continue_task` é o outro caminho. Escreve
`.tachyon/session-continuation/<id>.md` e põe o markdown no
`taskBrief` do spawn (`packages/engine/src/sessionContinuation/continueTask.ts:65-71`).
O pacote é host-authored: from/to, reason, task, progress, blockers.
Transcript nativo é referência opcional, não cópia
(`focusedHandoff.ts:24-26`, `79-85`; spec 443 non-goal
`docs/specs/443-session-continuation-cross-runtime/spec.md:34`).

Startup brief (primer + project guidance + TASK/CONTEXT) é conteúdo,
não ponteiro (`docs/architecture/startup-briefs.md`). Não é o brief do
agente que parou noutro runtime.

### ai-memory — três produtores, um consumidor

**Observação (automática).** O hook lê o JSON do runtime, tira um
excerto, sanitiza, grava.

- Prompt: chaves `prompt` / `message` / `text`, teto
  `USER_PROMPT_EXCERPT_MAX_BYTES` = 16 KiB
  (`crates/ai-memory-hooks/src/payload.rs:10-12`, `864-867`).
- Tool: nome + `tool_response`/`output`/`result`, teto 2 KiB
  (`payload.rs:20`, `868-878`).
- Persistência: `body: env.body_excerpt` → `Sanitized::new` (scrub de
  credencial + teto universal 16 KiB)
  (`crates/ai-memory-hooks/src/router.rs:2433-2447`;
  `crates/ai-memory-core/src/sanitize.rs:43`, `196-204`).
- Título do tool é o nome da ferramenta, não o I/O
  (`synth.rs:86-88` conta `PostToolUse` por título).

Isto não é um resumo. É o texto do prompt (ou do output da tool),
cortado e com padrões de segredo substituídos por `[REDACTED]`.

**Handoff automático (SessionEnd).** Sem chamada MCP.
`build_auto_handoff` (`router.rs:2861-2945`):

- `summary` = primeiro e último `UserPrompt.body` (fallback título),
  cada um limitado a 1500 caracteres
- `open_questions` = `"Continue from: "` + último prompt
- `next_steps` = lista de nomes de tools usados
- `from_agent` = o `AgentKind` do envelope (o runtime que acabou)
- `to_agent` = `None`
- `files_touched` = vazio
- não corre em managed run (`(!managed).then`, `router.rs:2695`)

O write é `end_admitted_session_with_handoff` (`router.rs:2753-2758`).

**Handoff MCP (agente escreve).** `memory_handoff_begin`
(`crates/ai-memory-mcp/src/server.rs:3288-3396`). O agente manda
`summary`, `open_questions`, `next_steps`, `files_touched`. O servidor
sanitiza e cap. **Não preenche runtime:** `from_session_id: None`,
`from_agent: AgentKind::Other`, `to_agent: None` (`3364-3369`). Este
caminho não depende do runtime de origem.

**Consumo no SessionStart.** `GET /handoff` é destrutivo: o primeiro
que chega marca `accepted` (`router.rs:1172-1180`, `1246-1250`). O
markdown (`render_handoff_markdown`, `1607-1676`) começa com
`📥 ai-memory: pending handoff`, depois open questions, next steps,
files, summary por último.

Quem injeta o **corpo**:

| runtime | SessionStart injeta o handoff? | como |
|---|---|---|
| claude | sim | stdout → `hookSpecificOutput.additionalContext` (`hooks/claude-code/session-start.sh:30-39`; `hook.rs:387-401`) |
| codex | sim | stdout do `ai_memory_get_handoff` (`hooks/codex/session-start.sh:21-23`) |
| grok | **não** | `AgentKind::Grok.session_start_injects_handoff() == false` (`crates/ai-memory-core/src/ids.rs:309-331`). O hook de SessionStart **captura e descarta stdout** (`hooks/grok/session-start.sh:3-17`) de propósito: o GET é destrutivo e o Grok ignora o stdout |

Grok recupera por MCP `memory_handoff_accept`, ou — só em
`ai-memory run grok` — pelo pacote empurrado em `--rules`
(`crates/ai-memory-cli/src/commands/run.rs:367-385`, `929-940`). Se o
utilizador já passou `--rules`, o pacote fica para a corrida seguinte
(`368-374`).

O schema tipado (`crates/ai-memory-core/src/handoff.rs:59-88`) tem
`from_agent` / `to_agent`, mas `to_agent` é só hint. O matching do
GET é `(workspace, project, cwd?, owner)`, não runtime de destino
(`router.rs:1222-1248`). A montagem automática depende do runtime de
origem (`from_agent = env.agent`). A montagem MCP não. A injeção
depende do runtime de destino (claude/codex sim, grok não).

## Fronteira: o que ele grava

Decisão permanente deste projeto: **nunca clonar transcrição, cache,
home privado do runtime ou credencial entre agentes.**

Três escritas, três respostas.

### 1. Observação de hook — não é clone de transcrição; é excerto de conversa

Ficheiro que produz o dado: `crates/ai-memory-hooks/src/payload.rs`
(`best_body_excerpt`, 864-886) +
`crates/ai-memory-hooks/src/router.rs:2433-2447` +
`crates/ai-memory-core/src/sanitize.rs:196-204`.

Origem: o JSON que o runtime mandou no hook, não o ficheiro de
session do home. Não copia cache, home, nem credencial (os padrões de
`sanitize.rs:48-80` apagam bearer, `sk-`, PAT, PEM, URL com password,
`*_API_KEY=…`, caminhos `.ssh`/`.aws`/`.kube`). Copia até 16 KiB do
**texto do prompt** e até 2 KiB do **output da tool**.

Isto não atravessa "clonar o transcript / o home / a credencial".
Atravessa a intuição de "só resumo derivado": o body guardado *é* o
prompt, cortado. A linha fina que o cartão pedia está aqui.

### 2. Handoff automático — derivado do item 1

Ficheiro: `crates/ai-memory-hooks/src/router.rs:2861-2945`.
Cola o body do primeiro/último prompt (já sanitizado) no `summary` /
`open_questions` do próximo agente. Não lê o journal nativo.

### 3. `raw/` — atravessa a cláusula de transcrição

Ficheiro que **produz** o `raw/`:

1. `crates/ai-memory-workstream/src/transcript.rs:108-136`
   (`export_transcript`) abre o journal nativo em leitura
   (Claude JSONL, Codex rollout, Grok journal, …).
2. `parse_claude` / `parse_codex` / `parse_grok` (486+, 543+, 1587+)
   extraem eventos **visíveis**: user, assistant, tool call, tool
   result. Excluem reasoning/system/meta (perdas explícitas).
3. `crates/ai-memory-hooks/src/workstream.rs:565-613`
   (`sanitize_events`) aplica o mesmo `Sanitizer` e corta cada evento
   em `MAX_EVENT_CONTENT_BYTES` = 64 KiB (linha 29).
4. `workstream.rs:674-698` (`write_segment`) escreve JSONL em
   `<data_dir>/raw/workstreams/<workstream-id>/segments/<run>-<digest>.jsonl`.

Isto **não** é cópia do home, do cache, nem de credencial. É cópia
sanitizada do **conteúdo visível da transcrição** para um diretório
partilhado. O próximo agente no mesmo projeto lê esse conteúdo
(managed context packet, até 30k chars em
`router.rs:1679-1686`, ou busca no ledger).

Só corre em workstream gerenciado (`ai-memory run`). Hooks normais
não escrevem `raw/`. O README chama-lhe "immutable sanitized
managed-workstream transcript segments" — o código confirma o
marketing neste ponto.

Grok, neste caminho: `parse_grok` (`transcript.rs:1587-1665`) importa
`user` / `assistant` / `tool_calls` / `tool_result` e declara perda
em `system` e `reasoning`. O journal do Grok pode ser reescrito in
place (`journal_rewrites_in_place` inclui `ManagedHarness::Grok`,
`transcript.rs:94-98`); o cursor valida prefix SHA-256.

## Grok na matriz

Sim. Não é um alias de "other".

- `AgentKind::Grok` / wire `"grok"` (`ids.rs:205-206`, `266`, `294`)
- Bundle `hooks/grok/` (session-start, stop, user-prompt-submit,
  pre/post-tool-use, pre-compact, session-end, subagent-start/stop)
- `install-hooks --agent grok` e `install-mcp --client grok`
  (`crates/ai-memory-cli/src/cli.rs:1054-1212`)
- Extração de tool no capture policy lê `tool_name`/`toolName` +
  `tool_input`/`toolInput` (`capture_policy.rs:521-529`)
- `ai-memory run grok` (alias `grok-build`) entrega o pacote por
  `--rules` (`run.rs:367-385`)
- Parser de transcript gerenciado: `parse_grok` acima

O que o Grok **não** faz: injeção do handoff no SessionStart. Captura
sim; baton no stdout não. Isso é o buraco medido, não uma ausência da
matriz.

## Controle negativo

Token inventado: `ZXQRPLONK9F3A`.

| superfície | resultado |
|---|---|
| `rg --fixed-strings ZXQRPLONK9F3A` no clone `b6a99a77` | zero hits |
| o mesmo rg neste worktree Tachyon | zero hits |

Como o código se comporta com esse nome, sem o gravar em lado nenhum:

- FTS5 (`search_pages`, `reader.rs:1218-1222`): `normalize_fts_query`
  vazio → `Vec::new()`. Query não-vazia vira `MATCH`; token que não
  está no índice devolve zero linhas. Teste positivo no mesmo ficheiro:
  inserir uma página com `"quick"` encontra 1 hit
  (`crates/ai-memory-store/src/lib.rs:2157-2185`). O inverso é o MATCH
  vazio, não um fallback que inventa hit.
- Entidades (`entity_hits_for_project`, `reader.rs:3095-3126`):
  `entity_query_tokens("ZXQRPLONK9F3A")` produz um token
  (`zxqrplonk9f3a`, ≥3 chars, `reader.rs:292-327`). O SQL é
  igualdade ou `LIKE` prefixo contra `entities.name` **já
  indexados**. Sem linha `zxqrplonk9f3a` na tabela, o `WITH matched`
  é vazio.
- Híbrido (`hybrid_search_inner`, `reader.rs:3548-3646`): RRF funde
  FTS + entidade + vetor (só com `query_vec`) + vizinhos do grafo.
  O grafo **só** expande seeds das outras streams. Sem FTS, sem
  entidade, sem vetor → sem seed → grafo vazio → funde nada.

Não instalei o binário. Não subi o servidor. O controlo é: o nome não
existe na árvore lida, e cada stream de busca é fail-empty na
ausência de índice.

## O que não é diferença (para não fabricar)

- Agente escreve um "onde paramos" — `set_continuity` e
  `memory_handoff_begin` são o mesmo gesto.
- SessionStart nos três runtimes — os dois produtos engancham no
  mesmo evento.
- Handoff de projeto partilhado — Tachyon já tem
  `get_project_handoff` / `append_project_handoff_note`.
- Board, journal de task, spawn brief — já injectam contexto de
  trabalho no destino.
- `continue_task` já recusa migrar sessão nativa e tool state
  (`continueTask.ts:4-5`; spec 443).

A wiki, o FTS, as entidades e os embeddings são um produto de memória
ao lado. Úteis para o agente que pergunta "onde foi que falámos de
X". Não são o baton da troca de runtime.

## Sem proposta

O dono decide depois de ver. Este ficheiro não recomenda instalar,
integrar, nem desenhar um equivalente no Tachyon.
