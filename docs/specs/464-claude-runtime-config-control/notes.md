# 464 — claude-runtime-config-control — notes

_Created 2026-07-26._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

_Choices made where the spec/plan was ambiguous. The decision + why this option over the others considered in the moment._

- A revisão adversarial Opus 5 (`probe-fab094ec-923f-4323-8713-927719e8484c`)
  confirmou documento como unidade de CAS, payloads de tooling opacos e
  `settings.local.json` apenas como detector de shadowing.
- O snapshot indisponível ganhou mensagem explícita; uma configuração de workspace
  inválida não pode deixar o Control em loading infinito.

## Deviations

_Where implementation intentionally departed from `plan.md`, and why it was necessary or better._

- A mutation Claude ficou junto ao inspector em `runtimeConfig/claudeInventory.ts`.
  Esta slice edita a fonte humana medida, não a projeção privada do perfil canônico.
- O dogfood revelou e incorporou `t-ed6dbe`, `t-502f4a` e `t-a07c07`: fixture legado,
  symlinks de fontes nativas no mirror e divergência de profile-home entre F5/headless.

## Tradeoffs

_Alternatives weighed mid-build. The chosen path + what was given up + why it was worth it._

- MCP Claude permanece read-only. Nomes são úteis para inventário; corpos e toggles
  não têm uma operação nativa reversível medida nesta etapa.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._

Nenhuma para esta slice. Policy/autoria canônica seguem em `t-fdd3a0` e `t-36b7f0`.

## Dogfood log

- 2026-07-26 — `scripts/dev-host/scenarios/claude-runtime-config.mjs`: `ok=true`.
  Provou selector Claude, três documentos, settings medidos, MCP read-only, ausência
  de sentinelas/payloads, save global no profile-home descartável e fixture intacto.
- Screenshot: `.tachyon/dev-host/interactive-out/claude-runtime-config.png`.
- Gates: `npm run typecheck` e `npm run verify:full:quiet` passaram.

### 2026-07-26T13:38:52Z — pass (1/1) — source: tasks.md — commit: c0e50cfbbbc056dacab345d96b2e7d74899168da
- `npx vitest run test/unit/claudeRuntimeConfigInventory.test.ts test/unit/codexRuntimeConfigInventory.test.ts` — pass

## Verification log

### 2026-07-26T13:38:53Z — pass (2/2) — source: tasks.md
- `npm run typecheck` — pass
- `npm run verify:full:quiet` — pass
