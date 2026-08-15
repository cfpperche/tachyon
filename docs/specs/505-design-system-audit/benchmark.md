# 505 — benchmark medido: escala de espaço e rampa tipográfica

_Medido 2026-08-15 por `escalaclaude` (t-d4eade). Material de decisão para a fatia 4. **Nada aqui foi
aplicado; nenhuma linha de CSS mudou.** O dono escolhe entre as opções._

Fica neste diretório e não em `docs/research/` porque não é pesquisa avulsa: é a entrada que faltava
para a fatia 4 do `spec.md`, ao lado de `questions.md` (a pergunta) e `decisions.md` (a resposta do
dono). A Q6 do `decisions.md` decidiu **DESENHAR** a escala; este arquivo é o prior art que a Q6
mandou consultar, com o custo de cada desenho possível.

Método, e ele é a metade que vale: **todo número abaixo foi lido de um arquivo em disco desta
máquina, com o comando que o produz registrado ao lado.** Nenhum veio de documentação, blog ou
memória. Onde não deu para medir, está dito na §9 e o número não aparece em lugar nenhum como se
tivesse dado.

---

## 1. As três referências, e por que exatamente estas

| # | Referência | Por que | Onde está |
| --- | --- | --- | --- |
| 1 | **VS Code 1.133.0** | É o HOST. A única restrição declarada do design system é que a cor vem do tema dele — e a medição achou que isso deixou de valer só para cor. | instalado |
| 2 | **Chrome DevTools 151** | É a "ferramenta densa" que o dono citou (Chrome). Resolve o mesmo problema da sidebar: muita informação, pouca altura. | instalado |
| 3 | **shadcn/Radix vendorizado + Tailwind 4.3.2** | Já está **dentro** do produto, em 5 componentes. Não é referência externa — é o que roda hoje em popover/dropdown/select/dialog/tooltip. | no repo |

Três bastam. A quarta não acrescentaria: como a §5 mostra, as três já **concordam** no essencial e a
divergência entre elas é o dado interessante. Uma quarta concordância seria ruído.

---

## 2. Referência 1 — VS Code 1.133.0 (o host)

### 2.1 É a mesma build que o dono roda

    $ node -e 'console.log(require("/home/goat/.vscode-server/bin/a5b500951314efd502d07465bd138dfbd714a960/product.json").version)'
    1.133.0

    $ node -e 'const p=require("/mnt/c/Users/cfpp/AppData/Local/Programs/Microsoft VS Code/a5b5009513/resources/app/package.json"); console.log(p.name, p.version)'
    Code 1.133.0

O servidor WSL (`a5b500951314efd502d07465bd138dfbd714a960`) e o cliente Windows (`a5b5009513`) são o
**mesmo commit**. O que segue não é "o VS Code em geral": é o VS Code desta máquina.

### 2.2 O achado que muda a conversa: o VS Code 1.133 tem tokens de TAMANHO registrados

Não é CSS espalhado. É um **registro**, no mesmo formato do registro de cores, lido de:

    arquivo: /mnt/c/.../resources/app/out/vs/workbench/workbench.desktop.main.js

    $ node -e 'const s=require("fs").readFileSync(FILE,"utf8"); const i=s.indexOf("spacing.sizeNone"); console.log(s.slice(i-900,i+700))'

Saída, transcrita (`Il(id, yl(valor,"px"), descrição)`):

    spacing.sizeNone     0px      cornerRadius.xSmall    2px      strokeThickness   1px
    spacing.size20       2px      cornerRadius.small     4px
    spacing.size40       4px      cornerRadius.medium    6px      codiconFontSize        16px
    spacing.size60       6px      cornerRadius.large     8px      codiconFontSize.compact 12px
    spacing.size80       8px      cornerRadius.xLarge   12px
    spacing.size100     10px      cornerRadius.circle 9999px      fontSize.heading1  26px
    spacing.size120     12px                                      fontSize.heading2  18px
    spacing.size160     16px      bodyFontSize          13px      fontSize.heading3  13px
    spacing.size200     20px      bodyFontSize.small    12px      fontSize.body1     13px
    spacing.size240     24px      bodyFontSize.xSmall   11px      fontSize.body2     11px
    spacing.size280     28px                                      fontSize.label1    12px
    spacing.size320     32px      fontWeight.regular     400      fontSize.label2    11px
    spacing.size360     36px      fontWeight.semiBold    600      fontSize.label3    10px
    spacing.size400     40px

O nome tem base 100 = 10px (`size40` = 4px, `size400` = 40px). O passo é **de 2 até 12, depois de 4**.

