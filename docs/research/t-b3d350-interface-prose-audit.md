# Auditoria da prosa de interface — 32 telas (+ Onboarding em voo)

**Data:** 2026-08-20
**Autor:** telasglm (delegado; cartão `t-b3d350`)
**Árvore:** `8ed9d434` (`tachyon/tmp.telasglm.20260820-200604-de2a`, base = `main`)
**Entrega:** análise, nenhum arquivo de app foi alterado. Este documento é o único artefato.

Vereditos: **FICA** (rótulo, estado ou consequência da ação iminente) · **ENCOLHE** (diz a coisa certa em palavras demais; texto curto proposto) · **MUDA DE LUGAR** (conhecimento de modelo/arquitetura; destino indicado) · **SOME** (não ajuda ninguém naquele momento).

---

## 0. Premissa verificada — e um desvio importante

A premissa vale, com uma correção de endereço que muda a leitura do exemplo:

- **32 apps** confirmados em `packages/webview-ui/src/webview/` (fora `shared/`).
- **11 strings >110** em `apps/vscode-extension/src/webview/controlStrings.ts` — reproduzido exato.
- **24 `class="ds-dim"`** exatos (+ ~30 variantes `stack`/`meta-line`), **18 `hint=`**, **30 `<EmptyState>`** — todos reproduzidos exatos.
- A contagem de **58 strings >110** no cartão depende do método: por varredura de linha há **35** literais >110, das quais **17 são strings de classes Tailwind** em `shared/ui/vendor/` (não são prosa). Prosa longa real: ~18 literais de linha + literais multilinha (ex.: riscos de autorização em `agent-studio-shell/domain.ts`) + parágrafos JSX. O inventário abaixo vem da **leitura integral** dos 32 `App.tsx` + catálogos, não do heurístico de comprimento.

O desvio: **o exemplo que originou o cartão não está no `main`.** A frase *"Agents are not declared in tachyon.yml — an agent is a profile under .tachyon/agents/, created by Agent Studio"* vive no app de Onboarding, que existe na branch em voo `tachyon/tmp.onboardglm.20260820-171701-9f56` (cartão `t-505f13`, commits `4d7bcfc2` + `4fcfacc7`) — o devhost apontava para lá. A auditoria cobre os 32 apps do `main` **mais** o Onboarding lido nessa branch (33º app, linhas são da branch). Quando `t-505f13` pousar, o item 1 do inventário já está coberto.

O achado lateral mais útil: o catálogo `controlStrings.ts` declara **34 chaves que nenhum app renderiza** (restos do Control pré-SDD 500) — §3.

### Escopo declarado

Conta como prosa de interface: `hint=` do PageChrome, parágrafos `ds-dim`, mensagens de `EmptyState`, `class="hint"` de bloco, strings de catálogo que alimentam tela, badge/tooltip que explica em vez de rotular. Não conta: rótulo de botão/campo, badge de enum, `title=` derivado de texto visível, aria-label espelho, classes CSS. Fixtures de preview (`section-app-fixture`, `agent-studio-fixture`, `pin-preview`, `ui-gate`) ficam fora: não são telas de produção.

---

## 1. O princípio (proposto; em inglês para entrar direto no `docs/project-guidance.md`)

> Uma página no máximo. Se passar de uma página, está errado.

```markdown
## The screen states; the manual teaches

Interface text earns its pixels one of two ways: it names what is on screen
(label, value, state), or it names what is about to happen (the consequence of
the gesture in front of the reader). Everything else — how the system is
modeled, why a rule exists, what a file is for — is documentation. It belongs
in docs/, in a tooltip, or behind a link, never in a paragraph on the screen.

The test is one question: **will the reader act on this text, right here?**
"Releasing it deletes nothing" is read and used. "An agent is a profile under
.tachyon/agents/" is read once, remembered never, and reshown forever.

- A consequence is one sentence in plain voice ("Restart a running session
  to disarm"). A state is a fact, not a story.
- A hint answers the question the reader plausibly has ON THIS SCREEN, in at
  most one sentence per question. Enumerating knobs belongs to the screen
  that shows the knobs.
- An empty state is one sentence of state plus one action ("No plugins
  installed. Install one by its source above."), never a paragraph.
- Progressive help carries the depth: tooltip holds the term, link holds the
  topic, docs hold the model. "If you have to explain how the user interface
  works… fix the interface so it does not need explaining" (GOV.UK).
- Where a write lands is a consequence: keep "Writes
  settings.companion.tabTools in tachyon.yml".
- Two exceptions earn their prose: a CONSENT surface may spell out cost,
  risk and undo — that text is the product there; and the ONBOARDING screen
  may teach, briefly, because teaching is its function.

When a text grows past three sentences, do not shorten it — ask which
document it was pretending to be, and send it there.
```

---

## 2. Inventário por app, com veredito

Formato: `arquivo:linha` · categoria · texto · **veredito** — justificativa (e proposta, quando ENCOLHE).

### 2.1 activity (`webview/activity/`)

