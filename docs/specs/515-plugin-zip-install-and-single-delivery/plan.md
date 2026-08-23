# 515 — plugin-zip-install-and-single-delivery — plan

_Drafted from `spec.md` on 2026-08-23. A abordagem, não os passos (esses vão em `tasks.md`)._

## Approach

Três movimentos, e o primeiro custa quase nada porque a costura já existe.

**1. Uma segunda porta de entrada.** `loadPluginFromSource(spec, git)` faz três coisas em sequência:
resolve o endereço, busca o payload, e chama `loadPlugin(dir)`. Só as duas primeiras são de git. Um
`loadPluginFromZip(zipPath)` descompacta em temporário e chama o mesmo `loadPlugin(dir)` — daí para a
frente (`previewInstall` → consentimento → `applyInstall`) **nada muda**, porque tudo isso opera sobre
um `LoadedPlugin`, não sobre uma fonte.

**2. A instalação para de escrever no workspace; quem entrega passa a escrever.** Hoje
`planSkillTargets(plugin, present, WORKSPACE_DESTS)` planeja diretórios de skill em `.claude/skills`,
`.agents/skills` e `.grok/skills`, e o lockfile os registra para poder removê-los. Isso sai. O que
fica é o payload em `.tachyon/plugins/<nome>/`, e a concessão por agente entrega dali.

**3. Exportar vira ação, não efeito colateral.** A capacidade de ter as skills nos diretórios do
projeto continua — passa a ser uma ação que o humano pede no card do plugin, e que se desfaz.

## Key decisions

- **A fonte por zip não precisa de schema novo, e isso foi medido.** `LoadResult.provenance` já é
  opcional ("present only when loaded via a source-spec"), e no lockfile `source` e `integrity` já são
  opcionais (`lockfile.ts:544-545`). Um plugin instalado por zip é gravado sem procedência e todo o
  resto do sistema já tolera. Rejeitado inventar um `source: { type: "zip" }`: seria registrar a
  origem de um arquivo que o humano escolheu no próprio disco — informação que não prova nada e que
  ninguém pode reverificar depois.

- **Consentimento continua, e só onde executa.** A gaveta atual pede aceite por runtime, skill em
  colisão, MCP, git hook, tool e data. Para um zip local, o que perde sentido é a *procedência*
  (checksum de payload baixado, tag imutável) — não o *consentimento de execução*. Um zip que
  provisiona binário ou instala git hook continua pedindo aceite pelo mesmo caminho, porque a
  consequência é a mesma: código de terceiro roda na sua máquina. Rejeitado pular a gaveta inteira
  para zip: seria trocar "não preciso provar de onde veio" por "não preciso saber o que faz".

- **A entrega do codex é a razão pela qual "instalar não escreve" NÃO significa "ninguém escreve".**
  Medido na t-ef3c1f: o codex não descobre skills a partir do seu `CODEX_HOME`, só de
  `<cwd>/.agents/skills` e de `~/.agents/skills`. Ou seja, para um agente codex a concessão
  *precisa* de um diretório no workspace. Isso já está resolvido no código: `restoreWorkspaceSkillDest`
  (t-318d7d) materializa exatamente a entrada concedida, a partir do payload, quando ela falta. A
  mudança desta spec é de **dono**: hoje o instalador escreve para todo mundo, e passa a ser a
  entrega que escreve só o que aquele agente recebeu. Rejeitado redirecionar `HOME` no launch do
  codex (o Grok faz isso): mudaria git, ssh e npm do processo por causa de um diretório de skills.

- **O lockfile encolhe de função, não de existência.** Ele deixa de contabilizar `skill-dir` e
  continua sendo a memória do que não se deriva do disco: entradas mescladas em `.mcp.json`,
  `config.toml`, `settings.json` e os git hooks. Rejeitado derivar tudo: uma entrada mesclada num
  arquivo compartilhado não é derivável — só o registro sabe qual linha era nossa.