**`6px` é um passo dessa escala.** O `census.md:201` registra: *"`6px` is the most-used spacing value
in the product (155 uses, 22 files) and is not a step of the scale."* Continua verdade a respeito da
escala escrita **aqui** — e é falso a respeito da escala do **host**, que sempre teve esse passo.

(O census conta 155 e a §6 conta 146 para o mesmo valor: o census varre mais propriedades, a §6 se
limita a `padding`/`margin`/`gap`. Os dois estão certos; digo qual recorte uso em cada número.)

### 2.3 E o host **injeta esses tokens no webview**, exatamente como as cores

Este é o achado decisivo, e não é inferência — é a função que monta o estilo do webview:

    $ node -e '... s.indexOf("getWebviewThemeData") ...'

    getWebviewThemeData(){ ...
      let l = qTe().getColors().reduce((f,v)=>{ ... f["vscode-"+v.id.replace(".","-")]=b.toString(); ...},{}),
          u = tdt(),
          p = u.getSizes().reduce((f,v)=>{ let b=u.resolveDefaultSize(v.id,c);
                                           b && (f["vscode-"+v.id.replace(/\./g,"-")]=Zlt(b)); return f},{}),
          m = {"vscode-font-family":_O, ..., ...l, ...p, ...}

`l` são as cores. `p` são os TAMANHOS, pela mesma transformação de nome, espalhados no mesmo objeto.
Não é inferência de nome: a função que monta a variável está três funções acima, e é literal —

    function _Wo(s){ return `--vscode-${s.replace(/\./g,"-")}` }
    function Il(s,o,e,t){ return edt.registerSize(s,o,e,t) }      function tdt(){ return edt }

`Il` (§2.2) registra em `edt`; `tdt()` devolve `edt`; `getSizes()` é chamado nele. `spacing.size60`
→ `--vscode-spacing-size60`, e o nome bate com o que o próprio workbench consome no CSS
(`--vscode-spacing-size40` aparece 139 vezes lá).

E há um detalhe que vai além do pedido: o valor registrado é
`{light, dark, hcDark, hcLight}` (`function yl(s,o="px")`), existe um
`registerSchema("vscode://schemas/workbench-sizes")` e um `notifyThemeUpdate`. **Os tamanhos são
temáveis, não constantes** — um tema pode redefini-los, exatamente como redefine cor.

**Consequência para o produto:** a frase "a cor vem do tema do VS Code" tem, desde a 1.133, uma irmã
disponível de graça — o espaço, o raio, a espessura de traço e a rampa de rótulo também podem vir. O
dono avisou para perguntar se algo é limite ou se foi só como alguém resolveu uma vez; aqui é o
contrário — o que parecia limite (só cor herda) virou opção aberta enquanto ninguém olhava.

### 2.4 Quanto o próprio VS Code já migrou (a honestidade da referência)

    $ grep -o -- '--vscode-spacing-size[a-zA-Z0-9]*' workbench.desktop.main.css | sort | uniq -c | sort -rn
        139 size40 (4px)   27 size120 (12px)   11 size100 (10px)    6 sizeNone
         69 size20 (2px)   20 size240 (24px)   10 size320 (32px)    6 size400
         63 size80 (8px)   14 size160 (16px)                        4 size200
         38 size60 (6px)   12 size280 (28px)                        1 size360
                                                              total 420

    $ node measure.mjs workbench-desktop.main.css   # padding/margin/gap literais
        total 3586 ocorrências, 66 valores distintos
        645× 4px   472× 8px   389× 6px   379× 2px   238× 10px   193× 12px   189× 3px   177× 5px   121× 16px   96× 1px

Ou seja: **o host está ~12% migrado para a própria escala** (420 usos de token contra 3586 literais), e
o legado dele tem 66 valores distintos — pior que os 32 daqui. A referência não é um sistema perfeito
que nós violamos; é um sistema que **declarou** a régua e está andando na direção dela. O que se herda
é a régua declarada, não a fotografia do legado dele — a mesma distinção que a Q6 fez aqui.

O ranking de uso **no código já migrado** é o dado útil, porque é onde alguém decidiu de propósito:
4px, depois 2px, depois 8px, depois 6px, depois 12px.

### 2.5 A rampa de chat: seis degraus, em `em`

    $ grep -o -- '--vscode-chat-font-size-body-[a-z]*: *[^;}]*' workbench.desktop.main.css | sort -u
        xs .846em   s .923em   m 1em   l 1.077em   xl 1.231em   xxl 1.538em

Sobre a base 13px do `bodyFontSize`: **11, 12, 13, 14, 16, 20**. Seis degraus, e todos caem em inteiro
— a rampa foi desenhada em px e escrita em `em`, não o contrário.

Raw font-size no CSS do workbench (o legado, para contraste): 244× 12px, 131× 11px, 93× 13px,
54× 14px, 49× 16px, 24× 10px, 14× 10.5px, 14× 11.5px, 13× 18px, 9× 9px.

---

## 3. Referência 2 — Chrome DevTools 151.0.7922.108

### 3.1 Como foi lido

O DevTools mora dentro de `resources.pak` comprimido e **não é grepável em disco** (`grep -c -a
'--sys-size' /opt/google/chrome/resources.pak` → `0`). O binário instalado, porém, serve os próprios
assets do frontend pela porta de depuração:

    $ google-chrome --version
    Google Chrome 151.0.7922.108

    $ google-chrome --headless=new --no-sandbox --remote-debugging-port=9333 --user-data-dir=<scratch> about:blank &   # PID guardado
    $ curl -s http://127.0.0.1:9333/devtools/design_system_tokens.css -o devtools-design_system_tokens.css   # 41.098 bytes
    $ kill <PID>                                                                                            # pelo PID, nunca por nome

É o binário instalado servindo o próprio bundle — mesma coisa que ler o arquivo, só que através da
porta que o Chrome abre para isso.

### 3.2 A escala

    $ grep -o -- '--sys-size-[0-9]*: *[^;]*' devtools-design_system_tokens.css | sort -u

    sys-size-1    1px     sys-size-6   12px     sys-size-11  24px     sys-size-16  48px
    sys-size-2    2px     sys-size-7   14px     sys-size-12  28px     sys-size-17  56px
    sys-size-3    4px     sys-size-8   16px     sys-size-13  32px     sys-size-18  64px
    sys-size-4    6px     sys-size-9   20px     sys-size-14  40px     sys-size-19  80px
    sys-size-5    8px     sys-size-10  22px     sys-size-15  44px     (… até 41 = 1280px)

    $ grep -o -- '--sys-shape-corner-[a-z-]*: *[^;]*' ...
    extra-small 4px   small 8px   medium 16px   medium-small 12px   large 24px   full 9999px

### 3.3 A rampa

    $ grep -o -- '--sys-typescale-[a-z0-9-]*: *[^;]*' devtools-design_system_tokens.css | sort -u

    body1      16px / 24px      headline1  24px / 32px
    body2      14px / 20px      headline2  20px / 24px
    body3      13px / 20px      headline3  18px / 24px
    body4      12px / 16px      headline4  16px / 24px
    body5      11px / 16px      headline5  14px / 20px
    monospace  11px / 1.2

**Cinco degraus de corpo** (16, 14, 13, 12, 11), cada um com entrelinha declarada junto. Não existe
`10px` e não existe `9px` na ferramenta mais densa que o dono citou. O menor texto do DevTools é
**11px**, e o menor texto monoespaçado também.

---

## 4. Referência 3 — shadcn/Radix vendorizado (o que já roda aqui)

### 4.1 Radix não contribui escala nenhuma

Os 5 componentes de `packages/webview-ui/src/webview/shared/ui/vendor/` são shadcn sobre primitivos
Radix. Radix é **unstyled por projeto** — não traz espaçamento nem tipo. Toda a métrica desses
componentes vem das classes Tailwind que o shadcn escreveu. Então "medir o Radix" é medir o Tailwind.

### 4.2 Tailwind 4.3.2, lido do disco

    $ node -e 'console.log(require("./node_modules/tailwindcss/package.json").version)'      → 4.3.2
    $ grep -n -- '--spacing:' node_modules/tailwindcss/theme.css                              → 325:  --spacing: 0.25rem;
    $ grep -n -- '--text-[a-z0-9]*:' node_modules/tailwindcss/theme.css | head -3
        347:  --text-xs: 0.75rem;      (+ --text-xs--line-height: calc(1 / 0.75))
        349:  --text-sm: 0.875rem;     (+ --text-sm--line-height: calc(1.25 / 0.875))
        351:  --text-base: 1rem;

Escala de espaço = **múltiplos de 4px**, com meios-passos (`p-1.5` = 6px). Tipo em `rem`.

### 4.3 O que os componentes vendorizados realmente usam

    $ grep -oE '\b(p|px|py|…|gap|size|text|rounded)-(…)' vendor/*.tsx | sort | uniq -c | sort -rn

    13 size-4    10 gap-2     8 py-1.5    7 rounded-md   5 pl-8    4 px-2    3 p-1    3 text-xs
    10 text-sm    7 left-2    5 top-2     5 rounded-sm   2 py-2    2 px-3    1 p-6    1 text-lg

Convertido: `gap-2`=8px, `py-1.5`=**6px**, `px-2`=8px, `px-3`=12px, `p-1`=4px, `p-6`=24px, `pl-8`=32px,
`size-4`=16px. Tudo dentro de {4, 6, 8, 12, 16, 24, 32}.

### 4.4 E aqui está uma incoerência medida, não suposta

O `tailwind-theme.css` deste repo mapeia **só** `--color-*`, `--font-*` e `--radius-*`. Não toca em
`--spacing` nem em `--text-*`:

    $ grep -n 'spacing\|--text-' packages/webview-ui/src/webview/shared/tailwind-theme.css     → (vazio)
    $ grep -rn 'html[^a-z]*{' --include=*.css packages/webview-ui/src -A6 | grep font-size      → (vazio)

Sem override de `--text-*` e sem `html { font-size }`, a raiz fica nos 16px do navegador. Logo:

    text-sm  =  0.875rem  =  14px          ← popover, dropdown, select, dialog, tooltip
    --ds-small           =  12px           ← 128 declarações no resto do produto

**Os cinco componentes vendorizados renderizam texto 2px maior que o resto do app, e ninguém decidiu
isso.** É uma das causas mecânicas do *"telas mudam a aparência"*. Não é o assunto desta medição
(é fatia 8), mas é o exemplo mais limpo de que o problema é a falta de uma régua única, não gosto.

---

## 5. Onde concordam, e onde divergem

### 5.1 Concordam — e a concordância é forte

**Espaço.** Os passos pequenos de todas as três:

    passo    VS Code 1.133      DevTools 151      Tailwind 4.3.2      concordância
     2px     spacing.size20     sys-size-2        spacing×0.5         3 de 3
     4px     spacing.size40     sys-size-3        spacing×1           3 de 3
     6px     spacing.size60     sys-size-4        spacing×1.5         3 de 3
     8px     spacing.size80     sys-size-5        spacing×2           3 de 3
    12px     spacing.size120    sys-size-6        spacing×3           3 de 3
    16px     spacing.size160    sys-size-8        spacing×4           3 de 3
    24px     spacing.size240    sys-size-11       spacing×6           3 de 3
    32px     spacing.size320    sys-size-13       spacing×8           3 de 3

**Oito passos com concordância unânime das três referências: 2, 4, 6, 8, 12, 16, 24, 32.**

**A menor distância utilizável é 2px, não 4px.** As três a declaram. E as duas que separam traço de
espaço declaram **1px como espessura de traço, nunca como distância**: `strokeThickness: 1px` no VS
Code, `sys-size-1: 1px` no DevTools. Isso responde a pergunta A do cartão com um resultado diferente
do que ele antecipava: o custo não é "164 lugares se convergirem em 4px" — é 19 lugares, que são
justamente os `padding: 1px` de pill/badge e os `gap: 1px` de tira de aba
(`sidebar.css:54`, `design-system.css:100`, `plugins.css:50`, `pin-preview.css:9`).

**Tipo.** A rampa de chat do VS Code e a rampa de corpo do DevTools:

    VS Code chat (base 13)    11   12   13   14   16   20
    DevTools body                       body5 11 · body4 12 · body3 13 · body2 14 · body1 16
                              ─────────────────────────────────────
    interseção                11   12   13   14   16

**Cinco degraus idênticos, em dois sistemas que não se conhecem.** É a convergência mais informativa
do documento inteiro. Ambos param em **11px** por baixo.

**Raio** (fora do escopo pedido, mas medido de graça e vale registrar): VS Code
2/4/6/8/12, DevTools 4/8/12/16/24, Tailwind 2/4/6/8/12. E o `--ds-radius: 6px` deste repo é
exatamente `cornerRadius.medium` do host. **Convergiu — não foi adotado.**

### 5.2 Divergem — e o motivo importa mais que o número

**a) 10px: o VS Code tem, o DevTools não.** `spacing.size100` = 10px existe e é usado 11 vezes no
código migrado do host. O DevTools pula de 8 para 12. Motivo provável: o VS Code herda uma tradição de
UI de editor onde 10px é a altura de meia-linha de lista; o DevTools é Material 3 reescalado, e o
Material não tem 10. **Isto é a decisão mais cara deste documento**, porque `10px` tem 73 usos de
espaço e 75 de tipo aqui.

**b) 14px: o DevTools tem, o VS Code não.** `sys-size-7` = 14px; o VS Code salta de 12 para 16.
Motivo provável: o DevTools mede ícones de 14 e linhas de árvore de 14; o VS Code usa 16 para ícone
(`codiconFontSize`) e não precisou do intermediário. Aqui `14px` tem 24 usos de espaço.

**c) A menor entrelinha declarada.** O DevTools declara entrelinha **junto** com cada degrau
(12/16, 11/16). O VS Code declara só o tamanho. O repo tem **13 entrelinhas distintas em 74
declarações** (`1.35`×15, `1.4`×14, `1.5`×10, `1`×8, `1.3`×7, `1.45`×5, `1.25`×5, …). Uma rampa sem
entrelinha resolve metade do *"a distância das coisas me incomoda"* — a outra metade é vertical.

**d) Tailwind escala em `rem`, os outros dois em `px`.** Não é detalhe: é exatamente por isso que a
§4.4 acontece. Enquanto o host fala px e o Tailwind fala rem sobre uma raiz de 16px que ninguém
configurou, os dois nunca vão coincidir por acaso.

---

## 6. A realidade do produto, re-medida hoje

O cartão da tarefa traz números de uma medição anterior. Refiz, porque *"uma Task escrita não é uma
Task aceita"*. A premissa **se mantém**, com duas correções para cima:

    $ node cost.mjs packages/webview-ui/src     # só padding/margin/gap, ignorando var()

    sítios de declaração com ≥1 literal px:  591      (o cartão diz 568)
    ocorrências de literal px:               792      (um shorthand conta 2)
    arquivos atingidos:                       30

    146× 6px   109× 8px    98× 4px   80× 12px   73× 10px   70× 2px   52× 5px   30× 3px
     24× 14px   21× 7px    19× 1px   13× 18px   12× 9px     8× 20px   7× 16px   6× 24px  …

**591 e não 568** — a diferença é a definição de "literal" (sítio de declaração × ocorrência de
valor). Uso 591 sítios / 792 ocorrências daqui em diante, e digo qual dos dois em cada linha.

    $ node type.mjs packages/webview-ui/src     # font-size, resolvendo --ds-* para px

    475 declarações; 11 relativas (em) que não resolvi
     16× 9px    2× 9.5px    75× 10px    1× 10.5px   131× 11px   180× 12px
      5× 12.5px  23× 13px    1× 13.5px  10× 14px      8× 16px    …acima de 16: 17,18,22,24,26,28,30

**São 11 tamanhos distintos de texto até 16px, não nove:** 9, 9.5, 10, 10.5, 11, 12, 12.5, 13, 13.5,
14, 16. O cartão contou nove porque `9.5`, `10.5` e `13.5` estavam escondidos em três arquivos. A
pergunta B do cartão fica pior do que estava: **onze degraus, quando as duas referências densas
sustentam cinco.**

Onde vivem os dois casos que o dono pediu para rastrear:

    9px    16 usos — badge/chevron/rótulo micro em caixa alta
                     board.css:72 · sidebar.css:{64,123,174,202,494,501} · runtime-config.css (7×) · engine-workspace.css (2×)
    12.5px  5 usos — texto de banner de aviso e grade chave/valor
                     plugins.css:{54,65,83} · design-system.css:{175,566}

---

## 7. As opções

### 7.1 Escala de espaço — três opções, custo medido

Custo por `node cost.mjs`, contando uma ocorrência como "fora da escala" quando o valor não é passo
dela. `1px` está contado como fora em todas as três (as três referências dizem que 1px é traço, não
distância) e vira 2px ou vira borda — 19 ocorrências, decisão de quem migrar.

---

**Opção A — herdar do host.** Passos: `2, 4, 6, 8, 10, 12, 16, 20, 24, 32` — **10 passos.**

| passo | referência que o sustenta |
| --- | --- |
| 2px | `spacing.size20` (VS Code) · `sys-size-2` (DevTools) · unânime |
| 4px | `spacing.size40` · `sys-size-3` · `--spacing`×1 · unânime |
| 6px | `spacing.size60` · `sys-size-4` · `p-1.5` · unânime |
| 8px | `spacing.size80` · `sys-size-5` · unânime |
| **10px** | `spacing.size100` — **só VS Code.** O DevTools não tem. |
| 12px | `spacing.size120` · `sys-size-6` · unânime |
| 16px | `spacing.size160` · `sys-size-8` · unânime |
| 20px | `spacing.size200` · `sys-size-9` |
| 24px | `spacing.size240` · `sys-size-11` · unânime |
| 32px | `spacing.size320` · `sys-size-13` · unânime |

    custo:  194 / 792 ocorrências fora da escala  (24%)
            180 / 591 sítios de declaração        (30%)
             23 / 30  arquivos
    os que somem: 5px×52 · 3px×30 · 14px×24 · 7px×21 · 1px×19 · 18px×13 · 9px×12 · 28px×5 · resto ×18

O que só esta opção permite: escrever `var(--vscode-spacing-size60, 6px)` e o espaçamento passa a
**vir do tema**, como a cor. Se a Microsoft reescalar a densidade do editor, o Tachyon acompanha sem
commit. Custa dez `var(…, fallback)` no `tokens.css`, porque `engines.vscode` é `^1.96.0` e os tokens
são de 1.133 (§9.a).

Contra: dez passos é muito. `10px` e `20px` existem porque o host tem, não porque o produto precise —
e são os dois que o DevTools recusa.

---

**Opção B — o núcleo unânime.** Passos: `2, 4, 6, 8, 12, 16, 24, 32` — **8 passos.**

Cada passo tem **três de três** referências (a tabela da §5.1 inteira, sem exceção). É a única opção
em que nenhum passo depende de uma referência só.

    custo:  275 / 792 ocorrências  (35%)
            254 / 591 sítios       (43%)
             23 / 30  arquivos
    os que somem: 10px×73 · 5px×52 · 3px×30 · 14px×24 · 7px×21 · 1px×19 · 18px×13 · 9px×12 · resto ×31

A diferença de A para B são **81 ocorrências**, e quase todas são a mesma decisão: `10px` → `8px` ou
`12px`, 73 vezes, em 12 arquivos. É literalmente a divergência (a) da §5.2 cobrada em dinheiro. A Q6
do `decisions.md` já previu esta conta e a aceitou de olhos abertos.

Ainda dá para consumir os tokens do host (todos os 8 passos existem lá) — herda-se um subconjunto.

---

**Opção C — grade estrita de 4.** Passos: `4, 8, 12, 16, 24, 32` — **6 passos.**

Sustentada por Tailwind (`--spacing: 0.25rem` × 1,2,3,4,6,8) e por ser subconjunto próprio das outras
duas. É a régua dos componentes vendorizados, tirando o meio-passo `p-1.5`.

    custo:  491 / 792 ocorrências  (62%)
            420 / 591 sítios       (71%)
             28 / 30  arquivos
    os que somem: 6px×146 · 10px×73 · 2px×70 · 5px×52 · 3px×30 · 14px×24 · 7px×21 · 1px×19 · resto ×56

Contra, e é grave: mata `6px` (146 usos, o valor mais frequente do produto) e mata `2px` (70 usos) —
**os dois são passo unânime das três referências.** C não é "mais rigorosa que B"; é B com dois passos
que todas as referências têm removidos por gosto de simetria. É a opção mais simples de explicar e a
única que as referências medidas contradizem.

---

    resumo        passos   ocorrências     sítios      arquivos   herda do host?
    Opção A         10      194 (24%)     180 (30%)      23       sim, integral
    Opção B          8      275 (35%)     254 (43%)      23       sim, subconjunto
    Opção C          6      491 (62%)     420 (71%)      28       não (6px e 2px saem)

**Não recomendo nenhuma — a escolha é do dono.** O que a medição diz, e é tudo o que ela pode dizer:
o eixo real da decisão é `10px` (81 ocorrências entre A e B), e C compra simplicidade contra as três
referências, não a favor delas.

### 7.2 Rampa tipográfica — três opções, custo medido

Base: 475 declarações de `font-size`, 464 resolvidas em px. `--ds-small`/`--ds-micro`/`--ds-body`/
`--ds-section`/`--ds-title` resolvidos para 12/11/13/11/16.

---

**Rampa 1 — espelho do host.** Degraus: `10, 11, 12, 13` + `18, 26` de display — **6 degraus, 4 de
texto.**

Cada um é um token registrado do VS Code 1.133: `fontSize.label3` 10, `label2`/`body2` 11, `label1` 12,
`body1`/`heading3` 13, `heading2` 18, `heading1` 26. Quatro degraus de texto porque é quantos o host
declara abaixo de 16.

    custo: 52 / 464 declarações  (11%)
    somem: 9px×16 · 14px×10 · 16px×8 · 12.5px×5 · 28px×3 · 9.5px×2 · 22px×2 · 24px×2 · 10.5/13.5/17/30 ×1
    9px    → 10px  (label3)
    12.5px → 12px ou 13px, caso a caso: os 3 de plugins.css são banner/kv, os 2 de design-system.css são banner
    16px   → some como texto; 16 é `codiconFontSize` no host, tamanho de ÍCONE, não de texto

A mais barata, e a única cujos degraus podem literalmente ler `var(--vscode-fontSize-label1, 12px)` e
acompanhar o host. Contra: `26px` é um degrau de página inteira que uma sidebar não usa, e `14px`
morre (10 usos) contrariando o DevTools.

---

**Rampa 2 — a interseção densa.** Degraus: `11, 12, 13, 14, 16` + `20` de display — **6 degraus, 5 de
texto.**

É a interseção exata da §5.1: os cinco degraus em que a rampa de chat do VS Code e a rampa de corpo do
DevTools concordam, mais o `20px` que ambos têm no topo (`xxl` / `headline2`). Cinco degraus de texto
porque é exatamente quantos o DevTools sustenta numa ferramenta mais densa que a nossa sidebar.

    custo: 112 / 464 declarações  (24%)
    somem: 10px×75 · 9px×16 · 12.5px×5 · 28px×3 · 9.5px×2 · 18px×2 · 22px×2 · 24px×2 · 10.5/13.5/17/26/30 ×1
    9px    → 11px  (dois degraus de salto; os badges de sidebar/board crescem visivelmente)
    10px   → 11px  (75 declarações em 12 arquivos — este é o custo da rampa 2, inteiro)
    12.5px → 12px ou 13px

Vem com entrelinha de graça, porque o DevTools declara o par: 11/16, 12/16, 13/20, 14/20, 16/24. Isso
resolve as 13 entrelinhas distintas da §5.2(c) junto, sem uma segunda decisão.

Contra: 91 declarações sobem de tamanho (10px e 9px). Numa sidebar já apertada, isso é uma mudança de
densidade real e visível — é a opção que mais muda o que o dono vê, para os dois lados.

---

**Rampa 3 — duas densidades nomeadas.** Degraus: operador `10, 11, 12, 13` · leitura `13, 16, 20` —
**7 papéis nomeados sobre 6 valores distintos**, porque `13px` é papel nos dois lados: é a dobradiça.

Esta é a Q8 do `decisions.md` (*"duas densidades, nomeadas"*) aplicada à rampa em vez de só ao
padding. Os quatro de operador saem do VS Code (`label3`/`label2`/`label1`/`body1`, §2.2 — a régua do
chrome do host); os três de leitura saem do DevTools (`body3` 13 / `body1` 16 / `headline2` 20, §3.3 —
a régua do conteúdo). `13px` é os dois ao mesmo tempo, e é o `--vscode-font-size` do host, o que dá
uma junta natural entre as densidades.

    custo: 47 / 464 declarações  (10%)  ← a mais barata das três
    somem: 9px×16 · 14px×10 · 12.5px×5 · 28px×3 · 9.5px×2 · 18px×2 · 22px×2 · 24px×2 · 10.5/13.5/17/26/30 ×1
    9px    → 10px  (operador/label3)
    12.5px → 13px  (é texto de leitura: banner e kv; a densidade de leitura o acolhe sem encolher)
    14px   → 13px ou 16px conforme a densidade da tela

É a única opção em que `12.5px` tem um lugar **por razão de desenho** e não por arredondamento: ele
existe hoje porque alguém queria "um pouco maior que o corpo apertado" — que é literalmente o que a
densidade de leitura nomeia.

Contra: seis valores é o teto do que ainda se explica, e a dobradiça em `13px` exige disciplina —
duas densidades que compartilham um degrau podem voltar a derivar se ninguém nomear qual é qual no
ponto de uso. É a opção que mais depende da fatia 6 existir de verdade.

---

    resumo    valores   dos quais texto (≤16px)   declarações a mudar   9px →   12.5px →
    Rampa 1      6                4                 52 / 464  (11%)      10px    12 ou 13
    Rampa 2      6                5                112 / 464  (24%)      11px    12 ou 13
    Rampa 3      6                5                 47 / 464  (10%)      10px    13px
                                  (7 papéis: 4 de operador + 3 de leitura, com 13px nos dois)

Em todas as três, **`9.5px`, `10.5px`, `13.5px` e `12.5px` desaparecem** — os quatro meios-pixels
somam 9 declarações e nenhuma referência medida tem meio pixel em lugar nenhum.

E em todas as três, **os onze tamanhos de texto de hoje viram quatro ou cinco** (seis valores
contando os degraus de display acima de 16px). A pergunta B do cartão tem a mesma resposta pelas três
referências: cinco ou seis no total, nunca onze.

---

## 8. O que é herança do host e o que é escolha nossa

Separado explicitamente, porque é onde o dono precisa saber se está seguindo ou decidindo.

### Herança — o host declara, e nós podemos só ler

| o quê | como se herda |
| --- | --- |
| Escala de espaço 2…40 | `var(--vscode-spacing-size60, 6px)` — injetado no webview (§2.3) |
| Raio 2/4/6/8/12/circle | `var(--vscode-cornerRadius-medium, 6px)` — idem |
| Espessura de traço 1px | `var(--vscode-strokeThickness, 1px)` — idem |
| Rampa de rótulo 10/11/12/13 | `var(--vscode-fontSize-label1, 12px)` — idem |
| Corpo 13px | já herdado hoje, via `--vscode-font-size` |
| Cor | já herdado hoje. Restrição declarada do produto. |

Herdar aqui não é preguiça: é a mesma coerência que a regra da cor já escolheu, aplicada aos eixos que
o host passou a expor. E acompanha o host de graça quando ele mudar.

### Escolha nossa — nenhuma referência decide por nós

| o quê | por que é escolha |
| --- | --- |
| **Quantos dos passos herdados usar** | O host declara 13. Nós escolhemos 10, 8 ou 6. Ele não opina. |
| **Se `10px` sobrevive** | VS Code sim, DevTools não. 81 ocorrências dependem disto. É a decisão. |
| **Se `14px` existe** | DevTools sim, VS Code não. |
| **Onde o operador acaba e a leitura começa** | Q8 é nossa. Nenhuma referência tem duas densidades nomeadas. |
| **Entrelinha** | O DevTools dá o par pronto; o host não. Adotar o par é escolha. |
| **Famílias de fonte** | Fixadas pelo dono. Fora de escopo, não medidas. |
| **`--spacing` do Tailwind e a raiz de 16px** | Hoje é acidente (§4.4), não escolha. Vira escolha em qualquer das opções. |
| **Movimento, sombra, z-index** | Fora do escopo desta medição. |

---

## 9. O que não consegui medir, e por quê

**a) Desde qual versão o VS Code expõe os tokens de tamanho ao webview.** Só a 1.133.0 está em disco.
Não dá para saber daqui se a 1.96 (mínimo declarado em `apps/vscode-extension/package.json`,
`engines.vscode: ^1.96.0`) tem `--vscode-spacing-*`. **Consequência prática:** qualquer opção que leia
tokens do host precisa de `var(--token, fallback)`, e o fallback tem de ser o valor da escala
escolhida. São ~10 fallbacks no `tokens.css`, não 591 sítios — mas não é zero, e não medi.

**b) Não confirmei em runtime que as variáveis chegam num webview do Tachyon.** A leitura é do código
que monta o objeto de estilo (`getWebviewThemeData`, §2.3) e do nome derivado, que bate com o que o
workbench consome. Isso é forte, mas é leitura de fonte, não medição no vivo. **A prova de verdade é
uma linha** — abrir uma superfície do Tachyon no VS Code do dono e ler
`getComputedStyle(document.documentElement).getPropertyValue('--vscode-spacing-size40')`. Não fiz
porque exigiria subir a extensão, e o contrato desta tarefa é medição sem tocar no produto. Se a
opção A ou B for escolhida, **esta linha é o primeiro passo da fatia 8**, antes de qualquer migração.

**c) O CSS do DevTools por painel, para contar frequência de uso dos tokens.** Consegui o registro de
tokens (`design_system_tokens.css`), não o corpo dos painéis: `inspectorCommon.css` e
`design_tokens.css` respondem 200 com 0 bytes pela porta de depuração, e o `.pak` é comprimido. Então
para o DevTools tenho a **régua declarada**, mas não o equivalente ao "12% migrado" que medi para o VS
Code (§2.4). Não sei o quanto o DevTools obedece à própria escala.

**d) Terminal / shell propriamente dito.** O dono citou "shell". O `xterm.css` que o VS Code embarca
(`node_modules/@xterm/xterm/css/xterm.css`) descreve a geometria do canvas do terminal, não uma escala
de UI — não tem padding, gap nem rampa para comparar. Um emulador de terminal com design system
próprio não está instalado nesta máquina. Então o eixo "shell" está coberto **indiretamente**, pela
régua de chrome denso do VS Code (que hospeda o terminal) e pelo DevTools, e **não** por um emulador
medido. Fica dito para não parecer que foi medido.

**e) Entrelinha como eixo próprio.** Contei a dispersão (13 valores distintos em 74 declarações) e
registrei o par tamanho/entrelinha do DevTools, mas não propus rampa de entrelinha nem custei uma. Não
estava no pedido, e cabe na mesma decisão da rampa — a Rampa 2 já vem com os pares prontos.

**f) Nada foi validado visualmente.** Isto é medição de fonte, não julgamento de tela. Nenhuma
captura foi tirada e nenhum veredito visual é dado aqui. As 56 capturas de
`/home/goat/tachyon-design-package` existem e mostram o estado atual; comparar qualquer opção contra
elas é trabalho da fatia 8, com âncora escrita **antes**.

---

## 10. Reprodução

Os scripts de medição ficaram no scratchpad da sessão (`measure.mjs`, `repo.mjs`, `cost.mjs`,
`type.mjs`, `remap.mjs`, `ctx.mjs`) e não entram no repo — são instrumento de uma medição, não
maquinaria do produto. Cada número acima traz o comando que o produz; os que dependem de script trazem
o nome dele e o que ele faz. Refazer é reescrever cinco greps e um `reduce`, e isso é mais barato de
manter que seis arquivos que ninguém vai reexecutar.