| Onde | Categoria | Texto | Veredito |
|---|---|---|---|
| `App.tsx:498` | EmptyState (erro) | "Structured activity is unavailable for this runtime. Open the terminal to see the live session." + ação | **FICA** — estado + saída; uma frase. |
| `App.tsx:562-563` | capnote + title | "history unavailable — agent shares this folder with no distinct session" (title explica o porquê em 118 chars) | **FICA** — consequência/estado; o title é o lugar do detalhe. |
| `App.tsx:577` | EmptyState | "All matching activity is hidden by type filters" / "No matches in recent activity" / "Waiting for activity…" | **FICA** — três estados, uma linha cada. |
| `App.tsx:617` | picker subtitle | "Opens Email or WhatsApp with the item text (preview confirm on host)." | **FICA** — consequência da ação ofertada. |
| `App.tsx:635` | picker subtitle | "Pastes focused context into the destination (not submitted)." | **FICA** — o "(not submitted)" é exatamente o que o leitor precisa antes de agir. |
| `markdown.tsx:302` | aria-label | "diagram viewport, scale {…}. Opens fit-to-width for reading; Fit shrinks fully. Ctrl+scroll zoom; drag pan when overflow. Keys: + − 0 F, arrows pan." (158) | **ENCOLHE** → `"Diagram viewport, scale {…}. Ctrl+scroll zoom; drag pan; keys + − 0 F."` — a ajuda de teclas duplica controles visíveis e o aria carrega o manual todo. |

### 2.2 agent-pane (`webview/agent-pane/`)

| Onde | Categoria | Texto | Veredito |
|---|---|---|---|
| `App.tsx:402` | tooltip | "Pin selection (or clipboard). Tip: Shift+drag if the agent captures the mouse — blue TUI highlight alone is not an xterm selection." (131) | **ENCOLHE** → `"Pin selection. Shift+drag if the agent holds the mouse."` — a aula sobre highlight de TUI vs seleção xterm é documento de modelo. |
| `App.tsx:423` | tooltip | "Paste without Enter — review in the TUI composer" | **FICA** — consequência. |
| `App.tsx:432` | tooltip | "Paste + Enter (Ctrl/Cmd+Enter). Refused by host when the agent is busy." | **FICA** — consequência de recuso. |

### 2.3 agent-studio-shell (`webview/agent-studio-shell/`)

| Onde | Categoria | Texto | Veredito |
|---|---|---|---|
| `App.tsx:883` | hint | "This agent's instructions are published by another owner… read-only so a save cannot overwrite them." | **FICA** — por quê do estado read-only; consequência. |
| `App.tsx:885` | hint | "Delivered at the start of every session for this agent. Saved in the profile as instructions.md and re-read on restart; clear the box to remove them." (149) | **ENCOLHE** → `"Sent at the start of every session. Clear the box to remove."` — o ciclo de vida do arquivo é modelo → doc. |
| `App.tsx:923` | hint | "This agent runs in its own git worktree, which is its working directory. Turn the separate checkout off below to choose a directory." | **FICA** (limítrofe) — consequência + saída; poderia perder a segunda oração da primeira. |
| `App.tsx:934` | hint | "Sets the working directory; it does not confine writes." | **FICA** — exemplar: três palavras que evitam um mal-entendido de segurança. |
| `App.tsx:1155` | parágrafo | "Creates a new disabled agent. Secrets, grants and workspace bindings must be authorized again." | **FICA** — consequência direta do gesto. |
| `App.tsx:1211` | hint | "Only pre-authorized references can be enabled here." | **FICA**. |
| `App.tsx:1235` | hint | "Authorize also enables it; untick above to disable without withdrawing authorization." | **FICA** — consequência de duas portas. |
| `App.tsx:1256` | hint | "Authorize grants everything the plugin exposes for this runtime, enabled; a plugin with ungrantable parts is refused whole." | **FICA** — risco do gesto. |
| `App.tsx:1291` | hint | "Already active on this checkout via git hooks, not agent capabilities: {…}" | **FICA** — estado nomeando o mecanismo em uma linha. |
| `domain.ts:512` | hint | "Groups these agents under this one in the sidebar; changes no spawning." | **FICA** — exemplar: o que faz E o que não faz. |
| `domain.ts:515` | hint | "No other agent is available to declare. A candidate must be an agent that no one else owns and that declares no subagents of its own." (133) | **ENCOLHE** → `"No agent can be declared: a candidate must be unowned and declare no subagents."` — a regra completa é modelo; o vazio precisa só do essencial. |
| `domain.ts:519-523` | risco (multi) | "Grant this only to an agent you trust to spend your attention… A proposed agent can never receive this same capability…" | **FICA** — superfície de consentimento; o custo é o produto aqui. |
| `domain.ts:528` | hint | "Save this agent to create its canonical profile. Then choose pre-authorized MCP servers, skills, and hooks in Runtime tooling." (126) | **ENCOLHE** → `"Save to create the profile, then authorize tools in Runtime tooling."` — o tour pelas abas é navegação doc. |
| `domain.ts:536` | hint | "Projected into the agent's private runtime home." | **FICA**. |
| `domain.ts:545-558` | riscos | três textos "Authorize … — This agent will run … Only the agents you authorize here are affected…" | **FICA** — consentimento; consequência + escopo. |
| `domain.ts:567` | hint | "Enabling or starting this canonical agent authorizes native folder trust only for the current workspace… stay unchanged." (212) | **FICA** — autorização: escopo do que muda e do que não muda. |
| `ForgetPlanView.tsx` (tudo) | plano | passos "will run / already satisfied / blocked" + RiskLine | **FICA** — o componente inteiro é consentimento medido. |

