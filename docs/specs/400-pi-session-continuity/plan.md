# 400 — pi-session-continuity — plan

_Drafted from `spec.md` on 2026-07-18._

## Approach

1. Promote `pi` into the resume adapter registry as a mint runtime: `--session-id <uuid>` on new managed sessions and exact `--session <uuid>` on resume.
2. Give each managed Pi agent a Tachyon-owned session directory under `.tachyon/pi-sessions/<agent>`, materialized as a real private directory and injected through `PI_CODING_AGENT_SESSION_DIR` on spawn/restart/resume. Commands already owning Pi session flags do not receive this storage override or a Tachyon resume block.
3. Add a bounded Pi JSONL resolver. It scans only the supplied private directory, refuses symlink/non-regular candidates, reads only the header, and requires exact header `type`, `id`, and canonical cwd.
4. Extend readiness, transcript lookup and resume admission to use the path-bearing capture resolver for Pi even though Pi is a mint runtime whose timestamped filename is not derivable directly from id.
5. Wire the daemon resolver environment so AgentManager passes the exact persisted private session directory. Preserve all existing runtime branches byte-for-byte where Pi is not selected.
6. Prove Pi's native persistence with a deterministic local-provider RPC dogfood: process A receives one zero-cost local assistant response, process B reopens the exact id, and the persisted conversation remains.

## Key decisions

- **Mint rather than capture** — Pi explicitly supports caller-selected `--session-id`; rejected newest-by-cwd capture because same-cwd agents would be ambiguous and crash-before-first-scan weaker.
- **Private session directory, not global `~/.pi` scanning** — exact per-agent namespaces make attribution deterministic and avoid reading unrelated user sessions; rejected global search despite Pi supporting it because it broadens authority beyond the managed agent.
- **Environment override, not `.pi` mutation** — `PI_CODING_AGENT_SESSION_DIR` is an official process-scoped Pi surface and survives all Tachyon lifecycle command builders without touching user config.
- **Header validation over filename trust** — Pi filenames include timestamp plus id; the resolver verifies header id/cwd and file type before accepting continuity.
- **Self-managed session flags remain opt-out** — explicit Pi lifecycle flags mean the user owns continuity; Tachyon still adds Bridge onboarding but records no managed resume authority.

## Files touched

- `docs/specs/400-pi-session-continuity/*` — contract and evidence.
- `src/resume/adapters.ts` — Pi mint/resume command adapter and self-managed flags.
- `src/resume/resolvers.ts` — bounded exact Pi transcript resolver.
- `src/agents/piSession.ts` — secure private session-directory materialization.
- `src/agents/AgentManager.ts` — Pi session env, config-home identity, path readiness and exact resume admission.
- `src/workspace/Workspace.ts` / `src/engine-service/engineService.ts` — resolver/materializer wiring.
- `test/unit/*` — command, resolver, isolation, readiness and lifecycle regressions.
- `scripts/dogfood/pi-session-continuity.mjs` — real Pi two-process persistence proof.
- `docs/runtimes/pi.md` — capability matrix update after proof.

## Risks & unknowns

- Adapter promotion changes Pi from generic lifecycle to resumable lifecycle; self-managed flag detection must prevent double session flags.
- Pi filenames are timestamped, so direct `transcriptPath` cannot honestly derive a path. Every resume/readiness branch must use the resolver instead of assuming id means present.
- Workspace-controlled `.tachyon` can be hostile/symlinked; materialization and resolver boundaries must fail closed on escape.
- Restart intentionally creates a new Pi session, while Resume reopens the old one. Tests must distinguish these semantics.

## Visual impact

Pi gains the existing Resume readiness/action surfaces already rendered for other runtimes. No new UI layout or strings are introduced; human dogfood checks behavior, not visual fidelity.

## Sources consulted

- SDD 399 implementation and human dogfood evidence.
- Pi `README.md`, `docs/session-format.md`, `docs/rpc.md`, and `docs/tmux.md`.
- Pi shipped `main.js`, `session-manager.js`, and `cli/args.js` for exact flag and header semantics.
- Tachyon `src/resume/{adapters,resolvers}.ts`, `src/agents/AgentManager.ts`, and session resume tests.
