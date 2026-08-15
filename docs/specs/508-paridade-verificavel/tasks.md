# SDD 508 — fatias

**Verify:** `npm run verify:full`
**Dogfood-Opt-Out:** o instrumento é estático e o produto não muda de comportamento; as células `measured` são provadas por dogfood próprio, dentro das fatias 4 e 5, e registradas com versão e data.

Escopo: **claude, codex, grok.** Os outros runtimes vêm depois destes três estarem provados.

---

## Fatia 1 — o instrumento, provado em 2 ou 3 dimensões

- [ ] Uma declaração tipada em código com célula por (runtime × dimensão), aceitando `wired`, `measured` e `cannot`.
- [ ] `cannot` exige motivo escrito; `measured` exige versão do runtime e data. O teste recusa qualquer um dos dois sem o lastro.
- [ ] Duas ou três dimensões deriváveis implementadas, escolhidas por "o produto já decide isso numa função que dá para chamar".
- [ ] **Para cada uma, a prova de que o teste FICA VERMELHO quando o produto muda.** Sem isso a fatia não sai — um teste tautológico é verde e permanece verde.
- [ ] Teste de completude: célula faltando é vermelho.
- [ ] Uma das dimensões é a dos **hooks de sessão**, porque é o caso que originou a SDD e o único cuja falha já é conhecida.

**Se o desenho não servir para as mais fáceis, ele não serve para as 22.** Pare e diga, em vez de forçar.

---

## Fatia 2 — classificar as 22

Medição. Nada implementado além da classificação.

- [ ] Cada dimensão classificada: derivável do código, só medível por dogfood, ou impossível para algum runtime.
- [ ] O critério de cada classificação escrito — não "é difícil", mas o que exatamente impede a derivação.
- [ ] Para as impossíveis, qual runtime e por quê.
- [ ] Dito quantas das 22 caem em cada grupo. Se mais da metade for `measured`, isso é sinal contra o desenho e eu quero saber.

---

## Fatia 3 — as deriváveis restantes

- [ ] Cada dimensão derivável com o seu teste, derivando do produto e não repetindo.
- [ ] Cada uma com a prova de vermelho.
- [ ] Qualquer desacordo entre o veredito derivado e o que a `parity.md` afirma hoje é **achado**: registre e abra cartão, não ajuste a tabela para bater.

---

## Fatia 4 — as medidas

- [ ] Toda célula `measured` carrega versão do runtime e data.
- [ ] As que não têm medição registrada ficam explícitas como não medidas — não como `wired` por conveniência.
- [ ] Dito o que precisaria ser medido, e como, para cada lacuna.

---

## Fatia 5 — os "seams" que nunca viraram linha

A `parity.md` linha 66 lista costuras conhecidas que nunca viraram dimensão. **Uma delas era session-ownership hooks** — o defeito que o dono encontrou.

- [ ] Cada item da lista: vira dimensão, ou ganha motivo com data para continuar fora.
- [ ] Um item sem data não pode permanecer na lista.

---

## Fatia 6 — fechar

- [ ] Cada afirmação de paridade na `parity.md` sobre claude, codex e grok tem contraparte na tabela, ou está declarada como narrativa.
- [ ] Os desacordos encontrados viraram cartão.
- [ ] `docs/runtimes/parity.md` aponta para a tabela como fonte verificável.

---

## Armadilhas — valem para todas as fatias

- **Não faça o teste ler o `.md`.** O dono cortou isso: o teste é sobre o código.
- **Não repita o valor que quer vigiar.** `expect(grok).toBe(false)` passa para sempre. Derive da função que o produto usa.
- **Não force derivação onde ela não existe.** "O CLI dispara `Stop`" não se prova em unitário. Classificar como `measured` é resultado; inventar uma derivação falsa cria aparência de cobertura — a forma de defeito que este repositório encontrou seis vezes numa semana.
- **Não ajuste a tabela para bater com a prosa.** Se discordam, a prosa pode estar errada, e o desacordo é o achado.
- **Não amplie para outros runtimes.** Claude, codex e grok primeiro.
- **Worktree nova não tem `node_modules`.** `npm install` antes do primeiro check.