### 2.4 approval (`webview/approval/`)

| Onde | Categoria | Texto | Veredito |
|---|---|---|---|
| `App.tsx:73,86` | EmptyState | "Loading approvals…" / "No pending approvals" | **FICA**. |
| `App.tsx:81` | hint | `vm.folder` (nome do workspace) | **FICA** — dado, não prosa. |

### 2.5 board (`webview/board/`)

| Onde | Categoria | Texto | Veredito |
|---|---|---|---|
| `App.tsx:577,586` | ds-dim | "no priority" / label sem assignee | **FICA** — rótulos de ausência, uma palavra. |

Sem prosa problemática. Tela enxuta.

### 2.6 handoff (`webview/handoff/`)

| Onde | Categoria | Texto | Veredito |
|---|---|---|---|
| `App.tsx:118` | ds-dim | "The agent drafts first; applying the rewrite still requires human approval." | **FICA** — consequência; exemplar. |
| `App.tsx:185` | EmptyState | "No project handoff yet. Open it to create the file from the 4-section template, then curate the state of the work." (114) | **ENCOLHE** → `"No handoff yet. Open to create it from the 4-section template."` — "curate the state of the work" é aula; o botão Open já está ao lado. |
| `App.tsx:197` | ds-dim | "no pending notes" | **FICA**. |

### 2.7 human-inbox (`webview/human-inbox/`)

| Onde | Categoria | Texto | Veredito |
|---|---|---|---|
| `App.tsx:207` | EmptyState | "Nothing is waiting on you" / "No decisions match these filters" | **FICA** — exemplar de convite curto. |
| `App.tsx:704` | EmptyState | "{kind} {id} is no longer waiting — it was resolved or closed elsewhere." | **FICA** — estado + porquê. |
| `App.tsx:147,722` | hint | folder / `{id} · folder` | **FICA** — dados. |

### 2.8 inspector (`webview/inspector/`)

| Onde | Categoria | Texto | Veredito |
|---|---|---|---|
| `App.tsx:117,269` | EmptyState | `""` / `s.empty` (catálogo do host) | **FICA** — dado/estado. |

### 2.9 keys (`webview/keys/`)

| Onde | Categoria | Texto | Veredito |
|---|---|---|---|
| `App.tsx:23` | hint | "Credentials for this machine. Never leave it." | **FICA** — escopo + segurança em 6 palavras. |
| `App.tsx:28` | parágrafo | "The current value is never displayed. Replacing a key requires a new value." | **FICA** — consequência. |
| `App.tsx:43` | ds-dim-like | "Required by {agent} — cannot launch without it" | **FICA**. |
| `App.tsx:46` | diálogo | "This cannot be undone. It will prevent {…} from launching until stored again." | **FICA** — consequência no ponto do gesto. |
| `App.tsx:47` | rodapé | "Storage: `secrets.json`, machine-local, owner-only. Not a keychain." | **ENCOLHE** → `"Stored in secrets.json on this machine."` — "Not a keychain" ensina o modelo de armazenamento; se importa, é doc. |

### 2.10 pin-preview / pin-studio / task-studio / task-prototype / plugin-host / design-mode-overlay

Sem prosa acima de rótulo (varredura completa de `ds-dim`/`hint`/`EmptyState`/literais). Nada a listar.

### 2.11 plugins (`webview/plugins/`) — o app mais denso, e quase tudo é consentimento

