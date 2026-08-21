# Inbox sweep — bloco B (estudos Orca e pesquisa)

**Task:** `t-3484a4` · **Medido:** 2026-08-16 · **Árvore:** `34a2887b626cde4459f0eb6e1e6d10ee4622fa0e` (`release: 0.93.6`) · **Agente:** sweepB

Não é triagem. Cada linha é um veredito para o dono decidir. Método: cartão contra codebase, `git log -S`, tasks irmãs, e o clone Orca que o lote C deixou em `/tmp/compC-competitors/orca` (`e4e54a17`, 2026-08-16).

Vereditos: **VALE COMO ESTA** · **PRECISA REESCREVER** · **NÃO FAZ MAIS SENTIDO** · **PERGUNTA JÁ RESPONDIDA** (estudo: apontar o arquivo).

## Tabela

| id | veredito | motivo |
|---|---|---|
| `t-1441a8` | PRECISA REESCREVER | A metade analytics foi medida em `t-bcf9e5` (não construir dashboard; ler `runtime_condition`). `claude-dev.tools` e o lado DevTools/Activity nunca foram estudados. |
| `t-299769` | PRECISA REESCREVER | Entregável 1 e a autoridade de `worker_done` já estão em `docs/research/orca-orchestration-task-lifecycle-land.md`. Lote C confirmou o DAG. Falta a pergunta central. |
| `t-37c531` | PRECISA REESCREVER | `t-94ec10` já recusou hot-swap em sessão viva (respawn/reanchor). O read-back da Orca já existe cá como harvest (`t-9598cc`, Grok `t-de73e0`). Falta o roster. |
| `t-3f165c` | PRECISA REESCREVER | A Orca **aposentou** o shim git/gh. Em `e4e54a17` o caminho citado não existe; o código vivo escreve tombstones (`7-neutralized`). A pergunta de provenance no Tachyon continua, o modelo a copiar não. |
| `t-54839a` | PRECISA REESCREVER | O inventário de gates de julho está velho. `t-fb7025` mediu o custo e recusou maquinaria nova. Nenhum dos 5 candidatos do corpo entrou no `verify:full`. |
| `t-56cac6` | VALE COMO ESTA | Não há store de comentário em diff nem envio em lote. Design Mode (SDD 488) é outro loop. Na Orca o mecanismo ainda vive (`diff-comments-format`). |
| `t-9d0d73` | PRECISA REESCREVER | Isolamento existe (namespace + `.tachyon/browser-state/`), não roster de perfis. Há dois browsers agora (plugin + IDE Browser da 488). A Orca ainda tem `browser-profile`. |
| `t-d2f679` | PRECISA REESCREVER | `t-283149` já mostra `mcpServers` por sessão, com origem e segredo mascarado. Sobra o enumerador genérico de `.mcp.json` / `.cursor/mcp.json` que a Orca ainda tem. |
| `t-eaa94d` | PRECISA REESCREVER | `ListRow` + convenção no STYLEGUIDE + `--hover/--sel` migrados (SDD 505). O corpo cita caminhos e CSS que não são mais a evidência. Sobra guard + `AgentRow` custom. |
| `t-a2a4a0` | VALE COMO ESTA | Admissão de agente continua só CLI (`claude`…`qwen`). `aider`/`goose`/`amp` são chip de autoria, não Agent. A categoria nunca foi mapeada. |
| `t-a27557` | VALE COMO ESTA | Attention, `write_input`, forget e harness continuam locais. MCP do Bridge permanece loopback; LAN é só companion (SDD 414), outro door. |
| `t-7db1d5` | PERGUNTA JÁ RESPONDIDA | GO compact/fresh na nota de 2026-07-31; shipped como `renew_context` (`t-6f0377`, done). Modelo/effort ficou NO-GO explícito, sem medição própria. |

## O que o lote C responde — e o que não

`docs/research/competitor-internal-checklist-lote-c.md` leu a Orca em `e4e54a17` (2026-08-16) para uma pergunta só: o concorrente lê o checklist nativo do runtime?

**Não responde nenhum destes 12.** Checklist interno ≠ orquestração, contas, shim, gates, diff comments, browser profiles, inspector MCP, ListRow.

O que o lote C *confirma* e poupa re-leitura:

