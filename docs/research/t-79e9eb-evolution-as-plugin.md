# t-79e9eb — self-evolution fora do core: o que os runtimes já fazem, o que sobra, e o padrão

**Medição:** 2026-08-11 (UTC). **Árvore:** `5bfb23d9c7b12626d908462f90aa59bd8246bf24`, worktree limpa.
**Produto:** 0.77.0. **Workspace medido:** `/home/goat/tachyon` (checkout primário).
**Fontes web:** todas consultadas em 2026-08-11; URL e data por linha na §1.

A direção — tirar self-evolution do core e transformar em plugin que o humano injeta em UM agente —
está ratificada pelo dono. Este documento decide a **forma**, não a direção. Onde digo "não vale a
pena", é sempre sobre uma **decomposição específica**, nomeada.

---

## Sumário executivo (o que mudou de premissa)

Cinco fatos medidos mudam o desenho, e três deles contrariam o que a task assumia:

1. **A injeção por agente já existe e está rodando neste workspace** — não como plugin por agente, mas
   como *grant de skill por agente*. `claude` tem 3 skills no seu home privado, `claude-cowntdown` tem
   5, `codex` tem 0. Cada uma é uma referência `kind: skill`, `mode: pinned`, com `sha256` e
   `version`, selada na autoridade do perfil. §4.
   **Mas o canal concede e não revoga:** o `grok`, cujo perfil hoje não concede nada, carrega **3
   skills granted em 07/08** que sobreviveram à remoção da seleção em 09/08 e a uma regeneração do
   home em 10/08 — e são alcançáveis pela descoberta nativa do runtime. Não é resíduo de outro
   mecanismo: o manifesto no home diz `origins: profile/grok`. §4.1, `t-987347`.
2. **Skill tem paridade 6/6** nos nossos runtimes, e é o único portador que tem. Claude, Codex, Grok,
   OpenCode, Pi e Hermes carregam `SKILL.md` + `scripts/references/assets` nativamente. §1, §5.
3. **Um runtime já entrega a máquina inteira, com gate de aprovação humana.** Hermes tem
   `skill_manage` (o agente cria/edita as próprias skills), `skills: write_approval: true` que
   *estagia* toda escrita em `~/.hermes/pending/skills/`, e `/skills pending | diff | approve |
   reject`. É a nossa Evolution, nativa. §1.6.
4. **O padrão da spec Agent Skills NÃO define versão, autoria, assinatura, aprovação ou rollback.**
   Só `name`, `description`, e opcionais `license`, `compatibility`, `metadata`, `allowed-tools`. O
   Claude Code diz textualmente que não age sobre `metadata`. Ou seja: o portador é nativo, a
   **custódia não é** — e é exatamente a custódia que precisa ficar no core. §1.1, §6.
5. **582 linhas da máquina atual já estão mortas em produção**, medidas por fecho de importação a
   partir dos entry points do build, não por grep. E **zero bytes de Evolution existem em disco** neste
   workspace: nenhum agente com `selfEvolution`, nenhum `.tachyon/agents/*/evolution`. **Não há
   migração a fazer.** §2, §3.

E uma medição de evidência externa que muda o peso da revisão humana: no SkillsBench, skills escritas
por humanos melhoram a taxa de acerto em **16,2 pontos percentuais**; skills escritas por LLM **não dão
ganho mensurável nenhum** (SkillAxe, arXiv 2606.10546, jun/2026). A revisão não é burocracia em volta
da Evolution — é onde está todo o valor dela. §1.8.

**Recomendação em uma linha:** o portador vira nativo (skill), a custódia fica no core, e o "refletir e
propor" sai do core como skill entregue por plugin. Três movimentos, o primeiro com risco zero. §7.

---

## 1. O que cada runtime oferece nativamente (fontes web, datadas)

Todas as páginas foram buscadas em **2026-08-11**. Onde não achei documentação, digo que não achei.

### 1.1 O padrão aberto: Agent Skills

- <https://agentskills.io/specification> — a especificação completa. Estrutura: `skill-name/SKILL.md`
  (obrigatório) + `scripts/` + `references/` + `assets/` opcionais.
  Frontmatter: **`name`** (obrigatório, ≤64 chars, kebab minúsculo, tem de bater com o nome do
  diretório), **`description`** (obrigatório, ≤1024 chars); opcionais `license`, `compatibility`
  (≤500 chars), `metadata` (mapa livre string→string), `allowed-tools` (experimental).
  **Não existe campo de versão, autor, proveniência, assinatura, aprovação ou rollback.** O exemplo da
  própria spec põe `author` e `version` *dentro* de `metadata`, que é declaradamente "propriedades
  adicionais não definidas pela spec".
  Carregamento em três estágios (*progressive disclosure*): metadados (~100 tokens) no startup,
  `SKILL.md` inteiro na ativação, `scripts/references/assets` sob demanda.
- <https://agentskills.io> — formato originalmente desenvolvido pela Anthropic e liberado como padrão
  aberto. O showcase de clientes inclui, entre outros, **Claude Code, ChatGPT & Codex, OpenCode, pi e
  Hermes Agent** — cinco dos nossos seis runtimes citados nominalmente pelo próprio padrão.

### 1.2 Claude Code

- <https://code.claude.com/docs/en/skills>
  - Locais: `~/.claude/skills/<name>/SKILL.md` (pessoal), `.claude/skills/<name>/SKILL.md` (projeto),
    mais escopo *enterprise*. Precedência: enterprise > pessoal > projeto; skills de plugin usam
    namespace `plugin-name:skill-name` e por isso não colidem.
  - Skills também carregam de `.claude/skills/` **aninhados** abaixo do cwd, no primeiro read/edit
    dentro do subdiretório.
  - **Symlink é suportado**: uma entrada `<skill-name>` pode ser um symlink para um diretório em
    qualquer lugar do disco; se o mesmo alvo for alcançável por mais de um local, a skill é carregada
    uma vez só.
  - `${CLAUDE_SKILL_DIR}` e `${CLAUDE_PROJECT_DIR}` são substituídos tanto no corpo quanto nas regras
    `Bash(...)` de `allowed-tools` — é assim que uma skill roda o próprio script sem prompt.
  - Frontmatter estendido além da spec: `disable-model-invocation`, `allowed-tools`,
    `disallowed-tools`, `context: fork`, `arguments`, `paths`, `metadata`, `license`, `compatibility`.
    Sobre `metadata`, textual: *"Claude Code doesn't act on its contents"*.
  - **Live change detection**: editar um `SKILL.md` sob `~/.claude/skills/`, o `.claude/skills/` do
    projeto ou um `--add-dir` é captado **dentro da sessão, sem restart**.
  - **O runtime já escreve skill sozinho.** Duas capacidades embutidas fazem exatamente o que a nossa
    Evolution faz: `/run-skill-generator` "captura o que funcionou … e commita como skill por projeto
    em `.claude/skills/run-<name>/`"; e `/verify`, quando precisa buildar e dirigir a app sem receita
    gravada, "escreve o que funcionou em `.claude/skills/verify/SKILL.md` na raiz do repo … para que
    execuções posteriores e outros agentes sigam os mesmos passos" (requer Claude Code v2.1.200+).
    **Sem gate de aprovação humana descrito.**