| Onde | Categoria | Texto | Veredito |
|---|---|---|---|
| `App.tsx:71` | tooltip | "installed into this runtime — materialization present on disk" / "…files are missing (drift)" | **FICA** — estado; "materialization" é jargão interno, tolerável num tooltip. |
| `App.tsx:103-111` | aviso (pgap) | "This workspace runs {X} and {P} supports them, but this install never covered them. Use Reinstall in this card's ⋮ menu — it re-materializes the recorded commit… It never removes first, so {Y} stay installed throughout." | **ENCOLHE** → `"Not installed for {X}. Use Reinstall (⋮ menu) — it adds them without removing the others."` — o feito é o aviso + o gesto; a mecânica de re-materializar commit é modelo. |
| `App.tsx:222` | ds-dim | "Restart a running session to disarm" | **FICA** — exemplar. |
| `App.tsx:246` | ds-dim | "Restart a running session to drop the tools" | **FICA**. |
| `App.tsx:258` | heading | "Views — these draw UI inside Tachyon" | **FICA** — enquadra o risco em 6 palavras. |
| `App.tsx:380` | heading | "Requires — declared by the plugin (install separately; may not work until present)" | **FICA** — o parêntese é consequência. |
| `App.tsx:419,428` | headings | "Permission summary — these run on agent events" / "Runtime settings hooks — these can intercept agent tool calls" | **FICA**. |
| `App.tsx:436` | ds-dim (stack) | "This package registers these hooks in the selected runtime settings. Tachyon-managed agent sessions receive them only when this workspace classifies {P} as enforcement under settings.agentHookProjection; an unclassified plugin projects nothing." (~300) | **ENCOLHE** → `"Reaches Tachyon-managed sessions only when the workspace classifies this plugin as enforcement."` — a projeção/classificação é modelo → doc de plugins. |
| `App.tsx:465` | ds-dim (stack) | "The plugin's committed payload and any empty directories this install created are also removed." | **FICA** — consequência de remoção. |
| `App.tsx:499` | heading | "MCP servers this plugin ships — they stay inert until you apply them" | **FICA**. |
| `App.tsx:533` | heading | "Git hooks — these run on EVERY commit, for everyone" | **FICA** — exemplar. |
| `App.tsx:540` | ds-dim (stack) | "Runs for you, the agent, and your IDE at commit time; it can read staged content and block the commit. `git commit --no-verify` bypasses it. Removing the plugin restores your prior hook setup." (210) | **FICA** — três fatos acionáveis de consentimento. |
| `App.tsx:556` | heading | "Tools — Tachyon will DOWNLOAD and EXECUTE these binaries" | **FICA**. |
| `App.tsx:574` | ds-dim (stack) | "The sha256 proves the bytes match the plugin's manifest — it does not vouch for the publisher. Verify you trust {…}. The binary is installed read-only + content-addressed under .tachyon/bin and re-validated before every run." | **FICA** — superfície de segurança; a distinção integridade×confiança é o ponto. |
| `App.tsx:626` | ds-dim (stack) | "An assisted install runs your system package manager in a visible terminal where your OS prompts for your password — Tachyon never sees it. The plugin installs regardless; a skill needing a missing tool fails closed at runtime." | **FICA** — confiança + consequência. |
| `App.tsx:663` | hint | "Browse, install & manage plugins · this workspace runs {wsRuntimes}" | **FICA** — escopo + estado. |
| `App.tsx:718` | EmptyState | "A curated registry is coming in v2. / For now, install any plugin by its git source above — github:owner/repo@ref." | **ENCOLHE** → `"Registry coming in v2. Install by git source above — github:owner/repo@ref."` |
| `App.tsx:722` | EmptyState | "No plugins installed. / Install one by its git source above — github:owner/repo@ref." | **FICA** — convite + como, no padrão Geist. |
| `App.tsx:731` | EmptyState | "No installed plugins match. / Clear the filter or try another search term." | **FICA** — exemplar de no-results. |

### 2.12 probes (`webview/probes/`)

| Onde | Categoria | Texto | Veredito |
|---|---|---|---|
| `App.tsx:46` | hint | "Run one with the `probe_agent` Bridge tool — an adversarial-review or factual-verify second-model pass (pass caller: …)." | **FICA** — empty-state apontando o gesto exato. |

### 2.13 review (`webview/review/`)

| Onde | Categoria | Texto | Veredito |
|---|---|---|---|
| `App.tsx:260` | hint | `{worktree} · {base ↔ current}` | **FICA** — dados. |
| `App.tsx:312-316` | EmptyState | "Select a file." / "Loading diff…" / "No diff for this file." | **FICA** — três palavras cada. |

### 2.14 rich-doc (`webview/rich-doc/`)

| Onde | Categoria | Texto | Veredito |
|---|---|---|---|
| `VisualsPanel.tsx:89` | ds-dim | "No screenshots or sketches attached." | **FICA**. |
| `toolbar.tsx` | tooltips | "Bulleted list" etc. | **FICA** — rótulos. |

### 2.15 runtime-config (`webview/runtime-config/`)

| Onde | Categoria | Texto | Veredito |
|---|---|---|---|
| `App.tsx:81/110` (+`RuntimeConfigPanel.ts:141`) | hint (catálogo) | "Global runtime configuration, capabilities, and agent impact." | **FICA**. |
| `App.tsx:179` | aviso | "Current sessions still use the previous source. The next Start, Restart or Resume will apply this change: {…}." | **FICA** — consequência exemplar. |
| `App.tsx:263` | parágrafo | "Values stay in the source file. This view lists only keys that are not yet editable in Control." | **ENCOLHE** → `"Not editable here yet — values stay in the source file."` — mesma informação, uma oração. |

### 2.16 runtime-ops (`webview/runtime-ops/`)

| Onde | Categoria | Texto | Veredito |
|---|---|---|---|
| `App.tsx:43/51/62` | hint | "Local runtime inventory and provider capacity." | **FICA**. |
| `App.tsx:88-89` | estado | "No supported runtimes found. / PATH detection and managed session ledgers returned no runtime inventory." | **ENCOLHE** → `"No supported runtimes found."` — como a busca foi feita é método de medição, não estado. |
| `App.tsx:116` | parágrafo | "Account-wide quota. These limits are not attributed to a runtime, workspace, or agent." | **FICA** — evita a leitura errada do número. |
| `App.tsx:354-356` | nota | "Strict MCP: … this list is exhaustive." / "Ambient MCP config is NOT excluded — the runtime may also load servers from outside Tachyon." | **FICA** — ressalva de segurança. |
| `App.tsx:440-442` | fallback | "Purpose not described here — the command below is the authority." / "Authored outside Tachyon; purpose not described." | **FICA** — honestidade sobre o que não sabe. |
| `App.tsx:457-460` | nota | "Plugins this workspace classified whose gate hook did not reach this agent. Read from the workspace's current plugin lockfile and classification — the same plan every spawn recomputes; the Hooks list above is what this session was actually given." | **ENCOLHE** → `"Plugin gates that did not reach this agent. The Hooks list above is what this session actually has."` — a proveniência (lockfile, plano por spawn) é modelo. |
| `App.tsx:502-507` | detalhes | "Carried from your global runtime config by this profile's family allowlist." / "Present in your global config but NOT carried by the allowlist — it never reaches this agent." | **FICA** — a segunda é a razão do painel existir. |
| `App.tsx:553-555` | proveniência | "Read-only Codex CLI app-server; credentials stay with Codex." etc. | **FICA** — uma linha de escopo. |