- O DAG de orquestração (`status | dispatch | worker_done | …`) é o mesmo modelo de `orca-orchestration-task-lifecycle-land.md` (commit `34f2a62`). As linhas andaram, o modelo não. Serve `t-299769`.
- Os quatro cartões já triados (`t-c70fb9`, `t-a8f1fd`, `t-54d0c5`, `t-7ff4c2`) não falavam de checklist — sem contradição, só o que não tinha sido medido.
- `/tmp/orca-re` `057db5b` continua morto. O clone vivo é `/tmp/compC-competitors/orca` @ `e4e54a17`.

## Série Orca — os 14 + DS, para não reabrir o mesmo produto

Catorze estudos numerados do mesmo dia (2026-07-06), mais cinco DS. Destino hoje:

| n | id | status | sobreposição com este bloco |
|---|---|---|---|
| 01 | `t-c70fb9` CLI | triaged | nenhuma com os 12; `t-784bc8` ainda depende dela |
| 02 | `t-674fb5` Design Mode | dropped | SDD 488 entregou; distingue `t-56cac6` (diff) e `t-9d0d73` (browser) |
| 03 | `t-56cac6` comments | **inbox** | este bloco |
| 04 | `t-299769` orchestration | **inbox** | este bloco; metade medida em 2026-08-09 |
| 05 | `t-619157` companion | done | `docs/architecture/companion-mobile-v1-research.md` + SDD 414; toca `t-a27557` só no door LAN |
| 06 | `t-bcf9e5` usage | landed | responde a metade analytics de `t-1441a8` |
| 07 | `t-a8f1fd` worktree | triaged | nenhuma direta |
| 08 | `t-54d0c5` restore | triaged | nenhuma direta |
| 09 | `t-9d0d73` browser profiles | **inbox** | este bloco |
| 10 | `t-54839a` gates | **inbox** | este bloco |
| 11 | `t-37c531` accounts | **inbox** | irmã de feature `t-94ec10` (ainda inbox) |
| 12 | `t-3fd30a` hooks | done | `docs/research/native-runtime-stop-hooks-t3fd30a.md` |
| 13 | `t-3f165c` attribution | **inbox** | este bloco |
| 14 | `t-d2f679` MCP inspector | **inbox** | este bloco |
| DS 01 | `t-e8bfb5` STYLEGUIDE | done | `docs/STYLEGUIDE.md` existe |
| DS 02 | `t-eaa94d` ListRow | **inbox** | este bloco; trilha viva é SDD 505 / `t-b0a229` |
| DS 03 | `t-df7df5` tokens | done | |
| DS 04 | `t-7ff4c2` paradigmas | triaged | irmã de token; não é a lacuna de linha |
| DS 05 | `t-c7e518` Tooltip/Dialog | landed | |

## Medição por cartão

### `t-1441a8` — claude-dev.tools / Analytics vs DevTools

- Nenhum `claude-dev.tools` / `tachyon-dev-tools` no tree.
- Activity continua inspeção ao vivo (spec 239).
- `t-bcf9e5` landed 2026-08-15: Codex tem cota local fiável; Claude idle-disk não; Grok não tem canal de quota. Recomendação: **não** construir dashboard; ler `runtime_condition` antes do spawn. Arquivo: `docs/research/t-bcf9e5-local-usage-rate-limit.md`.
- `t-f0180b` (ccusage) foi **dropped** pelo humano no mesmo dia.
- `t-71ec3b` (medidores + auto-continue) já é **done** desde julho.

O que envelheceu: o corpo fala como se analytics ainda fosse terra de ninguém. Não é. O que resta é o produto externo e a pergunta DevTools.

### `t-299769` — orquestração persistente

Já medido, não refazer:

- `docs/research/orca-orchestration-task-lifecycle-land.md` (2026-08-09, `34f2a62`): coordinator/worker, `worker_done` exige `taskId + dispatchId + outcome`, morte de processo não completa trabalho, `merge_ready` sem inlet, tasks efêmeras.
- Lote C (`e4e54a17`): o modelo não mudou.
- SDD 499 / `TaskStore.attempts`: ledger `claimed`/`released`/`delivered`/`dropped` (`packages/engine/src/tasks/TaskStore.ts`). `git log -S'.attempts'` → `ed6b8305 feat(t-a5b9b9)`.
- Spec 493 `read_notices` (`3f28ae26`): o doorbell deixou de ser só janela única. A nota de 2026-08-02 que dizia “não há inbox durável” está velha.

