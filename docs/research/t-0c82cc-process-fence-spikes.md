# t-0c82cc — o que os spikes de ProcessFence decidiram e por que pararam

Data da leitura: 2026-08-21

Escopo: síntese dos quatro artefatos do spec 368 e da história que os alcançou; nenhuma proposta ou implementação nova.

## Veredito

O trabalho tomou duas decisões técnicas separadas. Primeiro, uma execução precisava de uma fronteira de
membership que sobrevivesse a `setsid`, double-fork e reparenting; pane PID, árvore de PPID e process group foram
recusados por não oferecerem isso. Segundo, mesmo uma fronteira vazia não bastava: `proven_empty` exigia uma
auditoria independente de todo processo do mesmo UID ligado à worktree por `cwd`, `root` ou FD aberto. O cgroup
transitório do `systemd --user` passou o primeiro teste; o helper não fechou o segundo. Esses resultados estão nos
vereditos dos estudos, não são uma reconstrução: o primeiro spike termina `PARTIAL`, o de cgroup termina `PASS`
somente para containment, e o de auditoria termina `BLOCKED`.

Para o vazamento medido hoje, o resultado é assimétrico:

- **O cgroup ataca exatamente a forma “neto reparentado”.** No experimento, o writer fez double-fork,
  `setsid`, perdeu o pai original e continuou no cgroup; `cgroup.kill` o removeu e `populated 0` foi observado.
  Isso vale quando o descendente nasceu dentro daquele scope por execução. Não alcança retroativamente um
  processo para o qual hoje não há uma identidade de scope persistida.
- **O helper ataca a observação, não a terminação.** Antes da remoção da worktree, ele encontraria um processo
  reparentado pelo `cwd` (e também por `root`/FD), porque sua varredura global independe da linhagem. Mas o próprio
  helper nunca sinaliza ou mata, não obteve uma varredura completa neste host e, no contrato do spike, exige que a
  worktree-alvo ainda exista para ser resolvida e pinada. Portanto ele não resolve sozinho os 19 processos que já
  estão órfãos hoje.
- **O detector atual é a peça que alcança 13 dos 19 depois da remoção.** Ele foi escrito especificamente para
  `cwd` com sufixo ` (deleted)` e declara que linhagem é irrelevante. É somente relatório; os outros seis casos
  medidos (quatro no checkout principal, dois em worktree viva) ficam fora de seu predicado.

O trabalho não parou porque o problema deixou de doer, nem há texto que atribua a parada a custo, mudança de
prioridade ou falta de decisão sobre a técnica. A linha continuou: houve adapter experimental, correções e testes
de recovery. Ela morreu em 01/08 por outra decisão, registrada em `t-e88c8a`: Delivery e GitDelivery foram removidos
como política opinativa, apagando o único consumidor do ProcessFence. A umbrella `t-f25434` foi então marcada
`dropped`; seu journal diz explicitamente que o problema subjacente — um agente deixar processo destacado vivo —
continuava verdadeiro e sem resposta.

## Fontes e convenção de âncoras

Os quatro artefatos foram lidos pelos caminhos absolutos indicados no cartão:

1. `/home/goat/tachyon/.tachyon/studies/368-process-fence-spike.md`
2. `/home/goat/tachyon/.tachyon/studies/368-process-fence-cgroup-spike.md`
3. `/home/goat/tachyon/.tachyon/studies/368-process-audit-helper-spike.md`
4. `/home/goat/tachyon/.tachyon/studies/368-process-audit-helper.c`

Uma âncora como `fence:L10-L20` aponta para as linhas numeradas do primeiro arquivo; `cgroup`, `audit` e `helper.c`
nomeiam os outros três. As âncoras do código atual usam o caminho versionado. Decisões posteriores do board citam
task e journal id, pois não vivem nos quatro artefatos.

## 1. O que cada artefato propôs e decidiu

### 1. `368-process-fence-spike.md`: namespace como containment, auditoria como segundo cadeado