### 2.17 schedule-studio-shell / terminal-studio-shell (`webview/*-studio-shell/`)

| Onde | Categoria | Texto | Veredito |
|---|---|---|---|
| `schedule…/App.tsx:236,238` | hint | "No targets declared yet." / "Current target resolves as {kind}." | **FICA**. |
| `terminal…/App.tsx:241` | hint | "Comma-separated globs restart this terminal when matching files change." | **FICA** — formato + consequência. |

### 2.18 settings (`webview/settings/` + catálogo) — Control → Settings: a pior tela

O app consome o catálogo `controlStrings.ts`; "onde aparece" abaixo é o bloco na tela Settings.

| Onde (catálogo/uso) | Categoria | Texto | Veredito |
|---|---|---|---|
| `controlStrings.ts:108` → intro (`main.tsx:464`) | parágrafo | "Tachyon keeps two settings files on purpose: one for you on this machine, one for the project shared with the team. They own different knobs — they are not two places for the same list." (185) | **ENCOLHE** → `"Two settings files, on purpose: yours on this machine, the project's shared with the team. They own different knobs."` — a terceira oração ensina o modelo; os dois cards embaixo já mostram a divisão. |
| `controlStrings.ts:112` → card Global (`main.tsx:468`) | hint | "Your machine preferences — agent pane, git path, Activity theme. Not committed; recovery path when Control will not open." (121) | **ENCOLHE** → `"Your machine preferences — agent pane, git path, theme."` — "recovery path" é o plano de contingência, doc. |
| `controlStrings.ts:116` → card Workspace (`main.tsx:483`) | hint | "Shared project policy in tachyon.yml — agents, agent limit, memory cap, schedules, Companion, idle notify, worktree reveal. Versioned with the repo, so the whole team gets it." (175) | **ENCOLHE** → `"Shared project policy in tachyon.yml — versioned with the repo."` — a enumeração de knobs duplica a tela embaixo. |
| `controlStrings.ts:159` → bloco global (`main.tsx:94`) | hint | "Per-person, per-machine. Kept in a plain file you can also edit by hand — that file is the recovery path when Control itself will not open." (139) | **ENCOLHE** → `"Per-person, per-machine, in a plain file you can edit by hand."` — a frase de recovery já foi dita (e cortada) no card acima; um lar só. |
| `controlStrings.ts:128` → bloco Companion (`main.tsx:562`) | parágrafo | "When tab tools are on, agents see user_browser_* on the Bridge. Pairing Companion is still required to run them. Generate a pair code here (or via the command palette)." (168) | **ENCOLHE** → `"Agents see user_browser_* on the Bridge; pairing Companion is still required. Generate a pair code here."` — o parêntese da paleta de comandos é doc de caminhos alternativos. |
| `controlStrings.ts:185` → `main.tsx:514,559` | parágrafo | "Select a single workspace in Overview to manage Companion settings." | **ENCOLHE (+ponteiro podre)** → `"Select a single workspace in System to manage Companion settings."` — **"Overview" não existe mais** (SDD 500 fundiu no System); o texto manda o leitor para uma tela que não está lá. |
| `controlStrings.ts:44` → PageChrome (`main.tsx:461`) | hint | "Personal machine preferences and shared project policy — two files, two authorities." | **FICA** — escopo em uma linha. |
| `controlStrings.ts:131` → toggle help | hint | "Writes settings.companion.tabTools in tachyon.yml and refreshes the Bridge tool list." | **FICA** — onde-escreve é consequência; exemplar. |
| `controlStrings.ts:134` → campo hosts | hint | "One host or glob per line (example.com, *.herokuapp.com). Empty = all hosts. Writes settings.companion.allowedHosts in tachyon.yml." (131) | **FICA** — formato + default + destino: o que um hint de campo deve ser. |
| `controlStrings.ts:141/40-142` → bloco IDE Browser | hint+body | "VS Code editor browser and Design Mode. Opt in before the status-bar controls appear." / "When enabled, the globe and Design Mode icons show on the status bar. Agents always see ide_browser_* tools; calls fail until you enable this and open the bridge." (162) | **FICA** — ambas as frases são consequência do toggle. |
| `controlStrings.ts:149` → campo idle | hint | "How long a child agent may sit idle… 1-10080 minutes (7 days). Writes settings.agentNotifications.idleAfterMinutes in tachyon.yml and applies on the next check — no restart." (208) | **FICA** — unidade e limites dentro da string é decisão registrada (`t-585d5c`); tudo é consequência. |
| `controlStrings.ts:200` → QR card | hint | "Scan with your phone camera — opens Companion Mobile and pairs automatically. PC and phone must be on the same Tailscale tailnet (settings.companion.lanAccess: true)." (200) | **FICA** — pré-condição do gesto; a chave é o endereço do ajuste. |
| `controlStrings.ts:205` → QR card | hint | "Mobile uses Tailscale only (not raw Wi‑Fi IPs). Install Tailscale on PC + phone, same account/tailnet, then generate a code." (124) | **FICA** — passos imperativos curtos. |
| `controlStrings.ts:208-209` → bloco Devices | hint+empty | "Companion devices paired to this workspace engine (browser or mobile)." / "No Companion device paired. Generate a pair code above, enter it in Tachyon Companion, then refresh." | **FICA** — empty-state-convite exemplar. |
| `controlStrings.ts:176` → git path | hint | "Leave empty to use the git extension's git.path, then common install locations, then git on PATH." | **FICA** — cadeia de default é consequência. |

