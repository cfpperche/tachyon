# SDD 508 — a paridade entre runtimes deixa de ser prosa

**Status:** draft
**Criada:** 2026-08-15
**Documento afetado:** [`docs/runtimes/parity.md`](../../runtimes/parity.md) — 1.246 linhas, 22 dimensões
**Escopo:** **claude, codex, grok.** Os outros vêm depois que estes três estiverem provados.

## 1. O problema, e como ele apareceu

O dono viu no Runtime Ops que `claude` e `codex` tinham 5 hooks e `grok` tinha 3, e perguntou por quê. Era diferença de paridade real entre três runtimes de primeira classe.

**A tela denunciou. O documento não.**

Depois ele perguntou a coisa certa: *"nós temos testes que garantem que a matriz não é só prosa?"*

**Não temos.** Medido: nenhum teste e nenhum gate lê `docs/runtimes/parity.md`. As únicas referências no código são comentários **apontando para ela** — o código cita o documento, e nada faz o documento responder pelo código.

### E não foi esquecimento

A matriz **sabia**. Linha 66, num parágrafo de *"seams reais e desiguais (ainda não linhas da matriz)"*, está escrito: **session-ownership hooks (Claude `--settings`)**.

Foi um adiamento deliberado, e o adiamento nunca teve prazo. **Nada força uma costura conhecida a virar dimensão**, então ela ficou parada enquanto o produto mudava em volta.

## 2. O que esta SDD constrói

Uma declaração de paridade **em código**, derivada do produto, com um teste que a compara — não que a repita.

O documento continua existindo e continua sendo prosa; o que muda é que a prosa passa a ter uma contraparte verificável, e o desacordo entre as duas vira vermelho.

### As três naturezas de célula

    wired      o caminho existe no código          o teste DERIVA do produto e compara
    measured   o CLI real faz aquilo               só dogfood prova; a célula carrega versão e data
    cannot     não dá para acoplar neste runtime   MOTIVO ESCRITO é obrigatório

**A terceira é o pedido explícito do dono:** *"se algo não puder ser acoplado a um runtime, aí precisamos ser claros quanto a isso"*. Hoje uma célula pode ficar em branco. Depois desta SDD, não pode.

### A regra que decide se um teste presta

**Derivar, nunca repetir.** Um teste que escreve `expect(grok).toBe(false)` reafirma a linha que deveria vigiar, e passa para sempre. O teste tem de chamar a função que o produto usa para decidir, com entrada por runtime, e comparar com a tabela.

No caso dos hooks: chamar `silentPersistenceHooksDesired` com uma config por runtime. Se alguém editar a allowlist sem editar a tabela, vermelho.

### O molde já existe aqui

`packages/shared/src/agents/agentRuntimeAdmission.ts` faz isso hoje, e o próprio comentário descreve o padrão:

> *"pins this set against `KNOWN_AI_CLIS` minus supported and minus anything with a resume or brief channel, so a catalog change cannot drift unnoticed"*

A lista não é repetida no teste — é derivada de outra fonte e comparada. Não é desenho novo.

## 3. Critérios de aceite

- [ ] **Cenário: mudar o código sem mudar a tabela fica vermelho**
  - **Dado** uma dimensão `wired` cujo veredito a tabela declara
  - **Quando** alguém altera o caminho de produto que decide aquele veredito
  - **Então** o teste falha nomeando a dimensão, o runtime e os dois vereditos em desacordo

- [ ] **Cenário: célula em branco é impossível**
  - **Dado** as 22 dimensões e os três runtimes
  - **Quando** uma dimensão é acrescentada, ou um runtime entra no escopo
  - **Então** o teste falha até que todas as células existam

- [ ] **Cenário: `cannot` sem motivo é recusado**
  - **Dado** uma célula declarada `cannot`
  - **Quando** ela não carrega motivo escrito
  - **Então** o teste falha

- [ ] **Cenário: `measured` sem evidência é recusado**
  - **Dado** uma célula declarada `measured`
  - **Quando** ela não carrega versão do runtime e data da medição
  - **Então** o teste falha. O teste **não** verifica a medição em si — só que a alegação está lastreada.

- [ ] Cada uma das 22 dimensões classificada como derivável ou não, com o motivo por escrito.
- [ ] A lista de *"seams que ainda não são linhas"* resolvida: cada item vira dimensão ou ganha motivo com data.
- [ ] `docs/runtimes/parity.md` e a tabela em código não se contradizem, e existe um caminho que prova isso.

## 4. Fora de escopo

- **Runtimes além de claude, codex e grok.** Decisão do dono: os outros vêm depois que estes três estiverem provados.
- **Provar a medição de célula `measured`.** Um teste unitário não roda o CLI de outro fornecedor. O teste garante que a alegação tem versão e data; a medição em si é dogfood.
- **Reescrever a `parity.md`.** Ela é narrativa e continua sendo. Se depois ficar claro que parte dela deve ser gerada da tabela, isso é outra decisão.
- **Corrigir desníveis de paridade que a auditoria encontrar.** Cada um vira cartão próprio; esta SDD constrói o instrumento e o usa uma vez.

## 5. Riscos nomeados

- **Uma dimensão pode não ser derivável e ainda assim ser real.** "O CLI dispara `Stop`" não se prova em teste unitário. Classificar isso como não-derivável é resultado; forçar uma derivação falsa seria criar aparência de cobertura — a forma de defeito que este repositório encontrou seis vezes numa semana.
- **A tabela pode virar segunda gaveta.** Vinte e duas dimensões × três runtimes é uma superfície grande. Se a tabela crescer para além do que o teste consegue derivar, ela vira prosa de novo, só que em TypeScript.
- **O teste pode virar tautologia sem ninguém notar.** É o defeito mais provável desta SDD, e o único jeito de detectá-lo é provar que ele FALHA quando o produto muda — não que passa quando está tudo certo.
