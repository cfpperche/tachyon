# 466 — claude-agent-form-parity — notes

_Created 2026-07-26._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- A mutation é normalizada pelo adapter: choices de source viram tuples exatos
  Claude ou Codex; campos escondidos Claude são removidos em vez de preservados.
- Selectors só são authored quando há model/effort e usam um único tuple
  agent-owned. O host repete a validação Claude antes de escrever.

## Deviations

- O primeiro fixture (`agent-soul-dogfood`) estava degradado por agents inline
  removidos; bug fora do escopo registrado em `t-315ce9`.
- O fixture Runtime Config possuía profiles sem authority na home descartável.
  Foi criado `agent-studio-canonical-dogfood`, vazio e próprio para create/edit.

## Tradeoffs

- Claude usa select fechado para effort; Codex mantém texto livre porque seu
  adapter aceita selectors distintos. Isso evita uma allowlist falsa comum.

## Open questions

Nenhuma.

## Dev Host evidence

- Cenário: `scripts/dev-host/scenarios/claude-agent-form-parity.mjs`.
- Fixture: `test/fixtures/agent-studio-canonical-dogfood`.
- Resultado 2026-07-26: todos os 10 asserts passaram — campos Claude visíveis,
  provider/service tier ausentes, três defaults globais, create real, selector
  com fork, permission workspace, round-trip model=`claude-opus-5`,
  effort=`xhigh`, readiness Ready e quatro policies Supported.
- Visual: screenshot pós-save inspecionado; layout sem truncamento/overflow e
  hierarquia clara entre Runtime selectors e Native configuration.

## Dogfood log

### 2026-07-26T14:11:24Z — pass (1/1) — source: tasks.md — commit: fbdb9c423b361668a14f731c74ed6203f82af437
- `npx vitest run test/unit/agentProfileStudio.test.ts test/unit/agentStudioDomain.test.ts` — pass

## Verification log

### 2026-07-26T14:11:46Z — pass (2/2) — source: tasks.md
- `npm run typecheck` — pass
- `npm run verify:full:quiet` — pass