### 2.19 sidebar (`webview/sidebar/`)

| Onde | Categoria | Texto | Veredito |
|---|---|---|---|
| `App.tsx:1232-1236` | boot vazio | "No Tachyon workspace." + "Open a folder, then generate a tachyon.yml to manage its fleet here." + botão | **FICA** — exemplar: estado + um convite + ação. |
| `App.tsx:170` | banner | "Each ignored line runs the product default instead." | **FICA** — consequência em uma linha. |
| `App.tsx:386` | tooltip badge | "{runtime} reports this agent is not authenticated — {action}. Tachyon will not retry or restart it automatically." (155) | **FICA** — estado + o que NÃO vai acontecer; tooltip é o lugar do detalhe. |
| `App.tsx:620` | EmptyState | "(none)" | **FICA**. |

### 2.20 system (`webview/system/`)

| Onde | Categoria | Texto | Veredito |
|---|---|---|---|
| `controlStrings.ts:34` → `App.tsx:223` | hint | "Is Tachyon up and healthy, and if not, where?" | **FICA** — exemplar máximo: a pergunta do leitor em 9 palavras. |
| `controlStrings.ts:24` → `App.tsx:248` | empty | "No Tachyon workspace attached in this window." | **FICA**. |

### 2.21 task-detail (`webview/task-detail/`)

| Onde | Categoria | Texto | Veredito |
|---|---|---|---|
| `App.tsx:66` | EmptyState | "Task {id} never found on disk" | **FICA**. |
| `App.tsx:241,258` | ds-dim | "no body" / "no notes" | **FICA**. |

### 2.22 validations (`webview/validations/`)

| Onde | Categoria | Texto | Veredito |
|---|---|---|---|
| `App.tsx:150,199` | EmptyState | "Loading validations…" / "No {scope} validations" | **FICA**. |
| `App.tsx:158` | hint | `vm.folder` | **FICA** — dado. |

### 2.23 worktrees (`webview/worktrees/`) — catálogo local `defaultStrings` (L646-730)

| Onde | Categoria | Texto | Veredito |
|---|---|---|---|
| `App.tsx:648` | hint | "Tachyon-managed checkouts — reveal and copy paths." | **FICA**. |
| `App.tsx:656` | landIntro | "When every precondition below is proved, Tachyon fast-forwards the trunk onto this delivery, in the primary checkout, when you press Land. It never lands on its own." (165) | **ENCOLHE** → `"Land fast-forwards the trunk onto this delivery, in the primary checkout. It never lands on its own."` (110) — a condicional duplica a lista de checks logo abaixo. |
| `App.tsx:659` | landBlocked | "Not ready to land — {0} precondition(s) not proved. No command is offered: one that would fail wastes your time, and one that would succeed here would land something nobody verified." (182) | **ENCOLHE** → `"Not ready to land — {0} precondition(s) not proved. No command is offered."` — a justificativa da política (dois ramos contrafactuais) é doc; os checks vermelhos já dizem o resto. |
| `App.tsx:694` | confirm | "Each entry is re-checked at execution — one whose state changed is skipped with a reason, the rest proceed." | **FICA** — consequência no ponto de confirmação. |
| `App.tsx:697` | aviso | "Engine unavailable — registry not shown (unverified data is never displayed)." | **FICA** — o parêntese responde o "por quê" na hora. |
| `App.tsx:700` | groupDesc | "A launch was interrupted and Git still holds this checkout. Nothing can reuse or remove it until the lock is released — releasing it deletes nothing." (149) | **FICA** — três fatos, cada um consequência. |
| `App.tsx:708,710,712,716,722` | groupDescs | "A live agent holds this checkout right now." / "Clean, unoccupied… Safe to delete." / "The registry row survives, but the directory is gone…" / "Blocked from cleanup — read the reason…" / "Not registered yet… a reload drops it." | **FICA** — estados com consequência, uma-duas frases. |
| `App.tsx:685-687` | compare | "Review shows {0}..{1} — the commits this command would land, not the working tree." (+2 variantes) | **FICA** — escopo do que será lido; load-bearing. |
| `App.tsx:684` | aviso | "⚠ Uncommitted changes won't be in the PR — commit them first." | **FICA**. |

### 2.24 onboarding (`webview/onboarding/`, **branch t-505f13** — não está no main)

