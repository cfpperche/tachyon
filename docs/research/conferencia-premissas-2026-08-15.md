# Conferência de premissas — 2026-08-15

**Agente:** confere (delegado; sem claim no board)  
**Árvore:** `f7f66b4d463197b2d52ecc97c511183792383f83` (`tachyon/tmp.confere.20260816-001141-5993`)  
**Regra:** conferir, não consertar, não reescrever cartões.

Três perguntas por cartão, com arquivo e linha: os caminhos citados ainda existem? o problema ainda existe (medido)? a premissa ainda vale?

Vereditos: **vale como está** · **precisa reescrever** · **já resolvido**.

---

## Grupo 1 — `t-b0a229` (kit / “migrar a sidebar / fatia 8”)

O brief descreveu este id como “migrar a sidebar para o kit (fatia 8 do design system)”. O cartão no board não é isso. É o épico de 2026-07-03: *“Design system: mapear e migrar tela a tela… (trilha da 342)”*.

A fatia 8 que existe hoje é da **SDD 505**, não da 342, e não é um cartão “sidebar”:

```269:274:docs/specs/505-design-system-audit/spec.md
**Slice 8 — the surfaces, worst first.** *(pays: proportional to the counts)*

Order by measured debt, not by importance: `sidebar` (93 direct theme refs, 26 hex, 10 raw buttons,
4 private tokens), `activity` (69/32), `runtime-config` (44/3), `settings` (36/15), `rich-doc`
(20/3 + 18 raw buttons), `agent-pane` (§8), `board`, `agent-studio-shell`. Each is a separate task
```

A primeira fatia 8 que o board já teve é `t-7cb9fe` — *“SDD 505 fatia 8 — migrar `activity`…”* — status **landed**. Sidebar é o primeiro nome na lista de dívida da 505, mas não há cartão vivo “migrar a sidebar”.

### 1. Caminhos

| Citado | Estado nesta árvore |
|---|---|
| `src/webview/shared/ui/` (corpo/journal/STYLEGUIDE) | **MISSING** — monorepo: `packages/webview-ui/src/webview/shared/ui/` |
| `src/webview/shared/design-system.css` (`docs/STYLEGUIDE.md:7`) | **MISSING** |
| `docs/plans/unified-webview-design-system.md` (`docs/STYLEGUIDE.md:144`, `packages/webview-ui/src/webview/shared/ui/README.md:3`) | **MISSING** (`docs/plans/` não existe) |
| `docs/STYLEGUIDE.md:151` (tabela de migração) | **EXISTS**, mas não lista sidebar |

O kit cresceu além do que o cartão lista. Além de `KitSelect`/`KitDropdown`/`KitPopover`/`KitFieldRow`/`KitLabeledInput`, existem `KitDialog` e `KitTooltip` em `packages/webview-ui/src/webview/shared/ui/kit/` (`t-c7e518` landed). Toast e Tabs, que o cartão chamava de “candidatos a batch 2”, estão em `packages/webview-ui/src/webview/shared/ui/{Toast,Tabs}.tsx`.

### 2. O problema ainda existe?

Sim, como dívida de superfície — não como “o kit não existe”.

A sidebar já importa primitivos (`Button`, `Badge`, `EmptyState`, `DenseRow`, `QuickPicker`) em `packages/webview-ui/src/webview/sidebar/App.tsx:3,31`, e ao mesmo tempo recusa o box do kit nos hits de 22×22 (`App.tsx:662`; `sidebar.css:348–353`). A tabela piloto de `docs/STYLEGUIDE.md:148–160` marca Activity/Plugins/Board-head como done e **omite a sidebar**.

Não há a matriz surface×controle nem “uma task filha POR SURFACE” que a Fase 1 pedia. A 505 já fez o censo e a ordem por dívida.

### 3. A premissa ainda vale?