- <https://code.claude.com/docs/en/plugins-reference>
  - Escopos de instalação de plugin: `user` (`~/.claude/settings.json`, default), `project`
    (`.claude/settings.json`), `local` (`.claude/settings.local.json`), `managed`.
    **Não existe escopo por agente/sessão.**
  - `plugin.json` tem `version` (semver; fixar pinna o plugin naquela versão) e `defaultEnabled:
    false` (instala desligado). Cada versão instalada é um diretório separado no cache; a anterior é
    marcada como órfã e removida ~14 dias depois — isto é, existe uma **janela nativa de rollback**
    para *plugin*, não para skill.
  - `@skills-dir`: qualquer pasta sob um diretório de skills que contenha `.claude-plugin/plugin.json`
    é carregada como plugin `<name>@skills-dir`, **descoberta no lugar, sem marketplace e sem passo de
    install**. Escopo projeto exige o gate de confiança do workspace; monitores não carregam.

### 1.3 Codex

- <https://learn.chatgpt.com/docs/build-skills> (redireção 308 de
  <https://developers.openai.com/codex/skills>) e <https://github.com/openai/codex/blob/main/docs/skills.md>
  (que só aponta para a anterior).
  - Locais, por escopo: `$CWD/.agents/skills`, `$CWD/../.agents/skills`, `$REPO_ROOT/.agents/skills`
    (REPO); `$HOME/.agents/skills` (USER); `/etc/codex/skills` (ADMIN); mais skills embutidas pela
    OpenAI (SYSTEM), incluindo `skill-creator`.
  - Frontmatter obrigatório: `name`, `description`. `scripts/` opcional. Symlinks suportados; varre do
    diretório atual para cima até a raiz do repo.
  - Ativação: explícita (`$skill` no Codex, `/skills`) ou implícita por match de descrição.
  - **Nenhum campo de versionamento, autoria, aprovação ou verificação de confiança.** A documentação
    também **não traz aviso de segurança** sobre execução de skill.

### 1.4 Grok

- <https://docs.x.ai/build/features/skills-plugins-marketplaces>
  - Descoberta em quatro fontes: `./.grok/skills/` (subindo até a raiz do repo), `~/.grok/skills/`,
    o diretório `skills/` de qualquer plugin habilitado, e caminhos extras via `[skills] paths` em
    `~/.grok/config.toml`.
  - Plugins carregam "skills, agents, hooks, MCP servers e LSP servers"; marketplaces instalam em
    `~/.grok/plugins/marketplaces/`. Modal unificado por `/plugins`, `/hooks`, `/skills`, `/mcps`.
  - **Compatibilidade Claude Code com zero configuração**: lê marketplaces, plugins, skills, MCPs,
    agents, hooks e arquivos de instrução do Claude Code junto com os próprios.
  - Hooks de projeto exigem `/hooks-trust`. **Nenhum metadado de versionamento ou aprovação
    documentado.**

### 1.5 OpenCode

- <https://github.com/joshuadavidthomas/opencode-agent-skills> (README) — **este é o relato de
  recuo que a task pediu.** Textual: *"OpenCode now includes first-party support for agent skills,
  including native skill discovery and a built-in `skill` tool. For most users, this plugin is no
  longer necessary."* O plugin segue em modo manutenção.
  Ordem de descoberta que ele implementava: `.opencode/skills/`, `.claude/skills/`,
  `~/.config/opencode/skills/`, `~/.claude/skills/`, `~/.claude/plugins/cache/`,
  `~/.claude/plugins/marketplaces/`.
  O que ele oferece **além** do nativo: matching semântico automático, injeção sintética de contexto,
  resiliência a compactação, e ferramentas auxiliares para ler arquivos e rodar scripts da skill.
- <https://github.com/joshuadavidthomas/opencode-agent-memory> — memory blocks auto-editáveis pelo
  agente, inspirados em Letta: arquivos markdown em disco como estado compartilhado que toda sessão lê
  e escreve, com blocos escopados, metadata, limites de tamanho e tools dedicadas.
- <https://opencode.ai/docs/skills/> é o ponteiro oficial listado pelo agentskills.io. **Não consegui
  extrair a página oficial de skills do OpenCode nesta rodada** — a caracterização acima do suporte
  nativo vem do README do plugin de terceiros e do showcase do agentskills.io, não da doc primária.
  Registro isso como lacuna de fonte.

### 1.6 Hermes Agent — o runtime que já implementou a nossa Evolution

- <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/skills.md>
  - Tool **`skill_manage`**, com as ações `create`, `patch` ("targeted fixes (preferred)"), `edit`,
    `delete`, `write_file`, `remove_file`. Textual: skills criadas pelo agente **são a memória
    procedural dele**.
  - Gatilhos documentados para o agente criar skill: depois de uma tarefa complexa (5+ tool calls),
    ao achar o caminho que funciona depois de becos sem saída, quando o usuário corrigiu a abordagem,
    ao descobrir um workflow não trivial.
  - Armazenamento: `~/.hermes/skills/` é "the primary directory and source of truth"; estado de hub em
    `~/.hermes/skills/.hub/` (`lock.json`, `quarantine`, `audit.log`); manifest de hashes das skills
    embutidas em `~/.hermes/skills/.bundled_manifest`; taps configuráveis em `.hub/taps.json`;
    diretórios externos em `~/.hermes/config.yaml` sob `skills: external_dirs:`.
  - Frontmatter Hermes tem **`version: 1.0.0`**, `platforms`, e `metadata.hermes.{tags, category,
    requires_toolsets, config, required_environment_variables}`.
  - **O gate**: `skills: write_approval: true` faz **toda** escrita de `skill_manage` ser *estagiada*
    em `~/.hermes/pending/skills/` em vez de commitada. Revisão por `/skills pending`, `/skills diff
    <id>`, `/skills approve <id>` (ou `all`), `/skills reject <id>`, `/skills approval on|off`.
    O staging vale em foreground e em background e **sobrevive a restart**.
  - `/learn` transforma uma fonte em skill; re-rodar sobre o mesmo tema **funde na skill existente em
    vez de duplicar**.
- <https://hermes-agent.nousresearch.com/docs/user-guide/features/memory>
  - `~/.hermes/memories/MEMORY.md` (notas do agente) e `USER.md` (perfil do usuário), injetados no
    system prompt como **snapshot congelado no início da sessão** — a mesma escolha que o nosso
    `EvolutionStartupSnapshot` faz.
  - Tool `memory` com `add` / `replace` / `remove`; gate equivalente `memory.write_approval: true`,
    com `/memory pending | approve | reject | approval on|off`.
  - 8 plugins de provider externo de memória (Honcho, OpenViking, Mem0, Hindsight, Holographic,
    RetainDB, ByteRover, Supermemory).

### 1.7 Pi

- <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md>
  - Globais: `~/.pi/agent/skills/`, `~/.agents/skills/`. Projeto (depois de trust): `.pi/skills/`,
    `.agents/skills/` (no cwd e ancestrais até a raiz do repo git).
  - Fontes adicionais: diretórios `skills/` ou entradas `pi.skills` em `package.json`; array `skills`
    nas settings; `--skill <path>` (repetível).
  - Invocação `/skill:name`, com argumentos anexados como input do usuário.
  - Desligamento da descoberta: `"enableSkillCommands": false` em `settings.json` ou `--no-skills`
    (caminhos `--skill` explícitos ainda carregam) — que é exatamente o que a SDD 406 usa.
  - **A documentação não indica que o Pi possa criar ou editar as próprias skills.** Não achei.

### 1.8 Quem já tentou, e o que custou

