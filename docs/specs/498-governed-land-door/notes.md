# 498 — governed-land-door — notes

_Created 2026-08-09._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

## Revisão adversarial

**Veredito: volte para A.** O número 8/3 é verdadeiro no header, mas mede o land manual anterior ao suggest-and-copy, não uma falha deste.
O argumento do diretório está factualmente errado: o comando atual já leva `git -C <primaryPath>` e funciona de qualquer cwd.
Não medi nenhuma quebra depois que A entrou; portanto B abre a primeira escrita da trunk sem um defeito residual medido que a exija.
Além disso, a re-medição de B reduz a janela, mas não a fecha; medi um `git merge` movendo a branch errada dentro dela.

### O que não sobreviveu

- **“Oito merges à mão, três quebraram a trunk” não justifica B.** O header de `land.ts` diz exatamente isso e diz que as três quebras falharam uma condição computável. Mas `land.ts` e a UI de suggest-and-copy entraram em 2026-08-07 justamente para pôr essas cinco condições diante do humano e só entregar comando quando todas passam. A medição sustenta essa solução; não isola “o humano ainda precisa colar” como causa e não compara A pronta contra B. Procurei a alegação no repositório e só encontrei o número no header; não medi a taxa de falha posterior a A.

- **“O SHA protege a árvore, não o diretório” é falso no produto atual.** `landCommand(primaryPath, head)` produz `git -C ${primaryPath} merge --ff-only ${head}`. O clipboard carrega o diretório, sim: o shell focado pode estar em qualquer cwd. O SHA continua importante para a árvore, mas não há aqui um defeito de cwd que B precise corrigir.

- **“A metade que julga mas não age é incoerente” não se segue.** Provar e apresentar as pré-condições, deixar a mutação com o humano e não possuir a trunk é uma fronteira coerente. A pesquisa dos ADEs mostra exatamente essa separação em outra topologia: o produto/agent prepara evidência e o forge/humano possui o ato. B pode ser uma preferência de UX; a spec não demonstrou que seja uma correção de segurança.

- **“Re-probes at the moment of acting” não fecha a autorização.** São subprocessos separados: depois da leitura de branch/limpeza/ancestralidade e antes do `merge`, outro ator ainda pode mudar o primário. Medi no Git 2.53.0: a sondagem viu `main` e fast-forward verde; um `switch other` na janela; o mesmo `git merge --ff-only <sha>` avançou `other` e deixou `main` intacta. O Git não conhece a intenção “mova `main`”; ele move a branch apontada por `HEAD` quando o comando começa. **Quem fecha essa corrida na spec: ninguém.** Não proponho mutex de Tachyon: terminal externo não o respeitaria, e seria um subsistema para um risco que não foi medido em produção. Se B for mantida, essa janela precisa ser aceita em voz alta, não descrita como fechada.

- **“Git falhou, então a trunk está unchanged” está forte demais.** A invocação que perde uma corrida não move o ref, mas outra invocação pode tê-lo movido. No ensaio com duas deliveries divergentes, ambas passaram a ancestralidade contra o mesmo `main`; um merge venceu e o outro foi recusado por `update_ref` porque `HEAD` já não tinha o OID esperado. O checkout terminou limpo. A afirmação honesta é “esta invocação não fez uma atualização parcial”; o estado global pode ter mudado.

- **O ledger próprio de undo antes do merge não sobrevive ao princípio de simplicidade.** `git merge` já escreve `ORIG_HEAD` e reflog de branch em disco; confirmei os dois no ensaio. Duplicar isso cria dois donos para o mesmo histórico. A aceitação “from a record it made before moving the trunk” deve cair: o dono do ref já faz o registro.

- **“Exatamente um call site” não prova a autoridade.** O guard atual encontra literais em arrays e hoje prova o limite zero; estreitá-lo para um endereço nomeado só prova onde uma forma sintática apareceu. Não prova que apenas a Interface alcança o efeito, nem vê uma lista de argumentos construída por variável, shell ou outro wrapper. A regra que importa é a ausência de porta Agent/Tachyon; a contagem pode ser manutenção, não argumento de segurança. Não alterei nem fiz mutation-test do guard por causa da restrição de somente leitura em `test/`.