A premissa de 2026-07-03 (“342 entregou o kit + 2 pilotos; o resto é `.ds-*` artesanal”) está velha. O programa vigente é a SDD 505. Despachar `t-b0a229` como “migrar a sidebar / fatia 8” é o mesmo erro que o brief descreveu em `t-50feac`: o id não é o trabalho que o título do brief imagina.

**Veredito: precisa reescrever.** Ou vira um ponteiro para as fatias 8 restantes da 505 (sidebar primeiro por dívida), ou cai — não despachar o épico de julho como se fosse a fatia.

---

## Grupo 2 — SDD 504 boot da sidebar (`t-bb152a`, achado pelo nome)

Não havia id no brief. O cartão é `t-bb152a`: *“A sidebar afirma ‘No Tachyon workspace’ durante 10 a 30 s de boot…”*. Status **done**. Kind `design`. A SDD 504 (`docs/specs/504-sidebar-boot-truthful-state/`) foi o entregável de planejamento. `tasks.md` diz explicitamente: *“Nothing below is implemented by t-bb152a.”*

Não há cartão de implementação no board (varredura compacta de todos os status; nenhum título 504 / truthful boot / “ainda não sei”).

### 1. Caminhos

| Citado no cartão | Estado |
|---|---|
| `src/webview/sidebar/App.tsx:1492` | **MISSING** — agora `packages/webview-ui/src/webview/sidebar/App.tsx:1473` |
| `src/extension.ts` | **MOVED** — `apps/vscode-extension/src/extension.ts` |

### 2. O problema ainda existe?

**Sim. O mesmo booleano, a mesma mentira.**

```1472:1481:packages/webview-ui/src/webview/sidebar/App.tsx
  // No workspace booted → an honest empty state, never SAMPLE (which would show fake, unactionable rows).
  if (!fleets.length) return (
    <div class="init">
      <Icon name="rocket" />
      <p>No Tachyon workspace.</p>
      <p class="dim">Open a folder, then generate a <code>tachyon.yml</code> to manage its fleet here.</p>
      <Button class="init-btn" onClick={() => dispatch?.global("init")}>
        <Icon name="add" /><span>Initialize Tachyon</span>
      </Button>
```

Não há `booting` / `configured-and-starting` / `confirmed-unconfigured` / `delayed` / `failed` em `sidebar/App.tsx` (um único `unknown` no arquivo é tom de persistence-hooks, linha 495). O teste vigente **fixa** o estado vazio como correto quando `fleets: []`:

```182:186:test/unit/sidebarWorkspaceSelection.test.ts
  it("renders an honest empty state, not a selector, when no workspace is attached", () => {
    const html = render({ fleets: [], initialTab: "Agents" });
    expect(html).toContain("No Tachyon workspace.");
    expect(html).not.toContain('data-testid="sidebar-workspace-select"');
  });
```

Isso prova o welcome de ausência confirmada; não distingue “ainda não ouvi o engine”. Os seis estados da 504 não estão no protocolo.

### 3. A premissa ainda vale?

A premissa do **planejamento** foi cumprida (SDD escrita, medição de activate 1.7–3.5 s). A premissa de que o **defeito** sumiu com o `done` é falsa. O journal do próprio merge já avisava: a ausência é conhecível no turno de ativação; a tela vazia é o default do webview, não uma espera necessária.

**Veredito: já resolvido como plano; o defeito está vivo e sem cartão de implementação.** Não reabrir `t-bb152a`. Quem despachar “SDD 504” precisa de um cartão novo que cite `packages/webview-ui/src/webview/sidebar/App.tsx:1473`, não `src/…:1492`.

---

## Grupo 3 — `t-c2209d` checklists internos

Status **triaged**. Journal de 2026-08-15 já cortou o escopo para claude/codex/grok e pediu o vocabulário da 508.

### 1. Caminhos

