# 403 — pi-reviewer-safety — plan

_Drafted from `spec.md` on 2026-07-18._

## Approach

1. Extend `reviewerSafeCommand` with Pi-specific structural parsing. Recognize long/short exclude forms, require exactly one exclusion whose normalized set is `bash,edit,write`, reject all other Pi tool-selection flags, and inject the canonical long form when absent.
2. Extract a small predicate for the canonical reviewer denylist and use it in `withRuntimeBridge`: arbitrary Pi filters still fail closed, while the exact reviewer restriction is allowed because it cannot hide Tachyon Bridge tool names.
3. Add measured permission metadata to `runtimeProfile.pi`, explicitly scoped to Delivery reviewer shell-level posture.
4. Cover argv insertion, byte preservation, conflict zero-effects, restart/resume persistence, Bridge compatibility and ordinary Pi non-reviewer behavior.
5. Real-Pi dogfood loads a probe extension under the canonical exclusion and records `ctx.getActiveTools()`, proving mutators absent and read/probe tools present.
6. Keep parity `~` until human Delivery reviewer dogfood confirms code inspection + Bridge completion without writes.

## Key decisions

- **Denylist mutators instead of allowlisting readers** — an allowlist would suppress dynamically projected Bridge tools; excluding known Pi built-ins preserves orchestration.
- **Exact canonical set** — additional/partial/duplicate filters are refused rather than normalized silently, keeping reviewer intent auditable.
- **Structural insertion** — use the existing parsed runtime-token boundary so `env`, launchers and `--` positional boundaries remain safe.
- **Delivery role only** — reviewer authority comes from `deliveryJoin.role`, not an agent name or prompt.
- **Shell-level claim only** — Pi has no OS sandbox. Bridge authorization remains its own governance boundary.

## Files touched

- `src/agents/AgentManager.ts` — reviewer command adaptation and Bridge-compatible filter predicate.
- `src/runtime/runtimeProfile.ts` — Pi permission metadata.
- `test/unit/agentManager.test.ts`, `test/unit/runtimeProfile.test.ts` — safety and lifecycle matrix.
- `scripts/dogfood/pi-reviewer-safety.mjs` — real Pi active-tool proof.
- `docs/runtimes/{pi,parity}.md` — capability and limits.

## Risks & unknowns

- Pi may add new mutating built-ins; profile/version evidence must be remeasured on upgrade.
- A Bridge tool may perform governed mutations; this phase must not call the process an OS sandbox.
- User aliases/wrappers that hide the Pi runtime remain unsupported by structural reviewer preparation, as with existing runtimes.

## Visual impact

No visual changes. Human proof uses the existing Delivery reviewer flow and Activity/terminal output.

## Sources consulted

- Pi v0.80.10 `--help`, `docs/keybindings.md`, extension `getActiveTools()` API.
- SDD 368 reviewer safety and `reviewerSafeCommand` tests.
- SDD 398 Bridge projection/fail-closed tool filtering and SDD 402 runtime profile.