### Respostas às quatro perguntas

1. **O ato roda no engine, por uma operation exclusiva da Interface.** O botão de Worktrees envia uma nova operação tipada ao engine, no mesmo caminho já usado por `worktree.remove-managed`; o engine re-sonda e chama Git porque já possui `ManagedWorktreeService`, `GitExec` e os fatos de land. **Não** use `HostActionBroker`: ele existe para `run_host_action` via Bridge e criaria justamente uma porta agent-facing que a spec proíbe. O que se perde: sem engine persistente alcançável, não há fallback de land no extension host; o botão recusa.

2. **Sim, o undo sobrevive a reload pelo reflog do Git; não crie estado Tachyon.** Só ofereça “desfazer o último land” enquanto o primário continua limpo/on-trunk, a trunk ainda aponta para o SHA landed e o predecessor está no reflog; após reload, releia esses fatos e mostre `git -C <primary> reset --hard <predecessor>`. `ORIG_HEAD` serve como resultado imediato, mas o reflog é o registro durável. O que se perde: depois de outro movimento da trunk ou da expiração do reflog, a affordance desaparece; não haverá histórico de undo próprio nem promessa de desfazer um land antigo fora de ordem.

3. **Ignore agente ou terminal no primário.** Git já recusa operações Git simultâneas pelos locks/CAS que possui; um terminal parado não é um estado de segurança, e uma sondagem de ocupação anterior ao ato teria a mesma corrida que estamos tentando evitar. Não existe defeito de ocupação medido que justifique inventar autoridade sobre processos. O que se perde: não há aviso de cortesia, e um processo externo que conclua uma mudança entre a sondagem e o merge pode invalidar a intenção — inclusive a troca de branch que medi acima. Essa perda é mais honesta que um “refuse” que promete fechar e não fecha.

4. **Não construa mutex: entregue os dois cliques ao Git.** O update do ref já é compare-and-swap e os arquivos de estado já têm locks. No ensaio de dois fast-forwards divergentes simultâneos, um venceu e o outro recebeu a recusa de expected-old de `update_ref`; não houve corrupção nem estado parcial. Releia o estado depois e reporte o erro do Git sem resumir. O que se perde: o perdedor vê uma recusa de baixo nível em vez de uma fila amigável; dois cliques para o mesmo SHA podem resultar em “already up to date”.

### O que verifiquei e o que não verifiquei

Verifiquei no código:

- o header completo de `src/worktree/land.ts`, as cinco condições e seus probes fail-closed;
- que o comando atual inclui `git -C <primaryPath>` e fixa o SHA;
- que a sondagem é feita no engine por `ManagedWorktreeService`, enquanto Worktrees hoje só manda `copyText` ao extension host;
- que a gramática existente de ação humana (`worktree.remove-managed`) é Interface → operation tipada → engine, com revalidação no engine e sem Bridge genérica;
- que o guard atual rejeita literais `merge`/`--ff-only` em arrays de argumentos sob `src/`, e a limitação sintática do parser que ele próprio implementa;
- que a SDD 497 troca apenas a origem/leitura da prova por refs Git e não resolve nem autoriza o ato;
- que os ADEs pesquisados executam pelo forge, não mutam o checkout local do humano;
- em repositórios descartáveis reais com Git 2.53.0: (a) duas deliveries verdes concorrentes resultaram em um fast-forward e uma recusa atômica de expected-old, checkout limpo, `ORIG_HEAD` e reflog presentes; (b) uma troca de branch entre probe e merge fez o merge avançar a branch nova, não `main`. Os dois diretórios de ensaio foram removidos depois.

Não consegui verificar:

- os dados brutos dos oito lands/três quebras; verifiquei somente a afirmação preservada no header;
- qualquer quebra de trunk, erro de cwd ou erro de colagem ocorrido **depois** da entrega de suggest-and-copy;
- o comportamento visual ou um clique real da futura porta, porque ela não existe e não usei browser;
- comportamento em versões de Git diferentes da 2.53.0 ou em Windows;
- que um guard futuro “exatamente um call site” capture todas as maneiras de executar Git; não fiz mutation-test nem alterei `src/`/`test/`.
