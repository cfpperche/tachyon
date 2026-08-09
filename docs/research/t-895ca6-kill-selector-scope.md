# t-895ca6 — alcance de seletores de processo por padrão

Medição feita em 2026-08-09 sobre a árvore `79fa632a26a577c58fccf6d8a547556a04f363ef` e os 127 briefs presentes em `/home/goat/tachyon/.tachyon/briefs`.

## Resultado

Os quatro números pedidos, na ordem:

1. **2** comandos acionáveis de `pkill`/`killall`/`kill` por padrão em `scripts/`, `src/` e nos briefs: ambos são `pkill -f`; `scripts/` tem 0, `src/` tem 0 e os briefs têm 2.
2. **2** casam um processo que a frota compartilha: ambos selecionam `webview-preview/serve.mjs`, que qualquer worktree pode executar e que usa a porta fixa 5174.
3. **0** têm PID disponível no ponto de uso.
4. **2** não têm PID disponível: os dois são limpeza **antes** do spawn e tentam descobrir um servidor “stale” que o agente atual não criou nem registrou.

Não contei ocorrências narrativas que apenas descrevem o incidente de `verify-full.mjs`, nem APIs/métodos chamados `killAll`, nem `process.kill(pid, ...)`, `child.kill(...)`, `kill -0 "$pid"` e `kill "$pid"`: nenhum desses é seleção por padrão. Também procurei composições equivalentes (`pgrep`, `pidof`, `ps`/`xargs` alimentando `kill`) e não encontrei nenhuma nos três universos.

## Tabela sítio a sítio

| Sítio | Comando | Alvo compartilhado | PID disponível ali? | Classificação |
| --- | --- | --- | --- | --- |
| `/home/goat/tachyon/.tachyon/briefs/spawn/visPass2.md:3` | `pkill -f webview-preview/serve.mjs \|\| true` | Sim; nome de script executável por qualquer agente, com porta fixa 5174 | Não | Instrução de pré-limpeza procura processo de proprietário desconhecido antes de criar o processo deste agente |
| `/home/goat/tachyon/.tachyon/briefs/spawn/visPass3.md:3` | `pkill -f webview-preview/serve.mjs \|\| true` | Sim; mesmo alvo | Não | Mesmo molde, repetido em outro brief |

As frases “Kill the preview server when done” nesses mesmos briefs não acrescentam sítios por padrão: são prosa e, no fim da execução, o agente pode e deve usar o PID que recebeu ao iniciar seu próprio servidor. Portanto a substituição correta para o teardown final é direta; o problema medido na tabela é a pré-limpeza sem recibo de propriedade.

## Ocorrências deliberadamente fora da contagem

O brief desta própria tarefa contém várias cópias de `pkill -f "scripts/verify-full.mjs"`, mas todas são relato, regra citada ou enunciado do que medir; nenhuma manda o agente executá-lo. Contá-las inflaria um incidente em vários call sites. Da mesma forma, `killAll()` no produto é uma operação de domínio sobre sessões enumeradas, não o utilitário Unix `killall` nem um seletor por linha de comando.

Os usos reais de `kill` encontrados em shell recebem variáveis de PID (`host_pid`, `xvfb_pid`, `HOST`, `XVFB`) ou usam `-0` para sondagem. Os usos TypeScript/JavaScript recebem PID explícito ou o handle do `ChildProcess`. Eles são justamente o substituto seguro pedido pela tarefa e não pertencem à família medida.

## Recomendação: uma linha em project guidance

Recomendo **guidance**, não guard de source:

> Em host compartilhado, nunca encerre processos por nome ou padrão de linha de comando (`pkill`, `killall`, `pgrep | kill`); guarde no spawn o PID/handle do processo que você criou e encerre somente esse recibo de propriedade.

O custo da guidance é uma linha aplicada também ao lugar onde o defeito realmente nasceu: comandos ad hoc e briefs. Ela corrige os dois sítios medidos e cobre o incidente de terminal com `verify-full.mjs` sem fingir que a árvore de fontes é a única porta.

O custo de um guard é desproporcional aqui. Para respeitar o precedente de `tmuxFleetGuardBehavior.gen.test.ts`, ele precisaria analisar ASTs de TS/JS, AST de shell e ainda algum formato estruturado para comandos embutidos em Markdown. Mesmo assim, um teste hermético do repositório não vê briefs efêmeros sob `/home/goat/tachyon/.tachyon/briefs`, nem um comando digitado diretamente no terminal — exatamente as três ocorrências materiais (dois briefs e o incidente). Esse mecanismo teria manutenção permanente, allowlists para usos PID-targeted e cobertura residual no principal door.

O guard de tmux se paga porque a mesma falha derrubou a frota cinco vezes e havia invocações executáveis versionadas para analisar. Aqui há zero invocação perigosa versionada em `scripts/`/`src/`, dois briefs antigos do mesmo molde e, no pior caso medido, uma execução de gate perdida. A guidance tem alcance maior e custo menor para a família realmente observada.

Se a regra voltar a falhar depois de escrita — especialmente se aparecer uma chamada versionada em `scripts/` ou `src/` — essa recorrência muda a relação custo/benefício. Nesse ponto, o guard deve seguir o molde AST do tmux e provar vermelho com uma cópia fiel que chegue ao launcher por alias, não testar a ausência de um literal.

## Reprodução da contagem

Foram usados `rg --hidden --no-ignore` sobre `scripts`, `src` e `/home/goat/tachyon/.tachyon/briefs` para levantar `pkill`, `killall`, comandos shell `kill` e seletores equivalentes (`pgrep`, `pidof`, `ps`, `xargs`). Cada resultado foi então classificado no ponto de uso; busca textual foi apenas o inventário, não a decisão. O guard de referência foi lido integralmente para comparar o custo e o alcance do formato AST.