O primeiro spike recomendou um user+PID namespace com um init dedicado como núcleo de containment. O experimento
provou que um writer destacado e reparentado continuava no namespace, que uma parada a ponto fixo cessava seu
trabalho e que matar o namespace init removia os membros (`fence:L123-L168`). A proposta do port, porém, só
permitia `proven_empty` quando **duas** provas coincidiam: ausência no containment e auditoria independente da
worktree (`fence:L170-L209`). O veredito foi `PARTIAL`, porque a varredura global encontrou processos do mesmo UID
com `/proc` ilegível; transformar `EACCES` em ausência violaria o contrato (`fence:L10-L23`, `fence:L109-L121`).

O que ele recusou foi explícito e por correção, não por custo: pane/root PID falha após a raiz morrer e sofre PID
reuse; árvore de PPID perde o writer após reparenting; process group/session perde o double-fork com `setsid`;
subreaper não é boundary de freeze/kill; pidfds de PIDs conhecidos não enumeram membership completa. Cgroup ficou
“promising, unproven”, porque o escopo não autorizava criar/mutar um scope naquele estudo
(`fence:L61-L77`). Também recusou qualquer fallback otimista para pane kill, group kill, árvore de PID ou auditoria
incompleta (`fence:L15-L20`, `fence:L211-L230`).

Por que este spike parou: o texto diz que o experimento de namespace fechou só o núcleo e que a auditoria global
continuou bloqueando `proven_empty`; também diz que o cgroup não foi experimentado porque a tarefa proibia a
mutação (`fence:L61-L64`, `fence:L157-L168`). **O texto não diz** que houve falta de decisão do dono, mudança de
prioridade ou desaparecimento da dor.

### 2. `368-process-fence-cgroup-spike.md`: scope transitório passou o caso reparentado

O segundo spike trocou a pergunta: isolou somente a viabilidade do cgroup e decidiu `PASS` para um scope
transitório `systemd --user`. O writer double-forked/`setsid` permaneceu membro depois de perder o pane-root;
`cgroup.freeze` parou o log, thaw o retomou, `cgroup.kill` matou o writer e expôs `populated 0`; `systemctl --user
stop` teve o mesmo efeito (`cgroup:L9-L20`, `cgroup:L88-L112`, `cgroup:L151-L205`). A tentativa de automigração
para o slice pai falhou com `EBUSY`, evidência limitada às condições medidas (`cgroup:L221-L236`). `Delegate=yes`
foi medido como disponível, mas recusado como requisito do caminho freeze/kill/populated porque o default
`Delegate=no` já havia funcionado (`cgroup:L207-L220`).

O estudo recusou chamar isso de ProcessFence completo. A razão registrada é a mesma lacuna independente: cgroup
vazio não prova que nenhum processo externo ainda tem `cwd`, `root` ou FD na worktree. Também ficaram não provadas
as races de produção, identidade de unidade/boot, crash durante kill e migração externa. Por isso ele recusou
adapter de produção e `capability=available`, sem relaxar `proven_empty` (`cgroup:L238-L271`, `cgroup:L316-L327`).

Por que este spike parou: o seu escopo terminava no primitive de cgroup, e o texto lista a auditoria global e o
hardening de races como blockers do port completo (`cgroup:L24-L32`, `cgroup:L254-L260`). **O texto não diz** que
o dono recusou cgroup, que o custo foi alto, que a prioridade mudou ou que o problema deixou de existir.

### 3. `368-process-audit-helper-spike.md`: helper fail-closed ficou bloqueado

O terceiro documento especificou e mediu um helper C read-only para varrer processos do mesmo UID e classificar
`cwd`, `root` e todos os FDs como `empty`, `survivors` ou `unknown`. Ele pinava o target com
`realpath`+`O_PATH`+`st_dev/st_ino`, revalidava antes/depois de pass e observação, fixava identidade por starttime,
limitava relatórios e nunca imprimia paths alheios (`audit:L36-L61`, `audit:L132-L169`). Para FD directories
ilegíveis, R5 decidiu usar `pidfd_open`/`pidfd_getfd` com `FDSize` por processo, dois scans concordantes, deadline e
estabilidade exata; recusou `RLIMIT_NOFILE` e `fs.nr_open` como limites de completude (`audit:L191-L242`).

O veredito foi `BLOCKED` por duas razões registradas. A primeira é privilégio: `sudo -n` e `setcap` não podiam
instalar `CAP_SYS_PTRACE` sem credencial interativa, então não houve rerun completo com capability
(`audit:L12-L30`, `audit:L301-L321`). A segunda é semântica: um ator do mesmo UID pode fazer move+restore entre
syscalls separadas de procfs; a primitiva não exclui isso matematicamente, e o texto manda bloquear
`proven_empty`/rollout enquanto o threat model não for re-ratificado ou outra primitiva for provada
(`audit:L32-L34`, `audit:L351-L368`).