Aberto: precisa o Tachyon de coordenação supervisionada além de `spawn_agent` / `wait_for_agent` / journal? Modelo message/inbox/gate. Handoff completo vs coordenação.

Checkout citado `/tmp/orca-re` `057db5b` está morto — igual às dez irmãs.

### `t-37c531` — hot-swap de contas

- Isolamento de home por agente segue (`HarnessManager`, specs 357/358).
- `git log -S'accountProfile'` → vazio. Roster nomeado não existe.
- Irmã `t-94ec10` (inbox, feature): switch = **respawn/reanchor**; “credentials never hot-swapped inside a live session”; sem rotação automática por rate-limit.
- Read-back já é produto: Claude harvest/promote/re-symlink (`t-9598cc`, `parity.md`); Grok cópia privada reconciliada (`t-de73e0`). Não é roster — é autoridade única.
- Na Orca `e4e54a17` o mecanismo **ainda vive**: `src/main/claude-accounts`, `codex-accounts`, `hasLiveClaudePtys`, testes de read-back.

O corpo pede para desenhar a contraparte do hot-swap da Orca. A direção já escrita no Tachyon é a oposta.

### `t-3f165c` — shim git/gh

- `git log -S'REAL_GIT'` → vazio. Nenhum shim no Tachyon. Attribution continua Activity, não trailer de commit.
- Na Orca `e4e54a17`: `src/main/attribution/terminal-attribution.ts` **não existe**. O vivo é `src/main/pty/legacy-terminal-shim-dir.ts`, versão `7-neutralized`, função `neutralizeLegacyTerminalShimDir`. Tombstones POSIX/Windows fazem `unset ORCA_REAL_GIT`. Teste `retires the persisted GitHub attribution setting`. Spawn **apaga** `ORCA_ENABLE_GIT_ATTRIBUTION`.

Lote C não mediu isto. Medido hoje no mesmo clone. Quem pegar o cartão não deve reimplementar o que a Orca está a desmontar.

### `t-54839a` — gates

`verify:full` hoje (`scripts/verify-full.mjs`): `STATIC_GATES` = `check:source-diffable`, `check:theme-tokens`, `check:webview-tokens`, `check:engine-boundary`, `check:package-boundary`, `typecheck`, depois a suíte. Sem `test:browser`, sem `smoke:vsix`, sem budget de latência, sem canary de plugin UI, sem coverage i18n.

- `test:browser` e `smoke:vsix` existem como scripts; o segundo **não corre de worktree** (project guidance).
- `docs/research/t-fb7025-gate-cost.md` (2026-08-09): o pool estava 2× acima do joelho; a proposta de maquinaria extra **não se paga**; `settings.verify.affected` foi removido de propósito (`t-f559b6`).
- Project guidance: guard nasce de recorrência medida, não de medo.

A pergunta “no máximo 3 gates de maior ROI” ainda é pergunta. O ponto de partida e a política de “não inventar gate” mudaram.

### `t-56cac6` — comentários em diff em lote

- Nenhuma store de comentário por worktree/commit/base ref. O caminho humano→agente continua `write_input` / `notify_agent`.
- Design Mode (SDD 488, `t-674fb5` dropped) captura elemento no browser, não linha de diff.
- Na Orca `e4e54a17`: `src/renderer/src/lib/diff-comments-format.test.ts` e `markdown-review-notes.test.ts` ainda existem.

Pergunta intacta. Não reestudar Design Mode no lugar disto.

### `t-9d0d73` — browser profiles

- Spec 267: estado em `.tachyon/browser-state/` (workspace, gitignored); default isolado, nunca o Chrome do humano. Isolamento por namespace de daemon, não perfil versionado selecionável.
- Segundo browser: IDE Browser / Design Mode (SDD 488). `agent-desktop` / `agent-screen` reformados.
- Na Orca `e4e54a17`: `src/cli/handlers/browser-profile.ts` e IPC `browser-session-profile` ainda existem.

O corpo assume um plugin só e um produto de browser só.

### `t-d2f679` — inspector MCP por agente

