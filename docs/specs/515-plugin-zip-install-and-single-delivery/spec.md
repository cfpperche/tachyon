# 515 — plugin-zip-install-and-single-delivery

_Created 2026-08-23._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred. -->

## Intent

Instalar um plugin em Tachyon custa uma máquina inteira: resolver um endereço de git, clonar com tag
fixada, verificar checksum de payload, calcular um fingerprint de consentimento, mostrar uma gaveta de
consentimento, escrever um lockfile, manter estado aplicado, resolver dependências entre plugins, e
aplicar tudo numa transação reversível. Medido em 2026-08-23: **≈13.600 linhas de produção** e **9.631
de teste** em 50 arquivos, mais quatro binários que o build emite só para isso.

A spec 514 mostrou que existe uma forma mais barata para o caso comum, e ela já está em produção para
apps: **um zip vira um diretório, e o disco é o catálogo**. Esta spec traz essa porta para plugins — e
resolve a duplicidade de entrega que custou três releases de correções em 22–23/08.

### O que a auditoria mediu, e o que ela desautoriza

Uma primeira leitura sugeriu apagar as capacidades que "ninguém usa". **Medido contra o catálogo real
(`github:cfpperche/tachyon-plugins`, 17 plugins), isso é falso:** `tools` é usado por agent-browser,
dep-audit e secrets-guard; `gitHooks` por secrets-guard e verify-gate; `data` pelo transcribe (o
modelo); `externalTools` por transcribe, audio, image, sound, video, hyperframes e diagram;
`dependencies` por product-foundation; `blocks` por secrets-guard. Só os dois plugins instalados neste
workspace não usam nada disso.

**Nenhuma capacidade é removida por esta spec.** O que muda é a porta de entrada e o caminho de
entrega.

### A duplicidade que esta spec fecha

Hoje um plugin instalado é materializado **duas vezes**:

1. a instalação escreve diretórios de skill no workspace (`.claude/skills/`, `.agents/skills/`,
   `.grok/skills/`), registrados no lockfile;
2. a **concessão por agente** projeta o mesmo skill no home privado do agente, atestado por digest.

Medido neste workspace: `claude` e `grok` recebem `sdd` e `agent-browser` por **referência de
concessão** (`owner: plugin:<nome>`, `path: .tachyon/plugins/<nome>/skills/<skill>`, `sha256`
fixado), e o `codex` idem desde a t-ef3c1f. **Nenhum agente lançado pelo Tachyon lê os diretórios do
workspace.** Quem os lê é um `claude`/`codex` que o humano rode à mão naquela pasta, fora do harness.

Essa segunda cópia é a origem direta de: o dest que o lockfile afirmava e o disco não tinha
(t-318d7d), o symlink que a varredura ignorava, e a árvore substituída que apagava o roster do
instalador (t-94d49a/t-f842f0).

## Acceptance criteria

### Fatia 1 — instalar por zip

- [ ] **Scenario: instalar um plugin de um arquivo local**
  - **Given** um `.zip` contendo `tachyon-plugin.json` e o payload do plugin
  - **When** o humano escolhe o arquivo pela aba Plugins
  - **Then** o conteúdo é descompactado em `.tachyon/plugins/<nome>/`, o plugin aparece instalado, e
    nenhum endereço de rede, tag ou checksum de procedência é exigido

- [ ] **Scenario: reinstalar por cima é a atualização**
  - **Given** um plugin já instalado por zip
  - **When** o humano instala um zip cujo manifesto declara o mesmo nome
  - **Then** o diretório é substituído, e uma falha em qualquer ponto não deixa diretório parcial

- [ ] **Scenario: zip inválido avisa e não instala nada**
  - **Given** um zip sem `tachyon-plugin.json`, com manifesto ilegível, ou cujo manifesto é recusado
  - **When** o humano tenta instalar
  - **Then** a tela nomeia o que faltou, nada é materializado, e os plugins já instalados continuam
    funcionando

- [ ] **Scenario: o que executa código continua pedindo confirmação**
  - **Given** um zip cujo manifesto declara `tools` (binário provisionado) ou `gitHooks`
  - **When** o humano instala
  - **Then** a confirmação nomeia o que será executado e a instalação só prossegue com o aceite —
    a origem local dispensa provar procedência, nunca dispensa consentir execução

- [ ] Instalar por git continua existindo, inalterado, para plugins publicados.

### Fatia 2 — uma entrega, não duas

- [ ] **Scenario: instalar não escreve mais nos diretórios do workspace**
  - **Given** um plugin que expõe skills
  - **When** ele é instalado
  - **Then** o payload existe em `.tachyon/plugins/<nome>/` e nenhum diretório de skill é criado em
    `.claude/`, `.agents/` ou `.grok/`

- [ ] **Scenario: o agente continua recebendo o que lhe foi concedido**
  - **Given** um agente com uma concessão de skill de plugin
  - **When** ele é lançado
  - **Then** o skill chega pelo caminho de concessão, atestado por digest, exatamente como hoje

- [ ] **Scenario: desinstalar continua exato onde não dá para derivar**
  - **Given** um plugin que mesclou entradas de MCP, hooks de runtime ou git hooks
  - **When** ele é desinstalado
  - **Then** exatamente essas entradas são removidas dos arquivos compartilhados — o lockfile deixa
    de contabilizar skills e continua sendo a memória do que não se deriva do disco

- [ ] A projeção de skills para worktree e para home privado de agente permanece intacta.

### Fatia 3 — a porta explícita de exportação

- [ ] **Scenario: exportar as skills de um plugin para o workspace**
  - **Given** um plugin instalado que expõe skills
  - **When** o humano pede a exportação
  - **Then** os diretórios de skill aparecem em `.claude/skills/`, `.agents/skills/` e `.grok/skills/`
    para os runtimes presentes, e um `claude` ou `codex` rodado à mão naquela pasta os encontra

- [ ] **Scenario: exportar é reversível e não vira instalação**
  - **Given** skills exportadas
  - **When** o humano desfaz a exportação, ou desinstala o plugin
  - **Then** exatamente os diretórios exportados saem, e a exportação nunca é pré-requisito para um
    agente do Tachyon receber o skill — esse caminho continua sendo a concessão

## Non-goals

- **Remover qualquer capacidade de plugin.** `tools`, `data`, `externalTools`, `gitHooks`, `blocks`,
  `config` e `dependencies` continuam existindo e funcionando — o catálogo real depende de todas.
- **Migração.** Não há caminho de compatibilidade a construir: instalar por zip é uma porta NOVA ao
  lado da de git, e a fatia 2 muda onde um plugin materializa, não o que ele é.
- **Reescrever o sistema.** A auditoria mostrou que o peso está na aquisição, não na entrega; a
  entrega funciona e não é tocada além do colapso da segunda cópia.
- **Remover checksum/consentimento do caminho de git.** Baixar e executar binário de terceiro continua
  merecendo os dois.

## Decisões do dono

- **2026-08-23 — a exportação para o workspace vira porta explícita.** O que a fatia 2 remove é a
  escrita AUTOMÁTICA no workspace, não a capacidade. Quem roda `claude` ou `codex` à mão na pasta
  continua podendo ter as skills lá, pedindo. A diferença é quem decide: hoje toda instalação
  espalha, e passa a espalhar só quando alguém pede.
