# 513 — tachyon-diff-review — notes

_Created 2026-08-17._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- Fatia 0 (`docs/research/t-7eb2e4-diff-review-load.md`): lista de arquivos com um diff materializado
  por vez, porque a mediana é 3 arquivos/184 linhas mas o extremo chega a 131/5.354.
- Realce degrada explicitamente para texto escapado acima de 20.000 caracteres: o maior arquivo real
  tem 381.252 caracteres e custou 78,9 ms medianos no `highlight.js`.
- Diff unificado é o formato inicial: a 880 px contém 93,46% das linhas medidas, contra 56,79% por
  metade no lado a lado.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._