- **SkillAxe: Sharpening LLM-Authored Agent Skills Through Evaluation-Guided Self-Refinement.**
  Srishti Gautam, Arjun Radhakrishna, Sumit Gulwani. arXiv **2606.10546**, submetido 2026-06-09,
  revisado 2026-06-10. Textual do abstract: *"On SkillsBench, human-authored skills improve pass rates
  by 16.2 percentage points, while LLM-authored skills provide no measurable gain."* O framework
  proposto recupera 28% relativo e fecha 47–67% da distância para skills humanas — ou seja, mesmo
  refinadas, seguem abaixo.
  **Consequência direta para nós:** uma Evolution sem revisão humana efetiva vale ~0 medido. O gate não
  é overhead; é o produto. É também o argumento mais forte contra mover a revisão para fora do core.
- **OpenCode / `opencode-agent-skills`** (§1.5): o caso "construiu por cima e voltou atrás" — um
  plugin de terceiros implementou descoberta de skills e virou desnecessário quando o runtime shipou o
  nativo. É o precedente que sustenta a direção do dono: quem constrói em paralelo ao nativo paga a
  conta duas vezes.
- **Hermes** (§1.6) é o caso oposto e igualmente informativo: um runtime que implementou a máquina
  inteira — proposta, staging, diff, aprovação, quarentena, audit log, versão no frontmatter. Quando
  um runtime faz isso, o que o produto tem a acrescentar é a **política**, não o mecanismo.
- Não achei nenhum relato público de projeto que tenha adotado "skill como unidade de evolução" e
  **revertido**. O que achei foi o inverso (plugin de skills descontinuado *porque* o nativo chegou) e
  a evidência quantitativa do SkillAxe de que a parte cara é a autoria, não o transporte.

---

## 2. Alcançabilidade das 2914 linhas (medida, não estimada)

**Método.** Fecho transitivo de importação estática a partir de **todos** os entry points declarados em
`esbuild.mjs` (36 entradas: `extension.ts`, `daemonMain.ts`, `toolLauncherEntry.ts`,
`pluginValidateEntry.ts`, `dataResolverEntry.ts`, `externalResolverEntry.ts`, `pi-bridge-extension`,
sidebar, agent-pane, pipeline-studio, plugin-host, agent-studio-fixture, ui-gate, os 20
`WEBVIEW_APP_VIEWS`, mermaid/katex/excalidraw). Resultado: **748 de 777** arquivos `src/**` alcançados.
Verifiquei que não há `await import()` dinâmico de nenhum módulo de formation ou evolution, então o
grafo estático é o grafo real. Para os métodos, contei chamadores separando `src/` de produção,
`src/evolution/` interno e `test/`.

### 2.1 Os 7 arquivos de `src/evolution/` estão todos alcançáveis

| Arquivo | Linhas | Importadores prod | Importadores test |
|---|---:|---:|---:|
| `EvolutionStore.ts` | 2024 | 9 | 8 |
| `startupSnapshot.ts` | 228 | 4 | 3 |
| `domain.ts` | 154 | 0 (só via os outros) | 3 |
| `studioProjection.ts` | 148 | 4 | 1 |
| `EvolutionCoordinator.ts` | 127 | 1 | 1 |
| `skillBundle.ts` | 125 | 2 | 1 |
| `authorityIntegrity.ts` | 108 | 1 | 2 |
| **total** | **2914** | | |

Nenhum aparece na lista de não-alcançados. **A t-56ced4 está certa no fenômeno e imprecisa no
recorte**, e a diferença importa para dimensionar o corte — ver §2.3.

### 2.2 A lane VIVA, ponto a ponto

Existe torneira e ela é real:

1. `TaskStore` commita `status: done` → `EvolutionCoordinator.onTaskMutation`
   (`Workspace.ts:1686` constrói o coordinator) → `store.createReview` → `deliverNotice` digita o
   aviso no composer do agente → `markReviewDelivery` / `markReviewFailed`.
2. O agente chama **`submit_evolution_review`** (Bridge MCP, `src/bridge/tools/tasks.ts:127`) →
   `store.submitReview` (`EvolutionStore.ts:1209`), que **escreve os candidatos direto**
   (`atomicWriteJson(this.candidatePath(...))`, L1277) — não passa por `createCandidate`.
3. O humano no Agent Studio → `Workspace.readAgentEvolutionOverview` / `readAgentEvolutionCandidate`
   (via `studioProjection`) → `approveAgentEvolutionCandidate` (`Workspace.ts:7106`) /
   `rejectAgentEvolutionCandidate` (`:7115`) → `store.approveCandidate` / `rejectCandidate`.
4. No spawn: `resolveEvolutionStartupSnapshot` + `renderEvolutionPromptLayer` →
   `src/agents/promptLayers.ts:105`.
5. Ciclo de vida/identidade: `ensureProfile` (`Workspace.ts:5323, 5617`), `readProfile` (8 sítios),
   `retireAgent` (4), `renameAgent` (5).

**Correção precisa da t-56ced4:** `approveCandidate` **escreve** o intent de promoção
(`EvolutionStore.ts:1043`) e `reconcilePromotionUnlocked` roda na cabeça de **todas** as 11 mutações,
com `rollbackPromotionUnlocked` alcançável na recuperação. Ou seja, **a custódia e o rollback do
`EvolutionStore` rodam**. O que não roda é a **outra** máquina de promoção, a de *formation* — e essa
está morta de ponta a ponta.

### 2.3 O que está morto em produção — 582 linhas medidas

**Fora de `src/evolution/` (426 linhas, zero alcance a partir de qualquer entry point):**

| Arquivo | Linhas | Estado |
|---|---:|---|
| `src/agents/formation/evolutionTransactions.ts` | 219 | `EvolutionFormationTransactionService` — instanciado **só** por `test/unit/agentFormationEvolutionLane.test.ts:18` |
| `src/agents/formation/evolutionLane.ts` | 207 | importado só por `resolver.ts` e por `evolutionTransactions.ts` — ambos mortos |

Colateral, não-evolution mas parte do mesmo grafo: `src/agents/formation/resolver.ts` (129 linhas,
`resolveCompleteFormationPayload`) **não tem nenhum importador em `src/` nem em `test/`** — é o único
chamador possível de `resolveEvolutionFormationLane`. Junto vieram `humanLaneTransactions.ts` (665),
`memoryTransactions.ts` (188), `memoryLane.ts` (132), `lifecycleContract.ts` (39) e
`sessionPolicy.ts` (41), todos inalcançáveis. **Não proponho tocá-los aqui** — são a t-56ced4 e a
t-75ce10, e decidir a lane de memória por dentro desta task seria decidir errado, como aquela task já
avisa.

**Dentro de `EvolutionStore.ts` (156 linhas, medidas por span de método):**

| Método | Linhas | Chamadores prod | Chamadores test |
|---|---:|---:|---:|
| `prepareFormationPromotion` (L873-929) | 57 | 0 (só `evolutionTransactions.ts`, morto) | 1 |
| `createCandidate` (L775-804) | 30 | **0** | 28 |
| `approvePreparedFormationPromotion` (L930-949) | 20 | 0 (idem) | 1 |
| `writeLearnings` (L1293-1312) | 20 | **0** | 1 |
| `verifyFormationPromotionToken` (L859-872) | 14 | 0 (idem) | 1 |
| `recordHistory` (L1313-1320) | 8 | **0** | 1 |
| `formationTokenAuthorization` (L852-858, privado) | 7 | só os acima | — |

`createCandidate` é o achado mais desconfortável: **28 chamadas em `test/` para uma porta de criação de
candidato que a produção nunca usa**, porque `submitReview` escreve o candidato por dentro. São duas
implementações da mesma criação, e a testada é a que ninguém executa.