O que foi recusado aparece consolidado no próprio documento: `RLIMIT_NOFILE` como bound, `nr_open` como bound
primário, `CAP_DAC_READ_SEARCH`, carve-outs por nome de processo, claim de auditoria completa sem rerun com cap e
qualquer produção do adapter (`audit:L394-L423`). O path R4 de `nr_open` não foi simplesmente abandonado: foi
superseded por R5 porque o valor global deste host tornava a sondagem inviável, enquanto `FDSize` preservava o FD
5000 acima de soft limit (`audit:L191-L242`, `audit:L323-L350`).

Por que este spike parou: aqui o texto diz. Parou `BLOCKED` pela instalação interativa da capability, pela falta do
rerun capped do binário R5 contra `(sd-pam)` e pelo residual move+restore que o helper não fecha
(`audit:L382-L404`). Não atribui a parada a custo, prioridade ou desaparecimento do problema.

### 4. `368-process-audit-helper.c`: o protótipo executável, não uma decisão independente de rollout

O quarto artefato materializa o contrato do relatório: varredura global de processos do mesmo real UID, leitura de
`cwd`/`root`/FD, precedência de `unknown`, saída estável e nenhuma ação sobre processo ou target
(`helper.c:L1-L26`, `helper.c:L1582-L1662`, `helper.c:L1673-L1710`). O target precisa ser absoluto, resolvível,
canônico e abrível com `O_PATH|O_DIRECTORY`; path inexistente ou alias é recusado antes da varredura
(`helper.c:L1712-L1764`). O fallback usa dois scans `[0, FDSize)`, confere starttime/FDSize antes, no meio e depois,
e trata qualquer erro diferente de `EBADF` como desconhecido (`helper.c:L867-L1063`).

O amendment de 06/08 acrescentou `TACHYON_PROC_AUDIT_PID_ROOT` para que **testes** escaneiem só a própria
subárvore; o default continuou sendo todos os processos, justamente porque a pergunta de produção não pode depender
da árvore de PPID (`helper.c:L1462-L1580`; `audit:L442-L470`). A fonte reitera que nunca chama
`ptrace(PTRACE_ATTACH)`; `pidfd_getfd` pede ao kernel uma checagem de permissão equivalente, fato que depois gerou
ruído no `dmesg`, não anexação (`helper.c:L6-L9`, `helper.c:L1516-L1542`).

Por que este artefato parou: **o texto não diz**. A fonte declara ser “spike prototype”, descreve o cap pretendido e
os códigos de saída, mas não contém decisão de produto, conclusão de rollout ou razão histórica de abandono
(`helper.c:L1-L26`). A razão de parada pertence ao relatório `BLOCKED` acima e, depois, à remoção do consumidor.

## 2. Decidido versus recusado