| Onde | Categoria | Texto | Veredito |
|---|---|---|---|
| `App.tsx:88` | hint | "Tachyon runs AI coding agents as a managed fleet — real terminals, a shared board, human approvals." | **FICA** — Onboarding é a tela cuja função é dizer o que o produto é. |
| `App.tsx:103` | banner | "You're set up — the fleet lives in the Tachyon sidebar. Create more agents any time in Agent Studio." | **FICA** — saída apontando o próximo lugar. |
| `App.tsx:109` | ds-dim | "What Tachyon needs on this machine. Checked {hora}. Fix the missing items, then Re-check." | **FICA**. |
| `App.tsx:118` | EmptyState | "Open a folder first — then initialize it here. / The starter tachyon.yml is a teaching artifact: commented, valid, yours to edit." | **FICA** — diz o que o gesto produz. |
| **`App.tsx:123`** | **ds-dim (rodapé)** | **"Agents are not declared in tachyon.yml — an agent is a profile under .tachyon/agents/, created by Agent Studio."** | **MUDA DE LUGAR** → doc de modelo: `docs/` (seção "Agents and profiles"; o `docs/project-guidance.md` e os runbooks já são o lar natural). Na tela, no máximo um link "Where do agents live?" — o rodapé ensina o modelo de dados no meio do fluxo, quem lê não lembra, quem precisa não procura ali. É o exemplo do dono. |
| `App.tsx:130` | ds-dim | "Initializes with the workspace — an agent needs a Tachyon workspace to live in." | **FICA** — pré-condição. |
| `App.tsx:132` | ds-dim | "{n} agent(s) in the roster. Start sessions from the Tachyon sidebar (▶)." | **FICA** — estado + gesto. |
| `App.tsx:134` | ds-dim | "An agent is a named runtime session (claude, codex, grok…) with its own profile, worktree and permissions." | **ENCOLHE** → `"A named session of claude, codex or grok, with its own profile and worktree."` — mesmo em Onboarding, a definição não precisa da enumeração de atributos. |

---

## 3. O catálogo declara, a tela não renderiza — 34 chaves mortas em `controlStrings.ts`

Verificado por referência (`grep` por `.{chave}` fora de `controlStrings.ts`/`messages.ts`; uso por destructuring escaparia à checagem — re-executar na execução):

`navFleet, navInbox, navApprovals, navMission, navValidations, navHandoff, navWorktrees, navRuntime, navRuntimeConfig, navTmux, navPlugins, navSettings, navLoading, navStalled, navRetry, openBoard, copied, fleetTitle, fleetHint, approvalsTitle, approvalsHint, missionTitle, missionHint, validationsTitle, validationsHint, openTerminal, openActivity, editAgent, continueTaskNoDest, copyId, workspaceSettingsTitle, workspaceSettingsHint, companionPairCandidatesLabel, companionCopyPayload`

São restos do Control pré-SDD 500 (a navegação virou grid na sidebar; o segundo card de workspace foi removido em `t-aaad95`). Duas dessas (`workspaceSettingsTitle/Hint`) carregam justamente a enumeração-de-knobs que §2.18 manda encolher — mortas, nem precisam encolher: **SOME do catálogo**. É o mesmo formato de defeito que o guia de projeto já registra ("um inventário do que uma superfície DECLARA não vê o que ela RENDERIZA"), agora no catálogo de strings.

---

## 4. Cartões de execução propostos (NÃO criados; proposta apenas)

Do pior para o menos pior, por densidade de manual por área de tela. Todo cartão de execução carrega: aplicar o princípio (§1), evidência visual a 880/360 quando a tela muda de forma, e sincronizar `l10n/bundle.l10n.pt-br.json` quando string catalogada muda.

| # | Cartão | App/superfície | Itens | Conteúdo |
|---|---|---|---|---|
| 1 | settings-encolhe | Control → Settings | **7** | 6 ENCOLHE de §2.18 + ponteiro podre "Overview"→"System". Maior concentração de prosa-doc por tela. |
| 2 | catalogo-morto | controlStrings.ts | **34** | Remover as chaves sem renderizador (§3); re-executar a checagem por referência antes de cortar. |
| 3 | plugins-encolhe | Plugins | **3** | CoverageNotice, settingsHooks (§2.11 `App.tsx:436`), marketplace empty. |
| 4 | agent-studio-encolhe | Agent Studio | **3** | instructions hint, ownershipNoCandidates, newAgentSetupHelp (§2.3). |
| 5 | onboarding-muda | Onboarding (**após t-505f13 pousar**) | **2** | O rodapé do exemplo (MUDA DE LUGAR → docs) + definição de agent (ENCOLHE). |
| 6 | worktrees-land-encolhe | Worktrees | **2** | landIntro + landBlocked (§2.23). |
| 7 | runtime-ops-encolhe | Runtime Ops | **2** | no-runtimes + withheld gates (§2.16). |
| 8 | runtime-config-encolhe | Runtime Config | **1** | nota unknownKeys (§2.15). |
| 9 | handoff-empty-encolhe | Handoff | **1** | empty state (§2.6). |
| 10 | keys-footer-encolhe | Keys | **1** | rodapé (§2.9). |
| 11 | agent-pane-tooltip-encolhe | Agent pane | **1** | tooltip de pin (§2.2). |
| 12 | activity-aria-encolhe | Activity (markdown) | **1** | aria do diagrama (§2.1). |
| 13 | principio-em-docs | docs/project-guidance.md | **0** (texto) | Adotar a seção §1 como está (ou discutida); é o que impede o próximo autor de reintroduzir. |

