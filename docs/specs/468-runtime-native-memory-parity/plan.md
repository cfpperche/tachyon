# 468 — runtime-native-memory-parity — plan

_Drafted from `spec.md` on 2026-07-26. The approach, not the steps (those go in `tasks.md`)._

## Approach

1. Inspect installed runtime versions, their local documentation/source and
   Tachyon's current private-home projection.
2. Cross-check unstable runtime behavior against primary upstream sources.
3. Model native memory as orthogonal capability facts, not one optimistic
   supported boolean.
4. Publish a durable threat-boundary report and add a named parity dimension.
5. Open implementation tasks without adding memory behavior in this research.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Evidence state is first-class** — `declared` is not promoted to `verified`
  merely because Tachyon writes a setting.
- **Availability and control are independent** — a runtime can have memory that
  Tachyon cannot safely control, or no built-in memory while plugins can inject
  arbitrary persistent context.
- **Disable is the safe V1 operation** — enablement is authorable only after
  isolation and behavioral injection/write tests exist.
- **Runtime stores remain runtime-owned** — the adapter reports and controls
  them; it does not import them into `memory/active/`.

## Files touched

- `docs/research/runtime-native-memory-parity-t-d4c42e.md`
- `docs/runtimes/parity.md`
- `docs/specs/468-runtime-native-memory-parity/*`

## Risks & unknowns

- Feature behavior is changing rapidly across installed CLI versions.
- A disabled setting may still leave stale bytes, background provider state or
  plugin injection unless a behavioral probe proves otherwise.
- Model calls needed for behavioral proof cost money and must use isolated
  synthetic facts, never user memory.

## Visual impact

None; this is architecture/research. Follow-up UI must render provenance and
uncontrolled states before offering a toggle.

## Sources consulted

- Installed Claude 2.1.220, Codex 0.145.0, Grok 0.2.112, OpenCode 1.18.4,
  Pi 0.80.10 and Hermes 0.18.2.
- Runtime primary docs/source referenced by the research report.
- SDD 423, SDD 427, `agentProfileProjection.ts`, `HarnessManager.ts` and
  native-config policy regressions.
