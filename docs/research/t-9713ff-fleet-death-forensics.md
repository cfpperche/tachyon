# t-9713ff — forense da morte da frota em 06/08

Data da revisão: 2026-08-09  
Árvore examinada: `9c5fb27d65152cda8528ac832286b346f981fdec` (`HEAD` antes deste relatório)

## Veredito

**Causa achada.** O `finally` de `scripts/dogfood/runtime-remeasure.ts` executava
`tmux kill-server` com um `TMUX_TMPDIR` privado, mas preservava o `TMUX` herdado do pane da frota.
O tmux escolhe o servidor indicado por `TMUX` antes de consultar `TMUX_TMPDIR`. Portanto a limpeza
do ensaio privado enviava `kill-server` ao servidor que hospedava a frota inteira.

O commit `8bfb8ff45c8fbb9f5fcd54e653c4e9d50b43ce33` removeu `TMUX` e `TMUX_PANE` desse ambiente.
Ele é ancestral do `HEAD` examinado. O cenário `runtime-remeasure` ainda existe e continua
alcançável por `node scripts/dogfood/run.mjs runtime-remeasure`; o defeito não desapareceu por remoção de Soul,
Role, Execution graph, verify de worktree ou GC de transação. O ponto perigoso foi corrigido no
próprio cenário.

As três ocorrências instrumentadas de 17:31, 19:54 e 20:17 fecham causalmente com esse caminho: o
servidor tmux mudou de PID logo após o `remeasure` executar ou retomar, e a limpeza continha a chamada
capaz de atingir exatamente aquele servidor. Para a primeira ocorrência, entre 13:19 e 13:26, não
encontrei um carimbo durável da invocação do script. Ela tem o mesmo efeito observado, mas não a
atribuo individualmente com a mesma força.

## Evidência preservada de 06/08

- O journal completo de `t-9713ff` registra a progressão das medições, inclusive os PIDs do servidor,
  as contagens de sessões, a memória disponível e a descoberta final do emissor.
- O transcript durável do coordenador em
  `/home/goat/tachyon/.tachyon/harness/claude/projects/-home-goat--cache-tachyon-worktrees-b349073a-claude/05dfb028-5b5a-47f2-92dc-7820167f9a83.jsonl`
  contém a investigação e o resumo compactado posterior, que identifica o mesmo arquivo e commit.
- Os registros do engine em
  `/home/goat/.local/state/tachyon/engines/b349073a65a4a4d49f0cca4cd5bb1dad/state/runtime-observability-v1/`
  preservam capturas às 13:26:40/43, 15:42:15, 17:30:45, 19:54:15 e 20:17:30. Eles delimitam as
  retomadas, mas não registram o `kill-server`; não foram usados para inventar causalidade.
- O próprio commit corretivo contém a medição de seleção de socket feita em 06/08:
  `TMUX_TMPDIR=/tmp/privado tmux list-sessions` ainda listava a frota; removendo `TMUX`, o cliente
  tentava o socket privado e falhava ao conectar.
- O diff de `8bfb8ff4` altera somente o ambiente da chamada de limpeza: depois do spread de
  `process.env`, define `TMUX: undefined` e `TMUX_PANE: undefined`.

## Suspeitos novos examinados

### 1. `TMUX` herdado vence o `TMUX_TMPDIR` privado — confirmado

Artefatos: diff e mensagem do commit `8bfb8ff4`, código atual nas linhas 304–313 de
`scripts/dogfood/runtime-remeasure.ts`, transcript e journal. A função `readCodexScreen` do mesmo
arquivo já removia as duas variáveis; apenas o `finally` não removia. Isso explica por que o ensaio
parecia isolado e por que a sua limpeza atingia toda a frota.

### 2. A causa saiu com um subsistema removido — descartado

Artefato: o arquivo ainda existe, está registrado em `scripts/dogfood/run.mjs` e em `package.json`, e
o comando de dogfood ainda o alcança. As remoções citadas no brief não pertencem à cadeia
`dogfood runner → runtime-remeasure → finally → tmux`. O que mudou nessa cadeia foi o ambiente da
chamada em `8bfb8ff4`.

### 3. Outro emissor atual repete a mesma forma — nenhum encontrado na superfície varrida

Artefato: `test/unit/tmuxFleetGuardBehavior.gen.test.ts` percorre os arquivos TypeScript e JavaScript
sob `src/` e `scripts/` por AST. Ele rejeita chamadas tmux que herdam o servidor sem um socket próprio
ou sem remover `TMUX`, rejeita destruição dirigida ao literal `tachyon` e contém uma réplica exata da
linha antiga para provar o vermelho. Em 09/08 executei:

```text
npx vitest run test/unit/tmuxFleetGuardBehavior.gen.test.ts test/unit/tmuxEnv.test.ts
2 arquivos passaram; 6 testes passaram.
```

Isso prova que a forma original não existe hoje na superfície varrida. Não prova ausência universal:
o próprio teste documenta que wrappers desconhecidos com argv dinâmico e `new TmuxService()` são
portas residuais. Além disso, um socket dinâmico fixado com `-L` ou `-S` pode ser a frota sem que a
análise estática conheça o valor. Não encontrei artefato que ligue essas portas às quedas de 06/08.

## Suspeitos descartados e como

- **Memória/OOM:** nas ocorrências instrumentadas havia 9.708 MB e 9.557 MB disponíveis pouco antes
  da morte; nenhum OOM foi registrado. O descarte inicial por PSI médio era fraco e foi corretamente
  revogado; os números de amostragem fina são a evidência válida.
- **Engine:** `NRestarts=0`; o engine permaneceu de pé enquanto o PID do servidor tmux mudou.
- **Scopes systemd:** nenhum evento `Stopped`, `Stopping`, `Killing`, `Failed` ou `Deactivated` na
  janela medida.
- **`ptrace`:** as mensagens eram verificações de permissão de `pidfd_getfd`, negadas pelo Yama, não
  anexos. O helper foi corrigido por higiene, mas não causou a queda.
- **SIGABRT do Grok:** houve um sinal fatal na segunda queda, mas quedas posteriores ocorreram sem
  incremento no contador de sinais fatais; Grok também sobreviveu em outra onda.
- **`exit-empty`:** servidores morreram com 6, 5 e 4 sessões, e uma ocorrência já tinha
  `exit-empty off`. Não estavam vazios.
- **Contagem de sessões:** a contagem subia porque o coordenador reiniciava `remeasure`; era o
  `remeasure` retomando e limpando seu servidor que causava a morte. A terceira amostra com quatro
  sessões refutou o limiar proposto.
- **Agente de órfãos e 85 processos órfãos:** o código apenas relatava e havia memória folgada; não
  existia caminho de `kill` para o servidor.
- **Driver de CLIs como categoria:** o isolamento geral estava correto. O defeito era uma chamada
  específica no `finally`, que preservava `TMUX` apesar do comentário e das outras chamadas seguras.

## Alcance atual

O caminho exato de 06/08 está morto: a chamada ainda roda, mas não consegue mais selecionar o
servidor herdado porque recebe `TMUX: undefined`; o helper compartilhado também remove `TMUX`; e o
sentinela atual falha sobre uma réplica da forma antiga. Não executei o cenário real nem qualquer
comando contra o tmux vivo, porque reproduzir a forma antiga mataria sessões e violaria o contrato
desta investigação.

Não houve mudança de produto nesta passada. O único artefato novo é este relatório.