| Citado | Estado |
|---|---|
| `docs/research/runtime-internal-checklist-capabilities.md` | **EXISTS** (medição 2026-07-28; Claude 2.1.220 / Codex 0.145.0 / Grok 0.2.112 + OpenCode/Pi/Hermes) |
| `docs/runtimes/parity.md` “nova dimensão” | **EXISTS** como prosa: dimensão **18**, linhas 66 e 102 |
| `src/runtime/nativeMemory.ts` (journal 2026-08-02) | **MISSING** — agora `packages/engine/src/runtime/nativeMemory.ts` |
| `src/attention/manifests/grok.json` (mesmo journal) | não reconferido aqui; a forma viva da matriz tipada é outra |

A varredura de 2026-08-02 (`premissas`) disse que o research “não existe”. Nesta árvore ele existe. Ou a varredura mediu um HEAD sem o arquivo, ou o arquivo voltou. Não despachar uma re-medição de seis CLIs sem ler o que já está no disco.

### 2. O problema ainda existe?

A **pesquisa** de existência/semântica já está escrita. A **integração** (Tachyon observar o checklist) nunca esteve no escopo (“nenhuma implementação de integração nesta task”) e continua ausente.

O que o cartão pedia como entregável de produto — “nova dimensão na matriz” no sentido de 2026-07-28 — mudou de forma. Depois da SDD 508:

```6:13:packages/engine/src/runtime/parity.ts
export const PARITY_DIMENSIONS = [
  "session-hooks",
  "headless-probe",
  "observed-model-provenance",
  "probe-model-proof",
  "cross-runtime-task-continuation",
  "persistent-instructions-launch",
] as const;
```

Seis dimensões tipadas. Nenhuma é checklist. `docs/runtimes/parity.md:102` classifica a 18 como **narrative / `measured`**, com o motivo: *“no product function decides support; file names do not prove emission”*. A fatia 2 da 508 diz a mesma coisa:

```88:88:docs/specs/508-paridade-verificavel/notes.md
| 18 | Internal checklist telemetry | `measured` | A linha descreve eventos/arquivos estruturados nativos e correlação/proveniência, hoje não integrados para os três. Nenhuma função de produto decide suporte; nomes como `plan`/`todo` não provam que o CLI emite nem correlaciona a estrutura. |
```

### 3. A premissa ainda vale?

Não na forma do corpo. O corpo ainda pede três fases (incluindo OpenCode/Pi/Hermes), vocabulário `verified | limited | unsupported | unproven`, e “nova dimensão” como se a matriz fosse prosa a estender. O dono já cortou fases 2–3 no journal. A 508 já recusou transformar a 18 numa célula tipada sem uma porta de produto.

**Veredito: precisa reescrever.** O trabalho restante, se houver, é (a) re-medir claude/codex/grok nas versões de hoje com o método da 508 (canário + controle negativo) e só então decidir se a 18 sobe à tabela, ou (b) fechar o cartão apontando o research de 2026-07-28 + a classificação narrativa. Despachar o corpo atual refaz pesquisa que já está em disco e pede um segundo dialeto na mesma matriz.

---

## Grupo 4 — onda de plugins (`t-54cdb1` `t-54cdb2` `t-54cdb3` `t-54cdb4` `t-54cdb7`)

Pergunta urgente do brief: *`.tachyon/harness/claude/skills/` tem as 3 skills que o perfil autoriza; `.claude/skills/` tem 10+ do workspace. Isso sugere que `t-54cdb2` já está entregue.*

**Desmentido.** A observação é real e mede **outro mecanismo**.

### Medição ao vivo (checkout primário `/home/goat/tachyon`, 2026-08-15)

Perfil canônico `claude` (`/home/goat/tachyon/.tachyon/agents/claude/agent.yml:20-23`):

```yaml
capabilities:
  skills:
    - agent-browser
    - sdd
    - visual-qa
```

`references[]` (linhas 67–91) são `scope: project`, `owner: plugin:<nome>`, path `.tachyon/plugins/<nome>/skills/<skill>`.