**Total provado morto: 582 linhas** (426 fora + 156 dentro), removíveis com **zero mudança de
comportamento observável**.

### 2.4 Achado adjacente que muda o eixo maior

O mesmo fecho revelou que a camada de **memória nativa por runtime já foi construída e nunca foi
ligada**: `src/runtime/adapters/claudeMemory.ts` (154), `codexMemory.ts` (188),
`nativeMemoryVerifier.ts` (357), `nativeLaneSuppression.ts` (269), `src/memory/SelectedMemoryStore.ts`
(369), `src/memory/domain.ts` (106) — **1443 linhas sem nenhum importador em `src/`**. O header de
`nativeMemory.ts` diz que isso é deliberado ("NOT WIRED INTO CANONICAL READINESS BY THIS TASK"), e
`docs/research/runtime-native-memory-parity-t-d4c42e.md` é a pesquisa correspondente. Registro aqui
porque o eixo do dono ("simplificar o agente para ficar nativamente mais próximo dos runtimes") tem um
segundo caso já medido esperando decisão, e ele é maior que a Evolution.

---

## 3. Migração: medida, e a resposta é "nenhuma"

Regra do dono: se não existe neste workspace, não existe em lugar nenhum. Medido em
`/home/goat/tachyon`, 2026-08-11:

| O que | Contagem |
|---|---:|
| Diretórios `.tachyon/agents/*/evolution` | **0** |
| Entradas em `.tachyon/evolution-session-snapshots` | **0** |
| Arquivos `LEARNINGS.md` / `evolution/profile.json` | **0** |
| Perfis de agente com `selfEvolution` | **0** (de 3 agentes salvos: `claude`, `claude-cowntdown`, `grok`) |
| Ocorrências de `selfEvolution` em `tachyon.yml` | **0** |

**Nenhum migrador é necessário.** Qualquer decomposição abaixo pode remover estado sem compensação, e
nenhum humano perde aprendizado — porque nenhum foi produzido.

---

## 4. A vantagem que o dono nomeou já existe — com um limite, e ele é o único gap real