Soma dos itens executáveis: **58** (24 ENCOLHE + 34 SOME-do-catálogo; o MUDA DE LUGAR resolve-se em doc, não em string). Nenhuma string de produção recebeu SOME — o grosso da frota já escreve consequência, não manual; a doença está concentrada (Settings, catálogo, e o app que motivou o cartão).

---

## 5. Referências (com link e o que sustentam)

- **Progressive disclosure (ajuda progressiva):** Nielsen Norman Group, *Progressive Disclosure* — https://www.nngroup.com/articles/progressive-disclosure/ — "defers advanced or rarely used features to a secondary screen, making applications easier to learn and less error-prone"; máx. dois níveis; o óbvio tem que ter scent. Sustenta: tooltip/link/doc carregam a profundidade, a tela carrega o essencial.
- **Tooltips:** NN/g, *Tooltip Guidelines* — https://www.nngroup.com/articles/tooltip-guidelines/ — tooltips servem para "additional explanation for a form field unfamiliar to some users"; NÃO para "information that is essential to completing a task". Sustenta: o detalhe que cortamos da tela não vai obrigatoriamente para tooltip — vai para doc.
- **Empty states:** NN/g, *Designing Empty States in Complex Applications* — https://www.nngroup.com/articles/empty-state-interface-design/ — empty state deve dizer o estado em frases curtas ("brief system message") e oferecer o caminho direto ("provide direct pathways"); primeiro uso ensina no contexto ("pull revelation"), melhor que tutorial forçado. Sustenta: convite + ação, não parágrafo.
- **UX writing / densidade:** GOV.UK Service Manual, *Writing for user interfaces* — https://www.gov.uk/service-manual/design/writing-for-user-interfaces — "One idea per sentence"; "If you find yourself having to explain how the user interface works, that's a sign something has gone wrong. Fix the interface so it does not need explaining."; help text só quando a pesquisa mostra necessidade. Sustenta: o princípio inteiro, quase literal.
- **Voz dev-tool:** GitHub Primer, *Content* — https://primer.style/product/getting-started/foundations/content/ — "Be brief, remove unnecessary words like adjectives and adverbs"; "Write in plain English"; não dizer que algo é "easy/quick" nem que o usuário "just" precisa fazer. Sustenta: enumerações e contrafactuais fora.
- **VS Code (o padrão de settings deste produto):** *Settings — UX Guidelines for Extensions* — https://code.visualstudio.com/api/ux-guidelines/settings — "Add clear descriptions to each setting; Link to documentation for complicated settings; Don't create long descriptions." E o wiki *Setting Descriptions* — https://github.com/microsoft/vscode/wiki/Setting-Descriptions — descrições curtas, `markdownDescription` com link quando complica. Sustenta: a Settings screen do Tachyon devendo ter descrição curta + link "more info", não parágrafos.
- **Vercel:** Geist, *Empty State* — https://vercel.com/geist/empty-state — título comunica o estado; descrição "adds new information (don't restate title)"; um CTA primário + um link "Learn more" quando há dois caminhos. Sustenta: o formato empty-state proposto em plugins/handoff.
- **Linear:** https://linear.app/brand — a Linear não publica guia de escrita; a prática observável (prosa mínima, tooltips curtos, docs em linear.app/docs) é consistente com GOV.UK/Primer, mas **não** a citei como regra (ver §6).
- **Progressive disclosure (secundária):** IxDF — https://ixdf.org/literature/topics/progressive-disclosure — definição e carga cognitiva.

---

## 6. O que NÃO consegui determinar

1. **O app de Onboarding não está no `main`.** Inventariei-o na branch `t-505f13` (`4fcfacc7`); se a branch mudar antes de pousar, as linhas de §2.24 derivam. Ninguém auditou o app **visualmente** no devhost — li fonte, não pixels.
2. **Nenhuma medição visual foi feita** (880/360, headless browser). Este cartão não muda UI; quando os cartões de execução mudarem, a evidência visual é deles.
3. **A contagem "58" do cartão não reproduz por método** (§0). Meu número de itens é o da leitura integral; quem executar os cartões deve re-contar pelo mesmo método, não pelo heurístico.
4. **As 34 chaves mortas foram verificadas por referência** (`.{chave}`); uso via destructuring ou acesso dinâmico (`s[key]`) escaparia. O cartão 2 manda re-executar antes de cortar — é o fail-before do inventário.
5. **Strings do lado do engine que alimentam telas** (consent do plugins, `OnboardingPanel`/`environmentCheck`, `WorktreesPanel` além do hint) foram lidas por amostragem nas áreas de maior densidade, não exaustivamente item a item.
6. **`bundle.l10n.pt-br.json`** não foi auditado — a proposed-short de cada ENCOLHE catalogada precisa de par de tradução na execução.
7. **A Linear não tem guia público** (só a página de brand); não transformei a prática dela em regra. O guia de copywriting do Geist foi **removido** do site (a URL redireciona para a introdução); só o componente Empty State restou como fonte citável.

---

*Fim do documento. Nenhum arquivo de aplicação foi modificado; `git status` mostra apenas este arquivo.*
