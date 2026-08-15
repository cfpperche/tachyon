# 508 — paridade-verificavel — notes

_Created 2026-08-15._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- 2026-08-15, fatia 1: the declaration lives in `packages/engine/src/runtime/parity.ts` and starts
  with `session-hooks` and `headless-probe` for only Claude, Codex, and Grok. Both are `wired` for all
  three runtimes on the current product tree.
- `Workspace.silentPersistenceHooksDesired` decides eligibility, self-managed-session exclusion, and
  runtime support. Only the third question is parity. Its runtime decision was extracted once as
  `runtimeUsesSilentPersistenceHooks`; the private Workspace method calls it, and the parity test
  calls the same product decision. This avoids exposing or reimplementing the broader Workspace gate.
- Headless probe is derived from both production doors named by parity row 13: the adapter map used
  by Workspace and the Bridge `probe_agent` input schema. The declaration is `wired` only when both
  accept the runtime.

## Deviations

- Permission inject (candidate row 9) was not included. The production seam
  `AgentManager.applyAgentPermissionProjection` is a command transformation whose answer depends on
  authored projection, delegated lineage, and existing command flags. It has no callable per-runtime
  support verdict, and interpreting an unchanged command as unsupported would falsely classify
  Claude, whose posture may already be present in the launch command. This is non-derivable in the
  slice-1 sense and belongs in the slice-2 classification rather than a false unit derivation.

## Tradeoffs

- The runtime validator duplicates no product verdicts: it validates declaration shape and evidence
  only. TypeScript `satisfies` rejects malformed authored cells at compile time; the runtime validator
  also catches malformed data that crossed a cast or serialization boundary.

## Red-proof log

- Session hooks: temporarily removed `|| runtime === "grok"` from
  `runtimeUsesSilentPersistenceHooks`. Focused Vitest exited 1 with
  `session-hooks/grok: product=not-wired, declaration=wired`.
- Headless probe: temporarily removed `["grok", grokAdapter]` from the production adapter registry.
  Focused Vitest exited 1 with `headless-probe/grok: product=not-wired, declaration=wired`.
- Completeness: temporarily removed the `session-hooks/grok` declaration cell (and used an explicit
  unsafe cast solely to get the malformed fixture through transpilation). Focused Vitest exited 1
  with `session-hooks/grok: missing parity cell`; the axis test also named absent `grok`.
- `cannot` evidence: temporarily authored `{ verdict: "cannot" }` for `session-hooks/grok` through
  the same deliberate unsafe cast. Focused Vitest exited 1 with
  `session-hooks/grok: cannot requires a written reason`.
- `measured` evidence: temporarily authored `{ verdict: "measured" }` for `session-hooks/grok`.
  Focused Vitest exited 1 naming both missing fields: `runtimeVersion` and `measuredAt as YYYY-MM-DD`.
- Every mutation above was restored; the focused suite then returned green.

## Open questions

_Questions surfaced during the build with no answer yet. Owner or path to resolution if known._
