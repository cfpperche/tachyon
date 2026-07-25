# 454 — codex-canonical-parity — plan

_Drafted from `spec.md` on 2026-07-25. The approach, not the steps (those go in `tasks.md`)._

## Approach

Audit the existing private-home materializer and lifecycle test first. Add Codex permission metadata only
for values accepted by the installed CLI under strict config parsing, then make the unit contract assert
it. Reconcile the matrix rows to the existing lifecycle evidence rather than adding a redundant launch
path. Preserve the explicit unavailable-fork outcome.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Treat the established lifecycle test as the main behavior proof** — it exercises the actual
  AgentManager launch boundary three times; rejected a second parallel materializer just to make a new
  test path.
- **Use strict-config parser validation for declared modes** — it is non-billable and proves this installed
  Codex accepts the typed keys; rejected a model invocation because it would spend external authority
  without adding lifecycle coverage.
- **Describe fork as unavailable** — Codex has no native fork adapter; rejected an emulation that could
  misrepresent transcript lineage.

## Files touched

- `src/runtime/runtimeProfile.ts` — Codex permission metadata.
- `test/unit/runtimeProfile.test.ts` — metadata regression coverage.
- `docs/runtimes/parity.md` — summary reconciliation and dated evidence.
- `docs/specs/454-codex-canonical-parity/*` — contract and evidence.

## Risks & unknowns

- Strict-config accepts syntactic values but does not replace real launch lifecycle proof; retain the
  existing AgentManager lifecycle test as the stronger evidence.
- Matrix marks must remain scoped to canonical profiles, not imply unsupported legacy commands receive a
  policy projection.

## Visual impact

No rendered surface changes.

## Sources consulted

- `src/harness/HarnessManager.ts`
- `src/agents/AgentManager.ts`
- `src/runtime/runtimeProfile.ts`
- `test/unit/agentManager.test.ts` (`t-1a3d50`)
- `test/unit/harness.test.ts`
- `docs/runtimes/parity.md`