| Árvore | Conteúdo |
|---|---|
| `.tachyon/harness/claude/skills/` | **3:** `agent-browser`, `sdd`, `visual-qa` |
| `.claude/skills/` | **12:** as 3 + `audio` `dep-audit` `diagram` `hyperframes` `image` `product-foundation` `sound` `transcribe` `video` |
| `.agents/skills/` | **11** (sem `product-foundation`) |
| `.grok/skills/` | **11** (sem `product-foundation`) |
| `.tachyon/plugins.lock.json` | 15 plugins; **34** targets `skill-dir`; **0** campos `scope` |

Esta worktree **não** tem `.claude/skills` nem harness próprio. Um agente lançado daqui não vê o roster do primário por cwd; um lançamento com `cwd === workspaceRoot` veria.

### De onde vêm as 3 do harness

Não do plugin engine. Do projetor de perfil:

```1648:1663:packages/engine/src/harness/HarnessManager.ts
  private replaceCapturedSkillTree(agent: string, root: string, projection: ResolvedAgentCapabilityProjection): void {
    const target = path.join(root, "skills");
    // ...
      for (const skill of projection.skills) this.writeCapturedCapability(agent, skill.source, path.join(stage, skill.name));
```

Claude canônico chama isso na home privada e lança com `--setting-sources user`:

```2832:2852:packages/engine/src/harness/HarnessManager.ts
    if (capabilities) {
      this.replaceCapturedSkillTree(agent, home, capabilities);
      this.writeProfileCapabilityManifest(agent, home, capabilities);
    }
    // ...
      args: [
        "--setting-sources", "user",
        "--settings", settingsPath,
```

`authorizeAgentPlugin` já existe e grava `references[]`+grants só naquele perfil:

```287:318:packages/engine/src/config/agentSkillAuthorizationService.ts
export async function authorizeAgentPlugin(input: {
  workspaceRoot: string;
  agentName: string;
  pluginName: string;
  // ...
}): Promise<{ ok: true; authorized: string[]; outcomes: SkillAuthorizationOutcome[] } | { ok: false; error: string; authorized?: string[] }> {
```

A UI que chama isso é o Agent Studio (`apps/vscode-extension/src/webview/agent-studio-shell/agentStudioDomain.ts:283`), não a Plugins View.

### De onde vêm as 12 do workspace

O plugin engine ainda tem destinos **fixos de projeto**:

```105:110:apps/vscode-extension/src/plugins/engine.ts
const ADAPTERS: Record<Runtime, AdapterSpec> = {
  claude: { settingsRel: ".claude/settings.json", parseBlock: parseClaudeHooksBlock, skillsRel: ".claude/skills", mcpRel: ".mcp.json" },
  codex: { settingsRel: ".codex/hooks.json", parseBlock: parseCodexHooksBlock, skillsRel: ".agents/skills", mcpRel: ".codex/config.toml" },
  grok: { settingsRel: ".grok/hooks/tachyon-plugins.json", parseBlock: parseGrokHooksBlock, skillsRel: ".grok/skills", mcpRel: null },
};
```

`InstallPreview` (`engine.ts:803-839`) e `applyInstall` (`engine.ts:1413`) não têm campo de scope. `PluginLock` (`packages/engine/src/plugins/lockfile.ts:64-96`) não tem `scope`. Grep por `{type:"agent"}` / `InstallScope` em `**/plugins/**` = **zero**. Grep por `requiresPlugins` / `scope: self` no repo = **zero**.

O próprio HarnessManager ainda chama o instalador de dono do roster compartilhado (e ainda cita caminhos pré-monorepo):

```2646:2650:packages/engine/src/harness/HarnessManager.ts
    // t-94d49a — REFUSE rather than replace a directory this projection does not own. The skill tree
    // below goes to `<cwd>/.agents/skills`, and with the agent's worktree OFF `cwd` IS the workspace
    // root — where that directory belongs to the plugin installer (`src/plugins/engine.ts` codex
    // `skillsRel`, recorded per install in `src/plugins/lockfile.ts` …
```

