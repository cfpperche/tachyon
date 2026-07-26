# 466 — claude-agent-form-parity — plan

_Drafted from `spec.md` on 2026-07-26. The approach, not the steps (those go in `tasks.md`)._

## Approach

1. Expor constructors de policy Claude e opções derivadas do support resolver.
2. Normalizar a mutation conforme o adapter, com selectors apenas quando há
   valores e campos Claude fechados aos sinks medidos.
3. Renderizar selectors e famílias escalares para Claude/Codex usando o mesmo
   estado/round-trip.
4. Validar mutations no domínio antes da escrita, cobrir create/edit/switch.
5. Localizar textos e dogfoodar no Dev Host real.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Uma escolha de source, tuple derivado** — a UI não mantém lifecycle/treatment próprios.
- **Claude mostra model e effort; Codex mantém também provider/service tier** —
  apenas superfícies aceitas pela policy atual aparecem.
- **Troca de runtime limpa campos incompatíveis** — dados escondidos não podem
  permanecer na mutation.

## Files touched

- `src/config/agentNativeConfigPolicy.ts`
- `src/config/agentProfileStudio.ts`
- `src/webview/agent-studio-shell/{domain,App}.tsx`
- bundles de localização e testes Studio/Dev Host

## Risks & unknowns

- Perfis existentes com tuples antigos precisam abrir sem perda e normalizar no save.
- Mudança manual de command pode divergir do adapter até a serialização.

## Visual impact

Agent Studio New/Edit ganha campos de selectors e passa a mostrar Native
configuration para Claude; risco de densidade, labels truncados e controles
incorretos ao trocar runtime.

## Sources consulted

- `src/config/agentProfileStudio.ts`
- `src/webview/agent-studio-shell/domain.ts`
- `src/webview/agent-studio-shell/App.tsx`
- SDD 465 e `docs/runtimes/parity.md`
