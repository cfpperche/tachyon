# SDD 480 — plan

Phase 1 is ratified (spec §6). This is the work breakdown for what follows.

The ordering is not arbitrary: **provenance before projection, projection before pixels.** A graph
that draws a confident wrong parent is worse than no graph, because it will be believed — so no UI
phase starts until the ledger can distinguish proven from unproven.

## Phase 2 — identity and ledger (no UI)

| # | Work | Done when |
|---|---|---|
| 2.1 | Mint `turnId` at input submission; accept runtime-native ids as alias/evidence only | A turn has an id on every runtime; a runtime alias is stored beside it, never in place of it |
| 2.2 | Mint `executionId` before spawn and carry it into the child env at every seam in spec §3.1 | A reparented child is still attributable; a runtime that forbids env injection yields `unproven`, not a guess |
| 2.3 | Event ledger on `EngineEventJournal` — spawn/start/attach/exit/fail/orphan/share | Events survive a Control restart and rebuild the same graph |
| 2.4 | Sanitization at the write boundary via `redactSecrets` + `framingSafety` | A known secret in argv or env never reaches disk; test carries a real-shaped secret |
| 2.5 | Retention: bytes-per-agent primary, age secondary (spec §6.2) | A burst cannot exceed the byte budget; a quiet agent is retired by age |
| 2.6 | `InternalOperation` for every Bridge call (spec §6.3) | Every tool call appears; process detail only where proven |

**Gate:** provenance is trustworthy — `unproven` is reachable, distinguishable, and never silently
upgraded. Fail-before/pass-after tests. No UI work begins before this gate passes.

## Phase 3 — projection / read API

Per-agent projection that can express `shared`, `orphaned` and `unproven` without collapsing them.
A shared daemon has edges to every agent using it and is owned exclusively by none.

**Gate:** the four Phase-2 gaps from spec §3.4 are each demonstrably closed by a test.

## Phase 4 — canvas + accessible table

Canvas plus a tabular alternative that carries the same information. Filters by turn, state, type and
time; grouping for thousands of events; side panel with duration, exit code, resources when available,
cwd/worktree, tool origin and proof of identity.

**Gate:** headless QA at 760/1000/1400 with a heavy fixture; loading/empty/error and
agent-without-telemetry states all render; high volume does not stall the UI.

## Phase 5 — dogfood

Real agents, reparented processes, tmux, systemd, MCP, and cleanup. Update the parity matrix if any
runtime-visible contract moves — in particular which runtimes supply a turn-id alias (spec §6.1).

## Follow-ups deliberately not folded in

- **eBPF enrichment.** Investigation only, never a V1 dependency.
- **Destructive actions** (kill-subtree and friends). Out of V1; if ever added, through governed
  approval, never as a canvas affordance.