- `packages/engine/src/runtimeOps/sessionInspection.ts` (`t-283149`): `mcpServers`, origem por chave, `REDACTED` por nome de chave, `notExposed`. Leitores claude/codex/grok.
- Runtime Config lista `mcpServers` (`claudeInventory`, `codexInventory`, `grokInventory`).
- Não enumera `.mcp.json` / `.cursor/mcp.json` / `.claude.json` como a Orca.
- Na Orca `e4e54a17`: `src/shared/mcp-config.ts` ainda é o inspector de candidatos (`workspace | cursor | claude`), com máscara de env.

A auditoria “o que *este* agente está a ver” já tem superfície para os runtimes que o Tachyon gere. O cartão ainda descreve a ausência total.

### `t-eaa94d` — KitRow / ListRow

Feito desde a varredura de 2026-08-02, e mais:

1. `ListRow` em `packages/webview-ui/src/webview/shared/ui/patterns.tsx` — estados `idle | hover | selected | current`.
2. STYLEGUIDE.md:86 — “no hard-coded row hover colors in surface CSS”.
3. Pilotos Control usam `ListRow`. SDD 505 fatia 8 migrou escala da sidebar (`t-9c7ce8` landed). `--hover/--sel` saíram; o que resta de `--idle` é cinza de status-dot, não hover de linha (`sidebar.css:50-51`).

Não feito:

- Guard de cor de row: `test/unit/webviewComponentKit.test.ts` ainda só bane `ds-btn|ds-tab|ds-chip|chip`.
- `AgentRow` da sidebar (`sidebar/App.tsx:615`) continua `<div class="row">` custom, de propósito (árvore).

Caminhos do corpo (`src/webview/*`, `sidebar.css:7-9` com `--hover/--sel/--idle`) estão errados. Trilha viva: `t-b0a229` (épico, reescrito 2026-08-15) e `t-7ff4c2` (tokens, triaged). Isto já não é o estudo do primitivo.

### `t-a2a4a0` — agentes autónomos / open-source

`packages/shared/src/agents/agentRuntimeAdmission.ts`: Agent Instance = `claude`, `codex`, `grok`, `pi`, `opencode`, `hermes`, `gemini`, `qwen`. `aider` / `goose` / `amp` / `cursor-agent` / `copilot` / `verboo` estão em `AUTHORING_CATALOG_WITHOUT_ADAPTERS` — chip, não Agent. `antigravity` / `continue` correm como Terminal.

Nenhum framework de loop próprio sob o contentor de governança. O estudo não foi feito. O contentor (contrato, Activity, host-action) existe e cresceu.

### `t-a27557` — remote execution substrate

O que o corpo lista como “quebra fora do host” continua local:

- AttentionMonitor = pane/CPU local.
- `write_input` / `notify_agent` = tmux local.
- forget / harness = FS local.
- MCP do Bridge = loopback (`packages/bridge/src/Bridge.ts`). `settings.companion.lanAccess` abre `0.0.0.0` **só** para `/companion/v1/*`; MCP não sai. Isso é o companion (estudo 05 / SDD 414), não agente remoto.

`t-feda36` (inbox) pede SSH attach estilo Herdr — overlap de pergunta, outro concorrente. Spec 358 como seam de identidade+host continua proposta, não binding.

### `t-7db1d5` — gestão autónoma de sessão e modelo

A pesquisa pediu ADR + GO/NO-GO, sem `src/` nesta fase.

- 2026-07-31: nota no próprio journal com tabela de gestos, GO para compact/fresh diferido, NO-GO para modelo/effort.
- Filha `t-6f0377` (**done**): `renew_context` em `packages/bridge/src/tools/coordination-continuity.ts` — self-only, diferido para idle, `fresh` recusa sem continuity brief, runtime sem gesto medido recusa. Testes em `test/unit/contextRenewal.test.ts`.

Reabrir este cartão é reescrever um ADR que já virou ferramenta. Modelo/effort, se ainda interessar, é outra pergunta — e o próprio estudo disse que não viaja junto.

## O que não fiz

Não reescrevi cartão, não mudei status, não implementei, não abri cartão novo. Lote C não foi relido de ponta a ponta para openade/paseo — só a secção Orca e o clone, que é o que este bloco pede.
