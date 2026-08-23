# 515 — notes

## Fatia 1 — o que a implementação encontrou (2026-08-23)

**Três vezes o sistema já tinha o que eu ia construir.** Vale registrar porque muda o custo estimado
da spec inteira, e porque é o mesmo erro repetido: propor antes de medir.

1. `LoadResult.provenance` já é **opcional**, e no lockfile `source`/`integrity` também
   (`lockfile.ts:544-545`). A porta por zip não precisou de nenhuma mudança de schema.
2. `checkUpdates` já pula plugin sem `source` — com o comentário "a dir install has no source to
   re-resolve". A checagem de atualização nunca ia consultar um plugin instalado por arquivo.
3. O view-model do card já tem `localInstall` e já desenha o caso sem `sourceSpec`; as ações
   "Reinstall" e "Check for updates" já eram condicionadas a ele. Só troquei o texto de "local dir
   install" para "installed from a local file", porque agora são duas formas de chegar local.

**O que exigiu decisão de verdade:** onde o manifesto pode estar dentro do arquivo. Um zip de release
tem tudo sob uma pasta (`demo-1.0.0/…`), e obrigar o humano a achatar isso seria transferir a ele um
detalhe do empacotador. Aceitar raiz **ou** uma única pasta com manifesto cobre as duas formas; duas
pastas com manifesto é recusado pelo nome em vez de adivinhado.

**Dogfood real:** empacotei o `sdd` instalado neste workspace no formato de release (sob pasta) e
carreguei pela porta nova — `sdd 1.9.0`, skill `sdd`, sem procedência. Script em
`scripts/dogfood/plugin-zip-install.ts`.

## Um conflito que a fatia 2 vai ter que resolver (achado durante a fatia 1)

`restoreWorkspaceSkillDest` (t-318d7d) — a função que faz a concessão funcionar para um agente codex,
já que o codex não descobre skills do próprio `CODEX_HOME` — **consulta o lockfile** para saber qual
dest de workspace materializar. O plano da fatia 2 diz que a instalação deixa de declarar `skill-dir`
no lockfile. Se as duas coisas valerem juntas, a restauração fica sem o que apontar e o codex volta a
ser recusado no launch.

A saída está no espírito da própria spec: **derivar em vez de consultar**. A concessão já carrega
`path: .tachyon/plugins/<nome>/skills/<skill>`, que é tudo o que a materialização precisa — o
lockfile nunca foi necessário ali, só era o que estava à mão. A fatia 2 muda `restoreWorkspaceSkillDest`
para derivar do payload, e o T9 (provar antes de remover) passa a testar exatamente isso.

`plan.md` foi atualizado com essa decisão.

## O picker era do VS Code, e não podia ser (2026-08-23, depois do 0.93.55)

A fatia 1 subiu com `vscode.window.showOpenDialog` nesta porta. O dono pegou na primeira tentativa,
com print: numa janela remota/WSL aquele diálogo degrada para um campo de texto "Folder path" solto
por cima do editor. Não é só feio — não sabe o que é um pacote de plugin, abre onde esteve por último
em vez de onde os arquivos estão, e é uma janela com tema e teclado próprios.

A regra é do dono e é regra: **escolher artefato do Tachyon acontece no picker do Tachyon.** E ela já
tinha falhado uma vez com a instrução dada — o instalador de apps foi reconstruído em cima do
`PathPicker` duas specs atrás, e mesmo assim esta porta pegou o diálogo. Instrução que não segurou é
problema de mecanismo, não de diligência, então virou teste: `test/unit/productPicker.test.ts` recusa
`showOpenDialog` nas duas portas que instalam arquivo, e exige que o painel de plugins alimente um
picker de verdade (senão apagar o diálogo passaria no teste apagando a funcionalidade).

**Terceira vez que a coisa já existia.** `findAppZipCandidates`/`browseForAppZip` nunca tiveram nada de
app no corpo: acham `.zip` e listam um diretório. Foram para `packages/engine/src/files/zipPicker.ts`
com nomes neutros. Mesmo movimento do `extractZipContained` na fatia 1.

**O que NÃO foi tocado:** os outros cinco `showOpenDialog` do repositório escolhem coisas fora do
vocabulário do Tachyon — uma pasta de workspace, um HTML arbitrário para importar. Ali um diálogo de
propósito geral é a ferramenta honesta e o `PathPicker` (que lista diretórios e `.zip`) seria a errada.
Se a regra valer para esses também, é decisão dele e vira tarefa própria.

## Dois defeitos que o screenshot achou, e o DOM não acharia

Fiz a prova visual com o harness de preview + puppeteer (`test/browser/pluginZipPickerShots.test.ts`),
e ela pagou na hora — os dois são do 514 e estavam em produção desde então:

1. **A trilha imprimia `/ / home / goat / Downloads`.** A migalha raiz É uma barra, e o render punha um
   separador antes de toda migalha a partir da segunda.
2. **Os caminhos apareciam como `home/goat/Downloads/`.** `.pp-where` é `direction: rtl` para que a
   reticência coma a CABEÇA do caminho e a cauda — a parte que distingue duas pastas — sobreviva. O
   preço é bidi: `/` é caractere neutro, e numa caixa RTL a barra inicial migra para o fim. Resolvido
   com isolamento LTR (U+2066/U+2069), que conserta a direção do trecho sem mexer na direção da caixa.

O segundo **nenhuma asserção de DOM pegaria**: `textContent` é `/home/goat/Downloads` nos dois casos, a
diferença só existe depois do algoritmo bidi, ou seja, só na tela. É o argumento para a prova visual
ser um screenshot olhado e não uma consulta ao DOM.

Aproveitei para corrigir um comentário que afirmava o falso: dizia que nomes truncam no fim "mantendo
a extensão visível", o que é contraditório. As duas truncagens apontam para lados opostos de
propósito — nome pela cabeça (diz qual plugin é), caminho pela cauda (diz qual pasta é).

## Visual QA

Evidence: `.tachyon/visual-qa/515-plugin-zip-picker/` — quatro shots, as duas telas do picker
(sugestões e navegação) em 880 e 360, renderizadas do bundle real.
Verdict: aprovado depois dos dois consertos acima. O picker monta dentro do painel, cabe nas duas
larguras, não estoura, e a trilha e os caminhos agora leem como caminhos.

## Duas correções que vieram do uso, não do plano (0.93.57)

**1. O picker sugeria um app onde se instala plugin.** Ele bateu nisso com arquivo real:
`hello-fleet.zip`, um app que ele mesmo tinha empacotado, no topo das sugestões do instalador de
plugins. A varredura casava em `.zip` e mais nada. Um picker que sugere a coisa errada é pior que um
que não sugere nada — sugestão lê como recomendação.

Distinguir precisa dos nomes de dentro do arquivo, e um zip já guarda isso em texto puro no diretório
central, no fim do arquivo. Então `files/zipEntries.ts` lê a cauda e a região do diretório, e **nada
mais**: sem descompactar, sem temporário, sem custo proporcional ao payload — um arquivo de 400MB
responde tão rápido quanto um de 4KB, que é o que torna viável perguntar isso de cada candidato.

A regra do filtro segue o princípio da sessão inteira: só cai fora o que foi **medido** como outra
coisa. Um arquivo que não deu para ler continua sendo oferecido, porque recusa de leitura não é
evidência sobre o conteúdo — esconder um plugin de verdade porque o arquivo era estranho seria um
"não" sem medição vestido de medido. E navegar continua listando tudo: quem sabe onde está o arquivo
não deve ter a pasta filtrada por baixo.

Zip64 é recusado em vez de interpretado. Chegar lá significa arquivo acima de 4GB ou passando de 65535
entradas; pacote de plugin não é nem um nem outro, e um segundo formato de cabeçalho carregado para um
caso que não acontece é código que ninguém consegue conferir contra a realidade.

**2. Faltava a porta para o diálogo do sistema — e isso me obrigou a corrigir a regra que eu tinha
fixado.** A observação dele: IA digita rápido, humano prefere clicar; e tem humano que prefere digitar.
Precisa das duas. Todo picker que vale como referência põe um "Browse…" ao lado da caixa em vez de
obrigar a pessoa a escolher um estilo.

Minha primeira versão do `productPicker.test.ts` dizia, seco, que esses painéis nunca podem mencionar
`showOpenDialog`. Regra grossa demais: proibir o diálogo nativo proíbe também a saída de emergência.
**A regra nunca foi "nunca abrir diálogo nativo"** — é *o diálogo nativo nunca é a porta onde você
chega, só uma porta que você pode escolher*. O teste passou a fixar a ordenação, que é o que estava
em questão desde o começo:

1. nenhum painel abre diálogo por conta própria — todo repasse passa por `shared/systemFileDialog.ts`;
2. as portas de instalar-por-arquivo abrem o NOSSO picker, e têm de alimentá-lo com candidatos de
   verdade (senão apagar o diálogo passaria no teste apagando a funcionalidade);
3. o nosso picker oferece o diálogo do sistema como segunda mão.

`extension.ts` saiu da lista cega: ele também tem o diálogo do `restoreStateBackup`, que pede uma
**pasta** de destino — ali o `PathPicker` (que lista diretórios e `.zip` para escolher um arquivo) é a
ferramenta errada. A asserção passou a ser sobre o comando de instalar app, não sobre o arquivo em que
ele mora.

`onSystemBrowse` é opcional no componente de propósito: superfície sem diálogo para oferecer não desenha
botão morto.