O terceiro ponto do dono é "o user só instala o plugin no agente que ele quer a feature, e não em
todos". A nota do journal registrou que isso *não existe hoje*, citando
`consentViewModel.ts:46` ("per-agent grant: projection into managed agent sessions remains workspace
policy"). Essa citação está correta **sobre plugins**. Sobre **skills**, o efeito já existe e está
rodando. Conferido no ponto de uso, não por busca textual:

**Medido em `/home/goat/tachyon`, 2026-08-11 — 15 plugins instalados, 12 skills materializadas no
workspace (`.claude/skills/`):**

| Agente | `capabilities.skills` no perfil | Home privado | Conteúdo real de `<home>/skills/` |
|---|---|---|---|
| `claude` (salvo, perfil) | `agent-browser`, `sdd`, `visual-qa` | `.tachyon/harness/claude` | exatamente essas 3 |
| `claude-cowntdown` (salvo, perfil) | `agent-browser`, `hyperframes`, `image`, `sdd`, `visual-qa` | `.tachyon/harness/claude-cowntdown` | exatamente essas 5 |
| `grok` (salvo, perfil) | **nenhuma** | `.tachyon/bridge-mcp/grok.grok` | **3 obsoletas** — ver §4.1 |
| `codex` | — | `.tachyon/harness/codex` | vazio |
| `nativeevo` (temporário, sem perfil) | — | `.tachyon/harness/nativeevo` | **11** (o conjunto do workspace) |

> Correção da primeira versão deste documento (2026-08-11, apontada por `claude` na revisão): eu havia
> medido `.tachyon/harness/grok/skills` — ausente — e concluído "0". O home privado do Grok **não é
> esse**: é `.tachyon/bridge-mcp/grok.grok` (`bridgeGrokHome`, t-843576), e lá existem três skills.
> Medi a linha errada da tabela. A §4.1 diz o que elas são.

Cada entrada em `agent.yml` é uma referência **fixada por conteúdo e por versão**:

```yaml
capabilities:
  skills: [agent-browser, sdd, visual-qa]
references:
  - id: agent-browser
    kind: skill
    scope: project
    path: .tachyon/plugins/agent-browser/skills/agent-browser
    mode: pinned
    sha256: f9736eab90a30da62593cac54e75dd72e84ea5027ff8450c2a54f5718d14408a
    version: 3.1.0
```

A máquina que sustenta isso já está toda no core, e cada peça tem dono:

- `src/config/agentSkillAuthorization.ts` — AUTORIZAR (a regra). O header enumera os três passos e diz
  qual faltava: *"AUTHORIZE … No door. Nobody could open it"*, aberto pela t-5498a6.
- `src/config/agentSkillAuthorizationService.ts` — a porta fs: lê a árvore, calcula o digest e persiste
  **referência e grant na mesma transação**, porque são um fato só.
- `src/config/agentCapabilityCandidates.ts` — o que o humano PODE autorizar, em duas listas separadas
  por proveniência (plugin vs escrito à mão), discriminadas pelo **lockfile**, nunca por comparação de
  conteúdo. Carrega `AuthorizedState.stale`: a árvore mudou desde a autorização e a entrega vai
  recusar até reautorizar.
- `src/config/agentProfileResolver.ts:882-916` — ENTREGAR: `requireGrant` recusa qualquer seleção sem
  grant exato custodiado pelo host, e o harness escreve a árvore no **home privado do agente**, não no
  worktree.

### 4.1 O canal concede por agente, mas **não revoga** — medido no Grok

As três skills do Grok não são resíduo de outro mecanismo nem uma segunda porta de entrega: são o
**mesmo** caminho do grant, sem revogação. O manifesto no próprio home privado dá a proveniência:

```
.tachyon/bridge-mcp/grok.grok/.tachyon-profile-capabilities/manifest.json   (2026-08-07 18:23)
  sources: agent-browser, sdd, visual-qa — scope: project, owner: plugin:<nome>, sha256 por skill
  outputs.skills[].origins: [{ kind: "profile", agent: "grok" }]
```

`origins: profile/grok` significa: entregues **pelo perfil do próprio grok**, não por delegação, não
por herança de workspace. A linha do tempo fecha o caso:

| Quando | O quê |
|---|---|
| 2026-08-07 18:23 | as 3 árvores de skill são materializadas em `$GROK_HOME/skills/` pelo grant |
| 2026-08-09 21:54 | `.tachyon/agents/grok/agent.yml` é reescrito **sem `capabilities:` e sem `references:`** — a seleção sai |
| 2026-08-10 01:08 | `config.toml` do home privado é **regenerado** — houve materialização já sem seleção |
| 2026-08-10 01:57 | `auth.json` / `active_sessions.json` — **sessão viva** depois disso |
| hoje | as 3 árvores continuam com mtime de 07/08. Sobreviveram à regeneração. |

E são alcançáveis pelo runtime: o `[skills] ignore` gerado cobre só as raízes de **projeto**
(`.agents/skills` e `.grok/skills` dos dois workspaces) e **não** cobre `$GROK_HOME/skills`, que é
raiz de descoberta documentada do Grok (`~/.grok/skills/`, docs.x.ai). Uma delas é `agent-browser`,
que dirige browser real.

**Mecanismo, conferido no ponto de uso.** Claude purga incondicionalmente `skills` e
`.tachyon-profile-capabilities` (`HarnessManager.ts:2702`) **antes** de decidir, e só então
re-materializa `if (capabilities)`. Grok (`:1585-1591`) chama `materializeBridgeMcpGrok` — que em suas
75 linhas (L3343-3418) **não purga nada**, só comenta que as granted "are written to this home's own
`skills/` by `materializeProfileCapabilities`" — e depois `replaceCapturedSkillTree`, que está correto
mas **só roda quando existe projeção**. Seleção zero ⇒ nenhuma projeção ⇒ nada purga.

Isso **contradiz `docs/runtimes/parity.md:507`** (t-84c678, 2026-08-05): *"zero selection removes stale
private skills"*. Medido falso exatamente no caso que a frase nomeia. Registrado em **`t-987347`**;
Codex (`:2232-2234`) e Pi têm a mesma guarda `if (profileCapabilities)` e **não foram medidos aqui**.

**O que isso muda no estudo, e o que não muda.** Não derruba a §4: o grant por agente existe, entrega
e é fixado por conteúdo — o próprio manifesto do Grok é a prova de que rodou. O que ele mostra é que
o **CANAL do padrão (§9) concede mas não revoga**, e essa assimetria é pior para a Evolution do que
para uma skill de plugin: aqui o que sobrevive à revogação seria conteúdo **gerado por agente**.
Portanto `t-987347` entra como pré-requisito do Movimento 2, ao lado de `t-a7063c`.

**O outro gap medido:** um agente **temporário/delegado, sem perfil**, recebe o conjunto do workspace
(eu recebi 11 de 12). A granularidade por agente vale hoje para agentes com perfil — salvos/canônicos.
Se a Evolution virar skill entregue por plugin, ela será oferecida a agentes temporários que herdam.
Isso é uma escolha a fazer (§8), não um bloqueio.

E o gap **não** é o da nota do journal sobre worktree: `worktreeProjection.ts` aposentou
`.claude/skills` / `.agents/skills` **no worktree** — a decisão de 2026-07-31, comprada por um defeito
real (o agente codex tinha as doze skills do workspace em oferta, duas delas gastando dinheiro na
fal.ai, sob um perfil que não concedia nenhuma). A entrega por grant **não passa pelo worktree**: ela
escreve no home privado. As duas coisas convivem, e a regra de 31/07 continua íntegra.

---

## 5. Paridade: `docs/runtimes/parity.md` como régua

Skill é o **único** portador com paridade nos seis. Consolidando a doc dos runtimes (§1) com o que a
`parity.md` e o código já declaram:

| Runtime | Raiz nativa de skill | Home privado por agente no Tachyon | Entrega de skill granted, hoje | Fonte |
|---|---|---|---|---|
| Claude | `.claude/skills`, `~/.claude/skills` | `CLAUDE_CONFIG_DIR` privado | **✓ com `requireGrant`** | parity §3.2 Claude; code.claude.com/docs/en/skills |
| Codex | `.agents/skills`, `$HOME/.agents/skills`, `/etc/codex/skills` | `CODEX_HOME` privado | ✓ **sem `requireGrant`** (§6) | parity §3.2 Codex; learn.chatgpt.com/docs/build-skills |
| Grok | `.grok/skills`, `~/.grok/skills`, `[skills] paths` | `GROK_HOME` + `HOME` privados; `[skills].ignore` para as raízes de projeto **e** para `.agents/skills` — **nunca para `$GROK_HOME/skills`** | ✓ **sem `requireGrant`** (§6) e **sem revogação** (§4.1) | parity §3.2 Grok (`t-84c678`, 0.2.118, 2026-08-05); docs.x.ai |
| OpenCode | `.opencode/skills`, `~/.config/opencode/skills` (+ compat `.claude/skills`) | XDG por agente em `.tachyon/harness/<agent>/` (`t-e2ebe3`) | **ausente declarado** — `SKILLS_REL` cobre só claude/codex/grok | docs/runtimes/opencode.md; README opencode-agent-skills |
| Pi | `.pi/skills`, `.agents/skills`, `~/.pi/agent/skills`, `~/.agents/skills` | `PI_CODING_AGENT_DIR` privado; descoberta automática **desligada** por design (SDD 406) | **✓ por outro caminho** — snapshots privados exatos + `--skill` explícito | parity §3.2 Pi; pi-mono docs/skills.md |
| Hermes | `~/.hermes/skills/` + taps + `external_dirs` | `HERMES_HOME` privado | **ausente declarado** | docs/runtimes/hermes.md; hermes-agent docs |

**O que isso obriga a dizer, por runtime, se a Evolution virar skill:**

- **Claude, Codex, Grok** — funciona pelo canal que já existe. Codex e Grok precisam do fecho de
  autoridade da §6 antes, não depois.
- **Pi** — funciona, mas por um mecanismo diferente e mais estrito: a SDD 406 desliga descoberta
  automática e carrega só snapshots declarados. Uma skill de Evolution para Pi tem de entrar na lista
  de recursos do harness, e o `parity.md` já diz que aquisição remota está fora de escopo.
- **OpenCode e Hermes** — **ausente declarado**, e por motivos opostos.
  Em OpenCode falta o mapeamento (`SKILLS_REL` não tem `opencode`); é trabalho, não impedimento.
  Em **Hermes é o contrário do que parece**: ele tem a máquina *inteira*, melhor que a nossa. A
  resposta certa para Hermes não é entregar a nossa skill, é **recusar por nome e apontar para
  `skill_manage` + `write_approval`** — e, se um dia integrarmos, integrar a nossa *política* ao gate
  dele, não substituir o gate.

Não invento paridade que não medimos: não rodei nenhum dos seis runtimes nesta task. Tudo acima é
documentação atual mais o que o `parity.md` já registra como medido, com a data de cada medição.

---

## 6. Autoridade — quem impede um agente de se reescrever sem revisão

Esta é a pergunta que não pode ficar sem resposta, e ela tem duas partes.

### 6.1 A resposta de desenho: "o consentimento do plugin cobre" é FALSO, e a resposta certa é outra

O consentimento de plugin é política de workspace, declarado textualmente em
`consentViewModel.ts:46` e `:194`. Ele responde *"estes bytes podem entrar neste workspace"*. Não
responde *"este agente pode selecionar este conteúdo exato"*, que é a pergunta da autoridade. Se a
Evolution virar plugin e a defesa for o consentimento do plugin, a autoridade **piora**: hoje
`approveCandidate` exige um head de autoridade custodiado (`authorityIntegrity.ts`,
`sealAuthorityRecord` / `verifyAuthorityRecord` / `authorityRecordMac`) e recusa promoção sem ele
(`EvolutionStore.ts:855`, `:1611`, `:1889`).

**A resposta correta é que a autoridade não vai para o plugin.** Ela já tem forma no core e é a mesma
para toda capacidade: **grant por agente, fixado por sha256, selado na autoridade do perfil, exigido
na entrega**. `capabilityGrants` + `requireGrant`. O plugin traz os bytes; o grant diz de quem eles
são e para quem valem; o seal diz que um humano decidiu isso. Três respostas para três perguntas
distintas, e nenhuma cobre a outra.

Três razões medidas para isso não ser negociável:

1. **A spec Agent Skills não tem onde guardar essa informação** (§1.1). Sem campo de autor, versão,
   assinatura ou aprovação, o portador é incapaz de carregar a própria autoridade. Se a custódia sair
   do core, ela não existe em lugar nenhum.
2. **O único runtime que resolveu isso resolveu do lado do host, não do formato** — Hermes põe o gate
   em `write_approval` + `pending/` + `audit.log`, fora do `SKILL.md`. Convergência independente com o
   nosso desenho.
3. **A revisão é onde está o valor** — 16,2 p.p. contra ganho nulo (§1.8). Enfraquecer o gate para
   simplificar o core troca a única parte que mede resultado.

### 6.2 A resposta de medição: hoje existe um buraco, e ele é anterior a esta decisão

`src/config/agentProfileResolver.ts:913`:

```ts
if (adapter === "claude" && !requireGrant(reference, "skill")) continue;
```

A exigência de grant custodiado para **skill** só é aplicada quando o adapter é `claude`. As linhas
vizinhas — `:936` (mcp), `:964` (hook), `:988` (genérica) — **não** têm condição de adapter.
`git log -L 913,913` diz que a linha nasceu em `8ef994c3`, 2026-07-25, na t-2f37e7 ("project Claude
profile capabilities") e nunca foi generalizada quando a entrega para codex/grok chegou.

Ao mesmo tempo, o texto do inspector que o humano atesta **afirma o contrário**:
`agentProfileProjection.ts:126` (codex) — "selected owner-captured skills, hooks and MCP require exact
host grants and are reprojected"; `:110` (grok v4) — "selected owner-captured skills require exact
Grok grants and are reprojected into the private home".

**Escopo honesto do risco:** hoje a única porta que escreve `profile.references` de capacidade escreve
o grant na **mesma transação** (`agentSkillAuthorizationService.ts`), então não conheço um caminho
alcançável que produza uma referência sem grant. É uma falha de defesa em profundidade e uma
**divergência entre a atestação e o código**, não um exploit conhecido. É exatamente a forma que a
`docs/project-guidance.md` descreve em `t-17d885` / `t-e73e54`: mecanismo feito para um ator, alcançado
depois por outro que pulou a lógica.

**Registrado como Task**, não como prosa: `t-a7063c`.

**E isso é pré-requisito desta direção.** Se a Evolution passa a entregar por grant de skill, então
codex e grok passam a receber conteúdo gerado por agente por um caminho que não verifica o selo. Fechar
`:913` vem antes de qualquer movimento da §7 que toque codex ou grok.

---

## 7. O que morre, o que vira plugin, o que fica no core — com números

Três movimentos, ordenados por evidência e por risco. Cada um é entregável sozinho.

### MOVIMENTO 1 — remover o que já está morto (582 linhas, risco zero)

Nada muda de comportamento porque nada alcança esse código hoje (§2.3).

| O que sai | Linhas |
|---|---:|
| `src/agents/formation/evolutionTransactions.ts` (arquivo inteiro) | 219 |
| `src/agents/formation/evolutionLane.ts` (arquivo inteiro) | 207 |
| `EvolutionStore`: `prepareFormationPromotion`, `approvePreparedFormationPromotion`, `verifyFormationPromotionToken`, `formationTokenAuthorization`, `createCandidate`, `writeLearnings`, `recordHistory` | 156 |
| **total** | **582** |

Sai junto a **promessa escrita** que essas linhas fazem — que é, segundo a própria t-56ced4, o custo
real. Fica registrado que a custódia do `EvolutionStore` (intent + reconcile + rollback em
`approveCandidate`) **continua**, porque essa roda (§2.2). Os testes que hoje exercitam `createCandidate`
(28 sítios) migram para `submitReview`, que é a porta que a produção usa — aplicando a regra
"teste pela porta que a PRODUÇÃO usa".

### MOVIMENTO 2 — o portador vira nativo (≈185 linhas, risco baixo)

Hoje a Evolution guarda as skills aprovadas em `.tachyon/agents/<agente>/evolution/skills/<nome>/`
(`EvolutionStore.skillsDir`, L538) e as apresenta ao agente **como texto no prompt**:
`renderEvolutionPromptLayer` (`startupSnapshot.ts:212-228`) escreve um catálogo com nome, descrição,
caminho do `SKILL.md` e digest, com a instrução "leia um `SKILL.md` relevante". Isso é *progressive
disclosure reimplementada em prosa* — a coisa que os seis runtimes fazem nativamente (§1.1).

Passa a: a skill aprovada é materializada no **home privado do agente**, na raiz que o runtime já lê,
pelo mesmo caminho que hoje entrega `agent-browser` e `sdd` (§4). O prompt deixa de conter catálogo.

| O que sai | Linhas |
|---|---:|
| `src/evolution/skillBundle.ts` — duplica `src/plugins/skill.ts` (que ele **já importa**) e a materialização `skill-dir` do engine | 125 |
| `renderEvolutionPromptLayer` + a metade "catálogo de skills" de `startupSnapshot.ts` (a metade "learnings" fica) | ≈60 |
| **total** | **≈185** |

O que **não** muda: `LEARNINGS.md` continua camada de prompt, porque é fato durável e não procedimento
— a mesma separação que o Hermes faz entre `MEMORY.md` e skills, com as mesmas palavras (§1.6).

**Dois pré-requisitos, ambos medidos, ambos anteriores a este movimento e não criados por ele:**
`t-a7063c` (o grant de skill só é exigido no adapter `claude`, §6.2) e `t-987347` (o canal concede e
não revoga fora do Claude, §4.1). Enquanto valerem, entregar conteúdo **gerado por agente** por este
canal significa entregá-lo sem verificação de selo em codex/grok e sem garantia de que uma revogação
o retire. Para uma skill de plugin isso já é defeito; para a Evolution é a diferença entre a
capacidade e o seu oposto.

### MOVIMENTO 3 — o comportamento sai do core (o "vira plugin" propriamente dito)

O que ainda é core e **não precisa ser**: o texto que instrui o agente a refletir e a forma da
proposta. Hoje isso é `composeEvolutionReviewNotice` (`EvolutionCoordinator.ts:34`) mais o schema
`EVOLUTION_PROPOSAL` (`bridge/tools/shared.ts:665`) mais a descrição da tool.

Vira: um plugin `tachyon-evolution` que entrega **uma skill** — `SKILL.md` com quando refletir, o que
é uma boa proposta, os limites, e opcionalmente `scripts/` de validação. Instalada pelo humano,
concedida por agente pelo grant que já existe. É estruturalmente o `/learn` do Hermes: um prompt
guiado por padrão, entregue ao agente como um turno normal.

O agente que não tem o grant não paga nada: nem código, nem superfície, nem prompt.

### O que FICA no core, e por quê

| Peça | Linhas | Por que não pode virar plugin |
|---|---:|---|
| `EvolutionStore.ts` menos os cortes | ≈1868 | É o **ledger de autoridade**: profile, review, candidate, history, intent, reconcile, rollback, rename/retire. Um plugin não pode custodiar o que autoriza a si mesmo. |
| `authorityIntegrity.ts` | 108 | O selo (`sealAuthorityRecord` / `verifyAuthorityRecord` / `authorityRecordMac`). A spec Agent Skills não tem onde guardá-lo (§1.1). |
| `EvolutionCoordinator.ts` menos o texto do aviso | ≈120 | **O gatilho.** "Task concluída por este agente" não existe em runtime nenhum — o mais próximo é a heurística do Hermes ("5+ tool calls"). É informação do Tachyon. |
| `studioProjection.ts` | 148 | A superfície de revisão humana. É onde os 16,2 p.p. são ganhos (§1.8). |
| `domain.ts` | 154 | Tipos e regras do ledger. |
| metade "learnings" de `startupSnapshot.ts` | ≈168 | Fato durável ≠ procedimento. |

**Contas fechadas.** Das 2914 linhas: **582 morrem já** (§2.3), **≈185 morrem por delegação ao nativo**
(Movimento 2) — **767 no total, 26%**. Sobram **≈2147** que são ledger, selo, gatilho e revisão, e essas
**não encolhem por virar plugin** — encolhem, se encolherem, por outra decisão (por exemplo delegar o
gate ao Hermes onde ele existe, que é trabalho de paridade, não de plugin).

Dos **40 arquivos** fora de `src/evolution/` que tocam Evolution (17 mencionam `selfEvolution`, 26
importam `evolution/`, união 40 — mais que os 19 do corpo da task, que contava só uma das listas):
**2 somem inteiros** (`evolutionTransactions.ts`, `evolutionLane.ts`); **5 shells de studio**
(`command`/`runbook`/`schedule`/`terminal`/`agent-studio-shell/domain.ts`, 1 menção cada) e
`formLogic.ts` (7) mudam só se o toggle `selfEvolution` for substituído pelo grant — o que é uma
consequência do Movimento 3, não um pré-requisito; os demais (`loadConfig.ts` com 14 menções,
`Workspace.ts` com 6+3, `agentProfileResolver.ts`, `agentProfileProjection.ts`, `AgentManager.ts`)
ficam, porque são a ligação com o ledger e com o ciclo de vida.

### O que "não vale a pena", nomeado

**Mover o ledger e o selo de autoridade para dentro do plugin não vale a pena e não deve ser feito.**
Três razões, todas medidas: a spec do portador não tem onde guardá-los (§1.1); o único runtime que
resolveu o problema o resolveu do lado do host (§1.6); e enfraquecer a revisão troca a única parte com
ganho medido (§1.8). Isso não contraria a direção — a direção é tirar a *capacidade* do core, e a
capacidade é "refletir e propor". Custódia não é capacidade; é a condição para ela ser segura.

---

## 8. O mínimo da cadeia t-54cdb1..t-54cdb4

**Para a Evolution como skill concedida por agente: nenhuma das quatro é necessária.** A propriedade
que a cadeia entregaria — capacidade por sujeito, não por workspace — já está entregue no nível de
skill e está rodando (§4). Propor a cadeia inteira como pré-requisito seria pedir três tasks p3 para
construir algo que já existe.

O que a cadeia entrega **de fato** e que o grant não entrega: isolar o *payload* do plugin, de modo que
a skill nem sequer seja materializada no workspace. Isso importa em exatamente dois casos:

1. **Agentes temporários/delegados sem perfil recebem o conjunto do workspace** — medido, eu recebi 11
   de 12 (§4). Se for inaceitável que um agente delegado receba a skill de Evolution, o mínimo é
   **t-54cdb1** (o modelo canônico de escopo `{type:"agent", name}` no plano, com fail-closed em
   preview/consent/fingerprint/apply) **+ t-54cdb2** (materializar no harness privado).
   **Alternativa mais barata, e é a que eu recomendo primeiro:** decidir que a skill de Evolution
   simplesmente **não é herdável por delegação** e tratar isso na projeção de agente temporário. É uma
   regra, não um subsistema — e a `docs/project-guidance.md` diz para preferir a regra ("máquina é o
   último recurso").
2. **Se o plugin de Evolution precisar entregar MCP server ou hook** além da skill. Aí o mínimo é
   t-54cdb1 + t-54cdb2, sem exceção, porque MCP e hook não têm o equivalente do grant de skill por
   agente. **O desenho da §7 evita isso de propósito: skill e nada mais.**

**t-54cdb3** (UI de consentimento por agente) e **t-54cdb4** (lockfile por escopo) não são mínimo em
nenhum dos cenários acima: a superfície de autorização por agente já existe no Agent Studio, e o
lockfile atual já discrimina `skill-dir` por plugin com `version` e `sha256`.

**Resposta às três perguntas da nota do journal:**
1. A Evolution-como-plugin **não depende** de instalação por agente. Funciona com escopo de workspace
   + grant por agente — e o ganho **não** é menor do que parece, porque o grant é fixado por conteúdo e
   selado na autoridade, que é mais forte que uma chave de config booleana.
2. O mínimo é **nenhuma** das quatro; e **t-54cdb1 + t-54cdb2** apenas se a resposta ao caso (1) acima
   for "inaceitável" e a regra barata for rejeitada.
3. "Instalado para o agente X" e "alcança o worktree do agente X" continuam coisas diferentes — e o
   desenho **não usa o worktree**. A entrega é no home privado. A decisão de 2026-07-31 sobre
   `.claude/skills` no worktree fica intocada, e nenhuma das três saídas que a nota listava é
   necessária: não precisamos de projeção nominal como a dos hooks, nem de herança explícita, nem de
   dizer que a evolução não pertence ao agente. Ela pertence ao agente, pelo home privado.

---

## 9. O PADRÃO: capacidade do core → plugin injetável por agente

Este é o entregável que sobrevive à Evolution. Cinco peças. A Evolution é o **segundo** exemplo — o
primeiro já está no código, é o `agentHookProjection.ts`, e foi construído sem que ninguém o chamasse
de padrão.

| # | Peça | Pergunta que responde | Onde já existe |
|---|---|---|---|
| 1 | **PORTADOR** | Em que formato a capacidade é feita, para o runtime carregá-la sem que a gente invente nada? | Skill (`SKILL.md` + `scripts/references/assets`). Paridade 6/6 (§5). É o único portador que tem. |
| 2 | **CUSTÓDIA** | De onde vieram estes bytes, em que versão, e quem os trouxe para este workspace? | Lockfile de plugin (`.tachyon/plugins.lock.json`, alvo `skill-dir`, `version`, `sha256`). Nunca o ambiente, nunca o cwd, nunca `$HOME`. |
| 3 | **CONCESSÃO** | **Este** agente pode usar **este conteúdo exato**? | `authority.capabilityGrants` (fixado por sha256, selado) + `capabilities.skills` (seleção). Já roda (§4). |
| 4 | **CANAL** | Por onde a capacidade chega a UM agente **e por onde ela sai**, sem tocar o workspace nem o worktree? | O home privado por runtime, materializado a cada spawn: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`, `PI_CODING_AGENT_DIR`, XDG do OpenCode, `HERMES_HOME`. É o canal por agente que os runtimes não têm — nenhum deles tem escopo de plugin por sessão (§1.2) — e que o Tachyon **já tem**. **Metade dele, hoje:** concede em todos, revoga só no Claude (§4.1). |
| 5 | **RECUSA NOMINAL** | O que acontece no runtime onde o canal não existe? | Recusa **por nome, com motivo** — nunca silenciosamente vazia. A regra já está escrita em `agentHookProjection.ts` ("every other runtime — refused by name with a reason"). |

**A observação que faz o padrão funcionar, e que é o achado central deste estudo:** nenhum dos seis
runtimes tem escopo de plugin por agente — o Claude Code tem `user`/`project`/`local`/`managed`, todos
de máquina ou de repositório (§1.2). O Tachyon não precisa de um: **ele já dá a cada agente um HOME
privado, e "pessoal" dentro de um home privado por agente É por agente.** A injeção por sujeito não se
constrói mudando o runtime nem inventando escopo; ela cai fora do isolamento que já existe.

**O que dá dentes ao padrão** (`docs/project-guidance.md`): a lista ATOR × GATILHO vira a lista de
casos de teste, com os mesmos nomes. Para qualquer capacidade que siga este padrão:

- *Interface × install/uninstall* — escreve o lockfile de autoridade. Não alcança sessão viva.
- *Interface × authorize/revoke* — escreve referência **e** grant na mesma transação.
- *Agent × create / restart / resume / fork* — um canal por runtime, recomputado do lockfile + grant a
  cada spawn; nunca herdado de sessão anterior.
- *Interface × revoke, e o perfil fica com seleção VAZIA* — o caso que a §4.1 mede como quebrado em
  Grok. Vazio é uma seleção, não uma ausência de seleção: a materialização tem de **purgar
  incondicionalmente antes de decidir**, como o Claude faz, senão "conceder" é permanente. Este
  gatilho é o que faltava na lista, e ele só apareceu porque alguém foi olhar o disco.
- *Agent × delegation* — decisão explícita: herda ou não. Hoje herda o toolkit do delegador, e um
  temporário sem perfil recebe o conjunto do workspace (§4). Este é o gatilho que a Evolution obriga a
  responder.
- *Tachyon × crash-recovery* — re-deriva do lockfile custodiado; importa zero do ambiente em que
  acordou.
- *runtime sem canal* — recusa por nome.

**Segundo caso de aplicação, já medido e esperando decisão:** memória nativa por runtime — 1443 linhas
construídas e não ligadas (§2.4). O padrão diz o que falta lá: portador (o `MEMORY.md`/equivalente de
cada runtime, já mapeado em `nativeMemory.ts`), custódia e concessão (não existem ainda), canal (existe:
o home privado), recusa nominal (`nativeLaneSuppression.ts` já é isso). É o próximo teste do padrão, e
provavelmente o maior ganho do eixo do dono depois deste.

---

## 10. Riscos e o que este estudo NÃO mediu

- **Não rodei nenhum runtime.** Toda paridade da §5 vem de documentação atual (§1) mais medições já
  registradas no `parity.md`, com data. Antes do Movimento 2 tocar codex/grok/pi, a materialização real
  no home privado precisa de uma medição viva por runtime — a mesma disciplina que a `t-84c678` usou
  com `grok inspect --json`.
  **Este risco já se realizou na revisão deste documento**: a §4.1 é exatamente ele, e foi encontrada
  porque alguém foi olhar o disco do runtime que eu tinha medido no diretório errado. O que a leitura
  de código não pega é o que **sobrou** de uma materialização anterior — e "sobrou" é o estado que
  importa aqui.
- **Codex e Pi não foram medidos em disco.** Ambos têm a mesma guarda `if (profileCapabilities)` que
  produziu o defeito do Grok (`HarnessManager.ts:2232-2234` e `materializePiProfileHome`). Não afirmo
  que têm o defeito; afirmo que a medição que o encontraria não foi feita.
- **A doc oficial de skills do OpenCode não foi extraída** (§1.5). O suporte nativo está caracterizado
  pelo README de um plugin de terceiros e pelo showcase do agentskills.io.
- **Não medi custo de contexto.** Trocar catálogo-no-prompt por descoberta nativa muda quantos tokens o
  agente paga no startup, e em que momento. A spec diz ~100 tokens por skill na descoberta; o nosso
  catálogo atual escreve nome + descrição + caminho + digest por skill. Provavelmente empata ou melhora,
  mas é impressão, não medição — e a `docs/project-guidance.md` é explícita sobre isso.
- **Skills como superfície de execução.** `allowed-tools` do Claude Code pré-aprova ferramentas para o
  turno que invoca a skill, e `${CLAUDE_SKILL_DIR}` permite rodar script embarcado sem prompt. Uma skill
  **gerada por agente** que carregasse `allowed-tools` seria escalada de privilégio por conteúdo. A
  validação de bundle atual (`skillBundle.ts`) só exige `name` e `description`; se o Movimento 2 remover
  esse arquivo, o **validador do plugin** (`src/plugins/skill.ts`, que também só valida os dois campos)
  passa a ser o único guarda. **Recusar `allowed-tools` em skill de origem Evolution é requisito**, e
  precisa de teste fail-before. Não é regra de segurança inventada: é a consequência direta de um campo
  documentado (§1.2) encontrando um autor não-humano.

---

## 11. Fontes (todas consultadas em 2026-08-11)

| Fonte | URL | O que sustenta |
|---|---|---|
| Agent Skills — Specification | <https://agentskills.io/specification> | frontmatter completo; ausência de versão/autor/assinatura/aprovação/rollback |
| Agent Skills — Overview | <https://agentskills.io> | padrão aberto de origem Anthropic; showcase com Claude Code, Codex, OpenCode, pi, Hermes |
| Claude Code — Skills | <https://code.claude.com/docs/en/skills> | caminhos, precedência, symlink, live reload, `metadata` inerte, `/verify` e `/run-skill-generator` escrevendo skill (v2.1.200+) |
| Claude Code — Plugins reference | <https://code.claude.com/docs/en/plugins-reference> | escopos user/project/local/managed; `version`, `defaultEnabled`; `@skills-dir`; cache de versões com 14 dias |
| Codex — Build skills | <https://learn.chatgpt.com/docs/build-skills> (308 de <https://developers.openai.com/codex/skills>) | escopos REPO/USER/ADMIN/SYSTEM em `.agents/skills`; sem metadados de confiança |
| Codex — docs/skills.md | <https://github.com/openai/codex/blob/main/docs/skills.md> | aponta para a anterior |
| xAI — Skills, Plugins & Marketplaces | <https://docs.x.ai/build/features/skills-plugins-marketplaces> | `.grok/skills`, `~/.grok/skills`, `[skills] paths`; plugins e marketplaces; compat Claude Code zero-config; `/hooks-trust` |
| opencode-agent-skills (README) | <https://github.com/joshuadavidthomas/opencode-agent-skills> | **o recuo**: "OpenCode now includes first-party support … this plugin is no longer necessary"; ordem de descoberta |
| opencode-agent-memory | <https://github.com/joshuadavidthomas/opencode-agent-memory> | memory blocks auto-editáveis inspirados em Letta |
| Hermes Agent — Skills | <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/skills.md> | `skill_manage`; `~/.hermes/skills/`, `.hub/` (lock, quarantine, audit.log); `version` no frontmatter; `write_approval` + `pending/` + `/skills diff|approve|reject`; `/learn` |
| Hermes Agent — Memory | <https://hermes-agent.nousresearch.com/docs/user-guide/features/memory> | `MEMORY.md`/`USER.md` como snapshot congelado; tool `memory`; `memory.write_approval`; 8 providers |
| pi — skills | <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md> | raízes de skill, `/skill:name`, `--skill`, `enableSkillCommands: false` / `--no-skills` |
| SkillAxe (arXiv 2606.10546) | <https://arxiv.org/abs/2606.10546> | 16,2 p.p. para skills humanas vs **ganho nulo** para skills escritas por LLM (SkillsBench) |

**Fontes internas:** `docs/runtimes/parity.md` §3.1/§3.2/§3.3, `docs/runtimes/opencode.md`,
`docs/runtimes/pi.md`, `docs/runtimes/hermes.md`, `docs/research/runtime-native-memory-parity-t-d4c42e.md`,
`docs/research/t-73b2e1-core-plugin-coupling-map.md`, `docs/project-guidance.md`.
**Tasks:** t-56ced4, t-75ce10, t-54cdb1..t-54cdb4, t-5498a6, t-2f37e7, t-84c678, t-62f599, t-36182f,
t-09edf2, t-843576, t-a7063c e t-987347 (as duas últimas abertas por este estudo).
