# 398 — pi-runtime-onboarding — notes

_Created 2026-07-18._

_In-flight design memory — decisions, deviations, tradeoffs, and open questions surfaced **while building** that weren't pre-empted by `spec.md` or `plan.md`. Append-only by convention._

## Design decisions

- Pi's own validator explicitly accepts ordinary JSON Schema when a tool lacks TypeBox's symbol marker. The extension therefore passes MCP `inputSchema` through unchanged instead of importing Pi's private `typebox` dependency.
- Tool-shaping Pi flags (`--no-tools`, `--tools`, `--exclude-tools` and short forms) fail Bridge wiring closed. Respecting them while stamping `wired:true` would make the lifecycle proof dishonest; overriding them would violate additive user ownership.
- Bridge initialization/catalog discovery uses a 5s local preflight timeout. Tool calls retain cancellation and get a 300s timeout so Tachyon's long-running wait/verification tools are not truncated by the MCP SDK's 60s default.

## Deviations

- The planned TypeBox conversion became plain JSON Schema pass-through after inspecting Pi's shipped `validateToolArguments`; this is both smaller and the runtime's supported compatibility path.
- The dogfood uses Pi RPC plus `/tachyon-bridge-status` against a local authenticated MCP server. Native proxy execution is covered deterministically in the focused projection test; installed Tachyon spawn/primer inspection remains the human dogfood step.

## Tradeoffs

- Connection failure is advisory inside Pi so local coding remains available, while missing extension materialization is a spawn refusal in Tachyon. This separates transient runtime health from an engine claim that could never become true.
- Transcript resume, fork and Activity were not inferred from Pi's files. They remain explicit parity gaps until measured rather than inheriting generic behavior that could bind the wrong session.

## Open questions

- Human Dev Host dogfood is pending maintainer reload/approval.
- The branch inherited two unrelated baseline verification defects from `7946c02f`: `npm run typecheck` fails because `scripts/verify-full.mjs` has no declaration consumed by `test/unit/verifyFullLock.test.ts`; the full suite also has `verifyFullQuiet.test.ts` expecting the pre-`t-6a9bc4` `verify:full` script. The onboarding-focused tests, engine packaging, build, PI-001 and dogfood are green; these baseline defects were not folded into the onboarding diff.

## Human dogfood

### 2026-07-18 — pass — Dev Host worktree target

- Commit `625c3c1d`, isolated fixture `/tmp/tachyon-pi-onboarding-dogfood`.
- Maintainer confirmed the managed Pi started successfully in the Dev Host and the onboarding worked.
- This closes the remaining integrated spawn/primer/Bridge acceptance scenario for Phase 1.
- Dev Host pointer was cleared immediately after confirmation; its private engine was stopped.

## Dogfood log

### 2026-07-18T14:30:30Z — pass (1/1) — source: tasks.md — commit: 7946c02f8ce29bf5aaa38159329ba33917c629dd
- `node scripts/dogfood/pi-runtime-onboarding.mjs` — pass

## Verification log

### 2026-07-18T14:30:37Z — fail (2/3) — source: tasks.md
- `npm run typecheck` — fail
- `npx vitest run test/unit/piRuntimeOnboarding.test.ts test/unit/agentManager.test.ts test/unit/piBridgeExtension.test.ts test/unit/engineBundleStore.test.ts` — pass
- `npm run test:invariants` — pass
