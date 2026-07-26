# 467 — claude-codex-parity-audit — plan

_Drafted from `spec.md` on 2026-07-26. The approach, not the steps (those go in `tasks.md`)._

## Approach

1. Extrair requisitos da task e mapear evidência existente.
2. Rodar testes focados cobrindo profile, runtime config, harness e lifecycle.
3. Fazer dogfood Dev Host comparativo dos dois perfis.
4. Registrar lacunas contraditórias como tasks.
5. Publicar relatório e reconciliar a matriz.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Capacidade equivalente, protocolo nativo diferente** — fork Claude e ausência
  Codex são documentados, não mascarados.
- **Teste só prova o claim que exercita** — o relatório não usa green geral como
  substituto de evidência específica.

## Files touched

- `docs/reports/claude-codex-canonical-parity-audit-2026-07-26.md`
- `docs/runtimes/parity.md`
- cenário Dev Host comparativo se necessário

## Risks & unknowns

- Matriz pode estar mais otimista que os testes.
- Dogfoods anteriores podem não ter artefatos duráveis; cenário deve ser reproduzível.

## Visual impact

Sem nova UI; o Agent Form recém-landed será inspecionado comparativamente.

## Sources consulted

- SDDs 446, 463–466; `docs/runtimes/parity.md`
- testes profile/runtimeConfig/harness/AgentManager