| Caminho                                      | Decisão registrada                         | Razão registrada                                                                                                                         |
| -------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Pane PID / root PID                          | Recusado como fence                        | A raiz morre e o writer continua; PID nu também pode ser reutilizado (`fence:L68-L71`, `fence:L92-L107`).                                |
| Árvore de PPID                               | Recusada sozinha                           | Reparenting apaga a aresta e a enumeração corre com fork/exit (`fence:L71-L72`).                                                         |
| PGID / session                               | Recusado                                   | Double-fork + `setsid` mudou PGID/SID e sobreviveu ao kill do grupo original (`fence:L72-L73`, `fence:L94-L107`).                        |
| Subreaper                                    | Recusado sozinho                           | Melhora coleta de órfãos, mas não é membership durável nem fecha races (`fence:L73-L74`).                                                |
| pidfd de PIDs conhecidos                     | Aceito só como identidade auxiliar         | Não fornece membership completa nem containment de forks (`fence:L74-L75`).                                                              |
| User+PID namespace                           | Aceito como núcleo viável no primeiro host | Retém reparented child; init death mata membros. Ainda não fecha auditoria independente (`fence:L76-L77`, `fence:L141-L168`).            |
| Scope cgroup v2 / systemd-user               | `PASS` para containment neste host         | Membership sobrevive ao reparent, freeze/kill/populated funcionaram sem sudo (`cgroup:L9-L20`, `cgroup:L240-L252`).                      |
| Cgroup vazio como `proven_empty`             | Recusado                                   | Não prova ligações externas por cwd/root/FD (`cgroup:L254-L271`).                                                                        |
| Helper sem cap                               | Aceito somente como fail-closed `unknown`  | O host tem processos do mesmo UID ilegíveis; ausência não é provada (`audit:L244-L270`).                                                 |
| CAP_SYS_PTRACE helper como prova completa    | Bloqueado, não aceito                      | Instalação não interativa indisponível, rerun capped ausente e residual move+restore (`audit:L24-L34`, `audit:L382-L404`).               |
| `RLIMIT_NOFILE` / `nr_open` como probe bound | Recusados/superseded                       | Soft limit pode ficar abaixo de FD já aberto; `nr_open` global era enorme; R5 adotou `FDSize` (`audit:L191-L242`, `audit:L394-L404`).    |
| Adapter forte em produção                    | Não enviado                                | Spec fechado declara mechanism-only; strong fence não foi ligado (`docs/specs/368-delivery-worktree-leases/spec.md:L5-L10`, `L84-L102`). |

As razões medidas são correção, privilégio e incompletude/race. Os spikes não registram custo como razão de recusa,
nem uma recusa do dono ao cgroup.

## 3. Por que a linha inteira parou

Os spikes sozinhos contam por que a prova completa não fechou em julho, mas não contam por que o trabalho inteiro
desapareceu depois. A história versionada e o board completam a resposta:

1. Em 12/07, `504d12ae` adicionou `LinuxSystemdProcessFence` com systemd/cgroup e helper injetado; a mensagem do
   commit diz que `UnavailableProcessFence` continuava default. Portanto o `BLOCKED` não encerrou imediatamente a
   investigação: nasceu um adapter experimental, mas não um caminho de produção.
2. `t-cd8cbe` landou em 18/07 um teste da janela `fence → recoveryCurrent`; `t-108a79` landou em 20/07 a recusa
   antecipada de unit id incorreto em `activating`. São prova de hardening posterior, não de rollout.
3. Em 01/08, `t-e88c8a` registrou a decisão do dono de remover Delivery/GitDelivery por serem política opinativa
   sobre mecanismos já existentes. O commit `80de8aa7` apagou os dois subsistemas; `4758729d` apagou em seguida
   `processFence.ts` e `linuxProcessFence.ts`, dizendo que todas as 922 linhas estavam inalcançáveis.
4. O journal `j-5c5e67175a13` de `t-f25434` fecha a umbrella como `dropped`: não existe mais ocupante de Delivery a
   cercar. O mesmo texto separa a razão histórica do problema real: o processo destacado vivo continua sem
   resposta, mas retomá-lo já não seria continuar a umbrella Delivery-bound.
5. A closure versionada do spec 368 agora diz que apenas o lifecycle mechanism-only foi enviado e que a fronteira
   forte não foi enviada nem implicada (`docs/specs/368-delivery-worktree-leases/spec.md:L5-L10`). Também declara
   explicitamente que root death não prova descendentes e que o adapter revisado não está wired
   (`docs/specs/368-delivery-worktree-leases/spec.md:L84-L102`).

Assim, há duas respostas diferentes para “por que parou”:

- **a prova forte de julho parou bloqueada** por auditoria incompleta, privilégio e residual multi-syscall;
- **a linha de produto parou em agosto** porque o único lifecycle que a consumia foi removido. O problema de órfãos
  não foi declarado resolvido.

## 4. O que ataca o vazamento de hoje

### Cgroup: sim para o neto reparentado, sob a condição medida

O processo concreto é neto de browser, reparentado imediatamente ao `systemd --user`. A variável que derruba pane,
PPID e PGID é exatamente a que o experimento cgroup neutralizou: depois de o pane-root sair, o writer permaneceu
sozinho em `cgroup.procs`, e o relatório conclui “Detach/reparent did not drop cgroup membership”
(`cgroup:L88-L112`). Freeze e kill atuaram sobre esse membership, não sobre a árvore de pais
(`cgroup:L113-L168`). Portanto **sim**, o cgroup resolveria a classe reparented-grandchild se o browser e seu neto
tivessem sido lançados no scope por execução testado e essa identidade ainda estivesse pinada.

