# Changelog

All notable changes to Tachyon are documented here. This project adheres to
[Semantic Versioning](https://semver.org/). Older history lives in the git log and the
Marketplace release notes.

## 0.93.64 — o Agent Studio para de oferecer o que o Grok não aceita

Ao configurar um agente Grok, o formulário oferecia conceder hooks e servidores MCP de um plugin.
Conceder não fazia nada: a porta de perfil do Grok aceita skills e mais nada, e o launch retinha a
concessão com um aviso. Nada quebrava, mas o formulário prometia o que a outra ponta não cumpria.

Agora ele oferece a um agente Grok só o que o Grok aceita. Claude e Codex seguem recebendo hooks e
MCP normalmente — os dois foram medidos com chamadas reais, e nos dois o hook concedido dispara.

Isso veio de uma varredura feita depois da correção de ontem no Codex: se um caminho de hook estava
morto sem ninguém notar, valia olhar os outros dois antes de esperar a próxima surpresa.

## 0.93.63 — o hook do Codex passa a existir

Um hook concedido a um agente Codex nunca disparou. Não falhava, não avisava, não deixava rastro: o
agente subia normalmente e o hook simplesmente não estava lá.

A causa é uma regra do formato de configuração do Codex. `hooks.PreToolUse` só significa "hook" se
estiver escrito no topo do arquivo; depois de qualquer cabeçalho de seção, a mesma linha vira um
campo daquela seção. O Tachyon escrevia os hooks no fim do arquivo — e o fim, sempre, vinha depois
do cabeçalho que marca seu projeto como confiável.

Agora eles são escritos antes de qualquer seção. Medido com um Codex real, na configuração que o
próprio Tachyon gera, movendo só a posição da linha: antes do cabeçalho o hook dispara, depois não.

Quem achou foi a checagem que compara o mapa dos runtimes com a realidade — e ela achou porque
errou primeiro, do outro lado, pela mesma regra.

## 0.93.62 — o Codex recebe suas skills sem tocar no seu projeto

Um agente Codex recebia as skills concedidas dentro de `<projeto>/.agents/skills` — um diretório que é
seu. Não por escolha: a versão do Codex de então não lia skills de mais lugar nenhum, então entregar
significava escrever no seu checkout e depois desligar, uma a uma, todas as skills que o agente não
podia ver.

O Codex mudou. Medido na 0.149.0, com controle: ele lê skills da própria casa privada. Então a entrega
virou o que já era no Grok e no Pi — **escrever na casa do agente** — e o seu projeto deixou de ser
tocado.

### O que isso dispensa

Uma classe inteira de problema, não uma linha de código. Não há mais como alguém deixar um arquivo com
o nome da skill concedida no caminho onde o agente procura — e não há mais a recusa de launch que isso
provocava, com uma mensagem mandando reautorizar algo que reautorizar não consertava.

A garantia de que você recebe exatamente o conteúdo autorizado **não se perdeu**: ela é conferida
contra o pacote do plugin, na hora de capturá-lo, que é um lugar melhor do que conferir contra o que
por acaso estivesse num diretório compartilhado.

E a negação ficou mais estrita: **toda** skill solta no projeto é desligada agora, sem exceção — antes
a concedida precisava ser poupada, porque morava lá.

## 0.93.61 — quem não recebeu nada passa a ser o mais isolado

Duas skills escritas à mão no checkout compartilhado, e um agente codex **sem concessão nenhuma**
subindo por cima: ele enxergava as duas.

A causa é o avesso do que deveria ser. O isolamento de skill inteiro vivia dentro de um "se este
agente tem capacidades", e um agente que não autorizou nada não tem. Então nenhuma linha era escrita e
ele via tudo o que estivesse solto no projeto — **quem foi concedido de menos ficava isolado de
menos.**

Zero concessão não é "não tenho nada a dizer". É a afirmação mais forte que existe: *suprima tudo o
que descobrir*. A diferença entre as duas leituras era um caminho de código que não rodava.

## 0.93.60 — o Agent Studio volta a enxergar os plugins

A versão anterior instalou o plugin certo, no lugar certo, sem tocar no seu projeto — e o Agent
Studio dizia que não havia plugin nenhum instalado.

A tela que lista o que se pode conceder a um agente lia o arquivo de registro **pelo nome, dentro de
uma string**. Quando esse arquivo deixou de existir, o compilador não teve como perceber e a lista
passou a ser vazia para sempre. Agora ela lê o catálogo — a mesma fonte que a concessão usa — e há uma
checagem que procura pelo nome do arquivo no código, porque foi exatamente isso que ninguém procurou.

Um segundo silêncio no mesmo lugar: num agente pi, um `prompt` que o plugin traz **seria concedido e
não aparecia na lista**. Autorizar concede o plugin inteiro, então mostrar menos do que o botão
entrega é a forma de erro que este produto passa a vida recusando.

### O card do plugin

Subiu sem folha de estilo — o nome colava na versão (`sddv2.0.0`) e os quatro runtimes viravam uma
palavra só (`claudecodexgrokpi`). Agora tem três níveis de leitura: quem é o plugin, o que ele faz, o
que ele traz. Nada disso aparece numa verificação de código: o texto já era o certo, o que faltava era
o espaço entre as palavras — então a verificação passou a medir distâncias e a olhar o retrato.

## 0.93.59 — o sistema de plugins, reescrito do zero

Um plugin é uma pasta que você descompacta. Ela fica lá **inerte**. Um agente que recebe a concessão
tem aquilo materializado na **própria home** no launch. Mais nada acontece.

O sistema anterior tinha 13.584 linhas e fazia muito mais do que o uso pedia. Medido no catálogo real
de 17 plugins: a capacidade mais cara — o Tachyon baixar e instalar binários — servia **três** deles,
e custava 2.000 linhas. Toda a porta de git servia uma forma de instalar que o produto já tinha
substituído por zip. **21.605 linhas saíram; o sistema novo inteiro tem 1.444.**

### A lei

> O agente recebe exatamente o que foi concedido. Nada que o plugin traz escapa para o projeto, e
> nada que está no projeto entra no agente sem ter sido concedido.

Instalar não cria mais `.claude/skills`, `.agents/skills` nem `.grok/skills`. O que fica é o payload
em `.tachyon/plugins/<nome>/`, e desinstalar é apagar essa pasta.

### O manifesto tem seis campos

`name`, `version`, `description`, e opcionalmente `docs`, `runtimes`, `requires`. O resto é convenção
de diretório — `skills/`, `extensions/`, `prompts/`, `themes/`, `packages/`, `hooks/<runtime>/`,
`mcp.json`. O campo que dizia onde ficavam os hooks sumiu porque a pasta já diz.

E `runtimes` virou **opcional**: ausente significa "todos os que conseguem consumir o que este payload
traz", que é a resposta certa para a forma comum. Declarar passa a ser um estreitamento deliberado do
autor, não cerimônia.

### O `pi` deixou de ser inalcançável

A concessão sabia entregar `extensions`, `prompts`, `themes` e `packages` ao pi desde o MVP, mas
nenhum plugin conseguia produzi-los — o manifesto antigo não sabia que o pi existia. Agora sabe.

### Não há mais lockfile

Ele existia para lembrar o que a instalação mesclava em arquivos compartilhados do seu projeto — a
única informação que não se derivava do disco. Sem essas escritas, `.tachyon/plugins/` **é** o
catálogo. Um registro que pode divergir do disco vai divergir, e quando divergir será ele que mente.

### O que saiu junto, e volta depois

**Git hooks** saem inteiros da v1 e voltam como um sistema próprio, porque é o que são: uma
contribuição ao repositório, que dispara para qualquer ator, e não uma capacidade de um agente.
Estavam no mesmo manifesto por conveniência, não por parentesco.

**Baixar binário** sai. Um plugin declara em `requires` a ferramenta externa de que precisa, a tela
detecta se ela está no PATH, e você a instala uma vez. Isso reduz uma garantia, e vale dizer qual: o
invólucro que fazia a lista de domínios do `agent-browser` ser inegociável pelo agente vinha do
provisionamento. Sem ele, o que afirma a política é o texto da skill.

## 0.93.58 — a concessão passa a ser o que entrega

Instalar um plugin escrevia as skills dele em `.claude/skills`, `.agents/skills` e `.grok/skills`. Para
todo mundo. Isso tornava a concessão por agente decorativa: o agente que recebeu a skill e o que não
recebeu liam o mesmo diretório, e a tela dizia outra coisa.

Agora o que a instalação deixa é o **payload**, em `.tachyon/plugins/<nome>/`. Quem escreve nos
diretórios do projeto é a entrega — por agente, só o que aquele agente recebeu — ou você, pelo botão
**Apply** no card, que já existia e agora é a porta explícita de exportar para o projeto. Desfazer tira
os diretórios e deixa o payload: desexportar não é desinstalar.

O que a instalação **continua** escrevendo: hooks mesclados no settings do projeto, servidores MCP e
git hooks. Para essas coisas não existe outro lugar onde morar, e desfazê-las precisa do registro —
só ele sabe qual linha num arquivo compartilhado era nossa.

### O que a mudança revelou

Quatro defeitos, todos da mesma raiz: o código media "o que esta instalação fez" contando escritas no
projeto, e isso deixou de ser verdade.

Um plugin que só traz skills não instalava — e essa é a forma comum, `sdd` e `agent-browser` são os
dois assim. A lista de runtimes do plugin ficava vazia, que é justamente o que a concessão lê.
Reinstalar **apagava** uma exportação sua, porque a limpeza de órfãos lia "o que a nova versão ainda
traz" do plano de escrita, e um plano vazio diz, ao pé da letra, que tudo é órfão. E reinstalar
**esquecia** a exportação, deixando o diretório no disco sem nada que soubesse removê-lo.

### Medido neste workspace antes de mexer

O registro declarava seis diretórios de skill; um existia no disco. A entrega já produzia um número
diferente do que o registro afirmava — a mudança não criou essa distância, tornou-a a regra.

## 0.93.57 — o seletor mede o que sugere, e ganha a segunda mão

Duas correções que vieram do uso.

### Um pacote de app não é candidato numa porta de plugin

O seletor sugeria qualquer `.zip` do disco, então um app empacotado aparecia no topo das sugestões do
instalador de plugins. Um seletor que sugere a coisa errada é pior que um que não sugere nada —
sugestão lê como recomendação.

Distinguir precisa dos nomes de dentro do arquivo, e um zip já guarda isso em texto puro no fim dele,
no diretório central. Agora a varredura lê **a cauda do arquivo, não o arquivo**: sem descompactar e
sem custo proporcional ao conteúdo, de modo que um pacote de 400MB responde tão rápido quanto um de
4KB — que é o que torna viável perguntar isso de cada candidato.

Só sai da lista o que foi **medido** como outra coisa. Um arquivo que não deu para ler continua sendo
oferecido, porque recusa de leitura não é evidência sobre o conteúdo, e esconder um plugin de verdade
porque o arquivo era estranho seria um "não" sem medição vestido de medido. Navegar continua listando
tudo: quem sabe onde está o arquivo não deve ter a pasta filtrada por baixo.

### Digitar e clicar são as duas mãos do mesmo seletor

Faltava a saída para o diálogo do sistema. Quem já sabe o caminho digita e é mais rápido; a maioria
das pessoas prefere clicar e escolher — e todo seletor que vale como referência põe um **Browse…** ao
lado da caixa em vez de obrigar a pessoa a escolher um estilo. Agora ele está lá, tanto para plugins
quanto para apps.

O que não muda é onde você chega: o diálogo do sistema nunca é a porta que abre sozinha, é uma porta
que você escolhe de dentro do nosso seletor.

## 0.93.56 — escolher um plugin acontece no picker do Tachyon

A versão anterior abriu a porta por arquivo com o diálogo do editor. Numa janela remota ou WSL esse
diálogo não é um seletor de arquivos: é um campo de texto "Folder path" solto por cima do editor, que
abre onde esteve por último em vez de onde os arquivos estão e não faz ideia do que é um pacote de
plugin. Agora a escolha acontece no mesmo seletor que o instalador de apps usa — dentro do painel, já
com os arquivos que estão por perto listados, e navegando dali quando o que você quer não apareceu.

O seletor tem duas telas e as duas são o desenho: ele **abre** nos `.zip` que já estão por perto (o
que você acabou de baixar ou empacotar costuma ser o que você quer) e **navega** a partir daí quando
não estão. ↑↓ move, Enter entra numa pasta ou pega o arquivo, Backspace sobe, Esc fecha, e um caminho
digitado ganha da linha destacada — quem escreveu um endereço quis o endereço.

### Dois defeitos que só a tela revelava

A prova visual desta versão é screenshot do componente real, e pagou na hora. Os dois vinham do
seletor de apps e estavam em produção desde então:

A trilha imprimia `/ / home / goat / Downloads`. A migalha da raiz **é** uma barra, e o desenho punha
um separador antes de toda migalha a partir da segunda.

Os caminhos apareciam como `home/goat/Downloads/`, com a barra inicial no fim. A coluna do caminho é
escrita da direita para a esquerda de propósito, para a reticência comer a **cabeça** e a cauda — a
parte que distingue duas pastas — sobreviver. O preço é que `/` é um caractere neutro e migra para o
outro extremo. Nenhuma verificação de código pegaria esse: o texto sempre foi `/home/goat/Downloads`,
a diferença só existe depois que o navegador ordena a linha, ou seja, só na tela.

## 0.93.55 — um plugin também entra por arquivo

Instalar um plugin custava resolver um endereço de git, clonar numa tag fixada, conferir checksum,
calcular impressão digital e transacionar. Agora também se instala um `.zip` que você escolheu no
próprio disco — e daí para a frente o caminho é **o mesmo**: a mesma prévia, a mesma gaveta de
consentimento, a mesma aplicação transacional.

A costura já estava lá. Quem carrega de um endereço faz três coisas em sequência — resolve, busca,
e carrega o diretório. Só as duas primeiras são de git; tudo depois da terceira opera sobre um plugin
já carregado e nunca pergunta de onde ele veio. A porta nova produz o diretório de outro jeito e
para por aí.

### O que não vem junto, de propósito

Procedência. Um plugin lido de arquivo é gravado **sem** origem e sem integridade, e o resto do
sistema já aceitava isso antes desta versão — a checagem de atualização já pulava quem não tem origem,
e o card já sabia se desenhar sem ela. Um checksum de um arquivo que você mesmo escolheu não prova
nada: não há editor a quem vinculá-lo e não há segunda parte que pudesse reverificá-lo depois.
Registrar uma origem sintética seria registrar que um arquivo existiu em algum lugar uma vez.

### O que continua vindo junto, também de propósito

Consentir **execução**. Um zip que provisiona binário, instala git hook ou registra um servidor MCP
passa pela mesma gaveta de aceite que um plugin vindo de git, porque a consequência é idêntica:
código de terceiro roda na sua máquina. Origem local dispensa provar de onde veio; nunca dispensa
saber o que faz.

### Onde o manifesto pode estar

Na raiz do arquivo, ou dentro de **uma única** pasta — que é o que todo "baixe esta release" produz.
Obrigar você a achatar a pasta seria transferir um detalhe do empacotador. Um arquivo com dois
manifestos é recusado pelo nome dos dois, em vez de adivinhado.

## 0.93.54 — o sobrevivente de um reinício volta a ser reconhecido

Um agente vivo podia ficar mudo com o motor de pé. A cura já existia — há um mecanismo que lê a
credencial do próprio processo do painel gerenciado e a readota, escrito exatamente para "o processo
ainda tem um token que o registro esqueceu". O gatilho é que estava estreito: só o caso em que o
registro **desconhece** o token.

E não é esse o estado que um reinício do motor produz. Ele aposenta toda credencial viva, com uma hora
de tolerância, e emite uma nova dentro de um ambiente que nenhum painel vivo pode receber — variáveis
de ambiente são fixadas no nascimento do processo. Passada a tolerância, o painel passa a ser
**expirado**, e a cura recusava exatamente aí. Medido na sessão do autor, no meio de uma tarefa: o
agente de pé, o motor de pé, e sem voz.

Expirado passa a curar junto com desconhecido. São o mesmo fato: artefato de ter reiniciado, nunca
evidência sobre quem segura a credencial. O que prova a identidade não afrouxou — o portador tem de
estar dentro da árvore de processos de um painel gerenciado, e a identidade adotada é a do **cadastro**
daquele painel, jamais a que o processo declara de si.

### E o que continua sem cura, agora garantido no lugar certo

Uma credencial **revogada**. Revogar é uma decisão — encerrar, dispensar, uma retirada consumada, uma
morte observada — e curar significaria ler o texto puro de um processo vivo, que é precisamente a
situação que essas decisões existem para anular. A recusa passou a morar no próprio registro, não
apenas no ponto de chamada, para que um curador futuro não desfaça por acidente as garantias das duas
versões anteriores.

## 0.93.53 — o dado que a página de um app guarda passa a ter dono

A última afirmação da spec de apps que ainda não tinha sido medida: o que acontece com o que a página
de um app guarda no navegador. Medida, e a resposta trouxe dois fatos que não estavam no plano.

**Toda aba de app compartilha uma origem.** Elas são criadas sob o mesmo tipo de painel — e têm de
ser, porque o editor não registra restaurador para um tipo que ele só conhece depois de iniciar. A
orientação do próprio editor é explícita sobre a consequência: instâncias de uma mesma webview correm
na mesma origem, e o armazenamento é partido por origem. Ou seja, até aqui **um app lia e sobrescrevia
o armazenamento de outro**.

**E desinstalar não conseguia limpar nada.** Nenhuma interface entrega o armazenamento de uma webview
a uma extensão: o diretório ia embora e o que a página tinha escrito ficava, invisível e sem dono.

Agora cada app recebe o seu próprio espaço de nomes, sem que o autor faça nada. Isso torna o dado
**identificável** — e identificável é o que o torna **removível**: uma página da mesma origem pode
apagar o espaço de outra, então toda página de app varre, ao abrir, o que pertence a apps que já não
estão instalados.

O limite está dito na confirmação em vez de subentendido: o dado de um app desinstalado sai na próxima
vez que **algum** app abrir, não no instante da remoção. Nada nosso corre naquela origem enquanto
nenhuma aba de app está aberta, e abrir uma aba escondida só para varrer piscaria um painel na cara de
alguém por causa de faxina.

## 0.93.52 — o ladrilho ganha menu, e a ação vira linha de tabela

Botão direito num ladrilho do launcher abre um menu. O que ele oferece é **dado**, não ramo:
acrescentar "Novo agente" ao Fleet mais tarde é uma linha numa tabela, não um `if` dentro de um
componente.

Duas fontes, uma forma. Uma tela embutida declara suas ações ao lado do metadado que já diz o que um
ladrilho **é**; um app instalado declara as dele no próprio manifesto, e elas chegam junto com o
catálogo. **Desinstalar** não é declarado por ninguém: é contribuído pelo produto e apenas para um
ladrilho que veio de disco. A regra é estrutural — nenhum ponto de chamada pode errá-la, e uma tela do
núcleo nunca recebe essa linha.

### O componente foi medido contra os padrões, não montado no olho

O menu do quadro de tarefas já tinha a forma certa e é de onde este parte. O que as referências somam:

- **Shift+F10 e a tecla de menu abrem o menu.** Sem isso ele é só-mouse, e toda ação dentro dele fica
  inalcançável por teclado — a maior lacuna do menu antigo.
- **Escape devolve o foco a quem abriu.** Fechar e largar o foco no documento deixa quem usa teclado
  longe de onde estava.
- **Home/End e salto pela primeira letra**, que é o resto da gramática de menu.
- **Separador, e o item destrutivo pintado à parte, por último**, com uma confirmação que diz o
  **limite** do que ele faz.
- **Item indisponível fica listado, com o motivo.** Uma linha ausente é indistinguível de uma ação que
  não existe.
- **O painel vira em vez de deslizar** quando não cabe. Deslizar mantém o menu na tela e o desgruda do
  objeto — a única coisa que um menu contextual não pode fazer. E ele fecha ao rolar ou redimensionar,
  pelo mesmo motivo.

### E a primeira ação específica, como prova

**Nova tarefa**, no ladrilho do quadro, abre direto a tela de criação — a mesma que o botão do próprio
quadro já usava. Uma linha na tabela e um ramo na porta do host: é esse o custo que a arquitetura
promete para a próxima ação.

Um app instalado também pode declarar as suas, e elas viajam para a **página dele**: o produto nunca
interpreta o vocabulário de um app. Os dois nomes que são nossos — abrir e desinstalar — são recusados
na validação do manifesto.

## 0.93.51 — as duas metades

Dois defeitos, e os dois com a mesma forma: metade de um par simétrico foi corrigida, e o teste
escrito para provar a correção olhou apenas para a metade já corrigida.

**Instalar um app respondia "resultado de comando inválido".** Existem duas listas de ações — uma de
consultas, outra de comandos — e o **resultado** de cada operação é validado contra a sua. A ação de
instalar estava na descrição do pedido e fora da lista: o pedido era aceito, o motor respondia, e a
resposta era recusada na volta. É exatamente o que tinha acontecido do lado das consultas na versão
anterior; o guardião escrito então cobria consultas e não comandos. Agora cobre as duas, e cada metade
foi provada falhando sem a sua entrada.

**E o arranque falhou de novo, pelo mesmo motivo em outro lugar.** A folga dada ao motor que ainda
está vivo entrou numa das duas esperas — e a instalação roda a **outra**. A folga existia e nunca era
executada; a auditoria continuava dizendo "não respondeu em 10s". Agora está nas duas, e um teste
afirma isso pelo nome de cada uma.

Cobrir um de dois caminhos simétricos não é meia proteção: ensina a lição errada sobre qual dos dois
está seguro.

## 0.93.50 — o seletor de arquivo passa a ser um seletor de arquivo

O que a versão anterior chamava de seletor era uma lista chapada do que uma varredura tinha achado.
Não fazia a única coisa para a qual um seletor existe: alcançar um arquivo que a varredura **não**
achou. E dizia "nenhum .zip encontrado em" — com nada depois.

### O nada depois era o defeito de verdade

Existe uma lista explícita de ações de consulta, e o **resultado** de cada consulta é validado contra
ela. As duas ações novas de apps foram acrescentadas ao formato da requisição e não a essa lista: o
pedido entrava, o motor respondia, e a resposta era recusada na volta. O catálogo de apps nunca
funcionou — o ladrilho de um app instalado também nunca teria aparecido. E o `catch` que engolia isso
devolvia uma lista vazia, que é uma resposta vazia vestida de resposta medida.

Agora as ações estão na lista, a falha viaja como **razão** e aparece na tela, e um teste compara o
formato com a lista — porque as duas podiam divergir caladas, e foi o que fizeram.

### O seletor novo

Pesquisadas as referências de interface para seletores de arquivo e aplicado o que elas concordam,
na largura de uma barra lateral:

- **Trilha de navegação** clicável em cada nível; numa coluna estreita só a cauda cabe, então a
  cabeça vira reticências em vez de quebrar linha.
- **Uma caixa que filtra e endereça.** Texto filtra a pasta atual; algo que começa com `/` ou `~` é um
  caminho, e Enter navega até ele. Duas caixas custariam uma linha cada.
- **A primeira tela são os arquivos por perto**, não a raiz do sistema — a ideia de "recentes": o
  arquivo que alguém quer costuma ser um que acabou de construir ou baixar.
- **Teclado primeiro:** setas movem, Enter entra numa pasta ou leva o arquivo, Backspace sobe, Esc
  fecha, e a linha ativa tem anel de foco visível, nunca só cor.
- Pastas antes de arquivos, ambos em ordem alfabética. Uma pasta ilegível diz **por que** está vazia,
  em vez de parecer vazia.

## 0.93.49 — lento não é quebrado

Instalar a versão anterior podia terminar em "Tachyon não conseguiu iniciar nem o motor novo nem o seu
retorno verificado", com o humano clicando em Repetir até pegar. A frase é de catástrofe. O que estava
acontecendo era outra coisa.

Medido no diário do sistema e na trilha de transições: três partidas seguidas morreram **exatamente**
aos 10,0 segundos, cada uma consumindo cerca de um segundo de CPU em dez de relógio — famintas, não
quebradas. O retorno bateu no mesmo limite. A quarta tentativa subiu, nas mesmas condições. A trilha
registrava a causa que a tela não dizia: o motor não ficou pronto dentro do prazo.

O prazo era o defeito. Dez segundos é um **piso** razoável para o arranque a frio de um pacote de
megabytes; é um teto péssimo. Agora o prazo é estendido uma vez, e apenas enquanto o supervisor do
sistema ainda reporta o processo ativo: quem está lento ganha folga, quem morreu falha na hora —
exatamente como antes.

E a mensagem passa a dizer **quanto** esperou. Anunciar falha total de um arranque que apenas demorava
manda a pessoa repetir às cegas, que foi precisamente o que aconteceu.

## 0.93.48 — o mesmo `+`, o nosso picker, e a extensão dentro do portão

Três correções logo depois do primeiro uso da instalação de apps.

**O botão estava errado.** "Add app" saiu como um botão de linha inteira acima da grade — lia como um
banner sobre as telas, não como uma ação da seção. Agora é o mesmo `+` que Agentes e Terminais usam,
no cabeçalho, ao lado do controle de ordenação. A mesma coisa merece a mesma affordance.

**O seletor de arquivo era do editor.** Escolher qual `.zip` instalar é uma decisão do Tachyon e
estava sendo feita na chrome do VS Code. Passa a usar o picker do próprio produto, exatamente como já
havia sido feito quando "novo …" deixou de usar a lista nativa: o motor varre alguns lugares óbvios —
o projeto, Downloads, Desktop e a pasta temporária — com profundidade e contagem limitadas, pulando
as árvores ruidosas que todo projeto carrega e sobrevivendo a um laço de atalhos, e devolve o
**conjunto de candidatos**, que é a forma com que todo picker deste produto trabalha. A porta da
paleta de comandos mantém o diálogo nativo, porque lá não há superfície nossa na tela.

### E o portão que não cobria a extensão

`apps/vscode-extension/src` não estava em nenhum projeto de verificação de tipos. O portão só o
alcançava pelo que os testes importam — e o que nenhum teste importa não era verificado. Foi assim
que, nesta mesma spec, um símbolo referenciado antes de existir passou uma rodada inteira despercebido
no arquivo de ativação da extensão.

Agora está coberto, e a cobertura foi provada carregando peso: com um símbolo inexistente plantado, o
portão falha nomeando o símbolo e a linha.

Ele achou um defeito real no primeiro segundo: duas ramificações liam um campo `run` de um agendamento
que não existe há tempos — a forma "rodar um comando no relógio" foi retirada quando um agendamento
passou a acordar um agente declarado. Código morto, inalcançável, sobrevivendo por estar fora do
alcance da verificação.

E o pacote da tela de plugin sai da lista de empacotamento: retirar o alvo do build impede que ele
seja **construído**; só essa lista impede que ele seja **empacotado** a partir de um diretório de
build reaproveitado — que foi como a 0.93.47 embarcou o pacote de uma capacidade que ela mesma acabara
de remover.

## 0.93.47 — o usuário ganha a tela, e o plugin devolve a que ninguém usava

Tachyon tinha duas maneiras de desenhar uma tela e nenhuma delas era do usuário. Doze telas embutidas,
fixas em tempo de compilação. E uma porta de terceiros — a `views` do manifesto de plugin — que exigia
publicar um pacote num repositório git, rodava num iframe sem rede, via um único recorte de dado e
podia pedir uma única ação. Medida em agosto: **um consumidor no mundo inteiro**, uma prova de
conceito que o dono não usa.

Um **app** agora é HTML que o usuário instala subindo um `.zip`. Ele é descompactado em
`.tachyon/apps/<id>/`, ganha um ladrilho no launcher com o próprio ícone, abre numa aba do editor e
fala com o Tachyon pelo Bridge — a mesma superfície que os agentes usam, sem allowlist e sem
consentimento por ação. O humano instalou; o humano consentiu.

### O catálogo de telas deixou de ser decidido no build

As doze embutidas viram o prefixo e o disco escreve o resto. As três verificações que existiam para
pegar erro de digitação continuam derrubando o boot quando um id LITERAL está errado — é para isso que
elas foram escritas — e uma linha vinda do disco degrada em vez de derrubar: título vazio cai para o
id, id repetido é descartado, id malformado é ignorado. Config errada avisa, nunca bloqueia.

O ladrilho de um app se chama `app:<id>`, e os dois-pontos são o que torna a colisão com uma tela do
produto impossível **por construção** em vez de por convenção de nome. Isso obrigou três lugares a
concordarem, e um deles teria falhado calado: a ordem persistida do launcher rejeitava o token novo,
enquanto a atualização otimista da grade mostrava o arranjo correto até o próximo reload o jogar fora.

### E a porta de terceiros foi fechada, não deixada aberta e vazia

`views` saiu do manifesto, com o corretor de superfícies, o intermediário de ações, a projeção de
frota, o pacote de tela, o modo de sandbox correspondente e o alvo de lockfile. Nada foi migrado —
não havia o que migrar.

O que fica no lugar são recusas que **ensinam**. Um plugin que ainda declara `views` não ouve "campo
desconhecido": ouve que a capacidade mudou de casa, e qual é a casa. Um registro de instalação antigo
que ainda carrega uma tela é recusado pelo nome, antes da mensagem genérica, e nunca lido pela metade
— um registro custodiado que não pode ser honrado tem que ser dito em voz alta.

Duas coisas ficaram de propósito: os identificadores das abas de superfície continuam sendo
descartados na abertura da janela, porque alguém pode ter uma delas aberta ao atualizar; e os dois
modos de protótipo do sandbox ficam, porque têm consumidores próprios.

## 0.93.46 — resposta vazia não é evidência

A regra que a 0.93.45 devolveu à vida apagou, na instalação seguinte, o runtime da engine que estava
para subir. Aconteceu na máquina do dono, e a falha é da regra que eu escrevi.

O reclaim de arranque rodou na **janela de ativação** — engine antiga já parada, nova ainda não
iniciada. A medição pelo núcleo respondeu "olhei e não há engine nenhuma", e o código tratou isso como
evidência. O cinto que eu tinha posto — "guarda o mais recente" — escolheu pelo mtime do diretório,
que apontava para um runtime antigo. Coletou-se exatamente o que a engine ia usar.

### Dois erros, e o segundo anulava o primeiro cinto

**Ter medido e não ter achado ninguém não prova que nada é necessário.** Um runtime só é coletado
quando o exame identificou **positivamente** algum como em uso. É o método da faxina aplicado ao caso
vazio, onde não saber é razão para manter.

**Recência nunca foi evidência de uso.** O mtime de um diretório não diz qual runtime a próxima
ativação vai usar — no incidente, apontou justamente para o errado. O cinto saiu.

### E um terceiro, achado ao medir o estrago

O núcleo guarda no link do executável o caminho **original** e lhe acrescenta " (deleted)" quando o
arquivo some — então resolver o link falha exatamente onde a resposta mais importa. Uma engine viva
cujo runtime alguém já apagou ficava **invisível para o próprio exame**, convidando a mesma remoção
outra vez. Agora o link é lido, não resolvido.

As razões de retenção também deixaram de mentir: "uma engine viva roda nele" e "nada foi medido" são
fatos diferentes e agora chegam ao humano em frases diferentes.

### O estrago foi reparado

O runtime foi restaurado byte a byte a partir do Node do próprio editor, cujo resumo criptográfico é
exatamente o identificador do diretório removido — verificado por hash e por execução, com
autorização do dono. Nada foi reconstruído por aproximação.

## 0.93.45 — a regra existia e nunca pôde disparar

Depois da faxina da 0.93.34, o maior item de estado machine-local desta máquina passou a ser
`engine-runtimes`: 760 MB em cinco cópias do Node, das quais **uma** está em uso. Não sobreviviam por
falta de regra. A regra existia, e não podia disparar.

O scan decidia se um runtime está em uso lendo um `runtimeId` no manifesto de cada engine retido.
Nenhum manifesto jamais teve essa chave — e o fallback conservador que existe para o caso "ninguém
declarou nada" marcava então **todos** como em uso, sempre. Um guarda que nunca acorda parece um
guarda.

### A chave não faltava por acidente: era impreenchível

Um engine é **construído** — pelo `npm run release`, numa máquina que não é a de quem usa. Um runtime
é o Node do editor **de quem usa**, copiado na ativação e endereçado pelo próprio conteúdo. O par
engine↔runtime é por instalação, nunca por build. O manifesto do build era o lugar errado desde o
primeiro dia, e preencher a chave teria sido implementar o erro de categoria com mais capricho.

O núcleo do sistema já responde à pergunta real: o executável de um processo cujo título é o de um
engine Tachyon **é** o runtime que ele está rodando. Esse fato não depende de ninguém lembrar de
gravá-lo.

### Três decisões, ditas em voz alta

Um runtime está em uso quando um engine vivo o executa **ou** quando é o mais recente — cinto, porque
é o que a próxima ativação reencena de qualquer forma, e porque torna a regra segura de rodar sem
nenhum engine no ar.

**Não ter medido não é ter provado morte.** Onde o núcleo não pode ser lido — outro sistema
operacional, um sandbox — nada foi medido e a resposta conservadora de antes continua valendo:
segura tudo.

E coleta direta, não quarentena. A quarentena existe porque o estado de um engine morto carrega
chaves de API, material insubstituível que ninguém deve apagar com base numa inferência. Um runtime é
cópia de um binário público, recuperável numa ativação: guardá-lo num canto seria manter os mesmos
bytes com outro nome.

Nesta máquina, o plano passou a enxergar 0,67 GB — quatro runtimes sem dono, com o vivo intocado.

## 0.93.44 — estado de runtime deixa de ser conteúdo do repositório

Três arquivos ainda estavam versionados sob `.tachyon/`, contra a regra da casa e contra o próprio
`.gitignore`. Isso já tinha sido decidido uma vez e revertido: um commit desversionou `.tachyon/`
inteiro, exatamente como a regra sempre disse, e o seguinte devolveu os três à força — porque dois
testes os leem.

O raciocínio de quem devolveu estava certo sobre **o quê** (arquivo sob teste é conteúdo do
repositório) e errado sobre **onde**. `.tachyon/` é um diretório que o runtime cria, muta e pode
perder sem que isso conte como perda de código. O `rm -rf` de ontem levou o workspace, e o único
motivo de esses três terem sobrevivido é que o git os segurava **contra** a própria regra de ignore
dele. Sobreviver por acidente não é uma estratégia de custódia.

Os estudos passam a morar em `test/fixtures/studies/`. O que decide o destino não é o gênero do
texto — dois são relatos de investigação, um é C de verdade — e sim quem quebra se o arquivo sumir.
Quem quebra é a suíte.

### A anomalia suspeitada não existia

Havia a suspeita de uma regra de ignore quebrada, porque `git check-ignore` respondia "não ignorado"
para esses caminhos. Medido de novo agora: responde corretamente. `check-ignore` fala sobre arquivos
**não rastreados**; enquanto os três estavam forçados no índice, a resposta estava certa e a
conclusão é que era o rastreamento, não a regra. Nada a simplificar — e a medição virou teste, para a
suspeita não voltar.

### Uma regra que já foi revertida uma vez precisa de dente

O que impede a terceira rodada disso não é a mudança: é o guardião. Um teste pergunta ao índice
diretamente se algum caminho sob um `.tachyon/` de workspace está rastreado, e a única exceção é a
que faz sentido — um workspace de fixture tem que carregar o seu, porque é justamente ele o objeto do
teste. A mensagem de falha nomeia a saída (mover para fixtures), não só a proibição: os três arquivos
estavam ali por um motivo real, e o conserto sempre foi movê-los, nunca apagá-los.

## 0.93.43 — morrer sozinho também retira a credencial

A 0.93.42 fechou a retirada de credencial quando o agente é removido. Ficou medido, e dito, um caso
vizinho: um agente que **morre por conta própria** — crash, exit, Ctrl-C no arranque — não passa por
`kill` nem por `dismiss`, que são as duas ações nossas, e por isso ninguém revogava seu token. Ele
esperava as doze horas do TTL. Medido: uma saída 130 às 14:15, ainda `live` seis horas depois.

O lugar sempre foi óbvio — a costura onde a morte é evento e não condição parada, a mesma que já
carimba "esta parada foi pedida" na linha durável. O que impedia era a colisão de nomes: a revogação
é por **nome**, e spawn, restart e resume mintam sob o mesmo nome. Revogar ali podia matar a
credencial da instância **viva** que substituiu o pane morto — 401 aleatório num agente que está
funcionando, defeito pior que o vazamento que se queria fechar.

### A guarda é um contador, não um relógio

Um token mintado a partir do inventário que viu aquele nome **vivo** não pode pertencer à encarnação
que acabou de morrer: algo o criou depois. Só um token mais velho que aquela observação é o do
morto, e só ele é revogado. Relógio não serviria — o mint e a leitura cabem no mesmo milissegundo, e
a distinção que decide o caso desapareceria justamente onde ela é necessária.

Na dúvida o vazamento fica: uma credencial que expira sozinha é o mais barato dos dois erros.

Todo mint passa agora por um único ponto, para que o registro não possa divergir do que foi de fato
mintado.

### As duas metades foram provadas carregando peso

Sem a revogação, a morte deixa o token vivo e o teste falha. Sem a guarda, o restart perde a
credencial nova e o teste falha. Um teste verde que passasse com qualquer das duas removidas não
estaria medindo nada.

## 0.93.42 — a credencial não sobrevive ao agente

Um agente removido deste workspace continuou existindo onde importa. O forget commitou — saiu do
roster, o perfil foi quarentenado no recibo de retirada, a sessão morreu, o brief e o transcript
sumiram — e o registro de identidade do host ainda o trazia como **live**, válido pelas doze horas
restantes do seu TTL.

O caminho do forget já afirmava, em comentário no próprio código, alcançar "a mesma cauda de
retirada de credencial que o dismiss de um Temporary". O token era o único item dessa cauda que ele
não executava. O `kill` revoga no teardown e o `dismiss` revoga no fim de vida do Temporary, mas
nenhum dos dois está em toda estrada que chega ao forget: uma sessão que morreu sozinha, ou que foi
parada por outra porta, chega lá com a credencial viva. Agora a retirada revoga.

Não há corrida a proteger nesse ponto: a mesma função já provou a sessão morta antes de começar, e a
entrada do roster deixou de existir — nenhuma instância nova daquele nome pode estar mintando.

### O teste reproduz o estado medido, não o conveniente

Matar o agente antes do forget também revoga, então um teste que apenas matasse passaria sem a
correção — verde sobre uma garantia que não existe. Ele reencena o estado que foi medido: morto, com
a credencial ainda viva. Falha sem a correção, passa com ela.

Fica medido e não corrigido um caso vizinho: um processo que morre por conta própria não passa pelo
`kill`, e seu token também espera o TTL. Fechar isso não é uma linha — a observação de morte roda por
varredura e a revogação é por nome, então revogar ali pode atingir o token de uma instância nova que
subiu entre duas varreduras. Precisa de revogação por encarnação, e isso é outra mudança.

## 0.93.41 — entregar o que o instalador deixou tem uma premissa

A 0.93.39 trocou posse por exatidão: na raiz do workspace o lançamento parou de escrever a árvore de
skills e passou a **entregar o que o instalador deixou**, nomeando por caminho o que o agente não
pode ver. A premissa disso é que o que o instalador deixou ainda está lá, do jeito que ele deixou.
Duas coisas sobre esse "jeito" não estavam no desenho, e cada uma sozinha bastava para recusar uma
concessão saudável no resume.

### Um dest instalado é um link, não um diretório

O instalador materializa o dest como **symlink** para o payload do plugin — zero bytes duplicados. A
varredura pulava tudo que não fosse diretório de verdade, então um skill de plugin não era nem
entregue nem suprimido: sumia da conta. E a captura de custódia recusa symlink por desenho, então o
digest também não fechava.

Medido na codex-cli 0.149.0: o Codex segue o link, descobre o skill e o reporta sob o **caminho de
descoberta** — que é exatamente o caminho que o suprime. O link é, portanto, uma entrada descoberta
como qualquer outra, e passa a ser tratada como uma. O digest é conferido no diretório real por trás
do link: o conteúdo que o agente vai ler **neste** lançamento é a pergunta que importa.

### O registro podia afirmar um dest que o disco não tinha

O lockfile é o registro custodiado do que o humano instalou, e nada nunca o conferiu contra o disco.
Medido neste workspace: três dests registrados como materializados, nenhum dos três presente. Essa
falta não tinha dente enquanto um agente Codex no checkout compartilhado não podia ter concessão
nenhuma — ganhou dente na 0.93.39, e apareceu como a recusa que um `agent-browser` legitimamente
concedido levava ao ser retomado.

Um dest que a concessão nomeia e o disco perdeu é restaurado do payload que o registro aponta.
Reparo, não posse: só a entrada nomeada, só quando ausente, só de onde o lockfile manda, e só para um
dest que ele já declara. O que está no disco nunca é tocado — e é essa a diferença inteira entre isto
e a substituição de árvore que não pode rodar nessa raiz.

### E os botões colados

`.ash-native-config-actions` era uma classe que a folha do Agent Studio nunca definiu, então
"Authorized" e "Revoke" saíam encostados um no outro.

## 0.93.40 — o que ainda lia, e o que ainda dizia

A 0.93.37 retirou a ponte de migração do `tachyon.yml`. A promessa era maior que isso: que um
arquivo com esse nome na raiz simplesmente não fizesse nada, e que o nome não sobrasse vivo no
produto. Nenhuma das duas valia ainda.

### Dois caminhos ainda liam o arquivo

A resolução de identidade de harness — a pergunta "este agente tem um harness isolado de verdade?",
que decide se um plugin pode ser instalado só para ele — lia o bloco `agents:` da raiz quando não
achava um profile canônico. Era uma segunda resposta para uma pergunta que hoje tem uma casa só,
`.tachyon/agents/<name>/agent.yml`, e sobreviveu tanto ao arquivo quanto à própria espécie inline
que ela lia. Saiu, junto com a espécie `yaml-harness` que só ela produzia.

O Integrated Browser caía para o `tachyon.yml` quando a config viva não trazia `homeUrl`. Passa a
ler `.tachyon/settings.yml`.

### E cerca de cinquenta textos ainda mandavam o leitor para lá

Isso não é cosmética, porque metade desses textos é lida por **agente**, não por humano. O
`spawn_agent` oferecia, como saída governada para quem precisa de um checkout que sobreviva ao
filho, "declare it in tachyon.yml" — um conselho impossível de seguir. As descrições das ferramentas
de fleet ensinavam a mesma geografia. E todo agente salvo vinha com a explicação de por que não pode
ser dispensado apontando para um arquivo que não existe.

A regra aplicada: corrige-se o que alguém lê em runtime — descrição de ferramenta, mensagem de erro,
texto de UI — e o comentário que afirmava no presente algo falso. Comentário que registra história
fica: ele está certo sobre o passado. Sobraram cinco menções, todas nomeando a espécie legada como
legada.

## 0.93.39 — a limitação era nossa, não do Codex

A 0.93.38 recusava conceder skills de plugin a um agente Codex que roda na raiz do workspace, e
explicava por quê: a projeção substituiria `.agents/skills` — o diretório onde o instalador guarda
todos os plugins. A recusa protegia algo real. O que ela não protegia era a premissa em que se
apoiava.

Duas afirmações sustentavam esse desenho, ambas medidas na codex-cli **0.146.1**: que não existe
raiz de descoberta além do diretório de trabalho, e que a supressão `[[skills.config]]` é
identificada por **nome** — o que tornaria um skill concedido indistinguível do skill de plugin com
quem divide o nome.

Re-medidas na **0.149.0**, as duas são falsas. A supressão é por **caminho**, e funciona por entrada
dentro de um mesmo diretório: três skills em um `.agents/skills`, duas desabilitadas por caminho, a
terceira entregue. E no caso que decide — mesmo nome em dois lugares, o do workspace suprimido —
o agente vê só a concedida.

### Exatidão deixou de custar a posse do diretório

Na raiz do workspace, o lançamento agora **não escreve nem apaga nada**: nomeia por caminho tudo que
o agente não pode ver. Em um worktree segue substituindo a árvore, que é a forma mais forte e
continua sendo dele.

As duas metades da garantia ficam de pé, e uma delas melhorou. Nada não-concedido aparece — agora
inclusive os skills do home do usuário, que a substituição de diretório nunca cobriu: um skill
escrito à mão em `~/.agents/skills` chegava a um agente Codex que não recebera nenhum. E nada é
entregue em conteúdo que a concessão não atestou: um skill cuja árvore viva não confere com o
digest registrado é recusado pelo nome, em vez de embarcado.

Na prática: um agente Codex no checkout compartilhado volta a poder receber plugins, sem worktree.

### E o achado virou teste, não comentário

Uma medição de runtime externo tem prazo de validade. O comentário no código registrava a versão
medida — isso foi correto; o erro foi o produto passar a tratá-la como propriedade permanente do
Codex. Agora as três premissas são um teste que as re-mede contra o `codex` instalado e diz qual
delas mudou, em vez de um texto que as cita.

## 0.93.38 — autorizar um plugin deixa de ser uma porta só de ida

Autorizar o `agent-browser` num agente Codex deixava o agente **sem lançar e sem resumir**, e a tela
não oferecia nenhum caminho de volta. Duas falhas somadas, e a segunda é o que transformava a
primeira em armadilha.

### A recusa estava certa — o momento é que estava errado

As skills de um agente Codex são projetadas em `<cwd>/.agents/skills`. Com o worktree desligado esse
`cwd` **é a raiz do workspace** — onde esse diretório pertence ao instalador de plugins e guarda o
roster inteiro. Projetar ali apagaria todos os plugins instalados, então o launch recusa. Isso é
correto e deliberado.

O problema era descobrir isso tarde: o Agent Studio aceitava a concessão, salvava, e a
incompatibilidade só aparecia no lançamento seguinte — quando o agente já estava inutilizável. Agora
a mesma condição é verificada **onde a escolha é feita**, e a mensagem diz a saída: dar um worktree
ao agente. Com worktree, a concessão é normal; outros runtimes não são afetados, porque a colisão é
da projeção do Codex.

### E o que foi concedido pode ser retirado

Um plugin autorizado terminava num rótulo morto — "Authorized" e nada mais. Como o perfil de um
agente é atestado, editar o arquivo à mão arrisca recusar o agente inteiro, então uma autorização
feita por engano era, na prática, permanente.

O botão **Revoke** agora fica ao lado, e retira as referências que o plugin concedeu junto com a
seleção que dependia delas. O mecanismo já existia por dentro — revogar uma skill, ou revogar um
plugin de todos os agentes quando ele é desinstalado; o que faltava era poder retirar **um plugin de
um agente**, que é exatamente o gesto que a tela oferecia só na ida.

## 0.93.37 — a ponte de migração do tachyon.yml é retirada

A 0.93.30 aposentou o `tachyon.yml` e deixou uma ponte: na primeira carga, um arquivo legado era
projetado para as casas novas, o original preservado e o arquivo da raiz removido. A ponte existia
para um upgrade, e todo workspace que precisava dela já atravessou.

Ela sai agora, e não por gosto de limpeza: uma camada de tradução que ninguém mais alcança é uma
**segunda definição do formato**, esperando para discordar da primeira no dia em que alguém mexer
numa das duas.

O que muda para quem usa: nada — a não ser que você tenha um `tachyon.yml` esquecido na raiz. Ele
agora é um arquivo inerte. O produto não o lê, não o traduz e não o apaga.

### O que passava por causa dela

A parte que valeu o trabalho não foi remover, foi descobrir o que dependia. Cinco lugares semeavam
workspaces no formato antigo e funcionavam **porque a migração os traduzia** — entre eles o próprio
`vsix-smoke`, o portão que roda em toda release. Removê-la sem convertê-los teria quebrado o
empacotamento, e não o teste que a apontasse.

Vários deles escreviam blocos `agents:` que o carregador **já** descartava — agentes vêm de perfis
desde a SDD 478. Ou seja, semeavam configuração que o produto ignorava havia meses, e ninguém tinha
motivo para notar enquanto tudo passava.

## 0.93.36 — a rotina de verificação visual vira guidance, e o relatório do reclaim presta contas

### Qualquer agente passa a saber COMO olhar para a UI

A guidance do projeto já dizia que uma suíte verde não é julgamento visual, e trazia os princípios
duramente aprendidos: escreva a âncora antes de construir, meça em duas larguras, o veredito é
advisory e é insumo do julgamento, não a conclusão. Faltava a mecânica — como capturar de verdade,
neste repositório, onde as superfícies são webviews sem URL própria.

Agora ela está escrita, em quatro passos, cada um com o motivo. Buildar antes, porque um worktree
novo não tem `dist` e o harness serve o build. Resolver a superfície pelo catálogo, que já carrega
cada `view`/`fixture` com o frame natural e os apelidos. **Verificar dentro do iframe antes de
capturar** — medido em 2026-08-22, o marcador do documento de topo dizia "superfície certa" enquanto
o iframe ainda estava vazio, e a captura tirada nesse sinal era uma página em branco com cara de
resultado; uma checagem que valida o continente e não o conteúdo compra confiança falsa. E capturar
no frame que o catálogo declara, mais a segunda largura.

Ficou também a regra que faltava: um estado que só se alcança com clique se reporta como **não
julgado**. Nunca se automatiza um fluxo de clique para fabricar um screenshot, nem se julga o estado
alcançável fingindo que era o que importava.

### O relatório do reclaim diz o que fez — e o que não fez

A notícia dizia o total recuperado e nada mais. Agora lista o que foi removido por tipo, o que foi
movido para quarentena e de onde, e — o que mais faltava — **o que foi deixado de lado e por quê**.
Essa última parte é a diferença entre "não havia mais nada" e "havia, e não era meu para levar".

### O aviso de status respira quando aberto

O rodapé de aviso da sidebar reaproveitava, no estado expandido, o espaçamento apertado do estado
fechado — que é apertado de propósito, porque um aviso fechado custa exatamente uma linha. Aberto, a
primeira linha da mensagem ficava sentada sobre a borda. Só o estado aberto cresce; a altura fechada
está intacta.

## 0.93.35 — uma chave sem dono passa a dizer por quê, e um token só sai com prova

### A tela de Keys nomeia a situação em vez de apenas constatá-la

Quando o workspace de 2026-08-21 foi destruído e clonado de novo, as três chaves de provider
sobreviveram — corretamente, porque uma chave de máquina é machine-local por design. Mas os perfis
de agente que as declaravam morreram junto, e a tela passou a dizer *"No profile declares this key"*
três vezes: uma frase verdadeira que não nomeava a causa nem oferecia saída, sobre credenciais que
talvez fossem a razão daquele workspace existir. Pior: a única ação disponível era **Remove**,
escondida atrás do menu `⋯` — o que lê como "isto aqui é lixo".

Agora a tela distingue duas situações que eram uma. Quando **nada** naquele workspace declara chave
alguma, a chave aparece como **órfã**, com a explicação do mecanismo: chaves de máquina sobrevivem
ao workspace que as pediu, então um workspace recriado as deixa para trás. Quando outras chaves
*são* declaradas e só aquela não, o texto diz isso — é uma chave que você ainda não ligou, não uma
sobrevivente.

E as duas saídas reais agora estão no card: **Declare in an agent**, que abre o Agent Studio, onde
mora o perfil que declara a chave, e **Remove key**.

### Um token do Bridge só é removido quando algo prova que o workspace acabou

A coleta de tokens da 0.93.34 seguia a regra "remove a menos que se prove vivo". Só que a prova de
vida vem da proveniência, que é carimbada um workspace por vez — numa máquina real, 216 de 217
estados ainda não tinham nenhuma. Ligar a varredura automática sob essa regra teria apagado material
de autenticação de workspaces que estavam apenas não-carimbados.

A regra foi invertida para a mesma que o estado de engine já seguia: **desconhecido nunca é
coletado**; só a prova de morte — um estado que registra um workspace que sumiu ou foi substituído —
justifica remover. Com isso a varredura passou a rodar também no início do engine, o que antes não
acontecia. Hoje isso significa zero tokens removidos, e o número se corrige sozinho conforme cada
engine carimba o seu.

## 0.93.34 — o estado machine-local ganha dono, e o disco ganha coleta

Medido numa máquina em 2026-08-22: **cerca de 5 GB** de estado que o Tachyon guarda fora do
repositório e que nada jamais coletava. 1,8 GB em 362 builds do engine — `engineBundleStore` tinha
`stage`, `load` e `verify`, e nenhuma remoção. 1,7 GB em worktrees de workspaces que não existem
mais. E 217 diretórios de estado por workspace cujo dono era, literalmente, indeterminável.

### Um estado passa a saber a que workspace pertence

O diretório de estado é nomeado pelo hash do caminho do workspace — um digest de mão única — e nada
dentro dele registrava esse caminho. Não havia como perguntar "este estado ainda tem workspace?",
e por isso nada podia ser coletado com segurança: 35 MB carregando chaves de API, registros de
identidade e cabeças de autoridade, crescendo para sempre.

Agora o engine carimba, a cada início, **onde** serve e **qual** encarnação é aquela (a identidade
introduzida na 0.93.33). Com isso: caminho sumiu → workspace morto; caminho existe com id diferente
→ encarnação substituída; id igual → vivo, ninguém toca. Estado sem carimbo é reportado como
desconhecido e **nunca** coletado — um engine servindo workspace vivo carimba em um start, então o
que segue desconhecido é o que deixou de ser servido, e chutar aqui apagaria credenciais.

### Coletar é um plano que você lê antes

`Tachyon: Reclaim Disk` mostra quanto libera e, principalmente, **o que está poupando e por quê** —
worktrees com alterações não commitadas ou commits que ninguém levou, estado sem proveniência,
builds que um engine está executando agora. Só age depois da confirmação. O mesmo plano roda no
início do engine, ligado por padrão (`settings.reclaim`), reportando o que recuperou.

Duas regras dão forma a tudo: **nada que um engine vivo usa é candidato**, e **o que pode conter
trabalho que ninguém salvou é relatado, nunca coletado**.

### E nada é destruído

O estado de uma encarnação morta não é apagado: vai para uma quarentena com data, fora de qualquer
workspace. Ele guarda chaves de API — a decisão foi que nada é herdado em silêncio, não que algo
seja perdido.

## 0.93.33 — o engine para de servir um workspace que deixou de existir

Quando o workspace de 2026-08-21 foi apagado com o engine rodando, o `rm -rf` não conseguiu
terminar: abortou com *"Directory not empty"* porque o engine recriava `.tachyon/` debaixo dele —
são 154 pontos no código onde um store cria o próprio diretório sob demanda — e seguiu servindo um
projeto que não existia mais. Depois, um clone novo no mesmo caminho herdou em silêncio o estado
machine-local daquele engine.

Os dois efeitos vêm de um fato só: a identidade de um engine era `workspaceHash(path)`, um digest do
**caminho**. Destruir e recriar no mesmo lugar era, para o produto, indistinguível de continuidade.

### Um workspace agora tem identidade própria

`.tachyon/workspace.json` guarda um id escrito **uma vez**, na primeira vez que um engine serve
aquele workspace. É uma certidão de nascimento, não um lock: o caminho diz *onde*, o id diz *qual*.
Com ele, três situações que eram uma só passam a se distinguir — *ainda é o meu*, *sumiu*, *agora é
outro*.

### E o engine para, em vez de reconstruir

A verificação acontece no início do heartbeat que já existia, antes de qualquer coisa tocar o disco.
Quando o workspace some ou é substituído, o engine silencia seus timers e watchers, avisa o humano e
encerra — no daemon, saída limpa do processo. Não havia como conter isso por baixo: um heartbeat
sobre um workspace apagado não apenas falha, ele **reconstrói** o que a pessoa acabou de apagar.
Parar é a única reação que deixa um workspace apagado apagado.

Um marcador ilegível nunca dispara nada: soluço de filesystem não é projeto destruído.

Esta release entrega a metade da **detecção**. O que fazer com o estado machine-local quando um
caminho é reusado — as chaves de provider devem sobreviver, o registro de autoridade de uma
encarnação anterior provavelmente não — depende do inventário que está sendo levantado em separado.

## 0.93.32 — o produto para de dizer como se trabalha, e não inventa onde dizer

A 0.93.31 tirou os métodos de trabalho do primer e os pôs numa chave nova,
`settings.agentGuidance`. A chave era desnecessária: um agente **já** tem persistent instructions —
texto por agente, entregue no início de toda sessão, salvo como `instructions.md` no perfil e
editável no Agent Studio — e um agente Temporary recebe a mesma camada de quem o spawna. Para o
nível do projeto, `settings.projectGuidance` já existe desde a spec 383. Duas casas para dizer
"como se trabalha aqui", e a 0.93.31 abriu uma terceira.

Ela foi removida. Os métodos não mudaram de casa: saíram do produto. O brief de um agente agora
enuncia apenas fatos — onde a sessão roda, que um checkout compartilhado não autoriza nada, o que o
board tem para ele, que os dois registros podem se contradizer sem que nenhuma leitura resolva, o
que uma verificação atesta, que o doorbell existe. O que fazer diante de cada um desses fatos é
dito onde um projeto já dizia essas coisas.

O guarda acompanhou: em vez de provar que os defaults do produto eram sobrescrevíveis, ele agora
prova que **nenhuma linha entregue a um agente enuncia um método de trabalho**, carregando a lista
literal do que foi retirado para que não volte por outra porta.

Nota de upgrade: um `.tachyon/settings.yml` que tenha ganhado um bloco `agentGuidance` na 0.93.31
passa a ser reportado como chave desconhecida e é descartado — o resto do arquivo carrega
normalmente. Mova o texto para as persistent instructions do agente.

## 0.93.31 — o primer volta a ser fato: como você trabalha passa a ser do workspace

### O produto parou de impor um modelo de orquestração

Todo agente de todo projeto recebia, em todo spawn, um modelo de trabalho embutido: *espere uma
atribuição explícita*, *não adote trabalho varrendo o board, os pins ou a continuity de outro
agente*, *reporte um conflito ao seu spawner e não escolha*. Nada disso é um fato sobre o Tachyon —
é uma opinião sobre como se trabalha. E vinha dentro de um bloco que o próprio primer declarava
imune à guidance do projeto, então um workspace que roda modelo *pull* (workers que se servem da
fila, a forma mais comum de worker que existe) era contrariado pelo produto sem ter onde discordar.

O defeito já tinha sido medido uma vez: em 2026-08-05 o mantenedor deste repositório quis a política
oposta de continuity e não teve como dizê-lo, porque a frase que a carregava era imune. Aquela
correção separou duas frases e parou; dispatch, adoção e resolução de conflito continuaram
impostas.

Agora a fronteira é a regra. O bloco imune carrega **apenas fatos de mecanismo** — o que a wake line
faz com mais de 500 caracteres, o que sobrevive na continuity, que o texto de aprovação no pane não
é autoridade, o que o board e o brief *são*, o que uma verificação atesta. Os **métodos** viraram
configuração do workspace, em `.tachyon/settings.yml`:

Não há chave nova para isso: os métodos simplesmente **saíram do produto**. Onde eles vivem já
existia — as **persistent instructions** de cada agente (o `instructions.md` do perfil, editável no
Agent Studio, entregue no início de toda sessão; para um Temporary, a mesma camada vem de quem o
spawna) e o **`settings.projectGuidance`** do projeto (spec 383), composto no startup de todo
agente. Uma terceira casa para a mesma pergunta só produziria duas respostas divergindo.

### A linha de imunidade parou de blindar receita junto com fato

Onde antes se lia que a guidance do projeto *"cannot override either contract or protocol"*, hoje se
lê que os mecanismos são propriedades do Tachyon e que **como** você trabalha *não é do Tachyon
dizer* — vem das suas persistent instructions, do seu brief de spawn e dos documentos de guidance do
projeto. É a mesma fronteira, com a metade certa de cada lado.

### Uma promessa que era falsa foi corrigida

O primer afirmava que a continuity sobrevive a compaction, clear, restart e sessão nova — sem dizer
que é um arquivo do workspace e morre com ele. O incidente de 2026-08-21 desmentiu isso na prática.
A linha agora diz as duas coisas, e aponta para o backup (`stateBackup`, 0.93.29) como o que torna a
promessa verdadeira além desta máquina.

### A reincidência fica barrada por teste

O guarda que classificava cada linha imune do primer como fato de produto nunca tinha olhado o
`WORK ON RECORD` — que era exatamente onde o modelo de dispatch morava. Agora ambos passam pelo mesmo
crivo, e um invariante novo prova a propriedade inteira: **nenhuma linha entregue a um agente
enuncia um método de trabalho**, com a lista literal do que foi retirado para que não volte. Uma
linha nova é fato classificado, ou o teste quebra.

## 0.93.30 — tachyon.yml aposentado: configuração e declarações ganham casas próprias em .tachyon

### `.tachyon/settings.yml` — só configuração, e nada mais

O `tachyon.yml` era uma coisa e tinha virado outra. Nasceu como o arquivo do workspace; com o tempo
os agents migraram para `.tachyon/agents/<nome>/`, os terminais ganharam `.tachyon/terminals/<nome>.yml`,
e o que sobrou era um arquivo de configuração não trackeado que ainda carregava declarações no corpo.
Esta release completa o movimento:

- **Configuração** vive em `.tachyon/settings.yml`, cujo topo É o mapping de settings — sem wrapper
  `settings:`. O editor ganha schema dedicado para o arquivo.
- **Schedules** viram arquivos: `.tachyon/schedules/<nome>.yml`, o molde exato dos terminais — o
  mapping do arquivo é a declaração, o nome vive no filename. Aprovar uma proposta, salvar no Studio
  ou deletar da sidebar opera no arquivo, sempre com a validação completa do loader antes da escrita.
- **Terminais** completam a migração: o bloco legado `terminals:` deixa de ser lido; as declarações
  por arquivo, que já eram canônicas, são a única fonte.

### Migração automática — o upgrade não quebra ninguém

Na primeira carga após o upgrade, um `tachyon.yml` existente é projetado para as casas novas
(arquivo novo sempre vence o bloco legado), o original é preservado byte a byte em
`.tachyon/tachyon.yml.pre-migration`, e o arquivo da raiz é removido. Um legado imparsável fica no
lugar, com aviso alto — não se apaga o que não se conseguiu ler. `tachyon.yml.example` foi
aposentado junto: o `Tachyon: Init` agora gera `.tachyon/settings.yml` + terminais por arquivo, e o
schema no editor assume o papel de referência.

### Superfícies acompanham

`write_tachyon_config` (Bridge) valida e grava o texto do `settings.yml`; `Tachyon: Doctor`, a
sidebar, o onboarding e a tela de Settings apontam para a casa nova; o backup de estado
(`stateBackup`, 0.93.29) replica `settings.yml`, `terminals/` e `schedules/` — as declarações de
terminal faltavam no allowlist e entraram.

## 0.93.29 — o estado durável ganha réplica fora da máquina, e um caminho de volta

### Backup opt-in do runtime: `settings.stateBackup`

Um `rm -rf` no checkout levava junto tudo que o runtime tinha de insubstituível: o Board com suas
tasks e journals, os pins, a continuity dos agentes, o HANDOFF e o próprio `tachyon.yml` — que é
gitignored por design e portanto não tinha cópia em lugar nenhum. Aconteceu em 2026-08-21, com um
board de mais de quarenta tasks.

Agora o `tachyon.yml` aceita um bloco opt-in:

    settings:
      stateBackup:
        backend: filesystem     # qualquer path montado: NAS, SMB, segundo disco
        path: /mnt/nas/tachyon-bkp
        every: 10m              # default 10m
        keep: 30                # gerações mantidas no destino (default 30)

O estado local segue sendo o primário e o do runtime; o destino é uma réplica one-way, nunca uma
autoridade que o engine consulta. Sem o bloco, nada sai da máquina.

O que sai é um allowlist declarado como dado, nunca uma varredura de `.tachyon/`: um segredo só
chegaria ao destino sendo adicionado explicitamente à lista — o módulo do manifest recusa entradas
que alcancem `harness/`, `secrets/` ou qualquer `.credentials.json`, e o teste mede isso. Cada
passe grava uma geração inteira e autocontida com manifest e sha256 de cada arquivo; o ponteiro
`latest` só avança depois do manifest, então um backup rasgado nunca é o que um restore enxerga.
O conjunto durável mede kilobytes: sem dedup, sem incremental, de propósito.

O serviço lê a configuração ao vivo — declarar ou remover o bloco tem efeito sem reiniciar o
engine — e nada dele toca o caminho de escrita dos stores: um passe de backup apenas LÊ. Destino
fora do ar avisa uma vez e segue tentando.

### "Tachyon: Restore State Backup" — a superfície de desastre

O comando repovoa um checkout fresco a partir de um destino de backup: escolhe a pasta, escolhe a
geração (as mais novas primeiro), confirma com contagem e data, e restaura verificando o sha256 de
cada arquivo. Ele é deliberadamente autocontido — funciona sem engine rodando e sem `tachyon.yml`
presente, porque esse é exatamente o estado de um workspace destruído. Sobrescrever arquivos
existentes exige um segundo modal explícito.

Os backends `s3-compatible` e `gdrive` entram na mesma interface em release futura.

## 0.93.28 — os painéis do Lifecycle viram diálogo, e o produto para de explicar o que já se vê

### Rename, Forget e Clone deixam de empilhar no corpo da página

Os três botões do Lifecycle do Agent Studio revelavam um painel logo abaixo do formulário, no fluxo
normal da página. Nada impedia dois abertos ao mesmo tempo, e era o que acontecia: o painel de Rename
e o de Import, um sobre o outro, com o formulário rolado para fora de vista.

Agora abrem como diálogo sobre a tela. Um por vez, e isso vem do diálogo em vez de uma guarda nova.

A peça já existia e nunca tinha sido usada: o `KitDialog` está no design system desde o spec 342 e
seus únicos consumidores eram outro componente do kit e a tela de gate. Esta é a primeira vez em
produto, e ela vale para as outras telas que hoje empilham painel no corpo.

Um componente só serve as duas larguras: centrado no largo, ancorado embaixo em largura cheia abaixo
de 720 pixels. E o `useEffect` que focava o botão Cancel à mão saiu — o diálogo é dono do foco, e
duas autoridades sobre a mesma coisa é defeito, não redundância.

A confirmação digitada do Forget continua exigindo o nome do agente. Ela é o portão; o diálogo é
onde ele mora.

### O produto para de ensinar na tela o que a tela já mostra

A 0.93.27 escreveu o princípio no guia do projeto: **o leitor vai agir com este texto, aqui?** Esta
versão é ele sendo aplicado.

Quinze textos encolheram: oito frases-professor espalhadas por sete telas, três explicações do
modelo de consentimento em Plugins, e quatro parágrafos do Settings. Junto disso, o Settings passou a
dizer a divisão em vez de explicá-la, e a prosa sobre modelos saiu do onboarding.

O que fica é o que se lê e se usa. "Soltar não apaga nada" é lido e agido. "Um agente é um perfil
em `.tachyon/agents/`" é lido uma vez, lembrado nunca, e reexibido para sempre.

O `aria-label` do Activity ficou. Texto que só o leitor de tela recebe não disputa espaço com nada.

### O Runtime Config aponta para o lugar certo e ocupa a tela

Ele mandava o leitor para "Control", que não existe mais com esse nome. Agora diz Settings. E deixou
de ter largura máxima, como as telas irmãs.

### O command palette perde o último fóssil do nome antigo

A 0.93.27 renomeou a aba de Control para Apps e mediu 34 ocorrências. Duas ficaram de fora, e eram
as visíveis na paleta: `Tachyon: Control` e `Tachyon: Control (legacy alias)`.

A primeira virou `Tachyon: Apps`. A segunda saiu inteira — regra da casa é que caminho morto se
remove, não se mantém com `when: false`. Antes de remover, a busca no repositório inteiro por
consumidor real ou atalho voltou zero.

### O `kill_agent` relata o que mediu, não o que pretendia

Ele imprimia "worktree removida, branch apagada" sem olhar o disco. Quando a remoção falhava — um
processo segurando o diretório, uma branch com commit não mergeado — a mensagem de sucesso saía
igual.

Agora ele confere e diz o que encontrou, incluindo quando manteve a branch e por quê.

### Dispensar um agente diz quais cartões dele já pousaram

Quando um agente temporário sai, o Tachyon libera o cartão e o deixa `active` sem dono. No board isso
lê como trabalho pendente, mesmo quando a entrega está em `main` há horas.

O dismiss agora mede, por cartão, se a entrega é alcançável de `main`, e **oferece** fechar. Nunca
fecha sozinho: um agente dispensado no meio pode ter commit que nunca foi mergeado, e nesse caso o
cartão continua aberto, que é o certo.

A prova é a mesma que a reconciliação do board já usava — extraída para uma função e chamada dos dois
lugares, em vez de nascer uma segunda forma de provar a mesma coisa.

### Atualizar um plugin instalado por agente para de promovê-lo para o workspace

Um plugin pode ser instalado no harness privado de um agente em vez do workspace. O caminho de
atualização não sabia disso: ele replanejava sempre no workspace, então a primeira atualização movia
a instalação de lugar, sem aviso.

Agora a atualização escreve onde a instalação vive. E a recusa de escopo divergente reusa o
mecanismo que já existia — o fingerprint do preview já vinculava o destino.

### `.tachyon/` para de ser versionado

O `.gitignore` declarava o diretório ignorado desde sempre, e 64 arquivos continuavam no índice
dentro dele — gitignore não desrastreia o que já entrou. Eles saíram do repositório e ficaram no
disco; nada foi apagado e o histórico não foi reescrito.

Três exceções voltaram: dois relatórios e um arquivo `.c` que um teste compila e executa. Arquivo sob
teste é conteúdo do repositório, mesmo morando num diretório ignorado.

## 0.93.27 — o Design Mode sai da status bar, a aba Control vira Apps, e o launcher aprende a arrastar

### Design Mode deixa de morar na status bar do VS Code

Os dois ícones do Integrated Browser ocupavam a barra de status do editor — o lugar onde nenhuma
ferramenta parecida põe "modo de inspeção ligado". Chrome e Edge usam painel, Playwright abre janela
própria, Figma troca o modo na própria tela.

Agora Design Mode é um ladrilho no launcher, e clicar nele **faz**, não abre tela: com o Integrated
Browser desligado, leva ao Settings com o campo em destaque; ligado, arma o modo e abre o browser.
Fechar o browser desarma.

O estado que dá para observar — página atual e conexão do CDP — foi para o **System**, que é onde
estado de máquina já mora. Os comandos continuam na paleta.

### A aba Control agora se chama Apps

O nome era fóssil: Control era **um** app com seções antes de virar doze apps independentes. As abas
irmãs — Attentions, Agents, Terminals, Pipelines, Schedules, Pins — todas nomeiam o que listam. Essa
não nomeava.

E o ícone estava repetido: a aba e o ladrilho System desenhavam o mesmo glifo, na mesma tela. Agora a
aba usa `home`, que é o que aquele painel sempre foi — uma tela inicial de aplicativos.

### O launcher aprende a arrastar, e mostra onde vai encaixar

Arrastar um ladrilho agora abre o vão onde ele vai cair: os vizinhos deslocam ao vivo e a célula
arrastada vira o lugar vazio, com contorno tracejado. Antes o ícone flutuava sobre os outros e o
rótulo empilhava sobre o rótulo vizinho.

Soltar fora ou apertar Escape cancela sem gravar. E quem não usa mouse reordena por teclado —
Ctrl+X marca, Ctrl+V cola, com anúncio para leitor de tela.

O controle de ordenação também deixou de acender em azul: ele pinta igual ao da aba Agents, porque o
próprio desenho do ícone já diz a direção.

### A sidebar respira

A linha de tarefa parava de crescer num corredor fixo de 72 pixels, então o texto cortava mesmo com
a barra larga. Agora usa a largura que existe: medido, 502 para 704 pixels numa sidebar aberta.

E a barra de ações da linha de agente parou de cobrir o conteúdo. O botão de reticências fica
sempre visível, e o resto se revela da direita para a esquerda quando o ponteiro chega — ou quando o
teclado chega, que é o caminho que costuma ser esquecido.

### Companion ocupa a tela toda

Era o único app com largura máxima, e isso apareceu abrindo três abas em sequência. A restrição
tinha uma boa razão tipográfica, mas largura de leitura, se vale, vale para todos.

### Primeira fatia do Agent Heartbeat

O Tachyon passa a acordar o agente pai quando um filho fica ocioso, sem depender de o filho avisar —
o caso que importa é o filho que morre ou termina sem reportar.

É uma fatia deliberadamente pequena: um evento, nenhum botão de configuração. O que ela responde é
se acordar por evento produz trabalho que a notificação normal já não produzia. A resposta decide se
o resto do catálogo se justifica.

Um detalhe que parece pequeno e não é: nomes de agente temporário são reusados, então cada sessão
recebe um contador próprio. Sem isso, um despertar atrasado alcançaria a encarnação errada do mesmo
nome — justamente o que a entrega-uma-vez existe para impedir.

### Interface não é documentação, agora por escrito

Uma auditoria das 32 telas mediu ~18 casos de manual renderizado como interface. O princípio que ela
propôs entrou no guia do projeto, e o teste é uma pergunta: **o leitor vai agir com este texto, aqui?**

"Soltar não apaga nada" é lido e usado. "Um agente é um perfil em `.tachyon/agents/`" é lido uma vez,
lembrado nunca, e reexibido para sempre.

## 0.93.26 — o produto fala inglês, a interface para de documentar, e o board ganha busca

> Nota: o CHANGELOG estava parado na 0.93.11 e as versões 0.93.12 a 0.93.25 saíram sem entrada.
> O buraco foi fechado depois: as catorze entradas abaixo foram reconstruídas do histórico, a partir
> dos intervalos que os commits de release delimitam. Esta entrada cobre o que entrou depois da 0.93.25.

### O português sai do produto

O Tachyon carregava dois catálogos de tradução pt-BR — 875 linhas — e duas guardas para protegê-los.
Nada disso foi pedido: a tradução entrou em junho a partir de uma pergunta ("i18n? escolha de
idioma?") que virou escopo, e o idioma do projeto sempre foi inglês.

Os dois catálogos saíram, junto com um gate de pre-commit que existia completo e **nunca foi ligado a
hook nenhum**. A arquitetura de idioma fica: as chamadas `l10n.t()` continuam, o manifesto continua
apontando para `l10n/`, e os títulos de comando continuam no catálogo em inglês. Quando tradução
voltar, ela volta sem reconstruir nada.

Fica registrado no lugar onde quem retomar vai olhar: **304 strings do produto são invisíveis para
qualquer extração por regex**, porque passam por um apelido de `vscode.l10n.t`. As duas guardas que
diziam proteger a tradução usavam exatamente esse regex — e passavam verdes com 156 strings sem
traduzir. Uma guarda que passa prova que o filtro dela não achou nada.

### O launcher do Control ordena A–Z

A aba Control ganhou o mesmo controle de ordenação que a aba Agents já tinha, com a mesma
persistência. A ordem de produto continua sendo o padrão: sem preferência salva, os ladrilhos ficam
onde as decisões de posição os colocaram — alfabético é opção, nunca default.

### O onboarding é a única porta, e o walkthrough do editor sai

O passo a passo nativo do VS Code foi removido. Ele renderizava na tela de boas-vindas do editor, com
o vocabulário do editor, e estava mentindo em três pontos: mandava instalar tmux por Homebrew num
sistema que o README declara sem suporte, prometia abrir sozinho numa instalação nova sem código que
fizesse isso, e não citava o Agent Studio, que é onde agente nasce.

O app de Onboarding, que entrou nesta mesma leva, é a porta agora.

### O Companion e o Agent Studio

O Companion tinha dois cabeçalhos e um ícone sem relação com a função. Agora tem um cabeçalho, e o
ícone diz o que ele faz.

No Agent Studio, o botão Save do formulário de novo agente ficava cinza sem dizer por quê — e, pior,
acendia quando você desligava a worktree, num agente ainda sem nome. Agora o formulário nomeia o que
falta, e o Save mora no último passo do fluxo, não no cabeçalho.

O Settings perdeu 173 linhas comentadas que sobraram quando o Companion virou app próprio, e uma
frase que mandava o usuário para uma tela que não existe mais.

### Busca no board

Responder "já existe cartão sobre X?" custava ler mil cartões e ainda terminar sem certeza. Uma
exploração real gastou 316 mil tokens para chegar a "provavelmente não" — e a resposta certa existia.

Agora há uma ferramenta de busca textual sobre os 1.674 cartões. Ela parte do zero a cada consulta,
em 136 ms, e devolve o trecho que casou junto com o cartão — a razão, sem abrir o cartão. Não há
índice guardado em disco: um índice que se reconstrói em 136 ms nunca está desatualizado.

### Consertos de desenvolvimento

O smoke do extension host abria uma janela real do VS Code na tela de quem estivesse trabalhando. A
proteção existia, mas morava no chamador: quem rodasse o comando direto ganhava a janela. Agora o
próprio script sobe headless.

E a sonda que investiga travamentos do extension host olhava três portas de I/O enquanto o host usa
dez. Agora olha as dez, ao custo medido de 0,85 ms por ativação — e o número está escrito no código,
onde o próximo vai procurar.

## 0.93.25 — Onboarding e Companion viram aplicativos próprios

### O onboarding é um app em aba de editor

Checar se o ambiente está pronto morava num comentário dentro do `tachyon.yml`. Agora é um aplicativo
próprio: quando o ambiente não está pronto, a sidebar diz isso e o botão abre o app. Ele apresenta a
ferramenta, conduz o bootstrap pela mesma porta `tachyon.init` e lista o que falta — tmux, Node, CLI
de agente e credencial — cada linha com estado e com remédio.

### O Companion sai do Settings

O Companion cresceu dentro do Settings até ocupar quase a tela inteira. Agora é um app standalone,
com painel, superfície e bundle próprios, e o Settings volta a ser Settings.

### E o que sobrou da ronda

Os ícones de badge alinham com os rótulos das pílulas ao lado. O estado do Integrated Browser deixa
de viajar dentro do status do Companion. Saem também os fallbacks posicionais dos scripts de hook
gerados — configuração é nomeada ou não existe — e strings de Control que nada alcançava.

## 0.93.24 — subagentes nativos ficam de fora da trava de plano, e o grok nasce dono da própria sessão

### O gate de checklist para de cobrar plano de quem a sessão do pai já cobre

A trava que recusa a primeira mudança sem plano alcançava também os subagentes nativos — os que um
agente pai abre dentro do próprio turno. A trava passa a valer só para a sessão que abre o turno,
não para os filhos que ela própria abre.

### Toda sessão grok ganha linha no ledger desde o nascimento

O hook de SessionStart gerado para o grok usava o vocabulário de matcher do Claude
(`startup|resume|clear|compact`) — medido num turno real, o grok nunca disparava assim, e a sessão
nascia sem dono registrado. Sem matcher ele emite `session_start` normalmente. Agora toda sessão
grok entra no ledger de donos na hora em que nasce, com transcript derivado.

### O aviso de folga só afirma reset que já ocorreu

O aviso citava o `resetsAt` que o canal nomeia como corroboração de que a cota resetou — mesmo
lendo antes da hora. Agora afirma reset só quando a leitura é posterior a ele; antes disso, reporta
a mudança observada em vez da prevista.

### O Dev Host para de atravessar checkout

`point` recusa link de dependência que aponte para outro checkout — o tipo de contaminação que só
aparecia como gate verde provando a árvore errada. E `point-clear` colhe o servidor tmux privado
que o cenário deixou para trás.

## 0.93.23 — o Agent Studio conduz a criação em passos, e a conta de outro provedor nunca chega ao agente

### Criar agente viram três passos; editar viram abas

O formulário de criação é um wizard de três passos — Runtime, Workspace, Advanced — numa faixa
numerada: passo pronto clica, futuro só pelo Next. Editar perfil vira abas — General, Runtime,
Environment, Tooling, Lifecycle — e o resultado de uma ação aparece acima da faixa, visível de
qualquer aba. Nada muda no engine nem no protocolo.

### As linhas respondem pelo nome

Toda linha do Studio pode ser destruída, e o erro aponta o campo dela. A linha mantém o foco entre
ações, a recusa cita qual linha foi, e as colunas têm rótulo.

### A medição da conta errada deixa de ser oferecida como sua

Um agente perguntando por capacidade podia receber a leitura da conta de um provedor que não é o
dele. Agora recebe a declaração de que aquela conta não foi medida para o provedor dele — número
verdadeiro da conta errada é pior que ausência declarada.

### E o resto

Spawn temporário aceita reasoning effort explícito, projetado pela mesma guarda dos perfis
declarados e persistido no session record. O app Keys adota a largura e a densidade dos apps
vizinhos. E o smoke do extension host entra no verify gate: a classe de defeito que só aparece com
o host rodando deixou de depender de alguém lembrar de rodar.

## 0.93.22 — o plano concluído continua na tela, e o ambiente do agente vira configuração

### Um checklist terminado deixa de desaparecer

Quando o último item fechava, a linha `(n/n)` sumia da sidebar, e um plano concluído ficava
indistinguível de um que nunca foi registrado. Agora o plano concluído continua visível como `(n/n)`.

### Ambiente e segredos entram no perfil

O Agent Studio ganha edição de Environment, e agentes temporários aceitam ambiente próprio: valores
literais e referências a segredo do vault. A referência persiste; o valor resolvido, nunca.

### E o Keys assenta

A composição da página alinha com os apps vizinhos.

## 0.93.21 — o app Keys ganha porta

A Keys tinha entrado na versão anterior completa — bundle, painel, até a função que abre a aba — e
sem nada que pudesse chamá-la: nenhum ladrilho no launcher, nenhum comando. Agora o launcher tem o
ladrilho, com o ícone da aba.

## 0.93.20 — as chaves da máquina saem do Agent Studio e viram app

### Keys é um app próprio

Guardar credencial de máquina deixa de ser uma seção do Studio. O app mostra o que está guardado por
provider e o que foi declarado e falta, diz quem usa cada chave, troca valor — nunca exibe — e remove
mostrando antes quem depende dela.

### Os hooks do codex param de citar um placeholder

Os scripts de hook gerados recebiam `$TACHYON_AGENT_NAME` literal no lugar do nome, e o evento saía
atribuído ao placeholder. Resolvem agora pelo ambiente do processo.

## 0.93.19 — conserta a 0.93.18, que não subia

### Um arquivo observado como diretório derrubava o arranque

O conserto do digest de perfil fez as referências declaradas pelo perfil dirigirem os observadores de
arquivo — pedido certo: sem ele, corrigir o documento não limpava o alerta. Mas `instructions.md` é um
**arquivo**, e o observador chamava `readdirSync` nele. Todo perfil com `prompt.instructions`
derrubava o arranque do engine, o socket de controle nunca nascia, e o supervisor restaurava o engine
anterior — o rollback fez o trabalho dele, e o workspace não ficou sem engine.

Duas camadas entraram. A causa: referência de arquivo é observada como arquivo; diretório continua
varrido. O desenho: erro transitório de sistema de arquivos — ENOENT, ENOTDIR, EACCES, EPERM, ELOOP —
passa a ser reportado em vez de fatal. Um auxílio de observação que quebra o motor está errado por
desenho. E o teste que faltava coube: o daemon **empacotado** sobe contra um perfil real em disco e
cria o socket.

## 0.93.18 — o cofre de chaves mora no Agent Studio, e o schema para de oferecer o que o parser recusa

### Credencial de máquina: guardar, trocar, remover — e nada mais

A porta é a webview nossa, no Agent Studio, e migra com o produto. O comando `tachyon.setProfileSecret`
saiu — paleta de comandos é porta do editor. E nada de segredo no Bridge, que é o canal dos agentes:
expor lá seria o agente gravando credencial, o oposto da razão de o cofre existir.

A tela diz em voz alta o que costuma ficar implícito: o valor é aceito uma vez e nunca mostrado de
volta; o armazenamento é `secrets.json` com permissão restrita e **não** é keychain; editar é
substituir, operação própria que não lê o valor antigo; remover mostra quem depende antes. E o schema
das mensagens da webview **recusa payload que contenha valor de segredo** — não é "hoje não vaza", é
não haver como vazar por essa porta.

### O schema confirmava campos que o leitor joga fora

A remoção anterior do bloco `agents:` tinha renomeado a chave para `x-removed-agents` em vez de
apagá-la — e o prefixo `x-` não esconde nada do JSON Schema. Pior: `terminals` reusava o `$ref` dela,
então o editor confirmava `worktree`, `branch`, `baseRef` e `harness` dentro de um terminal, campos
que o leitor joga fora. Terminais agora têm forma própria: sete campos, menos 264 linhas de schema.
E um guarda novo afirma que as propriedades de topo são exatamente as que o parser conhece — pega a
família do defeito, não só este caso.

### O caminho legado sai de vez

Perfis vivem em `.tachyon/agents/<nome>/agent.yml`. O parser e o schema param de conhecer o bloco
`agents:` do `tachyon.yml` — a superfície morta que o autocomplete do editor recomendava.

### A entrega de notices para de despejar argv

Cinco argumentos posicionais viravam três linhas de ruído antes da mensagem. Agora é um JSON só, nos
sete hooks materializados.

## 0.93.17 — a terceira porta que cortava turno, e o ledger que não via grok

### O rebind do engine consultava a guarda tarde demais

Fechadas as portas humana e de agente, faltava o rebind do engine — e nele a guarda parecia não
funcionar porque ele **parava** o sobrevivente antes de chamar resume(): a guarda de processo vivo
não tinha mais processo para ver. Estava certa e era inalcançável. Agora é consultada no momento
destrutivo, com a isenção do self-restart por identidade e sem flag de força.

### O ledger de sessão tinha 317 linhas e zero grok

O hook disparava; o registrador rejeitava — claude e codex mandam snake_case, o grok manda camelCase.
Agora normaliza os dois, deriva o transcript do GROK_HOME e **diz** quando um runtime não é coberto:
ausência de instrumento deixa de se parecer com ausência de fato.

### Documento de perfil que divergiu continua reparável

Um instructions pinado podia travar a única porta de reparo que o produto nomeia. Divergiu? Continua
reparável.

### Sessões de tool carregam o dono

As sessões de tool nascem carimbadas com a identidade do agente e fecham no teardown dele.

## 0.93.16 — a worktree do agente, do nascimento ao descarte

### O agente escolhe de onde a worktree parte

Como o change já podia. Sem origem declarada, segue o HEAD do primário. E re-ramificar em restart é
impossível por construção: o baseRef só chega ao ensure quando não há registro anterior, então todo
caminho de reuso o ignora.

### A worktree aparece na lista enquanto nasce

Antes a linha só existia depois do `git worktree add` retornar, e um agente despachado com worktree
ficava invisível entre o spawn e o primeiro frame. Agora aparece com fase e com erro. É estado de
sessão: um reload no meio derruba a linha — exatamente o comportamento de hoje para o resto.

### Ref inválida avisa e cai no HEAD

Criar change com ref de origem inválida bloqueava. Agora avisa e cai no HEAD, com a mesma frase que
o agente usa. Nome de branch inválido continua recusando — esse não tem default óbvio.

### Remover olha quem está dentro antes de apagar

Dezenove processos achados com cwd em worktrees que não existiam mais, alguns vivos havia mais de
dez horas — a remoção simplesmente não olhava. Agora olha, nomeia, e oferece saída que não mata
ninguém. Plataforma sem `/proc` segue e declara que não mediu, em vez de virar pedágio permanente
no macOS e no Windows.

## 0.93.15 — uma noite de instrumento, não de feature

### A cor de erro do kit para de divergir dela mesma

O `--destructive` apontava para `--vscode-errorForeground` e caía num hex quando o tema não definia
esse token: duas cores de erro diferentes na mesma tela. Agora deriva de `--ds-err`, e o foreground
do `--ds-on-err` que já existia.

### A sonda de I/O síncrono para de acusar a si mesma

Três capturas do travamento do extension host nomeavam `/proc/self/schedstat` — o próprio detector
de lag calculando. A exclusão é por origem, não por caminho, então sobrevive ao bundling. Isso não
conserta o travamento; conserta o instrumento que vai procurá-lo.

### Erros que dividiam uma frase

O erro do runtime-status-publish passou a dizer qual das duas causas ocorreu, com status, statusText
e corpo bruto — medido no caminho, 92 de 92 falhas acontecem quando o agente está sendo morto e o
bearer já revogado, inofensivas que ninguém sabia serem inofensivas. E a frase de recusa do gate de
checklist prometia que leitura sempre passa e que só a primeira mudança bloqueia; as duas eram
falsas, medidas na própria sessão do dono. Agora ela diz o que o mecanismo faz. O mecanismo não mudou.

## 0.93.14 — quatro ajustes apontados usando a versão por um dia

### Uma segunda fonte monoespaçada

A Departure Mono entra como opção, em `~/.tachyon/settings.json` sob `font.mono`; Tachyon Mono segue
no default. São 22.496 bytes de face contra os 375.048 dos quatro pesos que já embarcavam, licença
SIL OFL 1.1 — a mesma — com o OFL.txt acompanhando os arquivos como ela exige.

### E três atritos de tela

A busca do Board para de mudar de largura ao digitar: o botão de limpar era montado condicionalmente
e a caixa crescia com ele; a pegada do estado cheio fica reservada. A lista de arquivos do review
vira redimensionável, com a largura de hoje como padrão — caminhos longos deixam de truncar e os
arquivos de uma mesma pasta voltam a se distinguir. E a última string em português do review foi
traduzida; ela sobrevivera à varredura por viver no ramo que só aparece com zero agentes.

## 0.93.13 — o review aprende com o dono olhando, e o notice sobrevive ao engine

### Na tela do review

A régua de anotação deixa de ser um segundo sinal de mais: numa linha adicionada lia-se "+ +", o
símbolo querendo dizer "anotar" onde significava "adicionado". Virou ícone de comentário. O corpo
sanga até as bordas, o header mantém o recuo, e as strings saem do português — era a última
superfície assim no produto.

### O notice deixa de morrer com o engine

A fila era só memória. Agora reconstitui do witness durável, e o fim de turno drena o que ficou: um
Stop hook põe a primeira linha no contexto do modelo nos três runtimes com canal por-spawn, medidos
vivos, e o cursor avança antes do emit para o grok — que invoca três vezes — não redeliverar. Controle
negativo: o primeiro boot sobre uma trilha de 3.283 linhas não reproduz nada.

### O rodapé da sidebar ganha como dispensar

Sem temporizador — a barra antiga apagava o aviso sozinha em 8 segundos, e foi por isso que o rodapé
existe.

### E o que só o uso mostrou

A aprovação de schedule exigia do proponente um grant que autoriza outro objeto: a decisão humana
ficava bloqueada por uma condição sobre outra coisa. Formulário aposentado volta a ser recusado como
domínio, não como transporte. E a busca do Board volta à geometria de controle do design system —
usava token de espaçamento onde o vizinho usa token de controle, e por isso não alinhava.

## 0.93.12 — o review ganha tela própria no Tachyon, cobrar plano vira trava, e o pacote para de levar desenvolvimento

### O review acontece numa aba do Tachyon

Até aqui o review morria nos comentários do VS Code. Agora é uma aba nossa: lista de arquivos, um
arquivo materializado por vez, régua com nota ancorada por snapshot, realce que **avisa** quando
degrada acima de 20 mil caracteres. O engine ganha hunks linha a linha. O painel Comments do editor
saiu do produto, com o CommentController junto — e a aba foi provada abrindo num Extension
Development Host real.

### Cobrar checklist passa a bloquear de verdade

`settings.checklist.requireIn` prometia exigir plano e não alcançava ninguém: o único consumidor
precisava de linha em persistence-stop.jsonl, que só agente **declarado** escreve — 1.461 linhas,
zero temporárias. Campo de configuração declarando capacidade que o sistema não tinha. Agora é um
PreToolUse injetado no canal por-spawn de cada runtime — `--settings`, `-c hooks.<Event>=`,
`$GROK_HOME/hooks/` — que recusa a primeira ferramenta que muta até a sessão ter plano no ledger do
próprio runtime. Fail open onde ler falha, recusa medida viva nos três, e a frase nomeia a ferramenta
de plano do runtime em uma linha.

### Um agente em pleno turno deixa de ter o processo trocado

resume e restart matavam e relançavam o processo em pleno turno; cinco agentes perderam trabalho em
voo assim em dois dias. A guarda consulta o processo vivo e admite uma única substituição — o
self-restart, por identidade.

### A sidebar mostra onde o agente está

O passo do checklist ganha posição e total — "(3/9)" — na linha do agente. O estado atual vira um
rodapé fixo na sidebar, projetado como estado de engine. Notices de shell sem ação são projetadas em
vez de descartadas, e o marcador de modelo para de acusar divergência onde nunca houve declaração de
`--model`.

### O pacote para de levar desenvolvimento

489.887 bytes de artefato de desenvolvimento saem do VSIX: sourcemap do companion, testes do
node-pty, devDependencies do manifesto, fixture da section-app e dois shells órfãos que embarcavam
sem fonte nem entry. Sai o Pipeline Studio inteiro — 1.957 linhas — com o seed de demonstração que
punha "Add a dark-mode toggle to Settings" dentro do daemon de quem instala. A política de
dimensionamento do vitest deixa de rodar no produto. Sete leituras de variável de ambiente de
desenvolvimento somem — uma delas fazia o produto instalado gravar config nativa de runtime no
caminho apontado por env var. E quinze comandos internos `tachyon._*` migram para um bundle irmão
que só carrega sob `TACHYON_TEST_SEAMS=1`.

A auditoria que encontrou tudo isso verificou cada achado contra os bytes do VSIX empacotado, não
contra o fonte.

## 0.93.11 — dois consertos no que a versão anterior acabou de entregar

### Review Changes deixa de mostrar a história inteira do projeto

Ao abrir o review de um agente de longa duração, a lista vinha com milhares de arquivos — quase tudo
mudança antiga do projeto, não trabalho daquele agente.

A causa: cada worktree guarda a referência contra a qual comparar, gravada no dia em que ela nasceu.
Para um agente temporário isso é sempre recente. Para um agente que vive há semanas, a referência
envelhece junto com ele, e o review passa a comparar contra um ponto do passado distante.

Agora as duas portas do review — a do agente e a de integrar o trabalho — resolvem essa referência do
mesmo jeito: preferem o branch principal, e só caem na referência de nascimento se não houver.

O que **não** mudou é o que cada uma responde. A porta de integrar continua mostrando os commits que
seriam introduzidos; a do agente continua mostrando a árvore de trabalho, inclusive o que ainda não
foi commitado. A tela também passa a **dizer** contra qual referência está comparando, em vez de você
ter que deduzir.

### O botão Enable CLI do grok volta a funcionar

O grok apareceu no painel de capacidade na versão passada, mas o botão que liga a observação não fazia
nada — sem erro, sem mensagem.

A lista de provedores aceitos estava escrita em três lugares e só dois foram atualizados. Agora existe
**uma** lista, e todos os pontos que precisam dela a consultam. Um provedor novo passa a funcionar em
todos os caminhos ou quebra o teste — não some em silêncio num botão.

## 0.93.10 — comentar uma linha do diff e mandar o lote para o agente

### O review deixa de morrer no chat

Até aqui, apontar um problema no trabalho de um agente era conversa: você via a linha, dizia no chat,
e alguém transformava aquilo em instrução. Funcionava e não deixava rastro — depois que a conversa
passava, o apontamento não existia em lugar nenhum.

Agora o diff que o Tachyon já abria aceita **comentário na linha**. Você passa o mouse na régua, um
`+` aparece, você escreve. As anotações se juntam, e um comando manda **todas de uma vez** para o
agente que você escolher naquela worktree — um prompt só, cada nota citando arquivo e linha.

O lote em bloco é de propósito. Mandar uma nota por vez faz o agente oscilar entre correções; junto,
ele pensa uma vez e revisa uma vez.

Nenhuma tela nova foi criada. O `+`, as bolhas e o painel Comments são do próprio editor.

### A anotação sobrevive ao agente mexer no arquivo

É a parte difícil, e é a que decide se a funcionalidade serve para alguma coisa.

Quando o agente altera o arquivo, a anotação **acompanha a linha** se o deslocamento for mecânico. Se
a linha foi apagada, ou se o trecho passou a existir em mais de um lugar, ela aparece marcada como
**desatualizada**, guardando o texto e a última posição conhecida.

O que ela nunca faz é flutuar em silêncio para uma linha qualquer. Medimos os diffs reais deste
projeto e nenhuma quantidade de contexto elimina a ambiguidade — repetição estrutural em JSON e
boilerplate garantem isso. Então o mecanismo prefere dizer "não sei" a fingir que sabe.

### Review Changes sai do esconderijo

O comando que abre o diff de uma worktree existia e não tinha porta: não aparecia na paleta de
comandos. Agora aparece.

### O grok entra no painel de capacidade

O bloco **Provider capacity** mostrava Codex e Claude e ignorava o grok. Agora mostra os três, com
percentual usado, data de reset e o plano.

O número vem do próprio canal de cobrança do CLI do grok, sem gastar uma chamada de modelo — não é
estimativa nem cálculo em cima do nome do plano.

### E um agente que perdia o Bridge em silêncio

Um agente Codex podia voltar de um reload sem o canal do Tachyon, porque a configuração privada dele
era sobrescrita. Ele morria com uma mensagem de erro de arquivo que não dizia nada sobre a causa.

Agora a configuração é preservada, e quando o canal se perde mesmo assim, o Tachyon **diz que foi
isso** em vez de vazar o erro cru.

## 0.93.9 — dois avisos que ninguém usava saem do cartão do agente

### O cartão perde `done` e `continuity stale`

Duas etiquetas somem da barra lateral, e as duas somem pelo mesmo motivo: nenhuma levava a uma ação.

O **`done`** dizia "o turno terminou e você ainda não focou este agente". Ele media **clique de foco**
e apresentava isso como atenção — no cartão do agente com quem você está conversando, "não visto" era
tecnicamente verdade e factualmente falso. Um agente ocioso agora mostra `idle`, e só.

O **`continuity stale`** avisava que o resumo de um agente estava atrás da atividade recente. Só que
quem pode resolver isso é o agente, não você. Um alerta sem ação disponível para quem o lê não é
informação — é ruído.

### A memória por agente deixa de ter máquina em volta

O resumo de continuidade continua existindo como um arquivo Markdown por agente, e as ferramentas de
ler e escrever continuam as mesmas. O que saiu foi tudo o que orbitava esse arquivo: o cálculo de
defasagem, o lembrete automático, os arquivos de estado paralelos e o coletor de órfãos.

A medição que decidiu: em toda a vida do projeto, o lembrete automático disparou **uma vez**. Dezenove
agentes tinham arquivo de estado, dez deles órfãos — apesar de existir um coletor justamente para
isso.

Duas mil linhas a menos, e o dado que importava ficou.

### Agente temporário não é mais convidado a escrever resumo

Um agente criado para uma tarefa é dispensado quando ela termina. Ele não tem um "eu futuro" para
quem escrever. Mesmo assim, todos escreviam — e cada resumo virava lixo.

Agora só agente declarado no projeto recebe esse pedido. Foi daí que vinham os órfãos.

### E o que ainda não aparece

Boa parte desta versão é fundação para uma funcionalidade que ainda não tem tela: **anotar uma linha
do diff e mandar o lote para o agente**. O motor que mantém a anotação apontando para o lugar certo
depois que o arquivo muda já está no produto, com os testes. A interface vem depois.

## 0.93.8 — o cartão do agente deixa de ser configurável

### O layout do cartão sai da configuração e volta a ser produto

O cartão do agente na barra lateral tinha layout configurável: um template com regiões, versão e
componentes, que o projeto podia declarar em `settings.sidebar.cardTemplate` e cada pessoa podia
sobrescrever no arquivo pessoal. Isso saiu inteiro.

**O cartão não muda de aparência.** Ele continua exatamente o que era — o que desapareceu é a
possibilidade de reconfigurá-lo. Nenhum controle novo aparece na tela; o bloco de edição de template
some das Configurações.

Se um projeto tiver `settings.sidebar` no `tachyon.yml`, a chave passa a ser desconhecida: o Tachyon
**avisa e segue**, como faz com qualquer chave que não reconhece. Nada é bloqueado e nada precisa ser
migrado antes de atualizar.

Junto com a configuração saíram quatro mil linhas de código que existiam só para sustentá-la — parser,
editor, sincronização entre projeto e pessoa, e as telas de prévia.

### E o que só os agentes veem

As descrições das ferramentas da Bridge citavam números de especificação e identificadores de tarefa —
"(spec 351)", "spec 493", "t-bec361" — em texto que o agente lê a cada listagem. O agente não tem como
abrir nem a especificação nem a tarefa, então a referência ocupava lugar sem informar nada. Quarenta
dessas menções saíram. Os comentários no código ficam: lá a referência é útil, porque quem lê pode
abrir o arquivo.

## 0.93.7 — as telas param de discordar entre si

### O espaçamento e o tamanho de texto agora são os mesmos em toda parte

A queixa que abriu esta trilha foi que **as telas pareciam diferentes umas das outras**. Nesta versão
as últimas quatro superfícies entraram na mesma escala: Plugins, o painel do agente, a barra lateral e
o quadro.

Elas não mudam de aparência — mudam de **origem**. Cada distância e cada tamanho de texto agora vêm da
escala herdada do editor, em vez de valores escolhidos tela a tela. Quando a Microsoft mudar a
densidade do VS Code, o Tachyon acompanha.

Um detalhe que vale a pena: onde a medida era **geometria** e não ritmo — a coluna de nome da barra
lateral, por exemplo — o número deixou de ser fixo e passou a ser **calculado** a partir das peças que
o formam. Se o ponto de estado mudar de tamanho, a coluna acompanha sozinha.

### Plugin com mais de uma tela deixa de mostrar só a primeira

Um plugin pode oferecer várias telas. Até aqui o Tachyon abria sempre a primeira e ignorava o resto:
não havia como escolher, a barra lateral mostrava só uma, e o cartão do plugin não tinha botão de
abrir.

Agora o cartão tem **Abrir**, com escolha quando há mais de uma tela e abertura direta quando há uma
só. A barra lateral ganha abas. Plugin de tela única continua igual.

### E a limpeza que você não vê

Rodar os testes não cria mais pasta na raiz do projeto. Um teste escrevia capturas de tela ali a cada
execução, e nenhuma verificação lia essas imagens.

## 0.93.6 — um engine travado deixa de ser um beco sem saída

### O Tachyon agora derruba o próprio morto

Na versão passada, um engine que travou no boot deixava a extensão sem saída. A mensagem dizia que
havia um endpoint de controle não verificável e que o Tachyon se recusava a subir um duplicado — o
que estava certo, e mesmo assim não levava a lugar nenhum.

O motivo é que o engine **não é filho da extensão**: é um serviço do sistema. Matar o processo não
adiantava, o serviço subia outro em segundos. Recarregar a janela também não, porque trocar de engine
exige verificar o atual — e o atual era justamente o que nunca respondia. **Travado é insubstituível
porque travou.** A saída era um comando no terminal.

Agora, quando o endpoint fica mudo até o fim do prazo **e** o serviço é comprovadamente o deste
projeto, o Tachyon derruba e sobe outro sozinho. Quando não dá para comprovar, ele continua recusando
— mas a mensagem **passa a oferecer o comando** em vez de terminar ali.

O prazo de espera não mudou. Um engine que estava só lento e responde antes do fim continua sendo
aceito, nunca derrubado. Um engine que não é deste projeto continua intocado.

Toda substituição fica registrada. Se o Tachyon derrubou um engine, isso não acontece em silêncio.

### O Dev Host não sobe mais do branch principal

O Dev Host cria agentes de verdade, e o espaço de teste dele não era um repositório próprio — então
esses agentes criavam ramos e cópias de trabalho **dentro do repositório do produto**.

O espaço de teste agora é isolado de verdade, e o Dev Host recusa subir a partir do branch principal:
ele roda de uma cópia de trabalho, para o branch de release ficar sendo só isso.

### Rodar os testes não suja mais o projeto

Um teste escrevia capturas de tela na raiz do projeto a cada execução. Nenhuma verificação lia essas
imagens, e as mesmas já ficavam no registro de evidências. O teste continua provando o que provava; o
arquivo solto saiu.

### E uma falha que só aparecia na máquina dos outros

Um teste criava um diretório sem definir a permissão, então funcionava para quem tinha uma
configuração restritiva e falhava para todo mundo com a configuração padrão — impedindo o envio de
código. O tipo de falha pior de achar: quem pode consertar nunca a vê.

## 0.93.5 — o engine volta a subir: cobrar checklist não pode custar o transcript inteiro

### O que acontecia

Depois da 0.93.4, a barra lateral podia parar aqui:

> Tachyon could not start for tachyon: Tachyon found an engine control endpoint but could not verify
> it; refusing to start a duplicate.

A recusa estava certa — havia um endpoint de controle e ninguém respondia atrás dele. O engine não
tinha caído: subia, e travava com o event loop 100% preso, antes de conseguir responder ao primeiro
health.

### Por quê

O mecanismo de checklist da 0.93.4 decide o veredito quando um turno termina, e para isso abre o
transcript do agente. Duas escolhas se multiplicaram:

- a memória de "quais fins de turno eu já vi" só existia em RAM, então **todo boot reprocessava o
  ledger inteiro** — no workspace deste repositório, 1469 fins de turno, meses de histórico;
- e cada um deles **lia e parseava o transcript inteiro** — 335 MB aqui.

1469 × 335 MB, em leitura síncrona, antes de atender qualquer um. Quanto mais tempo o Tachyon tinha
sido usado, mais longa a trava.

### O que mudou

O que já está em disco quando o engine sobe é **histórico, não gatilho**: só um fim de turno novo
pede um veredito. E o leitor passou a ler **a janela do último turno** — teto de 4096 registros ou
2 MB — em vez do arquivo inteiro: é a única parte que o juiz já usava, o resto era desperdício.

Junto veio um detalhe da mesma ética da 0.93.4: quando a janela não alcança o começo do turno, o
veredito é **pendente**, nunca "ausente". Acusar um agente porque não lemos longe o bastante seria
pior do que não cobrar.

## 0.93.4 — o Tachyon sabe quando um agente terminou sem checklist, e pode cobrar

### O agente escreve uma lista de passos. Agora o Tachyon lê

Claude, Codex e Grok mantêm um checklist interno enquanto trabalham. Até aqui isso ficava dentro do
terminal de cada um: para ver, você abria o painel daquele agente.

Agora **o passo atual de cada agente aparece na carta da barra lateral**. Quatro agentes rodando, quatro
passos visíveis de relance, sem trocar de painel.

### E pode exigir que ele exista

Você declara em quais tipos de task um checklist é obrigatório:

```yaml
settings:
  checklist:
    requireIn: [feature, architecture]
```

Quando um turno termina sem checklist numa task desse tipo, o Tachyon **lembra o agente uma vez**. Se
ele ignorar, o Tachyon desiste, registra e avisa você.

**A entrega nunca é bloqueada.** É lembrete, não recusa.

O tipo da task é texto livre — o Tachyon não impõe uma lista fechada. `'*'` vale para todos, `'!tipo'`
exclui, e a exclusão sempre ganha. Configuração inválida avisa e é ignorada; o produto segue.

### Por que isso não existe em nenhum concorrente

Doze produtos de código aberto foram lidos no código antes desta versão. **Todos os doze mostram o
checklist. Nenhum exige.**

A razão fica clara ao construir: para cobrar é preciso saber que o checklist **não** vai chegar — e
silêncio não é ausência. Um agente rodou sete minutos sem escrever nada e depois escreveu.

Por isso o Tachyon só decide **depois que o turno termina**, e nunca durante. E quando o runtime não
tinha como escrever checklist naquela sessão, ele não cobra nem sinaliza: acusar alguém que não podia
cumprir seria pior que não cobrar.

### Três coisas que apareceram no caminho

O modelo padrão do Claude **não tem as ferramentas de checklist** a menos que sejam ligadas. Não era
o agente escolhendo não planejar — a ferramenta não existia. Agora o Tachyon liga.

O Codex **já enviava** o identificador do turno, e o Tachyon jogava fora. A conclusão de que "não dava
para saber" era falsa, e falsa por nossa causa.

E o texto do lembrete prometia ser "o único aviso" quando o código não garantia isso. Corrigido antes
de sair.

## 0.93.3 — um plugin pode ser de um agente só, e sem custar espaço em disco

### Um plugin instalado para um agente não vaza para os outros

Até aqui, instalar um plugin escrevia nos destinos do workspace: `.claude/skills`, `.mcp.json`,
`.codex/config.toml`. Todos os agentes enxergavam tudo. Autorizar um agente e não os outros era uma
intenção sem mecanismo.

Agora o destino pode ser o harness privado de um agente. As skills, o MCP e os hooks daquele plugin
vão para `.tachyon/harness/<agente>/` e **não aparecem nos destinos compartilhados**.

Onde não dá para isolar, o produto recusa em vez de improvisar:

    agente inexistente          recusa
    isolamento so de transcript recusa — nao e harness completo
    skill de codex              recusa — nao ha raiz de descoberta isolada

Nenhum desses casos cai de volta para o destino global. Recusar é o comportamento; não é falta de
implementação.

### O isolamento não cobra por agente

A conta foi medida antes de existir código, porque ela decidia o desenho. O maior plugin instalado
aqui ocupa **6.492.222 bytes**. Se cada agente recebesse uma cópia, dois agentes custariam mais 6,4 MB
só nesse plugin, e três custariam mais 13 MB.

O payload continua sendo **uma cópia só**. O que o agente recebe é um destino apontando para ela.
Dois agentes, dois destinos, **zero byte extra**.

Remover um agente tira o destino dele e deixa o plugin de pé para os outros.

### Consentimento que não pode ser reaproveitado

Se o estado de isolamento do agente muda entre a hora em que você aprova e a hora em que a instalação
acontece, o apply **falha fechado** e pede aprovação nova. Aprovar para um destino não vale para outro.

### A tela de leitura de pin voltou a bater com o editor

O corpo do pin copiava o tamanho do editor de texto rico — 14px, escrito à mão nos dois lugares. O
editor foi para 16px na escala de leitura e o pin ficou para trás, sozinho em 14.

O conserto não foi copiar o número novo. O pin agora **aponta para o mesmo papel** que o editor usa.
Os dois não podem mais divergir sem alguém mudar o papel de propósito.

Nessa passada: 25 distâncias fora da escala foram a zero e os 7 tamanhos de texto viraram token.

### Sem Node no sistema, o Tachyon volta a recusar em vez de fingir que subiu

Num computador sem Node no `PATH`, a extensão **terminava a ativação com sucesso** — e nada
funcionava depois. Agora ela recusa dizendo o nome do problema.

A causa foi um conserto anterior aplicado longe demais. A versão passada ensinou o Tachyon a não
perder a janela inteira quando uma pasta falha ao abrir, o que está certo. Só que "não há Node neste
computador" caiu no mesmo caminho — e isso não é falha de uma pasta. Todas falham igual, e o botão
Repetir não instala Node.

### Três regras de estilo que ninguém renderizava

O Activity carregava três regras CSS sem consumidor. Elas não mudavam pixel nenhum — e continham
justamente os dois maiores desalinhamentos que a auditoria de design tinha contado naquela tela.

A dívida daquela superfície estava inflada por regras invisíveis. Vale conferir a mesma sombra nas
outras antes de repetir a conta.

## 0.93.2 — o espaçamento passa a vir do tema, e duas telas somem

A primeira versão em que **o espaço acompanha o VS Code**, do mesmo jeito que a cor sempre acompanhou.

### O espaço e o tamanho do texto ganham escala, e ela é herdada

O sistema tinha 568 espaçamentos escritos à mão e **nenhuma escala**. O valor mais usado era `6px`;
`3px`, `5px`, `7px` e `9px` apareciam 130 vezes juntos, como ajuste de olho. E havia **nove tamanhos
de texto diferentes**, incluindo um `12.5px`.

A escala não foi inventada: foi medida em três referências, e a mais importante já estava instalada
nesta máquina. **O VS Code declara tokens de tamanho** — espaço, raio, tamanho de fonte — no mesmo
formato em que declara as cores, e os entrega às telas do Tachyon. Isso foi confirmado executando a
leitura numa tela real, não deduzido do código.

    espaço    2 · 4 · 6 · 8 · 10 · 12 · 16 · 20 · 24 · 32
    texto     operador 10/11/12/13   ·   leitura 13/16/20

Duas densidades, porque apertar as telas de leitura machucaria justamente o que mais se lê. E `13px`
serve às duas — é o tamanho que o próprio editor usa.

Cada passo lê do tema com um valor de reserva medido. **Quando a Microsoft mudar a densidade do
editor, o Tachyon acompanha** — e em versões antigas do VS Code nada quebra.

### A tela de Activity foi a primeira migrada

Espaçamentos escritos à mão: **126 → 0**. Tamanhos de texto: **38 → 1**. Referências diretas de tema:
**69 → 6**.

Você vai ver a diferença. Ela é a escala fazendo efeito, não um redesenho.

### Commands e Runbooks saíram

As duas abas da sidebar, os runners, os painéis Studio e as ferramentas `run_command`,
`list_commands` e `run_runbook` foram removidos — **24 arquivos, 3.330 linhas**. As abas mostravam
vazio depois de meses de uso diário.

Schedules continuam, agora só com `spawn:`. `docs/runbooks/` — que são procedimentos em markdown,
não a feature — e o `LoginRunner` do login nativo ficaram.

Nada foi migrado nem descontinuado com aviso: não havia o que migrar.

### O aviso de travamento parou de pedir a coisa errada

A mensagem `event loop lagged` sugeria recuperar a Bridge, e não havia nada a recuperar. Medindo, as
duas causas prováveis foram descartadas — não era disputa de processador nem trabalho travando a
interface — e apareceu uma terceira que ninguém tinha considerado: **um salto no relógio do sistema é
indistinguível de um travamento** para quem só olha a hora.

Agora o aviso classifica antes de falar. Salto de relógio não diz nada. O resto nomeia o gesto, e o
gesto é *não* reiniciar a Bridge.

### E o `/exit` que aparecia sozinho

Ao trocar de versão, o Tachyon pede ao agente que encerre digitando `/exit` no campo dele. O comando
ficava lá **sem ser enviado**, por até quinze segundos, até o encerramento forçado.

A trava que segura o envio existe por um bom motivo — impedir que um encerramento envie um texto que
alguém tinha começado a escrever. O que estava errado era o alcance da leitura: ela olhava só as
últimas oito linhas da tela, e o menu que o próprio `/exit` abre é mais alto que isso.

### Ainda por baixo

A sidebar passou a distinguir um agente **com** tarefa de um **sem** tarefa, e mostra o estado dela
quando está parada. Um agente que já encerrou deixou de anunciar como atual um trabalho que já
entregou.

## 0.93.1 — a sidebar volta, e três guardas que não guardavam

Correção da 0.93.0, cortada no mesmo dia. Tudo aqui foi encontrado **por um humano olhando a tela**,
não por gate vermelho — que é o que estes consertos passam a mudar.

### A sidebar parou de renderizar por causa de uma string vazia

Depois do reload, a barra de status mostrava
`Could not refresh Sidebar: fleet.agents[0].persistenceHooks.path is too_small` e a sidebar **sumia
inteira**.

A cadeia: um hook de sessão falhou e gravou `path: ""` no log de falhas; a saúde do hook copiou o
campo direto; o projetor só omite valores `undefined`, e `""` não é `undefined`; o schema exige pelo
menos um caractere. Um dado pobre virou catástrofe de renderização.

Agora texto opcional vazio é **omitido** em vez de aceito. A distinção importa: aceitar vazio faria
a projeção carregar um campo sem significado; omitir diz a verdade, que é a ausência.

### E o hook que gerou aquilo nunca tinha funcionado

O publicador de status de runtime lia uma variável de ambiente com um nome, e o spawn injetava
outro. Nunca funcionou — e ninguém viu, porque **a falha era silenciosa**. O registro de falhas para
esse tipo de hook chegou na véspera, e o primeiro encerramento de sessão depois disso expôs tudo de
uma vez.

O defeito não era novo. Ficou visível, pelo conserto que existia justamente para tornar visível o
que era mudo.

### Um `/exit` que ninguém digitou

Durante a troca de versão, o Tachyon digita `/exit` no painel do agente para pará-lo com jeito.
Numa dessas o comando ficou no campo sem ser enviado, e o aviso de reload foi escrito **por cima**,
colando os dois numa linha só.

A proteção contra escrever sobre rascunho já existia — e olhava apenas as últimas oito linhas do
painel. O menu de comandos do Claude é mais alto que isso, então o texto saía da janela de captura e
o campo era lido como vazio. Agora esse aviso lê o painel inteiro.

### A carta do agente diz qual tarefa ele tem

Um agente vivo e sem trabalho parecia igual a um trabalhando. Medido: entre um aviso e o próximo, um
agente temporário passa em média **doze minutos e meio** parado, e às vezes quase uma hora — não é
exceção, é o estado normal de espera.

A carta agora mostra o id do cartão aberto, ou diz que não há cartão. Sem badge de alerta novo: a
distinção é a presença ou a ausência do id.

### O que essas quatro têm em comum

Três eram **guardas que não guardavam**. A checagem de agente vivo lia um retrato em cache; a
verificação de supressão nativa devolvia `false` fixo; a proteção do campo de texto enxergava só
oito linhas. Todas passavam verde no instante exato em que deviam recusar.

Nenhuma foi encontrada por teste. Todas por alguém olhando e perguntando por quê.

## 0.93.0 — as instruções permanentes param de depender de sorte, e a Inbox para de esconder decisões

Versão de conserto. Quase tudo aqui existia como defeito silencioso: um comportamento que
funcionava na maior parte do tempo, e falhava sem avisar no resto.

### As suas regras permanentes sobrevivem ao compact

O campo **Persistent Instructions** do perfil de um agente agora entra por flag de launch, e não
mais só no texto de abertura da conversa. A diferença aparece quando o contexto é compactado: o
texto de abertura é reescrito pelo resumo, e o system prompt não.

Antes, uma instrução voltava depois de um compact **porque o resumo decidiu carregá-la**. Um resumo
que cortasse o trecho apagava a instrução em silêncio, para sempre, e nada acusava.

Medido nos três runtimes com sessão real: Claude por `--append-system-prompt-file`, Grok por
`--rules`, Codex por `developer_instructions`. A única lacuna conhecida está declarada em vez de
escondida — a compactação **automática** do Claude não pôde ser provada, e a matriz de paridade diz
isso com o motivo.

### Human Inbox: proposta deixa de ser invisível

Três coisas mudaram, e as três vinham do mesmo incidente — uma decisão tomada que nem quem decidiu
nem quem pediu conseguiu ver depois:

- o cabeçalho contava três dos seis números que já calculava, e os três omitidos eram justamente os
  de proposta. Agora os contadores vêm da mesma fonte, e a soma não pode divergir do total;
- uma proposta **decidida** sumia da lista inteira, enquanto approvals e validations resolvidas
  ficavam no histórico. Agora fica, com o desfecho, e abre sem os botões de decidir;
- aprovar ou negar uma proposta de Saved Agent agora **avisa quem propôs**. Antes não avisava
  ninguém, e o agente só descobria por ausência — sem distinguir aprovado, negado, cancelado ou
  expirado.

E o caso "quem pediu saiu da sessão entre o pedido e a decisão" passou a ser coberto: a entrega
espera na fila até o agente voltar, em vez de registrar erro e ficar por isso mesmo.

### Evidence badge conta o que fala da árvore de agora

O contador somava registros que o próprio produto já sabia vencidos — a linha de um agente podia
dizer `6 evidence record(s), 6 stale` sobre trabalho fechado duas semanas antes. Agora conta só
frescos, e o número passa a significar *existe coisa que você não viu sobre esta árvore*.

E a legenda parou de morrer com o agente: o registro passa a viver ao lado dos arquivos de prova, em
vez de dentro da linha de sessão que a dispensa apaga. Isso já tinha custado 103 pastas de captura
sem o texto que dizia o que provavam — essas continuam onde estão, e nada foi apagado.

### F5 no dev-host diz o que está errado

Apertar F5 sem o dev-host armado mostrava uma linha: `terminated with exit code 1`. A causa já era
impressa, com o comando exato para armar — só que no terminal, e o diálogo do VS Code não mostra
terminal.

Agora a falha chega ao painel **Problems**, com a causa e o comando, e o botão *Show Errors* leva a
ela. O F5 continua falhando quando não está armado: escolher um fixture por conta própria abriria um
Extension Development Host vazio, que é pior que uma falha explicada.

### Tooltip e Dialog voltam a funcionar

Os dois falhavam sob `preact/compat` desde julho e ficaram sem wrapper no Kit, o que deixava as
toolbars densas de ícone-só **sem nome acessível** — nem para leitor de tela, nem para quem não
reconhece o ícone.

A causa não era o Radix: o Tooltip depende de hover e foco, e é esse caminho específico que não
fechava o circuito. Popover, Dropdown e Select passavam o mesmo gate porque abrem por clique.

### Ainda visível para quem dogfooda

Worktrees criadas por uma sessão de dev-host agora nascem como `tachyon/dev-host/<agente>` em vez de
`tachyon/<agente>`, para deixarem de se parecer com branch de trabalho no seu próprio repositório.

### Por baixo

A matriz de paridade entre runtimes deixou de ser só prosa. Seis dimensões agora têm contraparte
tipada que **deriva o veredito do código** em vez de repeti-lo, e cada célula separa o que o Tachyon
projeta do que o CLI realmente faz. As outras dezesseis estão declaradas como narrativa **com o
motivo medido** de por que não são deriváveis hoje.

Também deixaram de mentir: `retask_agent` afirmava entrega para agente que já tinha saído, e a porta
do Agent Studio registrava falha no log apenas para uma das suas operações.

## 0.92.0 — o repositório virou monorepo, e a engine deixou de saber quem a chama

Duas mudanças estruturais e **zero mudança de comportamento**. Nada que você vê ou faz muda nesta
versão; o que muda é que várias regras que existiam só como frase em documento agora são erro de
gate.

O mantenedor abriu assim: *"estamos construindo o produto um monolito sem separar isso em um monorepo
classico com os modulos do systema desacoplados"*. E fixou a condição: **sem acoplamento direto entre
as camadas** — não apenas pastas separadas.

### Changed

- **O produto virou quatro workspaces** (SDD 506). `apps/vscode-extension` e
  `packages/{engine,shared,webview-ui}`, com mais de mil arquivos movidos em seis fatias.

  O corte NÃO foi por nome de pasta, e a medição derrubou três candidatos óbvios: `agents` e `runtime`
  não caíam sozinhos (a engine alcança 36 dos 46 arquivos de `agents`, o navegador alcança 2), e
  `src/webview/` não era um pacote — só 165 dos 206 arquivos do programa navegador moravam lá, e 104
  dos 269 que moravam lá não eram do navegador. **O corte é pelo fecho de quem inicia o programa.**

  O `src/` da raiz deixou de existir: 269 arquivos viraram zero.

- **A bridge virou pacote de transporte, e a engine não a importa** (SDD 507). `@tachyon/bridge`
  declara `@tachyon/engine`; a engine não declara de volta, e `check:package-boundary` recusa a
  travessia com lista de exceções vazia.

  A medição por trás disso encontrou o que ninguém tinha perguntado: dos 68 símbolos que a engine
  importava do transporte, **37 eram vocabulário dela mesma** — nível de notificação, contrato de
  spawn, aprovação, fila de avisos. `bridge/` nunca foi uma camada; era uma gaveta com transporte,
  domínio e utilitário misturados. Seis extrações devolveram os 37, cinco fatias inverteram o resto,
  e o `new Bridge(...)` saiu do `Workspace.ts`.

  O que isso compra: um transporte que não seja MCP se escreve sem editar `packages/engine`, e existe
  teste que **compõe um transporte alternativo contra o `runEngineDaemon` real** para provar.

### Added

- **`check:package-boundary`** — dentro de um workspace, import relativo não escapa da própria raiz, e
  import por nome exige dependência declarada. Nasceu com lista de exceções vazia e continua vazia.
- **`check-vscode-import-boundaries.mjs`** — `packages/engine` e `packages/webview-ui` com tolerância
  zero a `vscode`, **incluindo `import type`**, e recusando entrada de allowlist que não case nada.
  Substituiu um grep por caminho que a própria migração teria invalidado.
- **Réguas reproduzíveis** em `scripts/research/` para o grafo de dependências e para a fronteira
  engine↔bridge, porque três números do documento original tinham sido contados à mão e erravam.

### Fixed

Uma auditoria de resíduo procurou o que a migração deixou para trás, e o padrão que ela encontrou é o
mesmo em todos os casos: **verificação que não verifica**, e nenhum apareceu como gate vermelho.

- Um guarda varria dois diretórios apagados e examinava **zero arquivos**, verde, desde uma fatia
  anterior.
- Cinco guardas de build ficaram `skipped` em vez de falharem.
- Oito das nove entradas de uma allowlist não casavam mais nada — e uma entrada morta libera caminho
  novo em silêncio.
- Uma fixture de migração derivava as chaves das funções que testava, então concordava consigo mesma.
- O manifesto do app preservou 27 scripts copiados da raiz; 22 apontavam para caminhos inexistentes e
  uma porta npm real falhava. Ficaram os 2 que são dele.
- O schema que valida `tachyon.yml` era código de produto morando na raiz, e um critério de aceite
  dizia o contrário — porque tinha sido verificado contando só TypeScript.

### Nota para quem puxa esta versão

Rode **`npm ci`**, não `npm install`. Um checkout que já tinha `node_modules` de antes dos pacotes
existirem pode não receber os links novos, e o build morre em `Cannot find package '@tachyon/...'` sem
que o código tenha nada de errado.

## 0.91.0 — two screens were rendering without the design system, and nothing could tell

The maintainer asked why Tachyon's UI looks worse than what other agents produce. The answer was not
taste. An audit of the design system found that `--ds-*` tokens were minted in four separate files,
that `design-system.css` referenced thirteen tokens it never declared, and that two surfaces linked
it without the sheet those tokens actually lived in. Those two rendered with black body text, no
button borders, no focus ring and no status colour — and three green tests were guarding the gap.

This release fixes that, gives the tokens a home of their own, and adds the checks that would have
caught each defect.

### Fixed

- **`ui-gate` and `plugin-host` render with the design system again** (`t-df3c88`). Measured in
  Chrome, the only difference between the two pages being one stylesheet: body text `rgb(0,0,0)`
  instead of `rgb(204,204,204)`, `border-width: 0` on buttons, no focus outline, disabled controls at
  full opacity, badges with no status colour. An unresolvable `var()` with no fallback is invalid at
  computed-value time and resolves to `unset`, so no theme could correct it.

  Nothing detected it because `SHELL_BASE_STYLESHEETS` — the constant naming the correct sheet list —
  had **zero consumers**; every host repeated the list by hand. The test that "proved" it asserted
  that the constant's *text* appeared in the source, and a CSS-order snapshot had frozen the wrong
  list as correct. Hosts now read the constant, and both surfaces are proven by rendering, not by
  matching source text.

- **Four error affordances are red again** (`t-f45320`). `--ds-danger` is not a token — the system's
  error token is `--ds-err` — so four rules using it silently dropped the property and rendered error
  text in the inherited colour. A comment in a fifth file already said the token did not exist; the
  comment was written, the live rules were not fixed. Five more of the same class went with them: a
  modal with square corners in a 6px-radius product, a page title outside the type ramp, a discarded
  `font` shorthand, an invalid `inherit` inside a shorthand, and a typo that was invisible because
  its fallback matched.

- **Design Mode's overlay follows your theme** (`t-f5b467`). It was 23 hardcoded hex colours and no
  stylesheet — because an overlay injected into someone else's page cannot load one, and must not
  inherit the host's CSS. It now mounts in a shadow root with `all: initial` and one stylesheet built
  from the 44 tokens the host already resolved. Zero hex literals remain. Proven against a hostile
  page that forces `font-size: 62.5%` and `!important` colour, background, radius and padding on
  every element.

### Changed

- **The design system has a home of its own** (`t-64acc7`). The shared sheets are split by what they
  *are* — `tokens.css`, `faces.css`, components — rather than by which surface can load which. Every
  surface links the token sheet; the agent pane skips only the faces, which was the actual
  restriction all along (Tachyon Mono's `@font-face` breaks xterm cell metrics — a statement about
  type, not about tokens).

  The pane had rebuilt sixteen private declarations by hand because it could not reach the shared
  ones, and they had drifted: its border mixed at 18 % where the shared token mixes at 22 %, and it
  anchored foreground to a different VS Code variable. All sixteen are gone.

- **Dead design-system code removed** (`t-1c075a`). The Toast block was written twice in one file and
  the copies had already diverged; 32 declarations became 16. `.ds-button` and `.ds-empty` are gone,
  with the latter's three call sites moved to the shared `EmptyState`.

### Internal

- A static gate now refuses **raw hex colours and numeric z-index** in `src/webview/`, and a second
  one refuses a `var()` on a token that is declared nowhere without a fallback (`t-c8e2bd`,
  `t-f45320`). The first was born with the existing debt declared — 208 hex literals and 22 numeric
  z-index, each with a written reason — and it also **fails when an exception is no longer needed**,
  so the list can only shrink. The second was born with an empty exception list: nothing was
  forgiven, everything was fixed.
- The Bridge's two conditionally-registered tool families now have an exact by-name inventory
  (`t-8e0366`). With both enabled the Bridge exposes 113 tools, 33 of them from those families —
  29 % of the surface the canonical inventory could not see, and adding one used to turn nothing red.
- Two design-system audits are recorded as specs rather than as memory: the boot-state plan
  (`SDD 504`) and the design-system census with its ten open questions and their answers (`SDD 505`).

## 0.90.0 — the Design Mode tab is gone; the whole thing lives in the page

0.89.0 gave the page everything it needed to work on its own. This release removes what it replaced.
The separate Design Mode tab — its chat, its composer, its reply tool, its build entry — is deleted,
along with about 2200 lines. Nothing takes its place: viewport presets and the pick preview moved
down into the page toolbar, and no sidebar was invented to hold them.

### Removed

- **The Design Mode chat tab** (`t-e6f115`). `DesignModePanel`, the `design-mode` webview app, the
  chat store and turn machinery, both build entries, and the `design_mode_chat_reply` Bridge tool are
  gone. The four viewport presets keep the same values and the same CDP backend — only their home
  changed, from the tab to the overlay's toolbar. The picked-element preview moved with them.

  A note for whoever finds this later: `t-727d9c` proved `design_mode_chat_reply` working live across
  six runtimes, and `t-45b266` waited eight days for that proof. Removing it contradicts neither. The
  proof was that replies reached **the panel** — and the panel is what this release deletes.

### Added

- **Markup: draw on a frozen viewport** (`t-dd0bce`). The Markup button captures the viewport through
  CDP and the overlay switches to a canvas over that still image. Shapes stay vector while you edit.
  Copy persists the composed PNG and puts its path on the clipboard; Send routes it through the same
  confirmed-receipt ladder annotations already use — there is no second delivery path.

  The canvas never reads or rewrites the inspected page's DOM. That is the property that makes it
  safe rather than an implementation detail, and it is what the test asserts. Budgets are explicit:
  100 shapes, 250 KB of shape data, 2 MiB for the frozen viewport, 8 MiB for the batch. Copy keeps
  exactly one replaceable PNG.

  If the page navigates underneath, the markup survives — the vectors persist across re-injection and
  the annotation carries the URL the viewport was frozen from, so the agent gets the right address
  even if the tab has moved on.

### Fixed

- **A queued notice now tells the sender how deep the wait is** (`t-44ae02`). `notify_agent` waits for
  the recipient's idle edge, so a busy recipient's queue can grow without the sender knowing. Measured
  (`t-747369`): one agent sent four notices in 4.5 minutes while the first was still queued. The
  receipt now reads `queued 'X' for idle delivery (depth 3, oldest 5m)`. The receipt is the only
  channel that reaches a sender mid-turn — the alternative would be writing into their terminal
  during a turn, which is exactly what the idle wait exists to prevent.

### Internal

- A cutover test asserted `readdirSync(...)` on a directory the same change deleted, so it passed only
  where the empty directory happened to linger and went red on a clean checkout (`t-69f737`). It now
  asserts the directory is gone. Found by an agent working on something else who measured the red on
  clean `main` instead of retrying past it.
- The 8–13 minute notice delays were measured and are **not** a defect (`t-747369`): the idle wait is
  deliberate, and the content was readable the whole time through `read_notices`, a durable pull door
  that had been used three times in every surviving transcript. Recorded as coordinator discipline —
  pull before spending a gate — rather than answered with machinery.

## 0.89.0 — annotate the page and send it straight to an agent, and Activity stops arriving in batches

Design Mode stops needing a chat of its own. You pick an element in the browser, write what you want
changed, and send the whole batch to a running agent's terminal — no separate conversation to keep in
sync. The other half of the release is latency and reachability: the Activity feed was arriving 1.3
seconds late in two-second clumps, and a live agent could stop answering entirely.

### Added

- **Send a batch of annotations straight to an agent's terminal** (`t-0a8f7a`). The page tray now
  carries a picker of running agents. Send composes one Markdown document — `## Design Feedback:
  <url>`, then per annotation the intent, selector, comment, bounds and `Screenshot: <path>` — and
  submits it through the same terminal path Tachyon already uses. No second conversation, no second
  submit mechanism.

  **The batch is cleared only after a confirmed receipt.** Every other outcome keeps your annotations
  and says what happened: a destination that died between listing and clicking, a terminal holding a
  human draft, or a submit whose completion could not be observed. The page never decides eligibility
  either — the host owns the roster and re-validates the chosen agent at the moment of the click.

  The screenshot is context, not a requirement: the host captures one crop per annotation and carries
  the **path**, never base64. If capture fails the annotation still sends as text.

- **Design Mode annotations live on the page** (`t-86e341`). Picking an element now opens a popover
  anchored to it: free text plus an intent, Change or Question. Adding stores the annotation on the
  host, which owns the numbering, and a numbered badge appears on the element. A tray on the page
  lists the batch — number, preview, element label, comment — with delete. No extra panel and no
  extra chat; the whole surface is the injected overlay.

  An annotation whose element disappears does **not** keep a badge pointing at nothing: the badge is
  removed and its tray row reads "Target not found". That is proven by deleting the element from a
  real Chrome page, not by simulating it. Sending the batch to an agent is the next slice.

### Fixed

- **A live agent could stop being reachable, and every door refused at once** (`t-e169e4`, spec 503).
  When a notice is queued for a busy agent, the drain types it at the next idle edge — but the
  runtime can be mid-handback and never accept the submit. That outcome was already modelled: the
  submission is reported unconfirmed and the queue keeps the item. What had no recovery path was the
  consequence — Tachyon's own line now sat in the composer, so every later delivery classified it as
  a **human draft** and refused. `notify_agent` held, `write_input` refused and pointed at
  `notify_agent`, `retask_agent` only queued. The agent stayed alive, idle, and unreachable with its
  own instruction sitting in its input box.

  Recovery submits an already-staged line without retyping it, and a later notice is itself an escape
  door. Ownership is decided by **byte-for-byte equality against the retained queue head**, not by
  the text looking like Tachyon's — a prefix can be pasted by a human, whereas the queue is
  out-of-band evidence. Unrelated human drafts are still held, and when the composer cannot be read
  at all the check fails closed and the content stays human-owned.

- **"Edit YAML" on a Saved Agent opens that agent's file** (`t-c29ca3`). It opened `tachyon.yml`,
  which no longer holds agents — they live in `.tachyon/agents/<name>/agent.yml`. The command looked
  for the agent inside the wrong file, did not find it, and opened the file anyway at line 0 with no
  explanation. Its error handling covered the one case that never happens ("no `tachyon.yml` in this
  workspace") while the real one passed in silence. A missing agent file is now named in the warning
  and nothing is opened. Commands, runbooks and schedules were measured and are still `tachyon.yml`
  by design; `Clone` never read it.

- **The Activity feed stops arriving in two-second batches** (`t-1484bc`, measured in `t-7e157a`).
  The complaint was that Activity "doesn't feel alive". Timed live, native write → durable JSONL was
  **p50 1096 ms, max 1946 ms**; the watcher added 0–500 ms and the app painted the pixel in 16 ms. So
  the delay was one timer — the log manager's 2 s tick — and it was not protecting anything: eight
  idle agents cost 0.054 ms per poll. The tick is now 500 ms and the same live measurement reads
  **p50 244 ms**. The obvious-looking culprit was measured and rejected: dropping the feed's 500 ms
  `watchFile` to 100 ms buys at most 20 % of the ceiling and multiplies `stat()` by five.

  What made this dangerous was not the number. Two constants counted **polls** while claiming a
  duration — `LIFECYCLE_GRACE_POLLS = 3`, whose comment read *"At ~2s/poll this is a few seconds"* —
  so lowering the tick would have silently shrunk a 6 s grace window to 1.5 s and a 60 s backstop to
  15 s. Nothing would have gone red: every test already constructs the manager with its own interval.
  They are expressed in milliseconds now, with a test that asserts twenty fast ticks emit nothing.

- **The first tool of a parallel Grok batch no longer runs forever** (`t-08abf8`). Grok writes one
  `assistant` record holding N tool calls; the durable log keyed that whole record by the **first**
  tool's id, and that tool's own result reuses the same id — so the log's idempotency check read the
  completion as a replay and dropped it. In Activity the first tool of every parallel batch stayed
  spinning with no end. The origin record is now keyed distinctly from its children. The idempotency
  check itself was not loosened: it was never the defect, the key was.

  Declared, because a durable key changed shape: a log written before this upgrade and re-read inside
  the crash-recovery window can append one batch twice. One duplicated Activity row, once. No key
  migration — the window is one-shot and migrating costs more than the defect.

### Changed

- **Design Mode's page overlay is now a compiled bundle instead of a hand-written string**
  (`t-1ca53b`, `t-5c5323`). `designModeInject.ts` went from **1765 lines to 15**; the picker is a
  Preact app built by esbuild as a self-contained 17 KB IIFE and evaluated over CDP. Behaviour is
  unchanged — this is the groundwork for annotations and for removing the separate Design Mode chat
  tab. A ratchet keeps the injection wrapper under 400 characters (it measures 196), so UI can grow
  in the bundle and not back into the string.

  **Still true in this build:** the Design Mode chat tab is still there, and so are its viewport
  presets and its copy of the pick screenshot. The page can now send on its own, so removing the tab
  is the next slice rather than a distant one — but until it happens both surfaces exist and the tab
  remains the only place with the responsive presets.

- **Clicking a link with Design Mode on no longer kills the overlay** (`t-03afe7`). The status bar
  kept saying ON while the overlay was gone — the product asserting a state it was not holding. The
  intended re-injection was never running: the presence watcher fires every 400 ms and each call
  cleared and re-armed a 450 ms timer, so the timer never reached its own deadline. It is now
  idempotent, and a real click restores the overlay in 719 ms.

  The suspected cause — a race between the dying document and the message going up — was tested and
  **refuted** before any line was changed: sending the navigation signal directly ahead of the click
  still did not close the loop. And the other half of the fix matters as much: when re-injection is
  genuinely impossible, Design Mode now turns **off** and tells the host, rather than leaving a
  status bar that lies.

### Internal

- Two pairs of tests that pinned the Bridge's tool **count** were removed (`t-33b5cd`, `t-4e328b`).
  One of them carried a `.gen.` suffix with no generator left to regenerate it, and the number it
  froze (83) had already drifted from the canonical list (80 names). The by-name inventory is the
  real guard and is untouched.
- The coordinator's merge cadence was measured (`t-fe60a3`): of the day's 45 possible merge pairs,
  **40 touched disjoint files**, so most re-integration proved nothing. The finding inverted the
  premise — the expensive collisions came from dispatching two agents onto the same screen, not from
  merge order. Written up as ordering discipline, not machinery.
- The exclusion of plugin `view` from spec 486 was contested and held on measurement (`t-7ec4b2`):
  of 15 installed plugins exactly one contributes a view, and it opens as a tab on demand.

## 0.88.0 — the board tells you who is working on what, and Design Mode gets its viewport presets back

Two of these are regressions this release fixes rather than features it adds, and both were found by
using the product: the board had stopped naming anyone, and the responsive presets went missing when
Design Mode's chat moved out of the page.

### Fixed

- **The board no longer labels every task `unassigned`** (`t-2a944c`). `assignee` is not a stored
  field — it is derived from the attempts ledger, and the store does that correctly. The board's wire
  projection forwarded only `assignee` while the card label reads `currentAssignee` for live work and
  `lastDeliverer` for history, so the webview received one field and the label read the other two.
  Every card said "unassigned", including 389 delivered tasks that had a recorded deliverer. The
  agent filter was measured and was **not** affected: it reads the field that was being forwarded.
- **Design Mode's viewport presets are back** (`t-0807b2`). Phone 375×812, tablet 768×1024, desktop
  1280×800 and reset lived in the injected page toolbar and went out with it in 0.87.0. The backend
  never left — `Emulation.setDeviceMetricsOverride` and its handler were intact the whole time, with
  nothing left to reach them. The controls now live in the Design Mode tab and show which preset is
  active, which matters more than it did on the old toolbar: in a separate tab there is otherwise no
  way to tell whether the page is at 375 or 1280.
- **Closing an already-delivered task no longer looks like assigning work** (`t-964eef`).
  `reconcile_task` is the quiet door for bookkeeping and stays quiet; a guard now holds that, proven
  by injecting a synthetic assignee to watch the test fail before trusting it.

### Added

- **The picked element's screenshot appears in the Design Mode chat** (`t-49ef22`). The capture was
  always being taken and its path already travelled in the agent's prompt; it simply was never shown.
  Undoing an edit — the other half of that task — is deliberately still out: it needs a written
  transaction contract first (what exactly is undone, whole patch or per file, and what happens when
  the file changed since). This shipped on catalog visual QA because the headless Dev Host could not
  inject the picker at the time. **Proven live shortly after release** (`t-d2e196`): a real pick in a
  working headless Dev Host shows the element image in the chat at 220×90. That Dev Host failure was
  transient and does not reproduce; the cause is unknown, and is recorded as unknown rather than
  guessed — the suspected culprit (`DISABLE_AUTOUPDATER`, added hours earlier) was A/B tested on one
  tree and refuted, with a real pick succeeding both with and without it.
- **`retask_agent`** (`t-a8b630`, SDD 502) hands one triaged board task to an already-live Temporary
  agent: it claims the task and pushes a freshly projected WORK ON RECORD into the existing
  conversation. No restart, no touched checkout. Until now the only ways to change what a live agent
  was working on either did not move the board record at all or destroyed the worktree the work lived
  in. It refuses while that agent still owns different active work, because a re-task door that
  always accepts recreates the two-tasks conflict it exists to resolve.

## 0.87.1 — a Dev Host could delete `claude` from your machine

Hotfix for anyone who runs the Extension Development Host, by F5 or headless.

### Fixed

- **A Dev Host no longer hijacks the global `claude` launcher** (`t-9eb7ef`). Claude's native updater
  honours the redirected `XDG_DATA_HOME` for the version binary it downloads, but still rewrites the
  literal `~/.local/bin/claude` symlink — which lives outside the sandbox. An agent running a headless
  EDH updated inside its own worktree, the launcher was repointed at that ephemeral copy, and the
  normal dev-host cleanup then deleted the tree and took the system's `claude` with it. Measured with
  a live reproduction, not deduced. The fix scopes `DISABLE_AUTOUPDATER=1` to the dev-host
  environment and both committed F5 launch configurations; your normal shell still updates.
  **Known limit:** typing `claude update` by hand inside a Dev Host still repoints the launcher — the
  updater ignores the flag for explicit user commands by design. Recovery is
  `ln -sfn ~/.local/share/claude/versions/<version> ~/.local/bin/claude`.

## 0.87.0 — Design Mode's chat leaves your page, and answers through one door

The Design Mode chat used to run inside the live document of the site you were inspecting. It does
not any more: the page keeps the element picker and nothing else, while chat and the selection
inspector became an editor tab. The reply path lost its fallback in the same release, so there is now
exactly one way an agent answers.

### Changed

- **Chat and the selection inspector are a Preact webview, not page-injected UI** (`t-64edaf`,
  SDD 488 hybrid D step 1). The injected script went from **1765 lines to 30** and now does pick only.
  The panel opens as an editor tab beside the browser, so you click an element on the left and talk
  about it on the right. Of the six `eval` doors the F6 security review mapped, the chat-push door
  became unnecessary and was removed; five remain, and they are named in the task.
- **`design_mode_chat_reply` is the only reply path** (`t-45b266`, SDD 488 F1). The pane-marker
  fallback — the agent writing START/END into its terminal for Tachyon to scrape off the screen — is
  gone from prompts, extractors, tests and docs. This was blocked for eight days on a distinction
  worth keeping: a headless test proves the tool was CALLED, not that the answer ARRIVED in the panel.
  Deleting the fallback on the first half alone could have left Design Mode with no working voice at
  all, and a green suite would not have noticed. The live half was measured first (`t-727d9c`):
  Claude, Codex and Grok each resolved a host-minted pending turn through the production door, with
  turn ids recorded in `docs/runtimes/parity.md`. Pi, OpenCode and Hermes were measured too and are
  green; Gemini and Qwen declare `bridge: null` and cannot call tools at all, which is recorded rather
  than worked around.
- **"Save to tachyon.yml" is now "Save as terminal declaration", and it stops appearing where it can
  only fail** (`t-7b7701`). The action was offered on every ad-hoc row including forks, while the door
  underneath refuses anything that is not a terminal — a button that failed 100% of the time on a
  fork. It also named the wrong file: the writer moved to `.tachyon/terminals/<name>.yml` and three of
  its four strings still said `tachyon.yml`. The refusal now tells you what to do instead — create a
  Saved Agent in Agent Studio — and says plainly that the fork's session is not adopted.

## 0.86.1 — the IDE Browser could not open in 0.86.0

Hotfix, and it also carried three changes that landed before it.

Design Mode and the Integrated Browser were dead on arrival in 0.86.0: opening the browser timed out
after 20 seconds with `Timed out waiting for editor-browser child debug session (CDP)`.

### Changed

- **SDD 496 is closed: agent and terminal no longer share a box at any level** (`t-34cae5` and the four
  slices before it). Terminal Studio owns its own validator and serializer, and `StudioKind` lost the
  `"agent"` member. Twelve branches of the shared form were removed, each with a written reason for
  why it had existed — caller count answers "who calls this?", never "why does this exist?".

### Fixed

- **IDE Browser attaches CDP again** (`t-54b9c3`). 0.86.0 replaced name matching on the debug session
  (`name.includes("Tachyon")`, which could cross-stop another manager's session) with a private launch
  id plus a type check — the right idea with the wrong type string. The launch config declares
  `type: "editor-browser"`, the debug contributor's name; VS Code resolves that to the
  `pwa-editor-browser` adapter, so the equality never held. The parent session was therefore never
  recognized, the CDP-bearing child was never matched to it, and every open timed out. The check now
  reuses `isBrowserDebugSession`, which already listed `pwa-editor-browser` first among the four types
  it accepts, and keeps the launch id beside it so the cross-manager protection the original change
  existed for is unchanged. No test exercises a real debug adapter, which is why a green suite shipped
  it; the new test hits the extracted predicate directly and that limit is stated rather than papered
  over.

### Internal

- **The gate stopped being a coin flip** (`t-f71795`). `tmuxReap.test.ts` failed 5 times in 10 runs on
  a clean tree. It reproduces a race on purpose — kill a tmux server, catch the forked child still
  alive — and it guarded that race once with a retry, then re-asserted the same fact three lines later
  without one. Measuring liveness through `/proc/<pid>/stat` rather than directory existence also
  stopped a zombie from counting as alive, so the test got stricter, not looser.
- **The `processLock` dual-holder test moved out of the standard gate** (`t-9c01e5`). The residue it
  provokes is real, was measured on 2026-08-05 (zero dual holders in 120 orphan recoveries; roughly
  1 in 750 SIGKILLs under pathological stress) and was deliberately accepted then, with a revisit
  trigger written down: a sustained rate in the field, not a red in a loaded gate. An accepted residue
  with a provoking test in the standard gate turns every run into a coin flip. The scenario still
  lives in `scripts/spikes/`, and the note left in its place carries the measurement, the trigger and
  the exact commands, so nobody returns it to the gate thinking it was forgotten.

## 0.86.0 — installing a plugin stops arming it, and secrets stop travelling with config

The theme of this release is **the product no longer claims a state it does not sustain**. Installing
a plugin used to materialize its skills, hooks, MCP servers and git hooks in one step; now install
records and an explicit apply arms. A cloned agent used to carry its parent's credentials. Three
surfaces promised write isolation that no runtime delivers. Each of those was a written promise the
code did not keep, and each is now either kept or withdrawn in writing.

### Added

- **Explicit apply/unapply for every plugin contribution** (`t-f30f34`, `t-7f52f6`, `t-e85e0e`,
  SDD 486). Install records the payload and the exact removal identity, and materializes nothing.
  Applying is a separate, per-contribution decision, and the Plugins app models "installed, not
  applied" as its own state with a restart notice for an armed hook. This matters most for the two
  loudest kinds: an MCP server is a set of tools the agent can call, and a git hook runs on every
  commit for everyone. Unapply removes only what Tachyon wrote — human-authored content in the same
  file survives, which is covered by a dedicated test rather than a promise.
- **Attention reads native stop hooks on the runtimes that have them** (`t-6b3a0d`, `t-3fd30a`).
  Claude `Stop`, Codex `stopped` and Grok `Stop` now move attention state through the same managed
  lifecycle channel the persistence recorder already uses — deliberately not a second Stop hook,
  because on Codex a second `-c hooks.Stop=` silently replaces the first. Screen reading stays as
  the fallback: a wedged agent emits no `Stop`, and lifecycle still wins over any published status.
  Six runtimes were measured; the three without a Tachyon-managed channel were left out rather than
  fitted with a copy of Claude's shape.
- **Retry-safe Bridge delivery** (`t-3cccef`). `notify_agent` accepts an optional `deliveryId`
  minted before the first attempt; a retry consults the durable record, answers `already-accepted`
  and does not deliver twice. Reusing an id with different content is refused, so the id cannot
  smuggle a new message under an old receipt. Measured after two `notify_agent` calls were lost and
  an `update_task` executed but lost only its response — indistinguishable from the caller's side,
  which is why both reactions were to repeat.

### Changed

- **Secrets no longer live in the same box as configuration** (`t-2ec981`). `environment.secrets` is
  its own shape, separate from `environment.values`, and cloning an agent no longer carries the
  parent's credentials along with its settings.
- **Terminals are declaration files, not a block in `tachyon.yml`** (`t-bc8eed`, SDD 496).
  A terminal now lives at `.tachyon/terminals/<name>.yml`, mirroring the layout agents already used.
  A legacy `terminals:` block still loads, with a warning naming the new location — it warns, it
  never refuses. Fifteen fixture workspaces were migrated in the same commit.
- **The IDE Browser applies one navigation policy, not two** (`t-c294e8`, `t-427fae`). The agent's
  `navigate` now follows the same scheme policy as the configured home URL, but reports a refusal by
  name instead of silently landing on `about:blank` — asking for `about:blank` and falling back to it
  are no longer the same answer. The HTTP `/eval` route inherits the 50,000-character ceiling the MCP
  tool already had, from one shared constant.
- **At most three pending schedule proposals per agent** (`t-e5ecec`), matching the ceiling its
  sibling surface already enforced.

### Fixed

- **`dev-host point` refuses to rematerialize the mirror under a live Dev Host window** (`t-7ee246`).
  Measured with real state loss: an EDH was open with agents created through Agent Studio, `point`
  rewrote the disposable workspace, and a live process was left writing to a file already marked
  `(deleted)`. `point` was already fail-closed for a headless session and destructive for a human
  window. The liveness signal is the owning VS Code/Electron process carrying this pointer's exact
  workspace and extension-development arguments, so a crash cannot leave a stale lock. `--force`
  overrides deliberately. Unreadable pointer metadata now refuses rather than guesses; absent
  metadata still passes, because an unarmed pointer has nothing to destroy.
- **Codex skill revocation reaches the tree it wrote** (`t-f842f0`). Sweeping was previously skipped
  entirely because Codex projects skills into `<cwd>/.agents/skills`, a directory the plugin
  installer also owns. Ownership was measured at the point of use: outside the workspace root the
  tree belongs to this grant path and an empty selection now purges it; at the root it belongs to the
  installer and is never swept, with the inability to revoke recorded rather than ignored. A symlink
  in place of the directory is refused, not followed.
- **Visual QA at 360px now photographs a 360px viewport** (`t-4a477f`). All 117 catalog URLs omit
  `?width=`, so the preview iframe stayed at the route's frame while only the outer window shrank —
  every narrow catalog shot was a crop of the wide layout, and a genuinely broken narrow layout would
  have passed just as easily. The shell now sizes the iframe to the outer window, clamped to the
  route frame, so wide captures are unchanged and no existing evidence is invalidated. An explicit
  `?width=` still wins.
- **The IDE Browser recognizes its own session** (`t-849f52`) through a launch id stamped into the
  debug configuration, replacing name matching on the string "Tachyon".

### Removed

- **Three surfaces stopped promising write isolation no runtime delivers** (`t-5313dc`). The claim was
  measured false and withdrawn in the UI text rather than quietly softened. The follow-up measurement
  (`t-e5441a`) found that only Codex and Grok can express the narrow boundary at all, so detection
  and reporting is the only honest cross-runtime statement; prevention, if it ships, must name its
  runtime and refuse the others instead of silently falling back.
- **`verifyNativeMemory`** (`t-74b75a`), whose owner existed and had already delivered through
  another door.

### Internal

- `parseAgentEntry` is now two parsers and `forceTerminal` is gone with its eight branches, six of
  which were already unreachable in production (`t-8e6011`, SDD 496). The `MOVE_TO_AN_AGENT`
  diagnostic survives as the unknown-key message, because it names which block the entry lives in —
  the whole cost of the `t-9418ac` incident was three increments discovering exactly that.
- `applyContribution`/`unapplyContribution` no longer declare a synchronous return for the git-hook
  path, which returns a Promise (`t-e472a9`).
- Design Mode security review across `eval`, token, Trusted Types and click (`t-2136b6`): no measured
  path returns page content as evaluated JavaScript.
- **IDE Browser child-session death is now classified, not guessed as "tab closed?"** (`t-1c8195`).
  The owner's globo.com tab kept painted Design Mode chrome after CDP died. Production logs from that
  incident (same Extension Host, three launches, three deaths) discard extension reload and our own
  reset path. On Dev Host 1.128, toolbar Stop and closing the tab both tear down parent+child and
  destroy the page — no orphan. globo.com also opens a forest of extra `pwa-editor-browser` sessions
  under the CDP child (input for `t-849f52`). The log now records actor/trigger and, 150ms later,
  whether the parent survived. No auto-reconnect (duplicate chrome). Cleaning the orphaned inject
  without CDP would need a page-side heartbeat; that is a remaining choice, not built here.

## 0.85.1 — an agent was refused because of the subject it had worked on

Hotfix. Resuming an agent failed with `runtime_auth_rejected` while its credentials were perfectly
valid, blocking the maintainer mid-task.

### Fixed

- **Resume no longer rejects a launch because of what the transcript says** (`t-914be3`). The startup
  classifier scans pane output for login failures. On resume the runtime replays its entire transcript
  into the pane — 2,284 lines in the case that surfaced this — and that transcript contained
  "Authentication required" seven times, because that agent had been researching runtime permissions
  and auth. The agent was refused because of the subject it had worked on.

  The defect was an asymmetry inside one function: **rejection scanned the whole buffer while readiness
  scanned only the live tail**, and the three rejections ran first, so a perfectly rendered composer
  immediately below was never consulted. A sentence from yesterday could fail a launch happening now.

  The fix is the region, not the word list: removing one phrase would have left the same hole for the
  other five. All three rejections — auth, model and config — now read the same live tail the ready
  signal already read, in the generic classifier and in the Codex adapter, which had the same shape.

  **It did not become fail-open.** A second test holds the other side: a recent, genuine auth refusal
  is still rejected by both classifiers. Without that, this fix would have traded one defect for a
  worse one — a resume that ignores a truly expired credential.

  Declared limit: a runtime with no measured composer profile keeps scanning the whole buffer, and
  keeps the old behavior. Same rule the composer region reader already follows — without a measured
  ruler, nobody inherits someone else's.

## 0.85.0 — everything here was found by opening the product and using it

No item in this release came off the board. Each one came from the maintainer opening Design Mode,
trying something ordinary, and hitting a wall — an agent list that was empty while three agents ran, a
panel covering the reply it had just received, a bridge that would not start on its own, a debug
toolbar over the page. Two of them also corrected things this project had recorded as true.

### Fixed

- **"No running agents" now says which of three things it means** (`t-a4060b`). The Design Mode agent
  picker reported an empty roster while three agents were live and one was eligible by every rule. The
  list-building function ended in `catch { return []; }`, so *no eligible agent*, *the query failed*,
  and *there is no connection to the page* all collapsed into one sentence — and the right action
  differs in each case. An empty list reads as an answer, not an error.

  The host now distinguishes them: a disconnected page says to reopen the IDE Browser, a failed query
  reports its reason and logs it, and genuinely empty says so. A missing workspace now throws into the
  second case instead of disguising itself as the first.

  **And the filter that everyone blamed was reading a field that does not exist.** The exclusion tested
  `!row.temporary`; production rows carry `lifetime`, and there is no `temporary` boolean on them. The
  condition was always true — the filter had never excluded anything. Two separate investigations read
  that code, believed it, and built conclusions on it, including a line in the runtime parity matrix
  claiming Design Mode excludes Temporary agents. That line is now corrected in place, recorded as
  disproved rather than quietly deleted, so the next reader does not repeat the walk. Behavior is
  unchanged: removing a clause that never fired changes nobody's eligibility, and whether Design Mode
  *should* exclude Temporary agents is a product decision, not a bug fix.

- **The Selection card no longer covers the chat transcript** (`t-330a51`). With both panels open the
  card sat on top of the conversation, so a reply that had already arrived stayed invisible until the
  card was closed. Before/after captures at two viewports are in the spec's evidence directory.

  This was priority one for a reason that is not cosmetic: a reply that *arrives and cannot be seen* is,
  to the person looking, identical to one that never came — and 0.84.0 had just taught the panel to
  print "delivery was not confirmed" when a send fails. That warning is worthless if it is born behind
  the card.

- **`settings.ideBrowser.enabled: true` now means the bridge is up** (`t-7a4c36`). It used to mean only
  that a command existed. A human could click the globe in the status bar, which lazy-starts — which is
  why the palette command is literally titled *(advanced)*. An agent had no door at all: it called, got
  `bridge offline`, and was told to run a palette command it cannot run. That cost a full round of work
  in one day, with one task reporting offline four times while another brought the same host up by
  itself an hour later.

  The host now starts with the extension when the workspace opted in. Measured before shipping: median
  **10.06 ms**, p95 10.82 ms over 30 runs, and 20.32 ms for two windows on one root (they coexist on
  distinct ports). A workspace that did not opt in binds nothing. Only the loopback host starts —
  Chromium and CDP stay lazy until something navigates — and a failed bind is logged rather than thrown,
  because an optional feature must not break activation.

  The offline message now names a condition the caller can check instead of an action it cannot take.
  Turning the setting on with the window already open also reconciles for real now, rather than only
  repainting the status bar icons.

### Internal

- **The debug toolbar over the Integrated Browser is a VS Code limitation, proven in its source**
  (`t-414540`). Tachyon already passes all four suppression options when it starts the browser, and the
  toolbar appears anyway. Measured live: two `pwa-editor-browser` sessions exist; the child owns both
  the toolbar and the CDP connection Design Mode depends on. Reading VS Code 1.117's source at the
  pinned commit shows why — the DAP reverse request creates that child with only `{ parentSession }`,
  and while `noDebug` is inherited from the parent's configuration, the three UI suppression flags are
  not. The extension API cannot set options on an existing session or supply them for that request.

  Removing the child would remove the CDP session, so there is no fix inside Tachyon. The only lever is
  the global `debug.toolBarLocation` setting, which would also hide real debugging controls — the
  product does not mutate a human's global settings to hide its own side effect. Eight lines of comment
  now sit beside the four flags that do not suffice, because the obvious and wrong next fix is to add a
  fifth.

## 0.84.0 — a message that vanished, a panel that said it had been sent, and the one delivery ladder that already worked

The maintainer sent a Design Mode message to an agent to see whether it arrived. It did not. It sat in
the composer, unsubmitted, and would have stayed there forever — and the panel reported it as sent. He
was not looking for a defect; he was testing the feature the previous release had just measured.

Everything below came out of that one send.

### Fixed

- **A Design Mode message that does not arrive is no longer reported as sent** (`t-a48926`). The engine
  path behind Design Mode, handoff distill and `agent.input` called the blind primitive: paste the text,
  send a bare Enter, capture nothing, return nothing. If that Enter was swallowed — which is what
  happens when the target is mid-turn — the text stayed staged in the composer and no one knew.

  Two ordering facts made it worse. The chat event was written *after* the send, so a lost Enter still
  produced a "sent" row. And a staged draft is the exact condition that makes Tachyon refuse every
  *later* delivery to that agent, so one failed send could quietly deafen the recipient.

  The path now carries a receipt: the measured composer profile on submit, an explicit
  `typed-unsubmitted` status for deliberate staging, the chat row written *first* as pending, and — when
  the receipt is not `submitted` — no typing indicator, no reply wait, and a panel line that says both
  halves: *delivery was not confirmed*, and *the message is still saved*.

- **The reply wait no longer watches a turn that started before the message existed** (`t-b09d9c`).
  Measured from the chat log: the send at 12:48:33, the verdict "finished the turn without a chat reply"
  at 12:48:43. Ten seconds — during which the agent was finishing a turn that had begun twenty seconds
  *before* the message was sent. The host bound its wait to "the next turn ending" and watched the wrong
  one end.

  It now reads attention at the instant of delivery; if a turn was already running, that turn must end
  before any later busy→idle edge can close the wait. The mirror of `t-4c82fa`: require the evidence,
  not the label. The timeout was deliberately left alone — ten seconds was never the problem.

- **Three more content submits stopped sending blind Enters** (`t-ff34db`). The continuity nudge, a
  schedule's `instructions` when the agent is already up, and the resume primer. Their payloads were
  already durable elsewhere, so what was at risk was the *waking*, not the information — but a blind
  Enter also leaves text in the composer, which is what deafens an agent.

  The real fix was not swapping the call. In both continuity paths the code now returns **before**
  marking the agent nudged or restored when the receipt is unconfirmed. Recording "already delivered" for
  something that never left would have traded a silent loss for a loss filed as a success.

- **Two call sites joined the standard instead of inventing a third** (`t-b805b5`, `t-2c2384`). The
  validation-close wake injected with a bare submit while its twin — approval resolution — had been
  queue-aware for weeks; it now reuses that twin's port literally. And the Agent Pane's freeform submit
  omitted the composer profile, falling back to a heuristic that cannot see a wrapped draft, so a long
  human message was reported as delivered while still staged.

- **Four runtimes measured for how their composer wraps** (`t-ba5357`). Without a measured rule the
  region reader reads a long draft in half and classifies it as delivered — and that wrong
  classification is what previously *disabled the retry loop* built for exactly this failure. The
  threshold is `pane_width − 4`; Tachyon panes are 220 columns and 92% of measured notices exceed it.

  Claude and Hermes now have declared continuation rules, from real 220-column pane captures. Grok and
  OpenCode were measured and deliberately **not** declared: Grok's continuation rows keep the left
  border, which the current reader preserves, so a regex alone cannot recover the text; and OpenCode's
  pane shows only `[Pasted ~1 lines]` — the bytes never appear at all. That second one is not "not yet
  measured", it is not observable through the pane, so *unconfirmed* is the permanent ceiling there.

### Internal

- **The delivery inventory that made all of the above one decision instead of eight** (`t-a5b186`).
  Twenty-one paths write into an agent pane; each was read at the call site and recorded with its
  primitive, whether the payload is durable, whether a retry exists, what receipt the caller sees, and
  who pays when it fails. Three primitives were doing the same job at three qualities, and the best one
  had existed since an unrelated fix without ever being generalized.

  The chosen standard invents nothing: it is the ladder `notify_agent` already runs — persist, knock,
  honest receipt, and the payload survives a failed knock. It deliberately keeps human messages *out* of
  the agent notice log (different origins; mixing them would pollute what agents pull), and it answers
  the unmeasured-runtime case explicitly: the ladder still applies, `submit-unconfirmed` is the honest
  ceiling, and nothing shows a green check it has not earned.

- **The activation refusal is fail-closed for fleet interpretation, not for the workspace** (`t-613361`).
  A question from July, never measured: when activation is refused, the Bridge keeps answering and keeps
  accepting writes. It is deliberate, and the proof is structural rather than empirical — the Bridge
  listener starts in `_create`, before `start()` runs, and the refusal is an early return with a notify
  that touches no teardown path. Now written where the next person will ask.

### Documentation

- **Design Mode panel-land is proven for two runtimes end to end** (`t-ba5027`). The August 6th matrix
  measured with the browser bridge offline, so it only ever proved MCP→handler. Codex and Pi each listed
  and called the reply tool with a turn id, used no markers, and produced exactly one chat-log event and
  one live panel bubble for a unique nonce. Pi moves from unmeasured to partial.

  The last link — a reply resolving an *outstanding* turn — was closed by the maintainer's own test send,
  the same one that exposed everything above.

- **Visual evidence pack for the Design Mode spec** (`t-7f994f`), captured in a real Extension
  Development Host. Verdict recorded as *concern*, not pass: with the selection card and the chat both
  open, the card covers the transcript, so a reply that has landed is invisible until the card is closed.
  Filed separately (`t-330a51`) — a delivery that arrives and cannot be seen is, to the human,
  indistinguishable from one that never came.

## 0.83.0 — a freeze you could feel, a refusal that hid its own answer, and 295 lines nothing could reach

Four of the nine items this round shipped no code at all. Three questions were closed by measuring them
and finding nothing to fix, and one deletion stopped at the door because the evidence that would justify
it does not exist yet. That is the shape of the round, and it is deliberate.

### Fixed

- **Saving a pin no longer freezes the window** (`t-17df02`). The pin store took its cross-process lock
  with a *synchronous* wait — `Atomics.wait`, which stops the extension host thread outright. With a
  second window or a Dev Host beside the first, saving a pin froze the UI until the other process let
  go. The seven mutations now await the asynchronous lock that already existed in the codebase; reads
  never took the lock and stay synchronous.

  **The test is the delivery.** It spawns a real second process that holds the pin lock for 800ms,
  starts a 20ms interval in the waiting process, and then saves a pin — asserting both halves: that it
  genuinely waited, and that the timer kept firing. Under the old code the tick count is zero. The
  comment calling the synchronous wait "a known cost" was corrected in the same commit; leaving it would
  have been the next written promise the code does not keep.

- **A refusal leads with the action instead of burying it** (`t-94273f`). Launch failures were ordered
  product prefix, subsystem prefix, long absolute path, action last — so a fixed-width notification band
  spent its budget on the path and clipped the fix. Lived, not theorised: the maintainer read
  `no credentials at /home/gc`, concluded Grok was unsupported, and asked when it would be enabled. The
  answer, `run grok login first`, was past the clip.

  Seven notification-bound refusal sites were measured; three messages serving four of them were
  reordered, and the tests assert that the action's index precedes the path's — an assertion on
  *containment* would pass with the order reversed.

  **The three credential sites were deliberately left alone.** Their defect was never word order: a
  notice with no actions falls into VS Code's status-bar branch, one cell wide and erased after eight
  seconds. Giving it a button was the fix, and that already shipped. Reordering them now would edit
  something that no longer hurts.

### Internal

- **295 lines that nothing could reach are gone** (`t-83723d`, `t-aec8a0`). `dogfoodBootstrap.ts` (195
  lines) sat in the production shell path with zero importers, its own header noting it was never
  registered — dev scaffolding in `src/webview/` that invites the next reader to wire it up. And a
  dev-host repro scenario drove `Control → Fleet`, a route that has not existed since the section list
  went empty, clicking a test id that no longer appears anywhere in the tree.

  The deletion broke a paragraph in `docs/runbooks/dev-host.md` that taught readers to copy that
  scenario as a template. That was fixed in the same commit rather than deferred: a reference broken
  *by* a deletion is part of the deletion.

- **The IDE browser bridge manager is three pieces with a boundary** (`t-47503a`). 1180 lines carrying
  eight measured responsibilities became a loopback HTTP host, a browser/CDP session controller, and a
  Design Mode adapter, with the engine↔host protocol given real types — a route table, request and
  response shapes, and one shared decoder. The public surface is unchanged and the historical error
  strings are identical.

  Reading it surfaced two facts for the multi-root work (`t-849f52`), recorded rather than fixed:
  `launchBrowser` accepts the first browser child with a matching parent session and carries no
  correlation id, and `resetBrowserSession` stops any debug session whose name contains "Tachyon" —
  including one another manager owns.

### Documentation

- **Which browser product, when** (`t-26232e`). Tachyon has three and they are not interchangeable: the
  Integrated Browser with Design Mode for a page the human and agent share inside VS Code, the Companion
  for the human's own signed-in tabs, and the agent-browser plugin for headless work the agent owns
  alone. One page: when to use each, when not to, what must be running, the tool namespace per product,
  what fails closed, and cleanup.

- **A race on Design Mode send is recorded as an accepted boundary** (`t-a7d951`). Between the probe that
  reads the composer and the tmux write there is a window with no compare-and-send, so a draft typed
  inside it can be submitted together with the prompt. This was chosen — the alternative was the
  multi-second stale read it replaced — and closing it needs a different transport, not a claim that the
  probe is atomic. Written down so it is not "fixed" later by someone who does not know it was a
  decision.

### Measured and closed without code

- **No test in the tree is a time bomb** (`t-ab17f8`). Thirty test files carry literal dates (the task
  said 21; the count was wrong). Twenty-nine are safe by construction — the frozen date is *injected*
  into the code under test as its clock, so the result never changes. The one genuine bomb, a fixture
  aging against the real clock, had already been fixed. Nothing to change.

- **Crash-loop on resume cannot happen as configured** (`t-7525c6`). Auto-restart is gated on a per-agent
  `restart: on-crash` policy that defaults to `never`, and no agent sets it — so the path that would
  resume a session into the crash that killed it is unreachable here. Not "has not happened yet":
  cannot, today. The existing backoff and give-up guard bounds it for anyone who arms the policy.

- **Deprecating the Design Mode pane markers stopped at its own precondition** (`t-45b266`). The spec
  requires the runtime matrix to be green first. It is half green: three runtimes are proven to *call*
  the reply tool, and none is proven to have the reply *arrive* — the panel-land column is unmeasured
  because the bridge was offline when it was taken, and two runtimes were never measured at all.
  Deleting the fallback on that evidence could leave a runtime with no working voice, and the headless
  test would not catch it, because it measures the call and not the arrival. No lines were changed.

## 0.82.0 — the last two places where VS Code's chrome stood in for ours

The maintainer's rule is that Tachyon builds its own pickers. Two sites resisted for measured reasons,
and both are gone here — one because the styles finally separate from a font the terminal cannot load,
the other because what was missing was a component, not a second picker.

### Added

- **A PR form that belongs to the product** (`t-f3ded3`). "Open a pull request" in the land block asked
  for the title through VS Code's input box and confirmed through a native modal with the body crammed
  into a detail line. It is now a `ConfirmForm` in the design system: editable title, scrollable body
  preview, the base branch and dirty-tree lines as real meta, and Confirm/Cancel.

  The authority split did not move: the host still owns readiness probing and PR creation, and the
  surface only collects. The probe still happens **at the click** — the draft is composed then, and
  confirming does not probe again — which is the property that makes the button safe on a polled
  dashboard. Closing the panel mid-flow cancels and creates nothing. At 360px the layout stacks; a
  field beside a multi-line preview is exactly the shape that collapses there.

- **The product's picker now draws inside the Agent Pane** (`t-de3dfc`). That surface deliberately
  refuses the design system, because the Tachyon Mono `@font-face` breaks xterm's cell metrics — and
  the picker's rules lived only in that sheet. They now live in a font-free layer linked beside it, so
  nothing is duplicated and the font exclusion holds.

  **The risk was measured before anything moved**: the picker listens for keys in the capture phase on
  `document`, and the Agent Pane is a live terminal that forwards keys to tmux. A focused probe
  confirms filter text, arrows, Enter and Escape never reach the pane's input.

### Fixed

- **Removing an agent retires its file-shaped bridge config** (`t-652153`). End-of-life retired only
  the directory-shaped runtime homes, so a `bridge-mcp/<name>.json` survived every removal. Measured
  along the way, and reported rather than swept: seven such files were orphaned, four harness homes for
  absent agents hold 330,215,424 allocated bytes — retained by design — and the size receipt the tool
  promises is a host notification that counts neither.

- **A refusal stops sending a terminal to doors that do not serve it** (`t-849277`). `dismiss_agent`
  called a declared terminal a "Saved Agent" and offered removal-proposal and Agent Studio, neither of
  which applies to it. The cause was vocabulary: `saved` is a *lifetime*, shared by profile-backed
  agents and declared terminals, and the refusal keyed on it. Terminals now get their real door — the
  sidebar's Remove, or the `config.agent.delete` operation that action invokes.

### Internal

- **A memory crash is diagnosable after the fact** (`t-bd9c61`). The vitest budget ledger lives in
  `/tmp` and holds only live claims, so a reboot erased any answer to "how many suites were running,
  whose, and how large". Moving it alone would not have helped — the next admission reaps dead PIDs and
  rewrites the file empty — and refusals never wrote it at all. One append-only line per admission and
  refusal now survives, with the siblings alive at that instant. Volume was measured before choosing a
  bound: at a peak of 63 gate runs a day, this is roughly 23 MB a year, so there is no rotation. It
  does not prevent the crash or reduce memory use; it only makes the question answerable.

## 0.81.0 — three doors write into a pane, and all three now read it at the moment they write

Tachyon delivers text into a running agent's terminal through three doors: the Interface (you typing a
prompt), an Agent (`write_input` / `notify_agent` over the Bridge), and Tachyon itself (queued
notices). Each decided differently whether the pane was free, and each could be wrong in its own way.
This release makes the three read the same region, with the same runtime-measured rule, at the instant
they write.

### Fixed

- **The Interface door stopped deciding from a stale poll** (`t-344fa6`). `prompt.inject` read composer
  occupancy from the attention poll rather than from the pane, so a human draft created after that poll
  could be overwritten — and it submitted without the runtime's composer profile, falling back to the
  legacy last-line heuristic that this release's predecessor replaced. It now probes immediately before
  writing, keeping the cached value only as the fallback for runtimes with no measured signal, and
  passes the profile so the same region reader governs it. Twelve lines of product code: the machinery
  was already there, built by the other two doors.

- **A queue overflow leaves a durable record** (`t-2153ae`). Dropping the oldest notice past the
  per-recipient cap only ever produced a transient toast, so the loss could not be counted after the
  fact. It is now an `overflow-drop` event in the doorbell trail, with its own shape so that
  `read_notices` and completion checks never mistake it for a doorbell.

  **The proposed fix was refused on its own measurement.** Making the queue visible — a new projection
  and UI — was the recommendation; the numbers behind it were a live queue of zero, zero recipients with
  a pending queue, zero observed overflows, and 91% of new notices already lifted out of the broken
  class by the previous release. Building a surface for a condition that does not occur is the wrong
  trade. What was worth fixing is that the event left no trace at all, which is why "it never happened"
  could not be demonstrated. The record does not limit the wait, expire an authored report, or prevent
  a stale delivery — it only makes a previously silent loss measurable.

- **A studio that fails to load names the surface, not an invented entity** (`t-831332`). The error
  screen said "New Agent" for a document that never loaded, because the error envelope carries no
  identity, and it offered a Save with nothing to save. The title now states what the screen actually
  knows — which studio it is, and that it failed — and the dead action is gone. One shared surface, not
  eight shells.

- **A dead pane stopped reading as alive under a non-UTF-8 locale** (`t-86f3e6`), where tmux substitutes
  its field separator and the helper meant to prevent exactly that had two holes of its own.

## 0.80.0 — the product stops claiming what it has not verified

Six defects here share one shape, and it is the shape this codebase produces most: a surface
asserting a state nobody checked. A Stop reported success 600 ms after sending keys. A dead row
offered the toolbar of a live agent. A fresh agent was called busy and refused *the human's* own
prompt. A discarded config line lived only in a toast that vanished. And every delegated subagent
carried eleven skills its delegator was never granted.

### Added

- **Landing a worktree is a product operation** (`t-7cb971`, SDD 498). The crossing from a worktree to
  the trunk now happens inside Tachyon, in the shape the Forget flow already uses — and the agent
  still cannot perform it.

### Fixed

- **A delegated subagent receives exactly its delegator's grant** (`t-53e485`). Measured across eleven
  agent homes: the parent profile granted three skills, the parent's home held three, and **every
  delegated child held eleven** — the workspace's installed plugin set. The delegable toolkit started
  from the parent's snapshot and then unioned every `skill-dir` in the plugin lockfile, treating an
  install as a second grant door.

  It is not one, and the measurement says so rather than the principle: `.claude/skills` and
  `.agents/skills` are gitignored, so no worktree holds them, and every parent's private home carried
  exactly its own grant — nobody held the eleven. The door even invented a grant, handing one child
  eleven skills delegated from a parent whose profile grants zero. Two of the eight extras are not
  decorative: one is paid image generation, the other drives a real browser. Codex leaked identically,
  with only the delivery target differing, which is why its home looked empty.

- **Stop reports what happened** (`t-22944a`). It sent `C-c`, waited 300 ms, repeated, and resolved
  **successfully** without checking whether the process died; the truth appeared only when a later
  refresh reclassified the row fifteen seconds on. Measured on Grok 1.0.0 mid-turn, successful exits
  land at 992–1032 ms, so confirmation waits two seconds — not the fifteen that would block a click.
  Stop now answers `stopped`, `alive` or `unknown` where it answered one success for three outcomes.
  Forced Kill stays an explicit human gesture; nothing escalates on its own.

- **A fresh agent is no longer called busy without evidence** (`t-4c82fa`). The initial `working` label
  is synthetic — measured, the window is 9 to 12 seconds — and three action gates trusted it, including
  the one that refuses **your** prompt. The seed stays honestly unknown; the gates now require positive
  evidence that a turn started.

- **A discarded config line leaves a durable record** (`t-7d6013`). Every unreadable key warns instead
  of refusing the file — the maintainer's decision — and that put the whole weight on a toast that
  vanished. A dismissible banner now names what the last successful load threw away. It never touches
  config validity, so a typo cannot mark the fleet invalid, and dismissal is keyed to the signature of
  the discarded set: reading once silences that file, and any change brings the record back.

- **A stopped agent no longer offers the repertoire of a running one** (`t-c515c0`). The row for an
  agent the human stopped read `stopped (exit 130)` and carried, beside it, the same bar as a live
  agent: Open terminal, Open agent pane, and a **Kill forced** for a process that had already exited.

  What the doors promised is not in the pane. Measured over the full scrollback on claude, codex, grok
  and pi, a postmortem pane retains exactly ONE line — tmux's own `Pane is dead (status …)` — because
  the runtime's TUI restores the primary screen as it exits. The two comments in the code that
  justified keeping those doors ("the pane still holds the `^C` and the exit code") were wrong, and are
  corrected rather than left behind. A **crash** is the other case and keeps its doors: it never
  restores the screen, so the same measurement read 20 lines back off a killed pane. A requested stop
  and a crash no longer offer the same set — telling them apart was the whole complaint.

  `Kill forced` was not noise, which is why it stayed: on a dead row that command reduces to the tmux
  `kill-session` that reaps the postmortem, and it is the row's only door to it. It is now named for
  what it does — **Collect dead pane** — with its own icon, and it is offered only where there is no
  process left. A clean exit whose pane Tachyon already collected offers neither door; that shape used
  to invent a pane through a fallback that only held while the field was absent.

  The exit code itself is unchanged and still shown. `130` is not a grok convention: measured, bare
  grok exits 0 (9 of 9), while a stop through Tachyon — which starts every agent with its brief as a
  prompt, so the process is mid-turn — exits 130 in 3 of 5 runs and does not die at all in the other 2.
  The number describes what the process was doing, not whether the stop was asked for, so nothing keys
  on it; the intent is still read from the recorded request.

- **The vitest budget stopped failing open** (`t-ad8fd2`) — an unreadable ledger became an unaccounted
  invocation, and two of those could not see each other. A revoked skill stopped surviving in a reused
  private home for the fourth runtime (`t-fc1df8`). A canonical codex agent with no worktree stopped
  deleting the workspace's eleven plugin installs (`t-94d49a`). A pin id is no longer drawn outside its
  lock, so a collision draws again (`t-8cdd0d`).

### Internal

- **Agent isolation, measured per runtime** (`t-5313dc`) — including that Pi cannot be isolated at all.
  Three permanent documents asserted an isolation the parity matrix had no dimension to describe.

- **The suite stopped depending on the machine it runs on.** Zero opencode binary executions in
  `test/unit`, counted rather than presumed (`t-35c998`, `t-64ea85`, `t-ed0f43`); 27 tests no longer
  need host state to exist (`t-b10d93`); one test stopped inheriting `XDG_DATA_HOME` from the host and
  its assertion got *stronger* (`t-86467a`); and `engineSupervisor` fell from 41.4 s to 10.4 s
  (`t-d1f356`) — the single file that set the floor for the entire gate.

- **Two ghosts that were not there.** The gate failed 6% of runs over a leak that never existed
  (`t-ffc5bf`), and the tmux scope oracle kept catching what there is to catch (`t-c1b382`). The
  vsix-smoke was deleting its tree with the tmux server still alive, where the guard could not see it
  (`t-10fda8`).

- **37 specs left limbo** (`t-5507f1`): the right status was already there, buried in prose on the
  status line. Eleven test files stopped pointing at a directory deleted two days earlier (`t-1fa246`),
  and the shipped schema now publishes exactly the keys the parser accepts, in both directions
  (`t-d47b0a`).

## 0.79.0 — an engine upgrade asks before killing a turn in flight

### Fixed

- **Upgrading the engine no longer discards work in progress without asking** (`t-173b8b`). A plain
  reload was already safe; the engine *upgrade* was not, and it is the path a human takes right after
  installing a new build. The window between installing and reloading is exactly when an agent is most
  likely to be mid-turn.

### Removed

- **Self-evolution is gone from the product** (`t-8ea8e0`) — 9,318 lines and 22 files. Not moved,
  deleted. The capability was never turned on for any agent here and nothing of it existed on disk; a
  replacement will be designed from scratch as an installable plugin, following the model a runtime
  already ships natively (a `pending/` directory plus approval as a gesture).

  The removal is broad and deliberate: the whole `src/evolution/` tree, the evolution leg of the
  formation authority vector, the `submit_evolution_review` Bridge tool (inventory 79 → 78), what the
  engine protocol carried, the toggle and section across **five** studio shells with their 38
  localized strings and 37 CSS rules, the `selfEvolution` config key in parser, writer and schema, and
  ~230 lines of authority-head in the workspace along with its secret.

  **The proof closes by identity, not by absence of a word.** Each case asserts the exact set a surface
  accepts — config keys, reference kinds, the Bridge tool inventory, prompt layers, formation lanes,
  forget-plan steps — so reintroducing the machine means adding a member to a declared set, and a set
  comparison fails under any name. Demonstrated by injecting a reference kind called `growth`, which a
  search for "evolution" would never catch.

  Three things surfaced during the removal and were reported rather than worked around: the parity
  matrix contained no mention of evolution at all, so there was nothing to correct there; 59 completed
  tasks carry an inert `evolutionCompletion` marker on disk, dropped on read and gone on the next
  write, needing no migration; and `gcLedger`'s "the ledger line survives for a retry" guarantee is no
  longer reachable, because it only held while an evolution step could fail before the line was spent
  — the test now asserts what remains true.

  Visual QA after the fact (`t-475b9b`): the seam where the section used to be measures 12px, the same
  as the column's median gap, with zero empty boxes and zero overflow across four routes at two widths.

### Internal

- **The skill grant is checked for every runtime, and a revoked skill leaves disk** — see 0.78.0; this
  release carries the live proof: starting `grok` with an empty selection removed three skill trees
  that had survived every regeneration since 07/08.

## 0.78.0 — granting a skill worked; taking it back did not

Removing a capability from an agent's profile left the files on its disk. Measured on the
maintainer's own workspace: the `grok` profile lost its `capabilities:` block on 09/08 at 21:54, the
private home was regenerated at 01:08 the next day, a session ran at 01:57 — and three skill trees
from 07/08 were still sitting there, one of them `agent-browser`, which drives a real browser.

### Fixed

- **A revoked skill is now removed from disk** (`t-987347`). The cause is a routing one: a profile
  that loses its selection produces no projection, so `profileCapabilities` is `undefined` and the
  revocation enters through a *different door* than the grant. Every `if (capabilities)` guard was
  therefore describing exactly the case a revocation never reaches. **Empty is a selection, not the
  absence of one.**

  The purge is now unconditional and runs *before* deciding to re-materialize — but it was not copied
  from Claude's sweep. It removes what each runtime's grant path writes into the private home and
  nothing else, per runtime: `grok` its `skills/` and manifest; `codex` only the manifest, because its
  skill tree lands in `<cwd>/.agents/skills`, a directory the **plugin installer** also owns, and
  sweeping there would delete plugin installs for every agent in the workspace (`t-f842f0`); `pi` only
  the manifest, because its generations are content-addressed and a revoked profile no longer gets the
  `--skill` arguments that are the only way to reach them. Claude was already correct and became the
  test's control.

  All four runtimes were measured rather than assumed: **codex had the defect too**, and pi's residue
  was inert but its manifest lied.

- **The skill grant is now checked for every runtime, not just Claude** (`t-a7063c`). The exact
  host-custodied grant was required only when the adapter was `claude`; the neighbouring mcp, hook and
  generic lines never had that condition. The guard was born in a Claude-specific task and was never
  generalized when delivery to codex, grok and pi arrived. Meanwhile the inspector text the human
  **attests** already promised the check for both grok and codex. Making the code honour the
  attestation is strictly stricter, so no promise changed.

- **A Studio save no longer deletes what the form cannot show** (`t-26ba8f`). Measured round trip:
  `attention: {enabled: true, silenceSec: 30, patterns: [...]}` came back as `attention: true` after a
  save that edited nothing. `env` was found by the same measurement and fixed with it.

- **The Grok preflight stops approving a CLI with no credential** (`t-5dcf47`). Grok 1.0.0 prints its
  model catalog in both auth states — measured with a live credential and an empty home, the only
  difference is the first line — so the catalog never was an auth signal. Authentication is now read
  from the banner, and an unrecognized banner fails to `unverifiable`, never to `supported`.

- **A studio that fails to load says so** (`t-f4e186`). `!ready || !entity` conflated "the host has not
  answered" with "the host answered and sent no document", so an error left the spinner as the
  *terminal* state. Seven of the eight studio shells had it; `pipeline-studio` was already correct and
  became the control.

- **The land card uses the width of the card** (`t-ea5425`), and picking a file to review happens in
  Tachyon's own list instead of VS Code's. Measured at 880px: the block went from 480 of 824 usable
  pixels to 798, and the one actionable line stopped breaking into three.

- **The journal reads back in the order it was written** (`t-c89c52`). Entries sharing a millisecond
  were ordered by a random id — 100 of 200 reads preserved append order, an exact coin flip. The
  tiebreak is now the file's own line order; no persisted format changed.

- **The onboarding template opens clean in the editor** (`t-fe772a`). The product accepted every key
  in `tachyon.yml.example`, and the editor marked two of them red, because the bundled JSON schema had
  fallen behind the parser. A newcomer believes the editor, not the product, and deletes working
  configuration.

### Internal

- **The gate's worker pool is sized by the measured CPU knee, not by free RAM** (`t-fb7025`,
  `t-392418`). Two runs on the same tree: 15 workers → 91s wall and a load-1 peak of 16.67; 8 workers →
  88s and 8.63. The suite is 392s of CPU whose longest single file is 55s, so the makespan is pinned
  regardless. The cap is now **6**, the conservative side of that knee, chosen to be calibrated by use.
  A duplicated `typecheck` was removed from inside the suite — the gate already runs it 35 seconds
  earlier — freeing 46.5s of CPU per run.

- **The test suite stops leaking tmux servers** (`t-8f48da`). 1946 were alive on this host, 1719 with a
  working directory that had already been deleted. Deleting the directory is not cleanup: a server
  whose socket is gone keeps running. Reaping now happens where the private socket is created.

- **The gate stops answering "is this machine logged in?" on the agent's behalf** (`t-a12966`). 8273
  tests swept; skips now declare a reason and `verify-full` names any file whose skips declared none.

- **Notice delivery stops claiming a submit it cannot see** (`t-7a297f`). A wrapped composer line was
  read one row deep, so a 433-character notice was compared against the 120 characters recovered — and
  the mismatch was reported as *delivered*, which also disabled the retry. 92% of notices are long
  enough to wrap.

## 0.77.0 — Tachyon runs without the SDD plugin installed

The maintainer's rule, and the acceptance criterion it produced: *"sdd é plugin e não deve estar no
core do tachyon … o core não deve ser acoplado a nenhum plugin … tachyon funciona sem sdd instalado."*

The core had grown to know one plugin from the inside: it read the plugin's files, parsed its format,
carried its status vocabulary into three separate schemas, and **refused to close a task** because a
markdown file said something other than `shipped`. A project that never heard of SDD carried all of it.

### Changed

- **The core no longer executes the plugin's policy** (`t-73b2e1`, step 1). `assertSddStatusUpdateAllowed`
  refused `status: done` unless a spec file said `shipped`; derived attentions and `RETRIAGE_SDD` /
  `ACTIONABLE_SDD` removed tasks from the work queue by the same reading. All gone.

  That guard also **failed open**, found by accident: a status outside the enum parsed as `undefined`
  and the gate opened — so the check meant to prevent premature closure was disarmed by exactly the
  error it should have caught. It was removed rather than fixed; improving a guard before deleting it
  is work on dead code.

- **The core no longer speaks the plugin's vocabulary** (step 3). `SddStatus`, `SddDerivedStage`,
  `TaskDerived.sdd`, the `missing_sdd_spec` / `sdd_needs_retriage` attention codes, the card fields,
  and the dedicated sections in Board and Task Detail. The seven-status enum had been **written three
  times** — `types.ts`, `boardProjection`, `taskDetailProjection` — a plugin's vocabulary copied into
  three product files.

- **The core no longer reads the plugin's files** (step 2). `resolveSddSpec`, `readSddStatus`, the
  derivation cache, and `managedSddWorkspaceRoots` — which walked the managed-worktree registry to find
  a spec in *another checkout*. Also `scanSpecs`, which scanned `docs/specs/*/tasks.md` for checkbox
  lines and turned them into validation candidates.

  **That last one removed a feature that was used**: 2 of the 8 validations ever created in this
  workspace came from it. It is a convenience, not a mechanism — `create_validation` was always the
  door, and `scanSpecs` only saved typing — but it is a real loss and is recorded as one. The other two
  discovery sources (`.tachyon/tasks` and pins) are unchanged, held by a test.

### What did not change

**The link a task keeps to its spec.** 271 tasks carry `artifact_refs: [{type: "sdd", …}]` and are
byte-identical on disk; `type` was always an opaque, extensible string. The reference still renders —
through the **generic** artifact surface that already shows `path`, `issue` and `task`, rather than a
section only one plugin had. What died is the core *interpreting* the value.

The rule is now two tests rather than a sentence:

```
closes and selects a task with an SDD ref when the plugin and docs/specs are absent
discovers the same task and pin candidates whether docs/specs exists or not
```

**No guard was added against future coupling**, by explicit decision: *"isso é disciplina de projeto,
se não vamos ter mais guard que funcionalidades no sistema."* The guards this codebase does carry were
each earned by a measured recurrence; this coupling happened once.

Of 15 installed plugins, SDD was the only one the core knew behaviourally. `agent-browser` appears in
an external-tool provenance union and **stays** — it reads no file, knows no format, executes no policy.

## 0.76.0 — saving a form stops deleting what the form cannot show

Three defects in this release share one shape: the product answered a question it had never
measured. A Studio save answered "what is this agent's attention config?" with a boolean it had
inferred from a checkbox. The Grok launch preflight answered "is this CLI authenticated?" by reading
a model catalog that is printed either way. The gate answered "is this agent's work green?" by
testing whether the host it ran on happened to be logged in.

### Fixed

- **Saving in a Studio no longer deletes `attention.silenceSec`, `attention.patterns` or `env`**
  (`t-26ba8f`). Every Studio models attention as one boolean, and the writer replaced the whole YAML
  node. Measured round trip, from a save that edited nothing:

      in:   attention: {enabled: true, silenceSec: 30, patterns: ["waiting for approval"]}
      out:  attention: true

  Both fields were live — `silenceSec` is the AttentionMonitor's idle threshold and `patterns`
  becomes its `extra_prompt_patterns` rule — so this was destruction of working configuration, not
  removal of a dead field. `env` was found by the same measurement and fixed with it: same
  `doc.setIn` replacement, same silent loss.

  The carried-forward list is **closed**, deliberately. "Preserve everything the form did not send"
  would be wrong twice: the form deletes *by omission* for the fields it owns (unchecking autostart
  removes the key), and carrying a key the loader refuses for that section would produce a file the
  next save cannot persist.

  The guard does not look for a literal. It asserts that a save which edited nothing is the
  **identity** on the loaded definition, over every entry key the shipped schema declares, with the
  real parser deciding which of them a terminal may carry — and a second assertion requires every
  declared key to have a probe value, so coverage cannot shrink by omission when a key is added.

- **The Grok preflight stops approving a CLI with no credential** (`t-5dcf47`). It resolved
  `supported` whenever the model catalog parsed, on the premise that a logged-out CLI prints a
  sign-in notice instead of a listing. True on 0.2.112; false on 1.0.0. Measured on one host with a
  live credential and an empty home, same session:

      $ diff <(grok models) <(GROK_HOME=<empty> grok models)
      1c1
      < You are logged in with grok.com.
      ---
      > You are not authenticated.

  One line. The catalog block is byte-identical and both exit 0 — so the catalog did not *stop*
  being an auth signal, it never was one. Authentication is now read from the banner line, and the
  catalog is consulted only after the known logged-in banner appears. A logged-out banner, an
  **unrecognized** banner and an unreadable catalog all resolve to `unverifiable`. A future wording
  change can cost a verdict; it cannot turn a credential-free CLI into `supported`.

- **The land card uses the width of the card, and the review picker is the product's own**
  (`t-ea5425`). The land block rendered in the list row's text column, sharing the line with the
  action buttons: measured at 880, it received 480 of the card's 824 internal pixels, and the one
  actionable line on screen — `Fix: run the declared verify gate IN this worktree…` — broke into
  three pieces inside that river. It now spans 798 of 824, with the fix on two lines and its label
  emphasized.

  **Review these changes** selects the file in Tachyon's own filterable picker instead of VS Code's
  QuickPick. The diff itself still opens in VS Code's diff editor — that is the right product for
  the job, and the single-implementation guard still holds: one function builds the pair and calls
  the editor, and it now takes an argument naming *which chrome picks the file*. The sidebar agent
  row and the pipeline's "View changes" stay on the native QuickPick, because they are tree items
  with no surface of their own to draw on.

  The PR form is **not** converted. `gh pr create` needs an editable title, a body preview and a
  confirmation, and the picker is a filterable list; the cost is measured and the slice is open
  (`t-f3ded3`).

### Internal

- **The gate stops answering "is this machine logged in?" on the agent's behalf** (`t-a12966`). An
  agent that delivered 321 lines of markdown got four red tests about agent crash memory, because a
  fixture needed a real credential to materialize a harness. 8273 tests were swept in two labs — one
  strict, one faithful to an agent worktree — and reported separately rather than summed. Result on
  the faithful lab: 4 failures and 98 skips became 0 and 41, with **no skip left silent**.
  `verify-full` now prints the declared reason for any skip and names the files whose skips declared
  nothing. That line found phantom coverage the same day it appeared: three SDD 485 budget guards
  gated on `dist/webview/cockpit.js`, a file deleted hours earlier, skipping on every gate in a fully
  built tree.

- **A non-UTF-8 locale breaks pane reading, and the test that proves it was left red** (`t-86f3e6`).
  Under `LANG` empty, `C` or `POSIX`, tmux substitutes `_` for TAB in `-F` output and `TmuxService`
  splits on tab in two places — every pane reads back `dead:false, pid:0`, so a dead pane is never
  detected and `restart: on-crash` never fires. A declared skip would have hidden a product defect
  behind the fix for a test problem.

- **The Agent Studio `new` preview route shows the screen production actually renders** (`t-547771`).
  Its fixture was built on the legacy form, so the Evolution toggle rendered clickable where
  production keeps it read-only, and the command placeholder offered `agy`, an unattested runtime the
  canonical path refuses. Two earlier tasks had worked around it rather than fix it; both detours are
  now removed.

- **The core stops enforcing the SDD plugin's policy** (`t-73b2e1`, step 1 of 3). Closing a Task no
  longer depends on what a markdown file under `docs/specs/` says, and the SDD-derived branches are
  out of the work queue. Reading and vocabulary remain, deliberately — they are steps 2 and 3, and
  removing policy and format in one commit would mix two different risks. `artifact_refs` is
  untouched: the 271 Tasks that name a spec are byte-identical on disk.

- **Process selectors** — `docs/project-guidance.md` now says to stop only the PID your own spawn
  returned, never a command-line pattern. This was proposed as a source guard and measured out of it:
  `scripts/` and `src/` contain zero `pkill`/`killall`, so the guard would have watched an empty set
  (`t-895ca6`).

- **Documentation weight** — 204 shipped specs distilled, 42,889 lines out of the working tree
  (`t-a46d8a`), and the dogfood harness shortcuts left the repository manifest (`t-f0ea03`).

## 0.75.0 — you can finally look at the code before you land it

The land block has always shown five green checks and a command to copy. It never showed a way to see
what the command would land. Measured on the coordinating agent's own behaviour on 2026-08-09: every
merge that day was reviewed by running `git diff` in a terminal — seven merges, seven trips outside
the product, with the land block open on screen the whole time.

### Added

- **Review and Propose, at the land door** (`t-3eaf77`, SDD 501). Every land block now ends with two
  actions: **Review these changes** opens the changed files in VS Code's own diff editor, and **Open a
  pull request** runs the existing `gh pr create` flow.

  **Neither is new code.** Both features had been built — diff review in spec 213/230, PR creation in
  spec 223 — and both were reachable only from the sidebar agent row, one room away from where the
  decision is made. This spec moved the reach, not the machinery. A guard test holds that there is
  exactly one `vscode.diff` caller, one consumer of the changed-file primitives, and one caller of the
  parser; it carries a self-check that runs its own detectors against synthetic sources with planted
  violations, because a static guard blind to what it forbids passes forever.

  **Tachyon renders no diff.** VS Code already ships the best diff viewer we could put there.

  Review compares **committed history** — `trunkRef..head`, exactly the commits the land command would
  introduce, not the working tree. That was measured rather than assumed, and the measurement inverted
  the plan's guess: the committed comparison is *cheaper* (10.9 ms vs 16.4 ms over a 130-file range),
  because it never stats the working tree and drops the `git ls-files` subprocess. The sidebar and
  pipeline callers keep the working-tree comparison, because there the question is different — what
  has this agent touched so far, including work not yet committed.

  On a **blocked** delivery both actions still appear, deliberately: a red check is when you most want
  to read the code. The line naming the comparison changes with the state — it stops claiming "the
  commits this command would land" where no command is offered.

### Fixed

- **The tooling stopped teaching a command that does not exist** (`t-5a9544`).
  The former npm indirection for Dev Host passed a leading separator, so the CLI answered
  `unknown command '--'`. `t-6e2e44` had consolidated the dogfood surface on 2026-07-30, and that separator became a literal
  argument. **Broken for ten days across ~100 references** — 20 in the dev-host runbook, 15 in the
  CLI's own help, 10 in `point`'s output, and one in `docs/project-guidance.md`, which goes into every
  agent's brief. The tool printed the wrong form and everything copied it.

  Fixed with **one line** in `scripts/dogfood/run.mjs` — drop a leading `--` — so all ~100 existing
  references work again untouched. Rewriting a hundred call sites to accommodate a parser would have
  been the wrong repair. A test asserts both spellings resolve identically.

### Internal

- **The packaged manifest stopped carrying the development environment** (`t-e995dd`). Every installed
  VSIX shipped all 27 npm scripts — `dogfood`, `release`, `runtime:remeasure`, and a
  `vscode:prepublish` that means nothing in an already-published package. `vsce` now reads a
  product-only manifest while the repository's own file is restored byte-for-byte. Recovery runs on
  **entry**, not in a `finally`: a `finally` does not run on SIGKILL, and a crash mid-package would
  otherwise leave a tracked file mutated.

- **Runbooks** — `docs/runbooks/plugins.md` is new (create, update and publish a plugin; publishing is
  cutting the tag, not pushing `main`). `docs/runbooks/dev-host.md` gained the fixture rules: what a
  fixture can seed, and that **managed worktrees cannot be seeded** — a registry entry whose path does
  not exist is reconciled to `abandoned` on load, so checking one in marks its own entries abandoned.
  That gap is why a Dev Host armed for this release's own feature opened an empty screen.

## 0.74.0 — a surface nobody opened is gone, and the ones that stayed stop lying about themselves

The theme is the same as 0.73.0, one layer down: names, comments and signatures that describe
machinery which no longer exists. Five of them were found and fixed in a single day, so they are
listed as a class rather than as isolated fixes.

### Removed

- **The Execution graph, entirely** (`t-af240d`). 62 files, 5443 lines: five modules, three surfaces,
  fourteen test files, the Control tile and every registration. **Measured before removing** — the
  ledger in this workspace held 814 entries, 36 `measured` and 778 `unproven`. The 778 were honest by
  construction (a Bridge call has no child process to carry an id); the defect was proportion. The 36
  proven spawns that justified the surface were buried under telemetry it could never promote, and the
  filters offered Turn/State/Type/Agent — no filter on attribution, the one axis that separates them.
  It had no Bridge tool: Interface-only, and never opened.

  The one real risk was measured, not assumed: `TACHYON_EXECUTION_ID` and `TACHYON_EXECUTION_AGENT`
  were injected into every spawned agent's environment. Nothing read them.

- **The unreachable restart GC** (`t-3e7153`). `toolTransaction.ts` claimed in its header that
  in-process rollback was "backed by recover-on-restart". It was not — `gcAbandonedTransactions` had
  four test callers and none in production. Wiring it was the obvious fix and measurement refused it:
  the collector guarded only the directory UID, never `meta.pid` liveness, so a startup in one window
  could delete an active transaction belonging to another. The function and the claim both go; the
  in-process rollback stays.

### Fixed

- **Persistent instructions can be written, and they reach the agent** (`t-d48775`). Reported twice by
  the maintainer. The textarea was `disabled` for every agent the studio can load, under a hint
  promising a "dedicated profile binding". **Both halves were missing**: the only writer of
  `prompt.instructions` in the whole product was the portable-bundle importer, and the projection
  *refused* the key outright — so the one existing door produced a profile that fell off the roster.
  The text now lives in `prompt.instructions` pinned to `instructions.md`, written through the same
  lifecycle transaction as the rest of the form, and the round trip is held by a test: write, restart,
  read back, and reach the agent's launch.

- **The completion doorbell stops expiring** (`t-93bec9`). `notify_agent` delivers on the recipient's
  working→idle edge with an empty composer, inside a 10-minute TTL. Those conditions are
  anti-correlated for a coordinator: it goes idle exactly when the human is about to type, into its
  pane. Two of three completion reports were lost in one afternoon. `agent-authored` notices — reports
  of what already happened — no longer expire; `host-poke` notices, which assert live state, keep the
  TTL. The distinction already existed in the type; only the TTL treated them alike.

- **The browser gate sees what the suite actually reads** (`t-fbd2ce`). Root discovery followed only
  the imports written in `test/browser/` files — one level. `src/tasks/` never entered, though the
  board app imports `boardModel` from it, so a change to a card's visual affordance shipped with zero
  browser tests. Now depth 2, chosen as the first depth that covers the real case: 11 roots at depth 1,
  22 at depth 2, 26 at depth 3. Still conditional — a docs-only change still runs none.

- **Cost inputs shared, with the divergence declared** (`t-f60468`). Four sizing constants and `envInt`
  existed twice, read the same environment variables, and disagreed on the floor. The disagreement
  turned out to be **intentional** — the free-RAM sizer protects a lone worker at 128MB while the
  host-wide ledger pairs its marginal term with a separately measured fixed charge. The shared inputs
  moved to `shared/`; the ledger's floor got a name, `VITEST_LEDGER_MIN_WORKER_MB`. No effective value
  changed for any operator.

### Changed

- **Overview and Engine are one screen, System** (`t-7b92bd`, SDD 500). They were never two subjects:
  `model.ts` read Overview's counters straight off the object Engine rendered row by row, in the same
  function. The summary now derives from the rows on screen, so no state exists where the counter and
  the card disagree — the one real instance of that being `workspaceCount`, which counts the window and
  now says so.

- **A task's ownership is a ledger, not a field** (`t-a5b9b9`, SDD 499). `assignee` meant two things
  by status: who is executing, and — once landed/done — **who delivered**. The board rendered
  `delivered by`, and self-evolution hung its whole chain off it. Attempts now append to
  `.tachyon/tasks/<id>.attempts`; `currentAssignee` and `lastDeliverer` are derived at read time and
  never persisted. 1051 historical assignees were backfilled, each line declaring itself a backfill
  with a timestamp marked as inferred rather than observed.

- **`reconcile_landed`, and three tools renamed** (`t-77c95c`). The board was the only domain with no
  sweep verb: 190 finished tasks needed 190 calls to close. The new tool follows the existing
  `reconcile_*` shape, defaults to `dry_run`, and journals the individual proven SHA per task — a sweep
  with weak proof would institutionalise the one case where a task was closed with its deliverable
  never merged. `worktree_hygiene`, `worktree_process_hygiene` and `reconcile_worktree_hygiene` became
  `worktree_audit`, `worktree_processes` and `reconcile_worktrees`.

### Internal

- **`src/cockpit/` dissolved** (`t-5a0c1c`). A directory named after the Control surface, which has not
  existed since SDD 485. Thirteen files went to their measured owners, one commit each; the shared
  vocabulary went to `src/sections/` and lost the `Cockpit` prefix. Along the way it surfaced a
  structural fact worth keeping: moving domain code into `src/webview/` changes which typecheck program
  it belongs to, and that program resolves modules differently — an untouched file broke because it
  changed programs, not content.

- **Nine comments stopped describing the removed Execution graph** (`t-2ef65c`). The removal proved
  zero *symbol* residue; comments have no symbols. Sentences claiming a minted turn id, an
  `InternalOperation` sink, and an id carried into the child's environment all described machinery that
  was gone. Rewritten where the reason survived, deleted where it did not. A dead parameter and a
  return type that always returned `undefined` went with them. SDD 480 is marked `abandoned`.

## 0.73.0 — the product stops asserting facts it never observed

Three fixes, one shape: code that wrote down a second fact after observing a first one. A dead process
became "the work was not done". An unreadable directory became "dependencies are fine". A hand-copied
algorithm became "these two files still agree".

### Fixed

- **Process death no longer claims the work was not done** (`t-49d7ec`). `returnUnavailableAgentClaims`
  observed one fact — this agent is no longer executing — and wrote two: that, plus "the task went back
  to triage". **Measured cost: 25 of 68 triaged tasks had already been delivered and merged**, sitting
  in `triaged` because the agent was dismissed after the merge.

  Five different events came through one door — explicit kill, absence at startup, clean `exited (0)`,
  requested stop, and disappearance — and the evidence string already told them apart, unread.

  What forced it: the store refused `active` without an assignee, so clearing the owner — the only
  proven fact — dragged the lane with it. Now `active` without an assignee is legal and means *claimed
  work, nobody executing*. The assignee is cleared because it names the executor that vanished;
  `awaitingHuman` and `evolutionCompletion` are **kept**, because waiting on a human and owing a review
  are not facts about the dead process. `nextTask` and the board's dimming both treat it as claimable,
  and a real crash still frees the claim — each held by a test.

- **"I could not measure" stops being recorded as "everything is fine"** (`t-7681c1`). The refusal that
  guards verification proof wrapped everything in `catch { return null }`, and `null` means *write the
  record*. Worse, that catch was load-bearing for the normal path: a missing `node_modules` throws
  ENOENT. Each throwing call was measured, then the answer became an explicit refusal naming the error.
  Only ENOENT of `node_modules` or of a lockfile still means "does not apply".

- **The last hand-maintained copy is gone** (`t-da6b78`). `scripts/host-resources.mjs` was an ESM twin
  of `src/host/hostResources.ts`, kept in sync by human memory — and it had already cost one defect
  (`t-0b7aa7`, a refusal reporting `0` workers as if it were a measurement). The algorithm now lives
  once in `shared/host-resource-sizing.cjs`; the `.mjs` was deleted. The regression is held by a test
  comparing **function identity**, not names: a faithful re-declaration that delegates to the shared
  module passes `tsc` and every other test, and fails only that one.

### Internal

- **Audit: machinery with no inlet** (`t-e50995`). 145 exported symbols with test callers and no
  production caller were judged; **5 are real missing inlets**, 140 dismissed with a reason. Method was
  TypeScript AST plus both bundles as an independent second signal, never grep alone. The worst is
  `gcAbandonedTransactions`: `ToolTransaction.begin` runs in production and the file header states that
  in-process rollback is backed by recover-on-restart. It is not — an interrupted provisioning
  transaction is orphaned forever. Follow-ups filed, nothing removed.

## 0.72.0 — the project declares what it shares, and the proof refuses to be written when it would lie

Tachyon stops having an opinion about your ecosystem. It also stops telling agents about their
dependencies, which is fine, because a sentence in a brief was never the mechanism — and the actual
mechanism ships here.

### Changed

- **Worktree sharing is declared, not inferred** (`t-5ac1df`, `t-9989cb`). Two lists, following Orca's
  shape after reading their source: `settings.worktree.sharedDirectories` symlinks, `.worktreeinclude`
  copies. They stay separate because copying and sharing are different decisions, and one list with a
  per-entry mode invites getting the default wrong. **No product default** — held by a test that shares
  nothing without a declaration, then symlinks a declared directory in a project with no Node lockfile.
  A PHP project declares `vendor/`, a Rust project `target/`.

  Admission follows Orca's rule: the path must exist, be untracked, and be gitignored. Absent, tracked,
  a glob, a negation or an unsafe path **warns and is skipped** — invalid config never blocks a launch.

  Not copied from them, deliberately: Orca has no divergence detection at all, which is why an
  `npm install` in one of their worktrees silently affects the others. Our SHA-256 over the lockfile
  bytes stays, as a `node_modules` special case, with the limit written into the code — other
  ecosystems share without detection until someone says how to detect.

- **The dependency line left the primer.** It read "node_modules is a symlink to the primary checkout"
  in a PHP project, and its purpose had already died: it existed to warn an agent not to reinstall
  before running the checks the primer used to name, and those checks left in 0.70.0. Orca injects
  nothing of the kind either. The state is still *computed* — link, don't link, undo. What stopped is
  *telling the agent about it*.

- **A run with unclaimable inputs produces no record** (`t-274be9`). This is the mechanism the removed
  sentence was standing in for. When a worktree's `node_modules` is a symlink into the primary checkout
  **and** the two lockfile sets disagree, `verify:full` runs to the end, prints its green, and then
  declines to file the proof — naming which lockfile diverged. Green on screen is not evidence; the
  record is, and the product's only real power is to refuse to write one.

  It refuses narrowly, and each exemption has a test: an owned `node_modules` records, a link pointing
  anywhere else records, identical lockfiles record, and **no lockfile on either side records** — which
  is what keeps non-Node projects working.

### Internal

- **The product stops depending on the tooling folder** (`t-04dfe3`). `src/` was importing from
  `scripts/`, i.e. the extension depended on the development environment. The shared contracts moved to
  a new top-level `shared/`, byte-identical via `git mv`. CommonJS is forced, not chosen: `src` compiles
  as CJS and cannot import `.mjs`, and an `.mjs` run by bare `node` cannot import `.ts`. Both dependency
  rules — the lockfile fingerprint and the divergence reason — now have exactly one definition, consumed
  by the extension and the gate alike.

## 0.71.0 — Soul and Role are gone, and proof of a green run is now a git ref

Ten thousand lines leave in this release, and what they have in common is that nobody was using
them. An agent no longer has a persona or a job title; a verification record is no longer a file only
this repository knows how to write.

### Removed

- **Soul and Role, entirely** (`t-77caa7`). Soul resolution, its lifecycle, its legacy capture, its
  whole transaction subsystem; Role templates and every Role surface in config, runtime, the Bridge,
  the sidebar, Agent Studio, the profile, the schema, the brief and localization. 163 files, ~9,900
  lines net. No migration was written and none was needed: **measured before removing** — no
  `SOUL.md` anywhere under `.tachyon/agents/`, and no agent declaring `role:`. A profile that still
  declares either loads with a warning like any other unknown key.

  What an agent's brief keeps, in this order, now held by a test rather than by hope: persistent
  instructions (with their formation receipt), Evolution, selected memory, the Bridge-guidance line,
  the spawn contract, and the work record. What it loses: the identity section and the role template.

  One thing that lived in the wrong file and survived: the line telling an agent that its CLI's own
  sub-agents run work Tachyon cannot see. That is a fact about Tachyon, not a persona, and it moved
  house rather than dying.

  A defect died with the subsystem rather than being fixed: the Soul transaction could leave a
  directory with no journal, which was then read as a synthetic degraded record matching every
  principal and skipped by reconcile forever. It has nowhere left to happen.

### Changed

- **A verification record is a git ref, not a file** (`t-23c92e`, SDD 497 slice 1). The per-tree proof
  moved from `<git-common-dir>/tachyon-verify/<tree>.json` to `refs/tachyon/verify/<tree>`, pointing
  at a blob with the same JSON. Writer and reader flipped in one commit, and the file path was
  deleted rather than kept as a fallback.

  The reason is not tidiness. The old file was already stored in the common directory so that a gate
  running inside an agent's worktree could be read from the primary checkout. A ref lives in that same
  place and adds the one thing a file cannot have: **it can be pushed and fetched.** That is what will
  let any CI publish the proof with nothing but `git` — no forge API, no token, no artifact download —
  so that a project gets a working land door without adopting a Tachyon script. The rest of that work
  is specified in `docs/specs/497-verify-evidence-by-ref/`.

  Two things were proved before the change was accepted, because either could have sunk it: a record
  published inside a linked worktree is readable from the primary, and a ref pointing at a blob
  survives both `git gc --prune=now` and a push with its object id and type intact.

  Consequence you may see once: records written by earlier builds are invisible, so the land panel's
  `verified-tree` reads red until the next gate run publishes a ref.

- **Board is the only name for the board, in the code too.** The tombstone viewType from before the
  0.65 reversal is deleted rather than renamed; nothing on disk referenced it.

## 0.70.0 — Tachyon stops running your checks

Running a command is something an agent and a CI can both already do. Holding the proof of what was
run, about which content, is something only the orchestrator is placed to do. Tachyon was doing both
and doing the first one badly, so this release removes it: **the product no longer executes a
verification command anywhere.** What stays is the part that was load-bearing — reading evidence.

Two config keys are gone, and they were failing in opposite directions. `settings.verify` was
presented as configuration and executed by nothing; its four commands only ever became sentences in
an agent's brief, and two of them (`prepare`, `affected`) did not even reach that. Meanwhile
`settings.worktree.verify` — the one the product really ran — was never shown to the agent it
applied to. The key that only talked called itself config; the key that acted was invisible.

### Removed

- **`settings.verify` and everything downstream of it.** Four subkeys, the schema, the primer lines
  they produced. A file that still declares the block loads with a warning, like any other unknown
  key — nothing breaks, because nothing executed it in the first place. Gone with it: the line
  telling every agent that "verification applies only when delivering repository changes". That was
  a **cadence** decision, and it belonged to the project, not to a block of the brief that declares
  itself un-overridable. Its stated justification was a mutex inside *this* repository's own gate
  script — our host economics, broadcast to every project as protocol.

- **The verify gate the product ran** (`t-6ca846`). `settings.worktree.verify`, per-agent `verify:`,
  the `verify_agent` tool, the verify badge and its recorded verdict, the field in Agent Studio, the
  `verification` command kind, the verify summary in the PR body, and the pipeline done-contract that
  could wait on a "verify gate". 131 files, ~1,800 lines net. **If you declared either verify key,
  Tachyon will no longer run it for you** — declare it in your CI, or run it in the agent's shell.

### Kept, deliberately

- **The evidence path is untouched.** The per-tree verification record, the land preconditions that
  read it, and the agent-completion signal that reads it all work exactly as before. This release
  removes the *producer* the product owned; it does not touch what consumes proof. The distinction
  worth keeping in mind: what left ran a command and recorded a verdict against a **commit**; what
  stayed reads a record about a **tree**.

- **"A check attests the exact TREE it ran on."** That sentence lived inside the block being deleted
  and would have died by accident. It is a fact about how proof works here, not a policy about when
  to run one, so it now renders unconditionally.

- **The dependency line in the brief.** It still tells an agent whether the checkout it was handed
  has, links, or lacks its dependencies. Only the install hint — which came from the removed config
  — is gone.

Where this is going, for anyone reading the direction rather than the diff: evidence should be
publishable by any CI with nothing but `git`, so that a project gets a working land door without
adopting a Tachyon script. That work is specified in `docs/specs/497-verify-evidence-by-ref/`.

## 0.69.0 — One name for the board, and a proof that has to still be worth something

Two changes that look unrelated and are the same idea: a thing should not be called two names, and
a green should not outlive what made it green. The screen you use has said **Board** since 0.65;
the code behind it still said Mission Control in 95 files. And the land panel was lighting up
`verified` on evidence that the verification gate itself would have thrown away.

### Changed

- **Mission Control is gone; it is the Board, everywhere** (`t-209516`). The label never changed —
  the command has read "Tachyon: Board" for releases — but the code carried a second vocabulary for
  the same screen, and two names for one thing is a tax on everyone who reads it later. 95 files, 17
  of them moved. The one thing you may notice: the command id is now `tachyon.board` instead of
  `tachyon.missionControl`, so a keybinding pointing at the old id needs updating. Nothing else about
  the screen, its state, or its behaviour changed — the release exists to make that claim testable.
  Old records keep the old name on purpose: shipped specs and past release notes describe what was
  true when they were written, and rewriting them would be falsifying a log.

### Fixed

- **The land panel stops accepting proof the gate itself refuses** (`t-40e655`). Three parts of
  Tachyon consult the same verification record and, until now, three of them meant different things
  by "verified". The strictest is the gate deciding whether it may skip work: it demands a record
  that names the environment that produced it, is not from the future, and is not older than a week.
  The loosest was the one arming the `git merge` command a human copies out of the Worktrees panel —
  it checked only that a file existed with the right name. A record the gate would have discarded
  could still turn that check green. It cannot now: stale, future-dated and unattributable records
  are refused at the reader, so every consumer inherits one definition. The environment comparison
  deliberately did **not** move: it is a question only the side that knows the producing environment
  can answer honestly, and the extension host is not that side. The same hardening reaches agent
  completion, which no longer treats an old or unattributable green as evidence that an agent
  delivered.

## 0.68.0 — The fleet leaves the config file, and the form stops lying

`tachyon.yml` is closer to being only configuration: your agents are the directories under
`.tachyon/agents/`, not a list in a file. And four controls in Agent Studio that looked usable and
were not — a field that discarded what you typed, two that were permanently greyed out, one whose
runtime the save would refuse — now either work or are gone. Every one of these was found by asking
the same question of a screen: is there anything here that promises something the code behind it
does not do?

### Changed

- **Your fleet is the directory, not the file** (`t-ae221c`). A folder under `.tachyon/agents/` with
  a readable `agent.yml` **is** an agent. The `agents:` block in `tachyon.yml` is no longer the
  source; a file that still has one loads normally, with a warning saying the block is ignored and
  can be deleted. Nothing rewrites your file for you. The pointer it replaced carried no information
  — it was required to be exactly the path derived from the name — so reading the directory gives the
  same answer with 174 fewer lines of code. Creating, renaming and forgetting an agent stopped being
  two-file transactions, and the whole class of failure "the profile was written but the pointer was
  not" no longer exists. One cost, stated rather than buried: deleting `.tachyon/agents/<name>/` by
  hand used to remove an orphan pointer that had a Forget door; now it deletes **the agent**, and
  what remains is a stranded authority with no door. That is inherent to "the directory is the
  agent".

### Fixed

- **Verify and Setup can finally be set on an agent** (`t-afc86e`). Both fields were rendered
  permanently read-only under a hint promising a binding that no work item carried. They now hold a
  per-agent verify command and per-agent setup commands. This nearly went the other way: the
  recommendation was to delete the controls, which was reasoning from this repository — one test
  suite, and dependency-linking that makes setup unnecessary. In a monorepo a per-agent verify is
  close to mandatory, and outside Node — venv, compilation, module download, codegen, migrations —
  setup is the mechanism, not a luxury. Fixing it exposed something older: the channel that writes
  profile files was **write-once**. Every artifact had been new by construction, so the second save
  of the same field threw. It is now a CAS-guarded replace whose rollback restores the previous
  bytes instead of deleting them.
- **The self-evolution toggle works, and can be switched back off** (`t-f96b2f`). It was greyed out
  while the machinery behind it was complete and had no callers at all. Wiring it up revealed that
  the **off** path did not exist anywhere — and it is not optional: leaving the reference behind
  makes the profile refuse to load, so an agent that enabled evolution and changed its mind would
  stop loading. Turning it on without being able to turn it off would have shipped exactly the defect
  this release exists to remove. A proposal, separately, can never grant evolution: creation refuses
  it explicitly instead of granting it silently.
- **Creating an agent on a runtime Tachyon cannot attest is refused, not offered** (`t-d68b8b`).
  Quick Add showed the chip and the save then refused it, sending you back to the form you were
  already in. Creation is limited to the attested runtimes — claude, codex, grok, pi — and the
  refusal says the limit belongs to the creation path, not to the runtime. The list is read, never
  copied, so attesting a runtime opens the form with no further edit. There were **two** doors, not
  one: an agent proposing a saved agent could name any runtime as free text.
- **Watch patterns is gone from agents** (`t-bd14d8`). It restarts the process when files change,
  which is what a terminal wants and the opposite of what an agent wants: a file save killed the
  session outright and started a new one, with no resume. Removing the field was not enough — a value
  already stored survived every subsequent edit untouched, so the first save now clears it.
- **A terminal is no longer matched against Claude Code's prompts** (`t-c59600`). Terminals declare
  no runtime, and the default filled in `claude`, so `npm install` asking `Ok to proceed? (y)` was
  compared against the patterns of an LLM interface. Neutral is now a scope of its own rather than a
  runtime with fewer patterns. Measured loss: none. Measured gain: eight real shell prompts.

### Internal

- **SDD 496 — the agent/terminal split, planned** (`t-91564a`). The measurement overturned the
  premise: the two types were separated a while ago, and what was never separated is the
  *collection*, which hands out both and makes every consumer ask again. 76 live branches, sorted
  into 28 that become dispatch, 20 that are dead code, and 28 that are legitimate. Five slices, each
  shippable alone.

## 0.67.0 — Stopping, starting, and being told what to do about it

Four things you press and one thing you read. Stop now stops, and stops looking like a crash. A
crash-restart comes back remembering. A launch refused for a missing login hands you the login
instead of a line in the status bar. Three of the four defects here were diagnosed wrong before they
were fixed — the corrections are recorded beside them, because a wrong cause that produces a working
fix is a trap for whoever reads this next.

### Fixed

- **The Stop button now stops Claude** (`t-ab2682`). Three graceful stops in four left the process
  alive, and thirty seconds later Tachyon forced a kill — which takes the session down instead of
  letting the runtime close itself. It exits cleanly in 11 of 11 runs now. The recorded cause was
  wrong and the measurement overturned it: the slash-command menu never swallowed the Enter. `/exit`
  was typed into a composer that still held the agent's spawn brief, and the pair went to the model
  as a prompt. The composer looking empty afterwards — the thing that made this read as a lost Enter
  — was the brief losing the race. The obvious fix was tried and **rejected on evidence**: a fixed
  600 ms delay failed at exactly the old rate, 3 in 4, while a 6–13 ms gap into a free composer
  succeeded 13 of 13. Time was never the variable. The rule is now composer occupancy: type only
  into a composer proven free, press Enter only while it proves it holds exactly that text. The
  defect was in the delivery mechanism, not in Claude's stop profile, which was right all along.
- **Stopping an agent no longer looks like it crashed** (`t-9d76b1`). You stopped `grok` and the row
  went red: `exited (130)`, the same badge an agent that died on its own gets — with `resumable`
  right beside it, one badge saying it broke and the other saying everything is fine. 130 is
  128+SIGINT: the *correct* exit of a process that honoured the Ctrl+C Tachyon itself sent. The
  product was asking one question — "was the exit code zero?" — and using the answer for a different
  one: "did this die, or did I stop it?". The intent was never in the number, and no adjustment to
  the number could put it there. Tachyon now *remembers* asking. A stop you ordered reads `stopped`,
  keeps the real exit code beside it instead of a fabricated `exited (0)`, and keeps its pane open
  for inspection; the memory survives a window reload, and the next start forgets it, so one
  instance's ending never describes the next. A genuine crash still reads as a crash — including one
  that happens to exit 130, which is exactly what a special case for that number would have erased.
  The Activity record stops calling an ordered stop a *failure*, and — the part that was worse than
  cosmetic — an agent with `restart: on-crash` is no longer resurrected seconds after you stopped it.
  Measured on all six runtimes rather than assumed symmetric (`node scripts/dogfood/run.mjs stop-exit-codes`):
  grok and hermes answer a requested stop with 130, codex, opencode and pi with 0. One more finding
  came out of running it more than once: claude's stop only *sometimes* stops claude — three failures
  in four runs — which is why a single earlier measurement called it fine. Filed as `t-ab2682`, marked
  honestly in `docs/runtimes/parity.md` row 7, and not papered over here.
- **An agent that crashes and restarts comes back remembering** (`t-f6aa7c`). With `restart: on-crash`
  it used to come back on a brand-new session: hours of context gone, and you found out when it asked
  something already answered. It now resumes. When there is nothing to resume — a first crash, an
  aged-out transcript, a runtime with no resume — it opens a fresh session **and says which of those
  it was**, instead of leaving you to infer it from behaviour. A terminal still comes back blank,
  which is correct: `bun run dev` has no memory to keep. The prior choice turned out not to be a
  choice: spec 389 recorded the crash case as "unchanged" and listed auto-resume on crash as a
  non-goal, so nobody decided this — it was deferred and became behaviour by omission.
- **A launch refused for a missing login hands you the login** (`t-2656d7`, SDD 495). You started a
  Grok agent and the status bar said `no credentials at /home/gc` before erasing itself. The rest of
  that sentence — `run grok login first` — was past the clip, so you concluded Grok was unsupported.
  Tachyon knew the answer and printed it where sentences cannot be read. The refusal is now a
  persistent notice naming the runtime and the agent, carrying a **Log in** button that runs that
  runtime's own login in an editor-tab terminal you can type into, and a **Retry** you press when you
  are ready — Tachyon does not start the agent for you. The whole defect was an empty actions array:
  with one, the same channel produces a notice that waits; with none, it produces eight seconds of
  status bar. That invariant is now a pure function asserted for every runtime, so an edit that drops
  the actions fails a test instead of quietly returning to the status bar.

### Internal

- **Tests that pin an address instead of a rule** (`t-60fcfc`, `t-c189ba`). A test pinned
  `Workspace.ts:3527`. That file has ~6900 lines, so any edit above that point — on any subject —
  turned it red, and in one day it produced two false failures and a merge conflict between two
  agents working in unrelated regions. A test states a rule; a line number is the rule's address
  today. 776 tests were swept; one more was genuinely broken and is fixed: it counted three
  occurrences of a crash-reporter switch, which went red on a correct fourth configuration and stayed
  green on one that dropped the switch — wrong in both directions at once.

## 0.66.0 — Nothing is left behind, and nothing you cannot undo

An operation that fails in the middle used to leave state nobody cleans and nobody can name. Six
of them are closed here, found by one measurement that went looking for the shape rather than for
a bug. The rule that closes most of them is the same: let the thing that owns the state say no —
`rmdir` refuses a directory that is not empty, and `git worktree remove` refuses a checkout with
work inside. A refusal from the kernel or from Git cannot be raced; a check written in front of a
delete can.

### Fixed

- **A launch that fails no longer strands the agent, and you can unstick it yourself** (`t-d29398`).
  Starting an agent creates its checkout and locks it while it prepares. When preparation failed —
  a missing runtime credential, say — the lock stayed. Fixing the real cause was not enough: every
  later attempt was refused because of the first attempt's own residue, with an instruction to
  "unlock explicitly" that the product offered no way to carry out. Now the failing launch discards
  the checkout it just created and never delivered, and Control → Worktrees has **Release lock**,
  which shows what is inside — commits, uncommitted changes — before anything is released. The five
  refusals that used to give an impossible order now point there, and they distinguish Tachyon's own
  interrupted-launch quarantine from a lock a human placed.
- **Removing an agent stops leaving the shell of its folder behind** (`t-4a1f85`, `t-8b58b3`). Two
  removal paths deleted the contents of a profile home and left the directory: one unlinked
  `agent.yml`, the other removed only the `evolution/` subfolder. And the one sweep that reads that
  directory *enumerated* it and then *measured a file inside it*, so residue it had just listed came
  back as "absent: there is nothing to remove" — a false negative delivered as proof. The sweep now
  names it, and the refusal hands over the one command that tells empty residue from real work by
  refusing.
- **Deleting a declared terminal cleans its footprint** (`t-af4a5f`). The roster row was deleted
  first and the footprint second, with no journal between them, and no startup reconcile that could
  ever revisit it. The order is inverted: the footprint goes first and the address goes last, so an
  interruption leaves an entry that is still listed and still removable instead of debris nobody can
  name.
- **One attempt to give a Soul to a terminal no longer freezes Soul for the whole workspace**
  (`t-359469`). The gate asked "is this name declared?" instead of "is this an agent?", so a
  `terminals:` entry passed. It then died in a place that left a transaction folder with no record
  inside, which the product reads as a broken transaction belonging to *everyone* — and nothing ever
  clears it. Every Soul change in the workspace was refused from then on. The gate now sits at the
  single funnel every mutation passes through, runs before anything touches disk, and its refusal
  says what is actually wrong instead of "not declared in tachyon.yml", which was false.

### Removed

- **The Fleet app is gone; the sidebar's Agents tab is the fleet** (`t-5f2b5b`). The Control tile,
  the editor tab and the "open agents as editor tab" button all go with it. The previous release had
  already made both surfaces render the same roster with the same nine statuses, so the second one
  stopped earning its keep. The guard that matters survived the deletion and got stronger: it still
  forbids the fleet from painting a boolean running/stopped list — the defect where a wedged agent
  read as "Stopped" and one waiting on input read as "Running" — and now also requires the status
  union to stay nine wide, so the defect cannot return by collapsing the type instead of the markup.

### Changed

- **An invalid `tachyon.yml` warns instead of taking the fleet down** (`t-48dd8d`). One mistyped key
  anywhere in the file used to make the whole workspace refuse to load. Now the bad key is discarded,
  a warning names it, and everything else loads. Two failures remain fatal, and only because they
  leave nothing to salvage: bytes that are not YAML, and a root that is not a mapping. Reading
  forgives; writing does not — the product still refuses to save bytes it has just called unreadable.
  There is no exception to the rule: a discarded key falls to its normal default, including where
  that default is the permissive one. That was an explicit decision, and it is pinned by a test so it
  cannot be quietly reversed.

### Internal

- **SDD 495 — runtime login and auth recovery** (`t-9b5457`). A measured proposal, not an
  implementation. It traces why a launch refusal that contained the exact fix never reached the
  human: that branch sends the message to the status bar, which truncates it and then erases it. The
  same condition mid-run passes a button and survives as a dialog. It also corrects a standing
  assumption — the per-runtime "preflight" files check the model catalog, not authentication — and
  measures what each of the three main runtimes really needs to log in.
- **The orphan hunt** (`t-bbe760`). The measurement that found the four residue sources above, with
  every origin traced to a line, a verdict in three lists including "could not decide", and two
  reproductions that run.

## 0.65.0 — The screens say what they know, and stop hiding what they don't

Every change here shortens the distance between something being true and you being able to see it.
A refusal that names the field. A merge command that shows what proved it. A history that admits
when nobody can prove a human decided.

### Added
- **The tmux app opens on the project you selected in the sidebar** (`t-6b5dea`), and says what it
  hid. Its universe is larger than the other apps': it lists sessions from closed folders and other
  windows, which no attached-project selector can name — and those are exactly the ones you open
  tmux to find when something went wrong. So a default nobody chose declares that it narrowed the
  screen, names the project, counts what is held back, and carries the way out with it. The
  disclosure disappears the moment you pick a project by hand.
- **The Human Inbox shows what you already decided** (`t-cede16`), filtered by state, type, result,
  period and search. Each line names who resolved it — including when the honest answer is
  `unattributed:vscode-command`, which means nobody could prove a human did. The screen does not
  invent a name.
- **The worktrees panel hands you the land command, already checked** (`t-7cb971`). Five
  preconditions, each showing what proved it. When one is unproved the command is withheld, because
  one that would fail wastes your time and one that would succeed would land something nobody
  verified. Each refusal carries a Fix line, and distinguishes *not measured* from *not true* — a
  refusal that names the wrong reason sends you to fix the wrong thing. The product still never
  moves the trunk, and a source guard refuses any `git` call under `src/` that passes `merge` or
  `--ff-only`.
- **`npm run runtime:remeasure`** (`t-0ac2e9`) re-measures four runtime facts compiled into the
  product. Three hold; native-memory suppression reports **NOT MEASURED**, with the reason — proving
  it needs two authenticated, quota-consuming sessions, and feature status is not evidence of
  consequence.
- **Design Mode edits are persisted** (`t-9d3919`). When the agent proposes a change it can send the
  patch — summary, files, diff — and the host validates and records it, so what changed outlives the
  page.

### Fixed
- **The sidebar names the field that overflowed** (`t-74274c`). It used to show eighty characters of
  clipped JSON; now the status bar reads `fleet.agents[3].focus.full is too_big` and the full issue
  goes to an Output channel. The measurement behind this was taken on the coordinator: a whole
  session spent grepping for a field the error already knew.
- **Whoever you declared owner of a Saved Agent can stop it again** (`t-b5f896`). Lifecycle scope
  read runtime lineage only, and activating a Saved Agent does not create a parent edge. Roster
  ownership is now a separate question, never converted into lineage, so the governance that refuses
  siblings and unrelated members is unchanged.
- **With two windows or two folders, the Integrated Browser stops picking the wrong one**
  (`t-464e2d`). Five measured breaks, including one that mattered: the window singleton was pinned
  to the first workspace folder while config followed the active one, so you could enable and open
  in B while it published and used A.
- **Dismissing an agent stops leaving its runtime home on disk** (`t-7bc276`). Grok and hermes
  materialize that home as a directory while claude and opencode write a file, and both sweeps only
  knew about files — so 35 dismissed agents had reached 2.2 GB. One constant now feeds both the path
  where a home is created and the scan that finds it, and dismissal reports the size it removed.
- **The documented onboarding path loads again** (`t-fe772a`). `tachyon.yml.example` declared an
  agent in a retired inline form, so copying it produced a config the loader refuses. The durable
  fix is the test: the example is now loaded through the production loader on every run.
- **The Saved Agent proposal screen is a decision document** (`t-d343ab`). The digest is shown in
  full instead of truncated — a clipped digest verifies nothing — the facts align in a column, and
  "created enabled; **not** started" has its own callout instead of being lost in prose.
- **The product stops promising a backup it never wrote** (`t-173b96`). Nothing in the codebase ever
  created or read `~/.local/share/tachyon-backups/`; two comments advertised it as if it were a
  feature. The comments now declare the absence, because `tachyon.yml` is not versioned, the product
  writes to it, and losing it costs the whole roster.

### Internal
- **A source guard stops a script from killing the fleet's tmux server** (`t-6ef951`, `t-9713ff`).
  tmux resolves the server from `$TMUX` before it looks at `$TMUX_TMPDIR`, so a script running
  inside a fleet pane that sets only the tmpdir and believes it isolated takes every live agent down
  — which happened three times in three hours. The rule the guard enforces: an invocation is safe if
  it passes `-L <its own socket>` **or** clears `TMUX`; neither reaches the fleet. It parses the
  syntax tree rather than matching text, because the mold it followed matches identifiers inside
  comments and broke `main` twice the same day.
- **The `resolvedBy` guard stops counting reads as writes** (`t-45db7d`). It scanned for the field
  name and flagged a view model that only displays the value; it now finds the write doors through
  the `resolveApproval` import, which also tells a port from a door.
- **`docs/specs/488-ide-browser-design-mode/hybrid-d-path.md`** (`t-d49ef0`) plans the route to the
  ratified destination, and settles the argument with a measurement: nine of the ten pieces of
  visible Design Mode state are destroyed by any in-page link click, and the host sends none of them
  back. Seven decisions are named for the maintainer rather than taken.

## 0.64.0 — What the product creates, it can now read, show and undo

The theme of this release is one class of defect, found four times in one day: Tachyon could
create state it then refused to load, display or remove.

### Fixed
- **A valid `spawn_agent` brief no longer takes the whole workspace down** (`t-a11ac5`). The tool
  capped `instructions` at 2000 on the way IN, then stored the *composed* brief — primer plus
  instructions — with no cap, and the loader refused it on the way OUT. The workspace did not
  degrade: it reported "No Tachyon workspace" and took `verify`, `projectGuidance`, `maxAgents`
  and auth down with the fleet. Size policy now lives in one module that both the projection and
  the tool schemas import, oversized display prose degrades per field, and identities that must
  match exactly are never truncated.
- **A correctly refused Saved Agent can be removed again** (`t-02e72c`, SDD 494). A refusal
  dropped the agent from `config.agents`, and all three removal doors asked `config.agents`
  whether it existed — so Forget hung on "Computing what this will do…" forever. Membership and
  runnability no longer share one map.
- **Creating an agent no longer fails on a leftover directory** (`t-760d53`). A path that exists
  but is not a Git checkout was reported as a preserved quarantine lock. It now says what it is
  and that removing it is safe.
- `${PLUGIN_ROOT}` is substituted when a plugin's MCP server is rendered (`t-b6180e`). Latent —
  0 of 15 installed plugins use it — and the un-merge stays exactly reversible.
- The continuity brief stops re-ingesting Tachyon's own framing (`t-fe9fca`). A stored `STALE:`
  prefix used to make a freshly written brief claim forever that it was behind.

### Added
- **`reconcile_roster`** names which records disagree about a Saved Agent, and **which door would
  remove it** (`t-6c029b`, SDD 494 Part 4). Five states derived from four presence facts; nothing
  stored.
- **`worktree_processes`** reports processes that outlived their worktree (`t-1926ce`). It
  reports only — killing another process stays the human's. Post-dismiss retention is now
  disclosed before you dismiss, including that it differs per runtime (`t-23ee99`).
- The packaged VSIX smoke now opens a door **with the engine running**, on an Electron extension
  host (`t-a8e1f7`). This is the half that was uncovered when 0.57.0 shipped broken past two
  reviews and a green gate.
- Runtime Ops shows the CLI version a behavior was measured on against the one on `PATH` —
  match, drift, or unknown (`t-1322b5`).
- `claim_task` accepts several task ids, all-or-nothing, and rolls back every claim if a later
  one or the launch fails (`t-66c4d7`).

### Changed
- `exit-empty` is reserved and forced off (`t-9713ff`). A single tmux server hosts the whole
  fleet, and it must not be able to end itself when it briefly holds no sessions.
- `role: custom` in a canonical profile is refused instead of accepted and delivered empty
  (`t-7d8744`).

## 0.63.0 — The engine starts on a local extension host

### Fixed
- **A packaged stable build now starts its engine on a local (non-remote) extension
  host** (`t-d11d57`). `process.execPath` there is the VS Code binary, which is Electron,
  and Electron does not start once copied out of its installation — activation died with
  `EngineSupervisorError` after 12.8s, taking Board, Fleet and Activity with it. Tachyon
  now detects Electron and resolves a real Node from `PATH`, validating each candidate by
  running it: the probe requires `versions.node`, a null `versions.electron`, and the
  candidate's own `process.execPath` to match, so a shim that execs something else is
  rejected by behaviour rather than by name. Remote hosts already had a real Node and are
  unchanged. When no Node is on `PATH` the failure is now a named
  `NODE_RUNTIME_NOT_FOUND` with instructions instead of a timeout.
- **The session panel no longer reports "nothing withheld" to a session that predates a
  gate** (`t-d848e4`). It recomputed from today's lockfile, which answers what the next
  spawn will do — not what this live session received. Sessions born before an install
  now say so, with `restart it to receive the gate`.
- A test asserted 32 unique draws from a 16-bit entropy budget, a ~0.76% false red per
  run (`t-ad8d95`).

### Added
- **`settings.ideBrowser.enabled`** gates the Integrated Browser's human surface and
  call-time execution, with first-use tips (`t-48ff4a`). Off by default. Tool
  registration is deliberately NOT gated: MCP freezes the catalog at connect, so agents
  born before the feature was enabled would otherwise never see the tools.
- **`read_notices`** — a durable read door for `notify_agent` doorbells, so a busy
  recipient can read what it missed instead of depending on having been idle when the
  pane flushed (`t-167b5c`, spec 493).
- `get_continuity` now derives your open tasks and pins at read time instead of asking
  you to hand-copy them, and a stale brief leads with its lag (`t-c35335`).

### Changed
- `role: custom` in a canonical profile is refused instead of accepted and delivered
  empty (`t-7d8744`). It promised instructions that canonical profiles cannot declare.

## 0.56.36 — Memory-aware heavy gates (t-019dac)

### Added
- Auto-size vitest `maxWorkers` from host free RAM (scales up if you add memory).
- Fail-closed refuse for `verify:full` / `verify_task(full)` under memory pressure.
- Runtime Ops summary: `hostMemAvailableMb`, `hostMemTotalMb`, `recommendedVitestWorkers`.

## 0.56.35 — Validations Control view v1 (t-da934e)

### Added
- **Control → Validations**: Approvals-parity card list with expand detail,
  close (outcome+note), claim/assign, filters, store-backed VM (not Mission strip).
- Engine `validation.assign` workspace command for human claim path.

### Fixed
- Preserve `verify:full` → `scripts/verify-full.mjs` (t-6a9bc4 lock + maxWorkers).

## 0.56.34 — Hotfix Mission Loading on Control (t-b87bfe)

### Fixed
- Control → Mission stuck on **Loading Mission Control…**: `buildBoardModel`
  was called with a bare snapshot instead of `{ snapshot }`, throwing once the
  board VM arrived and breaking the whole Cockpit App.

## 0.56.33 — Ship t-b87bfe Validations Control tab

### Fixed
- **0.56.32 package note** landed before the feature merge; **0.56.33** is the
  first build that includes Mission strip removal + Control → Validations tab.

## 0.56.32 — Validations leave Mission for Control tab (t-b87bfe)

### Changed
- **Mission Control** no longer embeds the Validations strip (task board only).
- **Control** gains a **Validations** tab with full queue + close UI.

## 0.56.31 — Design-system --ds-accent + kit tokens (t-df7df5)

### Fixed
- **`--ds-accent`** is now defined (was used across panels but never set).

### Added
- Disabled opacity, shadow, motion, z-index, and scrim tokens in the shared
  design system; reduced-motion zeroes duration tokens.

## 0.56.30 — Control health probe without nonce (t-faa36e upgrade)

### Fixed
- **Engine upgrade bootstrap**: when the control `.nonce` sidecar is missing
  (pre-auth engines), only the read-only `health` op is allowed so the
  supervisor can identity-check and replace; other ops stay fail-closed.

## 0.56.29 — Durable pane transcripts (t-6a6a00)

### Added
- **Per-agent `pipe-pane` transcripts** under `.tachyon/pane-transcripts/`
  (0700/0600). Survives kill-session/reload; read path always strips ANSI and
  runs `redactSecrets`.

## 0.56.28 — Persistent control peer auth (t-faa36e)

### Security
- **Engine control socket** requires a per-daemon 0600 nonce sidecar with
  timing-safe verification before request dispatch (dir perms no longer sole
  auth boundary).

## 0.56.27 — Drop stale queued notify after sender death (t-99ccc9)

### Fixed
- **`notify_agent` queue no longer injects obsolete completion lines** after the
  sender is killed. Sender incarnation metadata is bound into the existing
  NoticeQueue stale-source guard (minimal fix, not a full notification redesign).

## 0.56.26 — Hermetic verify path budget (t-b3ca7e)

### Fixed
- **`verify_task` full suite under deep temp clones.** Shorten clone parent to
  `tv-<12hex>`, set `TMUX_TMPDIR`, and keep restart dogfood sockets short so
  AF_UNIX paths stay under ~108 bytes. DaemonStateStore permission test now
  chmod-forces group bits under restrictive umask.

## 0.56.25 — Requester cancel for pending human approvals

### Added
- **`cancel_human_approval` Bridge tool** (`t-ae89d1`).
  Authenticated requesters can withdraw their own still-pending approval as
  `status=cancelled` with an audit reason — no false Deny, no stale Accept,
  no approve-text injection. Host resolve refuses cancelled records.

## 0.56.24 — Reentrant worktree path lock (prune deadlock)

### Fixed
- **Worktree path mutex is reentrant for nested same-path ops** (`t-3fb6eb`).
  `DeliveryProjectionService.prune` holds the path lock then calls `remove`, which
  re-enters the same mutex; the previous non-reentrant chain deadlocked, hung
  Bridge prune/reconcile for 300s, and leaked projection claims.

## 0.56.23 — Governed projection reconcile Bridge tool

### Added
- **`git_delivery_reconcile` Bridge tool** (`t-608f2e`). Linked GitDeliveries with
  `projectionSync=pending` can now drain pending canonical projection intents through a
  caller-authorized path (requires integrate + prune principal rights) before integrate/prune.

## 0.56.22 — Projection intent atomicity + corrupt-quarantine abandon

### Fixed
- **GitDelivery projection ops no longer orphan `projection.intent` events on guard failure** (`t-b3242a`).
  Prune eligibility is assessed before appending a canonical intent; unapplied prune intents that still fail
  guards can be voided by reconcile; `projectionSync` reports `pending` when the canonical intent log is ahead
  of `lastAppliedProjectionSequence`.
- **Approval-only `abandon_without_worktree` works for quarantines with a corrupt holder boundary** (`t-832946`).
  Missing `executionNonce` / mismatched holder no longer leaves a permanent no-exit quarantine; held leases
  still fail closed without process death proof.

### Changed
- **Solo hermes development fleet** may list `hermes` under `gitDelivery.integratePrincipals` /
  `prunePrincipals` so the local coordinator can close linked GitDelivery records without other agents.

## 0.45.1 — Catch a mistyped plugin-root placeholder

### Fixed
- **The install consent now warns when a plugin's hook references a mistyped plugin-root placeholder.** A hook
  command that uses `${PLUGIN_ROOT}` (or any `${…PLUGIN…ROOT…}` token that isn't the real `${TACHYON_PLUGIN_ROOT}`)
  is never substituted — it expands to *empty* at runtime, silently running `/<script>` ("not found") so the hook
  never fires. The Plugins drawer now surfaces a non-blocking warning ("did you mean `${TACHYON_PLUGIN_ROOT}`?")
  before you install, so the footgun is caught at consent time instead of failing quietly in a live agent.

## 0.45.0 — Plugins can enforce a tool's safety flags

### Added
- **A plugin can force a provisioned tool to always launch with mandated safety flags.** A tool declaration may
  carry a `launchPolicy { env, args, denyArgs }` that the Tachyon launcher **always** applies — it force-sets
  env vars (overriding a hostile parent env), prepends forced args, and **refuses** an agent argument that would
  override a policy-controlled flag (fail closed). The forced policy is shown in the install consent and bound
  into its fingerprint, so you approve exactly what the tool will always run with; a corrupt policy refuses the
  lockfile rather than launching the tool unpoliced. Loader/exec-hijacking env (`LD_*`/`DYLD_*`/`PATH`/
  `NODE_OPTIONS`/…) is rejected. The guarantee is **"enforced via the launcher"** — a same-user agent that
  re-executes the raw binary outside the launcher is out of scope (that needs agent sandboxing, not file perms).
- **First consumer — the `agent-browser` plugin's form-driving write gate (2.0.0).** Browsing the web with an
  agent now holds every *common* state-mutating action (click/fill/type/submit/upload/eval/download) for an
  explicit confirmation instead of running it silently; reads stay frictionless, and the gate-disable surfaces
  (`--confirm-actions`/`--action-policy`/`--config`/`mcp`/`batch`) are refused. A best-effort mechanical hold
  plus a human-approval protocol — not a sandbox (see the plugin's README for the honest scope).

## 0.44.0 — Plugins discover newer published versions

### Added
- **"Check updates" now finds a newer release of a tag-pinned plugin.** A plugin pinned to a semver tag
  (`github:org/repo@v0.5.0`) used to re-resolve its *exact* immutable pin, so it was forever "up to date" even
  after the source repo published a higher tag. Tachyon now also resolves the repo's **highest semver tag** and,
  when it is newer, evaluates the update against it — surfacing the available version and, on your confirm,
  re-pinning the lockfile to that **higher immutable tag** (reproducibility preserved: it never floats to a
  moving "latest"). The plugin's own manifest version still decides whether an update actually exists, so a
  monorepo tag bump that didn't touch *this* plugin correctly stays "up to date". Branch / `HEAD` / SHA /
  non-semver pins are unchanged, and a failed tag lookup falls back to the exact-pin check (never regresses a
  healthy "up to date"). A pin to a semver-*shaped branch* is never mistaken for a tag.

## 0.43.1 — No false "nothing to wire" warning for skills-only plugins

### Fixed
- **A skills-only (or MCP-only) plugin no longer shows a misleading "declares X but carries no hooks — nothing
  to wire" warning per runtime.** The install preview checked only for a hooks block, so a portable-skill plugin
  like `sdd` warned for every declared runtime even though each one *does* receive the skill. The warning now
  fires only when a runtime materializes **nothing** for the plugin (no hooks, no skill, no MCP) — a genuinely
  pointless declaration. The install behavior was always correct; only the alarming-but-wrong message is gone.

## 0.43.0 — Plugins provision their own pinned tools

### Added
- **A plugin can declare per-platform pinned CLI tools that Tachyon fetches, verifies, and runs.** This is what
  makes a git-hook gate (0.42.0) fail *closed* meaningfully — e.g. a secrets scanner's binary is now reliably
  present. The author pins `{url, sha256}` per platform (libc-qualified: glibc/musl); Tachyon downloads over
  HTTPS-only with bounded redirects, checksum-verifies the bytes, and atomically installs the executable into an
  immutable, content-addressed `.tachyon/bin/<name>/<binSha256>/<tool>` (`O_EXCL`, `0500`, `0700` parents). A
  mismatch fails closed — the bytes are discarded, never executed. tar.gz/tgz archives are unwrapped with a
  metadata-first, single-file extractor that rejects traversal/symlink/zip-bomb tricks.
- **A dedicated, stronger-than-MCP consent.** The Plugins drawer shows each tool's resolved platform, declared +
  final URL, checksum, and publisher, behind its own acknowledgement — with language making clear the sha256
  proves **integrity against the manifest, not that the publisher is trustworthy**.
- **A re-validating launcher.** A git-hook leaf references a tool via `${tool:<name>}`, which resolves to a
  plugin-scoped `_tachyon-tool` invocation; the launcher re-validates the binary's hash (and ownership/mode)
  against the lockfile before *every* exec — so a swapped binary never runs. Uninstall deletes a tool's bytes
  only when no other plugin references them; a fresh clone (where `.tachyon/bin` is gitignored) rehydrates the
  tools explicitly from the lockfile — never a silent fetch.

## 0.42.1 — Git-hook plugins need no runtime

### Fixed
- **A pure git-hook plugin no longer has to declare a runtime.** A git hook runs on every commit regardless of
  which agent runtime you use — it is runtime-agnostic — so requiring a `claude`/`codex` declaration was a
  vestige that produced a confusing "declares X but carries no hooks" notice. A git-hook-only plugin now
  declares no runtime and installs cleanly with no phantom runtime row or warning. (A skill/MCP capability still
  needs a runtime to install into.)

## 0.42.0 — Plugins can install git hooks

### Added
- **A plugin can now install a git `pre-commit` hook** — a gate that runs on **every commit, for every actor**
  (you, the agent, your IDE), not just when an agent acts. This is what makes a real secrets-scan (or any
  commit-time gate) possible. Because `core.hooksPath` is single-owner, Tachyon installs a **chaining
  dispatcher**: your existing hook runs first, then each plugin's hook, and the commit is blocked if any fails —
  multiple plugins and your own hook coexist. The consent drawer shows the exact command with a dedicated
  "runs on every commit" acknowledgement (it can read staged content and block commits; `git commit --no-verify`
  bypasses it). Removing the plugin restores your prior hook setup exactly and never touches your own hook.
- **Repair hooks** (header button) re-activates git-hooks after a clone whose `.git/config` didn't carry over.

### Internal
- Worktree-correct hook/config resolution (`git rev-parse --git-path`/`--git-common-dir`); a content-addressed
  leaf store + integrity-checked execution manifest + repo-level ownership refcount under a repo lock;
  transactional install (`core.hooksPath` set last) with a fingerprint binding the hook state; the engine
  install/remove/update path is now async. Linux/WSL/macOS only. Spec 264; suite + tsc ×2 + webview build green.

## 0.41.2 — Remove drawer counts skills & MCP

### Fixed
- **The Remove confirmation now shows everything it will delete, not just hooks.** Uninstalling a skills-only
  plugin previously showed "0 hook groups removed" — as if nothing would happen — even though it removes the
  skills, the committed payload, and any empty folders the install created. The drawer now lists **skills
  removed** / **MCP servers removed** / **hook groups removed** (each when applicable) plus orphans kept, with a
  note that the payload and installer-created empty directories are removed too.

## 0.41.1 — Plugin card pill fix

### Fixed
- **An installed plugin's runtime pill now reflects what's actually on disk.** A skills-only plugin installs its
  codex skills into `.agents/skills/` and never creates a `.codex/` folder, so the card wrongly showed `codex —`
  ("not present") even though codex *was* installed. The pill now checks the plugin's recorded materialization
  (its lockfile targets) — so it reads `codex ✓` when the skill is on disk, and only shows `—` as a genuine
  drift signal when a runtime's installed files were deleted out from under the plugin.

## 0.41.0 — Plugins install into a fresh workspace

### Changed
- **Installing a plugin no longer requires the runtime's folder to already exist.** Before, a plugin that
  declared `runtimes: [claude, codex]` would silently materialize **nothing** in a clean repo that had no
  `.claude/`/`.codex/` directory — the consent drawer showed each runtime as "skipped (not present)" and the
  install was a green no-op. Now the **plugin author** decides which runtimes a plugin targets and the
  **installer** agrees in the consent drawer: each declared runtime is a selector row labelled **present** or
  **will be created**, and Install creates whatever structure the selected runtimes need. Deselecting every
  runtime disables Install (never a payload-only no-op).
- **Uninstall cleans up exactly what it created.** The lockfile now records the runtime directories an install
  created (and only those), so removing a plugin removes the dirs it made — never a folder that pre-existed or
  that still holds your own files.
- **Updates keep your original runtime selection.** An update materializes into the same runtimes you consented
  to at install (not whatever happens to be on disk now); if a new version drops a runtime you installed into,
  the update refuses with a clear error instead of silently dropping it.

### Internal
- `previewInstall`/`applyInstall` take the consented **target** runtime set (not `detectRuntimes`-as-gate); the
  selection is bound explicitly into the consent fingerprint; `createdAncestors` is recorded before activation
  (so a partial install still has a complete removal record) and `atomicWrite` cleans its temp on failure.
  Spec 263; full suite + tsc ×2 + webview build green.

## 0.38.0 — Leaner coordination surface

### Changed
- **Retired the free-form shared notes whiteboard.** Tachyon had three overlapping ways to coordinate —
  **pins** (a structured checklist), **notes** (a free-form `.tachyon/notes.md` blob), and the **project
  handoff** (curated state). Notes is gone: discrete findings go to **pins**, narrative coordination state goes
  to the **project handoff** (which is append-safe and distilled — the wholesale `set_notes` overwrite was a
  multi-agent footgun), and a long result belongs in a file or is read with `read_output`. Existing
  `.tachyon/notes.md` files are left on disk untouched; the `get_notes`/`set_notes` Bridge tools and the
  "Open Notes" command are removed.
- **Simpler sidebar sort.** The Agents / Terminals sort is now just **A–Z ⇄ Z–A** — one click on the header
  control flips the direction (the old three-way menu and the live "status" reorder are gone), with a clearer
  sort icon.

### Internal
- Pins and the project handoff are untouched; the Bridge tool count drops from 28 to 26. No behavior change to
  anything that survived; tsc ×2 + engine-boundary + the full suite stay green.

## 0.37.0 — One consistent webview look

### Changed
- **Every Tachyon panel now shares one design system.** The six webviews — the sidebar, Activity, Project
  Handoff, Plugins, Agent Studio, and the tmux Server Inspector — had each grown their own styling, so the same
  element (a panel title, a badge, a button) drifted from panel to panel; titles alone ranged from 16px to 30px.
  They now draw from a single shared stylesheet: one type scale (a **16px panel title everywhere**), one spacing
  rhythm, and **identical badges / buttons / cards / inputs** across every panel.
- **The look follows your VS Code theme.** Every color is driven by your theme's own variables, so the panels
  adapt to whatever you run — **light, dark, or high-contrast** — instead of a hardcoded palette that could fight
  a light theme. Vertical spacing was tightened onto a consistent grid for a calmer, more even layout.

### Internal
- A single theme-driven `design-system.css` (`.ds-*` tokens + components) is copied to `dist/webview/` and
  linked by every webview; each panel keeps only its genuinely panel-specific styling (no re-defined tokens).
  Added a headless render harness that screenshots each panel under both a dark and a light theme. No behavior
  change; tsc ×2 + engine-boundary + the full suite stay green.

## 0.36.0 — Plugin skills

### Added
- **Plugins can now ship skills, not just hooks.** A plugin includes a `skills/<name>/SKILL.md` payload (written
  once), and Tachyon installs it into every present runtime that loads skills — **Claude** (`.claude/skills/`)
  and **Codex** (`.agents/skills/`), the same `SKILL.md` format for both. Skills install, update, and remove
  through the same Plugins View as hooks.
- **Your own skills are never silently overwritten.** When a plugin's skill would land where you already have a
  skill of that name, the consent drawer surfaces the collision with a **Keep mine / Replace** choice — Keep is
  the default, and **Replace requires a second explicit confirmation** (it permanently overwrites; there's no
  undo). Remove deletes exactly the skill-dirs Tachyon wrote, never your own.

### Internal
- Plugin engine extended to a second capability with a fail-closed security posture: the skill loader rejects
  symlink-escapes / oversized payloads / YAML-bomb frontmatter; install/remove are consent-fingerprint-bound
  (TOCTOU); and every lockfile skill-dir path is validated against the runtime's skills dir before it is ever
  trusted or deleted, so a corrupted lockfile can't turn a remove into an arbitrary delete.

## 0.35.0 — Plugins

### Added
- **The Plugins View — manage plugins from a new editor panel.** Open it from the **Plugins** button in the
  sidebar title bar (next to Inspect tmux). Per workspace, you can browse what's installed, install a plugin
  by its git source (`github:owner/repo@ref`), update, reinstall, and remove. Each plugin's native config
  block is merged into every runtime present in the workspace (claude + codex in v1; gemini is deferred).
- **A blocking security consent drawer before anything is written.** Installing, updating, or removing first
  shows the source provenance (resolved commit + integrity hash), the **full list of shell commands** the
  plugin will run on agent events, every file Tachyon will write, and a consent fingerprint. The apply is
  **bound to exactly what you consented to** — it refuses if the workspace or source moved since the preview,
  so a remote plugin's hooks are never wired silently or swapped out from under you.

### Internal
- Plugin engine completed end to end: a git source resolver + fetcher with a content-addressed cache,
  provenance + integrity pinned in the lockfile for byte-reproducible re-hydration, and a pure view-model
  layer (list + consent) so the UI's logic is unit-tested rather than buried in the VS Code layer.

## 0.34.3 — clearer Activity reminders

### Fixed
- **Tachyon's injected reminders no longer masquerade as human messages.** A `[tachyon] …` nudge (the
  handoff/continuity reminders Tachyon types into a pane) was rendering as a human chat bubble in the
  Activity feed, indistinguishable from what you typed. It now renders as a subtle, centered system chip
  (the agent still receives the reminder unchanged — this is purely how the feed reads).

### Internal
- Plugin system (engine, not yet surfaced in the UI): added a 3-way plugin updater that updates an
  installed plugin without clobbering your edits — it refuses (without force) when you've edited or would
  duplicate a plugin's hooks, and force-gates a downgrade.

## 0.34.2 — one cleanup path for agent teardown

### Fixed
- **Deleting a configured agent no longer orphans its activity log.** The 0.34.0/0.34.1 fixes cleaned the
  durable `.tachyon/activity/<agent>.jsonl` for ad-hoc kill, dismissal, and pipeline-node teardown, but the
  "Delete" action on a declared agent removed its config entry + session row while leaving the log behind —
  the same orphan class, just on the declared-delete path. Deleting an agent now drops its log with its row.

### Changed
- **Internal:** the "remove an ephemeral agent's session row + activity log" pair, previously open-coded at
  every teardown site (and the source of the drift that left orphans), is centralized into one shared,
  idempotent cleanup helper, so a future teardown path can't silently re-introduce an orphan. No behavior
  change for the existing kill/dismiss/pipeline paths.

## 0.34.1 — activity log also cleaned on kill

### Fixed
- **Killing an ad-hoc agent no longer leaves an orphaned activity log.** 0.34.0's cleanup (an agent's durable
  `.tachyon/activity/<agent>.jsonl` dies with its ledger row) covered dismissal and pipeline-node teardown but
  missed `kill` — which removes the row and, unlike a clean-exit dead pane, leaves no pane to view the log from,
  so the log was left unreachable on disk. Killing a non-persistent ad-hoc agent now deletes its log with the
  row. Found in live dogfood of 0.34.0.

## 0.34.0 — Delegation contract on agent-spawned AI sub-agents

### Added
- **When an agent delegates to a fresh AI sub-agent through the Bridge, it must now hand it a structured brief.**
  `spawn_agent` for an ad-hoc AI child requires a contract — **task + context + constraints + (deliverable OR
  done_when)** — or the call is rejected with a message naming what's missing, so the agent fixes it and retries.
  The accepted contract is composed into the child's opening instructions (it IS the child's brief, not just a
  checkpoint) and persisted with the agent. A genuinely trivial spawn can opt out with `skip_contract_reason`
  (≥10 chars), which is recorded and surfaced to you rather than silently allowed. Terminal (non-AI) children and
  agents declared in `tachyon.yml` are not gated. Enforced at the Bridge, so it works the same for any runtime
  (claude / codex / gemini / opencode); restarting, resuming, or forking an existing agent is never re-gated.

### Fixed / changed
- **A finished one-shot or pipeline `cmd:` node no longer leaves an orphaned, unreachable activity log.** The
  durable `.tachyon/activity/<agent>.jsonl` now shares the agent's lifecycle — it's removed when the agent is
  dismissed (a clean-exit ad-hoc) or its inline pipeline node is torn down, instead of accumulating on disk with
  no row to view it from. A declared agent keeps its log; the postmortem "Activity" view of a dead pane is
  unaffected (the log is dropped only at dismissal).
- **Launcher-wrapped AI commands (`npx claude`, `env -u VAR claude`, …) are now classified and prompted
  consistently** — a single resolver sees through `npx`/`bunx`/`env` for both kind-detection and prompt
  delivery, so a wrapped AI agent both gets gated and actually receives its brief.

## 0.33.0 — Project Handoff: agent-driven distill

### Added
- **An agent can now DISTILL the pending notes into the handoff — you just curate.** Reading the handoff
  (`get_project_handoff`) now returns the pending notes themselves (not just a count) plus a watermark, so an
  agent can fold them into a rewritten handoff, show you the draft, and on your OK write it
  (`set_project_handoff`). You stay the curator (approve / ask for changes); the agent does the typing.

### Fixed / changed
- **A note appended while a distill is in flight is never silently lost.** Pending is now tracked by an explicit
  distill watermark (which notes have actually been folded in), not by wall-clock — so a note that lands between
  an agent reading the handoff and writing the distilled version simply stays pending for the next pass. A plain
  rewrite (without declaring a distill) no longer clears pending — clearing is now an explicit, deliberate step.

## 0.32.1 — Project Handoff: quieter, smarter append-nudge

### Fixed
- **The "append a handoff note" reminder no longer nags an agent that has nothing new to log.** It now fires only
  when an agent has done real new work since it was last reminded or last appended (a per-agent activity-lag gate),
  on top of the existing per-workspace interval (`settings.handoff.nudgeEvery`). An agent that just logged — or
  that judged its recent work not worth a project note — won't be re-reminded for the same work.

## 0.32.0 — Project Handoff (shared state of the work)

### Added
- **A Project Handoff: one shared, curated "state of the work" per workspace — distinct from per-agent
  continuity.** Where per-agent continuity recovers an individual agent's thread, the handoff is the project-level
  picture (current state / active work / next actions / decisions & gotchas) that any human or freshly-resumed
  agent can read. Two lanes keep it correct in a multi-agent workspace without write conflicts:
  - **Canonical** `.tachyon/HANDOFF.md` — human/owner-curated, git-tracked, edited as a whole (concurrency-safe
    via compare-and-swap so a stale rewrite can't clobber a newer one).
  - **Pending notes** `.tachyon/handoff-notes.jsonl` — any agent appends a structured note (completed / blocked /
    decision / gotcha / next); the owner distills them into the canonical. Agents never rewrite the shared file.
  - **New Bridge tools:** `get_project_handoff`, `append_project_handoff_note`, `set_project_handoff`.
  - **A read-only editor panel** opens from a per-folder button in the sidebar (with a staleness badge: Fresh /
    Needs distill · N / Possibly stale / Old), rendering the handoff + the pending notes.
  - **A light, opt-out nudge** reminds an idle agent to append a note when project state changed — throttled
    per-workspace via `settings.handoff.nudgeEvery` (default `30m`, set `off` to disable). The handoff path is
    overridable via `settings.handoff.path`.

## 0.31.2 — Resume reopens the current session after `/clear` (shared cwd)

### Fixed
- **Stop→resume now reopens the session you were actually in, even after a `/clear` on a shared folder.** 0.31.1
  made the Activity feed *follow* a `/clear`; this completes the loop for *resuming*. Before, resuming a Claude
  agent that shared a folder with others could reopen the **pre-`/clear`** conversation, because the stored
  session id was never advanced past the rotation. Tachyon now uses the same per-agent ownership ledger (0.31.1)
  to pick the resume target — at stop, at resume, and for the sidebar's resumable badge — so it reopens the
  current session and never another agent's. Agents that manage their own session (`claude --resume …`) and
  non-Claude runtimes are unchanged; agents started before 0.31.1 keep the prior behavior until their next start.

## 0.31.1 — Activity keeps logging after `/clear` (shared cwd)

### Fixed
- **The Activity feed no longer freezes after `/clear` (or an in-TUI `/resume`) when several Claude agents share
  one folder.** Previously, once an agent's session id was captured, a `/clear` rotated Claude to a brand-new
  session that — on a shared working directory — Tachyon couldn't attribute from disk (Claude discards the
  Tachyon-set title and writes no parent link), so the durable Activity log stayed pinned to the old, frozen
  transcript and silently stopped recording. Tachyon now spawns each Claude agent with a per-spawn `--settings`
  `SessionStart` hook that records which session belongs to which agent in a small ledger
  (`.tachyon/activity/session-owners.jsonl`); the Activity view follows that **positive** signal, so it tracks a
  rotation exactly — and can never attribute another agent's session to the wrong log. No `~/.claude` or repo
  `.claude/` settings are touched (the `--settings` layer is additive, so your own hooks still run). Agents that
  manage their own session (`claude --resume …`) or already pass `--settings` are left untouched.

## 0.31.0 — Sortable sidebar (no more status churn)

### Changed
- **The Agents and Terminals lists are now a single flat list you sort yourself** — instead of bucketing into
  Running / Idle / Stopped groups that reflowed every time an agent changed state. The default is **Name (A–Z)**,
  a stable order where a status change just **recolors the dot in place** (no more rows jumping around). A sort
  control in the section header offers **Name (A–Z) · Name (Z–A) · Status (live)**; your choice is remembered.
  Status stays at-a-glance via the colored dot (hover for the label) and compact **per-status count chips** in the
  header. Other sections (Pipelines, Runbooks, Commands, Schedules, Pins) are unchanged.
  - **Note:** existing users will see Agents/Terminals switch from status-groups to a flat A–Z list by default —
    pick **Status (live)** from the new sort control to get the old status-first ordering back.

## 0.30.2 — Continuity nudges name the agent

### Fixed
- **The continuity nudge now spells out the agent's exact name in the `set_continuity` call.** An agent doesn't
  know its own Tachyon name, so when nudged it could guess wrong (e.g. write its brief under `main`) — the brief
  landed in the wrong file and its badge/recovery never saw it. Tachyon types the nudge and knows the name, so it
  now writes `set_continuity(agent: "<name>", …)` literally; the tool also warns against guessing.

## 0.30.1 — Continuity polish

### Fixed
- The continuity re-injection no longer points at `cat .tachyon/roles/<agent>.md` when that role doc doesn't
  exist (it only appears for agents you've actually re-anchored) — no more `cat` of a missing file.

## 0.30.0 — Per-agent continuity + richer diffs

### Added
- **Per-agent continuity — each agent keeps its working memory across session boundaries.** An agent now
  maintains a short continuity brief (`.tachyon/continuity/<agent>.md`: current goal, working state, decisions,
  next steps, open threads). When the agent crosses a **discontinuity** — a context compaction, a `/clear`, a
  restart, or a new session — Tachyon automatically types a "rebuild your context" pointer into the pane so the
  agent picks up where it left off, instead of starting blank. It is **hands-off for you**: the agent writes the
  brief (nudged by Tachyon when it's missing or falling behind), and Tachyon re-injects it on its own. Crucially,
  a **clean same-session resume is NOT re-injected** (no double-context). A sidebar badge shows
  fresh / **◐ stale** / **○ missing**, and `Tachyon: Re-inject Continuity` forces it on demand. claude-only in v1;
  no LLM cost (the agent authors the brief). `.tachyon/continuity/` is gitignored.
- **Richer Edit/Write diffs in the Activity view** — tool diffs now render TUI-style: a per-line gutter with old/
  new line numbers, the +/− sign, syntax-highlighted code (by file type), and green/red row backgrounds, instead
  of flat monospace text.

## 0.29.2 — Toggle isolation on an existing agent

### Fixed
- **Turning on `isolate: transcript` (or `harness:`) for an agent that already has history now takes effect on
  Restart.** Previously the agent's recorded config home was pinned to where its earlier sessions lived, so a
  restart kept looking there and the newly-isolated session showed an empty Activity view. A restart mints a
  fresh session, so it now re-homes to the current config home (old history stays where it was — a transcript
  can't be moved; resuming an existing session still uses its original home). A `claude --continue`/`--resume`
  agent, which owns its own session, still needs a delete + recreate to re-home.

## 0.29.1 — Task-list rendering + Studio isolate toggle

### Fixed
- **Markdown task lists (`- [ ]` / `- [x]`) rendered as stray empty boxes in the Activity feed.** The upstream
  task-list plugin emits malformed, space-less checkbox markup; Tachyon now renders each item as a proper
  styled checkbox glyph (read-only, matching the rest of the cockpit).

### Added
- **`Isolate transcript` checkbox in the Agent Studio.** The spec-240 per-agent transcript isolation is now a
  one-click toggle when creating/editing a claude agent (still off by default; claude-only; hidden when the
  heavier `Isolated harness` is on, which already isolates the transcript).

### Changed
- **`Open transcript` moved from the Activity header to a command.** The raw runtime `.jsonl` is a power-user /
  debug escape hatch, so it's now the `Tachyon: Open Raw Transcript` palette command (targets the active
  Activity panel) instead of a header button — the rendered, durable Activity log is the primary surface.

## 0.29.0 — Backward paging + per-agent transcript isolation

### Added
- **Load earlier activity (in-panel backward paging).** The Activity view can now reach OLDER history without
  leaving the panel — a "Load earlier activity" button grows the rendered window backward over the durable log,
  keeping your scroll position anchored on the item you were reading (no jump). Bounded (it defers to "open
  transcript" past a hard cap, so the payload stays sane).
- **`isolate: transcript` — per-agent transcript namespace (spec 240).** Declare it on a claude agent to give
  it its OWN claude config home (a separate transcript namespace) WITHOUT the heavier `harness:` MCP isolation:

  ```yaml
  agents:
    reviewer:
      cmd: claude
      isolate: transcript
  ```

  Now multiple agents that share ONE folder each get an attributable session, an in-TUI `/resume`/`/clear` that
  the Activity view follows, and their own durable activity log — while still loading the workspace project
  config (`CLAUDE.md`, `.claude/`, `.mcp.json`, which are cwd-relative) and inheriting your existing claude
  login (no re-auth). The fix for "several agents in the same folder, one shows no activity."

### Fixed
- Session attribution is now drift-safe: the config home a session was written under is persisted, so a later
  `isolate`/`harness` toggle or rename can't make Tachyon look in the wrong place; startup GC no longer reaps a
  still-referenced transcript home.

## 0.28.1 — Activity in shared folders

### Fixed
- **The Activity view was empty for agents that share a workspace folder.** When ≥2 agents run in the same
  directory (the common case), the durable-log writer was over-suppressed and captured nothing, so the cockpit
  showed "Waiting for activity…" for a working agent. It now attributes each agent's session safely by its
  captured uuid or unique title even in a shared folder (only the genuinely ambiguous, id-less case is gapped,
  with an honest notice) — so each agent's history shows correctly. No misattribution: the only ambiguous
  fallback (a bare "newest in this folder" scan) is skipped on a shared cwd.

## 0.28.0 — Durable activity history

### Added
- **The Activity view now keeps each agent's full, normalized history — durably.** A per-agent activity log
  (`.tachyon/activity/<agent>.jsonl`) is written continuously by an always-on writer, so the cockpit shows a
  complete, stitched timeline across `/clear`, `/resume`, context compaction, fresh starts and restarts —
  history that would otherwise be lost when the runtime rotates session files. The log is a normalized
  projection (not a raw clone): provenance pointers back to the source records, content-addressed copies of
  the images it renders, and it survives runtime-side pruning.
- **Session & compaction boundaries are rendered as separators.** Compaction shows "context compacted" with
  the token delta and an expandable summary; session changes show "new session" / "resumed session" /
  "restarted session" / "forked session" — labeled from Tachyon's own Start/Restart/Resume/Fork actions when
  it performs them, inferred from the transcript otherwise.
- **Rich rendering in the Activity feed** (since 0.27): markdown via markdown-it (tables, task lists, quotes),
  syntax-highlighted code blocks with copy, Mermaid diagrams, LaTeX (KaTeX), thinking blocks, tool diffs,
  inline images with click-to-zoom, a live "working…" indicator, in-feed search, and a visible "recent N of
  M" cap notice instead of silently dropping older activity.

### Changed
- The Activity panel is now a read-only subscriber to the durable log (it no longer tails the runtime
  transcript directly). Opening a long session is bounded (fast) instead of re-reading the whole file.
- Post-compaction artifacts (the continuation summary, `/`-command wrappers, local-command output) are no
  longer mis-rendered as human chat messages.

### Notes
- Per-agent history is captured from now forward; on a folder shared by ≥2 agents, session stitching is
  suppressed (an honest "history stitching limited" notice) rather than risk mis-attribution.

## 0.27.0 — New sidebar

### Changed
- **The Tachyon sidebar is now a purpose-built webview panel, replacing the native tree.** Icon tabs per
  section (Agents, Terminals, Pipelines, Schedules, Commands, Runbooks, Pins), a global `⌘K`/`Ctrl+K`
  search across the whole fleet, capability-gated per-row actions with a consistent `…` overflow menu
  (Edit in Studio / Edit YAML / Delete), multi-root folders shown together and grouped, a view toolbar
  (server inspector / refresh / settings), live state for every section, and full keyboard accessibility.
- The legacy tree is removed (the `tachyon.sidebar.legacyTree` opt-in is gone). All existing commands and
  Studios are unchanged — the panel drives the same actions.

### Added
- Per-section "new …" create buttons; Commands/Runbooks show real run state (running/passed/failed) with
  open-output and step expansion; pipelines gate Run/Cancel/Dismiss/Review by run state and auto-expand on
  start; schedules reflect paused state; an honest empty state with an "Initialize Tachyon" action.

## 0.26.0 — Zero-config Bridge

### Added
- **Every Tachyon-spawned agent reaches the MCP Bridge automatically.** Tachyon injects the
  Bridge at spawn — Claude via an additive `--mcp-config`, Codex via an additive
  `-c mcp_servers.tachyon_bridge=…`, and an isolated-harness Claude has it folded into its
  scoped (`--strict-mcp-config`) file. Injection re-runs on **spawn, restart, resume, and fork**
  (a momentarily-down Bridge self-heals on the next start), and the token never lands on the
  command line. **No `.mcp.json` / `config.toml` registration is needed** for agents Tachyon
  spawns. `Tachyon: Connect Agent Runtime` remains, now scoped to **external/manual** sessions
  you start yourself.

### Fixed
- An isolated-harness agent with `inherit: none` no longer silently loses the Bridge — it is
  always folded into the materialized strict MCP file, so the agent can still call
  `complete_node` / `write_input`.

### Changed
- Pipeline preflight now treats a Tachyon-spawned Claude node as Bridge-capable (injection
  guarantees it — no project `.mcp.json` evidence required); a node whose command disables MCP
  (`--safe-mode`) is correctly reported as unable to signal completion.

### Removed
- The discontinued **layouts** feature was retired (legacy config keys remain tolerated).

### Internal
- The engine is now decoupled from VS Code behind a host port, enforced by a CI boundary guard.
- The `Workspace` is headless-testable (`createForTest` + an in-memory host).

## 0.25.0 — Agent Pipelines, input-driven
- Input-driven pipelines: one definition becomes a reusable workflow run per issue, with agent
  personas and a handoff bus that carries context down the chain.
- Codex pipeline nodes reach the Bridge automatically via an injected `-c` override.

## 0.56.37
- t-ec5cd2: passive info toasts auto-advance (~4s); exact-duplicate collapse (~10s); burst "+N more" suffix.

## 0.56.38
- t-e1bd89: scope approval.css under .approval-root; Mission who/prio chips no longer blue under Control.
