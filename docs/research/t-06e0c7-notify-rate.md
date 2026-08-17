# t-06e0c7 — taxa real de `notify()`

Medição feita em 2026-08-17 sobre o ledger durável do engine do workspace Tachyon vivo,
`~/.local/state/tachyon/engines/b349073a65a4a4d49f0cca4cd5bb1dad/events/*.jsonl`.
A amostra cobre 23 h 41 min, de `2026-08-16T22:35:13.453Z` a
`2026-08-17T22:16:03.497Z`, enquanto o projeto estava em uso real contínuo: agentes trabalhando,
Tasks mudando de estado, notas sendo escritas, entregas e dismissals. Foram lidos os nove ledgers de
instâncias desse diretório e excluído `executions.jsonl`; cada evento usado tinha `kind: "notice"`.

O snapshot contém **108 notices, todos com id único**. Uma contagem anterior citava 118; a releitura
reprodutível do diretório no horário acima encontrou 108 (`rg -c '"kind":"notice"'` soma 108), então
os resultados abaixo usam as linhas que de fato existem e declaram o corte temporal.

## Resultado

- **Taxa média de parede:** 0,076 por minuto (108 / 1.420,83 min), ou um notice a cada 13,2 min.
  Essa média inclui ociosidade e não decide o desenho sozinha.
- **Rajada:** pico de **5 notices no mesmo minuto civil** (`2026-08-16T23:03Z`). Dos 62 minutos
  ativos, 35 tiveram 1 notice, 14 tiveram 2, 8 tiveram 3, 4 tiveram 4 e 1 teve 5.
- **Intervalo entre notices consecutivos (107 intervalos):** mínimo 0 s, p25 8,260 s, mediana
  36,014 s, p75 165,357 s, p90 529,801 s, p95 886,277 s e máximo 43.853,462 s. 32/107
  intervalos foram de até 10 s e 63/107 de até 60 s: a atividade chega em grupos, mesmo com média
  de parede baixa.
- **Nível:** 89 `info` (82,4%), 19 `warn` (17,6%) e 0 `error` (0%).
- **Comprimento de `message`:** mediana 135 caracteres; intervalo interquartil 81–146; p90 151,
  p95 152; mínimo 36 e máximo **161** (média 119,0). A mensagem típica já é larga demais para uma
  célula curta de status bar.
- **Actions:** 91/108 (84,3%) tinham uma action e seguem para QuickPick; 17/108 (15,7%) não tinham
  action e são as que hoje chegam a `setStatusBarMessage`.

O subconjunto que realmente mudará de superfície é ainda mais raro: os 17 notices sem action tiveram
pico de 3/min, mediana de 516,001 s (8,6 min) entre consecutivos e níveis 13 `info` / 4 `warn` /
0 `error`. Seus comprimentos foram 74–153 caracteres (mediana 77).

**Recomendação sobre histórico:** não precisa — o fluxo relevante sem action teve só 17 ocorrências em 23 h 41 min, mediana de 8,6 min entre elas e pico de 3/min; persistir a última mensagem resolve sem criar um centro de notificações.

## Custo e destino da instrumentação

O ledger já era escrito pelo produto; esta leitura retroativa não adicionou nenhum custo ao caminho
quente durante a amostra. Antes de descobrir esse dado, foi criado um probe temporário, gated por
`TACHYON_NOTIFY_MEASURE_FILE`, no único `NotificationService.dispatch`. Um benchmark sintético de
10.000 chamadas mediu o custo total do probe (serialização + `appendFileSync`) em 3,165 µs mediano,
5,149 µs p95, 15,935 µs p99 e 0,666 ms máximo. O probe não participou dos números de taxa e foi
removido por completo depois da descoberta do ledger; não fica código nem variável de ambiente no
produto.

Não agreguei os outros diretórios de engine à taxa de rajada: eles representam workspaces diferentes
e podem operar simultaneamente, enquanto um rodapé pertence a um workspace. Como controle de
amplitude, há 259 notices com ids únicos em 16 engines entre 2026-07-16 e 2026-08-17, mas somar seus
picos produziria uma carga que nenhum rodapé individual recebe.