Isso não é uma afirmação de que os 19 processos atuais pertencem hoje a um scope recuperável. O spike exigia unit
name, InvocationID, boot ID e ControlGroup pinados e mandava tratar drift como `unknown`
(`cgroup:L185-L186`, `cgroup:L262-L271`). O adapter que persistia essa identidade foi removido; não há evidência no
cartão de uma identidade equivalente para os processos já existentes.

### Helper: encontra antes da remoção, mas não resolve sozinho

Reparenting não afeta o helper default: ele enumera `/proc` inteiro e filtra por real UID, não por ancestrais
(`helper.c:L1516-L1580`). Um `cwd` dentro da worktree é uma das três ligações aceitas, e o helper também captura o
caso em que cwd virou `/` mas um FD ficou aberto (`audit:L267-L270`; `fence:L94-L107`). Logo ele encontraria o
`gsettings monitor` enquanto a worktree canônica ainda existisse e poderia produzir `survivors`/`unknown` em vez
de uma ausência falsa.

Mas há três limites que impedem chamar isso de resolução do vazamento atual:

1. é read-only e “never signals” (`helper.c:L6-L9`);
2. neste host, sem cap, uma descoberta pode coexistir com estado final `unknown`, e o helper completo permaneceu
   `BLOCKED` (`audit:L12-L30`, `audit:L267-L270`);
3. no contrato original ele recebe a worktree canônica; `main` exige `realpath` e `open(O_PATH|O_DIRECTORY)` antes
   de escanear, então uma worktree já apagada é `target_unresolvable`, não um alvo auditável
   (`helper.c:L1716-L1764`).

### Detector atual: encontra os 13 cujo cabo restante é cwd deleted

`scanOrphanedWorktreeProcesses` remove o sufixo ` (deleted)`, compara o cwd com o managed root e declara
lineage irrelevante porque o processo pode reparentar antes de o tmux morrer
(`packages/engine/src/worktree/orphanProcessHygiene.ts:L77-L155`). A tool `worktree_processes` expõe esse relatório
como read-only e diz que Tachyon não termina os processos automaticamente
(`packages/bridge/src/tools/worktrees.ts:L88-L104`). Isso coincide com os 13/19 medidos no cartão; não substitui
containment e não alcança os quatro cwd no checkout principal nem os dois em worktree ainda viva.

## 5. O que envelheceu

### O adapter e o lifecycle que os spikes pressupunham não existem mais

`git log -S'LinuxProcessFence'` mostra a vida inteira do adapter: adição em `504d12ae` (12/07) e remoção em
`4758729d` (01/08). `git log -S'ProcessFencePort'` mostra o mesmo corte junto de `80de8aa7`, que removeu Delivery e
GitDelivery. Hoje não há `ProcessFencePort`, `LinuxProcessFence` ou `UnavailableProcessFence` em `packages/`.
Consequentemente:

- a recomendação de wiring do spike não aponta para um ponto de extensão atual;
- `t-cd8cbe` exercitava recovery de um subsystem apagado;
- `t-108a79` corrigia um estado do adapter apagado; o próprio journal `j-b657838bf14d` de `t-f55bf7` registra que
  esse estado não pode mais ocorrer.

Isso envelheceu o **endereço e o consumidor**, não a medição de que reparenting preserva membership de cgroup.

### O helper mudou uma vez depois do spike, sem mudar o default de produção

`git log -S'TACHYON_PROC_AUDIT_PID_ROOT'` aponta `06c62a1c` (06/08). `t-9713ff` primeiro suspeitou que o teste
tivesse derrubado a frota, depois corrigiu a afirmação: não havia `ptrace attach`; havia requests negados de
`pidfd_getfd`, e a causa da queda era um `tmux kill-server` alheio. O amendment do relatório diz que o filtro de
PID root só é opt-in e que o comportamento default foi re-medido sem mudança (`audit:L442-L470`). Portanto as
medições globais do spike continuam sendo as que o código declara; o teste deixou de sondar o editor do humano.

### Os arquivos `.tachyon/studies` mudaram de status durante esta própria tarefa