### O leak que `t-54cdb2` nomeia ainda existe

`docs/research/runtime-write-discovery-isolation-t5313dc.md:23`: *“Project skills are fixed to `.claude/skills` from the launch directory through the repo root.”* `--setting-sources user` foi medido contra `CLAUDE.md` (SDD 490), **não** contra descoberta de skills de projeto. Codex 0.146.1 lê `<cwd>/.agents/skills` sem root substituto (`HarnessManager.ts:2655-2656`; `t-94d49a` recusa projetar grant em cima do roster do instalador).

Portanto: as 3 skills no harness provam que **a projeção de perfil funciona**. Não provam que o **install** é agent-scoped. Um agente sem grant, lançado no workspace root, ainda vê o roster de 12/11. Isolamento de autorização ≠ isolamento de destino. Isso é exatamente a decisão do dono em `t-f095b5` / `j-cbdb9b5727c7`.

### O que isso faz com os outros quatro

| Cartão | Efeito da medição |
|---|---|
| `t-54cdb2` | **Não entregue.** Continua o centro da onda. O corpo ainda é o trabalho: o engine escrever no harness quando o destino é um agente, em vez de `.claude/skills`. |
| `t-54cdb1` | **Não entregue.** Sem `{type:"workspace"\|"agent"}` no plano/fingerprint/apply. Mas o corpo fala como se o primeiro conceito a inventar fosse o grant — e o grant já existe. Reescrever para “escopo de DESTINO no install”, sobre `authorizeAgentPlugin`. |
| `t-54cdb3` | **Não entregue**, e o journal já diz ENCOLHE. Plugins View não tem `Scope: agent <nome>`. O que existe é autorizar no Studio. Reescrever para consentir **destino** (harness deste agente vs workspace), não um segundo modelo de grant. |
| `t-54cdb4` | Corpo já reescrito em 2026-08-15 (forget NÃO remove plugin). Lockfile ainda sem scope — o problema de identidade `(plugin, scope)` só nasce se `t-54cdb1` existir. |
| `t-54cdb7` | `requiresPlugins` / `scope: self` não existem. Continua dependente de `t-54cdb2`. Reescrever a linguagem `agent:<newName>` para destino de harness; forget do agente não desinstala payload compartilhado. |

---

## Vereditos

| Id | Grupo | Veredito | Motivo em uma linha |
|---|---|---|---|
| `t-b0a229` | kit | **precisa reescrever** | Épico 342 com `src/` e plano mortos; fatia 8 vigente é 505/surfaces (`t-7cb9fe` já levou activity). |
| `t-bb152a` | SDD 504 | **já resolvido como plano; defeito vivo** | SDD existe; `App.tsx:1473` ainda colapsa “não sei” em “não existe”; sem cartão de implementação. |
| `t-c2209d` | checklists | **precisa reescrever** | Research de 2026-07-28 existe; 508 deixou a dim 18 narrativa; corpo pede fases e vocabulário velhos. |
| `t-54cdb1` | plugins | **precisa reescrever** | Sem scope no engine; autorização já existe; o que falta é destino. |
| `t-54cdb2` | plugins | **precisa reescrever o entendimento, não está entregue** | 3 skills no harness = `replaceCapturedSkillTree`; install ainda escreve 12 em `.claude/skills`. |
| `t-54cdb3` | plugins | **precisa reescrever** | ENCOLHE: Studio já autoriza; Plugins View não escolhe destino. |
| `t-54cdb4` | plugins | **vale como está** | Corpo já corrige forget; lockfile ainda sem scope, o que é o trabalho. |
| `t-54cdb7` | plugins | **precisa reescrever** | `requiresPlugins`/`scope:self` inexistentes; depende de destino, não de copiar payload. |

`t-50feac` não foi reaberto (dropped, brief stale).
