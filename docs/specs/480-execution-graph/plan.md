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

## Closure (t-d2bb2f, 2026-07-28)

All five phases delivered. The gate for each was met; what follows is the evidence, and the honest
distance between "the feature works" and "the feature is running here".

**Dogfood against real operating-system objects** — `npm run dogfood -- execution-graph`, 15/15:

| Claim | How it was proven, on real objects |
|---|---|
| A pane carries its identity | Real tmux session created with `-e` (the path `TmuxService` uses); `show-environment` returned the minted id, and `attributionFor` graded it `measured`. |
| Reparenting does not break attribution | A really orphaned child: PPID reassigned to **systemd (2270)**, launcher gone — and `/proc/<pid>/environ` still carried the id it was born with. This is the spec's central claim, measured rather than argued. |
| Shared never becomes ownership | The real `tachyon-engine-*.service` claimed by three agents: `shared`, three claims, `exclusivelyOwned: false`. |
| `unproven` stays explicit | That same unit is `unproven` for all three — we did not start it and said so, rather than promoting a guess. |
| Exit is recorded with its code | A real `sh -c 'exit 42'`; the graph reads back `exit.code === "42"`. |
| Restart rebuilds the same graph | A second ledger over the same file produced a byte-identical projection. |
| No secret reaches disk | A real secret passed to a real process: absent from the file, while `--token` survived — redaction, not omission. |
| Canvas and table agree on real data | Parity asserted over the dogfood's own output, then rendered at 760/1000/1400. |

Evidence: `.tachyon/evidence/t-d2bb2f/` (results JSON, the captured VM, three widths). The captured VM
is committed as the `execution-graph-real` preview fixture, so the surface is regression-tested against
data the system actually produced rather than data a fixture author imagined.

**The parity matrix was deliberately NOT updated.** §7.1's Tachyon half is done and wired, but no
runtime feeds `nativeTurnId` — all three callers of `sendManagedAgentInput` omit it, so no alias is
ever populated in production. The runtime-visible contract did not move, and a matrix row would claim a
capability nothing has. Recorded as `t-ca9579`.

**Known distance from "running here", recorded rather than closed over:**

- `t-7ba92a` — this workspace's engine daemon predates the wiring, so the live section reads
  `no-telemetry` until the engine restarts on a build containing it. The dogfood therefore proved the
  seams against real OS objects on an isolated socket and storage root rather than hijacking the
  shared fleet: a dogfood that disturbs the fleet it measures is not evidence, it is an incident.
- `t-441b0f` — the host does not yet supply `detailFor`, so cwd/worktree/tool are absent in the panel
  even though the events carry them. Absent renders as absent, so it does not mislead.
- `t-ca9579` — no runtime supplies a turn-id alias yet.

**Out of scope and staying that way:** `t-d5066b` settled that `plugins/externalTool` is not a seam —
Tachyon does not originate those processes — and §3.1.1 records the measurement, including why letting
the shim write to the ledger would corrupt it.

## Follow-ups deliberately not folded in

- **eBPF enrichment.** Investigation only, never a V1 dependency.
- **Destructive actions** (kill-subtree and friends). Out of V1; if ever added, through governed
  approval, never as a canvas affordance.
