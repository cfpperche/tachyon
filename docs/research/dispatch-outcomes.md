# Registro de despachos — runtime × modelo × effort

_Aberto em 2026-08-05. Mantido pelo coordenador, escrito no MERGE de cada entrega._

## Por que existe

O coordenador precisa escolher runtime, modelo e effort para cada despacho. Até 2026-08-05 essa escolha era **palpite**: "codex é o revisor adversarial", "grok é fraco para arquitetura". Nenhuma dessas frases tinha medição por trás.

O dono cortou isso: primeiro usar todos sem distinção, depois classificar **pelas entregas**.

## Regras deste registro

1. Uma linha por despacho. Escrita no merge, a partir do que aconteceu — não da impressão.
2. **Fase 1: rodízio deliberado.** Não escolher por palpite. Escolher por palpite mede o palpite.
3. Nenhuma conclusão sem o **n** ao lado.
4. Variar as três variáveis, não só o runtime. Modelo e effort são metade do experimento.

## O viés que este registro tem, declarado

O coordenador é o **revisor E o classificador**. Se ele acreditar que um runtime é fraco, revisa com mais rigor e acha mais defeitos.

Mitigação: registrar **defeito objetivo** — chegou a main? o teste pegou? o dono reclamou? — e não impressão. Registrar também quando a revisão **não achou nada**, porque é o dado que o viés esconde.

## Mecanismo

- Agente temporário: `spawn_agent` com `cmd` livre. `claude --model sonnet-5`, `codex -m gpt-5.6-luna`, etc.
- Saved Agent: `model:` e `reasoningEffort:` no perfil canônico.
- **Até 2026-08-05 todos os despachos usaram o default.** Nenhuma variação de modelo ou effort foi testada.

---

## 2026-08-05 — backfill do primeiro dia

Todos com **modelo e effort default**. Registrado retroativamente, então o campo "defeitos que o coordenador pegou" é confiável (está nos merges) e o campo de custo não foi capturado.

| agente | task | kind | runtime | desfecho | defeitos pegos na revisão | questionou o brief |
|---|---|---|---|---|---|---|
| instructionsdoor | t-d48775 | arquitetura | claude | bloqueou | — | **3×** — contradição work-on-record, premissa falsa minha, "begin it" indevido |
| codexrev490 | review SDD 490 | revisão | codex | entregou | — | achou **2 P0** na minha spec |
| f490a | t-fb9087 A | arquitetura | claude | entregou + refutou | — | provou que minha fronteira era autocontraditória; reverteu o próprio commit |
| f490b | t-fb9087 B | execução | codex | entregou | 0 | — |
| f490c | t-fb9087 C | medição | grok | entregou | 0 | recusou inventar `verified` para grok |
| dmsec | t-a50ab0 | segurança | codex | entregou | 0 | — |
| dmchat | t-9b2741 | execução | grok | entregou | **1** — copiou lock sem staleness | — |
| vsixsmoke | t-e0a0f5 | design+execução | claude | entregou | 0 | achou audit que recusava toda release 0.57.x |
| workername | t-adf6bd | medição | grok | **refutou** | 0 | provou minha hipótese falsa; disse que não reproduziu |
| pinsketch | t-438e53 | execução | codex | entregou | 0 | — |
| callerscope | t-bec361 | execução | claude | entregou | 0 | — |
| codexmem | t-57f02e | medição | codex | entregou | 0 | promoveu só o eixo testado |
| locksafe | t-7843d0 | refatoração | claude | entregou | 0 | achou 4º mecanismo que eu não listei |
| filepickinv | t-7d1739 | levantamento | grok | entregou | 0 | corrigiu meu diagnóstico do sintoma |
| reloadcross | t-5fc17d | medição | claude | **refutou** | 0 | derrubou as 3 hipóteses de uma vez |
| primerline | t-486f43 | execução | claude | entregou | 0 | — |

---

## 2026-08-06 em diante — com modelo e effort registrados

| agente | task | kind | runtime | modelo/effort | desfecho | defeitos pegos | nota |
|---|---|---|---|---|---|---|---|
| lanewire | t-e3d14c | execução | codex | default | entregou | 0 | respondeu a pergunta de medição: condicional, não sempre |
| d16restore | t-a03fb6 | medição | grok | default | entregou | 0 | 4 respostas com evidência bruta (23 abas, 24 grupos, 1666 linhas JSON); nenhum defeito |
| guidancesplit | t-f050af | refatoração | codex | **gpt-5.6-luna** | entregou | 0 | primeiro despacho com modelo escolhido; ritual de supersessão em 3 casos, bytes históricos intactos |

---

### O que NÃO dá para concluir com n=16

Nada sobre runtime × kind. As células têm 2 a 6 amostras, o modelo nunca variou, e o effort nunca variou. Qualquer ranking daqui seria o palpite de volta com aparência de dado.

### O que o primeiro dia sugere, como hipótese a testar

1. **Questionar o brief foi o desfecho de maior valor**, e aconteceu em 8 de 16 — nos três runtimes. Não parece propriedade de runtime.
2. **Um único defeito escapou para a revisão** (`dmchat`, lock sem staleness), e a causa foi o agente seguir fielmente um precedente defeituoso do repositório. Isso é defeito do repo, não do agente.
3. **Duas refutações vieram de runtimes diferentes** (grok e claude). Ambas corretas.

### O que medir a seguir

- Variar **modelo** dentro do mesmo runtime, na mesma classe de task.
- Variar **effort** em task de arquitetura.
- Registrar **custo** (tokens/tempo), que hoje ficou vazio.
