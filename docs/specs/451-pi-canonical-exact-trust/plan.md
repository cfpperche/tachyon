# 451 — pi-canonical-exact-trust — plan

_Drafted from `spec.md` on 2026-07-25. The approach, not the steps (those go in `tasks.md`)._

## Approach

Add an exact-trust option at the Pi base-home boundary. Continue seeding and preserving every other
private JSON file as today, but exclude ambient `trust.json` when exact mode is active and atomically
replace the private trust store from normalized workspace/cwd inputs. Route canonical lifecycle and
captured-capability Pi materialization through exact mode; leave ordinary Pi materialization unchanged.

Prove the writer directly and through AgentManager fresh/restart/resume, then repeat the disposable
Pi 0.80.10 TTY scenario from the research before updating the parity matrix.

## Key decisions

_Each decision + why this option over the alternatives considered. Record rejected alternatives — they explain the design as much as the chosen path does._

- **Exact mode lives in the Pi base-home writer** — all canonical Pi projections share this boundary;
  rejected a post-materialization Workspace rewrite because it would split trust from private-home
  validation and publication.
- **Trust paths are workspace root plus effective cwd** — this matches the cross-runtime canonical
  contract and works for external managed worktrees; rejected parent-folder grants because Pi applies
  them transitively to unrelated descendants.
- **Non-canonical behavior is unchanged** — ordinary Pi intentionally owns later private mutations;
  rejected globally replacing trust because that would silently revoke user decisions outside the
  canonical profile contract.
- **Use the existing same-directory atomic writer and final no-follow/mode checks** — the private
  home ancestry is already mode `0700`; rejected direct truncation because a reader could observe
  partial JSON.

## Files touched

- `src/harness/HarnessManager.ts` — exact Pi trust projection and cwd propagation.
- `src/workspace/Workspace.ts` — select exact mode only for canonical Pi lifecycle routes.
- `test/unit/harness.test.ts` — direct boundary and non-canonical preservation coverage.
- `test/unit/agentManager.test.ts` — fresh/restart/resume lifecycle proof.
- `docs/runtimes/parity.md` — mark the trust lifecycle evidence after dogfood.
- `docs/specs/451-pi-canonical-exact-trust/*` — contract, plan, execution, and closure evidence.

## Risks & unknowns

- Captured-capability Pi profiles must receive the same effective cwd as plain canonical profiles.
- Workspace and cwd may resolve to the same path; the trust object must deduplicate deterministically.
- Replacing only `trust.json` must not reset auth/settings or content-addressed capability resources.
- A symlink/special-file private target must fail closed rather than be replaced through.

## Visual impact

None. The only visible behavior is removal of Pi's native TTY trust prompt.

## Sources consulted

- `docs/research/pi-trust-boundary-t-68ee7a.md`
- Pi 0.80.10 `dist/core/trust-manager.js` source map and `docs/security.md`
- `src/harness/HarnessManager.ts` Pi private-home and capability projection paths
- `src/workspace/Workspace.ts` canonical lifecycle materialization routing
- `test/unit/harness.test.ts` SDD 401/406 private-home invariants