O aviso do cartão era verdadeiro no fork desta worktree: `3ab02057` (21/08) havia tirado os studies do índice.
Mas `git log -S'TACHYON_PROC_AUDIT_PID_ROOT'` também encontrou um commit posterior no `main`, `5788983d`, que
restaurou os três artefatos lidos pelos testes: o C, o relatório do helper e o relatório de cgroup. A razão está na
mensagem do commit: `test/unit/processAuditHelperGrokR1Behavior.gen.test.ts` compila/lê os dois primeiros, e
`test/unit/processFenceCgroupReportLunaR2Behavior.gen.test.ts` lê o terceiro. O primeiro
`368-process-fence-spike.md` continua fora do índice e foi lido somente pelo caminho absoluto pedido.

Isso corrige uma dependência envelhecida do gate, mas também torna o artefato C uma entrada de teste versionada,
não apenas rastro histórico. O teste atual ainda fixa seus paths em `.tachyon/studies`
(`test/unit/processAuditHelperGrokR1Behavior.gen.test.ts:L21-L23`, `L212-L215`).

### O detector cwd-only nasceu depois e hoje tem uma segunda porta antes da remoção

`git log -S'scanOrphanedWorktreeProcesses'` mostra a criação em `09adad1d` (06/08), depois dos spikes e depois da
remoção do ProcessFence. Em `eb48c5b1` (19/08), o mesmo walk foi compartilhado com
`scanLiveWorktreeProcesses`, chamado antes de `git worktree remove`; a remoção recusa uma descoberta medida a
menos que `confirmLiveProcesses=true`, sem matar o processo
(`packages/engine/src/worktree/orphanProcessHygiene.ts:L81-L178`,
`packages/engine/src/worktree/WorktreeManager.ts:L1138-L1156`).

Portanto a frase do cartão “`scanOrphanedWorktreeProcesses` tem um consumidor só” ainda é literalmente verdadeira
para aquela função exportada, mas envelheceu como mapa de capability: o walk de cwd hoje também participa do
pre-removal. Isso não transforma o detector no helper dos spikes: ele mede só cwd, não root/FD, não fornece
membership e não termina nada.

## Comandos de história usados

```text
git log --all --oneline -S'LinuxProcessFence' -- src packages test
git log --all --oneline -S'ProcessFencePort' -- src packages test docs/specs/368-delivery-worktree-leases
git log --all --oneline -S'TACHYON_PROC_AUDIT_PID_ROOT' -- .tachyon test
git log --all --oneline -S'scanOrphanedWorktreeProcesses' -- src packages test
git log --all --follow --oneline -- packages/engine/src/worktree/orphanProcessHygiene.ts
git log --all --follow --oneline -- .tachyon/studies/368-process-audit-helper.c
```

Resultados decisivos: `504d12ae` adiciona o adapter; `80de8aa7` remove seu lifecycle; `4758729d` remove o adapter
órfão; `06c62a1c` escopa o helper somente nos testes; `09adad1d` cria o detector de cwd deleted; `eb48c5b1` o
reutiliza antes da remoção; `3ab02057` desrastreia studies e `5788983d` devolve os três que são entrada de teste.

## Resposta às cinco perguntas em uma linha cada

1. Cada spike: namespace foi núcleo `PARTIAL`; cgroup foi `PASS` para membership; helper foi protótipo `BLOCKED`;
   o C implementa esse helper e não contém decisão independente de rollout.
2. Decidido/recusado: cgroup foi aceito para reparented membership; pane/PPID/PGID foram recusados por correção; o
   helper completo foi recusado enquanto privilégio e atomicidade permanecessem não provados.
3. Por que parou: os spikes pararam nos blockers declarados; a linha de produto morreu depois porque Delivery foi
   removido. Onde a fonte C não explica a parada, **o texto não diz**.
4. Vazamento de hoje: cgroup cobre a classe do neto reparentado quando ele nasce no scope; o helper encontra a
   ligação antes da remoção, mas não mata nem fecha a prova; o detector atual encontra os 13 cwd deleted.
5. Envelhecimento: o adapter e seu lifecycle foram apagados; o helper recebeu somente um escopo opt-in de teste;
   os studies exigidos pelo gate foram temporariamente desrastreados e restaurados; o walk cwd-only ganhou uma
   porta pre-removal.