- **A exportação escreve o mesmo que a instalação escrevia, e o lockfile a registra.** Reusa
  `planSkillTargets` com `WORKSPACE_DESTS` — a função não muda, muda quem a chama. Rejeitado deixar
  a exportação sem registro: sem ele, desfazer viraria adivinhação sobre diretórios que o humano pode
  ter mexido.

## Files touched

**Novo**

| caminho | o quê |
|---|---|
| `apps/vscode-extension/src/plugins/zipSource.ts` | descompactar um zip em temporário e devolver `LoadResult` sem procedência |
| `docs/specs/515-…/` | esta spec |

**Alterado**

| caminho | o quê |
|---|---|
| `apps/vscode-extension/src/plugins/engine.ts:400` | `loadPluginFromZip` ao lado de `loadPluginFromSource`; `planSkillTargets` deixa de ser chamada pelo caminho de install |
| `apps/vscode-extension/src/webview/PluginsPanel.ts:451` | `previewInstallOp` aceita um zip além de um spec; ação de exportar/desexportar |
| `packages/webview-ui/src/webview/plugins/App.tsx` | o botão de instalar por arquivo e a ação de exportação no card |
| `packages/webview-ui/src/webview/plugins/messages.ts` | as duas mensagens novas |
| `packages/engine/src/apps/index.ts` | extrair o descompactador com contenção para uso comum (hoje `extractAppZip`, privado) |
| `packages/engine/src/plugins/lockfile.ts` | `skill-dir` deixa de ser escrito pelo install e passa a ser escrito pela exportação (o schema não muda) |

## Risks & unknowns

**R1 — a entrega do codex depende do diretório do workspace, e a mitigação existente NÃO basta.**
Descoberto ao implementar a fatia 1: `restoreWorkspaceSkillDest` (t-318d7d) materializa o dest do
codex consultando o **lockfile**, e a fatia 2 faz a instalação parar de declarar `skill-dir` ali. As
duas coisas juntas deixam a restauração sem o que apontar, e o codex volta a ser recusado no launch.
A saída é a mesma tese da spec — derivar em vez de consultar: a concessão já carrega
`path: .tachyon/plugins/<nome>/skills/<skill>`, que é tudo o que a materialização precisa. O T9 passa
a provar exatamente isso ANTES de qualquer remoção. Se falhar, a fatia 2 para — nunca contorna
voltando a escrever no install.

**R2 — plugin instalado por zip e a checagem de atualização.** `resolveEffectiveUpdateSpec` só faz
sentido para um pin de git. Um plugin sem `source` não deve ser consultado nem mostrado como
"atualização disponível"; precisa aparecer como o que é: instalado de arquivo local.

**R3 — o que já está instalado.** Os dois plugins deste workspace têm dests de workspace registrados
no lockfile. Depois da fatia 2, uma reinstalação deixa de criá-los; o desinstalar continua removendo
os que existem, porque o lockfile ainda os registra. Nenhuma migração é necessária — a spec proíbe —,
mas o comportamento assimétrico durante a transição precisa estar dito na `notes.md`.

**R4 — a aba Plugins é grande** (1.039 linhas no host, mais o webview). As três mudanças de UI são
pequenas, mas o arquivo é denso; cada uma entra sozinha e verde.

## Sources consulted

- `apps/vscode-extension/src/plugins/engine.ts` (`loadPluginFromSource:400`, `planSkillTargets:626`,
  `previewInstall:945`, `applyInstall:1391`)
- `apps/vscode-extension/src/webview/PluginsPanel.ts:451` (o fluxo de preview/consentimento)
- `packages/engine/src/plugins/lockfile.ts:544` (source e integrity já opcionais)
- `packages/engine/src/plugins/agentDest.ts:67` (o que cada runtime realmente lê)
- `.tachyon/agents/{claude,grok,codex}/agent.yml` (a concessão como caminho real de entrega)
- specs 514 (apps por zip), t-ef3c1f e t-318d7d (a descoberta de skills do codex)
